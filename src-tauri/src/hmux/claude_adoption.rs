//! Claude-specific proof for exact provider-native conversation adoption.
//!
//! Claude keeps a PID-scoped live-session record that follows in-process
//! `/resume` switches. We bind that record to the sampled OS process
//! generation, then corroborate its UUID and cwd against the transcript. No
//! latest-file or interactive-picker inference is accepted.

use serde::Deserialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

const MAX_LIVE_SESSION_BYTES: u64 = 64 * 1024;
/// Screenshot-heavy long-lived sessions organically exceed 64MiB (2026-08-05:
/// a live pane hit 90MB and account switching hard-failed on this guard). The
/// scan stays bounded — a few hundred ms per 100MB — and the per-record cap
/// below still rejects adversarially shaped records.
const MAX_TRANSCRIPT_SCAN_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORD_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LiveSession {
    pid: u32,
    session_id: String,
    cwd: String,
    started_at: u64,
    proc_start: String,
    kind: String,
    entrypoint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LiveSessionEvidence {
    session: LiveSession,
    raw_payload: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptRecord {
    session_id: Option<String>,
    cwd: Option<String>,
    is_sidechain: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProcessStartEvidence {
    unix_ms: u64,
    utc_label: String,
}

pub(super) fn exact_conversation(
    provider_pid: u32,
    provider_start_time: u64,
    expected_cwd: &Path,
) -> Result<String, String> {
    let claude_home = dirs::home_dir()
        .map(|home| home.join(".claude"))
        .ok_or_else(|| {
            "conversation_identity_unverified: Claude state root is unavailable".to_string()
        })?;
    let process_start = process_start_evidence(provider_start_time)?;
    exact_conversation_from_state(&claude_home, provider_pid, expected_cwd, &process_start)
}

fn exact_conversation_from_state(
    claude_home: &Path,
    provider_pid: u32,
    expected_cwd: &Path,
    process_start: &ProcessStartEvidence,
) -> Result<String, String> {
    let sessions_root = owned_real_directory(&claude_home.join("sessions"), "Claude sessions")?;
    let session_path = sessions_root.join(format!("{provider_pid}.json"));
    let evidence = read_live_session(&session_path)?;
    validate_live_session(
        &evidence.session,
        provider_pid,
        expected_cwd,
        process_start,
    )?;

    // A transcript tree is written on the first recorded turn, so its absence is
    // "not yet" exactly like a missing transcript file below — never a refusal.
    // Only a present-but-untrusted directory is unverifiable evidence.
    let projects_root = owned_real_directory_if_present(
        &claude_home.join("projects"),
        "Claude projects",
    )?
    .ok_or_else(|| {
        "conversation_identity_required: Claude projects root is not available yet".to_string()
    })?;
    let project_root = owned_real_directory_if_present(
        &projects_root.join(encode_cwd(expected_cwd)),
        "Claude project",
    )?
    .ok_or_else(|| {
        "conversation_identity_required: Claude project directory is not available yet".to_string()
    })?;
    validate_transcript(
        &project_root.join(format!("{}.jsonl", evidence.session.session_id)),
        &evidence.session.session_id,
        expected_cwd,
    )?;

    // `/resume` can change the conversation without changing the process
    // generation. Catch a switch or partial rewrite that races transcript
    // inspection, including changes outside the fields we deserialize.
    if read_live_session(&session_path)? != evidence {
        return Err(
            "conversation_identity_process_changed: Claude live session changed during inspection"
                .to_string(),
        );
    }
    Ok(evidence.session.session_id)
}

fn owned_real_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    owned_real_directory_if_present(path, label)?.ok_or_else(|| {
        format!("conversation_identity_unverified: {label} directory is unavailable")
    })
}

/// `Ok(None)` distinguishes "this directory has not been created yet" from
/// "it exists but cannot be trusted". Only the caller knows whether absence is
/// a pending state or a refusal.
fn owned_real_directory_if_present(path: &Path, label: &str) -> Result<Option<PathBuf>, String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(format!(
                "conversation_identity_unverified: {label} directory is unavailable"
            ));
        }
    };
    // SAFETY: geteuid has no pointer arguments and only reads process identity.
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(format!(
            "conversation_identity_unverified: {label} directory is untrusted"
        ));
    }
    fs::canonicalize(path)
        .map(Some)
        .map_err(|_| format!("conversation_identity_unverified: {label} directory is unavailable"))
}

