use hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY;
use hmux_host::local_protocol::{
    AGENT_STATE_REPORT_CAPABILITY, AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
    AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY, AgentStateReport, AgentStateReportOutcome,
    AgentStateReportReceipt, ErrorCode, ErrorFrame,
    FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY, FrameBody,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY, RetryPosture, SessionFence,
};
use hmux_host::session_host::{SessionHost, SessionHostError};
use hmux_host::terminal_replay::{
    AgentStateReportFold, AgentStateReportObservation, ProviderConversationIdentityObservation,
    TerminalReplayError,
};

#[derive(Clone, Copy)]
pub(crate) struct Permissions {
    pub(crate) progress: bool,
    pub(crate) report: bool,
    pub(crate) completion_id: bool,
    pub(crate) causality: bool,
    pub(crate) observation_fence: bool,
    pub(crate) conversation_identity: bool,
    pub(crate) fenced_conversation_identity: bool,
    pub(crate) identity_only_conversation: bool,
    pub(crate) conversation_continuation: bool,
    pub(crate) background_work: bool,
    pub(crate) startup_gate: bool,
    pub(crate) approval_request: bool,
    pub(crate) turn_failure: bool,
}

pub(crate) struct Application {
    pub(crate) response: FrameBody,
    pub(crate) broadcasts: Vec<FrameBody>,
}

