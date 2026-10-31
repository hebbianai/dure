//! Atomic storage and exact rollback for standalone resurrection recipes.

use hmux_host::local_discovery::SessionRetirementPolicy;
use hmux_runtime_contract::StandaloneResurrectionRecipe;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

type DynError = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, DynError>;

#[cfg(debug_assertions)]
const RESURRECTION_RECIPE_DIRECTORY_SYNC_FAULT_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_RECIPE_DIRECTORY_SYNC_FAULT_MARKER";
#[cfg(debug_assertions)]
static RESURRECTION_RECIPE_DIRECTORY_SYNC_ATTEMPTS: AtomicU64 = AtomicU64::new(0);
#[cfg(debug_assertions)]
const RESURRECTION_RECIPE_READ_FAULT_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_RECIPE_READ_FAULT_MARKER";
#[cfg(debug_assertions)]
static RESURRECTION_RECIPE_READ_ATTEMPTS: AtomicU64 = AtomicU64::new(0);
const MAX_RESURRECTION_RECIPE_BYTES: u64 = 256 * 1024;
// Audit history is bounded so retained audits can never push a plain recipe
// save past the 256 KiB storage limit.
const MAX_SUPERSEDE_AUDIT_HISTORY: usize = 16;

pub(crate) fn save_resurrection_recipe(
    discovery_root: &Path,
    recipe: &StandaloneResurrectionRecipe,
) -> Result<()> {
    prepare_resurrection_recipe(discovery_root, recipe)?
        .commit()
        .map_err(|error| Box::new(error) as DynError)
}

pub(crate) fn read_optional_resurrection_recipe(
    discovery_root: &Path,
    session_name: &str,
) -> Result<Option<StandaloneResurrectionRecipe>> {
    match read_resurrection_recipe(discovery_root, session_name) {
        Ok(recipe) => Ok(Some(recipe)),
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecipePublicationFailureStage {
    Unpublished,
    PublishedDurabilityUncertain,
    PublishedDurableReadback,
}

#[derive(Debug)]
pub(crate) struct RecipePublicationError {
    stage: RecipePublicationFailureStage,
    source: DynError,
}

impl RecipePublicationError {
    fn new(stage: RecipePublicationFailureStage, source: impl Into<DynError>) -> Self {
        Self {
            stage,
            source: source.into(),
        }
    }

    pub(crate) const fn stage(&self) -> RecipePublicationFailureStage {
        self.stage
    }
}

impl std::fmt::Display for RecipePublicationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "resurrection recipe publication failed at {:?}: {}",
            self.stage, self.source
        )
    }
}

impl std::error::Error for RecipePublicationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

pub(crate) struct PreparedResurrectionRecipe {
    discovery_root: PathBuf,
    directory: PathBuf,
    path: PathBuf,
    temporary: PathBuf,
    recipe: StandaloneResurrectionRecipe,
    published: bool,
}

impl PreparedResurrectionRecipe {
    pub(crate) fn commit(mut self) -> std::result::Result<(), RecipePublicationError> {
        fs::rename(&self.temporary, &self.path).map_err(|error| {
            RecipePublicationError::new(RecipePublicationFailureStage::Unpublished, error)
        })?;
        self.published = true;
        if sync_resurrection_recipe_directory(&self.directory).is_err() {
            // Rename is the visibility boundary. A directory fsync error does
            // not tell us whether publication happened, so read back the exact
            // value and retry the durability operation before reporting an
            // error that would make the caller roll the transaction back.
            let observed =
                read_resurrection_recipe(&self.discovery_root, self.recipe.session_name())
                    .map_err(|error| {
                        RecipePublicationError::new(
                            RecipePublicationFailureStage::PublishedDurabilityUncertain,
                            error,
                        )
                    })?;
            if observed != self.recipe {
                return Err(RecipePublicationError::new(
                    RecipePublicationFailureStage::PublishedDurabilityUncertain,
                    "resurrection recipe changed after atomic publication",
                ));
            }
            sync_resurrection_recipe_directory(&self.directory).map_err(|error| {
                RecipePublicationError::new(
                    RecipePublicationFailureStage::PublishedDurabilityUncertain,
                    error,
                )
            })?;
        }
        let persisted = read_resurrection_recipe(&self.discovery_root, self.recipe.session_name())
            .map_err(|error| {
                RecipePublicationError::new(
                    RecipePublicationFailureStage::PublishedDurableReadback,
                    error,
                )
            })?;
        if persisted != self.recipe {
            return Err(RecipePublicationError::new(
                RecipePublicationFailureStage::PublishedDurableReadback,
                "resurrection recipe exact readback did not match publication",
            ));
        }
        Ok(())
    }
}