fn private_regular_file(path: &Path) -> Result<Option<PathBuf>, ()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    // SAFETY: geteuid has no pointer arguments and only reads process identity.
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(());
    }
    fs::canonicalize(path).map(Some).map_err(|_| ())
}

fn read_live_session(path: &Path) -> Result<LiveSessionEvidence, String> {
    let path = private_regular_file(path)
        .map_err(|_| {
            "conversation_identity_unverified: Claude live session is unavailable or untrusted"
                .to_string()
        })?
        .ok_or_else(|| {
            "conversation_identity_required: Claude live session is not available yet".to_string()
        })?;
    let file = File::open(path).map_err(|_| {
        "conversation_identity_unverified: Claude live session is unreadable".to_string()
    })?;
    let mut payload = Vec::new();
    file.take(MAX_LIVE_SESSION_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|_| {
            "conversation_identity_unverified: Claude live session is unreadable".to_string()
        })?;
    if payload.len() as u64 > MAX_LIVE_SESSION_BYTES {
        return Err(
            "conversation_identity_unverified: Claude live session is oversized".to_string(),
        );
    }
    let session = decode_live_session(&payload).ok_or_else(|| {
        "conversation_identity_unverified: Claude live session is malformed".to_string()
    })?;
    Ok(LiveSessionEvidence {
        session,
        raw_payload: payload,
    })
}

fn decode_live_session(payload: &[u8]) -> Option<LiveSession> {
    serde_json::from_slice(payload).ok().or_else(|| {
        // Claude 2.1.220 can overwrite a shorter status record without
        // truncating the previous payload, leaving exactly one stale closing
        // brace. Accept only that observed one-byte residue. The caller still
        // requires the owner-bound process generation, exact transcript, and
        // byte-identical registry reread before this evidence is authoritative.
        payload
            .strip_suffix(b"}")
            .and_then(|candidate| serde_json::from_slice(candidate).ok())
    })
}

