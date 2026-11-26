//! Per-launch Claude auto-memory settings, separate from credential profiles.
//!
//! `autoMemoryDirectory` is the supported Claude setting (including --settings):
//! https://code.claude.com/docs/en/memory#storage-location
//! Never put it in the shared account settings: concurrent projects need different
//! directories. One directory per project serves every Dure-managed account, so
//! an account switch keeps the conversation's notes. Earlier per-account and
//! legacy notes are merged in once, with every original retained.

use super::{
    create_or_require_owned_directory, lock_profile, require_owned_real_directory, typed_error,
    unique_sidecar_path,
};
use hmux_runtime_contract::ProviderStateEnvironment;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TREE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

fn error(detail: &str) -> String {
    typed_error("claude_memory_unavailable", detail)
}

fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| error("cannot open memory or settings file"))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("cannot inspect memory or settings file"))?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.len() > MAX_FILE_BYTES
    {
        return Err(error(
            "memory and settings must be bounded, owned, single-link files",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("cannot read memory or settings file"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(error("file exceeds memory limit"));
    }
    let after = file
        .metadata()
        .map_err(|_| error("cannot recheck memory or settings file"))?;
    if super::FileGeneration::from(&metadata) != super::FileGeneration::from(&after)
        || bytes.len() as u64 != metadata.len()
    {
        return Err(error(
            "memory or settings changed during preparation; retry launch",
        ));
    }
    Ok(bytes)
}

fn settings(value: &str) -> Result<Map<String, Value>, String> {
    let bytes = if value.trim_start().starts_with('{') {
        value.as_bytes().to_vec()
    } else {
        read_regular(Path::new(value))?
    };
    if generated_settings_path(value)
        && Path::new(value).file_name().and_then(|name| name.to_str())
            != Some(format!("{:x}.json", Sha256::digest(&bytes)).as_str())
    {
        return Err(error("published Claude memory settings changed"));
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| error("Claude launch settings must be a JSON object"))
}

// Claude Agent SDK 0.3.234 project-key contract: ASCII sanitization over JS
// UTF-16 units, and a base-36 absolute signed 32-bit hash above 200 units.
// Keep this only for locating old notes; new identities use SHA-256.
fn legacy_project_key(path: &str) -> String {
    let mut hash = 0_i32;
    let mut slug = String::new();
    for unit in path.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
        slug.push(if unit < 128 && (unit as u8).is_ascii_alphanumeric() {
            unit as u8 as char
        } else {
            '-'
        });
    }
    if slug.len() > 200 {
        slug.truncate(200);
        let mut hash = hash.unsigned_abs();
        let mut digits = Vec::new();
        loop {
            digits.push(char::from_digit(hash % 36, 36).unwrap());
            hash /= 36;
            if hash == 0 {
                break;
            }
        }
        slug.push('-');
        slug.extend(digits.iter().rev());
    }
    slug
}

fn project_paths(cwd: &Path) -> Result<(PathBuf, PathBuf), String> {
    let cwd = cwd
        .canonicalize()
        .map_err(|_| error("project directory is unavailable"))?;
    if !cwd.is_dir() {
        return Err(error("project must be a directory"));
    }
    // Avoid interpreting a missing/broken Git executable as a different identity.
    if !cwd.ancestors().any(|path| path.join(".git").exists()) {
        return Ok((cwd.clone(), cwd));
    }
    let checkout = dure_git_checkout::locate_checkout(&cwd)
        .map_err(|_| error("cannot resolve repository memory identity"))?;
    let common = PathBuf::from(checkout.git_common_dir);
    let legacy = if common.file_name().is_some_and(|name| name == ".git") {
        common
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| error("repository memory identity has no parent"))?
    } else {
        PathBuf::from(checkout.canonical_path)
    };
    Ok((common, legacy))
}

fn create_note(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| error("cannot create migrated memory note"))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|_| error("cannot save migrated memory note"))
}

