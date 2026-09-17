use hmux_client::{StandaloneResurrectionRecipe, StandaloneResurrectionReplayPolicy};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const CURRENT_RECIPE_DIRECTORY: &str = ".resurrection";
const LEGACY_RECIPE_DIRECTORY: &str = "hmux-resurrection-v1";
const MAX_LEGACY_WORKSPACES: usize = 128;
const MAX_LEGACY_RECORDS: usize = 1_024;
const MAX_RECIPE_BYTES: u64 = 256 * 1024;
const DEFAULT_RESTORED_ROWS: u16 = 24;
const DEFAULT_RESTORED_COLUMNS: u16 = 80;

#[derive(Debug)]
pub(crate) struct ResolvedResurrectionRecipe {
    recipe: StandaloneResurrectionRecipe,
    migrated_legacy: bool,
}

impl ResolvedResurrectionRecipe {
    pub(crate) fn recipe(&self) -> &StandaloneResurrectionRecipe {
        &self.recipe
    }

    pub(crate) fn migrated_legacy(&self) -> bool {
        self.migrated_legacy
    }
}

#[derive(Debug)]
pub(crate) struct ResurrectionError(String);

impl fmt::Display for ResurrectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ResurrectionError {}

#[derive(Debug, Deserialize)]
struct LegacyResurrectionRecord {
    schema_version: u16,
    logical_session_id: String,
    workspace_id: String,
    session_name: String,
    restore_generation: u64,
    launch_recipe: LegacyLaunchRecipe,
    restore_policy: String,
    created_unix_ms: u64,
    updated_unix_ms: u64,
}

#[derive(Debug, Deserialize)]
struct LegacyLaunchRecipe {
    kind: String,
    program: PathBuf,
    #[serde(default)]
    arguments: Vec<String>,
    restore_cwd: PathBuf,
}

#[derive(Debug)]
struct LegacyCandidate {
    logical_session_id: String,
    workspace_id: String,
    updated_unix_ms: u64,
    recipe: StandaloneResurrectionRecipe,
}

pub(crate) fn resolve_and_migrate(
    discovery_root: &Path,
    session_name: &str,
) -> Result<ResolvedResurrectionRecipe, ResurrectionError> {
    let (recipe, legacy) = load_saved_recipe(discovery_root, session_name)?
        .ok_or_else(|| ResurrectionError(format!("no saved Hmux recipe named `{session_name}`")))?;
    if legacy {
        save_current_recipe(discovery_root, &recipe)?;
    }
    Ok(ResolvedResurrectionRecipe {
        recipe,
        migrated_legacy: legacy,
    })
}

/// Inspect a saved recipe without importing legacy state. Listing and recovery
/// preflight use this path so observation never creates files.
pub(crate) fn resolve_if_saved(
    discovery_root: &Path,
    session_name: &str,
) -> Result<Option<StandaloneResurrectionRecipe>, ResurrectionError> {
    Ok(load_saved_recipe(discovery_root, session_name)?.map(|(recipe, _legacy)| recipe))
}

fn load_saved_recipe(
    discovery_root: &Path,
    session_name: &str,
) -> Result<Option<(StandaloneResurrectionRecipe, bool)>, ResurrectionError> {
    if let Some(recipe) = load_current_recipe(discovery_root, session_name)? {
        return Ok(Some((recipe, false)));
    }

    let legacy_root = discovery_root
        .parent()
        .map(|parent| parent.join(LEGACY_RECIPE_DIRECTORY));
    Ok(legacy_root
        .as_deref()
        .map(|root| load_legacy_recipe(root, session_name))
        .transpose()?
        .flatten()
        .map(|recipe| (recipe, true)))
}

