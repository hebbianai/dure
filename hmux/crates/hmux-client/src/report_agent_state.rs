#[cfg(feature = "local-runtime")]
use crate::ManagedAttachRequest;
use crate::connection::{ConnectionOptions, LocalAttachRole};
use crate::error::host_refused;
#[cfg(feature = "local-runtime")]
use crate::managed_attach::ManagedSessionAttacher;
use crate::observer::{AgentRuntimeActivity, AgentRuntimeAttention};
use crate::{ClientError, LocalSession, SessionFence};
use hmux_session_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY;
use hmux_session_protocol::{
    AGENT_STATE_REPORT_CAPABILITY, AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
    AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
    AgentRuntimeActivity as HostAgentRuntimeActivity,
    AgentRuntimeAttention as HostAgentRuntimeAttention, AgentStateReport as AgentStateReportFrame,
    AgentStateReportObservationFence as HostAgentStateReportObservationFence,
    AgentStateReportOutcome as HostAgentStateReportOutcome,
    FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY, FrameBody,
    MANAGED_AUTHORIZATION_GRANT_CAPABILITY, PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY, ProviderConversationIdentityReport,
};
use serde::Serialize;
use std::fmt;
#[cfg(feature = "local-runtime")]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const REPORT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(3);

/// One externally observed agent state report delivered through an ephemeral
/// observer attach. The vocabulary is provider-neutral: activity, attention,
/// and turn completion. Lifecycle is Host truth and cannot be reported.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentStateReport {
    /// Preserve Host-owned runtime state and establish only the exact provider
    /// conversation identity.
    pub identity_only: bool,
    pub activity: AgentRuntimeActivity,
    pub attention: AgentRuntimeAttention,
    pub turn_completed: bool,
    /// Stable source-issued event identity. A negotiated Host applies one
    /// id at most once within the exact terminal generation.
    pub turn_completion_id: Option<String>,
    pub causality: Option<hmux_session_protocol::AgentStateReportCausality>,
    /// Bounded lifetime of a `working` observation. Current Hosts default an
    /// omitted value to 30 seconds and publish `waiting` when it expires.
    pub working_ttl_ms: Option<u64>,
    pub conversation_identity: Option<ProviderConversationIdentity>,
    pub expected_observation: Option<AgentStateReportObservationFence>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentStateReportObservationFence {
    pub terminal_epoch: String,
    pub runtime_revision: u64,
    pub output_sequence: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProviderConversationIdentity {
    pub provider_id: String,
    pub conversation_id: String,
    pub expected_fence: Option<SessionFence>,
}

impl fmt::Debug for ProviderConversationIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderConversationIdentity")
            .field("provider_id", &self.provider_id)
            .field("conversation_id_len", &self.conversation_id.len())
            .field("expected_fence", &self.expected_fence)
            .finish()
    }
}

/// Receipt outcome for one delivered report. `DroppedExited` is a success
/// shape: the Host proved the provider epoch already exited and discarded the
/// report instead of resurrecting state.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStateReportOutcome {
    Applied,
    DroppedExited,
    NoOp,
}

/// Product-facing reporter for managed sessions. Managed Hosts require the
/// adapter-minted authorization proof, and only the private managed broker is
/// allowed to mint it, so this wrapper runs the broker per report and keeps
/// the proof inside the crate boundary — mirroring [`ManagedSessionStopper`]
/// (product callers never handle the proof).
///
/// [`ManagedSessionStopper`]: crate::ManagedSessionStopper
// Only this wrapper needs the broker. `LocalSession::report_agent_state`
// below carries no such dependency, so a standalone session stays reportable
// from any transport.
#[cfg(feature = "local-runtime")]
#[derive(Clone, Debug)]
pub struct ManagedAgentStateReporter {
    attacher: ManagedSessionAttacher,
}

#[cfg(feature = "local-runtime")]
fn validate_report_source_generation(
    session: &LocalSession,
    expected_fence: Option<&SessionFence>,
) -> Result<(), ClientError> {
    if expected_fence.is_some_and(|expected| !session.descriptor().matches_fence(expected)) {
        return Err(ClientError::transport(
            "hmux_agent_state_report_source_mismatch",
            "managed agent state report source generation changed",
        ));
    }
    Ok(())
}

