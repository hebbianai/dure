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
    recipe.validate()?;
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
    let payload = serde_json::to_vec(recipe)?;
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

pub(crate) fn read_resurrection_recipe(
    discovery_root: &Path,
    session_name: &str,
) -> Result<StandaloneResurrectionRecipe> {
    fault_inject_resurrection_recipe_read()?;
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
    let recipe: StandaloneResurrectionRecipe = serde_json::from_slice(&payload)?;
    recipe.validate()?;
    if recipe.session_name() != session_name {
        return Err("standalone resurrection recipe name changed".into());
    }
    Ok(recipe)
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
