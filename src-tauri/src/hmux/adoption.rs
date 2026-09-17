use hebbian_process_sampler::{
    AgentProvider, SharedProcessSampler, process_argv, process_cwd, process_start_time,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

mod provider_sample_retry;

const MAX_PROCESS_TABLE_BYTES: usize = 8 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_OPEN_FILE_OUTPUT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SESSION_META_BYTES: u64 = 64 * 1024;
const MAX_CODEX_SESSION_ENTRIES: usize = 131_072;
const MAX_CODEX_SESSION_DEPTH: usize = 4;
#[cfg(target_os = "macos")]
const OPEN_FILE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ProviderIdentity {
    pub host_pid: u32,
    pub host_start_time: u64,
    pub provider_pid: u32,
    pub provider_start_time: u64,
    pub provider_id: String,
    pub conversation_id: String,
    pub provider_cwd: PathBuf,
}

#[derive(Clone, Debug)]
struct ProcessRecord {
    pid: u32,
    parent_pid: u32,
}

#[derive(Clone, Debug, Deserialize)]
struct SessionMetaRecord {
    #[serde(rename = "type")]
    record_type: String,
    payload: SessionMetaPayload,
}

#[derive(Clone, Debug, Deserialize)]
struct SessionMetaPayload {
    id: String,
    originator: Option<String>,
    source: Value,
    forked_from_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SessionMeta {
    id: String,
    parent_id: Option<String>,
    forked_from_id: Option<String>,
    codex_home: PathBuf,
}

pub(super) fn inspect_provider_under_host(
    host_pid: u32,
    expected_provider_id: &str,
    expected_cwd: &Path,
) -> Result<ProviderIdentity, String> {
    super::validate_identifier("provider id", expected_provider_id)?;
    let expected_cwd = fs::canonicalize(expected_cwd)
        .map_err(|_| "session_conversion_cwd_unavailable: provider cwd is missing".to_string())?;
    if !expected_cwd.is_dir() {
        return Err(
            "session_conversion_cwd_unavailable: provider cwd is not a directory".to_string(),
        );
    }
    let host_start_time = process_start_time(host_pid).ok_or_else(|| {
        "legacy_adoption_source_missing: legacy session host exited".to_string()
    })?;
    let sampler = SharedProcessSampler::host_default().map_err(|_| {
        "legacy_adoption_process_unverified: process sampler is unavailable".to_string()
    })?;
    let provider = provider_sample_retry::observe(
        || sampler.agent_process(host_pid),
        || process_start_time(host_pid) == Some(host_start_time),
        thread::sleep,
    )
    .map_err(|error| match error {
        provider_sample_retry::Failure::GenerationChanged => {
            "legacy_adoption_process_changed: source host changed during provider sampling"
                .to_string()
        }
        provider_sample_retry::Failure::Observation => {
            "legacy_adoption_process_unverified: provider process could not be sampled".to_string()
        }
    })?
        .ok_or_else(|| {
            "legacy_adoption_process_unverified: provider process is missing".to_string()
        })?;
    if provider.provider.as_str() != expected_provider_id {
        return Err("legacy_adoption_provider_mismatch: sampled provider changed".to_string());
    }
    let provider_cwd = verified_provider_cwd(provider.pid, &expected_cwd)?;

    // Sample descendants after the bounded provider observation. Reusing a
    // table captured before a transient sampler wait could bind open files to
    // a process tree that no longer accompanies the verified provider.
    let records = sample_process_table()?;
    let descendants = descendants_from(&records, provider.pid);
    if descendants.is_empty() {
        return Err(
            "legacy_adoption_process_unverified: provider process left the source tree".to_string(),
        );
    }
    let conversation_id = match provider.provider {
        AgentProvider::Codex => {
            let open_paths = open_paths_for_processes(&descendants)?;
            exact_codex_conversation(provider.pid, &open_paths)?
        }
        AgentProvider::Claude => super::claude_adoption::exact_conversation(
            provider.pid,
            provider.start_time,
            &provider_cwd,
        )?,
        _ => {
            return Err(
                "legacy_adoption_adapter_unsupported: provider has no reviewed exact identity adapter"
                    .to_string(),
            );
        }
    };

    if process_start_time(host_pid) != Some(host_start_time)
        || process_start_time(provider.pid) != Some(provider.start_time)
    {
        return Err(
            "legacy_adoption_process_changed: source process changed during inspection".to_string(),
        );
    }

    Ok(ProviderIdentity {
        host_pid,
        host_start_time,
        provider_pid: provider.pid,
        provider_start_time: provider.start_time,
        provider_id: provider.provider.as_str().to_string(),
        conversation_id,
        provider_cwd,
    })
}

pub(super) fn inspect_managed_provider(
    provider_pid: u32,
    provider_id: &str,
    expected_cwd: &Path,
) -> Result<String, String> {
    let expected_cwd = fs::canonicalize(expected_cwd).map_err(|_| {
        "conversation_identity_cwd_unavailable: provider cwd is missing".to_string()
    })?;
    if !expected_cwd.is_dir() {
        return Err(
            "conversation_identity_cwd_unavailable: provider cwd is not a directory".to_string(),
        );
    }
    let provider_start_time = process_start_time(provider_pid).ok_or_else(|| {
        "conversation_identity_source_missing: managed provider exited".to_string()
    })?;
    verified_provider_cwd(provider_pid, &expected_cwd)?;
    let records = sample_process_table()?;
    let descendants = descendants_from(&records, provider_pid);
    if descendants.is_empty() {
        return Err(
            "conversation_identity_process_unverified: provider process left the source tree"
                .to_string(),
        );
    }
    let conversation_id = match provider_id {
        "codex" => {
            let open_paths = open_paths_for_processes(&descendants)?;
            exact_codex_conversation(provider_pid, &open_paths)?
        }
        "claude" => super::claude_adoption::exact_conversation(
            provider_pid,
            provider_start_time,
            &expected_cwd,
        )?,
        _ => {
            return Err(
                "conversation_identity_adapter_unsupported: provider has no reviewed live identity adapter"
                    .to_string(),
            );
        }
    };
    if process_start_time(provider_pid) != Some(provider_start_time) {
        return Err(
            "conversation_identity_process_changed: provider changed during inspection".to_string(),
        );
    }
    Ok(conversation_id)
}

fn verified_provider_cwd(provider_pid: u32, expected_cwd: &Path) -> Result<PathBuf, String> {
    // Rollout metadata keeps the conversation's creation cwd across resumes.
    // Bind the pane to the fenced live process instead.
    let provider_cwd = process_cwd(provider_pid)
        .and_then(|path| fs::canonicalize(path).ok())
        .ok_or_else(|| {
            "conversation_identity_process_unverified: live provider cwd is unavailable"
                .to_string()
        })?;
    if provider_cwd != expected_cwd {
        return Err(
            "conversation_identity_mismatch: live provider cwd does not match the pane".to_string(),
        );
    }
    Ok(provider_cwd)
}

pub(super) fn source_host_matches(identity: &ProviderIdentity) -> bool {
    process_start_time(identity.host_pid) == Some(identity.host_start_time)
}

pub(super) fn source_provider_matches(identity: &ProviderIdentity) -> bool {
    process_start_time(identity.provider_pid) == Some(identity.provider_start_time)
}

fn sample_process_table() -> Result<Vec<ProcessRecord>, String> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,command="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| {
            "legacy_adoption_process_unverified: process table is unavailable".to_string()
        })?;
    if !output.status.success() || output.stdout.len() > MAX_PROCESS_TABLE_BYTES {
        return Err(
            "legacy_adoption_process_unverified: process table is unavailable".to_string(),
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_process_record)
        .collect())
}