#[cfg(feature = "local-runtime")]
impl ManagedAgentStateReporter {
    #[must_use]
    pub fn new(
        runtime_executable: impl Into<PathBuf>,
        runtime_working_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            attacher: ManagedSessionAttacher::new(runtime_executable, runtime_working_directory),
        }
    }

    #[must_use]
    pub fn with_discovery_root(mut self, discovery_root: impl Into<PathBuf>) -> Self {
        self.attacher = self.attacher.with_discovery_root(discovery_root);
        self
    }

    /// Deliver one agent state report to the current managed session.
    pub fn report_agent_state(
        &self,
        request: ManagedAttachRequest,
        report: AgentStateReport,
    ) -> Result<AgentStateReportOutcome, ClientError> {
        self.report_agent_state_inner(request, report, None)
    }

    /// Deliver one report only if the private broker resolves the exact source
    /// generation. The fence is checked against the broker transaction's
    /// manifest before any report is sent.
    pub fn report_agent_state_for_fence(
        &self,
        request: ManagedAttachRequest,
        report: AgentStateReport,
        expected_fence: SessionFence,
    ) -> Result<AgentStateReportOutcome, ClientError> {
        self.report_agent_state_inner(request, report, Some(expected_fence))
    }

    fn report_agent_state_inner(
        &self,
        request: ManagedAttachRequest,
        report: AgentStateReport,
        expected_fence: Option<SessionFence>,
    ) -> Result<AgentStateReportOutcome, ClientError> {
        self.attacher.with_prepared_receipt(request, |receipt| {
            let proof = receipt.authorization_proof_reference().to_string();
            let session = LocalSession::from_manifest(receipt.manifest().clone())?;
            validate_report_source_generation(&session, expected_fence.as_ref())?;
            session.report_agent_state(report, Some(proof))
        })
    }
}