/// Folds one provider-neutral report into the Host projection. Transport and
/// publication remain platform-owned; capability and projection semantics are
/// shared so Unix and Windows cannot reinterpret the same report differently.
pub(crate) fn apply(
    host: &mut SessionHost,
    fence: &SessionFence,
    provider_id: &str,
    permissions: Permissions,
    report: AgentStateReport,
) -> Application {
    let request_id = report.request_id.clone();
    let error = |code, message: &str, required_capability: Option<&str>| Application {
        response: FrameBody::Error(ErrorFrame {
            origin_code: None,
            code,
            message: message.to_string(),
            retry: RetryPosture::Never,
            required_capability: required_capability.map(str::to_string),
            supported_versions: None,
            in_reply_to_request_id: Some(request_id.clone()),
        }),
        broadcasts: Vec::new(),
    };

    if report.progress.is_some() && !permissions.progress {
        return error(ErrorCode::UnsupportedCapability, "agent progress was not negotiated", Some(hmux_host::local_protocol::AGENT_PROGRESS_CAPABILITY));
    }
    if !permissions.report {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state reporting was not negotiated",
            Some(AGENT_STATE_REPORT_CAPABILITY),
        );
    }
    if report.turn_completion_id.is_some() && !permissions.completion_id {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state report completion identity was not negotiated",
            Some(AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY),
        );
    }
    if report.background_work && !permissions.background_work {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state report background work was not negotiated",
            Some(hmux_host::local_protocol::AGENT_STATE_REPORT_BACKGROUND_WORK_CAPABILITY),
        );
    }
    if report.startup_gate.is_some() && !permissions.startup_gate {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state report startup gate was not negotiated",
            Some(hmux_host::local_protocol::AGENT_STATE_REPORT_STARTUP_GATE_CAPABILITY),
        );
    }
    if report.approval_request.is_some() && !permissions.approval_request {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state report approval request was not negotiated",
            Some(hmux_host::local_protocol::AGENT_STATE_REPORT_APPROVAL_REQUEST_CAPABILITY),
        );
    }
    if report.turn_failure.is_some() && !permissions.turn_failure {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state report turn failure was not negotiated",
            Some(hmux_host::local_protocol::AGENT_STATE_REPORT_TURN_FAILURE_CAPABILITY),
        );
    }
    if report.causality.is_some() && !permissions.causality {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state report causality was not negotiated",
            Some(AGENT_STATE_REPORT_CAUSALITY_CAPABILITY),
        );
    }
    if report.expected_observation.is_some() && !permissions.observation_fence {
        return error(
            ErrorCode::UnsupportedCapability,
            "agent state report observation fence was not negotiated",
            Some(AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY),
        );
    }
    if report.conversation_identity.is_some() && !permissions.conversation_identity {
        return error(
            ErrorCode::UnsupportedCapability,
            "provider conversation identity capability was not negotiated",
            Some(PROVIDER_CONVERSATION_IDENTITY_CAPABILITY),
        );
    }
    if report.identity_only && !permissions.identity_only_conversation {
        return error(
            ErrorCode::UnsupportedCapability,
            "identity-only provider conversation report was not negotiated",
            Some(PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY),
        );
    }
    if report
        .conversation_identity
        .as_ref()
        .is_some_and(|identity| identity.previous_conversation_id.is_some())
        && !permissions.conversation_continuation
    {
        return error(
            ErrorCode::UnsupportedCapability,
            "provider conversation continuation was not negotiated",
            Some(hmux_host::local_protocol::PROVIDER_CONVERSATION_CONTINUATION_CAPABILITY),
        );
    }
    if report
        .conversation_identity
        .as_ref()
        .is_some_and(|identity| identity.expected_fence.is_some())
        && !permissions.fenced_conversation_identity
    {
        return error(
            ErrorCode::UnsupportedCapability,
            "fenced provider conversation identity was not negotiated",
            Some(FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY),
        );
    }
    if report
        .conversation_identity
        .as_ref()
        .and_then(|identity| identity.expected_fence.as_ref())
        .is_some_and(|expected| expected != fence)
    {
        return error(
            ErrorCode::IdentityMismatch,
            "provider conversation identity report fence does not match",
            None,
        );
    }
    if report
        .conversation_identity
        .as_ref()
        .is_some_and(|identity| identity.provider_id != provider_id)
    {
        return error(
            ErrorCode::IdentityMismatch,
            "provider conversation identity does not match the Host provider",
            None,
        );
    }

    let identity_only = report.identity_only;
    let reported_conversation_identity = report.conversation_identity.is_some();
    let conversation_identity = report.conversation_identity.map(|identity| {
        let mut observation = ProviderConversationIdentityObservation::new(
            identity.provider_id,
            identity.conversation_id,
            hmux_host::local_protocol::ProviderConversationIdentitySource::ProviderEvent,
        );
        observation.previous_conversation_id = identity.previous_conversation_id;
        observation
    });
    let mut broadcasts = Vec::new();
    let outcome = if identity_only {
        let Some(conversation_identity) = conversation_identity else {
            return error(
                ErrorCode::ResourceLimit,
                "identity-only report lost its conversation identity",
                None,
            );
        };
        match host.report_provider_conversation_identity(fence, conversation_identity) {
            Ok((projection, identity_changed)) => {
                if identity_changed {
                    broadcasts.push(FrameBody::ProviderConversationIdentity(projection.clone()));
                }
                Ok((
                    if identity_changed {
                        AgentStateReportOutcome::Applied
                    } else {
                        AgentStateReportOutcome::NoOp
                    },
                    Some(projection),
                ))
            }
            Err(SessionHostError::SessionExited) => {
                Ok((AgentStateReportOutcome::DroppedExited, None))
            }
            Err(error) => Err(error),
        }
    } else {
        match host.apply_agent_state_report_with_identity(
            fence,
            AgentStateReportObservation {
                progress: report.progress,
                activity: report.activity,
                attention: report.attention,
                turn_completed: report.turn_completed,
                turn_completion_id: report.turn_completion_id,
                causality: report.causality,
                working_ttl_ms: report.working_ttl_ms,
                expected_observation: report.expected_observation,
                background_work: report.background_work,
                startup_gate: report.startup_gate,
                approval_request: report.approval_request,
                turn_failure: report.turn_failure,
            },
            conversation_identity,
        ) {
            Ok((AgentStateReportFold::DroppedExited, _, _)) => {
                Ok((AgentStateReportOutcome::DroppedExited, None))
            }
            Ok((state_fold, conversation_projection, identity_changed)) => {
                if identity_changed {
                    if let Some(projection) = conversation_projection.clone() {
                        broadcasts.push(FrameBody::ProviderConversationIdentity(projection));
                    }
                }
                let state_applied = matches!(&state_fold, AgentStateReportFold::Applied(_));
                if let AgentStateReportFold::Applied(runtime_state) = state_fold {
                    broadcasts.push(FrameBody::AgentRuntimeState(*runtime_state));
                }
                Ok((
                    if state_applied || identity_changed {
                        AgentStateReportOutcome::Applied
                    } else {
                        AgentStateReportOutcome::NoOp
                    },
                    reported_conversation_identity
                        .then_some(conversation_projection)
                        .flatten(),
                ))
            }
            Err(SessionHostError::SessionExited) => {
                Ok((AgentStateReportOutcome::DroppedExited, None))
            }
            Err(error) => Err(error),
        }
    };

    match outcome {
        Ok((outcome, provider_conversation_identity)) => Application {
            response: FrameBody::AgentStateReportReceipt(AgentStateReportReceipt {
                request_id,
                outcome,
                provider_conversation_identity: provider_conversation_identity.map(Box::new),
            }),
            broadcasts,
        },
        Err(SessionHostError::TerminalReplay(
            TerminalReplayError::ProviderConversationIdentityConflict,
        )) => error(
            ErrorCode::IdentityMismatch,
            "provider epoch already has another conversation identity",
            None,
        ),
        Err(_) => error(
            ErrorCode::ResourceLimit,
            "agent state report could not be folded",
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_protocol::{
        AGENT_STATE_REPORT_TURN_FAILURE_CAPABILITY, AgentRuntimeActivity, AgentRuntimeAttention,
        AgentTurnFailure, ProcessProof,
    };
    use hmux_host::terminal_replay::TerminalReplayLimits;

    fn fence() -> SessionFence {
        SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "local-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 1,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        }
    }

    /// A reporter that did not negotiate the failure must not get it folded:
    /// the Host refuses it by name, so the reporter can send the plain report.
    #[test]
    fn an_unnegotiated_turn_failure_is_refused_by_name() {
        let mut host = SessionHost::new(
            fence(),
            ProcessProof {
                process_id: 11,
                start_marker: "provider-start".into(),
            },
            24,
            80,
            TerminalReplayLimits::default(),
            2,
        )
        .unwrap();
        let permissions = Permissions {
            progress: false,
            report: true,
            completion_id: false,
            causality: false,
            observation_fence: false,
            conversation_identity: false,
            fenced_conversation_identity: false,
            identity_only_conversation: false,
            conversation_continuation: false,
            background_work: false,
            startup_gate: false,
            approval_request: false,
            turn_failure: false,
        };
        let report = AgentStateReport {
            progress: None,
            request_id: "report-1".into(),
            identity_only: false,
            activity: AgentRuntimeActivity::Waiting,
            attention: AgentRuntimeAttention::Error,
            turn_completed: false,
            turn_completion_id: None,
            causality: None,
            working_ttl_ms: None,
            conversation_identity: None,
            expected_observation: None,
            background_work: false,
            startup_gate: None,
            approval_request: None,
            turn_failure: Some(AgentTurnFailure::UsageLimit),
        };
        let refused = apply(&mut host, &fence(), "claude", permissions, report.clone());
        let FrameBody::Error(error) = refused.response else {
            panic!("an unnegotiated turn failure must be refused");
        };
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
        assert_eq!(
            error.required_capability.as_deref(),
            Some(AGENT_STATE_REPORT_TURN_FAILURE_CAPABILITY)
        );
        let runtime_state = |host: &SessionHost| {
            host.current_snapshot(hmux_host::local_protocol::ScreenSnapshotProfile::Full)
                .unwrap()
                .agent_runtime_state
        };
        assert!(runtime_state(&host).is_none());

        let applied = apply(
            &mut host,
            &fence(),
            "claude",
            Permissions {
                turn_failure: true,
                ..permissions
            },
            report,
        );
        assert!(matches!(
            applied.response,
            FrameBody::AgentStateReportReceipt(AgentStateReportReceipt {
                outcome: AgentStateReportOutcome::Applied,
                ..
            })
        ));
        assert_eq!(
            runtime_state(&host).and_then(|state| state.turn_failure),
            Some(AgentTurnFailure::UsageLimit)
        );
    }
}
