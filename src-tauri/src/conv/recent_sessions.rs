use serde::Serialize;
#[path = "pi_sessions.rs"]
mod pi_sessions;
#[cfg(test)]
#[path = "session_title_tests.rs"]
mod session_title_tests;
use super::codex_thread_index::state_database_path as codex_state_database_path;
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row,
};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::usage_cache::FileStamp;

use ssh2::Sftp;

const MAX_DISCOVERED_SESSIONS: usize = 200;
const MAX_PROVIDER_RECORDS: usize = 200;
const MAX_PROVIDER_DIRECTORIES: usize = 256;
const MAX_SESSION_BYTES: u64 = 1024 * 1024;
const MAX_TRANSCRIPT_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES: usize = 10_000;
const MAX_TRANSCRIPT_DISCOVERY_ENTRIES: usize = 131_072;
/// Upper bound on entries per provider-scan cache; far above any real session
/// tree (about 1k files today). Reaching it clears the map — a one-off
/// re-read, never staleness.
const CODEX_SCAN_CACHE_CAP: usize = 16_384;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_OPENCODE_DATABASES: usize = 8;
// Remote discovery runs automatically during first-run preview. Keep both the
// number of SFTP round trips and transferred transcript bytes independent of
// the size of a long-lived remote history.
const MAX_REMOTE_PROVIDER_RECORDS: usize = 48;
const MAX_REMOTE_DIRECTORIES: usize = 32;
const MAX_REMOTE_PREFIX_BYTES: u64 = 64 * 1024;
const MAX_REMOTE_SUFFIX_BYTES: u64 = 128 * 1024;
const MAX_REMOTE_AGE_SECONDS: u64 = 30 * 24 * 60 * 60;
const MAX_RECENT_TURNS: usize = 5;
const MAX_TURN_PREVIEW_CHARS: usize = 360;
const MAX_SUBAGENT_PREVIEWS: usize = 8;
const SUBAGENT_ACTIVE_AGE_SECONDS: u64 = 5 * 60;
const MAX_BRANCH_CHARS: usize = 256;
const MAX_SESSION_SETTING_CHARS: usize = 128;

type LocalLocation = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);
type RemoteLocation = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

/// Repository placement of remote working directories, resolved once per
/// distinct directory for the life of one scan.
///
/// Each answer used to be an SFTP walk: a `stat` per ancestor to find the
/// nearest existing directory, a `stat` per ancestor again to find `.git`,
/// then `realpath` and file reads for the gitdir, commondir and config —
/// easily thirty round trips per directory. The same questions are one
/// shell command on the box, answered in one round trip.
struct RemoteLocations<'a> {
    session: &'a ssh2::Session,
    cache: HashMap<String, Option<RemoteLocation>>,
}

impl<'a> RemoteLocations<'a> {
    fn new(session: &'a ssh2::Session) -> Self {
        Self {
            session,
            cache: HashMap::new(),
        }
    }

