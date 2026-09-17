use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManagedProviderKind {
    Codex,
    OpenCode,
    Pi,
}

impl ManagedProviderKind {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }

    pub(super) fn process_namespace(self) -> &'static str {
        match self {
            Self::Codex => "codex-app-server",
            Self::OpenCode => "opencode-server",
            Self::Pi => "pi-rpc",
        }
    }

    pub(super) fn credential_home(self, environment: &ProviderStateEnvironment) -> Option<PathBuf> {
        match self {
            Self::Codex => environment.values().get("CODEX_HOME").map(PathBuf::from),
            // OpenCode uses its own provider credentials in the default home.
            // A credential-reference profile has no reviewed overlay contract.
            Self::OpenCode | Self::Pi => None,
        }
    }

    pub(super) async fn attach<S: AgentTimelineStore + 'static>(
        self,
        binding: &AgentInteractionBindingV1,
        endpoint: &Path,
        cwd: &Path,
        expected_home: Option<&Path>,
        settings: &ProviderTurnSettings,
        service: Arc<AgentConversationService<S>>,
    ) -> Result<AttachedProviderConnection, Error> {
        match self {
            Self::Codex => {
                crate::codex_structured_connection::attach(
                    binding,
                    endpoint,
                    cwd,
                    expected_home,
                    settings,
                    service,
                )
                .await
            }
            Self::Pi => {
                crate::pi_timeline_bridge::attach(binding, endpoint, cwd, settings, service).await
            }
            Self::OpenCode => {
                crate::opencode_timeline_bridge::attach(binding, endpoint, cwd, settings, service)
                    .await
            }
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ManagedProviderExecutable {
    pub(crate) kind: ManagedProviderKind,
    pub(crate) executable: Option<PathBuf>,
}

impl ManagedProviderExecutable {
    pub(crate) fn new(kind: ManagedProviderKind, executable: Option<PathBuf>) -> Self {
        Self { kind, executable }
    }

    pub(super) fn resolve(self) -> Result<Self, Error> {
        let executable = self
            .executable
            .map(|path| exact_executable(&path))
            .transpose()?;
        Ok(Self {
            kind: self.kind,
            executable: match self.kind {
                ManagedProviderKind::Codex => executable.map(|path| preferred_native_codex(&path)),
                ManagedProviderKind::OpenCode | ManagedProviderKind::Pi => executable,
            },
        })
    }

    pub(super) fn command(
        &self,
        launcher: &Path,
        files: &RuntimeFiles,
        binding: &AgentInteractionBindingV1,
        settings: &ProviderTurnSettings,
    ) -> Result<Vec<String>, Error> {
        let executable = self.executable.as_ref().ok_or_else(unavailable)?;
        let mut command = vec![launcher.to_string_lossy().into_owned()];
        match self.kind {
            ManagedProviderKind::Codex => command.extend([
                "codex-connection-driver".into(),
                "--endpoint".into(),
                files.endpoint.to_string_lossy().into_owned(),
                "--upstream".into(),
                files.upstream.to_string_lossy().into_owned(),
                "--".into(),
                executable.to_string_lossy().into_owned(),
                "app-server".into(),
                "--listen".into(),
                format!("unix://{}", files.upstream.to_string_lossy()),
            ]),
            ManagedProviderKind::Pi => {
                let session = crate::pi_session_client::SessionId::for_binding(binding)
                    .map_err(|_| invalid())?;
                command.extend([
                    "pi-connection-driver".into(),
                    "--endpoint".into(),
                    files.endpoint.to_string_lossy().into_owned(),
                    "--".into(),
                    executable.to_string_lossy().into_owned(),
                    "--mode".into(),
                    "rpc".into(),
                    if binding.provider_conversation_ref.is_some() {
                        "--session".into()
                    } else {
                        "--session-id".into()
                    },
                    session.as_str().into(),
                ]);
                if let Some(model) = &settings.model {
                    command.extend(["--model".into(), model.as_str().into()]);
                }
                if let Some(effort) = &settings.effort {
                    command.extend(["--thinking".into(), effort.as_str().into()]);
                }
            }
            ManagedProviderKind::OpenCode => command.extend([
                "opencode-connection-driver".into(),
                "--endpoint".into(),
                files.endpoint.to_string_lossy().into_owned(),
                "--session".into(),
                crate::opencode_session_client::SessionId::for_binding(binding)
                    .map_err(|_| invalid())?
                    .as_str()
                    .into(),
                "--permission-mode".into(),
                serde_json::to_value(&settings.permission_mode)
                    .map_err(|_| invalid())?
                    .as_str()
                    .ok_or_else(invalid)?
                    .into(),
                "--".into(),
                executable.to_string_lossy().into_owned(),
            ]),
        }
        Ok(command)
    }
}

pub(super) fn preferred_native_codex(wrapper: &Path) -> PathBuf {
    if wrapper.file_name().and_then(|name| name.to_str()) != Some("codex.js") {
        return wrapper.to_path_buf();
    }
    let Some(package_root) = wrapper.parent().and_then(Path::parent) else {
        return wrapper.to_path_buf();
    };
    let Some((package, target)) = native_codex_package() else {
        return wrapper.to_path_buf();
    };
    let candidate = package_root
        .join("node_modules")
        .join("@openai")
        .join(package)
        .join("vendor")
        .join(target)
        .join("bin")
        .join("codex");
    exact_executable(&candidate).unwrap_or_else(|_| wrapper.to_path_buf())
}

fn native_codex_package() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(("codex-darwin-arm64", "aarch64-apple-darwin")),
        ("macos", "x86_64") => Some(("codex-darwin-x64", "x86_64-apple-darwin")),
        ("linux", "aarch64") => Some(("codex-linux-arm64", "aarch64-unknown-linux-musl")),
        ("linux", "x86_64") => Some(("codex-linux-x64", "x86_64-unknown-linux-musl")),
        _ => None,
    }
}
