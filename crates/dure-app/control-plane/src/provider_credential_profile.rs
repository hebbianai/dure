use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dure_app::{
    AgentExecutionProfileV1, DomainStoreErrorV1, PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
    ProviderCredentialProfileDirectoryNameV1, ProviderCredentialProfileRegistrationV1,
    ProviderCredentialProfileStore, ProviderCredentialProfileV1, ProviderIdV1,
    provider_credential_environment_policy_v1,
};
use hmux_client::ProviderStateEnvironment;
use serde::Deserialize;

#[path = "provider_credential_profile_marker.rs"]
mod marker;

use marker::{
    new_credential_generation, observe_profile_directory, publish_profile_generation,
    read_profile_generation, reobserve_same_profile_directory,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterProviderCredentialProfileBodyV1 {
    pub schema_version: u16,
    pub provider_id: String,
    pub reference_id: String,
    pub profile_directory_name: String,
}

#[derive(Clone)]
pub struct ResolvedProviderCredentialProfileV1 {
    profile: ProviderCredentialProfileV1,
    directory: PathBuf,
    directory_device: u64,
    directory_inode: u64,
}

pub(crate) struct PreparedProviderCredentialLaunchV1 {
    resolved: Option<ResolvedProviderCredentialProfileV1>,
    environment: ProviderStateEnvironment,
}

impl PreparedProviderCredentialLaunchV1 {
    pub(crate) fn resolved(&self) -> Option<&ResolvedProviderCredentialProfileV1> {
        self.resolved.as_ref()
    }

    pub(crate) fn environment(&self) -> ProviderStateEnvironment {
        self.environment.clone()
    }
}

pub(crate) trait ProviderCredentialProfileLaunchPreparer: Send + Sync {
    fn prepare(
        &self,
        provider_id: &ProviderIdV1,
        directory: &Path,
    ) -> Result<
        dure_provider_profile::PreparedProviderProfileLaunch,
        ProviderCredentialProfileErrorV1,
    >;

    fn prepare_default(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<ProviderStateEnvironment, ProviderCredentialProfileErrorV1> {
        native_provider_state_environment(provider_id, None)
    }
}

pub(crate) struct NativeProviderCredentialProfileLaunchPreparer {
    dure_home: PathBuf,
    platform_home: Option<PathBuf>,
}

impl NativeProviderCredentialProfileLaunchPreparer {
    pub(crate) fn new(dure_home: PathBuf, platform_home: Option<PathBuf>) -> Self {
        Self {
            dure_home,
            platform_home,
        }
    }
}

impl ProviderCredentialProfileLaunchPreparer for NativeProviderCredentialProfileLaunchPreparer {
    fn prepare(
        &self,
        provider_id: &ProviderIdV1,
        directory: &Path,
    ) -> Result<
        dure_provider_profile::PreparedProviderProfileLaunch,
        ProviderCredentialProfileErrorV1,
    > {
        let platform_home = self
            .platform_home
            .as_deref()
            .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
        dure_provider_profile::prepare_provider_profile_launch(
            provider_id.as_str(),
            &self.dure_home,
            platform_home,
            directory,
            None,
        )
        .map_err(|error| {
            let code = error
                .split(':')
                .next()
                .unwrap_or("provider_profile_prepare_failed");
            eprintln!("dure-control-plane: provider profile preparation failed: {code}");
            ProviderCredentialProfileErrorV1::Unavailable
        })
    }

    fn prepare_default(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<ProviderStateEnvironment, ProviderCredentialProfileErrorV1> {
        if let Some(platform_home) = self.platform_home.as_deref() {
            dure_provider_profile::prepare_provider_default_profile_state(
                provider_id.as_str(),
                &self.dure_home,
                platform_home,
            );
        }
        native_provider_state_environment(provider_id, None)
    }
}

/// Durable backend registration identity for a provider that the native
/// session adapter has already launched. Unlike
/// `ResolvedProviderCredentialProfileV1`, this does not re-open credential
/// files and cannot authorize a new provider launch.
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RegisteredProviderCredentialProfileV1 {
    profile: ProviderCredentialProfileV1,
    profile_directory_name: ProviderCredentialProfileDirectoryNameV1,
    profile_device: u64,
    profile_inode: u64,
}

impl RegisteredProviderCredentialProfileV1 {
    pub(crate) fn profile(&self) -> &ProviderCredentialProfileV1 {
        &self.profile
    }
}

impl ResolvedProviderCredentialProfileV1 {
    pub fn profile(&self) -> &ProviderCredentialProfileV1 {
        &self.profile
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        provider_id: &str,
        reference_id: &str,
        credential_generation: &str,
        directory: PathBuf,
    ) -> Self {
        let metadata = std::fs::symlink_metadata(&directory).expect("test profile directory");
        use std::os::unix::fs::MetadataExt;
        Self {
            profile: ProviderCredentialProfileV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: ProviderIdV1::new(provider_id).expect("valid test provider"),
                reference_id: reference_id.into(),
                credential_generation: credential_generation.into(),
            },
            directory,
            directory_device: metadata.dev(),
            directory_inode: metadata.ino(),
        }
    }
}

impl fmt::Debug for ResolvedProviderCredentialProfileV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedProviderCredentialProfileV1")
            .field("profile", &self.profile)
            .field("directory", &"<redacted>")
            .finish()
    }
}