fn load_current_recipe(
    discovery_root: &Path,
    session_name: &str,
) -> Result<Option<StandaloneResurrectionRecipe>, ResurrectionError> {
    let directory = discovery_root.join(CURRENT_RECIPE_DIRECTORY);
    match fs::read_dir(&directory) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(path_error(
                "read current resurrection recipe directory",
                &directory,
                error,
            ));
        }
    };
    validate_private_metadata(
        &directory,
        &fs::symlink_metadata(&directory).map_err(|error| {
            path_error(
                "inspect current resurrection recipe directory",
                &directory,
                error,
            )
        })?,
        true,
    )?;

    let path = current_recipe_path(&directory, session_name);
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(path_error(
                "inspect current resurrection recipe",
                &path,
                error,
            ));
        }
    }
    let payload = read_private_bounded_file(&path)?;
    let recipe: StandaloneResurrectionRecipe =
        serde_json::from_slice(&payload).map_err(|error| {
            ResurrectionError(format!(
                "decode current resurrection recipe {}: {error}",
                path.display()
            ))
        })?;
    recipe.validate().map_err(|error| {
        ResurrectionError(format!(
            "validate current resurrection recipe {}: {error}",
            path.display()
        ))
    })?;
    if recipe.session_name() != session_name {
        return Err(ResurrectionError(format!(
            "current resurrection recipe {} does not match requested name `{session_name}`",
            path.display()
        )));
    }
    Ok(Some(recipe))
}

fn load_legacy_recipe(
    legacy_root: &Path,
    session_name: &str,
) -> Result<Option<StandaloneResurrectionRecipe>, ResurrectionError> {
    let workspaces = match fs::read_dir(legacy_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(path_error(
                "read legacy resurrection root",
                legacy_root,
                error,
            ));
        }
    };
    validate_private_metadata(
        legacy_root,
        &fs::symlink_metadata(legacy_root)
            .map_err(|error| path_error("inspect legacy resurrection root", legacy_root, error))?,
        true,
    )?;

    let mut workspace_count = 0;
    let mut record_count = 0;
    let mut candidates = Vec::new();
    let mut skipped_records = 0;
    let mut first_skipped_error: Option<ResurrectionError> = None;
    for workspace in workspaces {
        let workspace = workspace.map_err(|error| {
            path_error("read legacy resurrection workspace", legacy_root, error)
        })?;
        let workspace_path = workspace.path();
        let workspace_metadata = fs::symlink_metadata(&workspace_path).map_err(|error| {
            path_error(
                "inspect legacy resurrection workspace",
                &workspace_path,
                error,
            )
        })?;
        if !workspace_metadata.is_dir() {
            continue;
        }
        workspace_count += 1;
        if workspace_count > MAX_LEGACY_WORKSPACES {
            return Err(ResurrectionError(
                "legacy Hmux resurrection workspace limit exceeded".to_string(),
            ));
        }
        validate_private_metadata(&workspace_path, &workspace_metadata, true)?;
        let records_path = workspace_path.join("records");
        let records = match fs::read_dir(&records_path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(path_error(
                    "read legacy resurrection records",
                    &records_path,
                    error,
                ));
            }
        };
        validate_private_metadata(
            &records_path,
            &fs::symlink_metadata(&records_path).map_err(|error| {
                path_error("inspect legacy resurrection records", &records_path, error)
            })?,
            true,
        )?;

        for record in records {
            let record = record.map_err(|error| {
                path_error("read legacy resurrection record", &records_path, error)
            })?;
            let record_path = record.path();
            if record_path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            record_count += 1;
            if record_count > MAX_LEGACY_RECORDS {
                return Err(ResurrectionError(
                    "legacy Hmux resurrection record limit exceeded".to_string(),
                ));
            }
            let payload = match read_private_bounded_file(&record_path) {
                Ok(payload) => payload,
                Err(error) => {
                    skipped_records += 1;
                    first_skipped_error.get_or_insert(error);
                    continue;
                }
            };
            let record: LegacyResurrectionRecord = match serde_json::from_slice(&payload) {
                Ok(record) => record,
                Err(error) => {
                    skipped_records += 1;
                    first_skipped_error.get_or_insert_with(|| {
                        ResurrectionError(format!(
                            "decode legacy resurrection record {}: {error}",
                            record_path.display()
                        ))
                    });
                    continue;
                }
            };
            if record.session_name != session_name {
                continue;
            }
            candidates.push(validate_legacy_record(
                &workspace_path,
                &record_path,
                record,
            )?);
        }
    }

    if candidates.is_empty() {
        if let Some(error) = first_skipped_error {
            return Err(ResurrectionError(format!(
                "no valid legacy Hmux recipe named `{session_name}`; skipped {skipped_records} unsafe or corrupt record(s), first error: {error}"
            )));
        }
        return Ok(None);
    }
    let identities = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.workspace_id.as_str(),
                candidate.logical_session_id.as_str(),
            )
        })
        .collect::<BTreeSet<_>>();
    if identities.len() > 1 {
        let workspaces = candidates
            .iter()
            .map(|candidate| candidate.workspace_id.as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(", ");
        return Err(ResurrectionError(format!(
            "legacy Hmux recipe name `{session_name}` is ambiguous across saved sessions ({workspaces})"
        )));
    }
    candidates.sort_by_key(|candidate| candidate.updated_unix_ms);
    Ok(candidates.pop().map(|candidate| candidate.recipe))
}

