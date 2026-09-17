use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DROPPED_FILES: usize = 5;
const MAX_DROPPED_BYTES: usize = 50 * 1024 * 1024;
const MAX_ENCODED_FILE_BYTES: usize = MAX_DROPPED_BYTES.div_ceil(3) * 4;
const MAX_FILE_NAME_BYTES: usize = 255;
const MAX_STORED_NAME_BYTES: usize = 160;
const PUBLISH_DIRECTORY_PREFIX: &str = ".dure-file-drop-";
const REMOTE_PUBLISH_DIRECTORY_PREFIX: &str = ".dure-file-drop.";
const REMOTE_DROP_DIRECTORY_PREFIX: &str = "dure-drop.";
static NEXT_DROP_DIRECTORY: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DroppedFilePayload {
    data_b64: String,
    file_name: String,
}

#[derive(Debug)]
struct DecodedDroppedFile {
    data: Vec<u8>,
    file_name: String,
}

fn decode_payloads(files: Vec<DroppedFilePayload>) -> Result<Vec<DecodedDroppedFile>, String> {
    decode_payloads_with_limits(files, MAX_DROPPED_FILES, MAX_DROPPED_BYTES)
}

fn decode_payloads_with_limits(
    files: Vec<DroppedFilePayload>,
    max_files: usize,
    max_bytes: usize,
) -> Result<Vec<DecodedDroppedFile>, String> {
    if files.is_empty() {
        return Err("dropped_files_empty: at least one file is required".to_string());
    }
    if files.len() > max_files {
        return Err(format!(
            "dropped_files_count_limit: at most {max_files} files are allowed"
        ));
    }

    let mut decoded = Vec::with_capacity(files.len());
    let mut total_bytes = 0usize;
    for file in files {
        if file.file_name.is_empty() || file.file_name.len() > MAX_FILE_NAME_BYTES {
            return Err("dropped_file_name_invalid: file name is empty or too long".to_string());
        }
        let encoded_limit = max_bytes.div_ceil(3) * 4;
        if file.data_b64.len() > encoded_limit || file.data_b64.len() > MAX_ENCODED_FILE_BYTES {
            return Err("dropped_file_size_limit: encoded file exceeds 50 MiB".to_string());
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(file.data_b64)
            .map_err(|_| "dropped_file_base64_invalid: invalid base64 data".to_string())?;
        if data.len() > max_bytes {
            return Err("dropped_file_size_limit: file exceeds 50 MiB".to_string());
        }
        total_bytes = total_bytes
            .checked_add(data.len())
            .ok_or_else(|| "dropped_files_total_limit: byte count overflow".to_string())?;
        if total_bytes > max_bytes {
            return Err("dropped_files_total_limit: files exceed 50 MiB combined".to_string());
        }
        decoded.push(DecodedDroppedFile {
            data,
            file_name: file.file_name,
        });
    }
    Ok(decoded)
}

fn safe_file_name(file_name: &str) -> String {
    let mut safe = String::new();
    for character in file_name.chars() {
        let replacement = if character.is_alphanumeric()
            || character == '.'
            || character == '-'
            || character == '_'
        {
            character
        } else {
            '_'
        };
        if safe.len() + replacement.len_utf8() > MAX_STORED_NAME_BYTES {
            break;
        }
        safe.push(replacement);
    }
    if safe.is_empty() {
        "file".to_string()
    } else {
        safe
    }
}

fn stored_file_name(index: usize, file_name: &str) -> String {
    format!("{index}-{}", safe_file_name(file_name))
}

fn private_directory_create(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    builder.create(path)
}

fn create_owned_drop_directory(root: &Path) -> Result<PathBuf, String> {
    for _ in 0..32 {
        let sequence = NEXT_DROP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = root.join(format!(
            "agent-ide-drop-{}-{nanos:x}-{sequence:x}",
            std::process::id()
        ));
        match private_directory_create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("dropped_files_directory_create_failed: {error}"));
            }
        }
    }
    Err("dropped_files_directory_collision: could not allocate a unique directory".to_string())
}

fn create_owned_publish_directory(root: &Path) -> Result<PathBuf, String> {
    for _ in 0..32 {
        let sequence = NEXT_DROP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = root.join(format!(
            "{PUBLISH_DIRECTORY_PREFIX}{}-{nanos:x}-{sequence:x}",
            std::process::id()
        ));
        match private_directory_create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("dropped_files_directory_create_failed: {error}"));
            }
        }
    }
    Err("dropped_files_directory_collision: could not allocate a unique directory".to_string())
}