/// Copy the notes `source` has that `destination` lacks. A note already in
/// `destination` is kept; when its contents differ, it is added to `differing`.
fn copy_notes(
    source: &Path,
    destination: &Path,
    entries: &mut usize,
    bytes: &mut u64,
    depth: usize,
    differing: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > 32 {
        return Err(error("memory directory is too deep"));
    }
    require_owned_real_directory(source, "earlier memory")?;
    for entry in fs::read_dir(source).map_err(|_| error("cannot read earlier memory"))? {
        let entry = entry.map_err(|_| error("cannot inspect earlier memory"))?;
        *entries += 1;
        if *entries > MAX_ENTRIES {
            return Err(error("too many earlier memory entries"));
        }
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let metadata =
            fs::symlink_metadata(&from).map_err(|_| error("cannot inspect earlier note"))?;
        if metadata.file_type().is_symlink() {
            return Err(error("earlier memory contains a symlink"));
        }
        let kept = match fs::symlink_metadata(&to) {
            Ok(kept) => Some(kept.is_dir()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(error("cannot inspect merged memory")),
        };
        if metadata.is_dir() {
            if kept == Some(false) {
                differing.push(to);
                continue;
            }
            create_or_require_owned_directory(&to, "memory topic directory", 0o700)?;
            copy_notes(&from, &to, entries, bytes, depth + 1, differing)?;
        } else {
            let contents = read_regular(&from)?;
            *bytes += contents.len() as u64;
            if *bytes > MAX_TREE_BYTES {
                return Err(error("earlier memory exceeds copy limit"));
            }
            match kept {
                None => create_note(&to, &contents)?,
                Some(true) => differing.push(to),
                Some(false) if read_regular(&to)? != contents => differing.push(to),
                Some(false) => {}
            }
        }
    }
    Ok(())
}

const MERGE_NOTE: &str = "dure-merged-account-memory.md";

/// Leave the merge where Claude reads it: a note listing the retained folders
/// and the files whose other versions were not copied, linked from MEMORY.md.
fn write_merge_note(stage: &Path, sources: &[(PathBuf, Vec<PathBuf>)]) -> Result<(), String> {
    let mut note = String::from(
        "# Merged account memory\n\n\
         Dure now keeps one Claude memory folder per project, shared by every \
         Dure-managed account. This folder was built once from the earlier \
         folders below, in this order. A file copied from an earlier folder was \
         kept, so the other versions of the files listed after a folder were not \
         copied. Every earlier folder is still in place, unchanged.\n\n",
    );
    for (index, (source, differing)) in sources.iter().enumerate() {
        note.push_str(&format!("{}. `{}`", index + 1, source.display()));
        if !differing.is_empty() {
            let mut names: Vec<_> = differing
                .iter()
                .filter_map(|path| path.strip_prefix(stage).ok())
                .map(|path| format!("`{}`", path.display()))
                .collect();
            names.sort();
            note.push_str(&format!(" — differs: {}", names.join(", ")));
        }
        note.push('\n');
    }
    note.push_str(
        "\nCopy anything still needed from those versions into this folder, then \
         delete this file and its line in `MEMORY.md`.\n",
    );
    let index_path = stage.join("MEMORY.md");
    let mut index = match fs::symlink_metadata(&index_path) {
        Ok(_) => read_regular(&index_path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err(error("cannot inspect merged memory index")),
    };
    if index.last().is_some_and(|byte| *byte != b'\n') {
        index.push(b'\n');
    }
    index.extend_from_slice(
        format!(
            "- [Merged account memory]({MERGE_NOTE}) — earlier per-account notes to reconcile\n"
        )
        .as_bytes(),
    );
    // Both paths are copies in the private staging directory, never originals.
    for (path, contents) in [
        (stage.join(MERGE_NOTE), note.into_bytes()),
        (index_path, index),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(_) => fs::remove_file(&path).map_err(|_| error("cannot update merged memory"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("cannot inspect merged memory")),
        }
        create_note(&path, &contents)?;
    }
    Ok(())
}

/// The config directory comes from the existing, authorized account launch
/// environment, never from a renderer-selected memory path. Every managed
/// account resolves the same project to `~/.dure/memories/claude/<project>`.
/// Provider-default launches retain Claude's native memory configuration.
pub fn prepare_directory(
    home: &Path,
    config: Option<&Path>,
    cwd: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(config) = config else {
        return Ok(None);
    };
    // SDK embedders may supply their own config directory; only Dure account
    // profiles participate in this migration.
    if config
        .parent()
        .and_then(Path::file_name)
        .is_none_or(|name| name != "accounts")
        || config
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| !name.starts_with("claude-"))
    {
        return Ok(None);
    }
    let profile = require_owned_real_directory(config, "Claude profile")?;
    let accounts = profile
        .parent()
        .ok_or_else(|| error("profile has no account root"))?;
    let name = profile
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with("claude-"))
        .ok_or_else(|| error("profile is not a managed Claude account"))?;
    if accounts.file_name().is_none_or(|name| name != "accounts") {
        return Err(error("profile is not in an account root"));
    }
    require_owned_real_directory(accounts, "account root")?;
    let dure = require_owned_real_directory(
        accounts
            .parent()
            .ok_or_else(|| error("missing Dure root"))?,
        "Dure root",
    )?;
    // Explicit user memory settings remain authoritative. Redirecting them
    // would hide existing custom notes or undo deliberate sharing. This fix
    // replaces only the provider's implicit config-directory default.
    // Observe explicit project choices without copying them into a trusted
    // launch setting. Claude still owns workspace trust and scope precedence.
    let project_settings = cwd.join(".claude");
    for path in [&profile, &project_settings]
        .into_iter()
        .flat_map(|root| ["settings.json", "settings.local.json"].map(|file| root.join(file)))
    {
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let document: Value = serde_json::from_slice(&read_regular(&path)?)
                    .map_err(|_| error("Claude user settings are invalid"))?;
                if document
                    .get("autoMemoryDirectory")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
                {
                    return Ok(None);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("cannot inspect Claude user settings")),
        }
    }
    let (identity, project) = project_paths(cwd)?;
    let project_text = project
        .to_str()
        .ok_or_else(|| error("project path is not UTF-8"))?;
    let key = format!(
        "{:x}",
        Sha256::digest(identity.as_os_str().as_encoded_bytes())
    );
    // One lock and one directory per project for every managed account.
    let _lock = lock_profile(accounts, &format!("memory-claude-{key}"))?;
    let mut root = dure;
    for component in ["memories", "claude"] {
        root =
            create_or_require_owned_directory(&root.join(component), "Claude memory root", 0o700)?;
    }
    let destination = root.join(&key);
    let marker = root.join(format!(".dure-memory-imported-{key}"));
    let imported_before = imported(&marker)?;
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            let directory = require_owned_real_directory(&destination, "Claude memory")?;
            publish_private_file(&marker, b"1\n")?;
            return Ok(Some(directory));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error("cannot inspect memory destination")),
    }
    let stage = unique_sidecar_path(&destination, "memory")?;
    create_or_require_owned_directory(&stage, "memory staging directory", 0o700)?;
    let result = (|| {
        // Clearing the shared directory must not resurrect the retained copies.
        if !imported_before {
            let mut sources = Vec::new();
            for source in earlier_memory(home, &profile, &root, name, &key, project_text)? {
                let mut differing = Vec::new();
                copy_notes(&source, &stage, &mut 0, &mut 0, 0, &mut differing)?;
                sources.push((source, differing));
            }
            if sources.len() > 1 {
                write_merge_note(&stage, &sources)?;
            }
        }
        fs::rename(&stage, &destination).map_err(|_| error("cannot publish memory directory"))?;
        super::sync_parent_directory(&destination)?;
        publish_private_file(&marker, b"1\n")?;
        Ok(Some(destination))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

fn imported(marker: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(marker) {
        Ok(_) if read_regular(marker)? == b"1\n" => Ok(true),
        Ok(_) => Err(error("memory import marker changed")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(error("cannot inspect memory import marker")),
    }
}

/// The folders notes come from on first preparation, in precedence order: the
/// launching account's own notes, then every other account's per-account
/// folder. An account's own notes are its per-account folder, or, before it
/// had one, the legacy Claude project memory it has not imported yet.
fn earlier_memory(
    home: &Path,
    profile: &Path,
    root: &Path,
    name: &str,
    key: &str,
    project_text: &str,
) -> Result<Vec<PathBuf>, String> {
    let account_folder = |account: &str| -> Result<Option<PathBuf>, String> {
        let account = root.join(account);
        match fs::symlink_metadata(&account) {
            Ok(_) => require_owned_real_directory(&account, "account memory root")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(error("cannot inspect account memory root")),
        };
        let folder = account.join(key);
        match fs::symlink_metadata(&folder) {
            Ok(_) => require_owned_real_directory(&folder, "account memory").map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(error("cannot inspect account memory")),
        }
    };
    let mut sources = Vec::new();
    match account_folder(name)? {
        Some(own) => sources.push(own),
        None if !imported(&profile.join(format!(".dure-memory-imported-{key}")))? => {
            sources.extend(legacy_memory(home, profile, project_text)?);
        }
        None => {}
    }
    let mut others = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| error("cannot read Claude memory root"))? {
        let entry = entry.map_err(|_| error("cannot inspect Claude memory root"))?;
        let Some(account) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if account.starts_with("claude-") && account != name {
            others.push(account);
        }
    }
    others.sort();
    for account in others {
        sources.extend(account_folder(&account)?);
    }
    Ok(sources)
}

fn legacy_memory(
    home: &Path,
    profile: &Path,
    project_text: &str,
) -> Result<Option<PathBuf>, String> {
    // `projects` is a reviewed profile overlay link. Accept only that exact
    // canonical target, or an old profile-local directory, before reading notes.
    let projects = profile.join("projects");
    if fs::symlink_metadata(&projects).is_ok() {
        let metadata =
            fs::symlink_metadata(&projects).map_err(|_| error("cannot inspect projects"))?;
        if metadata.file_type().is_symlink() {
            let canonical = home
                .join(".claude/projects")
                .canonicalize()
                .map_err(|_| error("canonical Claude projects are unavailable"))?;
            if projects.canonicalize().ok().as_ref() != Some(&canonical) {
                return Err(error("profile projects link is not the reviewed target"));
            }
        } else {
            require_owned_real_directory(&projects, "Claude projects")?;
        }
    }
    let legacy_project = projects.join(legacy_project_key(project_text));
    match fs::symlink_metadata(&legacy_project) {
        Ok(_) => {
            require_owned_real_directory(&legacy_project, "legacy Claude project")?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error("cannot inspect legacy project")),
    }
    let source = legacy_project.join("memory");
    match fs::symlink_metadata(&source) {
        Ok(_) => require_owned_real_directory(&source, "legacy memory").map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error("cannot inspect legacy memory")),
    }
}

fn publish_settings(config: &Path, document: &Map<String, Value>) -> Result<String, String> {
    let profile = require_owned_real_directory(config, "Claude profile")?;
    let name = profile
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| error("invalid profile name"))?;
    let _lock = lock_profile(
        profile
            .parent()
            .ok_or_else(|| error("missing account root"))?,
        &format!("{name}-memory-settings"),
    )?;
    let root = create_or_require_owned_directory(
        &profile.join(".dure-memory-settings"),
        "Claude launch settings",
        0o700,
    )?;
    let bytes =
        serde_json::to_vec(document).map_err(|_| error("cannot serialize memory settings"))?;
    let path = root.join(format!("{:x}.json", Sha256::digest(&bytes)));
    publish_private_file(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

fn publish_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.mode() & 0o077 != 0 || read_regular(path)? != bytes {
                return Err(error("published Claude memory settings changed"));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut transaction = super::OverlayTransaction::default();
            let mut fault = super::FaultInjection {
                fail_after: None,
                mutations: 0,
            };
            super::atomic_replace_regular_file(
                path,
                &mut transaction,
                &mut fault,
                |file| {
                    file.write_all(bytes)
                        .map_err(|_| error("cannot publish memory settings"))
                },
                || Ok(()),
            )?;
            transaction.commit()?;
        }
        Err(_) => return Err(error("cannot inspect published memory settings")),
    }
    Ok(())
}