fn validate_legacy_record(
    workspace_path: &Path,
    record_path: &Path,
    record: LegacyResurrectionRecord,
) -> Result<LegacyCandidate, ResurrectionError> {
    if record.schema_version != 1 {
        return Err(legacy_field_error(
            record_path,
            "schema_version is unsupported",
        ));
    }
    if !valid_identifier(&record.logical_session_id)
        || !record.logical_session_id.starts_with("resurrection_")
    {
        return Err(legacy_field_error(
            record_path,
            "logical_session_id is invalid",
        ));
    }
    let expected_record_name = format!("{}.json", sha256_hex(record.logical_session_id.as_bytes()));
    if record_path.file_name().and_then(|value| value.to_str())
        != Some(expected_record_name.as_str())
    {
        return Err(legacy_field_error(
            record_path,
            "record filename does not match logical_session_id",
        ));
    }
    if !valid_workspace_id(&record.workspace_id) {
        return Err(legacy_field_error(record_path, "workspace_id is invalid"));
    }
    let workspace_directory_name = workspace_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if workspace_directory_name != sha256_hex(record.workspace_id.as_bytes()) {
        return Err(legacy_field_error(
            record_path,
            "workspace directory does not match workspace_id",
        ));
    }
    if record.session_name.trim().is_empty()
        || record.session_name.len() > 256
        || record.session_name.chars().any(char::is_control)
    {
        return Err(legacy_field_error(record_path, "session_name is invalid"));
    }
    if record.restore_generation == 0
        || record.created_unix_ms == 0
        || record.updated_unix_ms < record.created_unix_ms
    {
        return Err(legacy_field_error(
            record_path,
            "generation or timestamps are invalid",
        ));
    }
    if record.restore_policy != "safe_auto" {
        return Err(legacy_field_error(
            record_path,
            "restore_policy is not safe_auto",
        ));
    }
    if record.launch_recipe.kind != "shell" {
        return Err(legacy_field_error(
            record_path,
            "launch_recipe kind is not shell",
        ));
    }
    if !record.launch_recipe.arguments.is_empty() {
        return Err(legacy_field_error(
            record_path,
            "shell arguments require manual replay approval",
        ));
    }

    let restore_cwd = canonical_directory(&record.launch_recipe.restore_cwd).map_err(|error| {
        ResurrectionError(format!(
            "legacy resurrection record {} has an unavailable restore cwd {}: {error}",
            record_path.display(),
            record.launch_recipe.restore_cwd.display()
        ))
    })?;
    validate_trusted_shell(&record.launch_recipe.program, record_path)?;
    let program = record
        .launch_recipe
        .program
        .to_str()
        .ok_or_else(|| legacy_field_error(record_path, "shell program is not valid UTF-8"))?
        .to_string();
    let recipe = StandaloneResurrectionRecipe::new(
        record.session_name,
        restore_cwd,
        vec![program],
        DEFAULT_RESTORED_ROWS,
        DEFAULT_RESTORED_COLUMNS,
        record.updated_unix_ms,
    )
    .and_then(|recipe| {
        recipe.with_resurrection_replay_policy(
            StandaloneResurrectionReplayPolicy::SafeInteractiveShell,
        )
    })
    .map_err(|error| {
        ResurrectionError(format!(
            "convert legacy resurrection record {}: {error}",
            record_path.display()
        ))
    })?;

    Ok(LegacyCandidate {
        logical_session_id: record.logical_session_id,
        workspace_id: record.workspace_id,
        updated_unix_ms: record.updated_unix_ms,
        recipe,
    })
}

