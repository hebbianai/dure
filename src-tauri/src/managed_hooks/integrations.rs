use super::*;
use dure_app::{
    ProviderIdV1, ProviderRuntimeIntegrationV1, ProviderRuntimeIntegrationsV1,
    PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1, PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1,
};
use std::collections::BTreeMap;
#[cfg(unix)]
use tauri::Manager;

/// Publish native adapters against one selected runtime before advertising
/// their launch material to either desktop or standalone control-plane callers.
pub(crate) fn publish_native_runtimes(
    app: &tauri::AppHandle,
    control_dir: &Path,
) -> BTreeMap<ProviderIdV1, ProviderRuntimeIntegrationV1> {
    let runtime = match crate::hmux::resolve_runtime_executable(app) {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("could not resolve Hmux runtime for provider hooks: {error}");
            return BTreeMap::new();
        }
    };
    #[cfg(unix)]
    let codex = app
        .path()
        .resource_dir()
        .map_err(std::io::Error::other)
        .and_then(|resources| super::publish_codex_runtime(control_dir, &runtime, &resources));
    #[cfg(not(unix))]
    let codex = super::publish_codex_notify(control_dir, &runtime);
    if let Err(error) = codex {
        eprintln!("could not publish managed Codex runtime integration: {error}");
    }
    #[cfg(unix)]
    {
        let mut integrations = BTreeMap::new();
        for (provider, result) in [
            ("pi", super::pi::publish(control_dir, &runtime)),
            ("gemini", super::gemini::publish(control_dir, &runtime)),
            ("qwen-code", super::qwen::publish(control_dir, &runtime)),
        ] {
            match result {
                Ok(integration) => {
                    integrations.insert(
                        ProviderIdV1::new(provider).expect("static provider ID"),
                        integration,
                    );
                }
                Err(error) => {
                    eprintln!("could not publish managed {provider} runtime integration: {error}");
                }
            }
        }
        integrations
    }
    #[cfg(not(unix))]
    BTreeMap::new()
}

pub(super) fn provider_runtime_integrations_document(
    channel: &str,
    claude_settings: Option<PathBuf>,
    codex: Option<ProviderRuntimeIntegrationV1>,
    mut integrations: BTreeMap<ProviderIdV1, ProviderRuntimeIntegrationV1>,
) -> std::io::Result<ProviderRuntimeIntegrationsV1> {
    if let Some(path) = claude_settings {
        integrations.insert(
            ProviderIdV1::new("claude").map_err(std::io::Error::other)?,
            ProviderRuntimeIntegrationV1::SettingsFile {
                path: path.to_string_lossy().into_owned(),
            },
        );
    }
    if let Some(codex) = codex {
        integrations.insert(
            ProviderIdV1::new("codex").map_err(std::io::Error::other)?,
            codex,
        );
    }
    let document = ProviderRuntimeIntegrationsV1 {
        schema_version: PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1,
        channel: channel.into(),
        integrations,
    };
    document.validate().map_err(std::io::Error::other)?;
    Ok(document)
}

/// Publish the token-free provider/runtime integration contract consumed by
/// the standalone control plane. Referenced hook files remain channel-owned;
/// credentials and the report token never enter this document.
pub(crate) fn publish_provider_runtime_integrations(
    channel: &str,
    control_dir: &Path,
    native: BTreeMap<ProviderIdV1, ProviderRuntimeIntegrationV1>,
) -> std::io::Result<()> {
    let claude_settings = published_claude_settings()
        .lock()
        .ok()
        .and_then(|published| published.clone())
        .and_then(|published| {
            let path = published.path.clone();
            validate_published_claude_settings(&path, &published)
                .map(|()| path)
                .map_err(|error| {
                    eprintln!("could not project managed Claude runtime integration: {error}");
                })
                .ok()
        });
    #[cfg(unix)]
    let codex = codex_native::launcher_path()
        .map_err(std::io::Error::other)?
        .map(|path| ProviderRuntimeIntegrationV1::CommandWrapper { path });
    #[cfg(not(unix))]
    let codex = codex_notify_command().and_then(|script| {
        let environment = crate::accounts::provider_default_state_environment("codex")
            .map_err(|error| {
                eprintln!("could not select managed Codex runtime integration: {error}");
            })
            .ok()?;
        let config_root = effective_codex_config_root(&environment)
            .map_err(|error| {
                eprintln!("could not resolve managed Codex runtime integration: {error}");
            })
            .ok()?;
        let chain = codex_notify_chain(&config_root)
            .map_err(|error| {
                eprintln!("could not read managed Codex notify chain: {error}");
            })
            .ok()?;
        let wrapper = publish_codex_user_notify_wrapper(control_dir, &chain)
            .map_err(|error| {
                eprintln!("could not publish managed Codex notify chain: {error}");
            })
            .ok()?;
        Some(ProviderRuntimeIntegrationV1::NotificationCommand {
            command: std::iter::once(script)
                .chain(wrapper.map(|path| path.to_string_lossy().into_owned()))
                .collect(),
        })
    });
    let document = provider_runtime_integrations_document(channel, claude_settings, codex, native)?;
    let mut contents = serde_json::to_vec_pretty(&document).map_err(std::io::Error::other)?;
    contents.push(b'\n');
    write_owner_only_file(
        control_dir,
        &control_dir.join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1),
        &contents,
        0o600,
    )
}

#[cfg(unix)]
pub(super) fn inject_command_wrapper(
    provider_id: &str,
    command: &str,
    channel: &crate::app_channel::AppChannel,
) -> Result<String, String> {
    let prefix = "managed_provider_integration_unavailable";
    let contract_path = channel
        .control_dir
        .join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1);
    validate_owner_only_regular_file(&contract_path, "provider integration contract", prefix)?;
    let metadata =
        std::fs::metadata(&contract_path).map_err(|error| format!("{prefix}: {error}"))?;
    if metadata.len() > 64 * 1024 {
        return Err(format!(
            "{prefix}: provider integration contract is too large"
        ));
    }
    let source = std::fs::read(&contract_path).map_err(|error| format!("{prefix}: {error}"))?;
    let document: ProviderRuntimeIntegrationsV1 =
        serde_json::from_slice(&source).map_err(|error| format!("{prefix}: {error}"))?;
    document
        .validate()
        .map_err(|error| format!("{prefix}: {error}"))?;
    let provider = ProviderIdV1::new(provider_id).map_err(|error| format!("{prefix}: {error}"))?;
    let Some(ProviderRuntimeIntegrationV1::CommandWrapper { path }) =
        document.integration(&provider)
    else {
        return Err(format!("{prefix}: {provider_id} integration was not published"));
    };
    if document.channel != channel.name
        || Path::new(path).parent() != Some(channel.control_dir.as_path())
    {
        return Err(format!(
            "{prefix}: {provider_id} integration belongs to another channel"
        ));
    }
    validate_owner_only_regular_file(Path::new(path), "provider launcher", prefix)?;
    Ok(format!("{} {command}", shell_quote(path)))
}