fn private_file_create(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn publish_staging_file_create(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    options.open(path)
}

fn write_decoded_files_to_owned_directory(
    directory: &Path,
    files: Vec<DecodedDroppedFile>,
) -> Result<Vec<String>, String> {
    let result = files
        .into_iter()
        .enumerate()
        .map(|(index, file)| {
            let path = directory.join(stored_file_name(index, &file.file_name));
            let mut destination = private_file_create(&path)
                .map_err(|error| format!("dropped_file_create_failed: {error}"))?;
            destination
                .write_all(&file.data)
                .map_err(|error| format!("dropped_file_write_failed: {error}"))?;
            destination
                .sync_all()
                .map_err(|error| format!("dropped_file_sync_failed: {error}"))?;
            Ok(path.to_string_lossy().into_owned())
        })
        .collect::<Result<Vec<_>, String>>();

    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    result
}

fn save_local_files(files: Vec<DecodedDroppedFile>) -> Result<Vec<String>, String> {
    let directory = create_owned_drop_directory(&std::env::temp_dir())?;
    write_decoded_files_to_owned_directory(&directory, files)
}

fn validate_publish_file_names(files: &[DecodedDroppedFile]) -> Result<(), String> {
    let mut names = HashSet::with_capacity(files.len());
    for file in files {
        let name = file.file_name.as_str();
        if name == "."
            || name == ".."
            || name.contains('/')
            || name.chars().any(|character| character.is_control())
        {
            return Err(format!("dropped_file_name_invalid: {name:?}"));
        }
        if !names.insert(name) {
            return Err(format!("dropped_file_name_duplicate: {name}"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn paths_refer_to_same_file(first: &Path, second: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(first), fs::metadata(second)) {
        (Ok(first), Ok(second)) => first.dev() == second.dev() && first.ino() == second.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn paths_refer_to_same_file(_first: &Path, _second: &Path) -> bool {
    false
}

fn rollback_published_links(published: &[(PathBuf, PathBuf)]) {
    for (staged, destination) in published.iter().rev() {
        if paths_refer_to_same_file(staged, destination) {
            let _ = fs::remove_file(destination);
        }
    }
}

fn save_files_to_existing_directory(
    directory: &Path,
    files: Vec<DecodedDroppedFile>,
) -> Result<Vec<String>, String> {
    validate_publish_file_names(&files)?;
    let directory = fs::canonicalize(directory)
        .map_err(|error| format!("dropped_files_destination_invalid: {error}"))?;
    if !directory.is_dir() {
        return Err("dropped_files_destination_invalid: destination is not a directory".to_string());
    }

    let staging = create_owned_publish_directory(&directory)?;
    let staged_paths: Vec<PathBuf> = (0..files.len())
        .map(|index| staging.join(index.to_string()))
        .collect();
    let destination_paths: Vec<PathBuf> = files
        .iter()
        .map(|file| directory.join(&file.file_name))
        .collect();

    let staged_result = staged_paths.iter().zip(files).try_for_each(|(path, file)| {
        let mut destination = publish_staging_file_create(path)
            .map_err(|error| format!("dropped_file_create_failed: {error}"))?;
        destination
            .write_all(&file.data)
            .map_err(|error| format!("dropped_file_write_failed: {error}"))?;
        destination
            .sync_all()
            .map_err(|error| format!("dropped_file_sync_failed: {error}"))
    });
    if let Err(error) = staged_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    for path in &destination_paths {
        if fs::symlink_metadata(path).is_ok() {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "dropped_file_destination_exists: {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }

    let mut published = Vec::with_capacity(staged_paths.len());
    for (staged, destination) in staged_paths.iter().zip(&destination_paths) {
        if let Err(error) = fs::hard_link(staged, destination) {
            rollback_published_links(&published);
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("dropped_file_publish_failed: {error}"));
        }
        published.push((staged.clone(), destination.clone()));
    }

    // All destination links now exist. Cleanup is deliberately best-effort from
    // this point: reporting failure after publication would invite a retry that
    // can only collide with the files that were just added. The hidden staging
    // entries are hard links, so removing (or retaining) them cannot change the
    // destination bytes.
    let _ = fs::remove_dir_all(&staging);

    Ok(destination_paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_publish_directory_command(destination: &str) -> String {
    format!(
        "set -eu\ncd {}\nresolved=$(pwd -P)\numask 077\nmktemp -d \"${{resolved%/}}/{REMOTE_PUBLISH_DIRECTORY_PREFIX}XXXXXX\"",
        shell_quote(destination)
    )
}

fn parse_remote_publish_directory(output: &str) -> Result<(String, String), String> {
    parse_remote_directory(output, REMOTE_PUBLISH_DIRECTORY_PREFIX)
}

/// Validates a remote `mktemp -d` result before any path built from it reaches
/// a shell. The name must carry the prefix we asked for and mktemp's exact
/// six-character suffix, so a compromised or confused remote cannot redirect
/// the upload — or a later `rm -rf` — at a directory we did not create.
fn parse_remote_directory(output: &str, prefix: &str) -> Result<(String, String), String> {
    let directory = output.trim();
    if !directory.starts_with('/')
        || directory
            .chars()
            .any(|character| character.is_control())
    {
        return Err("dropped_files_remote_directory_invalid: unsafe path".to_string());
    }
    let path = Path::new(directory);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "dropped_files_remote_directory_invalid: missing name".to_string())?;
    let suffix = name
        .strip_prefix(prefix)
        .ok_or_else(|| "dropped_files_remote_directory_invalid: unexpected name".to_string())?;
    if suffix.len() != 6 || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err("dropped_files_remote_directory_invalid: unsafe suffix".to_string());
    }
    let parent = path
        .parent()
        .and_then(|parent| parent.to_str())
        .filter(|parent| parent.starts_with('/'))
        .ok_or_else(|| "dropped_files_remote_directory_invalid: missing parent".to_string())?;
    Ok((directory.to_string(), parent.to_string()))
}

fn remote_publish_cleanup_command(directory: &str) -> Result<String, String> {
    parse_remote_publish_directory(directory)?;
    Ok(format!("rm -rf {}", shell_quote(directory)))
}

/// A private per-drop directory under the remote `TMPDIR`. Terminal drops name
/// no destination, so unlike a file-tree publish there is nothing to overwrite
/// and no staging/rename dance — `mktemp -d` under `umask 077` already gives an
/// empty directory only this user can read.
fn remote_drop_directory_command() -> String {
    format!(
        "set -eu\numask 077\nmktemp -d \"${{TMPDIR:-/tmp}}/{REMOTE_DROP_DIRECTORY_PREFIX}XXXXXX\"",
    )
}

fn remote_drop_cleanup_command(directory: &str) -> Result<String, String> {
    parse_remote_directory(directory, REMOTE_DROP_DIRECTORY_PREFIX)?;
    Ok(format!("rm -rf {}", shell_quote(directory)))
}

fn remote_publish_paths(
    directory: &str,
    parent: &str,
    files: &[DecodedDroppedFile],
) -> (Vec<String>, Vec<String>) {
    let staged = files
        .iter()
        .enumerate()
        .map(|(index, _)| format!("{directory}/{index}"))
        .collect();
    let destinations = files
        .iter()
        .map(|file| {
            if parent == "/" {
                format!("/{}", file.file_name)
            } else {
                format!("{parent}/{}", file.file_name)
            }
        })
        .collect();
    (staged, destinations)
}

fn remote_publish_command(directory: &str, staged: &[String], destinations: &[String]) -> String {
    let mut command = String::from("set -eu\ncleanup() {\n");
    for (staged, destination) in staged.iter().zip(destinations) {
        command.push_str(&format!(
            "  if [ -e {destination} ] && [ {destination} -ef {staged} ]; then rm -f {destination}; fi\n",
            destination = shell_quote(destination),
            staged = shell_quote(staged),
        ));
    }
    command.push_str(&format!("  rm -rf {}\n}}\ntrap cleanup EXIT\n", shell_quote(directory)));
    for destination in destinations {
        command.push_str(&format!(
            "if [ -e {destination} ] || [ -L {destination} ]; then printf '%s\\n' {message} >&2; exit 73; fi\n",
            destination = shell_quote(destination),
            message = shell_quote(&format!(
                "dropped_file_destination_exists: {}",
                Path::new(destination)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            )),
        ));
    }
    for (staged, destination) in staged.iter().zip(destinations) {
        command.push_str(&format!(
            "ln {staged} {destination}\n",
            staged = shell_quote(staged),
            destination = shell_quote(destination),
        ));
    }
    command.push_str(&format!(
        "trap - EXIT\nrm -rf {} || :",
        shell_quote(directory)
    ));
    command
}

#[tauri::command(async)]
pub(crate) fn save_temp_files(files: Vec<DroppedFilePayload>) -> Result<Vec<String>, String> {
    save_local_files(decode_payloads(files)?)
}

/// Files have already been staged on the pane's bound Host. Its local session
/// owner resolves any inner SSH hop; the desktop never interprets remote PIDs.
#[tauri::command(async)]
pub(crate) fn route_session_files(
    session_id: String,
    workspace_id: String,
    terminal_epoch: String,
    paths: Vec<String>,
    opts: Option<super::ssh::SshOptions>,
) -> Result<Vec<String>, String> {
    if paths.is_empty()
        || paths.len() > MAX_DROPPED_FILES
        || paths
            .iter()
            .any(|path| path.len() > 4096 || path.chars().any(char::is_control))
    {
        return Err("session_file_paths_invalid".into());
    }
    if let Some(opts) = opts {
        if opts.host_key_fingerprints.is_empty() {
            return Err("session_file_host_untrusted".into());
        }
        let capabilities =
            super::ssh::exec_once(&opts, "exec \"$HOME/.local/bin/hmux\" --json capabilities")?;
        let supported = serde_json::from_str::<serde_json::Value>(&capabilities.stdout)
            .ok()
            .and_then(|value| {
                value
                    .get("capabilities")
                    .and_then(|value| value.as_array())
                    .cloned()
            })
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|value| value.as_str() == Some(hmux_client::SESSION_FILE_ROUTE_CAPABILITY))
            });
        if capabilities.code != 0 || !supported {
            return Err("session_file_remote_update_required".into());
        }
        let command = format!(
            "exec \"$HOME/.local/bin/hmux\" --json session route-files {} --workspace {} --terminal-epoch {} --paths-json {}",
            shell_quote(&session_id), shell_quote(&workspace_id), shell_quote(&terminal_epoch),
            shell_quote(&serde_json::to_string(&paths).map_err(|e| e.to_string())?),
        );
        let result = super::ssh::exec_once_with_timeout(
            &opts,
            &command,
            std::time::Duration::from_secs(330),
        )?;
        if result.code != 0 {
            return Err(format!(
                "session_file_remote_route_failed: {}",
                result.stderr.trim()
            ));
        }
        return serde_json::from_str(&result.stdout)
            .map_err(|e| format!("session_file_remote_route_invalid: {e}"));
    }
    #[cfg(unix)]
    {
        let catalog =
            hmux_client::LocalSessionCatalog::from_environment().map_err(|e| e.to_string())?;
        hmux_client::session_files::route_files(
            &catalog,
            &hmux_client::SessionSelector::new(session_id, Some(workspace_id)),
            &terminal_epoch,
            paths,
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (session_id, workspace_id, terminal_epoch);
        Ok(paths)
    }
}

#[tauri::command(async)]
pub(crate) fn save_files_to_directory(
    directory: String,
    files: Vec<DroppedFilePayload>,
) -> Result<Vec<String>, String> {
    save_files_to_existing_directory(Path::new(&directory), decode_payloads(files)?)
}

#[tauri::command(async)]
pub(crate) fn save_temp_file(data_b64: String, file_name: String) -> Result<String, String> {
    let mut paths = save_temp_files(vec![DroppedFilePayload {
        data_b64,
        file_name,
    }])?;
    paths
        .pop()
        .ok_or_else(|| "dropped_files_empty_result: no path was created".to_string())
}

#[tauri::command(async)]
pub(crate) fn ssh_upload_files_to_directory(
    opts: super::ssh::SshOptions,
    directory: String,
    files: Vec<DroppedFilePayload>,
) -> Result<Vec<String>, String> {
    let decoded = decode_payloads(files)?;
    validate_publish_file_names(&decoded)?;
    let session = super::ssh::acquire(&opts)?;
    let created = super::ssh::exec_on(&session, &remote_publish_directory_command(&directory))?;
    if created.code != 0 {
        return Err(format!(
            "dropped_files_remote_directory_create_failed: {}",
            created.stderr.trim()
        ));
    }
    let (staging, parent) = parse_remote_publish_directory(&created.stdout)?;
    let cleanup = remote_publish_cleanup_command(&staging)?;
    let (staged_paths, destination_paths) = remote_publish_paths(&staging, &parent, &decoded);

    for (path, file) in staged_paths.iter().zip(&decoded) {
        match super::ssh::upload_on(&session, path, &file.data) {
            Ok(uploaded) if uploaded == *path => {}
            Ok(_) => {
                let _ = super::ssh::exec_on(&session, &cleanup);
                return Err(
                    "dropped_files_remote_path_mismatch: upload returned another path".to_string(),
                );
            }
            Err(error) => {
                let _ = super::ssh::exec_on(&session, &cleanup);
                return Err(error);
            }
        }
    }

    let published = super::ssh::exec_on(
        &session,
        &remote_publish_command(&staging, &staged_paths, &destination_paths),
    )?;
    if published.code != 0 {
        let _ = super::ssh::exec_on(&session, &cleanup);
        return Err(format!(
            "dropped_files_remote_publish_failed: {}",
            published.stderr.trim()
        ));
    }
    Ok(destination_paths)
}

/// Uploads terminal-dropped files to a fresh private directory on the remote
/// host and returns their absolute paths, over one connection.
///
/// This is the remote half of a terminal file drop. The retired interactive
/// SSH session daemon used to own it; keying on connect options instead means
/// an hmux remote pane can use it without a live legacy session.
#[tauri::command(async)]
pub(crate) fn ssh_upload_files_to_temp_directory(
    opts: super::ssh::SshOptions,
    files: Vec<DroppedFilePayload>,
) -> Result<Vec<String>, String> {
    let decoded = decode_payloads(files)?;
    validate_publish_file_names(&decoded)?;
    let session = super::ssh::acquire(&opts)?;
    let created = super::ssh::exec_on(&session, &remote_drop_directory_command())?;
    if created.code != 0 {
        return Err(format!(
            "dropped_files_remote_directory_create_failed: {}",
            created.stderr.trim()
        ));
    }
    let (directory, _) = parse_remote_directory(&created.stdout, REMOTE_DROP_DIRECTORY_PREFIX)?;
    let cleanup = remote_drop_cleanup_command(&directory)?;
    let paths: Vec<String> = decoded
        .iter()
        .map(|file| format!("{directory}/{}", file.file_name))
        .collect();

    for (path, file) in paths.iter().zip(&decoded) {
        match super::ssh::upload_on(&session, path, &file.data) {
            Ok(uploaded) if uploaded == *path => {}
            Ok(_) => {
                let _ = super::ssh::exec_on(&session, &cleanup);
                return Err(
                    "dropped_files_remote_path_mismatch: upload returned another path".to_string(),
                );
            }
            Err(error) => {
                let _ = super::ssh::exec_on(&session, &cleanup);
                return Err(error);
            }
        }
    }

    Ok(paths)
}

/// Quick-dispatch intent identifiers are filesystem path segments, so they
/// are restricted to a safe character set with no `.`/`/` — this rejects
/// traversal (`../x`) and empty values before the id ever reaches a path.
fn valid_intent_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// Persists quick-dispatch attachments under `<app_root>/quick-dispatch/<intentId>/`
/// before the intent record is journaled, so the delivered prompt can reference
/// them by absolute path. Uses `app_home::app_root_resolution` (not `spawn_dir`'s
/// HOME-only derivation) so a `DURE_HOME` override is honored.
#[tauri::command(async)]
pub(crate) fn save_quick_dispatch_attachments(
    intent_id: String,
    files: Vec<DroppedFilePayload>,
) -> Result<Vec<String>, String> {
    if !valid_intent_id(&intent_id) {
        return Err("quick_dispatch_intent_id_invalid".to_string());
    }
    let (root, _) = crate::app_home::app_root_resolution()?;
    let dir = root.join("quick-dispatch").join(&intent_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    save_files_to_existing_directory(&dir, decode_payloads(files)?)
}

/// Persists chat-composer attachments under
/// `<app_root>/chat-attachments/<interactionSessionId>/` before the message
/// is sent, so the delivered text can reference them by absolute path — the
/// same file-reference contract quick dispatch uses (both provider CLIs read
/// image files by path). The id shares the intent-id character policy, which
/// rejects traversal before the value ever reaches a path.
#[tauri::command(async)]
pub(crate) fn save_chat_attachments(
    interaction_session_id: String,
    files: Vec<DroppedFilePayload>,
) -> Result<Vec<String>, String> {
    if !valid_intent_id(&interaction_session_id) {
        return Err("chat_attachment_session_id_invalid".to_string());
    }
    let (root, _) = crate::app_home::app_root_resolution()?;
    let dir = root.join("chat-attachments").join(&interaction_session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    save_files_to_existing_directory(&dir, decode_payloads(files)?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatAttachmentImage {
    mime: String,
    data_b64: String,
}

/// Reads back one saved chat attachment so the timeline can render the image
/// the delivered prompt references by path. The webview never gets raw
/// filesystem access: this resolves only inside `<app_root>/chat-attachments/`
/// (canonicalized, so symlinks and traversal cannot escape), only for image
/// extensions the composer saves, and only up to the drop size cap.
#[tauri::command(async)]
pub(crate) fn read_chat_attachment(path: String) -> Result<ChatAttachmentImage, String> {
    let (root, _) = crate::app_home::app_root_resolution()?;
    read_chat_attachment_under(&root.join("chat-attachments"), Path::new(&path))
}

fn read_chat_attachment_under(
    attachments_root: &Path,
    requested: &Path,
) -> Result<ChatAttachmentImage, String> {
    if !requested.is_absolute() {
        return Err("chat_attachment_path_invalid".to_string());
    }
    let mime = match requested
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => return Err("chat_attachment_not_an_image".to_string()),
    };
    let canonical_root = attachments_root
        .canonicalize()
        .map_err(|_| "chat_attachment_missing".to_string())?;
    let canonical = requested
        .canonicalize()
        .map_err(|_| "chat_attachment_missing".to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("chat_attachment_outside_root".to_string());
    }
    let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_DROPPED_BYTES as u64 {
        return Err("chat_attachment_unreadable".to_string());
    }
    let bytes = fs::read(&canonical).map_err(|e| e.to_string())?;
    Ok(ChatAttachmentImage {
        mime: mime.to_string(),
        data_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(name: &str, data: &[u8]) -> DroppedFilePayload {
        DroppedFilePayload {
            data_b64: base64::engine::general_purpose::STANDARD.encode(data),
            file_name: name.to_string(),
        }
    }

    #[test]
    fn rejects_count_and_combined_size_before_file_creation() {
        let six = (0..6)
            .map(|index| payload(&format!("{index}.txt"), b"x"))
            .collect();
        assert!(decode_payloads_with_limits(six, 5, 10)
            .unwrap_err()
            .starts_with("dropped_files_count_limit:"));

        let oversized = vec![payload("one", b"abc"), payload("two", b"de")];
        assert!(decode_payloads_with_limits(oversized, 5, 4)
            .unwrap_err()
            .starts_with("dropped_files_total_limit:"));
    }

    #[test]
    fn rejects_invalid_base64_and_unbounded_file_names() {
        let invalid = DroppedFilePayload {
            data_b64: "%%%".to_string(),
            file_name: "a.txt".to_string(),
        };
        assert!(decode_payloads(vec![invalid])
            .unwrap_err()
            .starts_with("dropped_file_base64_invalid:"));

        let long_name = payload(&"a".repeat(MAX_FILE_NAME_BYTES + 1), b"x");
        assert!(decode_payloads(vec![long_name])
            .unwrap_err()
            .starts_with("dropped_file_name_invalid:"));
    }

    #[test]
    fn attachment_read_stays_inside_the_attachments_root() {
        let root = tempfile::tempdir().unwrap();
        let attachments = root.path().join("chat-attachments");
        fs::create_dir_all(attachments.join("session-1")).unwrap();
        fs::write(attachments.join("session-1/1-shot.png"), b"png-bytes").unwrap();
        fs::write(root.path().join("outside.png"), b"secret").unwrap();
        fs::write(attachments.join("session-1/notes.txt"), b"text").unwrap();

        let image =
            read_chat_attachment_under(&attachments, &attachments.join("session-1/1-shot.png"))
                .unwrap();
        assert_eq!(image.mime, "image/png");
        assert_eq!(
            image.data_b64,
            base64::engine::general_purpose::STANDARD.encode(b"png-bytes")
        );

        assert_eq!(
            read_chat_attachment_under(&attachments, &root.path().join("outside.png"))
                .unwrap_err(),
            "chat_attachment_outside_root"
        );
        assert_eq!(
            read_chat_attachment_under(
                &attachments,
                &attachments.join("session-1/../../outside.png"),
            )
            .unwrap_err(),
            "chat_attachment_outside_root"
        );
        assert_eq!(
            read_chat_attachment_under(&attachments, &attachments.join("session-1/notes.txt"))
                .unwrap_err(),
            "chat_attachment_not_an_image"
        );
        assert_eq!(
            read_chat_attachment_under(&attachments, Path::new("relative.png")).unwrap_err(),
            "chat_attachment_path_invalid"
        );
    }

    #[test]
    fn safe_names_preserve_unicode_and_remove_path_or_shell_syntax() {
        assert_eq!(
            stored_file_name(2, "../hello world-한글'$(x).txt"),
            "2-.._hello_world-한글___x_.txt"
        );
    }

    #[test]
    fn local_batch_is_private_and_rolls_back_after_a_late_failure() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("owned");
        private_directory_create(&directory).unwrap();
        fs::create_dir(directory.join(stored_file_name(1, "second.txt"))).unwrap();
        let files = vec![
            DecodedDroppedFile {
                data: b"first".to_vec(),
                file_name: "first.txt".to_string(),
            },
            DecodedDroppedFile {
                data: b"second".to_vec(),
                file_name: "second.txt".to_string(),
            },
        ];

        assert!(write_decoded_files_to_owned_directory(&directory, files).is_err());
        assert!(!directory.exists());
    }

    #[test]
    fn local_batch_keeps_order_and_distinct_duplicate_names() {
        let root = tempfile::tempdir().unwrap();
        let directory = create_owned_drop_directory(root.path()).unwrap();
        let files = vec![
            DecodedDroppedFile {
                data: b"first".to_vec(),
                file_name: "same name.txt".to_string(),
            },
            DecodedDroppedFile {
                data: b"second".to_vec(),
                file_name: "same name.txt".to_string(),
            },
        ];

        let paths = write_decoded_files_to_owned_directory(&directory, files).unwrap();
        assert_eq!(fs::read(&paths[0]).unwrap(), b"first");
        assert_eq!(fs::read(&paths[1]).unwrap(), b"second");
        assert_ne!(paths[0], paths[1]);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&paths[0]).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn publish_names_preserve_unicode_but_reject_paths_controls_and_duplicates() {
        let valid = vec![DecodedDroppedFile {
            data: vec![],
            file_name: "hello world-한글's.txt".to_string(),
        }];
        assert!(validate_publish_file_names(&valid).is_ok());

        for invalid in ["../secret", "nested/file", "line\nbreak"] {
            let files = vec![DecodedDroppedFile {
                data: vec![],
                file_name: invalid.to_string(),
            }];
            assert!(validate_publish_file_names(&files).is_err());
        }

        let duplicates = vec![
            DecodedDroppedFile { data: vec![], file_name: "same".to_string() },
            DecodedDroppedFile { data: vec![], file_name: "same".to_string() },
        ];
        assert!(validate_publish_file_names(&duplicates).is_err());
    }

    #[test]
    fn local_publish_keeps_exact_names_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let existing = root.path().join("existing.txt");
        fs::write(&existing, b"original").unwrap();
        let conflict = vec![DecodedDroppedFile {
            data: b"replacement".to_vec(),
            file_name: "existing.txt".to_string(),
        }];

        assert!(save_files_to_existing_directory(root.path(), conflict).is_err());
        assert_eq!(fs::read(&existing).unwrap(), b"original");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);

        let files = vec![
            DecodedDroppedFile {
                data: b"first".to_vec(),
                file_name: "hello world.txt".to_string(),
            },
            DecodedDroppedFile {
                data: b"second".to_vec(),
                file_name: "한글's.txt".to_string(),
            },
        ];
        let paths = save_files_to_existing_directory(root.path(), files).unwrap();
        assert_eq!(fs::read(&paths[0]).unwrap(), b"first");
        assert_eq!(fs::read(&paths[1]).unwrap(), b"second");
        assert!(fs::read_dir(root.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(PUBLISH_DIRECTORY_PREFIX)));
    }

    #[test]
    fn remote_publish_directory_and_command_are_bounded_and_no_clobber() {
        let (directory, parent) =
            parse_remote_publish_directory("/srv/repo/.dure-file-drop.aB123z\n").unwrap();
        assert_eq!(parent, "/srv/repo");
        let files = vec![DecodedDroppedFile {
            data: vec![],
            file_name: "a file's.txt".to_string(),
        }];
        let (staged, destinations) = remote_publish_paths(&directory, &parent, &files);
        let command = remote_publish_command(&directory, &staged, &destinations);
        assert!(command.contains("dropped_file_destination_exists: a file"));
        assert!(command.contains("ln '/srv/repo/.dure-file-drop.aB123z/0'"));
        assert!(command.contains("-ef"));
        assert_eq!(
            remote_publish_cleanup_command(&directory).unwrap(),
            "rm -rf '/srv/repo/.dure-file-drop.aB123z'"
        );
        assert!(parse_remote_publish_directory("/tmp/not-owned.abcdef").is_err());

        let (root_staged, root_destinations) =
            remote_publish_paths("/.dure-file-drop.aB123z", "/", &files);
        assert_eq!(root_staged[0], "/.dure-file-drop.aB123z/0");
        assert_eq!(root_destinations[0], "/a file's.txt");
        assert!(remote_publish_command(&directory, &staged, &destinations)
            .ends_with("rm -rf '/srv/repo/.dure-file-drop.aB123z' || :"));
    }

    #[test]
    fn remote_drop_directory_is_private_per_drop_and_cleanup_stays_inside_it() {
        let command = remote_drop_directory_command();
        assert!(command.contains("umask 077"));
        assert!(command.contains("${TMPDIR:-/tmp}/dure-drop.XXXXXX"));

        let (directory, _) =
            parse_remote_directory("/tmp/dure-drop.aB123z\n", REMOTE_DROP_DIRECTORY_PREFIX).unwrap();
        assert_eq!(directory, "/tmp/dure-drop.aB123z");
        assert_eq!(
            remote_drop_cleanup_command(&directory).unwrap(),
            "rm -rf '/tmp/dure-drop.aB123z'"
        );

        // A remote that answers with anything but our own mktemp result must not
        // become an upload target — or, worse, an `rm -rf` target.
        for hostile in [
            "/tmp/dure-drop.aB123",
            "/tmp/dure-drop.aB123zz",
            "/tmp/dure-drop.aB12-z",
            "/tmp/someone-elses-dir",
            "relative/dure-drop.aB123z",
            "/tmp/.dure-file-drop.aB123z",
        ] {
            assert!(
                parse_remote_directory(hostile, REMOTE_DROP_DIRECTORY_PREFIX).is_err(),
                "{hostile} must be rejected"
            );
            assert!(remote_drop_cleanup_command(hostile).is_err());
        }
    }

    #[test]
    fn quick_dispatch_intent_id_rejects_traversal_and_empty_but_accepts_generated_ids() {
        assert!(!valid_intent_id(""));
        assert!(!valid_intent_id("../x"));
        assert!(!valid_intent_id("a/b"));
        assert!(!valid_intent_id(&"a".repeat(65)));
        assert!(valid_intent_id(&"a".repeat(64)));
        assert!(valid_intent_id("qd_abcdef0123456789abcdef0123456789"));
    }

    // `app_root_resolution` reads `DURE_HOME` from the process environment, which
    // is process-global state. Serialize mutation with a lock (mirroring the
    // `ScopedEnvironment` RAII pattern in hmux/controller.rs) so a parallel test
    // run can never observe or clobber another test's override, and restore the
    // previous value on drop regardless of test outcome.
    struct ScopedDureHome {
        previous: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl ScopedDureHome {
        fn set(value: &Path) -> Self {
            let guard = crate::app_home::ENVIRONMENT_TEST_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::env::var_os("DURE_HOME");
            std::env::set_var("DURE_HOME", value);
            Self {
                previous,
                _guard: guard,
            }
        }
    }

    impl Drop for ScopedDureHome {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => std::env::set_var("DURE_HOME", previous),
                None => std::env::remove_var("DURE_HOME"),
            }
        }
    }

    #[test]
    fn save_quick_dispatch_attachments_honors_dure_home_override_and_round_trips() {
        let temporary = tempfile::tempdir().unwrap();
        let _scoped = ScopedDureHome::set(temporary.path());

        let paths = save_quick_dispatch_attachments(
            "qd_test-intent".to_string(),
            vec![payload("note.txt", b"hello attachment")],
        )
        .unwrap();

        assert_eq!(paths.len(), 1);
        let saved = Path::new(&paths[0]);
        // `DURE_HOME` is the override root directly (not `<override>/.dure`),
        // matching `app_root_resolution`'s `AppRootSource::EnvOverride` branch.
        // Canonicalize the expected prefix too: on macOS the tempdir root lives
        // under a `/var` -> `/private/var` symlink, and the destination path
        // returned by `save_files_to_existing_directory` is already canonical.
        let expected_prefix = fs::canonicalize(temporary.path())
            .unwrap()
            .join("quick-dispatch")
            .join("qd_test-intent");
        assert!(saved.starts_with(&expected_prefix));
        assert_eq!(fs::read(saved).unwrap(), b"hello attachment");
    }

    #[test]
    fn save_quick_dispatch_attachments_rejects_invalid_intent_id_before_touching_disk() {
        let temporary = tempfile::tempdir().unwrap();
        let _scoped = ScopedDureHome::set(temporary.path());

        let error = save_quick_dispatch_attachments(
            "../escape".to_string(),
            vec![payload("note.txt", b"x")],
        )
        .unwrap_err();
        assert_eq!(error, "quick_dispatch_intent_id_invalid");
        assert!(!temporary.path().join("quick-dispatch").exists());
    }
}