fn parse_process_record(line: &str) -> Option<ProcessRecord> {
    let line = line.trim_start();
    let (pid, rest) = line.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (parent_pid, _command) = rest.split_once(char::is_whitespace)?;
    Some(ProcessRecord {
        pid: pid.parse().ok()?,
        parent_pid: parent_pid.parse().ok()?,
    })
}

fn descendants_from(records: &[ProcessRecord], root_pid: u32) -> Vec<u32> {
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for record in records {
        children
            .entry(record.parent_pid)
            .or_default()
            .push(record.pid);
    }
    let mut queue = VecDeque::from([root_pid]);
    let mut seen = HashSet::new();
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(child_pids) = children.get(&pid) {
            queue.extend(child_pids);
        }
    }
    seen.into_iter().collect()
}

#[cfg(target_os = "macos")]
fn open_paths_for_processes(processes: &[u32]) -> Result<Vec<PathBuf>, String> {
    let mut paths = HashSet::new();
    for pid in processes {
        let Some(start_time) = process_start_time(*pid) else {
            // A process-table snapshot can contain a short-lived provider child
            // that exits before open-file inspection reaches it.
            continue;
        };
        let inspection = bounded_command_output(
            Command::new("/usr/sbin/lsof")
                .args(["-a", "-p", &pid.to_string(), "-Fn"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null()),
        );
        let Some(output) = fenced_process_inspection(
            start_time,
            process_start_time(*pid),
            inspection,
        )? else {
            continue;
        };
        for line in String::from_utf8_lossy(&output).lines() {
            if let Some(path) = line.strip_prefix('n').filter(|path| path.starts_with('/')) {
                paths.insert(PathBuf::from(path));
            }
        }
    }
    Ok(paths.into_iter().collect())
}

#[cfg(target_os = "linux")]
fn open_paths_for_processes(processes: &[u32]) -> Result<Vec<PathBuf>, String> {
    let mut paths = HashSet::new();
    for pid in processes {
        let Some(start_time) = process_start_time(*pid) else {
            continue;
        };
        let inspection = fs::read_dir(format!("/proc/{pid}/fd"))
            .map(|directory| {
                directory
                    .flatten()
                    .filter_map(|entry| fs::read_link(entry.path()).ok())
                    .filter(|path| path.is_absolute())
                    .collect::<Vec<_>>()
            })
            .map_err(|_| {
                "legacy_adoption_process_unverified: provider open files are unavailable"
                    .to_string()
            });
        let Some(process_paths) = fenced_process_inspection(
            start_time,
            process_start_time(*pid),
            inspection,
        )? else {
            continue;
        };
        for path in process_paths {
            paths.insert(path);
        }
    }
    Ok(paths.into_iter().collect())
}

fn fenced_process_inspection<T>(
    expected_start_time: u64,
    observed_start_time: Option<u64>,
    inspection: Result<T, String>,
) -> Result<Option<T>, String> {
    if observed_start_time != Some(expected_start_time) {
        return Ok(None);
    }
    inspection.map(Some)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_paths_for_processes(_processes: &[u32]) -> Result<Vec<PathBuf>, String> {
    Err("legacy_adoption_adapter_unsupported: open-file evidence is unavailable".to_string())
}

#[cfg(target_os = "macos")]
fn bounded_command_output(command: &mut Command) -> Result<Vec<u8>, String> {
    let mut child = command.spawn().map_err(|_| {
        "legacy_adoption_process_unverified: provider open files are unavailable".to_string()
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        "legacy_adoption_process_unverified: provider open files are unavailable".to_string()
    })?;
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .take(MAX_OPEN_FILE_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)
            .map(|_| output)
    });
    let deadline = Instant::now() + OPEN_FILE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(
                    "legacy_adoption_process_unverified: open-file inspection timed out".to_string(),
                );
            }
        }
    };
    let output = reader
        .join()
        .map_err(|_| {
            "legacy_adoption_process_unverified: open-file inspection failed".to_string()
        })?
        .map_err(|_| {
            "legacy_adoption_process_unverified: open-file inspection failed".to_string()
        })?;
    if !status.success() || output.len() as u64 > MAX_OPEN_FILE_OUTPUT_BYTES {
        return Err(
            "legacy_adoption_process_unverified: open-file inspection failed".to_string(),
        );
    }
    Ok(output)
}