fn save_current_recipe(
    discovery_root: &Path,
    recipe: &StandaloneResurrectionRecipe,
) -> Result<(), ResurrectionError> {
    recipe
        .validate()
        .map_err(|error| ResurrectionError(format!("validate migrated recipe: {error}")))?;
    let directory = discovery_root.join(CURRENT_RECIPE_DIRECTORY);
    create_private_directory(&directory)?;
    let path = current_recipe_path(&directory, recipe.session_name());
    if path
        .try_exists()
        .map_err(|error| path_error("inspect migrated resurrection recipe", &path, error))?
    {
        let existing: StandaloneResurrectionRecipe =
            serde_json::from_slice(&read_private_bounded_file(&path)?).map_err(|error| {
                ResurrectionError(format!(
                    "decode migrated resurrection recipe {}: {error}",
                    path.display()
                ))
            })?;
        if existing == *recipe {
            return Ok(());
        }
        return Err(ResurrectionError(format!(
            "refusing to replace a different Hmux resurrection recipe at {}",
            path.display()
        )));
    }

    let temporary = directory.join(format!(".recipe-{}.tmp", Uuid::new_v4().simple()));
    let payload = serde_json::to_vec(recipe)
        .map_err(|error| ResurrectionError(format!("encode migrated recipe: {error}")))?;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).map_err(|error| {
            path_error("create migrated resurrection recipe", &temporary, error)
        })?;
        file.write_all(&payload)
            .map_err(|error| path_error("write migrated resurrection recipe", &temporary, error))?;
        file.sync_all()
            .map_err(|error| path_error("sync migrated resurrection recipe", &temporary, error))?;
        match fs::hard_link(&temporary, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let existing: StandaloneResurrectionRecipe = serde_json::from_slice(
                    &read_private_bounded_file(&path)?,
                )
                .map_err(|error| {
                    ResurrectionError(format!(
                        "decode concurrently migrated recipe {}: {error}",
                        path.display()
                    ))
                })?;
                if existing != *recipe {
                    return Err(ResurrectionError(format!(
                        "another process published a different Hmux resurrection recipe at {}",
                        path.display()
                    )));
                }
            }
            Err(error) => {
                return Err(path_error(
                    "publish migrated resurrection recipe",
                    &path,
                    error,
                ));
            }
        }
        #[cfg(unix)]
        File::open(&directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| path_error("sync resurrection recipe directory", &directory, error))?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn current_recipe_path(directory: &Path, session_name: &str) -> PathBuf {
    let digest = sha256_hex(session_name.as_bytes());
    directory.join(format!("recipe_{}.json", &digest[..32]))
}

