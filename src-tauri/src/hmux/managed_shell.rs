use super::managed_create::{
    project_direct_created, ManagedCreateProjectionContext, ManagedCreateSummary,
};
use super::{product_catalog, validate_identifier, HmuxManager};
use hmux_client::{
    LocalSessionCatalog, LocalSessionObserver, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ObserverAttachOptions, PermissionMode, PresentationCheckpointPredecessor,
    SessionClass, SessionDescriptor, SessionRetirementPolicy, SessionRetirementReceiptState,
    SessionSelector, TerminalDefaultColors, TerminalEnvironment,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

const APP_STANDALONE_RETIREMENT_GRACE_MS: u64 = 2_000;

impl HmuxManager {
    #[allow(clippy::too_many_arguments)]
    pub fn create_managed_shell<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        idempotency_key: String,
        session_id: String,
        workspace_id: String,
        cwd: String,
        rows: u16,
        columns: u16,
        terminal_environment: TerminalEnvironment,
        terminal_default_colors: TerminalDefaultColors,
    ) -> Result<ManagedCreateSummary, String> {
        let cwd = canonical_managed_shell_cwd(&cwd)?;
        let request = managed_shell_create_request(
            &idempotency_key,
            session_id,
            workspace_id,
            cwd,
            rows,
            columns,
            terminal_environment,
            Some(terminal_default_colors),
            None,
        )?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        create_managed_shell_request(app, request)
    }

    pub fn promote_app_standalone_shell<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: ManagedShellPromotionRequest,
    ) -> Result<ManagedShellPromotionSummary, String> {
        validate_identifier("source session id", &request.source_session_id)?;
        validate_identifier("source workspace id", &request.source_workspace_id)?;
        validate_identifier("source terminal epoch", &request.source_terminal_epoch)?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let selector = SessionSelector::new(
            &request.source_session_id,
            Some(request.source_workspace_id.clone()),
        );
        let source = catalog.find(&selector).map_err(|error| error.to_string())?;
        validate_app_standalone_shell_source(&source, &request.source_terminal_epoch)?;

        let observer =
            LocalSessionObserver::connect(&catalog, &selector, ObserverAttachOptions::default())
                .map_err(|error| error.to_string())?;
        let snapshot = observer.attachment().initial_snapshot.clone();
        observer.detach().map_err(|error| error.to_string())?;
        if snapshot.agent_identity.is_some() {
            return Err(
                "managed_shell_promotion_agent_present: source shell is running an agent"
                    .to_string(),
            );
        }
        let working_directory = snapshot
            .working_directory
            .ok_or_else(|| {
                "managed_shell_promotion_cwd_unavailable: source cwd is not projected".to_string()
            })?
            .path;
        let cwd = canonical_managed_shell_cwd(&working_directory)?;
        require_idle_app_standalone_shell(&catalog, &selector, &request.source_terminal_epoch)?;

        let digest = managed_shell_promotion_digest(&source);
        let idempotency_key = format!("promote_shell_{}", &digest[..24]);
        let target_session_id = format!("managed_shell_{}", &digest[..24]);
        let channel_epoch = source.channel_epoch.parse::<u64>().map_err(|_| {
            "managed_shell_promotion_source_changed: source channel epoch is invalid".to_string()
        })?;
        let predecessor = PresentationCheckpointPredecessor::new(
            &source.session_id,
            &source.runner_principal,
            &source.runner_instance,
            channel_epoch,
            &source.host_instance_id,
            &source.terminal_epoch,
        )
        .map_err(|error| error.to_string())?;
        let create_request = managed_shell_create_request(
            &idempotency_key,
            target_session_id,
            source.workspace_id.clone(),
            cwd.clone(),
            snapshot.rows,
            snapshot.columns,
            TerminalEnvironment::default(),
            None,
            Some(predecessor),
        )?;
        let target = create_managed_shell_request(app, create_request)?;

        if let Err(error) =
            require_idle_app_standalone_shell(&catalog, &selector, &request.source_terminal_epoch)
        {
            if target.outcome == "created" {
                let _ = stop_managed_shell_compensation(app, &target);
            }
            return Err(error);
        }
        Ok(ManagedShellPromotionSummary {
            source_session_id: source.session_id,
            source_workspace_id: source.workspace_id,
            source_terminal_epoch: source.terminal_epoch,
            cwd: cwd.to_string_lossy().into_owned(),
            target,
        })
    }
}

fn create_managed_shell_request<R: Runtime>(
    app: &AppHandle<R>,
    request: ManagedCreateRequest,
) -> Result<ManagedCreateSummary, String> {
    let request = super::require_conversation_fenced_managed_stop_lifecycle(request)?;
    let expected_cwd = request.provider_cwd().to_path_buf();
    let created = crate::session_checkout::create(
        super::runtime::resolve_runtime(app)?,
        None,
        request,
    )?;
    project_direct_created(
        created,
        None,
        ManagedCreateProjectionContext {
            expected_cwd,
            credential_id: None,
            credential_generation: None,
            initial_prompt_accepted: false,
        },
    )
}

fn canonical_managed_shell_cwd(cwd: &str) -> Result<PathBuf, String> {
    let cwd = std::fs::canonicalize(cwd)
        .map_err(|error| format!("resolve managed Hmux shell cwd failed: {error}"))?;
    if !cwd.is_dir() {
        return Err("managed Hmux shell cwd must be a directory".to_string());
    }
    Ok(cwd)
}