fn exact_codex_conversation(
    provider_pid: u32,
    open_paths: &[PathBuf],
) -> Result<String, String> {
    let arguments = process_argv(provider_pid).unwrap_or_default();
    exact_codex_conversation_with_argv(open_paths, &arguments)
}

fn exact_codex_conversation_with_argv(
    open_paths: &[PathBuf],
    arguments: &[String],
) -> Result<String, String> {
    if arguments.windows(2).any(|pair| pair == ["resume", "--last"]) {
        return Err(
            "conversation_identity_unverified: implicit Codex resume is not pane-local"
                .to_string(),
        );
    }
    let canonical_paths = open_paths
        .iter()
        .filter_map(|path| private_regular_file(path))
        .collect::<HashSet<_>>();
    let metas = canonical_paths
        .iter()
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        })
        .filter_map(|path| session_meta(path).transpose())
        .collect::<Result<Vec<_>, _>>()?;
    if !metas.is_empty() {
        for meta in &metas {
            let has_runtime_database = canonical_paths.iter().any(|path| {
                path.parent() == Some(meta.codex_home.as_path())
                    && path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .is_some_and(is_codex_runtime_database)
            });
            if !has_runtime_database {
                return Err(
                    "conversation_identity_unverified: Codex home evidence is incomplete"
                        .to_string(),
                );
            }
        }
        if let Some(source_id) = forked_conversation_source_id(arguments)? {
            let runtime_home = unique_runtime_codex_home(&canonical_paths)?;
            return resolve_fork_conversation(&metas, &source_id, &runtime_home);
        }
        return resolve_root_conversation(&metas);
    }
    if forked_conversation_source_id(arguments)?.is_some() {
        return Err(
            "conversation_identity_required: Codex fork child rollout is not open yet"
                .to_string(),
        );
    }
    let conversation_id = resumed_conversation_id(arguments)?;
    let codex_home = unique_runtime_codex_home(&canonical_paths)?;
    let meta = find_private_codex_rollout(&codex_home, &conversation_id)?;
    if meta.parent_id.is_some() {
        return Err(
            "conversation_identity_unverified: resumed subagent parent rollout is not open"
                .to_string(),
        );
    }
    Ok(meta.id)
}

