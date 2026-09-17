use super::*;

#[derive(Clone, Debug)]
pub(crate) struct ManagedStructuredRuntimeConfiguration {
    pub(super) backend_generation: String,
    pub(super) provider: ManagedProviderExecutable,
    pub(super) provider_launcher_executable: PathBuf,
    pub(super) hmux_runtime: PathBuf,
    pub(super) discovery_root: PathBuf,
    pub(super) state_root: PathBuf,
    pub(super) address_root: PathBuf,
}

impl ManagedStructuredRuntimeConfiguration {
    pub(crate) fn new(
        backend_generation: impl Into<String>,
        provider: ManagedProviderExecutable,
        provider_launcher_executable: impl Into<PathBuf>,
        hmux_runtime: impl Into<PathBuf>,
        discovery_root: impl Into<PathBuf>,
        state_root: impl Into<PathBuf>,
        address_root: impl Into<PathBuf>,
    ) -> Result<Self, Error> {
        let backend_generation = backend_generation.into();
        if !safe_token(&backend_generation) {
            return Err(error(
                ErrorKind::RuntimeUnavailable,
                "managed_provider_unavailable",
            ));
        }
        let address_root = address_root.into();
        if !address_root.is_absolute() || address_root.to_str().is_none() {
            return Err(unavailable());
        }
        Ok(Self {
            backend_generation,
            provider: provider.resolve()?,
            provider_launcher_executable: exact_executable(&provider_launcher_executable.into())?,
            hmux_runtime: exact_executable(&hmux_runtime.into())?,
            discovery_root: exact_owner_directory(&discovery_root.into())?,
            state_root: exact_owner_directory(&state_root.into())?,
            address_root,
        })
    }

    pub(super) fn supports_new_sessions(&self) -> bool {
        self.provider.executable.is_some()
    }

    pub(super) fn unavailable_error(&self) -> Error {
        unavailable().with_detail(Some(format!(
            "{} executable is unavailable",
            self.provider.kind.id()
        )))
    }
}