/// Convert a generation-fenced profile handle into the private launch
/// environment understood by the native provider adapter. The environment is
/// never persisted in the spawn journal or returned to clients.
pub(crate) fn native_provider_state_environment(
    provider_id: &ProviderIdV1,
    resolved: Option<&ResolvedProviderCredentialProfileV1>,
) -> Result<ProviderStateEnvironment, ProviderCredentialProfileErrorV1> {
    let policy = provider_credential_environment_policy_v1(provider_id.as_str());
    let Some(resolved) = resolved else {
        let Some(policy) = policy else {
            return Ok(ProviderStateEnvironment::default());
        };
        let removals = policy
            .state_roots()
            .iter()
            .map(ToString::to_string)
            .collect();
        return ProviderStateEnvironment::from_mutations(BTreeMap::new(), removals)
            .map_err(|_| ProviderCredentialProfileErrorV1::Unavailable);
    };
    let policy = policy.ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
    if resolved.profile().provider_id != *provider_id {
        return Err(ProviderCredentialProfileErrorV1::Unavailable);
    }
    let directory = resolved
        .directory()
        .to_str()
        .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
    let values = if provider_id.as_str() == "codex" {
        let home = std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
        let sqlite_home = home
            .join(".codex")
            .to_str()
            .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?
            .to_owned();
        BTreeMap::from([
            (policy.state_roots()[0].to_string(), directory.into()),
            (policy.state_roots()[1].to_string(), sqlite_home),
        ])
    } else {
        policy
            .state_roots()
            .iter()
            .map(|state_root| ((*state_root).to_string(), directory.to_owned()))
            .collect()
    };
    let removals = policy
        .selected_environment_removals()
        .iter()
        .map(ToString::to_string)
        .collect();
    ProviderStateEnvironment::from_mutations(values, removals)
        .map_err(|_| ProviderCredentialProfileErrorV1::Unavailable)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderCredentialProfileErrorV1 {
    RequestInvalid,
    Unavailable,
    Conflict,
    StaleGeneration,
    StoreFailed,
}

impl ProviderCredentialProfileErrorV1 {
    pub fn code(self) -> &'static str {
        match self {
            Self::RequestInvalid => "provider_credential_profile_request_invalid",
            Self::Unavailable => "provider_credential_profile_unavailable",
            Self::Conflict => "provider_credential_profile_conflict",
            Self::StaleGeneration => "provider_credential_profile_stale_generation",
            Self::StoreFailed => "provider_credential_profile_store_failed",
        }
    }
}

pub struct ProviderCredentialProfileRegistry<S> {
    home: PathBuf,
    store: Arc<S>,
    launch_preparer: Arc<dyn ProviderCredentialProfileLaunchPreparer>,
}