fn forked_conversation_source_id(arguments: &[String]) -> Result<Option<String>, String> {
    let fork_indices = arguments
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == "fork").then_some(index))
        .collect::<Vec<_>>();
    match fork_indices.as_slice() {
        [] => Ok(None),
        [fork_index] => {
            let Some(source_id) = arguments.get(*fork_index + 1) else {
                return Err(
                    "conversation_identity_required: Codex fork source identity is missing"
                        .to_string(),
                );
            };
            if source_id == "--last" {
                return Err(
                    "conversation_identity_unverified: implicit Codex fork is not pane-local"
                        .to_string(),
                );
            }
            if !valid_conversation_id(source_id) {
                return Err(
                    "conversation_identity_unverified: Codex fork source identity is invalid"
                        .to_string(),
                );
            }
            Ok(Some(source_id.clone()))
        }
        _ => Err(
            "conversation_identity_ambiguous: provider has multiple Codex fork commands"
                .to_string(),
        ),
    }
}

fn resolve_fork_conversation(
    metas: &[SessionMeta],
    source_id: &str,
    runtime_home: &Path,
) -> Result<String, String> {
    let matches = metas
        .iter()
        .filter(|meta| meta.forked_from_id.as_deref() == Some(source_id))
        .collect::<Vec<_>>();
    let [child] = matches.as_slice() else {
        return Err(if matches.is_empty() {
            if metas.iter().any(|meta| meta.forked_from_id.is_some()) {
                "conversation_identity_unverified: Codex fork ancestry does not match the requested source"
                    .to_string()
            } else {
                "conversation_identity_required: Codex fork child rollout is not open yet"
                    .to_string()
            }
        } else {
            "conversation_identity_ambiguous: provider has multiple Codex fork children"
                .to_string()
        });
    };
    if child.id == source_id {
        return Err(
            "conversation_identity_unverified: Codex fork child reused the source identity"
                .to_string(),
        );
    }
    if child.parent_id.is_some() || child.codex_home != runtime_home {
        return Err(
            "conversation_identity_unverified: Codex fork child provenance is invalid"
                .to_string(),
        );
    }
    Ok(child.id.clone())
}

fn resumed_conversation_id(arguments: &[String]) -> Result<String, String> {
    let resume_indices = arguments
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == "resume").then_some(index))
        .collect::<Vec<_>>();
    let [resume_index] = resume_indices.as_slice() else {
        return Err(if resume_indices.is_empty() {
            "conversation_identity_required: provider has no open Codex rollout or exact resume identity"
                .to_string()
        } else {
            "conversation_identity_ambiguous: provider has multiple resume commands".to_string()
        });
    };
    let candidates = arguments[*resume_index + 1..]
        .iter()
        .filter(|argument| valid_conversation_id(argument))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let [conversation_id] = candidates.as_slice() else {
        return Err(if candidates.is_empty() {
            "conversation_identity_required: provider has no open Codex rollout or exact resume identity"
                .to_string()
        } else {
            "conversation_identity_ambiguous: resume arguments contain multiple conversation identities"
                .to_string()
        });
    };
    Ok((*conversation_id).clone())
}