fn validate_live_session(
    session: &LiveSession,
    provider_pid: u32,
    expected_cwd: &Path,
    process_start: &ProcessStartEvidence,
) -> Result<(), String> {
    let session_cwd = fs::canonicalize(&session.cwd).map_err(|_| {
        "conversation_identity_unverified: Claude live session cwd is unavailable".to_string()
    })?;
    // Generation binding is the pid-keyed file plus the exact process-start
    // label; a record predating its process is the one stale shape they miss.
    // No upper bound on registration delay: Claude registers only after its
    // startup gates (folder-trust prompt, resume picker) are answered, and
    // those legitimately sit for as long as the user is away.
    let registered_before_process = session.started_at < process_start.unix_ms;
    if session.pid != provider_pid
        || session_cwd != expected_cwd
        || !valid_conversation_id(&session.session_id)
        || session.proc_start != process_start.utc_label
        || registered_before_process
        || session.kind != "interactive"
        || session.entrypoint != "cli"
    {
        return Err(
            "conversation_identity_mismatch: Claude live session does not match the provider process"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_transcript(
    path: &Path,
    conversation_id: &str,
    expected_cwd: &Path,
) -> Result<(), String> {
    let path = private_regular_file(path)
        .map_err(|_| {
            "conversation_identity_unverified: Claude transcript is unavailable or untrusted"
                .to_string()
        })?
        .ok_or_else(|| {
            "conversation_identity_required: Claude transcript is not available yet".to_string()
        })?;
    let expected_name = format!("{conversation_id}.jsonl");
    if path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str()) {
        return Err(
            "conversation_identity_unverified: Claude transcript filename is invalid".to_string(),
        );
    }
    let file = File::open(path).map_err(|_| {
        "conversation_identity_unverified: Claude transcript is unreadable".to_string()
    })?;
    if file
        .metadata()
        .map_err(|_| {
            "conversation_identity_unverified: Claude transcript is unreadable".to_string()
        })?
        .len()
        > MAX_TRANSCRIPT_SCAN_BYTES
    {
        return Err(
            "conversation_identity_unverified: Claude transcript evidence is oversized".to_string(),
        );
    }

    let mut reader = BufReader::new(file).take(MAX_TRANSCRIPT_SCAN_BYTES + 1);
    let mut line = Vec::new();
    let mut total = 0_u64;
    let mut saw_identity = false;
    let mut saw_cwd = false;
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).map_err(|_| {
            "conversation_identity_unverified: Claude transcript is unreadable".to_string()
        })?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_TRANSCRIPT_SCAN_BYTES || line.len() > MAX_TRANSCRIPT_RECORD_BYTES {
            return Err(
                "conversation_identity_unverified: Claude transcript evidence is oversized"
                    .to_string(),
            );
        }
        let record: TranscriptRecord = serde_json::from_slice(&line).map_err(|_| {
            "conversation_identity_unverified: Claude transcript record is malformed".to_string()
        })?;
        if let Some(session_id) = record.session_id.as_deref() {
            if session_id != conversation_id {
                return Err(
                    "conversation_identity_mismatch: Claude transcript identity changed"
                        .to_string(),
                );
            }
            saw_identity = true;
        }
        if record.is_sidechain != Some(true)
            && record
                .cwd
                .as_deref()
                .and_then(|cwd| fs::canonicalize(cwd).ok())
                .as_deref()
                == Some(expected_cwd)
        {
            saw_cwd = true;
        }
    }
    if saw_identity && saw_cwd {
        Ok(())
    } else {
        Err(
            "conversation_identity_required: Claude transcript does not contain first-message identity evidence yet"
                .to_string(),
        )
    }
}