fn generated_settings_path(value: &str) -> bool {
    let Some(directory) = Path::new(value).parent() else {
        return false;
    };
    directory
        .file_name()
        .is_some_and(|name| name == ".dure-memory-settings")
        && directory
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("claude-"))
        && directory
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|name| name == "accounts")
}

/// Compose the existing hooks/settings with the per-project setting. One
/// --settings value avoids last-flag-wins loss of the managed lifecycle hooks.
pub fn prepare_arguments(
    home: &Path,
    environment: &ProviderStateEnvironment,
    cwd: &Path,
    arguments: &[String],
) -> Result<Vec<String>, String> {
    let Some(config) = environment.values().get("CLAUDE_CONFIG_DIR").map(Path::new) else {
        return Ok(arguments.to_vec());
    };
    // Existing explicit flag settings have the same authority as user settings.
    for pair in arguments.windows(2).filter(|pair| pair[0] == "--settings") {
        if !generated_settings_path(&pair[1])
            && settings(&pair[1])?
                .get("autoMemoryDirectory")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        {
            return Ok(arguments.to_vec());
        }
    }
    let directory = prepare_directory(home, Some(config), cwd)?;
    if directory.is_none()
        && !arguments
            .windows(2)
            .any(|pair| pair[0] == "--settings" && generated_settings_path(&pair[1]))
    {
        return Ok(arguments.to_vec());
    }
    let mut arguments = arguments.to_vec();
    let indices: Vec<_> = arguments
        .iter()
        .enumerate()
        .filter_map(|(i, value)| (value == "--settings").then_some(i))
        .collect();
    if indices.len() > 1 || arguments.iter().any(|arg| arg.starts_with("--settings=")) {
        return Err(error("ambiguous Claude launch settings"));
    }
    let mut document = match indices.first() {
        Some(index) => settings(
            arguments
                .get(index + 1)
                .ok_or_else(|| error("missing Claude settings"))?,
        )?,
        None => Map::new(),
    };
    if let Some(directory) = directory {
        document.insert(
            "autoMemoryDirectory".into(),
            Value::from(directory.to_string_lossy().into_owned()),
        );
    } else {
        // A persisted resume recipe may carry our old generated setting. Remove
        // only that default when the user has since chosen their own directory.
        document.remove("autoMemoryDirectory");
    }
    // Keep settings contents out of argv and durable command recipes. The
    // immutable owner-only file remains inside the protected config profile.
    let value = publish_settings(config, &document)?;
    match indices.first() {
        Some(index) => arguments[index + 1] = value,
        None => arguments
            .splice(0..0, ["--settings".into(), value])
            .for_each(drop),
    }
    Ok(arguments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepare_managed_provider_profile;

    #[test]
    fn legacy_keys_match_the_pinned_sdk_for_unicode_and_long_paths() {
        assert_eq!(legacy_project_key("/project/🧠"), "-project---");
        assert_eq!(
            legacy_project_key(&format!("/{}", "a".repeat(201))),
            format!("-{}-85qkr6", "a".repeat(199))
        );
    }

    #[test]
    fn managed_memory_is_outside_credentials_and_preserves_hooks() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let account = home.join(".dure/accounts/claude-work");
        let cwd = home.join("project");
        std::fs::create_dir_all(&account).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        let environment = prepare_managed_provider_profile(
            "claude",
            home.to_str().unwrap(),
            Some("work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap();
        let arguments = prepare_arguments(
            home,
            &environment,
            &cwd,
            &[
                "--settings".into(),
                r#"{"hooks":{"SessionStart":[]}}"#.into(),
                "--resume".into(),
                "conversation".into(),
            ],
        )
        .unwrap();
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(&arguments[1]).unwrap()).unwrap();
        let memory = Path::new(
            settings["autoMemoryDirectory"]
                .as_str()
                .expect("managed memory setting"),
        );
        assert!(memory.is_absolute());
        assert!(!memory.starts_with(home.join(".dure/accounts")));
        assert!(!memory.starts_with(home.join(".claude")));
        assert!(memory.is_dir());
        assert_eq!(settings["hooks"]["SessionStart"], serde_json::json!([]));
        assert!(settings.get("permissions").is_none());
        assert_eq!(&arguments[2..], &["--resume", "conversation"]);
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    struct Fixture {
        _root: tempfile::TempDir,
        home: PathBuf,
        account: PathBuf,
        cwd: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().canonicalize().unwrap();
            let account = home.join(".dure/accounts/claude-work");
            let cwd = home.join("project one");
            fs::create_dir_all(&account).unwrap();
            fs::create_dir(&cwd).unwrap();
            crate::prepare_managed_provider_profile(
                "claude",
                home.to_str().unwrap(),
                Some("work"),
                Some(account.to_str().unwrap()),
            )
            .unwrap();
            Self {
                _root: root,
                home,
                account,
                cwd,
            }
        }
        fn prepare(&self) -> Result<PathBuf, String> {
            prepare_directory(&self.home, Some(&self.account), &self.cwd).map(Option::unwrap)
        }
        fn legacy(&self) -> PathBuf {
            let (_, project) = project_paths(&self.cwd).unwrap();
            let slug = legacy_project_key(project.to_str().unwrap());
            self.account.join("projects").join(slug).join("memory")
        }
        fn key(&self) -> String {
            let (identity, _) = project_paths(&self.cwd).unwrap();
            format!(
                "{:x}",
                Sha256::digest(identity.as_os_str().as_encoded_bytes())
            )
        }
        /// A folder written by the per-account layout that preceded #718.
        fn account_memory(&self, account: &str, notes: &[(&str, &str)]) -> PathBuf {
            let folder = self
                .home
                .join(".dure/memories/claude")
                .join(account)
                .join(self.key());
            for (name, contents) in notes {
                let path = folder.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, contents).unwrap();
            }
            folder
        }
    }

    fn tree(root: &Path) -> std::collections::BTreeMap<PathBuf, String> {
        let mut files = std::collections::BTreeMap::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    let relative = path.strip_prefix(root).unwrap().to_path_buf();
                    files.insert(relative, fs::read_to_string(path).unwrap());
                }
            }
        }
        files
    }

    #[test]
    fn drifted_account_folders_merge_once_and_every_original_is_kept() {
        let f = Fixture::new();
        let work = f.account_memory(
            "claude-work",
            &[
                ("MEMORY.md", "- work index\n"),
                ("shared.md", "same"),
                ("own.md", "work"),
            ],
        );
        let other = f.account_memory(
            "claude-other",
            &[
                ("MEMORY.md", "- other index"),
                ("shared.md", "same"),
                ("own.md", "other"),
                ("topics/only-other.md", "other topic"),
            ],
        );
        let third = f.account_memory("claude-third", &[("only-third.md", "third")]);
        // A removed account's folder still contributes; unrelated entries do not.
        fs::create_dir_all(f.home.join(".dure/memories/claude/not-an-account")).unwrap();
        // Legacy notes were already imported into the launching account's folder.
        fs::create_dir_all(f.legacy()).unwrap();
        fs::write(f.legacy().join("legacy.md"), "legacy").unwrap();
        let originals = [&work, &other, &third].map(|path| tree(path));

        let shared = f.prepare().unwrap();
        let merged = tree(&shared);
        assert_eq!(merged[Path::new("shared.md")], "same");
        assert_eq!(merged[Path::new("own.md")], "work");
        assert_eq!(merged[Path::new("topics/only-other.md")], "other topic");
        assert_eq!(merged[Path::new("only-third.md")], "third");
        assert!(!merged.contains_key(Path::new("legacy.md")));
        assert_eq!(
            merged[Path::new("MEMORY.md")],
            format!(
                "- work index\n- [Merged account memory]({MERGE_NOTE}) — earlier per-account notes to reconcile\n"
            )
        );
        let note = &merged[Path::new(MERGE_NOTE)];
        let canonical = |path: &Path| path.canonicalize().unwrap().display().to_string();
        assert!(note.contains(&format!("1. `{}`\n", canonical(&work))));
        assert!(note.contains(&format!(
            "2. `{}` — differs: `MEMORY.md`, `own.md`\n",
            canonical(&other)
        )));
        assert!(note.contains(&format!("3. `{}`\n", canonical(&third))));
        assert_eq!(merged.len(), 6);
        for (folder, original) in [&work, &other, &third].iter().zip(&originals) {
            assert_eq!(&tree(folder), original, "an original folder changed");
        }

        // Another account reaches the same folder; the merge note is written once.
        let account = f.home.join(".dure/accounts/claude-other");
        fs::create_dir(&account).unwrap();
        fs::write(shared.join("MEMORY.md"), "- reconciled\n").unwrap();
        fs::remove_file(shared.join(MERGE_NOTE)).unwrap();
        assert_eq!(
            prepare_directory(&f.home, Some(&account), &f.cwd).unwrap(),
            Some(shared.clone())
        );
        assert_eq!(
            fs::read_to_string(shared.join("MEMORY.md")).unwrap(),
            "- reconciled\n"
        );
        assert!(!shared.join(MERGE_NOTE).exists());
        // Clearing the shared folder must not resurrect the retained copies.
        fs::remove_dir_all(&shared).unwrap();
        assert_eq!(f.prepare().unwrap(), shared);
        assert_eq!(fs::read_dir(&shared).unwrap().count(), 0);
        for (folder, original) in [&work, &other, &third].iter().zip(&originals) {
            assert_eq!(&tree(folder), original, "an original folder changed");
        }
    }

    #[test]
    fn an_account_without_a_folder_seeds_from_its_unimported_legacy_notes_first() {
        let f = Fixture::new();
        fs::create_dir_all(f.legacy()).unwrap();
        fs::write(f.legacy().join("MEMORY.md"), "legacy index\n").unwrap();
        let other = f.account_memory(
            "claude-other",
            &[("MEMORY.md", "other index\n"), ("other.md", "other")],
        );
        let shared = f.prepare().unwrap();
        assert!(
            fs::read_to_string(shared.join("MEMORY.md"))
                .unwrap()
                .starts_with("legacy index\n- [Merged account memory]")
        );
        assert_eq!(
            fs::read_to_string(shared.join("other.md")).unwrap(),
            "other"
        );
        assert_eq!(
            fs::read_to_string(other.join("MEMORY.md")).unwrap(),
            "other index\n"
        );
        assert_eq!(
            fs::read_to_string(f.legacy().join("MEMORY.md")).unwrap(),
            "legacy index\n"
        );
    }

    #[test]
    fn migration_preserves_notes_credentials_and_later_edits_and_deletions() {
        let f = Fixture::new();
        let source = f.legacy();
        fs::create_dir_all(source.join("topics")).unwrap();
        fs::write(source.join("MEMORY.md"), "old index").unwrap();
        fs::write(source.join("topics/topic.md"), "old topic").unwrap();
        let credentials = f.account.join(".credentials.json");
        fs::write(&credentials, "private credential").unwrap();
        fs::set_permissions(&credentials, fs::Permissions::from_mode(0o600)).unwrap();
        let destination = f.prepare().unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("MEMORY.md")).unwrap(),
            "old index"
        );
        assert_eq!(
            fs::read_to_string(destination.join("topics/topic.md")).unwrap(),
            "old topic"
        );
        assert_eq!(fs::metadata(&destination).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            fs::metadata(destination.join("MEMORY.md")).unwrap().mode() & 0o777,
            0o600
        );
        fs::write(destination.join("MEMORY.md"), "new index").unwrap();
        fs::remove_file(destination.join("topics/topic.md")).unwrap();
        assert_eq!(f.prepare().unwrap(), destination);
        assert_eq!(
            fs::read_to_string(destination.join("MEMORY.md")).unwrap(),
            "new index"
        );
        assert!(!destination.join("topics/topic.md").exists());
        // Clearing the whole new directory must not resurrect the retained copy.
        fs::remove_dir_all(&destination).unwrap();
        assert_eq!(f.prepare().unwrap(), destination);
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        assert_eq!(
            fs::read_to_string(source.join("MEMORY.md")).unwrap(),
            "old index"
        );
        assert_eq!(
            fs::read_to_string(source.join("topics/topic.md")).unwrap(),
            "old topic"
        );
        assert_eq!(
            fs::read_to_string(&credentials).unwrap(),
            "private credential"
        );
        assert_eq!(fs::metadata(credentials).unwrap().mode() & 0o777, 0o600);
    }

    #[test]
    fn accounts_share_project_memory_and_colliding_legacy_slugs_stay_distinct() {
        let f = Fixture::new();
        let one = f.prepare().unwrap();
        let other = f.home.join(".dure/accounts/claude-other");
        fs::create_dir(&other).unwrap();
        let two = prepare_directory(&f.home, Some(&other), &f.cwd)
            .unwrap()
            .unwrap();
        assert_eq!(one, two);
        assert_eq!(one, f.home.join(".dure/memories/claude").join(f.key()));
        fs::write(one.join("MEMORY.md"), "shared").unwrap();
        assert_eq!(fs::read_to_string(two.join("MEMORY.md")).unwrap(), "shared");
        let project = f.home.join("project-one");
        fs::create_dir(&project).unwrap();
        assert_ne!(
            one,
            prepare_directory(&f.home, Some(&f.account), &project)
                .unwrap()
                .unwrap()
        );
        assert!(prepare_directory(&f.home, None, &f.cwd).unwrap().is_none());
        assert!(
            prepare_directory(&f.home, Some(&f.home.join(".claude")), &f.cwd)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn composed_settings_keep_private_values_out_of_argv_and_refuse_tampering() {
        let f = Fixture::new();
        let source = f.home.join("managed-settings.json");
        let bytes = br#"{"hooks":{"SessionStart":[]},"env":{"TOKEN":"private-settings-value"},"autoMemoryEnabled":false}"#;
        fs::write(&source, bytes).unwrap();
        let environment = ProviderStateEnvironment::new(std::collections::BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            f.account.to_string_lossy().into_owned(),
        )]))
        .unwrap();
        let original = vec!["--settings".into(), source.to_string_lossy().into_owned()];
        let arguments = prepare_arguments(&f.home, &environment, &f.cwd, &original).unwrap();
        assert!(!arguments.join(" ").contains("private-settings-value"));
        let path = Path::new(&arguments[1]);
        assert!(path.starts_with(&f.account));
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o600);
        let composed: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(composed["env"]["TOKEN"], "private-settings-value");
        assert_eq!(composed["autoMemoryEnabled"], false);
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(
            prepare_arguments(&f.home, &environment, &f.cwd, &original).unwrap(),
            arguments
        );
        // An account switch reuses the launch settings, republished in the new
        // profile, and keeps the conversation's memory folder.
        let other = f.home.join(".dure/accounts/claude-other");
        fs::create_dir(&other).unwrap();
        let other_environment =
            ProviderStateEnvironment::new(std::collections::BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                other.to_string_lossy().into_owned(),
            )]))
            .unwrap();
        let switched = prepare_arguments(&f.home, &other_environment, &f.cwd, &arguments).unwrap();
        let switched_settings: Value =
            serde_json::from_slice(&fs::read(&switched[1]).unwrap()).unwrap();
        assert_eq!(
            composed["autoMemoryDirectory"],
            switched_settings["autoMemoryDirectory"]
        );
        assert!(Path::new(&switched[1]).starts_with(&other));
        fs::write(path, "{}").unwrap();
        assert!(prepare_arguments(&f.home, &environment, &f.cwd, &original).is_err());
        assert!(prepare_arguments(&f.home, &environment, &f.cwd, &arguments).is_err());
    }

    #[test]
    fn explicit_custom_memory_and_disabled_memory_settings_are_preserved() {
        let f = Fixture::new();
        let custom = f.home.join("custom-notes");
        fs::create_dir(&custom).unwrap();
        fs::write(custom.join("MEMORY.md"), "custom notes").unwrap();
        let settings =
            serde_json::json!({ "autoMemoryDirectory": custom, "autoMemoryEnabled": false });
        let bytes = serde_json::to_vec(&settings).unwrap();
        fs::write(f.account.join("settings.json"), &bytes).unwrap();
        assert!(
            prepare_directory(&f.home, Some(&f.account), &f.cwd)
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(f.account.join("settings.json")).unwrap(), bytes);
        assert_eq!(
            fs::read_to_string(custom.join("MEMORY.md")).unwrap(),
            "custom notes"
        );
        assert!(!f.home.join(".dure/memories").exists());
    }

    #[test]
    fn explicit_project_memory_settings_remain_provider_owned() {
        for file in ["settings.json", "settings.local.json"] {
            let f = Fixture::new();
            let directory = f.cwd.join(".claude");
            fs::create_dir(&directory).unwrap();
            let settings = directory.join(file);
            let contents = br#"{"autoMemoryDirectory":"~/custom-project-memory"}"#;
            fs::write(&settings, contents).unwrap();
            assert!(
                prepare_directory(&f.home, Some(&f.account), &f.cwd)
                    .unwrap()
                    .is_none(),
                "an explicit project memory setting must not be overridden"
            );
            assert_eq!(fs::read(settings).unwrap(), contents);
            assert!(!f.home.join(".dure/memories").exists());
        }
    }

    #[test]
    fn a_custom_setting_replaces_only_the_generated_memory_default_on_resume() {
        for project_setting in [false, true] {
            let f = Fixture::new();
            let environment = ProviderStateEnvironment::new(std::collections::BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                f.account.to_string_lossy().into_owned(),
            )]))
            .unwrap();
            let original = prepare_arguments(
                &f.home,
                &environment,
                &f.cwd,
                &[
                    "--settings".into(),
                    r#"{"hooks":{"SessionStart":[]}}"#.into(),
                    "--resume".into(),
                    "exact-conversation".into(),
                ],
            )
            .unwrap();
            let root = if project_setting {
                f.cwd.join(".claude")
            } else {
                f.account.clone()
            };
            fs::create_dir_all(&root).unwrap();
            fs::write(
                root.join("settings.local.json"),
                r#"{"autoMemoryDirectory":"~/chosen-memory"}"#,
            )
            .unwrap();
            let prepared = prepare_arguments(&f.home, &environment, &f.cwd, &original).unwrap();
            let document = settings(&prepared[1]).unwrap();
            assert!(!document.contains_key("autoMemoryDirectory"));
            assert_eq!(document["hooks"]["SessionStart"], serde_json::json!([]));
            assert_eq!(&prepared[2..], &["--resume", "exact-conversation"]);
            assert!(
                settings(&original[1])
                    .unwrap()
                    .contains_key("autoMemoryDirectory")
            );
        }
    }

    #[test]
    fn memory_destination_symlinks_cannot_grant_access_to_credentials() {
        let f = Fixture::new();
        symlink(f.home.join(".dure/accounts"), f.home.join(".dure/memories")).unwrap();
        assert!(f.prepare().is_err());
        fs::remove_file(f.home.join(".dure/memories")).unwrap();
        let destination = f.prepare().unwrap();
        fs::remove_dir(&destination).unwrap();
        symlink(&f.account, &destination).unwrap();
        assert!(f.prepare().is_err());
    }

    #[test]
    fn unsafe_legacy_notes_refuse_migration_without_copying_credentials() {
        for hardlink in [false, true] {
            let f = Fixture::new();
            let source = f.legacy();
            fs::create_dir_all(&source).unwrap();
            let credential = f.account.join(".credentials.json");
            fs::write(&credential, "secret").unwrap();
            if hardlink {
                fs::hard_link(&credential, source.join("MEMORY.md")).unwrap();
            } else {
                symlink(&credential, source.join("MEMORY.md")).unwrap();
            }
            assert!(f.prepare().is_err());
            assert_eq!(fs::read_to_string(&credential).unwrap(), "secret");
            fs::remove_file(source.join("MEMORY.md")).unwrap();
            fs::write(source.join("MEMORY.md"), "repaired").unwrap();
            assert_eq!(
                fs::read_to_string(f.prepare().unwrap().join("MEMORY.md")).unwrap(),
                "repaired"
            );
        }
    }

    #[test]
    fn repository_subdirectories_and_linked_worktrees_share_memory() {
        let f = Fixture::new();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&f.cwd)
                .args([
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["commit", "--allow-empty", "-m", "fixture"]);
        let worktree = f.home.join("linked");
        git(&["worktree", "add", "--detach", worktree.to_str().unwrap()]);
        let nested = f.cwd.join("src");
        fs::create_dir(&nested).unwrap();
        let destination = f.prepare().unwrap();
        assert_eq!(
            Some(destination.clone()),
            prepare_directory(&f.home, Some(&f.account), &nested).unwrap()
        );
        assert_eq!(
            Some(destination),
            prepare_directory(&f.home, Some(&f.account), &worktree).unwrap()
        );
    }

    #[test]
    fn concurrent_first_launch_imports_a_complete_snapshot_once() {
        let f = Fixture::new();
        fs::create_dir_all(f.legacy()).unwrap();
        fs::write(f.legacy().join("MEMORY.md"), "notes").unwrap();
        std::thread::scope(|scope| {
            let threads: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| f.prepare().unwrap()))
                .collect();
            let paths: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
            assert!(paths.iter().all(|path| path == &paths[0]));
            assert_eq!(
                fs::read_to_string(paths[0].join("MEMORY.md")).unwrap(),
                "notes"
            );
        });
    }
}