fn unique_runtime_codex_home(canonical_paths: &HashSet<PathBuf>) -> Result<PathBuf, String> {
    let homes = canonical_paths
        .iter()
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(is_codex_runtime_database)
        })
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let [home] = homes.as_slice() else {
        return Err(if homes.is_empty() {
            "conversation_identity_unverified: Codex home evidence is incomplete".to_string()
        } else {
            "conversation_identity_ambiguous: provider uses multiple Codex runtime homes".to_string()
        });
    };
    Ok(home.clone())
}

fn find_private_codex_rollout(
    codex_home: &Path,
    conversation_id: &str,
) -> Result<SessionMeta, String> {
    let mut matches = Vec::new();
    let mut visited = 0;
    for root_name in ["sessions", "archived_sessions"] {
        let root = codex_home.join(root_name);
        if !root.is_dir() {
            continue;
        }
        let mut queue = VecDeque::from([(root, 0_usize)]);
        while let Some((directory, depth)) = queue.pop_front() {
            let entries = fs::read_dir(&directory).map_err(|_| {
                "conversation_identity_unverified: Codex sessions root is unreadable".to_string()
            })?;
            for entry in entries {
                visited += 1;
                if visited > MAX_CODEX_SESSION_ENTRIES {
                    return Err(
                        "conversation_identity_unverified: Codex sessions search is oversized"
                            .to_string(),
                    );
                }
                let entry = entry.map_err(|_| {
                    "conversation_identity_unverified: Codex sessions root is unreadable"
                        .to_string()
                })?;
                let metadata = fs::symlink_metadata(entry.path()).map_err(|_| {
                    "conversation_identity_unverified: Codex session entry is unreadable"
                        .to_string()
                })?;
                if metadata.file_type().is_symlink() {
                    continue;
                }
                if metadata.is_dir() {
                    if depth < MAX_CODEX_SESSION_DEPTH {
                        queue.push_back((entry.path(), depth + 1));
                    }
                    continue;
                }
                let is_candidate = entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.ends_with(&format!("{conversation_id}.jsonl")));
                if !is_candidate {
                    continue;
                }
                let Some(path) = private_regular_file(&entry.path()) else {
                    return Err(
                        "conversation_identity_unverified: resumed rollout is not private"
                            .to_string(),
                    );
                };
                let Some(meta) = session_meta(&path)? else {
                    continue;
                };
                if meta.id == conversation_id && meta.codex_home == codex_home {
                    matches.push(meta);
                }
            }
        }
    }
    let [meta] = matches.as_slice() else {
        return Err(if matches.is_empty() {
            "conversation_identity_unverified: exact resumed rollout is unavailable".to_string()
        } else {
            "conversation_identity_unverified: duplicate exact resumed rollout identity".to_string()
        });
    };
    Ok(meta.clone())
}

fn is_codex_runtime_database(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".sqlite") else {
        return false;
    };
    let Some((family, version)) = stem.rsplit_once('_') else {
        return false;
    };
    matches!(family, "state" | "logs" | "goals" | "memories")
        && !version.is_empty()
        && version.bytes().all(|byte| byte.is_ascii_digit())
}

fn private_regular_file(path: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(path).ok()?;
    // SAFETY: geteuid has no pointer arguments and only reads process identity.
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return None;
    }
    fs::canonicalize(path).ok()
}

