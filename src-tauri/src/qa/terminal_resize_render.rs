use crate::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

const SNAPSHOT_PATH_ENV: &str = "DURE_QA_TERMINAL_SNAPSHOT_PATH";
const SNAPSHOT_ROOT_ENV: &str = "DURE_QA_TERMINAL_SNAPSHOT_ROOT";
const MAX_SNAPSHOT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SNAPSHOT_REPAINT_BYTES: usize = 512 * 1024;
const MAX_SNAPSHOT_DIMENSION: u16 = 1_000;
const SNAPSHOT_INPUT_CHUNK_BYTES: usize = 16 * 1024;
const _: () = assert!(SNAPSHOT_INPUT_CHUNK_BYTES < 64 * 1024);
const COMMAND_INPUT_TIMEOUT: Duration = Duration::from_secs(5);
const SNAPSHOT_STREAM_BEGIN: &str = "DURE_RESIZE_QA_SNAPSHOT_STREAM_BEGIN";
const SNAPSHOT_STREAM_END: &str = "DURE_RESIZE_QA_SNAPSHOT_STREAM_END";
const FIXTURE_START: &str = "DURE_RESIZE_QA_FIXTURE_START";
pub const SEED_MARKER: &str = "DURE_RESIZE_QA_SEED_READY";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalResizeScreenModel {
    Alternate,
    Normal,
}

impl TerminalResizeScreenModel {
    fn enter_buffer(self) -> &'static str {
        match self {
            Self::Alternate => "\\033[?1049h",
            Self::Normal => "",
        }
    }

    fn leave_buffer(self) -> &'static str {
        match self {
            Self::Alternate => "\\033[?1049l",
            Self::Normal => "",
        }
    }
}

pub fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.len() > 24
        || provider.is_empty()
        || !provider.as_bytes()[0].is_ascii_lowercase()
        || !provider
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(
            "resize render provider must be a lowercase token of at most 24 characters".to_string(),
        );
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotSeedReceipt {
    rows: u16,
    columns: u16,
    alternate_screen: bool,
    cursor_visible: bool,
    truncated: bool,
    repaint_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSnapshotSeedFile {
    schema_version: u8,
    rows: u16,
    columns: u16,
    data: String,
    alternate_screen: bool,
    cursor_visible: bool,
    truncated: bool,
}

pub struct TerminalSnapshotSeed {
    encoded_repaint: String,
    pub receipt: TerminalSnapshotSeedReceipt,
}

pub struct TerminalResizeFixtureLaunch {
    pub command: Vec<String>,
    pub rows: u16,
    pub columns: u16,
}

pub fn load_snapshot_seed_from_environment() -> Result<Option<TerminalSnapshotSeed>, String> {
    let Some(path) = std::env::var_os(SNAPSHOT_PATH_ENV) else {
        return Ok(None);
    };
    let root = std::env::var_os(SNAPSHOT_ROOT_ENV)
        .ok_or_else(|| format!("{SNAPSHOT_ROOT_ENV} is required with {SNAPSHOT_PATH_ENV}"))?;
    load_snapshot_seed(Path::new(&root), Path::new(&path)).map(Some)
}

fn load_snapshot_seed(root: &Path, path: &Path) -> Result<TerminalSnapshotSeed, String> {
    let root = canonical_directory(root, SNAPSHOT_ROOT_ENV)?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("canonicalize terminal snapshot seed failed: {error}"))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("terminal snapshot seed must be a file below its declared root".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("inspect terminal snapshot seed failed: {error}"))?;
    if metadata.len() > MAX_SNAPSHOT_FILE_BYTES {
        return Err("terminal snapshot seed file exceeds 2 MiB".to_string());
    }
    let source = fs::read_to_string(&path)
        .map_err(|error| format!("read terminal snapshot seed failed: {error}"))?;
    let snapshot: TerminalSnapshotSeedFile = serde_json::from_str(&source)
        .map_err(|error| format!("parse terminal snapshot seed failed: {error}"))?;
    if snapshot.schema_version != 1
        || snapshot.rows == 0
        || snapshot.rows > MAX_SNAPSHOT_DIMENSION
        || snapshot.columns == 0
        || snapshot.columns > MAX_SNAPSHOT_DIMENSION
    {
        return Err("terminal snapshot seed has unsupported metadata".to_string());
    }
    let repaint = base64::engine::general_purpose::STANDARD
        .decode(&snapshot.data)
        .map_err(|error| format!("decode terminal snapshot seed failed: {error}"))?;
    if repaint.len() > MAX_SNAPSHOT_REPAINT_BYTES {
        return Err("terminal snapshot repaint exceeds 512 KiB".to_string());
    }
    Ok(TerminalSnapshotSeed {
        encoded_repaint: snapshot.data,
        receipt: TerminalSnapshotSeedReceipt {
            rows: snapshot.rows,
            columns: snapshot.columns,
            alternate_screen: snapshot.alternate_screen,
            cursor_visible: snapshot.cursor_visible,
            truncated: snapshot.truncated,
            repaint_bytes: repaint.len(),
        },
    })
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("canonicalize {label} failed: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{label} must be a directory"));
    }
    Ok(canonical)
}

