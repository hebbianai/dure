use hmux_client::{
    AgentRuntimeActivity as ClientActivity, AgentRuntimeAttention as ClientAttention,
    AgentStateReport as ClientReport, AgentStateReportObservationFence,
    AgentStateReportOutcome as ClientOutcome, ClientError, LocalSession, LocalSessionCatalog,
    ManagedAttachRequest, ProviderConversationIdentity, prepare_managed_attach_receipt,
};
use hmux_host::local_protocol::{
    AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY, AgentRuntimeActivity, AgentRuntimeAttention,
    AgentStateReport, AgentStateReportOutcome,
};
use hmux_runtime_contract::{
    ManagedAgentStateReportBrokerResponse, ManagedAgentStateReportFailure,
    ManagedAgentStateReportRequest, read_managed_agent_state_report_request,
    write_managed_agent_state_report_response,
};
use std::io;

/// Private runtime ingress for provider lifecycle adapters. It resolves one
/// exact managed generation, mints the one-use Host authorization grant, and
/// delivers the neutral report without routing through the desktop backend.
pub(crate) fn broker() -> crate::Result<()> {
    let response = match read_managed_agent_state_report_request(&mut io::stdin()) {
        Ok(request) => match deliver(request) {
            Ok(outcome) => ManagedAgentStateReportBrokerResponse::completed(outcome),
            Err(failure) => ManagedAgentStateReportBrokerResponse::Refused(failure),
        },
        Err(error) => ManagedAgentStateReportBrokerResponse::refused(
            "hmux_managed_agent_state_report_request_invalid",
            error.to_string(),
        ),
    };
    write_managed_agent_state_report_response(&mut io::stdout(), &response)?;
    Ok(())
}

fn deliver(
    request: ManagedAgentStateReportRequest,
) -> Result<AgentStateReportOutcome, ManagedAgentStateReportFailure> {
    let (expected_fence, mut report) = request.into_parts();
    let catalog = LocalSessionCatalog::from_environment().map_err(client_failure)?;
    let attach = ManagedAttachRequest::new(
        &expected_fence.session_id,
        &expected_fence.workspace_id,
    )
        .map_err(|error| request_failure(error.to_string()))?;
    let receipt = prepare_managed_attach_receipt(&catalog, &attach).map_err(client_failure)?;
    let authorization_proof_reference = receipt.authorization_proof_reference().to_string();
    let session = LocalSession::from_manifest(receipt.manifest().clone()).map_err(client_failure)?;
    if !session.descriptor().matches_fence(&expected_fence) {
        return Err(ManagedAgentStateReportFailure {
            code: "hmux_agent_state_report_source_mismatch".to_string(),
            message: "managed agent state report source generation changed".to_string(),
        });
    }

    // Preserve the pre-capability behavior for an already-running older Host:
    // completion still converges, while a current Host keeps source-id
    // idempotency across adapter retries and app restarts.
    if report.turn_completion_id.is_some()
        && !session
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY)
    {
        report.turn_completion_id = None;
    }
    let report = into_client_report(report, &expected_fence);
    session
        .report_agent_state(report, Some(authorization_proof_reference))
        .map(map_outcome)
        .map_err(client_failure)
}

fn into_client_report(
    report: AgentStateReport,
    expected_fence: &hmux_host::local_protocol::SessionFence,
) -> ClientReport {
    ClientReport {
        identity_only: report.identity_only,
        activity: match report.activity {
            AgentRuntimeActivity::Working => ClientActivity::Working,
            AgentRuntimeActivity::Waiting => ClientActivity::Waiting,
        },
        attention: match report.attention {
            AgentRuntimeAttention::None => ClientAttention::None,
            AgentRuntimeAttention::InputRequired => ClientAttention::InputRequired,
            AgentRuntimeAttention::ApprovalRequired => ClientAttention::ApprovalRequired,
            AgentRuntimeAttention::Error => ClientAttention::Error,
        },
        turn_completed: report.turn_completed,
        turn_completion_id: report.turn_completion_id,
        causality: report.causality,
        working_ttl_ms: report.working_ttl_ms,
        conversation_identity: report.conversation_identity.map(|identity| {
            ProviderConversationIdentity {
                provider_id: identity.provider_id,
                conversation_id: identity.conversation_id,
                expected_fence: Some(expected_fence.clone()),
            }
        }),
        expected_observation: report.expected_observation.map(|expected| {
            AgentStateReportObservationFence {
                terminal_epoch: expected.terminal_epoch,
                runtime_revision: expected.runtime_revision,
                output_sequence: expected.output_sequence,
            }
        }),
    }
}

fn map_outcome(outcome: ClientOutcome) -> AgentStateReportOutcome {
    match outcome {
        ClientOutcome::Applied => AgentStateReportOutcome::Applied,
        ClientOutcome::DroppedExited => AgentStateReportOutcome::DroppedExited,
        ClientOutcome::NoOp => AgentStateReportOutcome::NoOp,
    }
}

fn client_failure(error: ClientError) -> ManagedAgentStateReportFailure {
    ManagedAgentStateReportFailure {
        code: error.code().to_string(),
        message: error.to_string(),
    }
}

fn request_failure(message: String) -> ManagedAgentStateReportFailure {
    ManagedAgentStateReportFailure {
        code: "hmux_managed_agent_state_report_request_invalid".to_string(),
        message,
    }
}