impl Drop for PreparedResurrectionRecipe {
    fn drop(&mut self) {
        if !self.published && fs::remove_file(&self.temporary).is_ok() {
            let _ = File::open(&self.directory).and_then(|directory| directory.sync_all());
        }
    }
}

pub(crate) fn prepare_resurrection_recipe(
    discovery_root: &Path,
    recipe: &StandaloneResurrectionRecipe,
) -> Result<PreparedResurrectionRecipe> {
    let mut payload = serde_json::to_value(recipe)?;
    if let Some(mut audit) = read_supersede_audit(discovery_root, recipe.session_name())? {
        // A plain save ends the previous supersede attempt: drop its request
        // binding so a repeated supersede key is validated as a new attempt,
        // not mistaken for a retry.
        if let Some(record) = audit.as_object_mut() {
            record.remove("requestBinding");
        }
        payload["supersedeAudit"] = audit;
    }
    prepare_recipe_payload(discovery_root, recipe, serde_json::to_vec(&payload)?)
}

fn prepare_recipe_payload(
    discovery_root: &Path,
    recipe: &StandaloneResurrectionRecipe,
    payload: Vec<u8>,
) -> Result<PreparedResurrectionRecipe> {
    recipe.validate()?;
    if payload.len() as u64 > MAX_RESURRECTION_RECIPE_BYTES {
        return Err("standalone resurrection recipe and audit exceed the storage limit".into());
    }
    let _: serde_json::Value = serde_json::from_slice(&payload)?;
    let directory = discovery_root.join(".resurrection");
    fs::create_dir_all(&directory)?;
    let metadata = fs::symlink_metadata(&directory)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        // SAFETY: geteuid has no arguments and does not dereference memory.
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("standalone resurrection directory is not private".into());
    }
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let mut digest = Sha256::new();
    digest.update(recipe.session_name().as_bytes());
    let digest = format!("{:x}", digest.finalize());
    let path = directory.join(format!("recipe_{}.json", &digest[..32]));
    // One deterministic pending entry per session bounds SIGKILL residue.
    // Recipe publication is ordered before the Ready manifest, so this file is
    // never treated as authority: a later save removes it and starts from the
    // exact canonical recipe selected by reboot recovery.
    let temporary = directory.join(format!(".recipe_{}.pending", &digest[..32]));
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    if let Err(error) = file.write_all(&payload).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    // The next value must itself be recoverable before the manifest
    // publication boundary. File fsync alone does not make the newly-created
    // temporary directory entry durable across a power loss.
    if let Err(error) = File::open(&directory).and_then(|directory| directory.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(PreparedResurrectionRecipe {
        discovery_root: discovery_root.to_path_buf(),
        directory,
        path,
        temporary,
        recipe: recipe.clone(),
        published: false,
    })
}

// Publish the audit and the retry binding in the same rename as the recipe.
// The binding holds only the idempotency key and a request hash: the request
// itself carries launchOwnerProof and terminal environment, which must not
// accumulate in persisted history.
pub(crate) fn prepare_superseding_recipe(
    discovery_root: &Path,
    previous: &StandaloneResurrectionRecipe,
    recipe: &StandaloneResurrectionRecipe,
    request: &hmux_runtime_contract::StandaloneCreateRequest,
) -> Result<PreparedResurrectionRecipe> {
    let mut payload = serde_json::to_value(recipe)?;
    let mut history = Vec::new();
    if let Some(mut previous_audit) = read_supersede_audit(discovery_root, recipe.session_name())? {
        if let Some(entries) = previous_audit
            .get_mut("history")
            .and_then(serde_json::Value::as_array_mut)
        {
            history.append(entries);
        }
        if let Some(record) = previous_audit.as_object_mut() {
            record.remove("history");
        }
        history.push(previous_audit);
    }
    if history.len() > MAX_SUPERSEDE_AUDIT_HISTORY {
        history.drain(..history.len() - MAX_SUPERSEDE_AUDIT_HISTORY);
    }
    payload["supersedeAudit"] = serde_json::json!({
        "previousRecipe": previous,
        "history": history,
        "supersededUnixMs": recipe.created_unix_ms(),
        "requestBinding": {
            "idempotencyKey": request
                .recovery_identity()
                .map(hmux_client::standalone_create_idempotency_key),
            "requestSha256": supersede_request_fingerprint(request)?,
        },
    });
    prepare_recipe_payload(discovery_root, recipe, serde_json::to_vec(&payload)?)
}