    fn resolve(&mut self, cwd: &str) -> Option<RemoteLocation> {
        if let Some(known) = self.cache.get(cwd) {
            return known.clone();
        }
        match remote_location(self.session, cwd) {
            RemoteAnswer::Answered(location) => {
                self.cache.insert(cwd.to_string(), location.clone());
                location
            }
            // A box that did not answer still has the conversation: the
            // record is listed without repository placement, and the next
            // record may find the box answering again.
            RemoteAnswer::Unanswered => {
                Some((cwd.trim().to_string(), None, None, None, false))
            }
        }
    }
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ResumeCapability {
    Exact,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLocation {
    Local,
    Ssh,
}

#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationInteractionKind {
    Interactive,
    NonInteractive,
}

#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationTurnRole {
    User,
    Agent,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurnPreview {
    pub role: ConversationTurnRole,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTranscriptEntry {
    pub role: ConversationTurnRole,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConversationTranscript {
    pub schema_version: u16,
    pub provider: String,
    pub conversation_id: String,
    pub history_complete: bool,
    pub final_response: Option<String>,
    pub entries: Vec<ProviderTranscriptEntry>,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSubagentPreview {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub status: ConversationSubagentStatus,
    pub mtime: u64,
}

#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationSubagentStatus {
    Running,
    Completed,
    Failed,
    Unknown,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ProviderConversationInputAuthority {
    Independent,
    ControlledByParent { parent_conversation_id: String },
    Unverified,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConversationDetails {
    pub input_authority: ProviderConversationInputAuthority,
    pub subagents: Vec<ConversationSubagentPreview>,
    pub total_count: usize,
}

fn execution_location(host_id: Option<&str>) -> ExecutionLocation {
    match host_id {
        Some(_) => ExecutionLocation::Ssh,
        None => ExecutionLocation::Local,
    }
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConversationRecord {
    pub provider: String,
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub mtime: u64,
    pub resume_capability: ResumeCapability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_kind: Option<ConversationInteractionKind>,
    pub working_directory_available: bool,
    pub execution_location: ExecutionLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_common_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_remote_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_turns: Vec<ConversationTurnPreview>,
    #[serde(skip_serializing_if = "is_zero")]
    pub subagent_count: usize,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[derive(Clone)]
struct Candidate {
    record: ProviderConversationRecord,
    logical_identity: String,
}

#[derive(Clone)]
struct DiscoveryRoots {
    claude_projects: PathBuf,
    codex_sessions: PathBuf,
    codex_state_database: PathBuf,
    gemini: PathBuf,
    pi_sessions: PathBuf,
    grok: PathBuf,
    opencode_data: PathBuf,
    opencode_db_override: Option<PathBuf>,
}

impl DiscoveryRoots {
    fn from_environment() -> Self {
        let home = std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_default();
        let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        let gemini = std::env::var_os("GEMINI_CLI_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".gemini"));
        let pi_sessions = std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("PI_CODING_AGENT_DIR")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".pi/agent"))
                    .join("sessions")
            });
        let grok = std::env::var_os("GROK_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".grok"));
        let xdg_data = std::env::var_os("XDG_DATA_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"));
        let opencode_data = xdg_data.join("opencode");
        let opencode_db_override = std::env::var_os("OPENCODE_DB")
            .filter(|value| !value.is_empty() && value != ":memory:")
            .map(PathBuf::from)
            .map(|value| {
                if value.is_absolute() {
                    value
                } else {
                    opencode_data.join(value)
                }
            });
        let codex_root = std::env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let codex_sessions = codex_root.join("sessions");
        let codex_state_database = codex_state_database_path(
            &codex_root,
            std::env::var_os("CODEX_SQLITE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        );

        Self {
            claude_projects: claude.join("projects"),
            codex_sessions,
            codex_state_database,
            gemini,
            pi_sessions,
            grok,
            opencode_data,
            opencode_db_override,
        }
    }
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:+-".contains(character))
}

fn clip(value: &str) -> String {
    value.trim().chars().take(64).collect()
}

fn referenced_directory(marker: &Path, prefix: &str) -> Option<PathBuf> {
    let content = bounded_full(marker, 4096)?;
    let value = content.trim().strip_prefix(prefix)?.trim();
    if value.is_empty() {
        return None;
    }
    let value = PathBuf::from(value);
    let resolved = if value.is_absolute() {
        value
    } else {
        marker.parent()?.join(value)
    };
    fs::canonicalize(resolved).ok().filter(|path| path.is_dir())
}

fn normalized_remote_path(host: &str, port: Option<u16>, path: &str) -> Option<String> {
    let host = host.trim().to_ascii_lowercase();
    let path = path.trim().trim_matches('/').trim_end_matches(".git");
    if host.is_empty()
        || path.is_empty()
        || path.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..")
        || host.chars().any(char::is_whitespace)
        || path.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some(match port {
        Some(port) => format!("{host}:{port}/{path}"),
        None => format!("{host}/{path}"),
    })
}

fn normalized_remote_identity(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.contains("://") {
        let parsed = tauri::Url::parse(raw).ok()?;
        if !matches!(parsed.scheme(), "http" | "https" | "ssh" | "git")
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return None;
        }
        let port = match (parsed.scheme(), parsed.port()) {
            ("http", Some(80))
            | ("https", Some(443))
            | ("ssh", Some(22))
            | ("git", Some(9418)) => None,
            (_, port) => port,
        };
        return normalized_remote_path(parsed.host_str()?, port, parsed.path());
    }

    // Git's scp-like syntax: [user@]host:path. Local and relative paths are
    // deliberately excluded because they are not stable cross-host identities.
    let (authority, path) = raw.split_once(':')?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    if host.contains('/')
        || !host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-".contains(character))
    {
        return None;
    }
    normalized_remote_path(host, None, path)
}

fn origin_remote_identity(config: &str) -> Option<String> {
    let mut in_origin = false;
    let mut urls = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            let section = line[1..line.len() - 1].trim().to_ascii_lowercase();
            in_origin = section == "remote \"origin\"";
            continue;
        }
        if !in_origin || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("url") {
            urls.push(normalized_remote_identity(value.trim())?);
        }
    }
    (urls.len() == 1).then(|| urls.remove(0))
}

fn repository_metadata(root: &Path) -> Option<(PathBuf, Option<String>)> {
    let marker = root.join(".git");
    let git_dir = if marker.is_dir() {
        fs::canonicalize(marker).ok()?
    } else if marker.is_file() {
        referenced_directory(&marker, "gitdir:")?
    } else {
        return None;
    };
    let common_marker = git_dir.join("commondir");
    let common_dir = if common_marker.is_file() {
        referenced_directory(&common_marker, "").or(Some(git_dir))
    } else {
        Some(git_dir)
    }?;
    let remote_identity = bounded_full(&common_dir.join("config"), MAX_METADATA_BYTES)
        .and_then(|config| origin_remote_identity(&config));
    Some((common_dir, remote_identity))
}

fn local_location(cwd: &str) -> Option<LocalLocation> {
    let original = Path::new(cwd.trim());
    if !original.is_absolute() {
        return None;
    }
    let working_directory_available = original.is_dir();

    let mut nearest_existing = original.to_path_buf();
    while !nearest_existing.is_dir() {
        if !nearest_existing.pop() {
            break;
        }
    }
    if nearest_existing.is_dir() {
        let mut ancestor = fs::canonicalize(&nearest_existing).unwrap_or(nearest_existing);
        loop {
            if let Some((common_dir, remote_identity)) = repository_metadata(&ancestor) {
                let canonical_cwd = fs::canonicalize(original)
                    .unwrap_or_else(|_| original.to_path_buf())
                    .to_string_lossy()
                    .into_owned();
                return Some((
                    canonical_cwd,
                    Some(ancestor.to_string_lossy().into_owned()),
                    Some(common_dir.to_string_lossy().into_owned()),
                    remote_identity,
                    working_directory_available,
                ));
            }
            if !ancestor.pop() {
                break;
            }
        }
    }

    let cwd = fs::canonicalize(original).unwrap_or_else(|_| original.to_path_buf());
    Some((
        cwd.to_string_lossy().into_owned(),
        None,
        None,
        None,
        working_directory_available,
    ))
}

fn record(
    provider: &str,
    id: &str,
    cwd: &str,
    title: Option<String>,
    fallback_title: &str,
    mtime: u64,
    logical_identity: Option<String>,
) -> Option<Candidate> {
    let (
        cwd,
        repository_root,
        repository_common_dir,
        repository_remote_identity,
        working_directory_available,
    ) = local_location(cwd)?;
    if !safe_id(id) {
        return None;
    }
    let title = title
        .map(|value| clip(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_title.to_string());
    Some(Candidate {
        record: ProviderConversationRecord {
            provider: provider.to_string(),
            id: id.to_string(),
            cwd: cwd.to_string(),
            title,
            mtime,
            resume_capability: ResumeCapability::Exact,
            interaction_kind: None,
            working_directory_available,
            execution_location: execution_location(None),
            host_id: None,
            repository_root,
            repository_common_dir,
            repository_remote_identity,
            branch: None,
            model: None,
            effort: None,
            recent_turns: Vec::new(),
            subagent_count: 0,
        },
        logical_identity: logical_identity.unwrap_or_else(|| id.to_string()),
    })
}

fn remote_bounded_prefix(sftp: &Sftp, path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = sftp.stat(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    remote_prefix_with_size(sftp, path, metadata.size?, max_bytes)
}

fn remote_prefix_with_size(
    sftp: &Sftp,
    path: &Path,
    size: u64,
    max_bytes: u64,
) -> Option<String> {
    if size == 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(size.min(max_bytes) as usize);
    sftp.open(path)
        .ok()?
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn remote_suffix_with_size(
    sftp: &Sftp,
    path: &Path,
    size: u64,
    max_bytes: u64,
) -> Option<String> {
    if size == 0 {
        return None;
    }
    let mut file = sftp.open(path).ok()?;
    let start = size.saturating_sub(max_bytes);
    file.seek(std::io::SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        let newline = text.find('\n')?;
        text.drain(..=newline);
    }
    Some(text)
}

/// One POSIX shell answer for [`remote_location`]: whether the directory
/// exists, the nearest existing ancestor's repository root (a `.git`
/// directory, or a `.git` file naming one), its common dir, and that common
/// dir's `config` text. Mirrors [`repository_metadata`] step for step so a
/// remote record carries the same identity as the local reader would derive.
fn remote_location_script(cwd: &str) -> String {
    format!(
        r#"cwd={cwd}
avail=0
[ -d "$cwd" ] && avail=1
printf 'available=%s\n' "$avail"
d=$cwd
while [ ! -d "$d" ]; do
  p=$(dirname -- "$d")
  [ "$p" = "$d" ] && break
  d=$p
done
[ -d "$d" ] || exit 0
a=$(cd -- "$d" 2>/dev/null && pwd -P) || exit 0
while :; do
  g=
  if [ -d "$a/.git" ]; then
    g=$(cd -- "$a/.git" 2>/dev/null && pwd -P)
  elif [ -f "$a/.git" ]; then
    v=$(head -c 4096 -- "$a/.git" 2>/dev/null | sed -n '1s/^gitdir:[[:space:]]*//p' | sed 's/[[:space:]]*$//')
    if [ -n "$v" ]; then
      case $v in /*) ;; *) v="$a/$v" ;; esac
      g=$(cd -- "$v" 2>/dev/null && pwd -P)
    fi
  fi
  if [ -n "$g" ]; then
    c=$g
    if [ -f "$g/commondir" ]; then
      v=$(head -c 4096 -- "$g/commondir" 2>/dev/null | sed -n '1p' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      if [ -n "$v" ]; then
        case $v in /*) ;; *) v="$g/$v" ;; esac
        c=$(cd -- "$v" 2>/dev/null && pwd -P) || c=$g
      fi
    fi
    canon=$(cd -- "$cwd" 2>/dev/null && pwd -P) || canon=$cwd
    printf 'cwd=%s\nroot=%s\ncommon=%s\nconfig<<\n' "$canon" "$a" "$c"
    [ -f "$c/config" ] && head -c {max_config} -- "$c/config"
    exit 0
  fi
  [ "$a" = / ] && exit 0
  a=$(dirname -- "$a")
done
"#,
        cwd = crate::ssh::shell_quote(cwd),
        max_config = MAX_METADATA_BYTES,
    )
}

fn parse_remote_location(original: &str, stdout: &str) -> Option<RemoteLocation> {
    let (facts, config) = match stdout.split_once("config<<\n") {
        Some((facts, config)) => (facts, Some(config)),
        None => (stdout, None),
    };
    let mut available = None;
    let mut canonical_cwd = None;
    let mut root = None;
    let mut common = None;
    for line in facts.lines() {
        if let Some(value) = line.strip_prefix("available=") {
            available = Some(value == "1");
        } else if let Some(value) = line.strip_prefix("cwd=") {
            canonical_cwd = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("root=") {
            root = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("common=") {
            common = Some(value.to_string());
        }
    }
    let working_directory_available = available?;
    match (root, common) {
        (Some(root), Some(common)) => Some((
            canonical_cwd.unwrap_or_else(|| original.to_string()),
            Some(root),
            Some(common),
            config.and_then(origin_remote_identity),
            working_directory_available,
        )),
        _ => Some((
            original.to_string(),
            None,
            None,
            None,
            working_directory_available,
        )),
    }
}

enum RemoteAnswer {
    /// The box answered; `None` means the path itself is refused.
    Answered(Option<RemoteLocation>),
    /// The exchange failed before the box could answer.
    Unanswered,
}

fn remote_location(session: &ssh2::Session, cwd: &str) -> RemoteAnswer {
    let original = cwd.trim();
    if !Path::new(original).is_absolute() {
        return RemoteAnswer::Answered(None);
    }
    // Under `sh` explicitly: the account's login shell may not be POSIX.
    let command = format!(
        "sh -c {}",
        crate::ssh::shell_quote(&remote_location_script(original))
    );
    match crate::ssh::exec_on(session, &command) {
        Ok(result) if result.code == 0 => {
            RemoteAnswer::Answered(parse_remote_location(original, &result.stdout))
        }
        _ => RemoteAnswer::Unanswered,
    }
}

struct RemoteRecord<'a> {
    host_id: &'a str,
    provider: &'a str,
    id: &'a str,
    cwd: &'a str,
    title: Option<String>,
    fallback_title: &'a str,
    mtime: u64,
    logical_identity: Option<String>,
}

fn remote_record(
    locations: &mut RemoteLocations<'_>,
    input: RemoteRecord<'_>,
) -> Option<Candidate> {
    if !safe_id(input.host_id) || !safe_id(input.id) {
        return None;
    }
    let location = locations.resolve(input.cwd)?;
    let (
        cwd,
        repository_root,
        repository_common_dir,
        repository_remote_identity,
        working_directory_available,
    ) = location;
    let title = input
        .title
        .map(|value| clip(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| input.fallback_title.to_string());
    Some(Candidate {
        record: ProviderConversationRecord {
            provider: input.provider.to_string(),
            id: input.id.to_string(),
            cwd,
            title,
            mtime: input.mtime,
            resume_capability: ResumeCapability::Exact,
            interaction_kind: None,
            working_directory_available,
            execution_location: execution_location(Some(input.host_id)),
            host_id: Some(input.host_id.to_string()),
            repository_root,
            repository_common_dir,
            repository_remote_identity,
            branch: None,
            model: None,
            effort: None,
            recent_turns: Vec::new(),
            subagent_count: 0,
        },
        logical_identity: input
            .logical_identity
            .unwrap_or_else(|| input.id.to_string()),
    })
}

fn mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn bounded_full(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .ok()?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > max_bytes {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn bounded_prefix(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    fs::File::open(path)
        .ok()?
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn bounded_suffix(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let start = metadata.len().saturating_sub(max_bytes);
    file.seek(std::io::SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        let newline = text.find('\n')?;
        text.drain(..=newline);
    }
    Some(text)
}

fn text_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| part.as_str())
                })
                .collect::<String>();
            (!joined.trim().is_empty()).then_some(joined)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn turn_preview_text(text: String) -> Option<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(MAX_TURN_PREVIEW_CHARS).collect())
}

fn bounded_label(value: &str, max_chars: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(max_chars).collect())
}

fn latest_recent_turns(
    content: &str,
    parse: fn(&Value) -> Option<(ConversationTurnRole, String)>,
) -> Vec<ConversationTurnPreview> {
    let mut turns = Vec::with_capacity(MAX_RECENT_TURNS);
    for value in content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        let Some((role, text)) = parse(&value) else {
            continue;
        };
        let Some(text) = turn_preview_text(text) else {
            continue;
        };
        let preview = ConversationTurnPreview { role, text };
        if turns.last() == Some(&preview) {
            continue;
        }
        if turns.len() == MAX_RECENT_TURNS {
            turns.remove(0);
        }
        turns.push(preview);
    }
    turns
}

fn recent_turns_from_bounded_windows(
    prefix: &str,
    suffix: Option<&str>,
    file_size: u64,
    prefix_window_bytes: u64,
    parse: fn(&Value) -> Option<(ConversationTurnRole, String)>,
) -> Vec<ConversationTurnPreview> {
    match suffix {
        Some(content) => latest_recent_turns(content, parse),
        None if file_size <= prefix_window_bytes => latest_recent_turns(prefix, parse),
        None => Vec::new(),
    }
}

fn claude_user_text(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    value.pointer("/message/content").and_then(text_content)
}

fn claude_turn(value: &Value) -> Option<(ConversationTurnRole, String)> {
    let role = match value.get("type").and_then(Value::as_str) {
        Some("user") => ConversationTurnRole::User,
        Some("assistant") => ConversationTurnRole::Agent,
        _ => return None,
    };
    let text = value.pointer("/message/content").and_then(text_content)?;
    if role == ConversationTurnRole::User && claude_context_injection(&text) {
        return None;
    }
    Some((role, text))
}

fn claude_metadata(content: &str) -> (Option<String>, Option<String>, bool) {
    let mut cwd = None;
    let mut identity = None;
    let mut auxiliary = false;
    for value in content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        auxiliary |= value.get("isSidechain").and_then(Value::as_bool) == Some(true);
        if cwd.is_none() {
            cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if identity.is_none() && claude_user_text(&value).is_some() {
            identity = value.get("uuid").and_then(Value::as_str).map(str::to_string);
        }
        if cwd.is_some() && identity.is_some() {
            break;
        }
    }
    (cwd, identity, auxiliary)
}

fn claude_branch(content: &str) -> Option<String> {
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|value| {
            value
                .get("gitBranch")
                .and_then(Value::as_str)
                .and_then(|branch| bounded_label(branch, MAX_BRANCH_CHARS))
        })
}

fn latest_claude_settings(content: &str) -> (Option<String>, Option<String>) {
    let mut model = None;
    let mut effort = None;
    for value in content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("assistant"))
    {
        let next_model = value
            .pointer("/message/model")
            .or_else(|| value.get("model"))
            .and_then(Value::as_str);
        if next_model == Some("<synthetic>") {
            continue;
        }
        if let Some(next) =
            next_model.and_then(|value| bounded_label(value, MAX_SESSION_SETTING_CHARS))
        {
            model = Some(next);
        }
        if let Some(next) = value
            .get("effort")
            .or_else(|| value.pointer("/message/effort"))
            .or_else(|| value.get("reasoning_effort"))
            .or_else(|| value.pointer("/message/reasoning_effort"))
            .and_then(Value::as_str)
            .and_then(|value| bounded_label(value, MAX_SESSION_SETTING_CHARS))
        {
            effort = Some(next);
        }
    }
    (model, effort)
}

fn claude_session_settings(
    prefix: &str,
    suffix: Option<&str>,
) -> (Option<String>, Option<String>) {
    let prefix = latest_claude_settings(prefix);
    let suffix = suffix.map(latest_claude_settings).unwrap_or_default();
    (suffix.0.or(prefix.0), suffix.1.or(prefix.1))
}

fn latest_claude_title(content: &str) -> Option<String> {
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| claude_user_text(&value))
        .filter(|text| {
            let text = text.trim();
            !text.is_empty() && !text.starts_with('<') && !text.starts_with("Caveat:")
        })
        .map(|text| clip(&text))
        .next_back()
}

fn claude_subagent_id(path: &Path) -> Option<&str> {
    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return None;
    }
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|id| id.starts_with("agent-") && safe_id(id))
}

fn claude_subagent_count(project: &Path, conversation_id: &str) -> usize {
    let directory = project.join(conversation_id).join("subagents");
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries
        .flatten()
        .take(MAX_PROVIDER_RECORDS)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && claude_subagent_id(&entry.path()).is_some()
        })
        .count()
}

struct RemoteClaudeSubagentFile {
    id: String,
    path: PathBuf,
    modified: u64,
    size: u64,
}

fn remote_claude_subagent_files(
    sftp: &Sftp,
    project: &Path,
    conversation_id: &str,
) -> Vec<RemoteClaudeSubagentFile> {
    if !safe_id(conversation_id) {
        return Vec::new();
    }
    let directory = project.join(conversation_id).join("subagents");
    let Ok(entries) = sftp.readdir(&directory) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .take(MAX_PROVIDER_RECORDS)
        .filter_map(|(path, metadata)| {
            if !metadata.is_file() {
                return None;
            }
            let id = claude_subagent_id(&path)?;
            Some(RemoteClaudeSubagentFile {
                id: id.to_string(),
                path,
                modified: metadata.mtime.unwrap_or(0),
                size: metadata.size?,
            })
        })
        .collect()
}

fn collect_claude(root: &Path, output: &mut Vec<Candidate>) {
    let Ok(projects) = fs::read_dir(root) else {
        return;
    };
    let mut inspected = 0;
    for project in projects.flatten().take(MAX_PROVIDER_DIRECTORIES) {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(project.path()) else {
            continue;
        };
        for file in files
            .flatten()
            .take(MAX_PROVIDER_RECORDS.saturating_sub(inspected))
        {
            if inspected >= MAX_PROVIDER_RECORDS {
                return;
            }
            inspected += 1;
            if !file.file_type().is_ok_and(|kind| kind.is_file())
                || file.path().extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                continue;
            }
            let path = file.path();
            let file_size = file
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(MAX_SESSION_BYTES.saturating_add(1));
            let Some(prefix) = bounded_prefix(&path, MAX_SESSION_BYTES) else {
                continue;
            };
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let (cwd, identity, auxiliary) = claude_metadata(&prefix);
            if auxiliary {
                continue;
            }
            let Some(cwd) = cwd else {
                continue;
            };
            let suffix = bounded_suffix(&path, MAX_SESSION_BYTES);
            let title = super::claude_session_title::named_title(&prefix, suffix.as_deref(), id)
                .or_else(|| suffix.as_deref().and_then(latest_claude_title))
                .or_else(|| latest_claude_title(&prefix));
            if let Some(mut candidate) = record(
                "claude",
                id,
                &cwd,
                title,
                "Claude Code",
                mtime(&path),
                identity,
            ) {
                candidate.record.branch = claude_branch(&prefix);
                (candidate.record.model, candidate.record.effort) =
                    claude_session_settings(&prefix, suffix.as_deref());
                candidate.record.recent_turns = recent_turns_from_bounded_windows(
                    &prefix,
                    suffix.as_deref(),
                    file_size,
                    MAX_SESSION_BYTES,
                    claude_turn,
                );
                candidate.record.subagent_count = claude_subagent_count(&project.path(), id);
                output.push(candidate);
            }
        }
    }
}

fn codex_content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter(|part| {
                    matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("input_text" | "output_text" | "text")
                    )
                })
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn provider_context_injection(text: &str) -> bool {
    let text = text.trim_start();
    [
        "# AGENTS.md instructions for ",
        "<system-reminder>",
        "<environment_context>",
        "<INSTRUCTIONS>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "<apps_instructions>",
        "<plugins_instructions>",
        "<skills_instructions>",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

fn claude_context_injection(text: &str) -> bool {
    provider_context_injection(text) || text.trim_start().starts_with("Caveat:")
}

fn codex_user_text(value: &Value) -> Option<String> {
    let payload = value.get("payload").unwrap_or(value);
    if payload.get("type").and_then(Value::as_str) == Some("user_message") {
        return payload
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    if payload.get("type").and_then(Value::as_str) == Some("message")
        && payload.get("role").and_then(Value::as_str) == Some("user")
    {
        return payload.get("content").and_then(codex_content_text);
    }
    None
}

fn codex_turn(value: &Value) -> Option<(ConversationTurnRole, String)> {
    let payload = value.get("payload").unwrap_or(value);
    if payload.get("type").and_then(Value::as_str) == Some("user_message") {
        let text = payload.get("message").and_then(Value::as_str)?.to_string();
        if provider_context_injection(&text) {
            return None;
        }
        return Some((ConversationTurnRole::User, text));
    }
    if payload.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let role = match payload.get("role").and_then(Value::as_str) {
        Some("user") => ConversationTurnRole::User,
        Some("assistant") => ConversationTurnRole::Agent,
        _ => return None,
    };
    let text = payload.get("content").and_then(codex_content_text)?;
    if role == ConversationTurnRole::User && provider_context_injection(&text) {
        return None;
    }
    Some((role, text))
}

fn latest_codex_title(content: &str) -> Option<String> {
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| codex_user_text(&value))
        .filter(|text| !provider_context_injection(text))
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
        .map(|text| clip(&text))
        .next_back()
}

fn codex_interaction_kind(metadata: &Value) -> Option<ConversationInteractionKind> {
    match metadata.pointer("/payload/originator").and_then(Value::as_str) {
        Some("codex-tui") => Some(ConversationInteractionKind::Interactive),
        Some("codex_exec") => Some(ConversationInteractionKind::NonInteractive),
        _ => None,
    }
}

fn codex_branch(metadata: &Value) -> Option<String> {
    metadata
        .pointer("/payload/git/branch")
        .and_then(Value::as_str)
        .and_then(|branch| bounded_label(branch, MAX_BRANCH_CHARS))
}

fn latest_codex_settings(content: &str) -> (Option<String>, Option<String>) {
    let mut model = None;
    let mut effort = None;
    for value in content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("turn_context"))
    {
        let payload = value.get("payload").unwrap_or(&value);
        if let Some(next) = payload
            .get("model")
            .and_then(Value::as_str)
            .and_then(|value| bounded_label(value, MAX_SESSION_SETTING_CHARS))
        {
            model = Some(next);
        }
        if let Some(next) = payload
            .get("effort")
            .or_else(|| payload.get("reasoning_effort"))
            .and_then(Value::as_str)
            .and_then(|value| bounded_label(value, MAX_SESSION_SETTING_CHARS))
        {
            effort = Some(next);
        }
    }
    (model, effort)
}

fn codex_session_settings(
    prefix: &str,
    suffix: Option<&str>,
) -> (Option<String>, Option<String>) {
    let prefix = latest_codex_settings(prefix);
    let suffix = suffix.map(latest_codex_settings).unwrap_or_default();
    (suffix.0.or(prefix.0), suffix.1.or(prefix.1))
}

fn codex_is_subagent(metadata: &Value) -> bool {
    metadata
        .pointer("/payload/thread_source")
        .and_then(Value::as_str)
        == Some("subagent")
        || metadata.pointer("/payload/source/subagent").is_some()
}

#[derive(Clone)]
struct CodexSubagentReference {
    parent_id: String,
    id: String,
}

/// Per-file outcome of one bounded codex rollout inspection, replayable from
/// the scan cache when the file's (mtime, size) fingerprint is unchanged.
#[derive(Clone)]
enum CodexFileOutcome {
    /// Inspected and skipped (no session_meta, subagent duplicate shell,
    /// missing id/cwd, or an unrecordable cwd). Content-derived, so it stays
    /// valid until the file changes.
    Skip,
    Subagent(CodexSubagentReference),
    Candidate(Box<Candidate>),
}

struct CachedCodexFile {
    stamp: FileStamp,
    outcome: CodexFileOutcome,
}

/// Codex rollout scan cache. Consumers refresh the conversation listing on a
/// 30s-class staleness while a real `~/.codex/sessions` tree can hold 100GB;
/// re-reading every unchanged file's bounded prefix+suffix (≤2MiB each)
/// summed to ~5MB/s of steady disk reads on the 2026-08-24 live daily driver
/// (~430GB/day of cumulative I/O in Activity Monitor). Entries are shared
/// in place — concurrent scans are the production norm, so a scan must never
/// drop entries it did not visit — and bounded by CODEX_SCAN_CACHE_CAP.
fn codex_scan_cache() -> &'static Mutex<HashMap<PathBuf, CachedCodexFile>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedCodexFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn codex_subagent_reference(metadata: &Value) -> Option<CodexSubagentReference> {
    if !codex_is_subagent(metadata) {
        return None;
    }
    let parent_id = metadata
        .pointer("/payload/source/subagent/thread_spawn/parent_thread_id")
        .or_else(|| metadata.pointer("/payload/parent_thread_id"))
        .and_then(Value::as_str)?;
    let id = metadata.pointer("/payload/id").and_then(Value::as_str)?;
    if !safe_id(parent_id) || !safe_id(id) {
        return None;
    }
    Some(CodexSubagentReference {
        parent_id: parent_id.to_string(),
        id: id.to_string(),
    })
}

fn codex_input_authority(
    metadata: &Value,
    conversation_id: &str,
) -> Option<ProviderConversationInputAuthority> {
    let id = metadata.pointer("/payload/id").and_then(Value::as_str)?;
    if id != conversation_id || !safe_id(id) {
        return None;
    }
    if let Some(reference) = codex_subagent_reference(metadata) {
        return Some(ProviderConversationInputAuthority::ControlledByParent {
            parent_conversation_id: reference.parent_id,
        });
    }
    Some(if codex_is_subagent(metadata) {
        ProviderConversationInputAuthority::Unverified
    } else {
        ProviderConversationInputAuthority::Independent
    })
}

struct InputAuthorityObservation {
    authority: ProviderConversationInputAuthority,
    modified: u64,
}

fn observe_input_authority(
    observation: &mut Option<InputAuthorityObservation>,
    authority: ProviderConversationInputAuthority,
    modified: u64,
) {
    if observation
        .as_ref()
        .is_some_and(|current| current.modified > modified)
    {
        return;
    }
    *observation = Some(InputAuthorityObservation {
        authority,
        modified,
    });
}

/// Read one rollout file's bounded windows and derive its scan outcome.
/// `None` means the file could not be read at all — that is not cached, so a
/// transient permission or race failure retries on the next scan.
fn inspect_codex_file(path: &Path, file_size: u64) -> Option<CodexFileOutcome> {
    let prefix = bounded_prefix(path, MAX_SESSION_BYTES)?;
    let Some(metadata) = prefix
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value.get("type").and_then(Value::as_str) == Some("session_meta"))
    else {
        return Some(CodexFileOutcome::Skip);
    };
    if codex_is_subagent(&metadata) {
        return Some(match codex_subagent_reference(&metadata) {
            Some(subagent) => CodexFileOutcome::Subagent(subagent),
            None => CodexFileOutcome::Skip,
        });
    }
    let Some(id) = metadata.pointer("/payload/id").and_then(Value::as_str) else {
        return Some(CodexFileOutcome::Skip);
    };
    let Some(cwd) = metadata.pointer("/payload/cwd").and_then(Value::as_str) else {
        return Some(CodexFileOutcome::Skip);
    };
    let suffix = bounded_suffix(path, MAX_SESSION_BYTES);
    let title = suffix
        .as_deref()
        .and_then(latest_codex_title)
        .or_else(|| latest_codex_title(&prefix));
    let Some(mut candidate) = record(
        "codex",
        id,
        cwd,
        title,
        "Codex",
        mtime(path),
        Some(id.to_string()),
    ) else {
        return Some(CodexFileOutcome::Skip);
    };
    candidate.record.interaction_kind = codex_interaction_kind(&metadata);
    candidate.record.branch = codex_branch(&metadata);
    (candidate.record.model, candidate.record.effort) =
        codex_session_settings(&prefix, suffix.as_deref());
    candidate.record.recent_turns = recent_turns_from_bounded_windows(
        &prefix,
        suffix.as_deref(),
        file_size,
        MAX_SESSION_BYTES,
        codex_turn,
    );
    Some(CodexFileOutcome::Candidate(Box::new(candidate)))
}

fn collect_codex_files(
    root: &Path,
    output: &mut Vec<Candidate>,
    subagents: &mut Vec<CodexSubagentReference>,
    cache: &Mutex<HashMap<PathBuf, CachedCodexFile>>,
) {
    for path in super::codex_rollout_files::recent(root, MAX_PROVIDER_RECORDS) {
        let stamp = FileStamp::of(&path);
        let cached_outcome = stamp.and_then(|now| {
            cache.lock().ok().and_then(|entries| {
                entries
                    .get(&path)
                    .filter(|cached| cached.stamp == now)
                    .map(|cached| cached.outcome.clone())
            })
        });
        let outcome = match (stamp, cached_outcome) {
            // Unchanged fingerprint — replay without opening the file.
            (_, Some(outcome)) => outcome,
            (stamp, None) => {
                let file_size = fs::metadata(&path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(MAX_SESSION_BYTES.saturating_add(1));
                let Some(outcome) = inspect_codex_file(&path, file_size) else {
                    continue;
                };
                // A file rewritten mid-inspection would be cached under the
                // pre-read stamp and caught by the next fingerprint check.
                if stamp.is_none() {
                    // Unfingerprintable files are never cached.
                    match &outcome {
                        CodexFileOutcome::Skip => {}
                        CodexFileOutcome::Subagent(subagent) => subagents.push(subagent.clone()),
                        CodexFileOutcome::Candidate(candidate) => {
                            output.push((**candidate).clone());
                        }
                    }
                    continue;
                }
                outcome
            }
        };
        match &outcome {
            CodexFileOutcome::Skip => {}
            CodexFileOutcome::Subagent(subagent) => subagents.push(subagent.clone()),
            CodexFileOutcome::Candidate(candidate) => output.push((**candidate).clone()),
        }
        if let Some(stamp) = stamp {
            if let Ok(mut entries) = cache.lock() {
                if entries.len() >= CODEX_SCAN_CACHE_CAP {
                    entries.clear();
                }
                entries.insert(path, CachedCodexFile { stamp, outcome });
            }
        }
    }
}

fn collect_codex(root: &Path, output: &mut Vec<Candidate>) {
    collect_codex_with_cache(root, output, codex_scan_cache());
}

fn collect_codex_with_cache(
    root: &Path,
    output: &mut Vec<Candidate>,
    cache: &Mutex<HashMap<PathBuf, CachedCodexFile>>,
) {
    let output_start = output.len();
    let mut subagents = Vec::new();
    collect_codex_files(root, output, &mut subagents, cache);
    let mut seen = HashSet::new();
    let mut counts = HashMap::new();
    for subagent in subagents {
        if !seen.insert((subagent.parent_id.clone(), subagent.id)) {
            continue;
        }
        *counts.entry(subagent.parent_id).or_insert(0usize) += 1;
    }
    for candidate in &mut output[output_start..] {
        candidate.record.subagent_count = counts.remove(&candidate.record.id).unwrap_or(0);
    }
    if let Some(provider_root) = root.parent() {
        let provider_titles = super::codex_thread_index::titles(provider_root);
        for candidate in &mut output[output_start..] {
            if let Some(title) = provider_titles.get(&candidate.record.id) {
                candidate.record.title = title.clone();
            }
        }
    }
}

#[derive(Default)]
struct ClaudeSubagentParentFact {
    title: Option<String>,
    status: Option<ConversationSubagentStatus>,
}

fn tagged_value<'a>(content: &'a str, tag: &str) -> Option<&'a str> {
    let opening = format!("<{tag}>");
    let closing = format!("</{tag}>");
    let start = content.find(&opening)? + opening.len();
    let end = content[start..].find(&closing)? + start;
    Some(&content[start..end])
}

fn claude_subagent_fact_id(value: &str) -> Option<String> {
    let value = value.trim();
    if !safe_id(value) {
        return None;
    }
    let id = if value.starts_with("agent-") {
        value.to_string()
    } else {
        format!("agent-{value}")
    };
    safe_id(&id).then_some(id)
}

fn marked_text<'a>(value: &'a Value, marker: &str) -> Option<&'a str> {
    match value {
        Value::String(text) => text.contains(marker).then_some(text.as_str()),
        Value::Array(items) => items.iter().find_map(|item| marked_text(item, marker)),
        Value::Object(object) => ["content", "text", "message"]
            .into_iter()
            .filter_map(|key| object.get(key))
            .find_map(|item| marked_text(item, marker)),
        _ => None,
    }
}

fn subagent_status(value: &str) -> Option<ConversationSubagentStatus> {
    match value {
        "async_launched" | "running" | "in_progress" => {
            Some(ConversationSubagentStatus::Running)
        }
        "completed" | "success" | "succeeded" => {
            Some(ConversationSubagentStatus::Completed)
        }
        "failed" | "error" | "cancelled" | "canceled" => {
            Some(ConversationSubagentStatus::Failed)
        }
        _ => None,
    }
}

fn collect_claude_parent_facts(
    content: &str,
    facts: &mut HashMap<String, ClaudeSubagentParentFact>,
) {
    for value in content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        if let Some(result) = value.get("toolUseResult") {
            if let Some(id) = result
                .get("agentId")
                .and_then(Value::as_str)
                .and_then(claude_subagent_fact_id)
            {
                let fact = facts.entry(id).or_default();
                if fact.title.is_none() {
                    fact.title = result
                        .get("description")
                        .and_then(Value::as_str)
                        .and_then(|title| bounded_label(title, 96));
                }
                if let Some(status) = result
                    .get("status")
                    .and_then(Value::as_str)
                    .and_then(subagent_status)
                {
                    fact.status = Some(status);
                }
            }
        }
        let notification = value
            .get("content")
            .and_then(|content| marked_text(content, "<task-notification>"))
            .or_else(|| {
                value
                    .get("message")
                    .and_then(|message| marked_text(message, "<task-notification>"))
            });
        let Some(notification) = notification
        else {
            continue;
        };
        let Some(id) = tagged_value(notification, "task-id").and_then(claude_subagent_fact_id)
        else {
            continue;
        };
        let fact = facts.entry(id).or_default();
        if fact.title.is_none() {
            fact.title = tagged_value(notification, "summary")
                .and_then(|title| bounded_label(title, 96));
        }
        if let Some(status) = tagged_value(notification, "status").and_then(subagent_status) {
            fact.status = Some(status);
        }
    }
}

fn status_with_freshness(
    explicit: Option<ConversationSubagentStatus>,
    modified: u64,
) -> ConversationSubagentStatus {
    if let Some(
        status @ (ConversationSubagentStatus::Completed | ConversationSubagentStatus::Failed),
    ) = explicit
    {
        return status;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if now.saturating_sub(modified) <= SUBAGENT_ACTIVE_AGE_SECONDS {
        ConversationSubagentStatus::Running
    } else {
        ConversationSubagentStatus::Unknown
    }
}

fn claude_subagent_preview(
    id: String,
    modified: u64,
    prefix: Option<&str>,
    suffix: Option<&str>,
    metadata: Option<&Value>,
    parent: Option<&ClaudeSubagentParentFact>,
) -> ConversationSubagentPreview {
    let title = metadata
        .and_then(|value| value.get("description"))
        .and_then(Value::as_str)
        .and_then(|value| bounded_label(value, 96))
        .or_else(|| parent.and_then(|fact| fact.title.clone()))
        .or_else(|| suffix.and_then(latest_claude_title))
        .or_else(|| prefix.and_then(latest_claude_title))
        .unwrap_or_else(|| id.clone());
    let kind = metadata
        .and_then(|value| value.get("agentType"))
        .and_then(Value::as_str)
        .and_then(|value| bounded_label(value, 48));
    ConversationSubagentPreview {
        id,
        title,
        kind,
        status: status_with_freshness(parent.and_then(|fact| fact.status), modified),
        mtime: modified,
    }
}

fn find_claude_conversation(
    root: &Path,
    conversation_id: &str,
) -> Option<(PathBuf, PathBuf)> {
    let projects = fs::read_dir(root).ok()?;
    projects
        .flatten()
        .take(MAX_TRANSCRIPT_DISCOVERY_ENTRIES)
        .filter(|project| project.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|project| {
            let path = project.path().join(format!("{conversation_id}.jsonl"));
            path.is_file()
                .then(|| (mtime(&path), project.path(), path))
        })
        .max_by_key(|(modified, _, _)| *modified)
        .map(|(_, project, path)| (project, path))
}

fn codex_file_has_identity(path: &Path, conversation_id: &str) -> bool {
    bounded_prefix(path, MAX_SESSION_BYTES).is_some_and(|prefix| {
        prefix
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|value| {
                value.get("type").and_then(Value::as_str) == Some("session_meta")
                    && value.pointer("/payload/id").and_then(Value::as_str)
                        == Some(conversation_id)
            })
    })
}

fn find_codex_conversation(
    directory: &Path,
    conversation_id: &str,
    depth: usize,
    inspected: &mut usize,
) -> Option<(u64, PathBuf)> {
    if depth > 4 || *inspected >= MAX_TRANSCRIPT_DISCOVERY_ENTRIES {
        return None;
    }
    let entries = fs::read_dir(directory).ok()?;
    let suffix = format!("{conversation_id}.jsonl");
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in entries
        .flatten()
        .take(MAX_TRANSCRIPT_DISCOVERY_ENTRIES.saturating_sub(*inspected))
    {
        if *inspected >= MAX_TRANSCRIPT_DISCOVERY_ENTRIES {
            break;
        }
        *inspected += 1;
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let candidate = if kind.is_dir() {
            find_codex_conversation(&entry.path(), conversation_id, depth + 1, inspected)
        } else if kind.is_file()
            && entry.file_name().to_string_lossy().ends_with(&suffix)
            && codex_file_has_identity(&entry.path(), conversation_id)
        {
            Some((mtime(&entry.path()), entry.path()))
        } else {
            None
        };
        if candidate
            .as_ref()
            .is_some_and(|(modified, _)| best.as_ref().is_none_or(|(current, _)| modified > current))
        {
            best = candidate;
        }
    }
    best
}

/// Preserve explicit provider final markers instead of guessing from the last
/// assistant message, which can be a tool preamble or interrupted response.
fn provider_final_response(provider: &str, value: &Value) -> Option<String> {
    match provider {
        "claude"
            if value
                .pointer("/message/stop_reason")
                .and_then(Value::as_str)
                == Some("end_turn") =>
        {
            claude_turn(value)
                .filter(|(role, _)| *role == ConversationTurnRole::Agent)
                .map(|(_, text)| text)
        }
        "codex" => {
            let payload = value.get("payload").unwrap_or(value);
            if payload.get("type").and_then(Value::as_str) == Some("task_complete") {
                return payload
                    .get("last_agent_message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            (payload.get("phase").and_then(Value::as_str) == Some("final_answer"))
                .then(|| codex_turn(value))
                .flatten()
                .filter(|(role, _)| *role == ConversationTurnRole::Agent)
                .map(|(_, text)| text)
        }
        _ => None,
    }
}

fn transcript_from_file(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    parse: fn(&Value) -> Option<(ConversationTurnRole, String)>,
) -> Result<ProviderConversationTranscript, String> {
    let before = fs::metadata(path).map_err(|error| format!("read provider transcript: {error}"))?;
    if before.len() > MAX_TRANSCRIPT_SOURCE_BYTES {
        return Err("provider transcript exceeds the source byte limit".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("read provider transcript: {error}"))?;
    if bytes.len() > MAX_TRANSCRIPT_SOURCE_BYTES as usize {
        return Err("provider transcript exceeds the source byte limit".to_string());
    }
    let utf8_complete = std::str::from_utf8(&bytes).is_ok();
    let content = String::from_utf8_lossy(&bytes);
    let mut entries = Vec::new();
    let mut output_bytes = 0usize;
    let mut history_complete = utf8_complete;
    let mut final_response = None;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => {
                history_complete = false;
                continue;
            }
        };
        if let Some(text) =
            provider_final_response(provider, &value).filter(|text| !text.trim().is_empty())
        {
            if text.len() > MAX_TRANSCRIPT_OUTPUT_BYTES {
                return Err("provider final response exceeds the output limit".to_string());
            }
            final_response = Some(text);
        }
        let Some((role, text)) = parse(&value) else {
            continue;
        };
        if role == ConversationTurnRole::User {
            final_response = None;
        }
        if text.trim().is_empty() {
            continue;
        }
        let entry = ProviderTranscriptEntry { role, text };
        output_bytes = output_bytes.saturating_add(entry.text.len());
        if output_bytes > MAX_TRANSCRIPT_OUTPUT_BYTES || entries.len() == MAX_TRANSCRIPT_ENTRIES {
            return Err("provider transcript exceeds the output limit".to_string());
        }
        entries.push(entry);
    }
    let unchanged = fs::metadata(path)
        .ok()
        .is_some_and(|after| after.len() == before.len() && after.modified().ok() == before.modified().ok());
    Ok(ProviderConversationTranscript {
        schema_version: 1,
        provider: provider.to_string(),
        conversation_id: conversation_id.to_string(),
        history_complete: history_complete && unchanged,
        final_response,
        entries,
    })
}

fn transcript_for_roots(
    roots: &DiscoveryRoots,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    if !safe_id(conversation_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let (path, parse) = match provider {
        "claude" => (
            find_claude_conversation(&roots.claude_projects, conversation_id)
                .map(|(_, path)| path),
            claude_turn as fn(&Value) -> Option<(ConversationTurnRole, String)>,
        ),
        "codex" => {
            let mut inspected = 0;
            let active = find_codex_conversation(
                &roots.codex_sessions,
                conversation_id,
                0,
                &mut inspected,
            );
            let archived = roots
                .codex_sessions
                .parent()
                .map(|root| root.join("archived_sessions"))
                .and_then(|directory| {
                    find_codex_conversation(
                        &directory,
                        conversation_id,
                        0,
                        &mut inspected,
                    )
                });
            (
                [active, archived]
                    .into_iter()
                    .flatten()
                    .max_by_key(|(modified, _)| *modified)
                    .map(|(_, path)| path),
                codex_turn as fn(&Value) -> Option<(ConversationTurnRole, String)>,
            )
        }
        _ => return Err("provider transcript export is unsupported".to_string()),
    };
    let path = path.ok_or_else(|| "provider conversation was not found".to_string())?;
    transcript_from_file(&path, provider, conversation_id, parse)
}

pub fn transcript_global(
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    transcript_for_roots(
        &DiscoveryRoots::from_environment(),
        provider,
        conversation_id,
    )
}

fn claude_details(
    root: &Path,
    conversation_id: &str,
) -> Result<ProviderConversationDetails, String> {
    let Some((project, parent_path)) = find_claude_conversation(root, conversation_id) else {
        return Err("provider conversation was not found".to_string());
    };
    let mut parent_facts = HashMap::new();
    if let Some(prefix) = bounded_prefix(&parent_path, MAX_SESSION_BYTES) {
        collect_claude_parent_facts(&prefix, &mut parent_facts);
    }
    if let Some(suffix) = bounded_suffix(&parent_path, MAX_SESSION_BYTES) {
        collect_claude_parent_facts(&suffix, &mut parent_facts);
    }
    let directory = project.join(conversation_id).join("subagents");
    let mut files = fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .take(MAX_PROVIDER_RECORDS)
                .filter(|entry| {
                    entry.file_type().is_ok_and(|kind| kind.is_file())
                        && claude_subagent_id(&entry.path()).is_some()
                })
                .map(|entry| (mtime(&entry.path()), entry.path()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    files.sort_by_key(|(modified, _)| Reverse(*modified));
    let total_count = files.len();
    let subagents = files
        .into_iter()
        .take(MAX_SUBAGENT_PREVIEWS)
        .filter_map(|(modified, path)| {
            let id = path.file_stem()?.to_str()?.to_string();
            let prefix = bounded_prefix(&path, MAX_SESSION_BYTES);
            let suffix = bounded_suffix(&path, MAX_SESSION_BYTES);
            let metadata = bounded_full(&path.with_extension("meta.json"), MAX_METADATA_BYTES)
                .and_then(|content| serde_json::from_str::<Value>(&content).ok());
            let parent = parent_facts.get(&id);
            Some(claude_subagent_preview(
                id,
                modified,
                prefix.as_deref(),
                suffix.as_deref(),
                metadata.as_ref(),
                parent,
            ))
        })
        .collect();
    Ok(ProviderConversationDetails {
        input_authority: ProviderConversationInputAuthority::Independent,
        subagents,
        total_count,
    })
}

fn codex_subagent_preview(
    id: String,
    modified: u64,
    prefix: &str,
    metadata: &Value,
    suffix: Option<&str>,
) -> ConversationSubagentPreview {
    let spawn = metadata.pointer("/payload/source/subagent/thread_spawn");
    let title = suffix
        .and_then(latest_codex_title)
        .or_else(|| latest_codex_title(prefix))
        .or_else(|| {
            spawn
                .and_then(|value| value.get("agent_nickname"))
                .and_then(Value::as_str)
                .and_then(|value| bounded_label(value, 96))
        })
        .or_else(|| {
            spawn
                .and_then(|value| value.get("agent_path"))
                .and_then(Value::as_str)
                .and_then(|value| value.rsplit('/').find(|segment| !segment.is_empty()))
                .and_then(|value| bounded_label(value, 96))
        })
        .unwrap_or_else(|| id.clone());
    let kind = spawn
        .and_then(|value| value.get("agent_role"))
        .and_then(Value::as_str)
        .and_then(|value| bounded_label(value, 48));
    ConversationSubagentPreview {
        id,
        title,
        kind,
        status: status_with_freshness(None, modified),
        mtime: modified,
    }
}

struct CodexSubagentFile {
    id: String,
    path: PathBuf,
    /// Present only when the file was actually read this walk. Cache-replayed
    /// files carry `None`; the preview step re-reads the bounded prefix for
    /// the few files it selects.
    prefix: Option<String>,
    metadata: Value,
    modified: u64,
}

/// Per-file outcome of one subagent-membership inspection, parent-agnostic so
/// one cache serves the details view of every conversation.
#[derive(Clone)]
enum CodexSubagentScan {
    NotSubagent,
    Subagent {
        parent_id: String,
        id: String,
        metadata: Value,
    },
}

struct CachedCodexSubagentScan {
    stamp: FileStamp,
    scan: CodexSubagentScan,
}

/// Subagent walk cache. Mounted conversation surfaces legitimately re-request
/// details on refresh, and each uncached walk re-read every rollout's bounded
/// prefix (2026-08-24 live daily driver: ~880MB disk-read bursts every ~60s
/// from two mounted codex panes). Same fingerprint idiom as the candidate
/// scan cache above; shared in place and bounded by CODEX_SCAN_CACHE_CAP.
fn codex_subagent_scan_cache() -> &'static Mutex<HashMap<PathBuf, CachedCodexSubagentScan>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedCodexSubagentScan>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn collect_codex_subagent_files_with_cache(
    root: &Path,
    parent_id: &str,
    inspected: &mut usize,
    output: &mut HashMap<String, CodexSubagentFile>,
    cache: &Mutex<HashMap<PathBuf, CachedCodexSubagentScan>>,
) {
    collect_codex_subagent_files(root, parent_id, 0, inspected, output, cache);
}

fn collect_codex_subagent_files(
    directory: &Path,
    parent_id: &str,
    depth: usize,
    inspected: &mut usize,
    output: &mut HashMap<String, CodexSubagentFile>,
    cache: &Mutex<HashMap<PathBuf, CachedCodexSubagentScan>>,
) {
    if depth > 4 || *inspected >= MAX_PROVIDER_RECORDS {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten().take(MAX_PROVIDER_DIRECTORIES) {
        if *inspected >= MAX_PROVIDER_RECORDS {
            return;
        }
        *inspected += 1;
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_codex_subagent_files(
                &entry.path(),
                parent_id,
                depth + 1,
                inspected,
                output,
                cache,
            );
            continue;
        }
        if !kind.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let path = entry.path();
        let stamp = FileStamp::of(&path);
        // Shared in-place lookup: concurrent walks are the production norm
        // (multiple mounted conversation panes refresh together), so entries
        // must never be dropped by a walk that did not visit them.
        let cached_scan = stamp.and_then(|now| {
            cache.lock().ok().and_then(|entries| {
                entries
                    .get(&path)
                    .filter(|cached| cached.stamp == now)
                    .map(|cached| cached.scan.clone())
            })
        });
        let (scan, fresh_prefix) = match (stamp, cached_scan) {
            // Unchanged fingerprint — replay without opening the file.
            (_, Some(scan)) => (scan, None),
            (stamp, None) => {
                let Some(prefix) = bounded_prefix(&path, MAX_SESSION_BYTES) else {
                    // Unreadable files are never cached, so a transient
                    // failure retries on the next walk.
                    continue;
                };
                let metadata = prefix
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .find(|value| {
                        value.get("type").and_then(Value::as_str) == Some("session_meta")
                    });
                let scan = match metadata.as_ref().and_then(codex_subagent_reference) {
                    Some(reference) => CodexSubagentScan::Subagent {
                        parent_id: reference.parent_id,
                        id: reference.id,
                        metadata: metadata.expect("reference implies metadata"),
                    },
                    None => CodexSubagentScan::NotSubagent,
                };
                if let Some(stamp) = stamp {
                    if let Ok(mut entries) = cache.lock() {
                        if entries.len() >= CODEX_SCAN_CACHE_CAP {
                            entries.clear();
                        }
                        entries.insert(
                            path.clone(),
                            CachedCodexSubagentScan {
                                stamp,
                                scan: scan.clone(),
                            },
                        );
                    }
                }
                (scan, Some(prefix))
            }
        };
        let CodexSubagentScan::Subagent {
            parent_id: file_parent_id,
            id,
            metadata,
        } = scan
        else {
            continue;
        };
        if file_parent_id != parent_id {
            continue;
        }
        let modified = mtime(&path);
        if output
            .get(&id)
            .is_some_and(|existing| existing.modified >= modified)
        {
            continue;
        }
        output.insert(
            id.clone(),
            CodexSubagentFile {
                id,
                path,
                prefix: fresh_prefix,
                metadata,
                modified,
            },
        );
    }
}

fn exact_codex_rollout_input_authority(
    root: &Path,
    rollout_path: &str,
    conversation_id: &str,
    parent_conversation_id: Option<&str>,
) -> ProviderConversationInputAuthority {
    let Some(path) = fs::canonicalize(rollout_path)
        .ok()
        .filter(|path| path.is_file())
    else {
        return ProviderConversationInputAuthority::Unverified;
    };
    let Some(active_root) = fs::canonicalize(root).ok().filter(|path| path.is_dir()) else {
        return ProviderConversationInputAuthority::Unverified;
    };
    let archived_root = active_root
        .parent()
        .and_then(|parent| fs::canonicalize(parent.join("archived_sessions")).ok());
    let allowed = [Some(active_root), archived_root]
        .into_iter()
        .flatten()
        .any(|directory| path.starts_with(directory));
    if !allowed {
        return ProviderConversationInputAuthority::Unverified;
    }
    let authority = bounded_prefix(&path, MAX_SESSION_BYTES)
        .and_then(|prefix| {
            prefix
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|value| {
                    value.get("type").and_then(Value::as_str) == Some("session_meta")
                })
        })
        .and_then(|metadata| codex_input_authority(&metadata, conversation_id));
    match authority {
        Some(ProviderConversationInputAuthority::Independent)
            if parent_conversation_id.is_none() =>
        {
            ProviderConversationInputAuthority::Independent
        }
        Some(ProviderConversationInputAuthority::ControlledByParent {
            parent_conversation_id: metadata_parent,
        }) if parent_conversation_id.is_none_or(|parent| parent == metadata_parent) => {
            ProviderConversationInputAuthority::ControlledByParent {
                parent_conversation_id: metadata_parent,
            }
        }
        _ => ProviderConversationInputAuthority::Unverified,
    }
}

async fn exact_codex_input_authority(
    root: &Path,
    state_database: &Path,
    conversation_id: &str,
) -> ProviderConversationInputAuthority {
    let options = SqliteConnectOptions::new()
        .filename(state_database)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_millis(100));
    let Ok(pool) = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_millis(250))
        .connect_with(options)
        .await
    else {
        return ProviderConversationInputAuthority::Unverified;
    };
    let rows = sqlx::query(
        "SELECT threads.thread_source, thread_spawn_edges.parent_thread_id \
         FROM threads LEFT JOIN thread_spawn_edges \
         ON thread_spawn_edges.child_thread_id = threads.id \
         WHERE threads.id = ? LIMIT 2",
    )
    .bind(conversation_id)
    .fetch_all(&pool)
    .await;
    let Ok(rows) = rows else {
        return ProviderConversationInputAuthority::Unverified;
    };
    let [row] = rows.as_slice() else {
        return ProviderConversationInputAuthority::Unverified;
    };
    let Ok(parent_conversation_id) = row.try_get::<Option<String>, _>("parent_thread_id") else {
        return ProviderConversationInputAuthority::Unverified;
    };
    let Ok(thread_source) = row.try_get::<Option<String>, _>("thread_source") else {
        return ProviderConversationInputAuthority::Unverified;
    };
    let authority = match (thread_source.as_deref(), parent_conversation_id.as_deref()) {
        (Some("user"), None) => ProviderConversationInputAuthority::Independent,
        (Some("subagent"), Some(parent_conversation_id)) if safe_id(parent_conversation_id) => {
            ProviderConversationInputAuthority::ControlledByParent {
                parent_conversation_id: parent_conversation_id.to_string(),
            }
        }
        (legacy_source, parent_conversation_id)
            if legacy_source.is_none_or(|source| source.trim().is_empty()) =>
        {
            let rollout_path = sqlx::query_scalar::<_, String>(
                "SELECT rollout_path FROM threads WHERE id = ? LIMIT 1",
            )
            .bind(conversation_id)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
            rollout_path
                .as_deref()
                .map(|path| {
                    exact_codex_rollout_input_authority(
                        root,
                        path,
                        conversation_id,
                        parent_conversation_id,
                    )
                })
                .unwrap_or(ProviderConversationInputAuthority::Unverified)
        }
        _ => ProviderConversationInputAuthority::Unverified,
    };
    pool.close().await;
    authority
}

async fn codex_details(
    root: &Path,
    state_database: &Path,
    conversation_id: &str,
) -> Result<ProviderConversationDetails, String> {
    let preview_root = root.to_path_buf();
    let preview_conversation_id = conversation_id.to_string();
    let preview_task = tauri::async_runtime::spawn_blocking(move || {
        let mut files = HashMap::new();
        collect_codex_subagent_files_with_cache(
            &preview_root,
            &preview_conversation_id,
            &mut 0,
            &mut files,
            codex_subagent_scan_cache(),
        );
        files
    });
    let input_authority =
        exact_codex_input_authority(root, state_database, conversation_id).await;
    let files = preview_task
        .await
        .map_err(|error| format!("Codex details task failed: {error}"))?;
    let total_count = files.len();
    let mut files = files.into_values().collect::<Vec<_>>();
    files.sort_by_key(|file| Reverse(file.modified));
    let subagents = files
        .into_iter()
        .take(MAX_SUBAGENT_PREVIEWS)
        .map(|file| {
            // Cache-replayed files carry no prefix; read the bounded window
            // only for the few files actually previewed.
            let prefix = file
                .prefix
                .or_else(|| bounded_prefix(&file.path, MAX_SESSION_BYTES))
                .unwrap_or_default();
            let suffix = bounded_suffix(&file.path, MAX_SESSION_BYTES);
            codex_subagent_preview(
                file.id,
                file.modified,
                &prefix,
                &file.metadata,
                suffix.as_deref(),
            )
        })
        .collect();
    Ok(ProviderConversationDetails {
        input_authority,
        subagents,
        total_count,
    })
}

struct RemoteClaudeConversation {
    project: PathBuf,
    path: PathBuf,
    modified: u64,
    size: u64,
}

fn find_remote_claude_conversation(
    sftp: &Sftp,
    root: &Path,
    conversation_id: &str,
) -> Option<RemoteClaudeConversation> {
    if !safe_id(conversation_id) {
        return None;
    }
    sftp.readdir(root)
        .ok()?
        .into_iter()
        .take(MAX_PROVIDER_DIRECTORIES)
        .filter(|(_, metadata)| metadata.is_dir())
        .filter_map(|(project, _)| {
            let path = project.join(format!("{conversation_id}.jsonl"));
            let metadata = sftp.stat(&path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some(RemoteClaudeConversation {
                project,
                path,
                modified: metadata.mtime.unwrap_or(0),
                size: metadata.size?,
            })
        })
        .max_by_key(|conversation| conversation.modified)
}

fn remote_claude_details(
    sftp: &Sftp,
    root: &Path,
    conversation_id: &str,
) -> Result<ProviderConversationDetails, String> {
    let Some(parent) = find_remote_claude_conversation(sftp, root, conversation_id) else {
        return Err("provider conversation was not found".to_string());
    };
    let parent_prefix = remote_prefix_with_size(
        sftp,
        &parent.path,
        parent.size,
        MAX_REMOTE_PREFIX_BYTES,
    );
    let parent_suffix = if parent.size > MAX_REMOTE_PREFIX_BYTES {
        remote_suffix_with_size(
            sftp,
            &parent.path,
            parent.size,
            MAX_REMOTE_SUFFIX_BYTES,
        )
    } else {
        None
    };
    let mut parent_facts = HashMap::new();
    if let Some(prefix) = parent_prefix.as_deref() {
        collect_claude_parent_facts(prefix, &mut parent_facts);
    }
    if let Some(suffix) = parent_suffix.as_deref() {
        collect_claude_parent_facts(suffix, &mut parent_facts);
    }
    let mut files = remote_claude_subagent_files(sftp, &parent.project, conversation_id);
    files.sort_by_key(|file| Reverse(file.modified));
    let total_count = files.len();
    let subagents = files
        .into_iter()
        .take(MAX_SUBAGENT_PREVIEWS)
        .map(|file| {
            let prefix = remote_prefix_with_size(
                sftp,
                &file.path,
                file.size,
                MAX_REMOTE_PREFIX_BYTES,
            );
            let suffix = if file.size > MAX_REMOTE_PREFIX_BYTES {
                remote_suffix_with_size(
                    sftp,
                    &file.path,
                    file.size,
                    MAX_REMOTE_SUFFIX_BYTES,
                )
            } else {
                None
            };
            let metadata = remote_bounded_prefix(
                sftp,
                &file.path.with_extension("meta.json"),
                MAX_METADATA_BYTES,
            )
            .and_then(|content| serde_json::from_str::<Value>(&content).ok());
            claude_subagent_preview(
                file.id.clone(),
                file.modified,
                prefix.as_deref(),
                suffix.as_deref(),
                metadata.as_ref(),
                parent_facts.get(&file.id),
            )
        })
        .collect();
    Ok(ProviderConversationDetails {
        input_authority: ProviderConversationInputAuthority::Independent,
        subagents,
        total_count,
    })
}

struct RemoteCodexSubagentFile {
    id: String,
    path: PathBuf,
    prefix: String,
    metadata: Value,
    modified: u64,
    size: u64,
}

fn collect_remote_codex_subagent_files(
    sftp: &Sftp,
    directory: &Path,
    parent_id: &str,
    depth: usize,
    inspected: &mut usize,
    output: &mut HashMap<String, RemoteCodexSubagentFile>,
    input_authority: &mut Option<InputAuthorityObservation>,
) {
    if depth > 4 || *inspected >= MAX_PROVIDER_RECORDS {
        return;
    }
    let Ok(entries) = sftp.readdir(directory) else {
        return;
    };
    for (path, metadata) in entries.into_iter().take(MAX_PROVIDER_DIRECTORIES) {
        if *inspected >= MAX_PROVIDER_RECORDS {
            return;
        }
        *inspected += 1;
        if metadata.is_dir() {
            collect_remote_codex_subagent_files(
                sftp,
                &path,
                parent_id,
                depth + 1,
                inspected,
                output,
                input_authority,
            );
            continue;
        }
        let Some(size) = metadata.size else {
            continue;
        };
        if !metadata.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let Some(prefix) = remote_prefix_with_size(sftp, &path, size, MAX_REMOTE_PREFIX_BYTES)
        else {
            continue;
        };
        let Some(session) = prefix
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|value| value.get("type").and_then(Value::as_str) == Some("session_meta"))
        else {
            continue;
        };
        let modified = metadata.mtime.unwrap_or(0);
        if let Some(authority) = codex_input_authority(&session, parent_id) {
            observe_input_authority(input_authority, authority, modified);
        }
        let Some(reference) = codex_subagent_reference(&session) else {
            continue;
        };
        if reference.parent_id != parent_id {
            continue;
        }
        if output
            .get(&reference.id)
            .is_some_and(|existing| existing.modified >= modified)
        {
            continue;
        }
        output.insert(
            reference.id.clone(),
            RemoteCodexSubagentFile {
                id: reference.id,
                path,
                prefix,
                metadata: session,
                modified,
                size,
            },
        );
    }
}

fn remote_codex_details(
    sftp: &Sftp,
    root: &Path,
    conversation_id: &str,
) -> ProviderConversationDetails {
    let mut files = HashMap::new();
    let mut input_authority = None;
    collect_remote_codex_subagent_files(
        sftp,
        root,
        conversation_id,
        0,
        &mut 0,
        &mut files,
        &mut input_authority,
    );
    let total_count = files.len();
    let mut files = files.into_values().collect::<Vec<_>>();
    files.sort_by_key(|file| Reverse(file.modified));
    let subagents = files
        .into_iter()
        .take(MAX_SUBAGENT_PREVIEWS)
        .map(|file| {
            let suffix = if file.size > MAX_REMOTE_PREFIX_BYTES {
                remote_suffix_with_size(
                    sftp,
                    &file.path,
                    file.size,
                    MAX_REMOTE_SUFFIX_BYTES,
                )
            } else {
                None
            };
            codex_subagent_preview(
                file.id,
                file.modified,
                &file.prefix,
                &file.metadata,
                suffix.as_deref(),
            )
        })
        .collect();
    ProviderConversationDetails {
        input_authority: input_authority
            .map(|observation| observation.authority)
            .unwrap_or(ProviderConversationInputAuthority::Unverified),
        subagents,
        total_count,
    }
}

fn collect_remote_claude(
    sftp: &Sftp,
    root: &Path,
    host_id: &str,
    locations: &mut RemoteLocations<'_>,
    minimum_mtime: u64,
    output: &mut Vec<Candidate>,
) {
    let Ok(mut projects) = sftp.readdir(root) else {
        return;
    };
    projects.sort_by_key(|(_, metadata)| Reverse(metadata.mtime.unwrap_or(0)));
    let mut inspected = 0;
    for (project, metadata) in projects.into_iter().take(MAX_REMOTE_DIRECTORIES) {
        if !metadata.is_dir() {
            continue;
        }
        let Ok(mut files) = sftp.readdir(&project) else {
            continue;
        };
        files.sort_by_key(|(_, metadata)| Reverse(metadata.mtime.unwrap_or(0)));
        for (path, metadata) in files
            .into_iter()
            .take(MAX_REMOTE_PROVIDER_RECORDS.saturating_sub(inspected))
        {
            if inspected >= MAX_REMOTE_PROVIDER_RECORDS {
                return;
            }
            inspected += 1;
            let file_mtime = metadata.mtime.unwrap_or(0);
            let Some(file_size) = metadata.size else {
                continue;
            };
            if !metadata.is_file()
                || file_mtime < minimum_mtime
                || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                continue;
            }
            let Some(prefix) =
                remote_prefix_with_size(sftp, &path, file_size, MAX_REMOTE_PREFIX_BYTES)
            else {
                continue;
            };
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let (cwd, identity, auxiliary) = claude_metadata(&prefix);
            if auxiliary {
                continue;
            }
            let Some(cwd) = cwd else {
                continue;
            };
            let suffix = if file_size <= MAX_REMOTE_PREFIX_BYTES {
                None
            } else {
                remote_suffix_with_size(sftp, &path, file_size, MAX_REMOTE_SUFFIX_BYTES)
            };
            let title = super::claude_session_title::named_title(&prefix, suffix.as_deref(), id)
                .or_else(|| suffix.as_deref().and_then(latest_claude_title))
                .or_else(|| latest_claude_title(&prefix));
            if let Some(mut candidate) = remote_record(
                locations,
                RemoteRecord {
                    host_id,
                    provider: "claude",
                    id,
                    cwd: &cwd,
                    title,
                    fallback_title: "Claude Code",
                    mtime: file_mtime,
                    logical_identity: identity,
                },
            ) {
                candidate.record.branch = claude_branch(&prefix);
                (candidate.record.model, candidate.record.effort) =
                    claude_session_settings(&prefix, suffix.as_deref());
                candidate.record.recent_turns = recent_turns_from_bounded_windows(
                    &prefix,
                    suffix.as_deref(),
                    file_size,
                    MAX_REMOTE_PREFIX_BYTES,
                    claude_turn,
                );
                candidate.record.subagent_count =
                    remote_claude_subagent_files(sftp, &project, id).len();
                output.push(candidate);
            }
        }
    }
}

struct RemoteCodexScan<'a, 's> {
    sftp: &'a Sftp,
    host_id: &'a str,
    locations: &'a mut RemoteLocations<'s>,
    subagents: &'a mut Vec<CodexSubagentReference>,
    minimum_mtime: u64,
    inspected: usize,
}

impl RemoteCodexScan<'_, '_> {
    fn collect_directory(&mut self, directory: &Path, depth: usize, output: &mut Vec<Candidate>) {
        if depth > 4 || self.inspected >= MAX_REMOTE_PROVIDER_RECORDS {
            return;
        }
        let Ok(mut entries) = self.sftp.readdir(directory) else {
            return;
        };
        entries.sort_by_key(|(_, metadata)| Reverse(metadata.mtime.unwrap_or(0)));
        for (path, metadata) in entries.into_iter().take(MAX_REMOTE_DIRECTORIES) {
            if self.inspected >= MAX_REMOTE_PROVIDER_RECORDS {
                return;
            }
            self.inspected += 1;
            if metadata.is_dir() {
                self.collect_directory(&path, depth + 1, output);
                continue;
            }
            let file_mtime = metadata.mtime.unwrap_or(0);
            let Some(file_size) = metadata.size else {
                continue;
            };
            if !metadata.is_file()
                || file_mtime < self.minimum_mtime
                || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                continue;
            }
            let Some(prefix) = remote_prefix_with_size(
                self.sftp,
                &path,
                file_size,
                MAX_REMOTE_PREFIX_BYTES,
            ) else {
                continue;
            };
            let Some(session) = prefix
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|value| value.get("type").and_then(Value::as_str) == Some("session_meta"))
            else {
                continue;
            };
            if codex_is_subagent(&session) {
                if let Some(subagent) = codex_subagent_reference(&session) {
                    self.subagents.push(subagent);
                }
                continue;
            }
            let Some(id) = session.pointer("/payload/id").and_then(Value::as_str) else {
                continue;
            };
            let Some(cwd) = session.pointer("/payload/cwd").and_then(Value::as_str) else {
                continue;
            };
            let suffix = if file_size <= MAX_REMOTE_PREFIX_BYTES {
                None
            } else {
                remote_suffix_with_size(self.sftp, &path, file_size, MAX_REMOTE_SUFFIX_BYTES)
            };
            let title = suffix
                .as_deref()
                .and_then(latest_codex_title)
                .or_else(|| latest_codex_title(&prefix));
            if let Some(mut candidate) = remote_record(
                self.locations,
                RemoteRecord {
                    host_id: self.host_id,
                    provider: "codex",
                    id,
                    cwd,
                    title,
                    fallback_title: "Codex",
                    mtime: file_mtime,
                    logical_identity: Some(id.to_string()),
                },
            ) {
                candidate.record.interaction_kind = codex_interaction_kind(&session);
                candidate.record.branch = codex_branch(&session);
                (candidate.record.model, candidate.record.effort) =
                    codex_session_settings(&prefix, suffix.as_deref());
                candidate.record.recent_turns = recent_turns_from_bounded_windows(
                    &prefix,
                    suffix.as_deref(),
                    file_size,
                    MAX_REMOTE_PREFIX_BYTES,
                    codex_turn,
                );
                output.push(candidate);
            }
        }
    }
}

fn collect_remote_codex(
    sftp: &Sftp,
    root: &Path,
    host_id: &str,
    locations: &mut RemoteLocations<'_>,
    minimum_mtime: u64,
    output: &mut Vec<Candidate>,
) {
    let output_start = output.len();
    let mut subagents = Vec::new();
    RemoteCodexScan {
        sftp,
        host_id,
        locations,
        subagents: &mut subagents,
        minimum_mtime,
        inspected: 0,
    }
    .collect_directory(root, 0, output);
    let mut seen = HashSet::new();
    let mut counts = HashMap::new();
    for subagent in subagents {
        if !seen.insert((subagent.parent_id.clone(), subagent.id)) {
            continue;
        }
        *counts.entry(subagent.parent_id).or_insert(0usize) += 1;
    }
    for candidate in &mut output[output_start..] {
        candidate.record.subagent_count = counts.remove(&candidate.record.id).unwrap_or(0);
    }
}

fn gemini_user_title(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) == Some("user") {
        return value.get("content").and_then(text_content);
    }
    value
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.iter().find_map(gemini_user_title))
}

fn gemini_record(path: &Path, cwd: &str) -> Option<Candidate> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let content = if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
        bounded_prefix(path, MAX_SESSION_BYTES)?
    } else {
        bounded_full(path, MAX_SESSION_BYTES)?
    };
    let mut id = None;
    let mut title = None;
    let mut subagent = false;
    if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
        for value in content
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        {
            let metadata = value.get("$set").unwrap_or(&value);
            if id.is_none() {
                id = metadata
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            subagent |= metadata.get("kind").and_then(Value::as_str) == Some("subagent");
            if title.is_none() {
                title = gemini_user_title(&value);
            }
        }
    } else {
        let value = serde_json::from_str::<Value>(&content).ok()?;
        id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        subagent = value.get("kind").and_then(Value::as_str) == Some("subagent");
        title = gemini_user_title(&value);
    }
    let id = id?;
    if subagent {
        return None;
    }
    record(
        "gemini",
        &id,
        cwd,
        title,
        "Gemini CLI",
        mtime(path),
        Some(id.clone()),
    )
}

fn collect_gemini(root: &Path, output: &mut Vec<Candidate>) {
    let mut projects = Vec::new();
    let mut seen = HashSet::new();
    if let Some(content) = bounded_full(&root.join("projects.json"), MAX_METADATA_BYTES) {
        if let Ok(value) = serde_json::from_str::<Value>(&content) {
            if let Some(registry) = value.get("projects").and_then(Value::as_object) {
                for (cwd, slug) in registry.iter().take(MAX_PROVIDER_DIRECTORIES) {
                    let Some(slug) = slug.as_str().filter(|slug| {
                        !slug.is_empty()
                            && slug.chars().all(|character| {
                                character.is_ascii_alphanumeric() || character == '-'
                            })
                    }) else {
                        continue;
                    };
                    let directory = root.join("tmp").join(slug);
                    if seen.insert(directory.clone()) {
                        projects.push((directory, cwd.clone()));
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(root.join("tmp")) {
        for entry in entries.flatten().take(MAX_PROVIDER_DIRECTORIES) {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let directory = entry.path();
            let marker = directory.join(".project_root");
            let Some(cwd) = bounded_full(&marker, 4096) else {
                continue;
            };
            if seen.insert(directory.clone()) {
                projects.push((directory, cwd.trim().to_string()));
            }
        }
    }

    let mut inspected = 0;
    for (project, cwd) in projects {
        if inspected >= MAX_PROVIDER_RECORDS {
            break;
        }
        let Ok(files) = fs::read_dir(project.join("chats")) else {
            continue;
        };
        for file in files
            .flatten()
            .take(MAX_PROVIDER_RECORDS.saturating_sub(inspected))
        {
            if inspected >= MAX_PROVIDER_RECORDS {
                break;
            }
            inspected += 1;
            let supported = matches!(
                file.path().extension().and_then(|value| value.to_str()),
                Some("json" | "jsonl")
            );
            if !supported || !file.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            if let Some(candidate) = gemini_record(&file.path(), &cwd) {
                output.push(candidate);
            }
        }
    }
}

fn grok_record(path: &Path) -> Option<Candidate> {
    let content = bounded_full(path, MAX_METADATA_BYTES)?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    let id = value.pointer("/info/id").and_then(Value::as_str)?;
    let cwd = value.pointer("/info/cwd").and_then(Value::as_str)?;
    let hidden = value
        .get("hidden")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            value
                .get("session_kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.starts_with("subagent"))
        });
    if hidden || !super::exact_uuid_identity(id) {
        return None;
    }
    let title = value
        .get("generated_title")
        .and_then(Value::as_str)
        .or_else(|| value.get("session_summary").and_then(Value::as_str))
        .map(str::to_string);
    record(
        "grok",
        id,
        cwd,
        title,
        "Grok Build",
        mtime(path),
        Some(id.to_string()),
    )
}

fn collect_grok(root: &Path, output: &mut Vec<Candidate>) {
    let Ok(projects) = fs::read_dir(root.join("sessions")) else {
        return;
    };
    let mut inspected = 0;
    for project in projects.flatten().take(MAX_PROVIDER_DIRECTORIES) {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(sessions) = fs::read_dir(project.path()) else {
            continue;
        };
        for session in sessions
            .flatten()
            .take(MAX_PROVIDER_RECORDS.saturating_sub(inspected))
        {
            if inspected >= MAX_PROVIDER_RECORDS {
                return;
            }
            inspected += 1;
            if !session.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Some(candidate) = grok_record(&session.path().join("summary.json")) {
                output.push(candidate);
            }
        }
    }
}

fn opencode_json_record(path: &Path) -> Option<Candidate> {
    let content = bounded_full(path, MAX_METADATA_BYTES)?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    if value.get("parentID").is_some_and(|parent| !parent.is_null()) {
        return None;
    }
    let id = value.get("id").and_then(Value::as_str)?;
    let cwd = value.get("directory").and_then(Value::as_str)?;
    let title = value.get("title").and_then(Value::as_str).map(str::to_string);
    let updated = value
        .pointer("/time/updated")
        .or_else(|| value.get("updated"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        / 1000;
    let record_mtime = if updated > 0 { updated } else { mtime(path) };
    record(
        "opencode",
        id,
        cwd,
        title,
        "OpenCode",
        record_mtime,
        Some(id.to_string()),
    )
}

fn collect_opencode_json(root: &Path, output: &mut Vec<Candidate>) {
    let Ok(projects) = fs::read_dir(root.join("storage/session")) else {
        return;
    };
    let mut inspected = 0;
    for project in projects.flatten().take(MAX_PROVIDER_DIRECTORIES) {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(project.path()) else {
            continue;
        };
        for file in files
            .flatten()
            .take(MAX_PROVIDER_RECORDS.saturating_sub(inspected))
        {
            if inspected >= MAX_PROVIDER_RECORDS {
                return;
            }
            inspected += 1;
            if !file.file_type().is_ok_and(|kind| kind.is_file())
                || file.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            if let Some(candidate) = opencode_json_record(&file.path()) {
                output.push(candidate);
            }
        }
    }
}

fn opencode_database_paths(roots: &DiscoveryRoots) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Some(path) = &roots.opencode_db_override {
        if seen.insert(path.clone()) {
            paths.push(path.clone());
        }
    }
    if let Ok(entries) = fs::read_dir(&roots.opencode_data) {
        for entry in entries.flatten().take(MAX_PROVIDER_DIRECTORIES) {
            if paths.len() >= MAX_OPENCODE_DATABASES {
                break;
            }
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && name.starts_with("opencode")
                && name.ends_with(".db")
                && seen.insert(path.clone())
            {
                paths.push(path);
            }
        }
    }
    paths
}

async fn collect_opencode_database(path: &Path, output: &mut Vec<Candidate>) {
    if !path.is_file() {
        return;
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_millis(100));
    let Ok(pool) = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_millis(250))
        .connect_with(options)
        .await
    else {
        return;
    };
    let rows = sqlx::query(
        "SELECT id, directory, title, time_updated FROM session \
         WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 200",
    )
    .fetch_all(&pool)
    .await
    .unwrap_or_default();
    pool.close().await;
    for row in rows {
        let Ok(id) = row.try_get::<String, _>("id") else {
            continue;
        };
        let Ok(cwd) = row.try_get::<String, _>("directory") else {
            continue;
        };
        let title = row.try_get::<String, _>("title").ok();
        let updated = row
            .try_get::<i64, _>("time_updated")
            .ok()
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(0)
            / 1000;
        if let Some(candidate) = record(
            "opencode",
            &id,
            &cwd,
            title,
            "OpenCode",
            updated,
            Some(id.clone()),
        ) {
            output.push(candidate);
        }
    }
}

fn finalize(mut candidates: Vec<Candidate>) -> Vec<ProviderConversationRecord> {
    candidates.sort_by(|left, right| {
        right
            .record
            .mtime
            .cmp(&left.record.mtime)
            .then_with(|| left.record.provider.cmp(&right.record.provider))
            .then_with(|| left.record.id.cmp(&right.record.id))
    });
    let mut seen_exact = HashSet::new();
    let mut seen_logical = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| {
            let source = match candidate.record.execution_location {
                ExecutionLocation::Local => "local".to_string(),
                ExecutionLocation::Ssh => format!(
                    "ssh\0{}",
                    candidate.record.host_id.as_deref().unwrap_or("unknown")
                ),
            };
            let exact_is_new = seen_exact.insert((
                source.clone(),
                candidate.record.provider.clone(),
                candidate.record.id.clone(),
            ));
            let logical_is_new = seen_logical.insert((
                source,
                candidate.record.provider.clone(),
                candidate.logical_identity.clone(),
            ));
            exact_is_new && logical_is_new
        })
        .map(|candidate| candidate.record)
        .take(MAX_DISCOVERED_SESSIONS)
        .collect()
}

async fn discover(roots: &DiscoveryRoots) -> Vec<ProviderConversationRecord> {
    let mut candidates = Vec::new();
    collect_claude(&roots.claude_projects, &mut candidates);
    collect_codex(&roots.codex_sessions, &mut candidates);
    collect_gemini(&roots.gemini, &mut candidates);
    pi_sessions::collect(&roots.pi_sessions, &mut candidates);
    collect_grok(&roots.grok, &mut candidates);
    collect_opencode_json(&roots.opencode_data, &mut candidates);
    for database in opencode_database_paths(roots) {
        collect_opencode_database(&database, &mut candidates).await;
    }
    finalize(candidates)
}

/// Scan only bounded, provider-owned local records. This performs no network,
/// authentication, provider CLI invocation, or process launch.
pub async fn list_global() -> Vec<ProviderConversationRecord> {
    discover(&DiscoveryRoots::from_environment()).await
}

async fn details_for_roots(
    roots: &DiscoveryRoots,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationDetails, String> {
    if !safe_id(conversation_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    match provider {
        "claude" => {
            let root = roots.claude_projects.clone();
            let conversation_id = conversation_id.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                claude_details(&root, &conversation_id)
            })
            .await
            .map_err(|error| format!("Claude details task failed: {error}"))?
        }
        "codex" => codex_details(
            &roots.codex_sessions,
            &roots.codex_state_database,
            conversation_id,
        )
        .await,
        "pi" => {
            let root = roots.pi_sessions.clone();
            let conversation_id = conversation_id.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                pi_sessions::details(&root, &conversation_id)
            })
            .await
            .map_err(|error| format!("Pi details task failed: {error}"))
        }
        _ => Ok(ProviderConversationDetails {
            input_authority: ProviderConversationInputAuthority::Unverified,
            subagents: Vec::new(),
            total_count: 0,
        }),
    }
}

pub async fn details_global(
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationDetails, String> {
    details_for_roots(
        &DiscoveryRoots::from_environment(),
        provider,
        conversation_id,
    )
    .await
}

/// Load one provider-owned details projection from one explicitly selected SSH
/// host. Provider transcript formats remain private to this scanner; callers
/// receive only the same bounded common projection used for local history.
pub fn details_remote(
    host_id: &str,
    opts: &crate::ssh::SshOptions,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationDetails, String> {
    if !safe_id(host_id) {
        return Err("remote provider history host id is invalid".to_string());
    }
    if !safe_id(conversation_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let session = crate::ssh::acquire(opts)?;
    let sftp = session.sftp().map_err(|error| format!("open SFTP: {error}"))?;
    let home = sftp
        .realpath(Path::new("."))
        .map_err(|error| format!("resolve remote home: {error}"))?;
    match provider {
        "claude" => remote_claude_details(
            &sftp,
            &home.join(".claude/projects"),
            conversation_id,
        ),
        "codex" => Ok(remote_codex_details(
            &sftp,
            &home.join(".codex/sessions"),
            conversation_id,
        )),
        _ => Ok(ProviderConversationDetails {
            input_authority: ProviderConversationInputAuthority::Unverified,
            subagents: Vec::new(),
            total_count: 0,
        }),
    }
}

/// Scan bounded provider-owned records through one explicitly registered SSH
/// host. This is read-only SFTP discovery; it never invokes a provider CLI or
/// creates a remote process. The first remote slice intentionally supports the
/// two provider formats whose exact-resume records are already conformance
/// tested locally.
pub fn list_remote(
    host_id: &str,
    opts: &crate::ssh::SshOptions,
) -> Result<Vec<ProviderConversationRecord>, String> {
    if !safe_id(host_id) {
        return Err("remote provider history host id is invalid".to_string());
    }
    let session = crate::ssh::acquire(opts)?;
    let sftp = session.sftp().map_err(|error| format!("open SFTP: {error}"))?;
    let home = sftp
        .realpath(Path::new("."))
        .map_err(|error| format!("resolve remote home: {error}"))?;
    let mut candidates = Vec::new();
    let mut locations = RemoteLocations::new(&session);
    let minimum_mtime = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .saturating_sub(MAX_REMOTE_AGE_SECONDS);
    collect_remote_claude(
        &sftp,
        &home.join(".claude/projects"),
        host_id,
        &mut locations,
        minimum_mtime,
        &mut candidates,
    );
    collect_remote_codex(
        &sftp,
        &home.join(".codex/sessions"),
        host_id,
        &mut locations,
        minimum_mtime,
        &mut candidates,
    );
    Ok(finalize(candidates))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, SqliteConnection};

    #[test]
    fn native_final_response_requires_provider_final_markers() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("transcript.jsonl");
        for (provider, parse, records) in [
            (
                "codex",
                codex_turn as fn(&Value) -> Option<(ConversationTurnRole, String)>,
                vec![
                    serde_json::json!({"payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Running tools"}]}}),
                    serde_json::json!({"payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Done"}]}}),
                    serde_json::json!({"payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Interrupted next turn"}]}}),
                ],
            ),
            (
                "claude",
                claude_turn as fn(&Value) -> Option<(ConversationTurnRole, String)>,
                vec![
                    serde_json::json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Running tools"}]}}),
                    serde_json::json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Done"}]}}),
                    serde_json::json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Interrupted next turn"}]}}),
                ],
            ),
        ] {
            fs::write(&path, records[0].to_string()).unwrap();
            assert_eq!(
                transcript_from_file(&path, provider, "conversation", parse)
                    .unwrap()
                    .final_response,
                None
            );
            fs::write(
                &path,
                records
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
            let transcript = transcript_from_file(&path, provider, "conversation", parse).unwrap();
            assert_eq!(transcript.final_response.as_deref(), Some("Done"));
            assert_eq!(
                transcript.entries.last().unwrap().text,
                "Interrupted next turn"
            );
            assert!(transcript.history_complete);
            let user = if provider == "codex" {
                serde_json::json!({"payload":{"type":"user_message","message":"Next request"}})
            } else {
                serde_json::json!({"type":"user","message":{"content":"Next request"}})
            };
            fs::write(
                &path,
                format!("{}\n{}", fs::read_to_string(&path).unwrap(), user),
            )
            .unwrap();
            assert_eq!(
                transcript_from_file(&path, provider, "conversation", parse)
                    .unwrap()
                    .final_response,
                None
            );
        }
        assert_eq!(
            provider_final_response(
                "codex",
                &serde_json::json!({
                    "payload":{"type":"task_complete","last_agent_message":"Older CLI final"}
                })
            )
            .as_deref(),
            Some("Older CLI final")
        );
        assert_eq!(
            provider_final_response(
                "codex",
                &serde_json::json!({
                    "payload":{"type":"message","role":"user","phase":"final_answer","content":[{"type":"input_text","text":"Not an answer"}]}
                })
            ),
            None
        );
    }

    #[cfg(unix)]
    fn run_location_script(cwd: &str) -> String {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(remote_location_script(cwd))
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap()
    }

    /// The remote reader answers the same questions as [`repository_metadata`]
    /// for a checkout, a linked worktree whose `.git` is a file, and a
    /// directory that no longer exists under a repository.
    #[cfg(unix)]
    #[test]
    fn remote_location_script_mirrors_the_local_repository_reader() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let repo = root.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(
            repo.join(".git/config"),
            "[remote \"origin\"]\n\turl = git@github.com:acme/repo.git\n",
        )
        .unwrap();
        fs::create_dir_all(repo.join("src/deep")).unwrap();

        let cwd = repo.join("src/deep");
        let located =
            parse_remote_location(cwd.to_str().unwrap(), &run_location_script(cwd.to_str().unwrap()))
                .unwrap();
        let local = repository_metadata(&repo).unwrap();
        assert_eq!(located.0, cwd.to_string_lossy());
        assert_eq!(located.1.as_deref(), Some(repo.to_str().unwrap()));
        assert_eq!(located.2.as_deref(), Some(local.0.to_str().unwrap()));
        assert_eq!(located.3, local.1);
        assert!(located.4);

        // A linked worktree: `.git` is a file naming the gitdir, whose
        // `commondir` points back at the main repository.
        let worktree = root.join("linked");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(repo.join(".git/worktrees/linked")).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", repo.join(".git/worktrees/linked").display()),
        )
        .unwrap();
        fs::write(repo.join(".git/worktrees/linked/commondir"), "../..\n").unwrap();
        let located = parse_remote_location(
            worktree.to_str().unwrap(),
            &run_location_script(worktree.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(located.1.as_deref(), Some(worktree.to_str().unwrap()));
        assert_eq!(located.2.as_deref(), Some(repo.join(".git").to_str().unwrap()));
        assert_eq!(located.3, local.1);

        // A working directory that was deleted still belongs to the
        // repository above it, and says it is gone.
        let missing = repo.join("src/removed");
        let located = parse_remote_location(
            missing.to_str().unwrap(),
            &run_location_script(missing.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(located.0, missing.to_string_lossy());
        assert_eq!(located.1.as_deref(), Some(repo.to_str().unwrap()));
        assert!(!located.4);
    }

    #[test]
    fn remote_location_parse_needs_the_availability_line() {
        assert_eq!(parse_remote_location("/srv/app", ""), None);
        assert_eq!(
            parse_remote_location("/srv/app", "available=0\n"),
            Some(("/srv/app".to_string(), None, None, None, false))
        );
    }

    fn roots(temporary: &tempfile::TempDir) -> DiscoveryRoots {
        DiscoveryRoots {
            claude_projects: temporary.path().join(".claude/projects"),
            codex_sessions: temporary.path().join(".codex/sessions"),
            codex_state_database: temporary.path().join(".codex/state_5.sqlite"),
            gemini: temporary.path().join(".gemini"),
            pi_sessions: temporary.path().join(".pi/agent/sessions"),
            grok: temporary.path().join(".grok"),
            opencode_data: temporary.path().join(".local/share/opencode"),
            opencode_db_override: None,
        }
    }

    #[test]
    fn exports_the_exact_native_codex_conversation_without_context_injections() {
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let directory = roots.codex_sessions.join("2026/09/01");
        fs::create_dir_all(&directory).unwrap();
        let conversation_id = "conversation-exact";
        let records = [
            serde_json::json!({
                "type": "session_meta",
                "payload": { "id": conversation_id, "cwd": "/repo" }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "# AGENTS.md instructions for /repo" }] }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Fix the menu" }] }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Fix the menu" }] }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<div>Keep literal markup prompts</div>" }] }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Done" }] }
            }),
        ];
        let rollout = directory.join(format!("rollout-{conversation_id}.jsonl"));
        fs::write(
            &rollout,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let transcript = transcript_for_roots(&roots, "codex", conversation_id).unwrap();

        assert!(transcript.history_complete);
        assert_eq!(
            transcript.entries,
            vec![
                ProviderTranscriptEntry {
                    role: ConversationTurnRole::User,
                    text: "Fix the menu".to_string(),
                },
                ProviderTranscriptEntry {
                    role: ConversationTurnRole::User,
                    text: "Fix the menu".to_string(),
                },
                ProviderTranscriptEntry {
                    role: ConversationTurnRole::User,
                    text: "<div>Keep literal markup prompts</div>".to_string(),
                },
                ProviderTranscriptEntry {
                    role: ConversationTurnRole::Agent,
                    text: "Done".to_string(),
                },
            ]
        );

        let archived = roots.codex_sessions.parent().unwrap().join("archived_sessions");
        fs::create_dir_all(&archived).unwrap();
        fs::rename(
            rollout,
            archived.join(format!("rollout-{conversation_id}.jsonl")),
        )
        .unwrap();
        assert_eq!(
            transcript_for_roots(&roots, "codex", conversation_id)
                .unwrap()
                .entries,
            transcript.entries
        );
    }

    async fn create_codex_authority_state(
        roots: &DiscoveryRoots,
        threads: &[(&str, &str)],
        edges: &[(&str, &str)],
    ) {
        let options = SqliteConnectOptions::new()
            .filename(&roots.codex_state_database)
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE threads (id TEXT PRIMARY KEY, thread_source TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE thread_spawn_edges (\
             parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, \
             status TEXT NOT NULL)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        for (id, thread_source) in threads {
            sqlx::query("INSERT INTO threads (id, thread_source) VALUES (?, ?)")
                .bind(*id)
                .bind(*thread_source)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        for (parent_id, child_id) in edges {
            sqlx::query(
                "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) \
                 VALUES (?, ?, 'open')",
            )
            .bind(*parent_id)
            .bind(*child_id)
            .execute(&mut connection)
            .await
            .unwrap();
        }
        connection.close().await.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn codex_state_database_follows_the_shared_sessions_root() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let canonical_root = temporary.path().join("canonical");
        let account_root = temporary.path().join("account");
        fs::create_dir_all(canonical_root.join("sessions")).unwrap();
        fs::create_dir_all(&account_root).unwrap();
        symlink(canonical_root.join("sessions"), account_root.join("sessions")).unwrap();

        assert_eq!(
            codex_state_database_path(&account_root, None),
            fs::canonicalize(canonical_root)
                .unwrap()
                .join("state_5.sqlite")
        );

        let explicit_root = temporary.path().join("explicit");
        assert_eq!(
            codex_state_database_path(&account_root, Some(explicit_root.clone())),
            explicit_root.join("state_5.sqlite")
        );
    }

    #[test]
    fn claude_sidechain_records_are_not_discovered() {
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        let project = roots.claude_projects.join("project");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&project).unwrap();
        for (id, is_sidechain) in [
            ("conversation-main", false),
            ("conversation-sidechain", true),
        ] {
            fs::write(
                project.join(format!("{id}.jsonl")),
                serde_json::json!({
                    "type": "user",
                    "uuid": format!("message-{id}"),
                    "cwd": cwd,
                    "isSidechain": is_sidechain,
                    "message": {"content": id}
                })
                .to_string(),
            )
            .unwrap();
        }

        let mut candidates = Vec::new();
        collect_claude(&roots.claude_projects, &mut candidates);
        assert_eq!(
            finalize(candidates)
                .into_iter()
                .map(|record| record.id)
                .collect::<Vec<_>>(),
            vec!["conversation-main"]
        );
    }

    #[test]
    fn claude_and_codex_records_expose_bounded_provider_neutral_details() {
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        let long_answer = "x".repeat(MAX_TURN_PREVIEW_CHARS + 24);
        fs::create_dir_all(&cwd).unwrap();

        let claude = roots
            .claude_projects
            .join("project/conversation-claude.jsonl");
        fs::create_dir_all(claude.parent().unwrap()).unwrap();
        fs::write(
            &claude,
            [
                serde_json::json!({
                    "type": "user",
                    "uuid": "message-origin",
                    "cwd": cwd,
                    "gitBranch": "feature/session-details",
                    "message": {"content": "Old question"}
                }),
                serde_json::json!({
                    "type": "assistant",
                    "effort": "low",
                    "message": {
                        "model": "claude-opus-5",
                        "content": [{"type": "text", "text": "Old answer"}]
                    }
                }),
                serde_json::json!({
                    "type": "user",
                    "message": {"content": "Latest question"}
                }),
                serde_json::json!({
                    "type": "assistant",
                    "effort": "high",
                    "message": {"content": [{"type": "text", "text": long_answer}]}
                }),
                serde_json::json!({
                    "type": "user",
                    "message": {"content": [{"type": "tool_result", "content": "Agent started"}]},
                    "toolUseResult": {
                        "agentId": "explore",
                        "status": "async_launched",
                        "description": "Trace the session handoff"
                    }
                }),
                serde_json::json!({
                    "type": "user",
                    "message": {"content": [{
                        "type": "tool_result",
                        "content": "<task-notification><task-id>explore</task-id><status>completed</status><summary>Trace the session handoff finished</summary></task-notification>"
                    }]}
                }),
            ]
            .into_iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();

        let claude_subagents = roots
            .claude_projects
            .join("project/conversation-claude/subagents");
        fs::create_dir_all(&claude_subagents).unwrap();
        fs::write(
            claude_subagents.join("agent-explore.meta.json"),
            serde_json::json!({
                "agentType": "Explore",
                "description": "Trace the session handoff"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            claude_subagents.join("agent-explore.jsonl"),
            serde_json::json!({
                "type": "user",
                "isSidechain": true,
                "agentId": "agent-explore",
                "message": {"content": "Trace the session handoff"}
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            claude_subagents.join("notes.jsonl"),
            serde_json::json!({"type": "user", "message": {"content": "not a child"}})
                .to_string(),
        )
        .unwrap();

        let codex = roots.codex_sessions.join("2026/08/15/rollout.jsonl");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::write(
            &codex,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "conversation-codex",
                        "cwd": cwd,
                        "git": {"branch": "feature/session-details-codex"}
                    }
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "<environment_context>hidden runtime context</environment_context>"}]
                    }
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Codex question"}]
                    }
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "Codex answer"}]
                    }
                }),
                serde_json::json!({
                    "type": "turn_context",
                    "payload": {
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh"
                    }
                }),
            ]
            .into_iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();

        fs::write(
            roots
                .codex_sessions
                .join("2026/08/15/rollout-subagent.jsonl"),
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "subagent-codex",
                        "cwd": cwd,
                        "thread_source": "subagent",
                        "source": {
                            "subagent": {
                                "thread_spawn": {
                                    "parent_thread_id": "conversation-codex",
                                    "agent_path": "/root/explore-session",
                                    "agent_nickname": "Ada",
                                    "agent_role": "explore"
                                }
                            }
                        }
                    }
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Trace Codex session recovery"}]
                    }
                }),
            ]
            .into_iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();

        tauri::async_runtime::block_on(create_codex_authority_state(
            &roots,
            &[
                ("conversation-codex", "user"),
                ("subagent-codex", "subagent"),
            ],
            &[("conversation-codex", "subagent-codex")],
        ));

        let mut candidates = Vec::new();
        collect_claude(&roots.claude_projects, &mut candidates);
        collect_codex(&roots.codex_sessions, &mut candidates);
        let records = finalize(candidates);
        let details = records
            .iter()
            .map(|record| {
                let value = serde_json::to_value(record).unwrap();
                (record.provider.as_str(), value)
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(
            details["claude"]["recentTurns"],
            serde_json::json!([
                {"role": "user", "text": "Old question"},
                {"role": "agent", "text": "Old answer"},
                {"role": "user", "text": "Latest question"},
                {"role": "agent", "text": "x".repeat(MAX_TURN_PREVIEW_CHARS)}
            ])
        );
        assert_eq!(
            details["codex"]["recentTurns"],
            serde_json::json!([
                {"role": "user", "text": "Codex question"},
                {"role": "agent", "text": "Codex answer"}
            ])
        );
        assert_eq!(details["claude"]["branch"], "feature/session-details");
        assert_eq!(details["claude"]["model"], "claude-opus-5");
        assert_eq!(details["claude"]["effort"], "high");
        assert_eq!(details["claude"]["subagentCount"], 1);
        assert!(details["claude"].get("subagents").is_none());
        assert_eq!(
            details["codex"]["branch"],
            "feature/session-details-codex"
        );
        assert_eq!(details["codex"]["model"], "gpt-5.6-sol");
        assert_eq!(details["codex"]["effort"], "xhigh");
        assert_eq!(details["codex"]["subagentCount"], 1);
        assert!(details["codex"].get("subagents").is_none());

        let claude_details = tauri::async_runtime::block_on(details_for_roots(
            &roots,
            "claude",
            "conversation-claude",
        ))
        .expect("Claude details");
        assert_eq!(claude_details.total_count, 1);
        assert_eq!(claude_details.subagents.len(), 1);
        assert_eq!(claude_details.subagents[0].id, "agent-explore");
        assert_eq!(
            claude_details.subagents[0].title,
            "Trace the session handoff"
        );
        assert_eq!(claude_details.subagents[0].kind.as_deref(), Some("Explore"));
        assert_eq!(
            claude_details.subagents[0].status,
            ConversationSubagentStatus::Completed
        );

        let codex_details = tauri::async_runtime::block_on(details_for_roots(
            &roots,
            "codex",
            "conversation-codex",
        ))
        .expect("Codex details");
        assert_eq!(
            serde_json::to_value(&codex_details).unwrap()["inputAuthority"],
            serde_json::json!({"kind": "independent"})
        );
        assert_eq!(codex_details.total_count, 1);
        assert_eq!(codex_details.subagents.len(), 1);
        assert_eq!(codex_details.subagents[0].id, "subagent-codex");
        assert_eq!(
            codex_details.subagents[0].title,
            "Trace Codex session recovery"
        );
        assert_eq!(codex_details.subagents[0].kind.as_deref(), Some("explore"));

        let codex_subagent_details = tauri::async_runtime::block_on(details_for_roots(
            &roots,
            "codex",
            "subagent-codex",
        ))
        .expect("Codex subagent details");
        assert_eq!(
            serde_json::to_value(codex_subagent_details).unwrap()["inputAuthority"],
            serde_json::json!({
                "kind": "controlled_by_parent",
                "parentConversationId": "conversation-codex"
            })
        );
    }

    #[test]
    fn exact_codex_authority_uses_sqlite_without_bounded_jsonl_census() {
        tauri::async_runtime::block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let roots = roots(&temporary);
            fs::create_dir_all(&roots.codex_sessions).unwrap();
            create_codex_authority_state(
                &roots,
                &[
                    ("conversation-exact", "user"),
                    ("subagent-exact", "subagent"),
                    ("orphan-exact", "subagent"),
                    ("conflict-exact", "user"),
                ],
                &[
                    ("conversation-exact", "subagent-exact"),
                    ("conversation-exact", "conflict-exact"),
                ],
            )
            .await;

            let details = details_for_roots(&roots, "codex", "conversation-exact")
                .await
                .expect("exact Codex details");

            assert_eq!(
                details.input_authority,
                ProviderConversationInputAuthority::Independent
            );

            let controlled = details_for_roots(&roots, "codex", "subagent-exact")
                .await
                .expect("exact Codex subagent details");
            assert_eq!(
                controlled.input_authority,
                ProviderConversationInputAuthority::ControlledByParent {
                    parent_conversation_id: "conversation-exact".to_string(),
                }
            );

            for conversation_id in ["orphan-exact", "conflict-exact", "missing-exact"] {
                let details = details_for_roots(&roots, "codex", conversation_id)
                    .await
                    .expect("fail-closed Codex details");
                assert_eq!(
                    details.input_authority,
                    ProviderConversationInputAuthority::Unverified
                );
            }
        });
    }

    #[test]
    fn legacy_top_level_codex_authority_uses_its_exact_rollout_metadata() {
        tauri::async_runtime::block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let roots = roots(&temporary);
            let conversation_id = "legacy-top-level";
            let child_id = "legacy-child";
            let rollout = roots
                .codex_sessions
                .join("2026/08/27/rollout-legacy-top-level.jsonl");
            let child_rollout = roots
                .codex_sessions
                .join("2026/08/27/rollout-legacy-child.jsonl");
            fs::create_dir_all(rollout.parent().unwrap()).unwrap();
            fs::write(
                &rollout,
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": conversation_id,
                        "cwd": "/repo",
                        "source": "vscode"
                    }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                &child_rollout,
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": child_id,
                        "cwd": "/repo",
                        "source": {
                            "subagent": {
                                "thread_spawn": { "parent_thread_id": conversation_id }
                            }
                        }
                    }
                })
                .to_string(),
            )
            .unwrap();

            let options = SqliteConnectOptions::new()
                .filename(&roots.codex_state_database)
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query(
                "CREATE TABLE threads (\
                 id TEXT PRIMARY KEY, thread_source TEXT, rollout_path TEXT NOT NULL)",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            sqlx::query(
                "CREATE TABLE thread_spawn_edges (\
                 parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, \
                 status TEXT NOT NULL)",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO threads (id, thread_source, rollout_path) VALUES (?, NULL, ?)",
            )
            .bind(conversation_id)
            .bind(rollout.to_string_lossy().as_ref())
            .execute(&mut connection)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO threads (id, thread_source, rollout_path) VALUES (?, NULL, ?)",
            )
            .bind(child_id)
            .bind(child_rollout.to_string_lossy().as_ref())
            .execute(&mut connection)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) \
                 VALUES (?, ?, 'open')",
            )
            .bind(conversation_id)
            .bind(child_id)
            .execute(&mut connection)
            .await
            .unwrap();
            connection.close().await.unwrap();

            assert_eq!(
                exact_codex_input_authority(
                    &roots.codex_sessions,
                    &roots.codex_state_database,
                    conversation_id,
                )
                .await,
                ProviderConversationInputAuthority::Independent
            );
            assert_eq!(
                exact_codex_input_authority(
                    &roots.codex_sessions,
                    &roots.codex_state_database,
                    child_id,
                )
                .await,
                ProviderConversationInputAuthority::ControlledByParent {
                    parent_conversation_id: conversation_id.to_string()
                }
            );

            let options = SqliteConnectOptions::new().filename(&roots.codex_state_database);
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("UPDATE threads SET thread_source = '' WHERE id = ?")
                .bind(conversation_id)
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::query(
                "UPDATE thread_spawn_edges SET parent_thread_id = 'conflicting-parent' \
                 WHERE child_thread_id = ?",
            )
            .bind(child_id)
            .execute(&mut connection)
            .await
            .unwrap();
            connection.close().await.unwrap();
            assert_eq!(
                exact_codex_input_authority(
                    &roots.codex_sessions,
                    &roots.codex_state_database,
                    conversation_id,
                )
                .await,
                ProviderConversationInputAuthority::Independent
            );
            assert_eq!(
                exact_codex_input_authority(
                    &roots.codex_sessions,
                    &roots.codex_state_database,
                    child_id,
                )
                .await,
                ProviderConversationInputAuthority::Unverified
            );
        });
    }

    #[test]
    fn subagent_cache_survives_a_walk_that_visits_other_files() {
        // Two conversation panes walk concurrently in production; a
        // take-and-rebuild cache makes each walk destroy the other's entries,
        // so one walk per cycle always re-read the whole tree (2026-08-24
        // live daily driver: bursts persisted at ~19MB/s after the first
        // cache landed). Entries must survive walks that do not visit them.
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let path = roots.codex_sessions.join("2026/08/15/rollout-keep.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = |parent: &str| {
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "subagent-keep",
                    "cwd": cwd,
                    "source": {"subagent": {"thread_spawn": {"parent_thread_id": parent}}}
                }
            })
            .to_string()
        };
        fs::write(&path, body("parent-aaaa")).unwrap();
        let cache = Mutex::new(HashMap::new());

        let mut warm = HashMap::new();
        collect_codex_subagent_files_with_cache(
            &roots.codex_sessions,
            "parent-aaaa",
            &mut 0,
            &mut warm,
            &cache,
        );
        assert_eq!(warm.len(), 1);

        // A walk over an unrelated empty root must not evict the entry.
        let other_root = temporary.path().join("other-root");
        fs::create_dir_all(&other_root).unwrap();
        let mut unrelated = HashMap::new();
        collect_codex_subagent_files_with_cache(
            &other_root,
            "parent-aaaa",
            &mut 0,
            &mut unrelated,
            &cache,
        );

        // Same-fingerprint rewrite: a surviving entry replays the original.
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, body("parent-bbbb")).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(modified).unwrap();
        drop(file);
        let mut third = HashMap::new();
        collect_codex_subagent_files_with_cache(
            &roots.codex_sessions,
            "parent-aaaa",
            &mut 0,
            &mut third,
            &cache,
        );
        assert_eq!(
            third.len(),
            1,
            "an entry untouched by an unrelated walk must survive it"
        );
    }

    #[test]
    fn unchanged_subagent_rollout_is_served_from_the_scan_cache_without_rereading() {
        // The details walk re-read every rollout's bounded prefix per call
        // while mounted conversation surfaces legitimately re-ask on refresh.
        // Live daily driver 2026-08-24: two mounted codex panes produced
        // ~880MB disk-read bursts every ~60s. An unchanged fingerprint must
        // replay the cached subagent fact without opening the file.
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let path = roots.codex_sessions.join("2026/08/15/rollout-sub.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = |parent: &str| {
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": "subagent-1",
                    "cwd": cwd,
                    "source": {"subagent": {"thread_spawn": {"parent_thread_id": parent}}}
                }
            })
            .to_string()
        };
        fs::write(&path, body("parent-aaaa")).unwrap();
        let cache = Mutex::new(HashMap::new());

        let mut first = HashMap::new();
        collect_codex_subagent_files_with_cache(
            &roots.codex_sessions,
            "parent-aaaa",
            &mut 0,
            &mut first,
            &cache,
        );
        assert_eq!(first.len(), 1, "first walk must find the subagent");

        // Same byte length, restored mtime: the rewritten parent linkage must
        // not be observed because the file is never opened.
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, body("parent-bbbb")).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(modified).unwrap();
        drop(file);

        let mut second = HashMap::new();
        collect_codex_subagent_files_with_cache(
            &roots.codex_sessions,
            "parent-aaaa",
            &mut 0,
            &mut second,
            &cache,
        );
        assert_eq!(
            second.len(),
            1,
            "unchanged fingerprint must replay the cached subagent fact"
        );

        // A changed fingerprint invalidates and observes the new linkage.
        let touched = modified + std::time::Duration::from_secs(2);
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(touched).unwrap();
        drop(file);
        let mut third = HashMap::new();
        collect_codex_subagent_files_with_cache(
            &roots.codex_sessions,
            "parent-aaaa",
            &mut 0,
            &mut third,
            &cache,
        );
        assert_eq!(third.len(), 0, "changed file re-reads and drops the old parent");
    }

    #[test]
    fn unchanged_codex_rollout_is_served_from_the_scan_cache_without_rereading() {
        // Consumers refresh this listing on a 30s staleness while a real
        // ~/.codex/sessions tree can hold 100GB; re-reading every unchanged
        // file's bounded prefix+suffix summed to ~5MB/s of steady disk reads
        // on the 2026-08-24 live daily driver (~430GB/day in Activity
        // Monitor). An unchanged (mtime, size) fingerprint must replay the
        // previous outcome without opening the file.
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let codex = roots.codex_sessions.join("2026/08/15/rollout-cache.jsonl");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        let body = |title: &str| {
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "conversation-cache", "cwd": cwd}
                })
                .to_string(),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": title}]
                    }
                })
                .to_string(),
            ]
            .join("\n")
        };
        fs::write(&codex, body("Original 1title")).unwrap();
        // Test-local cache: the global one is shared by parallel tests, and a
        // concurrent scan taking it between our passes would force a re-read.
        let cache = Mutex::new(HashMap::new());

        let mut first = Vec::new();
        collect_codex_with_cache(&roots.codex_sessions, &mut first, &cache);
        assert_eq!(
            finalize(first).into_iter().next().unwrap().title,
            "Original 1title"
        );

        // Same byte length, same restored mtime — the fingerprint is
        // identical, so the scan must not observe the rewritten content.
        let modified = fs::metadata(&codex).unwrap().modified().unwrap();
        fs::write(&codex, body("Rewritten title")).unwrap();
        let file = fs::File::options().write(true).open(&codex).unwrap();
        file.set_modified(modified).unwrap();
        drop(file);

        let mut second = Vec::new();
        collect_codex_with_cache(&roots.codex_sessions, &mut second, &cache);
        assert_eq!(
            finalize(second).into_iter().next().unwrap().title,
            "Original 1title"
        );

        // A changed fingerprint invalidates the entry and reads the file.
        let touched = modified + std::time::Duration::from_secs(2);
        let file = fs::File::options().write(true).open(&codex).unwrap();
        file.set_modified(touched).unwrap();
        drop(file);
        let mut third = Vec::new();
        collect_codex_with_cache(&roots.codex_sessions, &mut third, &cache);
        assert_eq!(
            finalize(third).into_iter().next().unwrap().title,
            "Rewritten title"
        );
    }

    #[test]
    fn large_transcript_does_not_present_an_old_prefix_turn_as_recent() {
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let codex = roots.codex_sessions.join("2026/08/15/rollout-large.jsonl");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::write(
            &codex,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "conversation-large", "cwd": cwd}
                })
                .to_string(),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Ancient question"}]
                    }
                })
                .to_string(),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {"opaque": "x".repeat(MAX_SESSION_BYTES as usize + 64)}
                })
                .to_string(),
                serde_json::json!({"type": "event_msg", "payload": {"type": "token_count"}})
                    .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let mut candidates = Vec::new();
        collect_codex(&roots.codex_sessions, &mut candidates);
        let record = finalize(candidates).into_iter().next().unwrap();

        assert!(record.recent_turns.is_empty());
    }

    #[test]
    fn recent_codex_record_uses_the_latest_provider_thread_name() {
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let codex = roots.codex_sessions.join("2026/09/03/rollout-title.jsonl");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::write(
            &codex,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "conversation-title", "cwd": cwd}
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "Original prompt"
                    }
                }),
            ]
            .map(|record| record.to_string())
            .join("\n"),
        )
        .unwrap();
        fs::write(
            roots.codex_sessions.parent().unwrap().join("session_index.jsonl"),
            [
                serde_json::json!({
                    "id": "conversation-title",
                    "thread_name": "Generated title"
                }),
                serde_json::json!({
                    "id": "conversation-title",
                    "thread_name": "clean code"
                }),
            ]
            .map(|record| record.to_string())
            .join("\n"),
        )
        .unwrap();

        let mut candidates = Vec::new();
        collect_codex(&roots.codex_sessions, &mut candidates);
        let record = finalize(candidates).into_iter().next().unwrap();

        assert_eq!(record.title, "clean code");
    }

    #[test]
    fn incomplete_large_suffix_does_not_fall_back_to_an_old_prefix_turn() {
        let temporary = tempfile::tempdir().unwrap();
        let roots = roots(&temporary);
        let cwd = temporary.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let codex = roots
            .codex_sessions
            .join("2026/08/15/rollout-incomplete-suffix.jsonl");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::write(
            &codex,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "conversation-incomplete-suffix", "cwd": cwd}
                })
                .to_string(),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Ancient question"}]
                    }
                })
                .to_string(),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {"opaque": "x".repeat(MAX_SESSION_BYTES as usize + 64)}
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let mut candidates = Vec::new();
        collect_codex(&roots.codex_sessions, &mut candidates);
        let record = finalize(candidates).into_iter().next().unwrap();

        assert!(record.recent_turns.is_empty());
    }

    #[test]
    fn missing_working_directory_is_recorded_without_becoming_available() {
        let temporary = tempfile::tempdir().unwrap();
        let missing = temporary.path().join("removed-worktree");
        let candidate = record(
            "codex",
            "missing-worktree-session",
            &missing.to_string_lossy(),
            Some("Missing worktree".to_string()),
            "Codex",
            1,
            None,
        )
        .unwrap();

        assert!(!candidate.record.working_directory_available);
        assert_eq!(candidate.record.cwd, missing.to_string_lossy());
    }

    #[test]
    fn global_file_discovery_is_provider_native_sorted_and_independent_of_dure_state() {
        tauri::async_runtime::block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let roots = roots(&temporary);
            let claude_cwd = temporary.path().join("claude-work");
            let codex_cwd = temporary.path().join("codex-work");
            let gemini_cwd = temporary.path().join("gemini-work");
            let pi_cwd = temporary.path().join("pi-work");
            let grok_cwd = temporary.path().join("grok-work");
            for cwd in [
                &claude_cwd,
                &codex_cwd,
                &gemini_cwd,
                &pi_cwd,
                &grok_cwd,
            ] {
                fs::create_dir_all(cwd).unwrap();
            }

            let claude = roots
                .claude_projects
                .join("project/conversation-claude.jsonl");
            fs::create_dir_all(claude.parent().unwrap()).unwrap();
            fs::write(
                &claude,
                serde_json::json!({
                    "type": "user",
                    "uuid": "message-origin",
                    "cwd": claude_cwd,
                    "message": {"content": "Claude history"}
                })
                .to_string(),
            )
            .unwrap();

            let gemini_project = roots.gemini.join("tmp/project");
            let gemini = gemini_project.join("chats/gemini.jsonl");
            fs::create_dir_all(gemini.parent().unwrap()).unwrap();
            fs::write(
                gemini_project.join(".project_root"),
                gemini_cwd.to_string_lossy().as_bytes(),
            )
            .unwrap();
            fs::write(
                &gemini,
                [
                    serde_json::json!({"sessionId": "conversation-gemini", "kind": "main"}),
                    serde_json::json!({"type": "user", "content": "Gemini history"}),
                ]
                .into_iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
            )
            .unwrap();

            let codex = roots
                .codex_sessions
                .join("2026/07/31/rollout-codex.jsonl");
            fs::create_dir_all(codex.parent().unwrap()).unwrap();
            fs::write(
                &codex,
                [
                    serde_json::json!({
                        "type": "session_meta",
                        "payload": {
                            "id": "conversation-codex",
                            "cwd": codex_cwd,
                            "originator": "codex_exec"
                        }
                    }),
                    serde_json::json!({
                        "type": "response_item",
                        "payload": {"type": "message", "role": "user", "content": "Codex history"}
                    }),
                ]
                .into_iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
            )
            .unwrap();

            let grok = roots
                .grok
                .join("sessions/project/019c10d2-8d16-7cc0-a44e-55847c4eb786/summary.json");
            fs::create_dir_all(grok.parent().unwrap()).unwrap();
            fs::write(
                grok,
                serde_json::json!({
                    "info": {
                        "id": "019c10d2-8d16-7cc0-a44e-55847c4eb786",
                        "cwd": grok_cwd
                    },
                    "generated_title": "Grok history"
                })
                .to_string(),
            )
            .unwrap();

            let pi = roots.pi_sessions.join("project/pi.jsonl");
            fs::create_dir_all(pi.parent().unwrap()).unwrap();
            fs::write(
                &pi,
                [
                    serde_json::json!({"type": "session", "id": "conversation-pi", "cwd": pi_cwd}),
                    serde_json::json!({"type": "message", "message": {"role": "user", "content": "Pi history"}}),
                ]
                .into_iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
            )
            .unwrap();

            let records = discover(&roots).await;
            let identities = records
                .iter()
                .map(|record| (record.provider.as_str(), record.id.as_str()))
                .collect::<HashSet<_>>();
            assert_eq!(
                identities,
                HashSet::from([
                    ("claude", "conversation-claude"),
                    ("codex", "conversation-codex"),
                    ("gemini", "conversation-gemini"),
                    ("grok", "019c10d2-8d16-7cc0-a44e-55847c4eb786"),
                    ("pi", "conversation-pi"),
                ])
            );
            assert!(records.windows(2).all(|rows| rows[0].mtime >= rows[1].mtime));
            assert!(records
                .iter()
                .all(|record| record.resume_capability == ResumeCapability::Exact));
            assert!(records
                .iter()
                .all(|record| record.working_directory_available));
            assert_eq!(
                records
                    .iter()
                    .find(|record| record.provider == "codex")
                    .and_then(|record| record.interaction_kind),
                Some(ConversationInteractionKind::NonInteractive)
            );
        });
    }

    #[test]
    fn codex_originator_classifies_interactive_and_one_shot_history() {
        let metadata = |originator: &str| {
            serde_json::json!({
                "type": "session_meta",
                "payload": {"originator": originator}
            })
        };

        assert_eq!(
            codex_interaction_kind(&metadata("codex-tui")),
            Some(ConversationInteractionKind::Interactive)
        );
        assert_eq!(
            codex_interaction_kind(&metadata("codex_exec")),
            Some(ConversationInteractionKind::NonInteractive)
        );
        assert_eq!(codex_interaction_kind(&metadata("future-client")), None);
    }

    #[test]
    fn finalization_deduplicates_exact_ids_and_logical_fragments_per_source() {
        let candidate = |provider: &str,
                         id: &str,
                         logical_identity: &str,
                         mtime: u64,
                         host_id: Option<&str>| Candidate {
            record: ProviderConversationRecord {
                provider: provider.to_string(),
                id: id.to_string(),
                cwd: "/repo".to_string(),
                title: id.to_string(),
                mtime,
                resume_capability: ResumeCapability::Exact,
                interaction_kind: None,
                working_directory_available: true,
                execution_location: execution_location(host_id),
                host_id: host_id.map(str::to_string),
                repository_root: None,
                repository_common_dir: None,
                repository_remote_identity: None,
                branch: None,
                model: None,
                effort: None,
                recent_turns: Vec::new(),
                subagent_count: 0,
            },
            logical_identity: logical_identity.to_string(),
        };

        let records = finalize(vec![
            candidate("claude", "same-id", "origin-a", 30, None),
            candidate("claude", "same-id", "origin-b", 20, None),
            candidate("claude", "fragment-id", "origin-a", 10, None),
            candidate("claude", "fragment-id-b", "origin-b", 5, None),
            candidate("codex", "same-id", "same-id", 25, None),
            candidate("claude", "same-id", "origin-a", 15, Some("remote-a")),
        ]);

        assert_eq!(
            records
                .iter()
                .map(|record| (
                    record.provider.as_str(),
                    record.id.as_str(),
                    record.host_id.as_deref()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("claude", "same-id", None),
                ("codex", "same-id", None),
                ("claude", "same-id", Some("remote-a")),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn repository_resolution_prefers_nearest_marker_and_canonicalizes_symlinks() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let outer = temporary.path().join("outer");
        let nested = outer.join("vendor/nested");
        let nested_child = nested.join("src/component");
        fs::create_dir_all(outer.join(".git")).unwrap();
        fs::create_dir_all(&nested_child).unwrap();
        // A .git file + commondir covers linked worktrees and submodules without Git.
        let common_dir = temporary.path().join("metadata/common");
        let linked_git_dir = common_dir.join("worktrees/nested");
        fs::create_dir_all(&linked_git_dir).unwrap();
        fs::write(linked_git_dir.join("commondir"), "../..\n").unwrap();
        fs::write(
            common_dir.join("config"),
            "[remote \"origin\"]\n  url = https://user:secret@GitHub.com/org/repo.git\n",
        )
        .unwrap();
        fs::write(
            nested.join(".git"),
            format!("gitdir: {}\n", linked_git_dir.display()),
        )
        .unwrap();

        let (
            cwd,
            repository_root,
            repository_common_dir,
            repository_remote_identity,
            working_directory_available,
        ) = local_location(&nested_child.to_string_lossy()).unwrap();
        assert!(working_directory_available);
        assert_eq!(cwd, fs::canonicalize(&nested_child).unwrap().to_string_lossy());
        assert_eq!(
            repository_root,
            Some(fs::canonicalize(&nested).unwrap().to_string_lossy().into_owned())
        );
        assert_eq!(
            repository_common_dir,
            Some(fs::canonicalize(&common_dir).unwrap().to_string_lossy().into_owned())
        );
        assert_eq!(
            repository_remote_identity.as_deref(),
            Some("github.com/org/repo")
        );

        let alias = temporary.path().join("linked-alias");
        symlink(&nested, &alias).unwrap();
        let alias_child = alias.join("src/component");
        let (
            cwd,
            repository_root,
            repository_common_dir,
            repository_remote_identity,
            working_directory_available,
        ) = local_location(&alias_child.to_string_lossy()).unwrap();
        assert!(working_directory_available);
        assert_eq!(cwd, fs::canonicalize(&nested_child).unwrap().to_string_lossy());
        assert_eq!(
            repository_root,
            Some(fs::canonicalize(&nested).unwrap().to_string_lossy().into_owned())
        );
        assert_eq!(
            repository_common_dir,
            Some(fs::canonicalize(&common_dir).unwrap().to_string_lossy().into_owned())
        );
        assert_eq!(
            repository_remote_identity.as_deref(),
            Some("github.com/org/repo")
        );

        let separate_clone = temporary.path().join("separate-clone");
        fs::create_dir_all(separate_clone.join(".git")).unwrap();
        fs::write(
            separate_clone.join(".git/config"),
            "[remote \"origin\"]\n  url = git@github.com:org/repo.git\n",
        )
        .unwrap();
        let (_, _, separate_common_dir, separate_remote_identity, _) =
            local_location(&separate_clone.to_string_lossy()).unwrap();
        assert_ne!(separate_common_dir, repository_common_dir);
        assert_eq!(separate_remote_identity, repository_remote_identity);

        let standalone = temporary.path().join("standalone/folder");
        fs::create_dir_all(&standalone).unwrap();
        let (
            cwd,
            repository_root,
            repository_common_dir,
            repository_remote_identity,
            working_directory_available,
        ) = local_location(&standalone.to_string_lossy()).unwrap();
        assert!(working_directory_available);
        assert_eq!(cwd, fs::canonicalize(&standalone).unwrap().to_string_lossy());
        assert_eq!(repository_root, None);
        assert_eq!(repository_common_dir, None);
        assert_eq!(repository_remote_identity, None);
    }

    #[test]
    fn remote_identity_requires_one_sanitized_primary_origin() {
        assert_eq!(
            origin_remote_identity(
                "[remote \"origin\"]\nurl = ssh://git@Example.com:22/team/repo.git\n"
            )
            .as_deref(),
            Some("example.com/team/repo")
        );
        assert_eq!(
            origin_remote_identity(
                "[remote \"origin\"]\nurl = https://token@example.com/team/repo.git\nurl = git@example.net:fork/repo.git\n"
            ),
            None
        );
        assert_eq!(
            origin_remote_identity("[remote \"upstream\"]\nurl = git@example.com:team/repo.git\n"),
            None
        );
    }

    #[test]
    fn opencode_sqlite_is_read_only_bounded_and_legacy_json_remains_visible() {
        tauri::async_runtime::block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let mut roots = roots(&temporary);
            fs::create_dir_all(&roots.opencode_data).unwrap();
            let database = roots.opencode_data.join("opencode.db");
            let options = SqliteConnectOptions::new()
                .filename(&database)
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query(
                "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, \
                 title TEXT NOT NULL, time_updated INTEGER NOT NULL, parent_id TEXT)",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO session (id, directory, title, time_updated, parent_id) \
                 VALUES (?, ?, ?, ?, NULL), (?, ?, ?, ?, 'parent')",
            )
            .bind("ses_sqlite")
            .bind(temporary.path().join("sqlite-work").to_string_lossy().as_ref())
            .bind("SQLite session")
            .bind(9_000_i64)
            .bind("ses_child")
            .bind(temporary.path().join("child-work").to_string_lossy().as_ref())
            .bind("Child session")
            .bind(10_000_i64)
            .execute(&mut connection)
            .await
            .unwrap();
            connection.close().await.unwrap();

            let legacy = roots
                .opencode_data
                .join("storage/session/project/ses_legacy.json");
            fs::create_dir_all(legacy.parent().unwrap()).unwrap();
            fs::write(
                legacy,
                serde_json::json!({
                    "id": "ses_legacy",
                    "directory": temporary.path().join("legacy-work"),
                    "title": "Legacy session",
                    "time": {"updated": 8000}
                })
                .to_string(),
            )
            .unwrap();
            roots.opencode_db_override = Some(database.clone());

            let before = fs::metadata(&database).unwrap().modified().unwrap();
            let records = discover(&roots).await;
            let after = fs::metadata(&database).unwrap().modified().unwrap();
            assert_eq!(before, after);
            assert_eq!(
                records
                    .iter()
                    .filter(|record| record.provider == "opencode")
                    .map(|record| record.id.as_str())
                    .collect::<HashSet<_>>(),
                HashSet::from(["ses_sqlite", "ses_legacy"]),
            );
            assert!(!records.iter().any(|record| record.id == "ses_child"));
        });
    }

    #[test]
    fn pi_saved_conversation_details_allow_exact_recovery() {
        tauri::async_runtime::block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let roots = roots(&temporary);
            let directory = roots.pi_sessions.join("project");
            fs::create_dir_all(&directory).unwrap();
            for (id, parent) in [("pi-current", None), ("pi-fork", Some("/old/session.jsonl"))] {
                let path = directory.join(format!("2026-09-11_{id}.jsonl"));
                let content = format!("{}\n", serde_json::json!({
                    "type": "session", "version": 3, "id": id,
                    "cwd": temporary.path(), "parentSession": parent,
                }));
                fs::write(&path, &content).unwrap();
                let details = details_for_roots(&roots, "pi", id).await.unwrap();
                assert_eq!(details.input_authority, ProviderConversationInputAuthority::Independent);
                assert_eq!(details.total_count, 0);
                assert!(details.subagents.is_empty());
                assert_eq!(fs::read_to_string(&path).unwrap(), content);
            }
            let records = discover(&roots).await;
            assert_eq!(records.iter().filter(|record| record.provider == "pi").count(), 2);
        });
    }

    #[test]
    fn pi_details_do_not_infer_authority_from_a_filename_or_another_session() {
        tauri::async_runtime::block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let roots = roots(&temporary);
            fs::create_dir_all(&roots.pi_sessions).unwrap();
            for (filename, content) in [
                ("missing", serde_json::json!({"type": "session", "id": "another", "cwd": temporary.path()}).to_string()),
                ("malformed", "{not-json}".to_string()),
                ("relative", serde_json::json!({"type": "session", "id": "relative", "cwd": "relative/path"}).to_string()),
            ] {
                fs::write(roots.pi_sessions.join(format!("{filename}.jsonl")), content).unwrap();
                let details = details_for_roots(&roots, "pi", filename).await.unwrap();
                assert_eq!(details.input_authority, ProviderConversationInputAuthority::Unverified);
            }
            assert!(details_for_roots(&roots, "pi", "../another").await.is_err());
        });
    }

    #[test]
    fn malformed_oversized_and_relative_records_fail_closed() {
        tauri::async_runtime::block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let roots = roots(&temporary);
            let directory = roots.pi_sessions.join("project");
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("malformed.jsonl"), "{not-json}\n").unwrap();
            fs::write(
                directory.join("relative.jsonl"),
                serde_json::json!({"type": "session", "id": "relative", "cwd": "relative/path"})
                    .to_string(),
            )
            .unwrap();
            let oversized = directory.join("oversized.jsonl");
            let mut content = serde_json::json!({
                "type": "session",
                "id": "bounded-prefix",
                "cwd": temporary.path().join("bounded")
            })
            .to_string();
            content.push('\n');
            content.push_str(&"x".repeat(MAX_SESSION_BYTES as usize));
            fs::write(oversized, content).unwrap();

            let records = discover(&roots).await;
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].id, "bounded-prefix");
        });
    }
}
