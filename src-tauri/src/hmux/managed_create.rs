use super::{product_catalog, project_session, SessionSummary};
use crate::managed_create_resolution::{
    project_checkout_advance, ManagedCreateAdvanceCommandResolution,
};
use crate::session_credentials::{ManagedCreateAdvanceCredentialIntent, PreparedCredentialLaunch};
use hmux_client::{
    CreatedManagedSession, ManagedCreateOutcome, ManagedCreateRequest,
    PermissionMode, ProviderStateEnvironment, SessionClass, SessionSelector, TerminalDefaultColors,
    TerminalEnvironment,
};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

pub(crate) struct ManagedCreateLaunch {
    pub(crate) replace_current: bool,
    pub(crate) idempotency_key: String,
    pub(crate) session_id: String,
    pub(crate) workspace_id: String,
    pub(crate) provider_id: String,
    pub(crate) conversation_id: Option<String>,
    pub(crate) permission_mode: PermissionMode,
    pub(crate) credential_id: Option<String>,
    pub(crate) credential_generation: Option<u64>,
    pub(crate) provider_state_environment: ProviderStateEnvironment,
    pub(crate) cwd: String,
    pub(crate) command: String,
    pub(crate) initial_prompt: Option<String>,
    pub(crate) rows: u16,
    pub(crate) columns: u16,
    pub(crate) terminal_environment: TerminalEnvironment,
    pub(crate) terminal_default_colors: TerminalDefaultColors,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCreateSummary {
    pub session: SessionSummary,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_generation: Option<u64>,
    pub outcome: &'static str,
    pub initial_prompt_accepted: bool,
}

pub(super) struct ManagedCreateProjectionContext {
    pub(super) expected_cwd: PathBuf,
    pub(super) credential_id: Option<String>,
    pub(super) credential_generation: Option<u64>,
    pub(super) initial_prompt_accepted: bool,
}

fn managed_launch_preexisting_runtime(request: &ManagedCreateRequest) -> Result<bool, String> {
    if !crate::session_credentials::provider_tracks_credential_conversations(request.provider_id())
    {
        return Ok(false);
    }
    let catalog = product_catalog().map_err(|error| error.to_string())?;
    let selector = SessionSelector::new(
        request.session_id(),
        Some(request.workspace_id().to_string()),
    );
    match catalog.find(&selector) {
        Ok(_) => Ok(true),
        Err(error) if error.is_session_absent() => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn prepare_credential_launch(
    request: &ManagedCreateRequest,
    launch_id: &str,
    credential_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<Option<PreparedCredentialLaunch>, String> {
    let preexisting_runtime = managed_launch_preexisting_runtime(request)?;
    crate::session_credentials::prepare_managed_launch(
        crate::session_credentials::ManagedCredentialLaunch {
            launch_id,
            session_id: request.session_id(),
            workspace_id: request.workspace_id(),
            provider_id: request.provider_id(),
            credential_id,
            conversation_id,
            preexisting_runtime,
        },
    )
}

fn create_advance_credential_intent(
    request: &ManagedCreateRequest,
    credential_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<Option<ManagedCreateAdvanceCredentialIntent>, String> {
    crate::session_credentials::managed_create_advance_credential_intent(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
        request.provider_id(),
        credential_id,
        conversation_id,
    )
}

fn create_advance_credential_intent_for_mode(
    request: &ManagedCreateRequest,
    replace_current: bool,
    credential_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<Option<ManagedCreateAdvanceCredentialIntent>, String> {
    if replace_current {
        return Ok(None);
    }
    create_advance_credential_intent(request, credential_id, conversation_id)
}

pub(super) fn project_direct_created(
    created: CreatedManagedSession,
    prepared: Option<&PreparedCredentialLaunch>,
    context: ManagedCreateProjectionContext,
) -> Result<ManagedCreateSummary, String> {
    let created_generation = created.receipt().outcome() == ManagedCreateOutcome::Created;
    let descriptor = created.session().descriptor().clone();
    let summary = project_created(created, context)?;
    crate::session_credentials::finish_direct_managed_launch(
        prepared,
        created_generation,
        &descriptor,
    )?;
    Ok(summary)
}

pub(super) fn project_local_resolution(
    resolution: ManagedCreateAdvanceCommandResolution<CreatedManagedSession>,
    credential_intent: Option<&ManagedCreateAdvanceCredentialIntent>,
    context: ManagedCreateProjectionContext,
) -> Result<ManagedCreateAdvanceCommandResolution<ManagedCreateSummary>, String> {
    match resolution {
        ManagedCreateAdvanceCommandResolution::Current { receipt: created } => {
            let created_generation = created.receipt().outcome() == ManagedCreateOutcome::Created;
            let descriptor = created.session().descriptor().clone();
            let summary = project_created(created, context)?;
            crate::session_credentials::finish_current_managed_launch(
                credential_intent,
                created_generation,
                &descriptor,
            )?;
            Ok(ManagedCreateAdvanceCommandResolution::Current { receipt: summary })
        }
        ManagedCreateAdvanceCommandResolution::Advanced { receipt: created } => {
            let target_launch_id = created.receipt().idempotency_key().to_string();
            let descriptor = created.session().descriptor().clone();
            let summary = project_created(created, context)?;
            crate::session_credentials::finish_advanced_managed_launch(
                credential_intent,
                &target_launch_id,
                &descriptor,
            )?;
            Ok(ManagedCreateAdvanceCommandResolution::Advanced { receipt: summary })
        }
        ManagedCreateAdvanceCommandResolution::Rejected { code, message } => {
            Ok(ManagedCreateAdvanceCommandResolution::Rejected { code, message })
        }
        ManagedCreateAdvanceCommandResolution::RetrySame {
            reason,
            code,
            message,
        } => Ok(ManagedCreateAdvanceCommandResolution::RetrySame {
            reason,
            code,
            message,
        }),
    }
}

pub(super) fn advance_managed_create<R: Runtime>(
    app: &AppHandle<R>,
    prepared: super::managed_launch::PreparedManagedCreateRequest,
    timing: &mut super::managed_create_timing::ManagedCreateTiming,
) -> Result<ManagedCreateAdvanceCommandResolution<ManagedCreateSummary>, String> {
    let super::managed_launch::PreparedManagedCreateRequest {
        request,
        replace_current,
        credential_id,
        credential_generation,
        conversation_id,
        initial_prompt_accepted,
        ..
    } = prepared;
    let request = super::require_conversation_fenced_managed_stop_lifecycle(request)?;
    timing.mark("fence.ready");
    let runtime = super::runtime::resolve_runtime(app)?;
    timing.mark("runtime.resolved");
    // Exact Resume is already attributed by its target-first backend projection.
    // The optional local usage journal must never become launch admission.
    let credential_intent = create_advance_credential_intent_for_mode(
        &request,
        replace_current,
        credential_id.as_deref(),
        conversation_id.as_deref(),
    )?;
    timing.mark("credential.intent.ready");
    let expected_cwd = request.provider_cwd().to_path_buf();
    timing.mark("checkout.start");
    let resolution = project_checkout_advance(crate::session_checkout::advance(
        runtime,
        None,
        request,
        replace_current,
        timing.enabled(),
        timing.observer(),
    ))?;
    timing.mark("checkout.ready");
    let result = project_local_resolution(
        resolution,
        credential_intent.as_ref(),
        ManagedCreateProjectionContext {
            expected_cwd,
            credential_id,
            credential_generation,
            initial_prompt_accepted,
        },
    );
    timing.mark("summary.ready");
    result
}

fn project_created(
    created: CreatedManagedSession,
    context: ManagedCreateProjectionContext,
) -> Result<ManagedCreateSummary, String> {
    let idempotency_key = created.receipt().idempotency_key().to_string();
    let descriptor = created.session().descriptor().clone();
    if descriptor.session_class != SessionClass::Managed {
        return Err("managed Hmux runtime returned a standalone session".to_string());
    }
    let cwd = hebbian_process_sampler::process_cwd(descriptor.provider_process.process_id)
        .and_then(|path| std::fs::canonicalize(path).ok())
        .filter(|path| path == &context.expected_cwd)
        .map(|path| path.to_string_lossy().into_owned());
    Ok(ManagedCreateSummary {
        session: project_session(descriptor),
        idempotency_key,
        cwd,
        credential_id: context.credential_id,
        credential_generation: context.credential_generation,
        outcome: match created.receipt().outcome() {
            ManagedCreateOutcome::Created => "created",
            ManagedCreateOutcome::Reused => "reused",
        },
        initial_prompt_accepted: context.initial_prompt_accepted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_resume_does_not_admit_through_credential_attribution() {
        let request = ManagedCreateRequest::new(
            "create-source",
            "session-source",
            "workspace-source",
            "codex",
            PermissionMode::Default,
            "/tmp",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap();

        assert!(create_advance_credential_intent_for_mode(
            &request,
            true,
            Some("invalid/credential"),
            Some("conversation-1"),
        )
        .unwrap()
        .is_none());
        assert!(create_advance_credential_intent_for_mode(
            &request,
            false,
            Some("invalid/credential"),
            Some("conversation-1"),
        )
        .is_err());
    }
}