pub(crate) fn supersede_request_fingerprint(
    request: &hmux_runtime_contract::StandaloneCreateRequest,
) -> Result<String> {
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(request)?);
    Ok(format!("{:x}", digest.finalize()))
}

fn read_supersede_audit(
    discovery_root: &Path,
    session_name: &str,
) -> Result<Option<serde_json::Value>> {
    match read_recipe_payload(discovery_root, session_name) {
        Ok(payload) => {
            let value: serde_json::Value = serde_json::from_slice(&payload)?;
            Ok(value.get("supersedeAudit").cloned())
        }
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SupersedeRequestBinding {
    pub(crate) idempotency_key: Option<String>,
    pub(crate) request_sha256: String,
}

pub(crate) fn supersede_request_binding(
    discovery_root: &Path,
    session_name: &str,
) -> Result<Option<SupersedeRequestBinding>> {
    let payload = read_recipe_payload(discovery_root, session_name)?;
    let value: serde_json::Value = serde_json::from_slice(&payload)?;
    value
        .get("supersedeAudit")
        .and_then(|audit| audit.get("requestBinding"))
        .map(|binding| serde_json::from_value(binding.clone()).map_err(Into::into))
        .transpose()
}

pub(crate) fn read_resurrection_recipe(
    discovery_root: &Path,
    session_name: &str,
) -> Result<StandaloneResurrectionRecipe> {
    fault_inject_resurrection_recipe_read()?;
    let payload = read_recipe_payload(discovery_root, session_name)?;
    let recipe: StandaloneResurrectionRecipe = serde_json::from_slice(&payload)?;
    recipe.validate()?;
    if recipe.session_name() != session_name {
        return Err("standalone resurrection recipe name changed".into());
    }
    Ok(recipe)
}

fn read_recipe_payload(discovery_root: &Path, session_name: &str) -> Result<Vec<u8>> {
    let directory = discovery_root.join(".resurrection");
    let metadata = fs::symlink_metadata(&directory)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        // SAFETY: geteuid has no arguments and does not dereference memory.
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("standalone resurrection directory is not private".into());
    }
    let mut digest = Sha256::new();
    digest.update(session_name.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    let path = directory.join(format!("recipe_{}.json", &digest[..32]));
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > MAX_RESURRECTION_RECIPE_BYTES
    {
        return Err("standalone resurrection recipe is not a private bounded file".into());
    }
    let mut payload = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.read_to_end(&mut payload)?;
    Ok(payload)
}

pub(crate) fn remove_resurrection_recipe_exact(
    discovery_root: &Path,
    expected: &StandaloneResurrectionRecipe,
) -> Result<()> {
    let observed = match read_resurrection_recipe(discovery_root, expected.session_name()) {
        Ok(observed) => observed,
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if observed != *expected {
        return Err("standalone resurrection recipe changed before rollback".into());
    }
    let directory = discovery_root.join(".resurrection");
    let mut digest = Sha256::new();
    digest.update(expected.session_name().as_bytes());
    let digest = format!("{:x}", digest.finalize());
    fs::remove_file(directory.join(format!("recipe_{}.json", &digest[..32])))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

fn fault_inject_resurrection_recipe_read() -> Result<()> {
    #[cfg(debug_assertions)]
    if let Some(marker) = env::var_os(RESURRECTION_RECIPE_READ_FAULT_MARKER_ENV) {
        let marker = PathBuf::from(marker);
        if marker.is_absolute() {
            if let Some(target) = fs::read_to_string(&marker)
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
            {
                let attempt = RESURRECTION_RECIPE_READ_ATTEMPTS
                    .fetch_add(1, Ordering::SeqCst)
                    .saturating_add(1);
                if attempt == target {
                    return Err(io::Error::other(
                        "fault-injected resurrection recipe read failure",
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

fn sync_resurrection_recipe_directory(directory: &Path) -> Result<()> {
    #[cfg(debug_assertions)]
    if let Some(marker) = env::var_os(RESURRECTION_RECIPE_DIRECTORY_SYNC_FAULT_MARKER_ENV) {
        let marker = PathBuf::from(marker);
        if marker.is_absolute() {
            if let Ok(limit) = fs::read_to_string(&marker)
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .ok_or(())
            {
                let attempt = RESURRECTION_RECIPE_DIRECTORY_SYNC_ATTEMPTS
                    .fetch_add(1, Ordering::SeqCst)
                    .saturating_add(1);
                if attempt <= limit {
                    return Err(io::Error::other(
                        "fault-injected resurrection recipe directory sync failure",
                    )
                    .into());
                }
            }
        }
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub(crate) fn rebuild_resurrection_recipe_with_policy(
    recipe: &StandaloneResurrectionRecipe,
    policy: Option<SessionRetirementPolicy>,
) -> Result<StandaloneResurrectionRecipe> {
    let rebuilt = StandaloneResurrectionRecipe::new(
        recipe.session_name(),
        recipe.provider_cwd(),
        recipe.command().to_vec(),
        recipe.initial_rows(),
        recipe.initial_columns(),
        recipe.created_unix_ms(),
    )?
    .with_resurrection_replay_policy(recipe.resurrection_replay_policy())?
    .with_terminal_environment(recipe.terminal_environment().clone())?
    .with_terminal_default_colors_option(recipe.terminal_default_colors())?;
    match policy {
        Some(policy) => Ok(rebuilt.with_retirement_policy(policy)?),
        None => Ok(rebuilt),
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod supersede_audit_tests {
    use super::*;
    use hmux_runtime_contract::{StandaloneCreateRequest, StandaloneRecoveryCreateIdentity};

    #[test]
    fn supersede_audit_is_atomic_private_and_retained_by_later_saves() {
        let state = tempfile::tempdir().unwrap();
        let previous =
            StandaloneResurrectionRecipe::new("audit", "/tmp", vec!["old".into()], 24, 80, 1)
                .unwrap();
        let next =
            StandaloneResurrectionRecipe::new("audit", "/tmp", vec!["new".into()], 25, 81, 2)
                .unwrap();
        let identity =
            StandaloneRecoveryCreateIdentity::new("standalone_target01", "private-proof").unwrap();
        let request =
            StandaloneCreateRequest::new("/tmp", Some("audit".into()), vec!["new".into()], 25, 81)
                .unwrap()
                .with_recovery_identity(identity.clone())
                .unwrap();
        save_resurrection_recipe(state.path(), &previous).unwrap();
        let prepared =
            prepare_superseding_recipe(state.path(), &previous, &next, &request).unwrap();
        assert_eq!(
            read_resurrection_recipe(state.path(), "audit").unwrap(),
            previous
        );
        assert!(
            supersede_request_binding(state.path(), "audit")
                .unwrap()
                .is_none()
        );
        prepared.commit().unwrap();
        assert_eq!(
            read_resurrection_recipe(state.path(), "audit").unwrap(),
            next
        );
        assert_eq!(
            supersede_request_binding(state.path(), "audit").unwrap(),
            Some(SupersedeRequestBinding {
                idempotency_key: Some(
                    hmux_client::standalone_create_idempotency_key(&identity)
                ),
                request_sha256: supersede_request_fingerprint(&request).unwrap(),
            })
        );
        // The audit retains only the key and hash; the request body (owner
        // proof, terminal environment) must never land in persisted history.
        let audit = read_supersede_audit(state.path(), "audit")
            .unwrap()
            .unwrap();
        assert!(audit.get("request").is_none());
        assert!(!audit.to_string().contains("private-proof"));
        save_resurrection_recipe(state.path(), &next).unwrap();
        // A plain save ends the previous binding: a repeated supersede key is a
        // new attempt, not a retry.
        assert!(
            supersede_request_binding(state.path(), "audit")
                .unwrap()
                .is_none()
        );
        let audit = read_supersede_audit(state.path(), "audit")
            .unwrap()
            .unwrap();
        assert_eq!(
            audit["previousRecipe"],
            serde_json::to_value(previous).unwrap()
        );
        assert_eq!(audit["supersededUnixMs"], 2);
        let third =
            StandaloneResurrectionRecipe::new("audit", "/tmp", vec!["third".into()], 25, 81, 3)
                .unwrap();
        let third_request = StandaloneCreateRequest::new(
            "/tmp",
            Some("audit".into()),
            vec!["third".into()],
            25,
            81,
        )
        .unwrap();
        prepare_superseding_recipe(state.path(), &next, &third, &third_request)
            .unwrap()
            .commit()
            .unwrap();
        let audit = read_supersede_audit(state.path(), "audit")
            .unwrap()
            .unwrap();
        assert_eq!(audit["history"].as_array().unwrap().len(), 1);
        assert!(audit["history"][0].get("history").is_none());
        assert_eq!(audit["history"][0]["supersededUnixMs"], 2);
        assert_eq!(audit["supersededUnixMs"], 3);
        for entry in fs::read_dir(state.path().join(".resurrection")).unwrap() {
            assert_eq!(
                entry.unwrap().metadata().unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }

    #[test]
    fn oversized_audit_does_not_replace_the_canonical_recipe() {
        let state = tempfile::tempdir().unwrap();
        let recipe = StandaloneResurrectionRecipe::new("audit", "/tmp", vec![], 24, 80, 1).unwrap();
        save_resurrection_recipe(state.path(), &recipe).unwrap();
        assert!(
            prepare_recipe_payload(
                state.path(),
                &recipe,
                vec![0; MAX_RESURRECTION_RECIPE_BYTES as usize + 1]
            )
            .is_err()
        );
        assert_eq!(
            read_resurrection_recipe(state.path(), "audit").unwrap(),
            recipe
        );
    }
    #[test]
    fn flat_audit_remains_readable_after_150_replacements() {
        let state = tempfile::tempdir().unwrap();
        let mut previous =
            StandaloneResurrectionRecipe::new("audit", "/tmp", vec![], 24, 80, 1).unwrap();
        let request =
            StandaloneCreateRequest::new("/tmp", Some("audit".into()), vec![], 24, 80).unwrap();
        save_resurrection_recipe(state.path(), &previous).unwrap();
        for index in 0..150 {
            let next =
                StandaloneResurrectionRecipe::new("audit", "/tmp", vec![], 24, 80, index + 2)
                    .unwrap();
            prepare_superseding_recipe(state.path(), &previous, &next, &request)
                .unwrap()
                .commit()
                .unwrap();
            assert_eq!(
                read_resurrection_recipe(state.path(), "audit").unwrap(),
                next
            );
            previous = next;
        }
        let audit = read_supersede_audit(state.path(), "audit")
            .unwrap()
            .unwrap();
        let history = audit["history"].as_array().unwrap();
        assert_eq!(history.len(), MAX_SUPERSEDE_AUDIT_HISTORY);
        assert!(history.iter().all(|entry| entry.get("history").is_none()));
        assert_eq!(
            history[0]["supersededUnixMs"],
            151 - MAX_SUPERSEDE_AUDIT_HISTORY
        );
        assert_eq!(audit["supersededUnixMs"], 151);
    }

    #[test]
    fn excessive_json_depth_is_refused_before_publication() {
        let state = tempfile::tempdir().unwrap();
        let recipe = StandaloneResurrectionRecipe::new("audit", "/tmp", vec![], 24, 80, 1).unwrap();
        save_resurrection_recipe(state.path(), &recipe).unwrap();
        let payload = format!("{}0{}", "[".repeat(150), "]".repeat(150)).into_bytes();
        assert!(prepare_recipe_payload(state.path(), &recipe, payload).is_err());
        assert_eq!(
            read_resurrection_recipe(state.path(), "audit").unwrap(),
            recipe
        );
        assert_eq!(
            fs::read_dir(state.path().join(".resurrection"))
                .unwrap()
                .count(),
            1
        );
    }
}