impl<S> ProviderCredentialProfileRegistry<S>
where
    S: ProviderCredentialProfileStore,
{
    pub fn new(home: PathBuf, store: Arc<S>) -> Self {
        Self::with_launch_preparer(
            home.clone(),
            store,
            Arc::new(NativeProviderCredentialProfileLaunchPreparer::new(
                home.clone(),
                Some(home),
            )),
        )
    }

    pub(crate) fn with_platform_home(
        home: PathBuf,
        platform_home: Option<PathBuf>,
        store: Arc<S>,
    ) -> Self {
        Self::with_launch_preparer(
            home.clone(),
            store,
            Arc::new(NativeProviderCredentialProfileLaunchPreparer::new(
                home,
                platform_home,
            )),
        )
    }

    pub(crate) fn with_launch_preparer(
        home: PathBuf,
        store: Arc<S>,
        launch_preparer: Arc<dyn ProviderCredentialProfileLaunchPreparer>,
    ) -> Self {
        Self {
            home,
            store,
            launch_preparer,
        }
    }

    pub(crate) async fn register(
        &self,
        body: RegisterProviderCredentialProfileBodyV1,
    ) -> Result<ProviderCredentialProfileV1, ProviderCredentialProfileErrorV1> {
        if body.schema_version != PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1 {
            return Err(ProviderCredentialProfileErrorV1::RequestInvalid);
        }
        let provider_id = ProviderIdV1::new(body.provider_id)
            .map_err(|_| ProviderCredentialProfileErrorV1::RequestInvalid)?;
        let profile_directory_name = ProviderCredentialProfileDirectoryNameV1::new(
            &provider_id,
            body.profile_directory_name,
        )
        .map_err(|_| ProviderCredentialProfileErrorV1::RequestInvalid)?;
        ProviderCredentialProfileV1 {
            schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
            provider_id: provider_id.clone(),
            reference_id: body.reference_id.clone(),
            credential_generation: "credential-v2-validation".into(),
        }
        .validate()
        .map_err(|_| ProviderCredentialProfileErrorV1::RequestInvalid)?;
        let existing = self
            .store
            .provider_credential_profile(&provider_id, &body.reference_id)
            .await
            .map_err(map_store_error)?;
        if existing.as_ref().is_some_and(|registration| {
            registration.profile_directory_name != profile_directory_name
        }) {
            return Err(ProviderCredentialProfileErrorV1::Conflict);
        }
        let observation = observe_profile_directory(
            &self.home,
            &profile_directory_name,
            ProviderCredentialProfileErrorV1::Unavailable,
        )?;
        let marker_generation = read_profile_generation(
            &observation,
            &provider_id,
            &body.reference_id,
            ProviderCredentialProfileErrorV1::Conflict,
        )?;
        let credential_generation = match marker_generation.as_ref() {
            Some(generation) => generation.clone(),
            None => match existing
                .as_ref()
                .filter(|registration| registration.profile_inode == observation.inode)
            {
                Some(registration) => registration.profile.credential_generation.clone(),
                None => new_credential_generation(&provider_id, &body.reference_id)?,
            },
        };
        let mut registration = ProviderCredentialProfileRegistrationV1 {
            profile: ProviderCredentialProfileV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: provider_id.clone(),
                reference_id: body.reference_id.clone(),
                credential_generation,
            },
            profile_directory_name: profile_directory_name.clone(),
            profile_device: observation.device,
            profile_inode: observation.inode,
        };
        registration
            .validate()
            .map_err(|_| ProviderCredentialProfileErrorV1::RequestInvalid)?;
        let stored = match self
            .store
            .register_provider_credential_profile(
                existing
                    .as_ref()
                    .map(|registration| registration.profile.credential_generation.as_str()),
                &registration,
            )
            .await
        {
            Ok(stored) => stored,
            Err(DomainStoreErrorV1::IdentityConflict { .. }) => {
                let converged = self
                    .store
                    .provider_credential_profile(&provider_id, &body.reference_id)
                    .await
                    .map_err(map_store_error)?
                    .ok_or(ProviderCredentialProfileErrorV1::Conflict)?;
                if converged.profile_directory_name != profile_directory_name
                    || converged.profile_inode != observation.inode
                    || marker_generation.as_ref().is_some_and(|generation| {
                        generation != &converged.profile.credential_generation
                    })
                {
                    return Err(ProviderCredentialProfileErrorV1::Conflict);
                }
                registration.profile.credential_generation =
                    converged.profile.credential_generation.clone();
                self.store
                    .register_provider_credential_profile(
                        Some(converged.profile.credential_generation.as_str()),
                        &registration,
                    )
                    .await
                    .map_err(map_store_error)?
            }
            Err(error) => return Err(map_store_error(error)),
        };
        publish_profile_generation(
            &observation,
            &provider_id,
            &body.reference_id,
            &stored.profile.credential_generation,
            ProviderCredentialProfileErrorV1::Conflict,
        )?;
        let final_observation = reobserve_same_profile_directory(
            &self.home,
            &profile_directory_name,
            &observation,
            ProviderCredentialProfileErrorV1::Conflict,
        )?;
        if read_profile_generation(
            &final_observation,
            &provider_id,
            &body.reference_id,
            ProviderCredentialProfileErrorV1::Conflict,
        )?
        .as_deref()
            != Some(stored.profile.credential_generation.as_str())
        {
            return Err(ProviderCredentialProfileErrorV1::Conflict);
        }
        let final_registration = self
            .store
            .provider_credential_profile(&provider_id, &body.reference_id)
            .await
            .map_err(map_store_error)?
            .ok_or(ProviderCredentialProfileErrorV1::Conflict)?;
        if final_registration.profile_directory_name != profile_directory_name
            || final_registration.profile.credential_generation
                != stored.profile.credential_generation
            || final_registration.profile_inode != final_observation.inode
        {
            return Err(ProviderCredentialProfileErrorV1::Conflict);
        }
        Ok(final_registration.profile)
    }

    /// Resolve a public execution profile into a private, generation-fenced
    /// launch handle. Provider-default execution requires no registry entry.
    pub async fn resolve(
        &self,
        provider_id: &ProviderIdV1,
        execution_profile: &AgentExecutionProfileV1,
    ) -> Result<Option<ResolvedProviderCredentialProfileV1>, ProviderCredentialProfileErrorV1> {
        let AgentExecutionProfileV1::CredentialReference {
            reference_id,
            credential_generation: Some(expected_generation),
        } = execution_profile
        else {
            return match execution_profile {
                AgentExecutionProfileV1::ProviderDefault => Ok(None),
                AgentExecutionProfileV1::CredentialReference { .. } => {
                    Err(ProviderCredentialProfileErrorV1::StaleGeneration)
                }
            };
        };
        let registration = self
            .store
            .provider_credential_profile(provider_id, reference_id)
            .await
            .map_err(map_store_error)?
            .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
        if registration.profile.credential_generation != *expected_generation {
            return Err(ProviderCredentialProfileErrorV1::StaleGeneration);
        }
        let observation = observe_profile_directory(
            &self.home,
            &registration.profile_directory_name,
            ProviderCredentialProfileErrorV1::Unavailable,
        )?;
        let marker_generation = read_profile_generation(
            &observation,
            provider_id,
            reference_id,
            ProviderCredentialProfileErrorV1::StaleGeneration,
        )?;
        match marker_generation.as_deref() {
            Some(generation)
                if generation == registration.profile.credential_generation.as_str() => {}
            Some(_) => return Err(ProviderCredentialProfileErrorV1::StaleGeneration),
            None if observation.inode == registration.profile_inode => {
                publish_profile_generation(
                    &observation,
                    provider_id,
                    reference_id,
                    &registration.profile.credential_generation,
                    ProviderCredentialProfileErrorV1::StaleGeneration,
                )?;
            }
            None => return Err(ProviderCredentialProfileErrorV1::StaleGeneration),
        }
        let final_observation = reobserve_same_profile_directory(
            &self.home,
            &registration.profile_directory_name,
            &observation,
            ProviderCredentialProfileErrorV1::StaleGeneration,
        )?;
        if read_profile_generation(
            &final_observation,
            provider_id,
            reference_id,
            ProviderCredentialProfileErrorV1::StaleGeneration,
        )?
        .as_deref()
            != Some(registration.profile.credential_generation.as_str())
        {
            return Err(ProviderCredentialProfileErrorV1::StaleGeneration);
        }
        let final_registration = self
            .store
            .provider_credential_profile(provider_id, reference_id)
            .await
            .map_err(map_store_error)?
            .ok_or(ProviderCredentialProfileErrorV1::StaleGeneration)?;
        if final_registration.profile_directory_name != registration.profile_directory_name
            || final_registration.profile.credential_generation
                != registration.profile.credential_generation
        {
            return Err(ProviderCredentialProfileErrorV1::StaleGeneration);
        }
        Ok(Some(ResolvedProviderCredentialProfileV1 {
            profile: final_registration.profile,
            directory: final_observation.canonical_path,
            directory_device: final_observation.device,
            directory_inode: final_observation.inode,
        }))
    }

    /// Prepare one generation-fenced profile at the last boundary before exec.
    pub(crate) async fn prepare_for_launch(
        &self,
        provider_id: &ProviderIdV1,
        execution_profile: &AgentExecutionProfileV1,
    ) -> Result<PreparedProviderCredentialLaunchV1, ProviderCredentialProfileErrorV1> {
        let resolved = self.resolve(provider_id, execution_profile).await?;
        let prepared_launch = match resolved.as_ref() {
            Some(profile) => Some(
                self.launch_preparer
                    .prepare(provider_id, profile.directory())?,
            ),
            None => None,
        };
        let prepared = self.resolve(provider_id, execution_profile).await?;
        if resolved.as_ref().map(|profile| profile.profile())
            != prepared.as_ref().map(|profile| profile.profile())
            || resolved.as_ref().map(|profile| profile.directory())
                != prepared.as_ref().map(|profile| profile.directory())
            || resolved
                .as_ref()
                .map(|profile| (profile.directory_device, profile.directory_inode))
                != prepared
                    .as_ref()
                    .map(|profile| (profile.directory_device, profile.directory_inode))
        {
            return Err(ProviderCredentialProfileErrorV1::StaleGeneration);
        }
        let environment = match (prepared.as_ref(), prepared_launch) {
            (Some(profile), Some(launch))
                if launch.directory() == profile.directory()
                    && launch.directory_device() == profile.directory_device
                    && launch.directory_inode() == profile.directory_inode =>
            {
                launch.into_environment()
            }
            (None, None) => self.launch_preparer.prepare_default(provider_id)?,
            _ => return Err(ProviderCredentialProfileErrorV1::StaleGeneration),
        };
        Ok(PreparedProviderCredentialLaunchV1 {
            resolved: prepared,
            environment,
        })
    }

    /// Normalize one immutable Hmux launch reference (current public id or
    /// legacy profile-directory name) to its durable backend generation
    /// without authorizing another filesystem launch.
    pub(crate) async fn registered_launch_reference(
        &self,
        provider_id: &ProviderIdV1,
        launch_reference: &str,
    ) -> Result<RegisteredProviderCredentialProfileV1, ProviderCredentialProfileErrorV1> {
        let registration = self
            .store
            .provider_credential_profile_for_launch_reference(provider_id, launch_reference)
            .await
            .map_err(map_store_error)?
            .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
        registration
            .validate()
            .map_err(|_| ProviderCredentialProfileErrorV1::Conflict)?;
        if registration.profile.provider_id != *provider_id
            || (registration.profile.reference_id != launch_reference
                && registration.profile_directory_name.as_str() != launch_reference)
        {
            return Err(ProviderCredentialProfileErrorV1::Conflict);
        }
        Ok(RegisteredProviderCredentialProfileV1 {
            profile: registration.profile,
            profile_directory_name: registration.profile_directory_name,
            profile_device: registration.profile_device,
            profile_inode: registration.profile_inode,
        })
    }

    /// Prove that an immutable Hmux recipe launched the registered logical
    /// credential, without claiming that the legacy process used the
    /// registry's current credential generation.
    pub(crate) async fn verified_native_launch_reference(
        &self,
        provider_id: &ProviderIdV1,
        launch_reference: &str,
        observed_environment: &ProviderStateEnvironment,
    ) -> Result<RegisteredProviderCredentialProfileV1, ProviderCredentialProfileErrorV1> {
        let registered = self
            .registered_launch_reference(provider_id, launch_reference)
            .await?;
        let resolved = self
            .resolve(
                provider_id,
                &AgentExecutionProfileV1::CredentialReference {
                    reference_id: registered.profile.reference_id.clone(),
                    credential_generation: Some(registered.profile.credential_generation.clone()),
                },
            )
            .await?
            .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
        let expected_environment = native_provider_state_environment(provider_id, Some(&resolved))?;
        if &expected_environment != observed_environment {
            return Err(ProviderCredentialProfileErrorV1::Conflict);
        }
        let converged = self
            .registered_launch_reference(provider_id, launch_reference)
            .await?;
        if converged != registered {
            return Err(ProviderCredentialProfileErrorV1::StaleGeneration);
        }
        Ok(converged)
    }

    /// Read one public execution-profile reference without accepting private
    /// legacy directory aliases from an external request.
    pub(crate) async fn registered_reference(
        &self,
        provider_id: &ProviderIdV1,
        reference_id: &str,
    ) -> Result<RegisteredProviderCredentialProfileV1, ProviderCredentialProfileErrorV1> {
        let registration = self
            .store
            .provider_credential_profile(provider_id, reference_id)
            .await
            .map_err(map_store_error)?
            .ok_or(ProviderCredentialProfileErrorV1::Unavailable)?;
        registration
            .validate()
            .map_err(|_| ProviderCredentialProfileErrorV1::Conflict)?;
        if registration.profile.provider_id != *provider_id
            || registration.profile.reference_id != reference_id
        {
            return Err(ProviderCredentialProfileErrorV1::Conflict);
        }
        Ok(RegisteredProviderCredentialProfileV1 {
            profile: registration.profile,
            profile_directory_name: registration.profile_directory_name,
            profile_device: registration.profile_device,
            profile_inode: registration.profile_inode,
        })
    }
}