fn session_meta(path: &Path) -> Result<Option<SessionMeta>, String> {
    let sessions = path
        .ancestors()
        .find(|ancestor| {
            matches!(
                ancestor.file_name().and_then(|value| value.to_str()),
                Some("sessions" | "archived_sessions")
            )
        })
        .ok_or_else(|| {
            "conversation_identity_unverified: rollout is outside a Codex sessions root"
                .to_string()
        })?;
    let codex_home = sessions.parent().ok_or_else(|| {
        "conversation_identity_unverified: Codex sessions root has no home".to_string()
    })?;
    let file = File::open(path)
        .map_err(|_| "conversation_identity_unverified: rollout is unreadable".to_string())?;
    let mut bytes = Vec::new();
    BufReader::new(file)
        .take(MAX_SESSION_META_BYTES + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "conversation_identity_unverified: rollout is unreadable".to_string())?;
    if bytes.len() as u64 > MAX_SESSION_META_BYTES {
        return Err("conversation_identity_unverified: session metadata is oversized".to_string());
    }
    let record: SessionMetaRecord = serde_json::from_slice(&bytes)
        .map_err(|_| "conversation_identity_unverified: session metadata is malformed".to_string())?;
    if record.record_type != "session_meta" {
        return Ok(None);
    }
    if record.payload.originator.as_deref() != Some("codex-tui")
        || !valid_conversation_id(&record.payload.id)
        || !path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.ends_with(&format!("{}.jsonl", record.payload.id)))
    {
        return Err("conversation_identity_unverified: session metadata identity is invalid"
            .to_string());
    }
    let parent_id = record
        .payload
        .source
        .pointer("/subagent/thread_spawn/parent_thread_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    if parent_id.as_deref().is_some_and(|id| !valid_conversation_id(id)) {
        return Err(
            "conversation_identity_unverified: subagent parent identity is invalid".to_string(),
        );
    }
    if record
        .payload
        .forked_from_id
        .as_deref()
        .is_some_and(|id| !valid_conversation_id(id))
    {
        return Err(
            "conversation_identity_unverified: fork source identity is invalid".to_string(),
        );
    }
    Ok(Some(SessionMeta {
        id: record.payload.id,
        parent_id,
        forked_from_id: record.payload.forked_from_id,
        codex_home: codex_home.to_path_buf(),
    }))
}

fn resolve_root_conversation(metas: &[SessionMeta]) -> Result<String, String> {
    let by_id = metas
        .iter()
        .map(|meta| (meta.id.as_str(), meta))
        .collect::<HashMap<_, _>>();
    if by_id.len() != metas.len() {
        return Err(
            "conversation_identity_unverified: duplicate open rollout identity".to_string(),
        );
    }
    for meta in metas {
        if let Some(parent_id) = meta.parent_id.as_deref() {
            if !by_id.contains_key(parent_id) {
                return Err(
                    "conversation_identity_unverified: subagent parent rollout is not open"
                        .to_string(),
                );
            }
        }
    }
    let roots = metas
        .iter()
        .filter(|meta| meta.parent_id.is_none())
        .collect::<Vec<_>>();
    let [root] = roots.as_slice() else {
        return Err(
            "conversation_identity_ambiguous: provider has multiple root conversations".to_string(),
        );
    };
    for meta in metas {
        let mut current = meta;
        let mut visited = HashSet::new();
        while let Some(parent_id) = current.parent_id.as_deref() {
            if !visited.insert(current.id.as_str()) {
                return Err(
                    "conversation_identity_unverified: subagent ancestry contains a cycle"
                        .to_string(),
                );
            }
            current = by_id[parent_id];
        }
        if current.id != root.id {
            return Err(
                "conversation_identity_ambiguous: open rollouts do not share one root".to_string(),
            );
        }
    }
    Ok(root.id.clone())
}