fn managed_shell_command() -> Vec<String> {
    let command = crate::remote_hmux::local_shell_with_ssh_shim();
    if !command.is_empty() {
        return command;
    }
    vec![
        std::env::var_os("SHELL")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
            .to_string_lossy()
            .into_owned(),
        "-l".to_string(),
    ]
}

#[allow(clippy::too_many_arguments)]
fn managed_shell_create_request(
    idempotency_key: &str,
    session_id: String,
    workspace_id: String,
    cwd: PathBuf,
    rows: u16,
    columns: u16,
    terminal_environment: TerminalEnvironment,
    terminal_default_colors: Option<TerminalDefaultColors>,
    predecessor: Option<PresentationCheckpointPredecessor>,
) -> Result<ManagedCreateRequest, String> {
    let request = ManagedCreateRequest::new(
        idempotency_key,
        session_id,
        workspace_id,
        "local-shell",
        PermissionMode::Default,
        cwd,
        managed_shell_command(),
        rows,
        columns,
    )
    .and_then(|request| request.with_terminal_environment(terminal_environment))
    .and_then(|request| request.with_terminal_default_colors_option(terminal_default_colors))
    .map_err(|error| error.to_string())?;
    match predecessor {
        Some(predecessor) => request
            .with_presentation_predecessor(predecessor)
            .map_err(|error| error.to_string()),
        None => Ok(request),
    }
}

fn expected_app_retirement_policy() -> SessionRetirementPolicy {
    SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: APP_STANDALONE_RETIREMENT_GRACE_MS,
    }
}

fn validate_app_standalone_shell_source(
    source: &SessionDescriptor,
    expected_terminal_epoch: &str,
) -> Result<(), String> {
    if source.session_class != SessionClass::Standalone
        || source.provider_id != "local-shell"
        || source.lifecycle != hmux_client::SessionLifecycle::Ready
        || source.terminal_epoch != expected_terminal_epoch
        || source.retirement_policy != Some(expected_app_retirement_policy())
    {
        return Err(
            "managed_shell_promotion_source_changed: source is not an exact Dure-owned standalone shell"
                .to_string(),
        );
    }
    Ok(())
}

fn require_idle_app_standalone_shell(
    catalog: &LocalSessionCatalog,
    selector: &SessionSelector,
    expected_terminal_epoch: &str,
) -> Result<(), String> {
    let source = catalog.find(selector).map_err(|error| error.to_string())?;
    validate_app_standalone_shell_source(&source, expected_terminal_epoch)?;
    let session = catalog.open(selector).map_err(|error| error.to_string())?;
    let receipt = session
        .preview_retirement_sweep()
        .map_err(|error| format!("{}: {error}", error.code()))?;
    if receipt.state != SessionRetirementReceiptState::Eligible {
        return Err(format!(
            "managed_shell_promotion_source_busy: {:?}",
            receipt.reason
        ));
    }
    Ok(())
}

fn managed_shell_promotion_digest(source: &SessionDescriptor) -> String {
    let mut digest = Sha256::new();
    for field in [
        "dure-managed-shell-promotion-v1",
        &source.workspace_id,
        &source.session_id,
        &source.runner_principal,
        &source.runner_instance,
        &source.channel_epoch,
        &source.host_instance_id,
        &source.terminal_epoch,
    ] {
        digest.update(field.len().to_le_bytes());
        digest.update(field.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn stop_managed_shell_compensation<R: Runtime>(
    app: &AppHandle<R>,
    target: &ManagedCreateSummary,
) -> Result<(), String> {
    let current = super::runtime::ensure_current_build(app)?;
    crate::session_checkout::close(
        current.runtime,
        None,
        ManagedCreateReconcileRequest::new(
            &target.idempotency_key,
            &target.session.session_id,
            &target.session.workspace_id,
        )
        .map_err(|error| error.to_string())?,
    )
    .map(|_| ())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedShellPromotionRequest {
    pub source_session_id: String,
    pub source_workspace_id: String,
    pub source_terminal_epoch: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedShellPromotionSummary {
    pub source_session_id: String,
    pub source_workspace_id: String,
    pub source_terminal_epoch: String,
    pub cwd: String,
    pub target: ManagedCreateSummary,
}

#[cfg(test)]
mod tests {
    use super::managed_shell_create_request;
    use hmux_client::{PresentationCheckpointPredecessor, TerminalEnvironment};

    #[test]
    fn ordinary_managed_shell_request_is_neutral_and_predecessor_fenced() {
        let cwd = std::env::temp_dir();
        let predecessor = PresentationCheckpointPredecessor::new(
            "standalone-source",
            "runner-principal",
            "runner-instance",
            7,
            "host-source",
            "terminal-source",
        )
        .unwrap();
        let request = managed_shell_create_request(
            "promote_shell_test",
            "managed-target".to_string(),
            "workspace-1".to_string(),
            cwd.clone(),
            30,
            120,
            TerminalEnvironment::default(),
            None,
            Some(predecessor.clone()),
        )
        .unwrap();

        assert_eq!(request.provider_id(), "local-shell");
        assert_eq!(request.provider_cwd(), cwd);
        assert!(!request.command().is_empty());
        assert_eq!(request.initial_rows(), 30);
        assert_eq!(request.initial_columns(), 120);
        assert_eq!(request.presentation_predecessor(), Some(&predecessor));
    }
}