fn send_snapshot_seed(
    session_id: &str,
    workspace_id: &str,
    seed: &TerminalSnapshotSeed,
) -> Result<(), String> {
    let mut commands = vec![SNAPSHOT_STREAM_BEGIN.to_string()];
    for bytes in seed
        .encoded_repaint
        .as_bytes()
        .chunks(SNAPSHOT_INPUT_CHUNK_BYTES)
    {
        let chunk = std::str::from_utf8(bytes)
            .map_err(|error| format!("terminal snapshot seed is not ASCII: {error}"))?;
        commands.push(chunk.to_string());
    }
    commands.push(SNAPSHOT_STREAM_END.to_string());
    crate::hmux::command_input::send_local_standalone_commands(
        session_id,
        workspace_id,
        commands,
        COMMAND_INPUT_TIMEOUT,
    )?;
    Ok(())
}

pub fn install_snapshot_seed<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    workspace_id: &str,
    seed: &TerminalSnapshotSeed,
) -> Result<(), String> {
    let manager = &app.state::<AppState>().hmux;
    send_snapshot_seed(session_id, workspace_id, seed)?;
    wait_for_seed_marker(manager, session_id, workspace_id)
}

pub fn activate_fixture(session_id: &str, workspace_id: &str) -> Result<String, String> {
    crate::hmux::command_input::send_local_standalone_commands(
        session_id,
        workspace_id,
        [FIXTURE_START.to_string()],
        COMMAND_INPUT_TIMEOUT,
    )?
    .ok_or_else(|| "terminal resize activation produced no input receipt".to_string())
}

fn wait_for_seed_marker(
    manager: &crate::hmux::HmuxManager,
    session_id: &str,
    workspace_id: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let snapshot = manager.inspect_session_snapshot(session_id, workspace_id)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(snapshot.data)
            .map_err(|error| format!("decode QA snapshot failed: {error}"))?;
        if bytes
            .windows(SEED_MARKER.len())
            .any(|window| window == SEED_MARKER.as_bytes())
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err("timed out waiting for the terminal snapshot seed marker".to_string())
}