impl LocalSession {
    /// Deliver one agent state report through an ephemeral observer attach:
    /// connect, confirm the Host selected `agent_state_report_v1` before any
    /// report frame is written (an unknown frame kind closes older Host
    /// connections), send, and wait for the correlated receipt.
    ///
    /// Managed Hosts require the adapter-minted authorization proof for the
    /// current Host generation; standalone Hosts refuse any proof because
    /// same-user transport plus the manifest token is already the standalone
    /// authority, so callers must pass `None` for them.
    pub fn report_agent_state(
        &self,
        report: AgentStateReport,
        authorization_proof_reference: Option<String>,
    ) -> Result<AgentStateReportOutcome, ClientError> {
        if report.identity_only && report.expected_observation.is_some() {
            return Err(ClientError::transport(
                "hmux_invalid_agent_state_report",
                "identity-only agent state reports cannot carry an observation fence",
            ));
        }
        if report.identity_only && report.causality.is_some() {
            return Err(ClientError::transport(
                "hmux_invalid_agent_state_report",
                "identity-only reports cannot carry activity causality",
            ));
        }
        if report.expected_observation.is_some() && report.conversation_identity.is_some() {
            return Err(ClientError::transport(
                "hmux_invalid_agent_state_report",
                "observation-fenced state reports cannot carry conversation identity",
            ));
        }
        if report.turn_completion_id.is_some() && !report.turn_completed {
            return Err(ClientError::transport(
                "hmux_invalid_agent_state_report",
                "turn completion identity requires a completed turn",
            ));
        }
        // Refuse before connecting when discovery already proves the Host
        // predates the capability. The authoritative check below still runs
        // because discovery can be stale.
        if !self
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == AGENT_STATE_REPORT_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_CAPABILITY,
            });
        }
        if report.conversation_identity.is_some()
            && !self
                .descriptor()
                .capabilities
                .iter()
                .any(|capability| capability == PROVIDER_CONVERSATION_IDENTITY_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            });
        }
        let identified_completion = report.turn_completion_id.is_some();
        let causal = report.causality.is_some();
        if causal
            && !self
                .descriptor()
                .capabilities
                .iter()
                .any(|capability| capability == AGENT_STATE_REPORT_CAUSALITY_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
            });
        }
        if identified_completion
            && !self
                .descriptor()
                .capabilities
                .iter()
                .any(|capability| capability == AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
            });
        }
        if report.identity_only
            && !self.descriptor().capabilities.iter().any(|capability| {
                capability == PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY
            })
        {
            return Err(ClientError::MissingCapability {
                capability: PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
            });
        }
        let fenced_identity = report
            .conversation_identity
            .as_ref()
            .is_some_and(|identity| identity.expected_fence.is_some());
        if fenced_identity
            && !self.descriptor().capabilities.iter().any(|capability| {
                capability == FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY
            })
        {
            return Err(ClientError::MissingCapability {
                capability: FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
            });
        }
        let fenced_observation = report.expected_observation.is_some();
        if fenced_observation
            && !self
                .descriptor()
                .capabilities
                .iter()
                .any(|capability| capability == AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
            });
        }
        let mut optional_capabilities = if fenced_observation {
            vec![
                AGENT_STATE_REPORT_CAPABILITY,
                AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            ]
        } else if fenced_identity && report.identity_only {
            vec![
                AGENT_STATE_REPORT_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
                FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            ]
        } else if report.identity_only {
            vec![
                AGENT_STATE_REPORT_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            ]
        } else if fenced_identity {
            vec![
                AGENT_STATE_REPORT_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
                FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            ]
        } else if report.conversation_identity.is_some() {
            vec![
                AGENT_STATE_REPORT_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            ]
        } else {
            vec![
                AGENT_STATE_REPORT_CAPABILITY,
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            ]
        };
        if identified_completion {
            optional_capabilities.push(AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY);
        }
        if causal {
            optional_capabilities.push(AGENT_STATE_REPORT_CAUSALITY_CAPABILITY);
        }
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, authorization_proof_reference)
                .with_optional_capabilities(&optional_capabilities),
        )?;
        if !connection.supports(AGENT_STATE_REPORT_CAPABILITY) {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_CAPABILITY,
            });
        }
        if causal && !connection.supports(AGENT_STATE_REPORT_CAUSALITY_CAPABILITY) {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
            });
        }
        if fenced_observation
            && !connection.supports(AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
            });
        }
        if identified_completion
            && !connection.supports(AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
            });
        }
        if report.conversation_identity.is_some()
            && !connection.supports(PROVIDER_CONVERSATION_IDENTITY_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            });
        }
        if fenced_identity
            && !connection.supports(FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
            });
        }
        if report.identity_only
            && !connection.supports(PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
            });
        }
        let request_id = next_report_request_id();
        let identity_only = report.identity_only;
        let expected_conversation_identity = report.conversation_identity.clone();
        let conversation_identity =
            report
                .conversation_identity
                .map(|identity| ProviderConversationIdentityReport {
                    provider_id: identity.provider_id,
                    conversation_id: identity.conversation_id,
                    expected_fence: identity.expected_fence,
                });
        connection
            .writer()
            .send(FrameBody::AgentStateReport(AgentStateReportFrame {
                request_id: request_id.clone(),
                identity_only,
                activity: match report.activity {
                    AgentRuntimeActivity::Working => HostAgentRuntimeActivity::Working,
                    AgentRuntimeActivity::Waiting => HostAgentRuntimeActivity::Waiting,
                },
                attention: match report.attention {
                    AgentRuntimeAttention::None => HostAgentRuntimeAttention::None,
                    AgentRuntimeAttention::InputRequired => {
                        HostAgentRuntimeAttention::InputRequired
                    }
                    AgentRuntimeAttention::ApprovalRequired => {
                        HostAgentRuntimeAttention::ApprovalRequired
                    }
                    AgentRuntimeAttention::Error => HostAgentRuntimeAttention::Error,
                },
                turn_completed: report.turn_completed,
                turn_completion_id: report.turn_completion_id,
                causality: report.causality,
                working_ttl_ms: report.working_ttl_ms,
                conversation_identity,
                expected_observation: report.expected_observation.map(|expected| {
                    HostAgentStateReportObservationFence {
                        terminal_epoch: expected.terminal_epoch,
                        runtime_revision: expected.runtime_revision,
                        output_sequence: expected.output_sequence,
                    }
                }),
            }))?;

        let receipt_started = Instant::now();
        let outcome = loop {
            let elapsed = receipt_started.elapsed();
            if elapsed >= REPORT_RECEIPT_TIMEOUT {
                return Err(ClientError::transport(
                    "hmux_agent_state_report_receipt_timeout",
                    "Hmux Host did not acknowledge the agent state report before the deadline",
                ));
            }
            connection.set_read_timeout(Some(REPORT_RECEIPT_TIMEOUT.saturating_sub(elapsed)))?;
            match connection.read_body()? {
                FrameBody::AgentStateReportReceipt(receipt) if receipt.request_id == request_id => {
                    if !receipt_matches_fenced_identity(
                        &receipt,
                        expected_conversation_identity.as_ref(),
                    ) {
                        return Err(ClientError::InconsistentStream {
                            reason: "agent state report receipt does not match fenced conversation identity",
                        });
                    }
                    break match receipt.outcome {
                        HostAgentStateReportOutcome::Applied => AgentStateReportOutcome::Applied,
                        HostAgentStateReportOutcome::DroppedExited => {
                            AgentStateReportOutcome::DroppedExited
                        }
                        HostAgentStateReportOutcome::NoOp => AgentStateReportOutcome::NoOp,
                    };
                }
                FrameBody::AgentStateReportReceipt(_) => {
                    return Err(ClientError::transport(
                        "hmux_agent_state_report_uncorrelated",
                        "Hmux Host returned an agent state report receipt for another request",
                    ));
                }
                FrameBody::Error(error) => return Err(host_refused(error)),
                // An Exit racing the receipt is not a failure: the read loop
                // still answers the report (as dropped when the epoch already
                // completed), so keep waiting for the correlated receipt.
                _ => {}
            }
        };
        let _ = connection.detach("agent_state_report_complete");
        Ok(outcome)
    }
}