fn create_private_directory(path: &Path) -> Result<(), ResurrectionError> {
    fs::create_dir_all(path)
        .map_err(|error| path_error("create resurrection recipe directory", path, error))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| path_error("inspect resurrection recipe directory", path, error))?;
    #[cfg(unix)]
    {
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            // SAFETY: geteuid takes no arguments and only reads process identity.
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(ResurrectionError(format!(
                "resurrection recipe directory is not privately owned: {}",
                path.display()
            )));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            path_error("set resurrection recipe directory permissions", path, error)
        })?;
    }
    #[cfg(not(unix))]
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ResurrectionError(format!(
            "resurrection recipe path is not a directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn read_private_bounded_file(path: &Path) -> Result<Vec<u8>, ResurrectionError> {
    let before = fs::symlink_metadata(path)
        .map_err(|error| path_error("inspect resurrection recipe", path, error))?;
    validate_private_metadata(path, &before, false)?;
    if before.len() > MAX_RECIPE_BYTES {
        return Err(ResurrectionError(format!(
            "resurrection recipe exceeds {MAX_RECIPE_BYTES} bytes: {}",
            path.display()
        )));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(|error| path_error("open resurrection recipe", path, error))?;
    #[cfg(unix)]
    {
        let after = file
            .metadata()
            .map_err(|error| path_error("reinspect resurrection recipe", path, error))?;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(ResurrectionError(format!(
                "resurrection recipe changed while opening: {}",
                path.display()
            )));
        }
    }
    let mut payload = Vec::new();
    file.take(MAX_RECIPE_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| path_error("read resurrection recipe", path, error))?;
    if payload.len() as u64 > MAX_RECIPE_BYTES {
        return Err(ResurrectionError(format!(
            "resurrection recipe grew beyond {MAX_RECIPE_BYTES} bytes: {}",
            path.display()
        )));
    }
    Ok(payload)
}

fn validate_private_metadata(
    path: &Path,
    metadata: &fs::Metadata,
    directory: bool,
) -> Result<(), ResurrectionError> {
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(ResurrectionError(format!(
            "resurrection path has an unsafe file type: {}",
            path.display()
        )));
    }
    #[cfg(unix)]
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
        return Err(ResurrectionError(format!(
            "resurrection path is not private to the current user: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_trusted_shell(program: &Path, record_path: &Path) -> Result<(), ResurrectionError> {
    if !program.is_absolute() {
        return Err(legacy_field_error(
            record_path,
            "shell program is not absolute",
        ));
    }
    let canonical_program = fs::canonicalize(program).map_err(|error| {
        ResurrectionError(format!(
            "legacy resurrection record {} shell {} is unavailable: {error}",
            record_path.display(),
            program.display()
        ))
    })?;
    let metadata = fs::metadata(&canonical_program)
        .map_err(|error| path_error("inspect legacy shell program", &canonical_program, error))?;
    if !metadata.is_file() {
        return Err(legacy_field_error(
            record_path,
            "shell program is not a file",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(legacy_field_error(
            record_path,
            "shell program is not executable",
        ));
    }
    if trusted_shell_paths()
        .iter()
        .any(|trusted| same_canonical_path(trusted, &canonical_program))
    {
        return Ok(());
    }
    Err(ResurrectionError(format!(
        "legacy resurrection record {} shell {} is not listed by $SHELL or /etc/shells",
        record_path.display(),
        program.display()
    )))
}

fn trusted_shell_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(shell) = std::env::var_os("SHELL").filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(shell));
    }
    if let Ok(contents) = fs::read_to_string("/etc/shells") {
        paths.extend(
            contents
                .lines()
                .map(str::trim)
                .filter(|line| line.starts_with('/') && !line.starts_with("/#"))
                .map(PathBuf::from),
        );
    }
    paths.extend(
        ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh"]
            .into_iter()
            .map(PathBuf::from),
    );
    paths
}

fn same_canonical_path(candidate: &Path, canonical_program: &Path) -> bool {
    fs::canonicalize(candidate).is_ok_and(|candidate| candidate == canonical_program)
}

fn canonical_directory(path: &Path) -> io::Result<PathBuf> {
    let canonical = fs::canonicalize(path)?;
    if !canonical.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not a directory",
        ));
    }
    Ok(canonical)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn valid_workspace_id(value: &str) -> bool {
    value.strip_prefix("workspace_").is_some_and(|suffix| {
        suffix.len() == 16 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn sha256_hex(value: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(value);
    format!("{:x}", digest.finalize())
}

fn legacy_field_error(path: &Path, reason: &str) -> ResurrectionError {
    ResurrectionError(format!(
        "legacy resurrection record {} is invalid: {reason}",
        path.display()
    ))
}

fn path_error(operation: &str, path: &Path, error: io::Error) -> ResurrectionError {
    ResurrectionError(format!("{operation} at {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inspecting_a_legacy_recipe_does_not_publish_a_current_recipe() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        write_legacy_record(
            &discovery_root,
            LegacyRecordFixture::shell("resurrection_inspect", "legacy-inspect", &cwd),
        );

        let inspected = resolve_if_saved(&discovery_root, "legacy-inspect")
            .unwrap()
            .expect("legacy recipe should be inspectable");

        assert_eq!(inspected.session_name(), "legacy-inspect");
        assert!(
            !discovery_root.join(CURRENT_RECIPE_DIRECTORY).exists(),
            "read-only recipe inspection must not migrate legacy state"
        );
    }

    #[test]
    fn valid_legacy_shell_is_migrated_once_with_exact_program_and_cwd() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        write_legacy_record(
            &discovery_root,
            LegacyRecordFixture::shell("resurrection_one", "legacy-dev", &cwd),
        );

        let migrated = resolve_and_migrate(&discovery_root, "legacy-dev").unwrap();

        assert!(migrated.migrated_legacy());
        assert_eq!(
            migrated.recipe().provider_cwd(),
            cwd.canonicalize().unwrap()
        );
        assert_eq!(migrated.recipe().command(), ["/bin/sh"]);
        assert!(!migrated.recipe().requires_operator_confirmation());
        let current_directory = discovery_root.join(CURRENT_RECIPE_DIRECTORY);
        assert_eq!(fs::read_dir(&current_directory).unwrap().count(), 1);

        let current = resolve_and_migrate(&discovery_root, "legacy-dev").unwrap();
        assert!(!current.migrated_legacy());
        assert_eq!(current.recipe(), migrated.recipe());
    }

    #[test]
    fn corrupt_unrelated_legacy_record_does_not_block_a_valid_target() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        let valid_record = write_legacy_record(
            &discovery_root,
            LegacyRecordFixture::shell("resurrection_valid", "valid-dev", &cwd),
        );
        write_private_file(
            &valid_record.with_file_name("corrupt-unrelated.json"),
            b"{not-json",
        );

        let migrated = resolve_and_migrate(&discovery_root, "valid-dev").unwrap();

        assert!(migrated.migrated_legacy());
        assert_eq!(migrated.recipe().command(), ["/bin/sh"]);
    }

    #[test]
    fn current_recipe_takes_precedence_over_an_unsafe_legacy_record() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        let current =
            StandaloneResurrectionRecipe::new("dev", &cwd, Vec::new(), 30, 100, 10).unwrap();
        save_current_recipe(&discovery_root, &current).unwrap();
        write_private_file(
            &discovery_root
                .join(CURRENT_RECIPE_DIRECTORY)
                .join("corrupt-unrelated.json"),
            b"{not-json",
        );
        let mut legacy = LegacyRecordFixture::shell("resurrection_old", "dev", &cwd);
        legacy.restore_policy = "manual_only";
        write_legacy_record(&discovery_root, legacy);

        let resolved = resolve_and_migrate(&discovery_root, "dev").unwrap();

        assert!(!resolved.migrated_legacy());
        assert_eq!(resolved.recipe(), &current);
    }

    #[test]
    fn missing_legacy_cwd_fails_without_publishing_a_current_recipe() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let missing = state.path().join("missing");
        write_legacy_record(
            &discovery_root,
            LegacyRecordFixture::shell("resurrection_missing", "missing-dev", &missing),
        );

        let error = resolve_and_migrate(&discovery_root, "missing-dev").unwrap_err();

        assert!(error.to_string().contains("unavailable restore cwd"));
        assert!(!discovery_root.join(CURRENT_RECIPE_DIRECTORY).exists());
    }

    #[test]
    fn legacy_shell_arguments_require_manual_migration() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        let mut legacy = LegacyRecordFixture::shell("resurrection_args", "arg-dev", &cwd);
        legacy.arguments = &["-c", "touch /tmp/should-not-run"];
        write_legacy_record(&discovery_root, legacy);

        let error = resolve_and_migrate(&discovery_root, "arg-dev").unwrap_err();

        assert!(error.to_string().contains("manual replay approval"));
        assert!(!discovery_root.join(CURRENT_RECIPE_DIRECTORY).exists());
    }

    #[test]
    fn unsafe_legacy_restore_policy_is_not_imported() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        let mut legacy = LegacyRecordFixture::shell("resurrection_manual", "manual-dev", &cwd);
        legacy.restore_policy = "manual_only";
        write_legacy_record(&discovery_root, legacy);

        let error = resolve_and_migrate(&discovery_root, "manual-dev").unwrap_err();

        assert!(
            error
                .to_string()
                .contains("restore_policy is not safe_auto")
        );
        assert!(!discovery_root.join(CURRENT_RECIPE_DIRECTORY).exists());
    }

    #[test]
    fn mismatched_legacy_workspace_hash_is_not_imported() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        let record = write_legacy_record(
            &discovery_root,
            LegacyRecordFixture::shell("resurrection_mismatch", "mismatch-dev", &cwd),
        );
        let wrong_records = discovery_root
            .parent()
            .unwrap()
            .join(LEGACY_RECIPE_DIRECTORY)
            .join("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
            .join("records");
        create_private_directory(wrong_records.parent().unwrap()).unwrap();
        create_private_directory(&wrong_records).unwrap();
        let moved_record = wrong_records.join(record.file_name().unwrap());
        fs::rename(record, &moved_record).unwrap();

        let error = resolve_and_migrate(&discovery_root, "mismatch-dev").unwrap_err();

        assert!(
            error
                .to_string()
                .contains("workspace directory does not match workspace_id")
        );
        assert!(!discovery_root.join(CURRENT_RECIPE_DIRECTORY).exists());
    }

    #[test]
    fn duplicate_legacy_name_is_refused_instead_of_guessing() {
        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        for logical_id in ["resurrection_one", "resurrection_two"] {
            write_legacy_record(
                &discovery_root,
                LegacyRecordFixture::shell(logical_id, "duplicate-dev", &cwd),
            );
        }

        let error = resolve_and_migrate(&discovery_root, "duplicate-dev").unwrap_err();

        assert!(error.to_string().contains("ambiguous"));
        assert!(!discovery_root.join(CURRENT_RECIPE_DIRECTORY).exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_legacy_record_is_refused() {
        use std::os::unix::fs::symlink;

        let state = private_tempdir();
        let discovery_root = state.path().join("state/hmux-hosts");
        let cwd = state.path().join("workspace");
        create_private_directory(&cwd).unwrap();
        let record = write_legacy_record(
            &discovery_root,
            LegacyRecordFixture::shell("resurrection_link", "linked-dev", &cwd),
        );
        let target = record.with_extension("target");
        fs::rename(&record, &target).unwrap();
        symlink(&target, &record).unwrap();

        let error = resolve_and_migrate(&discovery_root, "linked-dev").unwrap_err();

        assert!(error.to_string().contains("unsafe file type"));
        assert!(!discovery_root.join(CURRENT_RECIPE_DIRECTORY).exists());
    }

    fn private_tempdir() -> tempfile::TempDir {
        let state = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        fs::set_permissions(state.path(), fs::Permissions::from_mode(0o700)).unwrap();
        state
    }

    struct LegacyRecordFixture<'a> {
        workspace_id: &'a str,
        logical_session_id: &'a str,
        session_name: &'a str,
        restore_cwd: &'a Path,
        program: &'a str,
        arguments: &'a [&'a str],
        restore_policy: &'a str,
    }

    impl<'a> LegacyRecordFixture<'a> {
        fn shell(
            logical_session_id: &'a str,
            session_name: &'a str,
            restore_cwd: &'a Path,
        ) -> Self {
            Self {
                workspace_id: "workspace_0123456789abcdef",
                logical_session_id,
                session_name,
                restore_cwd,
                program: "/bin/sh",
                arguments: &[],
                restore_policy: "safe_auto",
            }
        }
    }

    fn write_legacy_record(discovery_root: &Path, fixture: LegacyRecordFixture<'_>) -> PathBuf {
        let legacy_root = discovery_root
            .parent()
            .unwrap()
            .join(LEGACY_RECIPE_DIRECTORY);
        let workspace = legacy_root.join(sha256_hex(fixture.workspace_id.as_bytes()));
        let records = workspace.join("records");
        for directory in [&legacy_root, &workspace, &records] {
            create_private_directory(directory).unwrap();
        }
        let path = records.join(format!(
            "{}.json",
            sha256_hex(fixture.logical_session_id.as_bytes())
        ));
        let payload = serde_json::to_vec(&json!({
            "schema_version": 1,
            "logical_session_id": fixture.logical_session_id,
            "workspace_id": fixture.workspace_id,
            "session_name": fixture.session_name,
            "restore_generation": 1,
            "launch_recipe": {
                "kind": "shell",
                "program": fixture.program,
                "arguments": fixture.arguments,
                "restore_cwd": fixture.restore_cwd,
            },
            "restore_policy": fixture.restore_policy,
            "predecessor_runtime": null,
            "last_runtime": null,
            "created_unix_ms": 10,
            "updated_unix_ms": 10,
        }))
        .unwrap();
        write_private_file(&path, &payload);
        path
    }

    fn write_private_file(path: &Path, payload: &[u8]) {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(path).unwrap();
        file.write_all(payload).unwrap();
        file.sync_all().unwrap();
    }
}