pub fn fixture_launch(
    provider: &str,
    screen_model: TerminalResizeScreenModel,
    seed: Option<&TerminalSnapshotSeed>,
) -> Result<TerminalResizeFixtureLaunch, String> {
    validate_provider(provider)?;
    let marker = provider.to_ascii_uppercase();
    let enter_buffer = screen_model.enter_buffer();
    let leave_buffer = screen_model.leave_buffer();
    let body = format!(
        "stty -echo; \
         IFS= read -r DURE_QA_COMMAND || exit 1; \
         if [ \"$DURE_QA_COMMAND\" = {SNAPSHOT_STREAM_BEGIN} ]; then \
         {{ while IFS= read -r DURE_QA_SEED_CHUNK; do \
         [ \"$DURE_QA_SEED_CHUNK\" = {SNAPSHOT_STREAM_END} ] && break; \
         printf '%s' \"$DURE_QA_SEED_CHUNK\"; done; }} | {{ \
         if [ \"$(uname -s)\" = Darwin ]; then /usr/bin/base64 -D; \
         else base64 -d; fi; }}; \
         printf '\\r\\n{SEED_MARKER}\\r\\n'; \
         IFS= read -r DURE_QA_COMMAND || exit 1; fi; \
         [ \"$DURE_QA_COMMAND\" = {FIXTURE_START} ] || exit 2; \
         DURE_QA_GENERATION=0; DURE_QA_LAST_INPUT=; \
         dure_resize_qa_draw() {{ \
         DURE_QA_GENERATION=$((DURE_QA_GENERATION+1)); \
         DURE_QA_SIZE=$(stty size); \
         DURE_QA_ROWS=${{DURE_QA_SIZE%% *}}; \
         DURE_QA_COLUMNS=${{DURE_QA_SIZE##* }}; \
         printf '{enter_buffer}\\033[2J\\033[H'; \
         printf 'DURE_RESIZE_QA_{marker}_R%s_C%s_G%s' \
         \"$DURE_QA_ROWS\" \"$DURE_QA_COLUMNS\" \"$DURE_QA_GENERATION\"; \
         printf '\\033[3;1Hprovider={marker} resize-aware fixture'; \
         if [ -n \"$DURE_QA_LAST_INPUT\" ]; then \
         printf '\\033[5;1H%s' \"$DURE_QA_LAST_INPUT\"; fi; \
         printf '\\033[%s;1HDURE_RESIZE_QA_FOOTER_{marker}_G%s' \
         \"$DURE_QA_ROWS\" \"$DURE_QA_GENERATION\"; \
         }}; \
         trap 'dure_resize_qa_draw' WINCH; \
         trap 'printf \"{leave_buffer}\\033[?25h\"; stty echo; exit 0' HUP INT TERM; \
         printf '\\033[?25h'; dure_resize_qa_draw; \
         while :; do IFS= read -r DURE_QA_INPUT || :; \
         DURE_QA_LAST_INPUT=$DURE_QA_INPUT; dure_resize_qa_draw; \
         DURE_QA_LAST_INPUT=; done"
    );
    let (rows, columns) = seed
        .map(|seed| (seed.receipt.rows, seed.receipt.columns))
        .unwrap_or((30, 100));
    Ok(TerminalResizeFixtureLaunch {
        command: vec!["/bin/sh".to_string(), "-c".to_string(), body],
        rows,
        columns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "dure-terminal-resize-render-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn provider_commands_preserve_distinct_screen_models() {
        let claude = fixture_launch("claude", TerminalResizeScreenModel::Alternate, None).unwrap();
        let codex = fixture_launch("codex", TerminalResizeScreenModel::Normal, None).unwrap();
        let claude_command = claude.command.join(" ");
        let codex_command = codex.command.join(" ");

        assert_eq!(&claude.command[..2], ["/bin/sh", "-c"]);
        assert!(claude_command.contains("DURE_RESIZE_QA_CLAUDE"));
        assert!(claude_command.contains("\\033[?1049h"));
        assert!(claude_command.contains("\\033[?1049l"));
        assert!(codex_command.contains("DURE_RESIZE_QA_CODEX"));
        assert!(!codex_command.contains("\\033[?1049h"));
        assert!(codex_command.contains("dure_resize_qa_draw"));
        assert!(codex_command.contains("WINCH"));
        assert!(codex_command.contains(FIXTURE_START));
        assert!(codex_command.contains("DURE_QA_SIZE%% *"));
        assert!(!codex_command.contains("set -- $(stty size)"));
        assert!(validate_provider("future_provider").is_ok());
        assert!(validate_provider("Future-Provider").is_err());
        assert_eq!((claude.rows, claude.columns), (30, 100));
    }

    #[test]
    fn seed_loader_accepts_only_bounded_files_below_the_declared_root() {
        let root = temporary_root();
        let path = root.join("snapshot.json");
        fs::write(
            &path,
            r#"{"schemaVersion":1,"rows":24,"columns":80,"data":"aGVsbG8=","alternateScreen":true,"cursorVisible":true,"truncated":false}"#,
        )
        .unwrap();

        let seed = load_snapshot_seed(&root, &path).unwrap();
        assert_eq!(seed.receipt.repaint_bytes, 5);
        let launch = fixture_launch(
            "claude",
            TerminalResizeScreenModel::Alternate,
            Some(&seed),
        )
        .unwrap();
        assert_eq!((launch.rows, launch.columns), (24, 80));
        let command = launch.command.join(" ");
        assert!(command.contains(SEED_MARKER));
        assert!(command.contains(SNAPSHOT_STREAM_BEGIN));
        assert!(command.contains(SNAPSHOT_STREAM_END));

        fs::write(
            &path,
            r#"{"schemaVersion":1,"rows":24,"columns":1001,"data":"aGVsbG8=","alternateScreen":true,"cursorVisible":true,"truncated":false}"#,
        )
        .unwrap();
        assert!(load_snapshot_seed(&root, &path).is_err());

        let outside = root.with_extension("json");
        fs::write(&outside, "{}").unwrap();
        assert!(load_snapshot_seed(&root, &outside).is_err());
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