fn receipt_matches_fenced_identity(
    receipt: &hmux_session_protocol::AgentStateReportReceipt,
    expected: Option<&ProviderConversationIdentity>,
) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let Some(expected_fence) = expected.expected_fence.as_ref() else {
        return true;
    };
    match receipt.outcome {
        HostAgentStateReportOutcome::DroppedExited => {
            receipt.provider_conversation_identity.is_none()
        }
        HostAgentStateReportOutcome::Applied | HostAgentStateReportOutcome::NoOp => {
            let Some(projection) = receipt.provider_conversation_identity.as_deref() else {
                return false;
            };
            projection.fence == *expected_fence
                && projection.provider_id == expected.provider_id
                && projection.conversation_id == expected.conversation_id
        }
    }
}

fn next_report_request_id() -> String {
    static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "agent_state_report_{}_{}",
        std::process::id(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveredSession, DiscoveryManifest, HostLifetimeIdentity, LocalEndpoint,
        LocalEndpointKind, ManifestCommon, ReadyManifest, SessionClass,
    };
    use hmux_session_protocol::{
        AgentStateReportReceipt, PROTOCOL_V1, ProcessProof, ProviderConversationIdentityProjection,
        ProviderConversationIdentitySource, RuntimeContext, VersionRange,
    };

    fn session_with_capabilities(capabilities: Vec<String>) -> LocalSession {
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "test".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities,
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace".into(),
                session_id: "standalone_report".into(),
                runner_principal: "standalone".into(),
                runner_instance: "standalone".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host".into(),
            provider_id: "shell".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id: 10,
                start_marker: "host-start".into(),
            },
            created_unix_ms: 1,
            session_class: SessionClass::Standalone,
            session_name: Some("report".into()),
            retirement_policy: None,
        };
        LocalSession::from_discovered(DiscoveredSession {
            key: hmux_host::local_discovery::DiscoveryKey::new(
                "workspace",
                "standalone_report",
                "standalone",
                1,
            )
            .unwrap(),
            manifest: DiscoveryManifest::Ready(ReadyManifest {
                common,
                provider_process: ProcessProof {
                    process_id: 11,
                    start_marker: "provider-start".into(),
                },
                terminal_epoch: "terminal".into(),
                ready_output_seq: 1,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: "/tmp/hmux-report-test.sock".into(),
                },
                capability_token: "token".into(),
                ready_unix_ms: 2,
            }),
            discovery_path: "/tmp/discovery".into(),
        })
    }

    #[test]
    fn hosts_without_the_capability_get_a_typed_error_before_any_connection() {
        let session = session_with_capabilities(vec!["screen_snapshot".into()]);

        let result = session.report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: AgentRuntimeActivity::Working,
                attention: AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            None,
        );

        assert!(matches!(
            result,
            Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_CAPABILITY,
            })
        ));
    }

    #[test]
    fn old_hosts_refuse_observation_fences_before_any_connection() {
        let session = session_with_capabilities(vec![AGENT_STATE_REPORT_CAPABILITY.to_string()]);

        let result = session.report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::Error,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: Some(AgentStateReportObservationFence {
                    terminal_epoch: "terminal".into(),
                    runtime_revision: 1,
                    output_sequence: 0,
                }),
            },
            None,
        );

        assert!(matches!(
            result,
            Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
            })
        ));
    }

    #[test]
    fn old_hosts_refuse_completion_id_before_any_connection() {
        let session = session_with_capabilities(vec![AGENT_STATE_REPORT_CAPABILITY.to_string()]);

        let result = session.report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::None,
                turn_completed: true,
                turn_completion_id: Some("turn-0199aaaa-bbbb-7ac2".into()),
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            None,
        );

        assert!(matches!(
            result,
            Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
            })
        ));
    }

    #[test]
    fn old_hosts_refuse_causal_reports_before_any_connection() {
        let session = session_with_capabilities(vec![AGENT_STATE_REPORT_CAPABILITY.to_string()]);
        let result = session.report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: AgentRuntimeActivity::Working,
                attention: AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: Some(hmux_session_protocol::AgentStateReportCausality {
                    sequence: 1,
                    work_id: Some("current-work".into()),
                }),
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            None,
        );
        assert!(matches!(
            result,
            Err(ClientError::MissingCapability {
                capability: AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
            })
        ));
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn report_source_fence_distinguishes_a_replacement_generation() {
        let session = session_with_capabilities(vec![AGENT_STATE_REPORT_CAPABILITY.to_string()]);
        let mut expected = SessionFence {
            workspace_id: "workspace".into(),
            session_id: "standalone_report".into(),
            runner_principal: "standalone".into(),
            runner_instance: "standalone".into(),
            channel_epoch: 1,
            host_instance_id: "host".into(),
            terminal_epoch: "terminal".into(),
        };
        assert!(validate_report_source_generation(&session, Some(&expected)).is_ok());
        expected.terminal_epoch = "successor-terminal".into();
        let error = validate_report_source_generation(&session, Some(&expected)).unwrap_err();
        assert_eq!(error.code(), "hmux_agent_state_report_source_mismatch");
    }

    #[test]
    fn old_hosts_refuse_identity_reports_before_any_connection() {
        let session = session_with_capabilities(vec![AGENT_STATE_REPORT_CAPABILITY.to_string()]);

        let result = session.report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: Some(ProviderConversationIdentity {
                    provider_id: "codex".into(),
                    conversation_id: "conversation-1".into(),
                    expected_fence: None,
                }),
                expected_observation: None,
            },
            None,
        );

        assert!(matches!(
            result,
            Err(ClientError::MissingCapability {
                capability: PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            })
        ));
    }

    #[test]
    fn old_hosts_refuse_identity_only_reports_before_any_connection() {
        let session = session_with_capabilities(vec![
            AGENT_STATE_REPORT_CAPABILITY.to_string(),
            PROVIDER_CONVERSATION_IDENTITY_CAPABILITY.to_string(),
        ]);

        let result = session.report_agent_state(
            AgentStateReport {
                identity_only: true,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: Some(ProviderConversationIdentity {
                    provider_id: "codex".into(),
                    conversation_id: "conversation-1".into(),
                    expected_fence: None,
                }),
                expected_observation: None,
            },
            None,
        );

        assert!(matches!(
            result,
            Err(ClientError::MissingCapability {
                capability: PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
            })
        ));
    }

    #[test]
    fn fenced_identity_receipt_requires_the_exact_host_projection() {
        let fence = SessionFence {
            workspace_id: "workspace".into(),
            session_id: "standalone_report".into(),
            runner_principal: "standalone".into(),
            runner_instance: "standalone".into(),
            channel_epoch: 1,
            host_instance_id: "host".into(),
            terminal_epoch: "terminal".into(),
        };
        let expected = ProviderConversationIdentity {
            provider_id: "codex".into(),
            conversation_id: "conversation-1".into(),
            expected_fence: Some(fence.clone()),
        };
        let projection = ProviderConversationIdentityProjection {
            fence,
            revision: 1,
            observed_through_output_seq: 1,
            provider_id: "codex".into(),
            conversation_id: "conversation-1".into(),
            source: ProviderConversationIdentitySource::ProviderEvent,
        };
        let exact = AgentStateReportReceipt {
            request_id: "report-1".into(),
            outcome: HostAgentStateReportOutcome::NoOp,
            provider_conversation_identity: Some(Box::new(projection.clone())),
        };
        assert!(receipt_matches_fenced_identity(&exact, Some(&expected)));

        let mismatched = AgentStateReportReceipt {
            provider_conversation_identity: Some(Box::new(
                ProviderConversationIdentityProjection {
                    conversation_id: "conversation-2".into(),
                    ..projection.clone()
                },
            )),
            ..exact.clone()
        };
        assert!(!receipt_matches_fenced_identity(
            &mismatched,
            Some(&expected)
        ));
        let confirmed_revision = AgentStateReportReceipt {
            provider_conversation_identity: Some(Box::new(
                ProviderConversationIdentityProjection {
                    revision: 2,
                    ..projection
                },
            )),
            ..exact
        };
        assert!(receipt_matches_fenced_identity(
            &confirmed_revision,
            Some(&expected)
        ));
        let exited = AgentStateReportReceipt {
            request_id: "report-1".into(),
            outcome: HostAgentStateReportOutcome::DroppedExited,
            provider_conversation_identity: None,
        };
        assert!(receipt_matches_fenced_identity(&exited, Some(&expected)));
    }
}