fn valid_conversation_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[cfg(target_os = "macos")]
    #[test]
    fn vanished_descendant_does_not_fail_open_file_inspection() {
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());

        assert_eq!(open_paths_for_processes(&[pid]).unwrap(), Vec::<PathBuf>::new());
    }

    #[test]
    fn stable_process_inspection_failure_remains_fail_closed() {
        let error = fenced_process_inspection::<Vec<u8>>(
            41,
            Some(41),
            Err("open-file inspection failed".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "open-file inspection failed");
    }

    #[test]
    fn replaced_process_inspection_output_is_discarded() {
        assert_eq!(
            fenced_process_inspection(41, Some(42), Ok(vec!["untrusted replacement output"])),
            Ok(None)
        );
    }

    #[test]
    fn root_rollout_wins_over_its_open_subagent() {
        let home = PathBuf::from("/home/user/.codex");
        let root_id = "019fa342-4698-78b2-a47d-784690b3c756";
        let child_id = "019fa462-8fe7-7680-bec0-07719034abca";
        assert_eq!(
            resolve_root_conversation(
                &[
                    SessionMeta {
                        id: root_id.into(),
                        parent_id: None,
                        forked_from_id: None,
                        codex_home: home.clone(),
                    },
                    SessionMeta {
                        id: child_id.into(),
                        parent_id: Some(root_id.into()),
                        forked_from_id: None,
                        codex_home: home,
                    },
                ],
            )
            .unwrap(),
            root_id
        );
    }

    #[test]
    fn two_independent_open_roots_fail_closed() {
        let home = PathBuf::from("/home/user/.codex");
        let error = resolve_root_conversation(
            &[
                SessionMeta {
                    id: "019fa342-4698-78b2-a47d-784690b3c756".into(),
                    parent_id: None,
                    forked_from_id: None,
                    codex_home: home.clone(),
                },
                SessionMeta {
                    id: "019fa462-8fe7-7680-bec0-07719034abca".into(),
                    parent_id: None,
                    forked_from_id: None,
                    codex_home: home,
                },
            ],
        )
        .unwrap_err();
        assert!(error.starts_with("conversation_identity_ambiguous"));
    }

    #[test]
    fn session_metadata_requires_matching_filename() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join(".codex/sessions/2026/07/28");
        fs::create_dir_all(&sessions).unwrap();
        let id = "019fa342-4698-78b2-a47d-784690b3c756";
        let path = sessions.join(format!("rollout-2026-07-28T00-00-00-{id}.jsonl"));
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": temp.path(),
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        let parsed = session_meta(&path).unwrap().unwrap();
        assert_eq!(parsed.id, id);
    }

    #[test]
    fn codex_logs_database_corroborates_rollout_home() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions/2026/07/28");
        fs::create_dir_all(&sessions).unwrap();
        let id = "019fa342-4698-78b2-a47d-784690b3c756";
        let rollout = sessions.join(format!("rollout-2026-07-28T00-00-00-{id}.jsonl"));
        let mut file = File::create(&rollout).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": temp.path(),
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        let logs = codex_home.join("logs_2.sqlite");
        File::create(&logs).unwrap();

        assert_eq!(
            exact_codex_conversation_with_argv(&[rollout, logs], &[]).unwrap(),
            id
        );
    }

    #[test]
    fn exact_resume_identity_uses_private_rollout_from_runtime_home() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions/2026/07/28");
        fs::create_dir_all(&sessions).unwrap();
        let id = "019fa342-4698-78b2-a47d-784690b3c756";
        let rollout = sessions.join(format!("rollout-2026-07-28T00-00-00-{id}.jsonl"));
        let mut file = File::create(&rollout).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": temp.path(),
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        let state = codex_home.join("state_5.sqlite");
        File::create(&state).unwrap();
        let arguments = ["codex", "--dangerously-bypass-approvals-and-sandbox", "resume", id]
            .map(ToString::to_string);

        assert_eq!(
            exact_codex_conversation_with_argv(&[state], &arguments).unwrap(),
            id
        );
    }

    #[test]
    fn native_fork_waits_for_child_instead_of_binding_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions/2026/08/02");
        fs::create_dir_all(&sessions).unwrap();
        let source_id = "019fa342-4698-78b2-a47d-784690b3c756";
        let source = sessions.join(format!(
            "rollout-2026-08-02T00-00-00-{source_id}.jsonl"
        ));
        let mut source_file = File::create(&source).unwrap();
        writeln!(
            source_file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": source_id,
                    "cwd": temp.path(),
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        let state = codex_home.join("state_5.sqlite");
        File::create(&state).unwrap();
        let arguments = ["codex", "-C", ".", "fork", source_id].map(ToString::to_string);

        let error = exact_codex_conversation_with_argv(&[source, state], &arguments).unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_required: Codex fork child rollout is not open yet"
        );
    }

    #[test]
    fn native_fork_selects_the_child_with_exact_source_ancestry() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions/2026/08/02");
        fs::create_dir_all(&sessions).unwrap();
        let source_id = "019fa342-4698-78b2-a47d-784690b3c756";
        let child_id = "019fa462-8fe7-7680-bec0-07719034abca";
        let source = sessions.join(format!(
            "rollout-2026-08-02T00-00-00-{source_id}.jsonl"
        ));
        let child = sessions.join(format!(
            "rollout-2026-08-02T00-00-01-{child_id}.jsonl"
        ));
        for (path, id, forked_from_id) in [
            (&source, source_id, None),
            (&child, child_id, Some(source_id)),
        ] {
            let mut file = File::create(path).unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": id,
                        "cwd": temp.path(),
                        "originator": "codex-tui",
                        "source": "cli",
                        "forked_from_id": forked_from_id
                    }
                })
            )
            .unwrap();
        }
        let state = codex_home.join("state_5.sqlite");
        File::create(&state).unwrap();
        let arguments = ["codex", "-C", ".", "fork", source_id].map(ToString::to_string);

        assert_eq!(
            exact_codex_conversation_with_argv(&[source, child, state], &arguments).unwrap(),
            child_id
        );
    }

    #[test]
    fn native_fork_rejects_mixed_or_duplicate_child_ancestry() {
        let home = PathBuf::from("/home/user/.codex");
        let source_id = "019fa342-4698-78b2-a47d-784690b3c756";
        let other_source_id = "019fa562-8fe7-7680-bec0-07719034abcb";
        let first_child = SessionMeta {
            id: "019fa462-8fe7-7680-bec0-07719034abca".into(),
            parent_id: None,
            forked_from_id: Some(other_source_id.into()),
            codex_home: home.clone(),
        };

        let error = resolve_fork_conversation(
            std::slice::from_ref(&first_child),
            source_id,
            &home,
        )
        .unwrap_err();
        assert!(error.starts_with("conversation_identity_unverified:"));

        let matching_child = SessionMeta {
            forked_from_id: Some(source_id.into()),
            ..first_child.clone()
        };
        let second_matching_child = SessionMeta {
            id: "019fa662-8fe7-7680-bec0-07719034abcc".into(),
            ..matching_child.clone()
        };
        let error = resolve_fork_conversation(
            &[matching_child, second_matching_child],
            source_id,
            &home,
        )
        .unwrap_err();
        assert!(error.starts_with("conversation_identity_ambiguous:"));
    }

    #[test]
    fn resume_last_with_one_open_rollout_still_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions/2026/07/28");
        fs::create_dir_all(&sessions).unwrap();
        let id = "019fa342-4698-78b2-a47d-784690b3c756";
        let rollout = sessions.join(format!("rollout-2026-07-28T00-00-00-{id}.jsonl"));
        let mut file = File::create(&rollout).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": "/repo/.worktrees/another-pane",
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        let logs = codex_home.join("logs_2.sqlite");
        File::create(&logs).unwrap();
        let arguments = ["codex", "resume", "--last"].map(ToString::to_string);
        let error = exact_codex_conversation_with_argv(&[rollout, logs], &arguments).unwrap_err();
        assert!(error.starts_with("conversation_identity_unverified:"));
    }

    #[test]
    fn multiple_resume_identities_fail_closed() {
        let arguments = [
            "codex",
            "resume",
            "019fa342-4698-78b2-a47d-784690b3c756",
            "019fa462-8fe7-7680-bec0-07719034abca",
        ]
        .map(ToString::to_string);
        let error = exact_codex_conversation_with_argv(&[], &arguments).unwrap_err();
        assert!(error.starts_with("conversation_identity_ambiguous:"));
    }

    #[test]
    fn codex_runtime_database_names_are_bounded() {
        for name in [
            "state_5.sqlite",
            "logs_2.sqlite",
            "goals_1.sqlite",
            "memories_1.sqlite",
        ] {
            assert!(is_codex_runtime_database(name));
        }
        for name in [
            "state.sqlite",
            "logs_latest.sqlite",
            "other_2.sqlite",
            "logs_2.sqlite-wal",
        ] {
            assert!(!is_codex_runtime_database(name));
        }
    }

    #[test]
    fn open_rollout_identity_is_independent_of_historical_cwd() {
        let current = tempfile::tempdir().unwrap();
        let historical = tempfile::tempdir().unwrap();
        let codex_home = current.path().join(".codex");
        let sessions = codex_home.join("sessions/2026/07/28");
        fs::create_dir_all(&sessions).unwrap();
        let id = "019fa342-4698-78b2-a47d-784690b3c756";
        let rollout = sessions.join(format!("rollout-2026-07-28T00-00-00-{id}.jsonl"));
        let mut file = File::create(&rollout).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": historical.path(),
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        let logs = codex_home.join("logs_2.sqlite");
        File::create(&logs).unwrap();

        assert_eq!(
            exact_codex_conversation_with_argv(&[rollout, logs], &[]).unwrap(),
            id
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn live_provider_cwd_must_match_the_expected_path() {
        let current = fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
        assert_eq!(
            verified_provider_cwd(std::process::id(), &current).unwrap(),
            current
        );

        let other = tempfile::tempdir().unwrap();
        let error = verified_provider_cwd(
            std::process::id(),
            &other.path().canonicalize().unwrap(),
        )
        .unwrap_err();
        assert!(error.starts_with("conversation_identity_mismatch:"));
    }
}
