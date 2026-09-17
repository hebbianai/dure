use crate::{accounts, conv, remote_accounts, ssh};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationCredentialProfile {
    reference_id: String,
    directory: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderConversationMetadataTarget {
    provider: String,
    conversation_id: String,
    cwd: String,
    credential_profile: Option<ConversationCredentialProfile>,
    /// Remote change token from the previous observation; the local reader
    /// keeps its own file stamps and ignores it.
    #[serde(default)]
    observed: Option<String>,
}

const MAX_PROVIDER_CONVERSATION_METADATA_TARGETS: usize = 128;

/// Batch exact active-conversation metadata lookups. One request replaces
/// per-pane history scans; positional results keep frontend Agent ids out of
/// this provider/filesystem adapter.
#[tauri::command(async)]
pub(crate) async fn provider_conversation_metadata(
    targets: Vec<ProviderConversationMetadataTarget>,
) -> Result<Vec<Option<conv::presentation_metadata::Metadata>>, String> {
    if targets.len() > MAX_PROVIDER_CONVERSATION_METADATA_TARGETS {
        return Err("provider conversation metadata target limit exceeded".to_string());
    }
    let home = conv::conversation_home()?;
    let sqlite_root = std::env::var_os("CODEX_SQLITE_HOME")
        .filter(|value| !value.is_empty()).map(std::path::PathBuf::from);
    let targets = tauri::async_runtime::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|target| {
                let root = match target.credential_profile {
                    Some(profile) => accounts::resolve_account_profile_directory(
                        &target.provider,
                        home.to_string_lossy().as_ref(),
                        &profile.reference_id,
                        &profile.directory,
                    )
                    .ok()?,
                    None => home.join(format!(".{}", target.provider)),
                };
                Some(conv::presentation_metadata::MetadataTarget {
                    provider: target.provider,
                    conversation_id: target.conversation_id,
                    cwd: target.cwd,
                    root,
                })
            })
            .collect()
    })
    .await
    .map_err(|error| format!("provider metadata profile resolution failed: {error}"))?;
    conv::presentation_metadata::read_batch(targets, sqlite_root).await
}

/// Batch the same exact metadata lookups on one registered SSH host. Only the
/// reviewed relative profile root crosses the SSH boundary; a target whose
/// profile fails that review is reported as unobserved, like a local target
/// whose account cannot be resolved.
#[tauri::command(async)]
pub(crate) async fn ssh_provider_conversation_metadata(
    opts: ssh::SshOptions,
    targets: Vec<ProviderConversationMetadataTarget>,
) -> Result<Vec<Option<conv::remote_presentation_metadata::RemoteMetadata>>, String> {
    if targets.len() > MAX_PROVIDER_CONVERSATION_METADATA_TARGETS {
        return Err("provider conversation metadata target limit exceeded".to_string());
    }
    let targets = targets
        .into_iter()
        .map(|target| {
            let profile_directory = match target.credential_profile {
                Some(profile) => {
                    remote_accounts::validate_remote_directory(
                        &target.provider,
                        &profile.directory,
                    )
                    .ok()?;
                    Some(profile.directory)
                }
                None => None,
            };
            Some(conv::remote_presentation_metadata::RemoteTarget {
                provider: target.provider,
                conversation_id: target.conversation_id,
                cwd: target.cwd,
                profile_directory,
                observed: target.observed,
            })
        })
        .collect::<Vec<_>>();
    let expected = targets.len();
    let request = conv::remote_presentation_metadata::remote_read_request(&targets)?;
    let command = conv::remote_presentation_metadata::remote_read_command();
    let output = tauri::async_runtime::spawn_blocking(move || {
        ssh::exec_once_with_stdin(&opts, &command, Some(request.as_str()))
    })
    .await
    .map_err(|error| format!("remote provider conversation metadata task failed: {error}"))??;
    conv::remote_presentation_metadata::parse_remote_read_output(&output.stdout, expected)
}

/// List provider-owned conversations for one local workspace and committed
/// credential profile. The account registry path is normalized once here.
#[tauri::command(async)]
pub(crate) fn list_conversations(
    cwd: String,
    provider: String,
    credential_profile: Option<ConversationCredentialProfile>,
) -> Result<Vec<conv::Conversation>, String> {
    let profile_root = credential_profile
        .map(|profile| {
            let home = conv::conversation_home()?;
            accounts::resolve_account_profile_directory(
                &provider,
                home.to_string_lossy().as_ref(),
                &profile.reference_id,
                &profile.directory,
            )
        })
        .transpose()?;
    conv::list(&cwd, &provider, profile_root.as_deref())
}

/// List provider-owned recent records from all local profiles.
#[tauri::command(async)]
pub(crate) async fn list_provider_conversations() -> Vec<conv::ProviderConversationRecord> {
    conv::list_global().await
}

/// Read one exact provider-owned transcript into the provider-neutral entry
/// shape shared by pane copy and the local CLI server.
#[tauri::command(async)]
pub(crate) async fn read_provider_conversation_transcript(
    provider: String,
    conversation_id: String,
) -> Result<conv::ProviderConversationTranscript, String> {
    tauri::async_runtime::spawn_blocking(move || {
        conv::transcript_global(&provider, &conversation_id)
    })
    .await
    .map_err(|error| format!("provider transcript task failed: {error}"))?
}

/// List provider-owned recent records on one registered SSH host.
#[tauri::command(async)]
pub(crate) async fn list_remote_provider_conversations(
    host_id: String,
    opts: ssh::SshOptions,
) -> Result<Vec<conv::ProviderConversationRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || conv::list_remote(&host_id, &opts))
        .await
        .map_err(|error| format!("remote provider history task failed: {error}"))?
}

/// List provider-owned conversations for one remote workspace. Only the
/// reviewed relative profile root crosses the SSH boundary.
#[tauri::command(async)]
pub(crate) fn ssh_list_conversations(
    opts: Option<ssh::SshOptions>,
    cwd: String,
    provider: String,
    credential_profile: Option<ConversationCredentialProfile>,
) -> Result<Vec<conv::Conversation>, String> {
    let profile_directory = match credential_profile {
        Some(profile) => {
            remote_accounts::validate_remote_directory(&provider, &profile.directory)?;
            Some(profile.directory)
        }
        None => None,
    };
    let command = conv::remote_list_command(&cwd, &provider, profile_directory.as_deref())?;
    let output = match opts {
        Some(opts) => ssh::exec_once(&opts, &command)?.stdout,
        None => return Err("ssh session or connection options are required".to_string()),
    };
    serde_json::from_str(output.trim())
        .map_err(|error| format!("conversation list parse failed: {error}"))
}