fn map_store_error(error: DomainStoreErrorV1) -> ProviderCredentialProfileErrorV1 {
    match error {
        DomainStoreErrorV1::InvalidRecord { .. } => {
            ProviderCredentialProfileErrorV1::RequestInvalid
        }
        DomainStoreErrorV1::IdentityConflict { .. } => ProviderCredentialProfileErrorV1::Conflict,
        _ => ProviderCredentialProfileErrorV1::StoreFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app_sqlite::SqliteDomainStore;
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn owner_directory_at(path: &Path) {
        fs::create_dir(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn profile_generation_path(profile_path: &Path) -> PathBuf {
        profile_path.join(marker::PROFILE_GENERATION_FILE_NAME.to_str().unwrap())
    }

    #[tokio::test]
    async fn provider_default_launch_does_not_require_an_ambient_platform_home() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Arc::new(
            SqliteDomainStore::open(temporary.path().join("application-state.sqlite3"))
                .await
                .unwrap(),
        );
        let registry = ProviderCredentialProfileRegistry::with_platform_home(
            temporary.path().to_path_buf(),
            None,
            store,
        );

        for (provider, removals) in [
            ("codex", ["CODEX_HOME", "CODEX_SQLITE_HOME"]),
            ("claude", ["ANTHROPIC_CONFIG_DIR", "CLAUDE_CONFIG_DIR"]),
        ] {
            let prepared = registry
                .prepare_for_launch(
                    &ProviderIdV1::new(provider).unwrap(),
                    &AgentExecutionProfileV1::ProviderDefault,
                )
                .await
                .unwrap();

            assert!(prepared.resolved().is_none());
            assert_eq!(
                prepared.environment().removals(),
                &removals.into_iter().map(String::from).collect()
            );
        }
    }

    #[tokio::test]
    async fn claude_provider_default_launch_converges_shared_state_without_moving_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let platform_home = temporary.path();
        let dure_home = platform_home.join(".dure");
        owner_directory_at(&dure_home);
        owner_directory_at(&dure_home.join("accounts"));
        let profile = dure_home.join("accounts/claude-work");
        owner_directory_at(&profile);
        let store = Arc::new(
            SqliteDomainStore::open(dure_home.join("application-state.sqlite3"))
                .await
                .unwrap(),
        );
        for (path, identity, server) in [
            (
                platform_home.join(".claude.json"),
                "default-account",
                "default-server",
            ),
            (
                profile.join(".claude.json"),
                "profile-account",
                "profile-server",
            ),
        ] {
            fs::write(
                path,
                serde_json::to_vec_pretty(&serde_json::json!({
                    "oauthAccount": { "accountUuid": identity },
                    "mcpServers": { (server): { "command": "/usr/bin/true" } }
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let registry = ProviderCredentialProfileRegistry::with_platform_home(
            dure_home,
            Some(platform_home.to_path_buf()),
            store,
        );

        registry
            .prepare_for_launch(
                &ProviderIdV1::new("claude").unwrap(),
                &AgentExecutionProfileV1::ProviderDefault,
            )
            .await
            .unwrap();

        for (path, identity) in [
            (platform_home.join(".claude.json"), "default-account"),
            (profile.join(".claude.json"), "profile-account"),
        ] {
            let document: serde_json::Value =
                serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(document["oauthAccount"]["accountUuid"], identity);
            assert!(document["mcpServers"]["default-server"].is_object());
            assert!(document["mcpServers"]["profile-server"].is_object());
        }
    }

    #[tokio::test]
    async fn registration_survives_store_reopen_and_resolution_redacts_the_path() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        owner_directory_at(&home.join("accounts"));
        owner_directory_at(&home.join("accounts/claude-work"));
        let database = home.join("application-state.sqlite3");
        let store = Arc::new(SqliteDomainStore::open(&database).await.unwrap());
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), store.clone());
        let profile = registry
            .register(RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "claude".into(),
                reference_id: "acc-profile-a".into(),
                profile_directory_name: "claude-work".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(profile_generation_path(&home.join("accounts/claude-work")))
                .unwrap(),
            format!("{}\n", profile.credential_generation)
        );
        store.close().await;

        let reopened = Arc::new(SqliteDomainStore::open(&database).await.unwrap());
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), reopened);
        let resolved = registry
            .resolve(
                &ProviderIdV1::new("claude").unwrap(),
                &AgentExecutionProfileV1::CredentialReference {
                    reference_id: profile.reference_id.clone(),
                    credential_generation: Some(profile.credential_generation.clone()),
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            resolved.directory(),
            home.join("accounts/claude-work").canonicalize().unwrap()
        );
        assert!(!format!("{resolved:?}").contains("claude-work"));
        let environment = native_provider_state_environment(
            &ProviderIdV1::new("claude").unwrap(),
            Some(&resolved),
        )
        .unwrap();
        assert_eq!(
            environment
                .values()
                .get("CLAUDE_CONFIG_DIR")
                .map(String::as_str),
            resolved.directory().to_str()
        );
        assert!(!format!("{environment:?}").contains("claude-work"));
    }

    #[test]
    fn codex_profile_selects_credentials_without_forking_canonical_sqlite_state() {
        let temporary = tempfile::tempdir().unwrap();
        let resolved = ResolvedProviderCredentialProfileV1::for_test(
            "codex",
            "acc-codex",
            "credential-generation",
            temporary.path().to_path_buf(),
        );
        let environment = native_provider_state_environment(
            &ProviderIdV1::new("codex").unwrap(),
            Some(&resolved),
        )
        .unwrap();
        assert_eq!(
            environment.values().get("CODEX_HOME").map(String::as_str),
            temporary.path().to_str(),
        );
        assert_eq!(
            environment
                .values()
                .get("CODEX_SQLITE_HOME")
                .map(PathBuf::from),
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".codex")),
        );
    }

    #[test]
    fn provider_default_has_explicit_state_root_authority() {
        let codex =
            native_provider_state_environment(&ProviderIdV1::new("codex").unwrap(), None).unwrap();
        assert_eq!(
            serde_json::to_value(codex).unwrap(),
            serde_json::json!({
                "CODEX_HOME": null,
                "CODEX_SQLITE_HOME": null,
            })
        );

        let claude =
            native_provider_state_environment(&ProviderIdV1::new("claude").unwrap(), None).unwrap();
        assert_eq!(
            serde_json::to_value(claude).unwrap(),
            serde_json::json!({
                "ANTHROPIC_CONFIG_DIR": null,
                "CLAUDE_CONFIG_DIR": null,
            })
        );

        let kimi =
            native_provider_state_environment(&ProviderIdV1::new("kimi").unwrap(), None).unwrap();
        assert_eq!(
            serde_json::to_value(kimi).unwrap(),
            serde_json::json!({ "KIMI_CODE_HOME": null })
        );

        let unknown = native_provider_state_environment(
            &ProviderIdV1::new("provider-without-credential-policy").unwrap(),
            None,
        )
        .unwrap();
        assert!(unknown.is_empty());
    }

    #[test]
    fn selected_profiles_remove_ambient_auth_overrides() {
        let codex_directory = tempfile::tempdir().unwrap();
        let codex = native_provider_state_environment(
            &ProviderIdV1::new("codex").unwrap(),
            Some(&ResolvedProviderCredentialProfileV1::for_test(
                "codex",
                "acc-codex",
                "credential-codex",
                codex_directory.path().to_path_buf(),
            )),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(codex).unwrap(),
            serde_json::json!({
                "CODEX_ACCESS_TOKEN": null,
                "CODEX_API_KEY": null,
                "CODEX_HOME": codex_directory.path(),
                "CODEX_SQLITE_HOME": PathBuf::from(std::env::var_os("HOME").unwrap()).join(".codex"),
                "OPENAI_API_KEY": null,
                "OPENAI_FEDERATION_RULE_ID": null,
                "OPENAI_IDENTITY_TOKEN_FILE": null,
            })
        );

        let claude_directory = tempfile::tempdir().unwrap();
        let claude = native_provider_state_environment(
            &ProviderIdV1::new("claude").unwrap(),
            Some(&ResolvedProviderCredentialProfileV1::for_test(
                "claude",
                "acc-claude",
                "credential-claude",
                claude_directory.path().to_path_buf(),
            )),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(claude).unwrap(),
            serde_json::json!({
                "ANTHROPIC_CONFIG_DIR": claude_directory.path(),
                "ANTHROPIC_API_KEY": null,
                "ANTHROPIC_AUTH_TOKEN": null,
                "ANTHROPIC_FEDERATION_RULE_ID": null,
                "ANTHROPIC_ORGANIZATION_ID": null,
                "ANTHROPIC_PROFILE": null,
                "CLAUDE_CODE_OAUTH_TOKEN": null,
                "CLAUDE_CODE_USE_ANTHROPIC_AWS": null,
                "CLAUDE_CODE_USE_BEDROCK": null,
                "CLAUDE_CODE_USE_FOUNDRY": null,
                "CLAUDE_CODE_USE_MANTLE": null,
                "CLAUDE_CODE_USE_VERTEX": null,
                "CLAUDE_CONFIG_DIR": claude_directory.path(),
            })
        );

        let kimi_directory = tempfile::tempdir().unwrap();
        let kimi = native_provider_state_environment(
            &ProviderIdV1::new("kimi").unwrap(),
            Some(&ResolvedProviderCredentialProfileV1::for_test(
                "kimi",
                "acc-kimi",
                "credential-kimi",
                kimi_directory.path().to_path_buf(),
            )),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(kimi).unwrap(),
            serde_json::json!({
                "KIMI_CODE_CUSTOM_HEADERS": null,
                "KIMI_CODE_HOME": kimi_directory.path(),
                "KIMI_MODEL_API_KEY": null,
                "KIMI_MODEL_BASE_URL": null,
                "KIMI_MODEL_NAME": null,
                "KIMI_MODEL_PROVIDER_TYPE": null,
                "KIMI_WEB_FETCH_API_KEY": null,
                "KIMI_WEB_FETCH_BASE_URL": null,
                "KIMI_WEB_SEARCH_API_KEY": null,
                "KIMI_WEB_SEARCH_BASE_URL": null,
            })
        );
    }

    #[tokio::test]
    async fn legacy_registration_survives_device_number_drift_without_advancing_generation() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        owner_directory_at(&home.join("accounts"));
        let profile_path = home.join("accounts/claude-work");
        owner_directory_at(&profile_path);
        let database = home.join("application-state.sqlite3");
        let store = Arc::new(SqliteDomainStore::open(&database).await.unwrap());
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), store.clone());
        let profile = registry
            .register(RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "claude".into(),
                reference_id: "acc-profile-a".into(),
                profile_directory_name: "claude-work".into(),
            })
            .await
            .unwrap();
        fs::remove_file(profile_generation_path(&profile_path)).unwrap();
        store.close().await;

        let current_device = fs::symlink_metadata(&profile_path).unwrap().dev();
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database)
                .create_if_missing(false),
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE provider_credential_profiles SET profile_device = ?1 WHERE provider_id = 'claude' AND reference_id = 'acc-profile-a'",
        )
        .bind(current_device.wrapping_add(1).to_string())
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();

        let reopened = Arc::new(SqliteDomainStore::open(&database).await.unwrap());
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), reopened);
        let resolved = registry
            .resolve(
                &ProviderIdV1::new("claude").unwrap(),
                &AgentExecutionProfileV1::CredentialReference {
                    reference_id: profile.reference_id.clone(),
                    credential_generation: Some(profile.credential_generation.clone()),
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            resolved.profile().credential_generation,
            profile.credential_generation
        );
        assert_eq!(
            fs::read_to_string(profile_generation_path(&profile_path)).unwrap(),
            format!("{}\n", profile.credential_generation)
        );
    }

    #[tokio::test]
    async fn generation_marker_survives_persisted_filesystem_identity_drift() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        owner_directory_at(&home.join("accounts"));
        let profile_path = home.join("accounts/claude-work");
        owner_directory_at(&profile_path);
        let database = home.join("application-state.sqlite3");
        let store = Arc::new(SqliteDomainStore::open(&database).await.unwrap());
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), store.clone());
        let profile = registry
            .register(RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "claude".into(),
                reference_id: "acc-profile-a".into(),
                profile_directory_name: "claude-work".into(),
            })
            .await
            .unwrap();
        store.close().await;

        let metadata = fs::symlink_metadata(&profile_path).unwrap();
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database)
                .create_if_missing(false),
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE provider_credential_profiles SET profile_device = ?1, profile_inode = ?2 WHERE provider_id = 'claude' AND reference_id = 'acc-profile-a'",
        )
        .bind(metadata.dev().wrapping_add(1).to_string())
        .bind(metadata.ino().wrapping_add(1).to_string())
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();

        let reopened = Arc::new(SqliteDomainStore::open(&database).await.unwrap());
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), reopened);
        let resolved = registry
            .resolve(
                &ProviderIdV1::new("claude").unwrap(),
                &AgentExecutionProfileV1::CredentialReference {
                    reference_id: profile.reference_id.clone(),
                    credential_generation: Some(profile.credential_generation.clone()),
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            resolved.profile().credential_generation,
            profile.credential_generation
        );
    }

    #[tokio::test]
    async fn replacement_is_stale_until_registration_advances_the_generation() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        owner_directory_at(&home.join("accounts"));
        let profile_path = home.join("accounts/claude-work");
        owner_directory_at(&profile_path);
        let store = Arc::new(
            SqliteDomainStore::open(home.join("application-state.sqlite3"))
                .await
                .unwrap(),
        );
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), store);
        let first = registry
            .register(RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "claude".into(),
                reference_id: "acc-profile-a".into(),
                profile_directory_name: "claude-work".into(),
            })
            .await
            .unwrap();
        fs::rename(
            &profile_path,
            home.join("accounts/claude-retired-generation"),
        )
        .unwrap();
        owner_directory_at(&profile_path);
        let stale = AgentExecutionProfileV1::CredentialReference {
            reference_id: first.reference_id.clone(),
            credential_generation: Some(first.credential_generation.clone()),
        };
        assert_eq!(
            registry
                .resolve(&ProviderIdV1::new("claude").unwrap(), &stale)
                .await
                .unwrap_err(),
            ProviderCredentialProfileErrorV1::StaleGeneration
        );
        assert!(!profile_generation_path(&profile_path).exists());
        let replacement = registry
            .register(RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "claude".into(),
                reference_id: "acc-profile-a".into(),
                profile_directory_name: "claude-work".into(),
            })
            .await
            .unwrap();
        assert_ne!(
            replacement.credential_generation,
            first.credential_generation
        );
        assert_eq!(
            fs::read_to_string(profile_generation_path(&profile_path)).unwrap(),
            format!("{}\n", replacement.credential_generation)
        );
    }

    #[tokio::test]
    async fn mismatched_or_symlinked_generation_marker_is_stale() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        owner_directory_at(&home.join("accounts"));
        let profile_path = home.join("accounts/claude-work");
        owner_directory_at(&profile_path);
        let store = Arc::new(
            SqliteDomainStore::open(home.join("application-state.sqlite3"))
                .await
                .unwrap(),
        );
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), store.clone());
        let profile = registry
            .register(RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "claude".into(),
                reference_id: "acc-profile-a".into(),
                profile_directory_name: "claude-work".into(),
            })
            .await
            .unwrap();
        let execution_profile = AgentExecutionProfileV1::CredentialReference {
            reference_id: profile.reference_id.clone(),
            credential_generation: Some(profile.credential_generation.clone()),
        };
        fs::write(
            profile_generation_path(&profile_path),
            format!("credential-v2-{}\n", "a".repeat(64)),
        )
        .unwrap();
        assert_eq!(
            registry
                .resolve(&ProviderIdV1::new("claude").unwrap(), &execution_profile)
                .await
                .unwrap_err(),
            ProviderCredentialProfileErrorV1::StaleGeneration
        );
        let stored = store
            .provider_credential_profile(&ProviderIdV1::new("claude").unwrap(), "acc-profile-a")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.profile.credential_generation,
            profile.credential_generation
        );

        fs::remove_file(profile_generation_path(&profile_path)).unwrap();
        let external = home.join("external-generation");
        fs::write(&external, format!("{}\n", profile.credential_generation)).unwrap();
        std::os::unix::fs::symlink(&external, profile_generation_path(&profile_path)).unwrap();
        assert_eq!(
            registry
                .resolve(&ProviderIdV1::new("claude").unwrap(), &execution_profile)
                .await
                .unwrap_err(),
            ProviderCredentialProfileErrorV1::StaleGeneration
        );

        fs::remove_file(profile_generation_path(&profile_path)).unwrap();
        let fifo_path = profile_generation_path(&profile_path);
        let fifo_path = CString::new(fifo_path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
        assert_eq!(
            registry
                .resolve(&ProviderIdV1::new("claude").unwrap(), &execution_profile)
                .await
                .unwrap_err(),
            ProviderCredentialProfileErrorV1::StaleGeneration
        );
    }

    #[tokio::test]
    async fn concurrent_registration_converges_on_one_generation() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        owner_directory_at(&home.join("accounts"));
        owner_directory_at(&home.join("accounts/claude-work"));
        let store = Arc::new(
            SqliteDomainStore::open(home.join("application-state.sqlite3"))
                .await
                .unwrap(),
        );
        let registry = ProviderCredentialProfileRegistry::new(home.to_path_buf(), store);
        let body = RegisterProviderCredentialProfileBodyV1 {
            schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
            provider_id: "claude".into(),
            reference_id: "acc-profile-a".into(),
            profile_directory_name: "claude-work".into(),
        };
        let (first, second) =
            tokio::join!(registry.register(body.clone()), registry.register(body),);
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.credential_generation, second.credential_generation);
        assert_eq!(
            fs::read_to_string(profile_generation_path(&home.join("accounts/claude-work")))
                .unwrap(),
            format!("{}\n", first.credential_generation)
        );
    }
}