fn encode_cwd(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
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

fn process_start_evidence(process_start_time: u64) -> Result<ProcessStartEvidence, String> {
    let unix_ms = process_start_unix_ms(process_start_time).ok_or_else(|| {
        "conversation_identity_process_unverified: provider start time is unavailable".to_string()
    })?;
    let seconds = libc::time_t::try_from(unix_ms / 1_000).map_err(|_| {
        "conversation_identity_process_unverified: provider start time is invalid".to_string()
    })?;
    let mut broken_down: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers reference live, correctly sized values and
    // gmtime_r writes only to `broken_down`.
    if unsafe { libc::gmtime_r(&seconds, &mut broken_down) }.is_null() {
        return Err(
            "conversation_identity_process_unverified: provider start time is invalid".to_string(),
        );
    }
    let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let weekday = usize::try_from(broken_down.tm_wday)
        .ok()
        .and_then(|index| weekdays.get(index))
        .ok_or_else(|| {
            "conversation_identity_process_unverified: provider start time is invalid".to_string()
        })?;
    let month = usize::try_from(broken_down.tm_mon)
        .ok()
        .and_then(|index| months.get(index))
        .ok_or_else(|| {
            "conversation_identity_process_unverified: provider start time is invalid".to_string()
        })?;
    Ok(ProcessStartEvidence {
        unix_ms,
        utc_label: format!(
            "{weekday} {month} {:>2} {:02}:{:02}:{:02} {}",
            broken_down.tm_mday,
            broken_down.tm_hour,
            broken_down.tm_min,
            broken_down.tm_sec,
            broken_down.tm_year + 1900
        ),
    })
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn process_start_unix_ms(process_start_time: u64) -> Option<u64> {
    process_start_time.checked_div(1_000)
}

#[cfg(target_os = "linux")]
fn process_start_unix_ms(process_start_time: u64) -> Option<u64> {
    let boot_seconds = fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .parse::<u64>()
        .ok()?;
    // SAFETY: sysconf reads a process-global constant and has no pointer args.
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let ticks_per_second = u64::try_from(ticks_per_second)
        .ok()
        .filter(|value| *value > 0)?;
    boot_seconds.checked_mul(1_000)?.checked_add(
        process_start_time
            .checked_mul(1_000)?
            .checked_div(ticks_per_second)?,
    )
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux")))]
fn process_start_unix_ms(_process_start_time: u64) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn process_start() -> ProcessStartEvidence {
        ProcessStartEvidence {
            unix_ms: 1_785_332_411_000,
            utc_label: "Wed Jul 29 13:40:11 2026".into(),
        }
    }

    fn fixture(temp: &tempfile::TempDir, pid: u32, conversation_id: &str, cwd: &Path) -> PathBuf {
        let claude_home = temp.path().join(".claude");
        let sessions = claude_home.join("sessions");
        let project = claude_home.join("projects").join(encode_cwd(cwd));
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(
            sessions.join(format!("{pid}.json")),
            serde_json::to_vec(&serde_json::json!({
                "pid": pid,
                "sessionId": conversation_id,
                "cwd": cwd,
                "startedAt": process_start().unix_ms + 2_000,
                "procStart": process_start().utc_label,
                "kind": "interactive",
                "entrypoint": "cli"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut transcript =
            File::create(project.join(format!("{conversation_id}.jsonl"))).unwrap();
        writeln!(
            transcript,
            "{}",
            serde_json::json!({ "type": "mode", "sessionId": conversation_id })
        )
        .unwrap();
        writeln!(
            transcript,
            "{}",
            serde_json::json!({
                "type": "user",
                "sessionId": conversation_id,
                "cwd": cwd,
                "isSidechain": false
            })
        )
        .unwrap();
        claude_home
    }

    #[test]
    fn pid_registry_and_transcript_prove_one_exact_conversation() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);

        assert_eq!(
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap(),
            id
        );
    }

    #[test]
    fn a_session_registered_long_after_process_start_is_still_this_generation() {
        // Claude registers its live session only after its startup gates are
        // answered — a folder-trust prompt or resume picker can sit for as
        // long as the user is away. Observed live: a pane created at 14:48
        // whose trust prompt was accepted at 15:07 registered 18.7 minutes
        // after process start with every identity field matching, and the
        // account switch refused it for the pane's whole lifetime.
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let registry = claude_home.join("sessions").join(format!("{pid}.json"));
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
        record["startedAt"] =
            serde_json::json!(process_start().unix_ms + 19 * 60 * 1_000);
        fs::write(&registry, serde_json::to_vec(&record).unwrap()).unwrap();

        assert_eq!(
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap(),
            id
        );
    }

    #[test]
    fn a_registry_record_predating_its_process_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let registry = claude_home.join("sessions").join(format!("{pid}.json"));
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
        record["startedAt"] = serde_json::json!(process_start().unix_ms - 1);
        fs::write(&registry, serde_json::to_vec(&record).unwrap()).unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert!(error.starts_with("conversation_identity_mismatch:"));
    }

    #[test]
    fn one_stale_closing_brace_from_a_shorter_registry_rewrite_is_accepted() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let registry = claude_home.join("sessions").join(format!("{pid}.json"));
        let mut payload = fs::read(&registry).unwrap();
        payload.push(b'}');
        fs::write(registry, payload).unwrap();

        assert_eq!(
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap(),
            id
        );
    }

    #[test]
    fn more_than_one_stale_byte_in_the_registry_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let registry = claude_home.join("sessions").join(format!("{pid}.json"));
        let mut payload = fs::read(&registry).unwrap();
        payload.extend_from_slice(b"}}");
        fs::write(registry, payload).unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_unverified: Claude live session is malformed"
        );
    }

    #[test]
    fn missing_pid_registry_waits_for_fresh_launch_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(temp.path().join(".claude/sessions")).unwrap();
        fs::create_dir_all(temp.path().join(".claude/projects")).unwrap();
        fs::create_dir_all(&cwd).unwrap();

        let error = exact_conversation_from_state(
            &temp.path().join(".claude"),
            42_424,
            &cwd.canonicalize().unwrap(),
            &process_start(),
        )
        .unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_required: Claude live session is not available yet"
        );
    }

    #[test]
    fn transcript_before_first_user_message_waits_for_identity_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let transcript = claude_home
            .join("projects")
            .join(encode_cwd(&cwd))
            .join(format!("{id}.jsonl"));
        fs::write(
            transcript,
            format!(
                "{}\n",
                serde_json::json!({ "type": "mode", "sessionId": id })
            ),
        )
        .unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_required: Claude transcript does not contain first-message identity evidence yet"
        );
    }

    // A first-launch pane registers its pid before any turn is recorded, so the
    // transcript tree does not exist yet. That is the same "not yet" the missing
    // transcript file reports — a refusal here latches a blocking readiness that
    // is never re-probed and permanently blocks credential migration.
    #[test]
    fn missing_project_directory_waits_for_the_first_recorded_turn() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        fs::remove_dir_all(claude_home.join("projects").join(encode_cwd(&cwd))).unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_required: Claude project directory is not available yet"
        );
    }

    #[test]
    fn missing_projects_root_waits_for_the_first_recorded_turn() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        fs::remove_dir_all(claude_home.join("projects")).unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_required: Claude projects root is not available yet"
        );
    }

    // Absence is pending; a present entry that is not an owned real directory is
    // still unverifiable evidence and must stay fail-closed.
    #[test]
    fn a_project_path_that_is_not_a_directory_still_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let project = claude_home.join("projects").join(encode_cwd(&cwd));
        fs::remove_dir_all(&project).unwrap();
        fs::write(&project, b"not a directory").unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_unverified: Claude project directory is untrusted"
        );
    }

    #[test]
    fn a_symlinked_project_directory_still_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let project = claude_home.join("projects").join(encode_cwd(&cwd));
        let elsewhere = temp.path().join("elsewhere");
        fs::rename(&project, &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &project).unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert_eq!(
            error,
            "conversation_identity_unverified: Claude project directory is untrusted"
        );
    }

    #[test]
    fn stale_pid_registry_generation_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let stale = ProcessStartEvidence {
            unix_ms: process_start().unix_ms + 60_000,
            utc_label: "Wed Jul 29 13:41:11 2026".into(),
        };

        let error = exact_conversation_from_state(&claude_home, pid, &cwd, &stale).unwrap_err();

        assert!(error.starts_with("conversation_identity_mismatch:"));
    }

    #[test]
    fn transcript_with_another_identity_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo/worktree");
        fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &cwd);
        let transcript = claude_home
            .join("projects")
            .join(encode_cwd(&cwd))
            .join(format!("{id}.jsonl"));
        fs::write(
            transcript,
            format!(
                "{}\n",
                serde_json::json!({
                    "sessionId": "737e9ac1-26f3-4e4b-b801-aa97a1e60fff",
                    "cwd": cwd,
                    "isSidechain": false
                })
            ),
        )
        .unwrap();

        let error =
            exact_conversation_from_state(&claude_home, pid, &cwd, &process_start()).unwrap_err();

        assert!(error.starts_with("conversation_identity_mismatch:"));
    }

    #[test]
    fn registry_cwd_mismatch_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let source_cwd = temp.path().join("repo/source");
        let requested_cwd = temp.path().join("repo/other");
        fs::create_dir_all(&source_cwd).unwrap();
        fs::create_dir_all(&requested_cwd).unwrap();
        let source_cwd = source_cwd.canonicalize().unwrap();
        let requested_cwd = requested_cwd.canonicalize().unwrap();
        let pid = 42_424;
        let id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        let claude_home = fixture(&temp, pid, id, &source_cwd);

        let error =
            exact_conversation_from_state(&claude_home, pid, &requested_cwd, &process_start())
                .unwrap_err();

        assert!(error.starts_with("conversation_identity_mismatch:"));
    }
}
