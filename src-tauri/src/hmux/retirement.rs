use super::{product_catalog, validate_identifier, HmuxManager};
use hmux_client::{
    ClientError, HostErrorCode, SessionRetirementPolicy, SessionRetirementReceipt,
    SessionRetirementReceiptReason, SessionRetirementReceiptState, SessionSelector,
    StandaloneCreateRequest,
};
use serde::Serialize;

const APP_STANDALONE_RETIREMENT_GRACE_MS: u64 = 2_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PaneAttachmentIdentity {
    owner_id: String,
    session_id: String,
    workspace_id: String,
}

impl PaneAttachmentIdentity {
    pub(super) fn new(
        owner_id: impl Into<String>,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
    ) -> Self {
        Self {
            owner_id: owner_id.into(),
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
        }
    }

    pub(super) fn matches_owner(&self, owner_id: &str) -> bool {
        self.owner_id == owner_id
    }

    /// Pane ownership is the authority; a terminal surface is only its
    /// transport. Accept the old `-view` spelling so a pane mounted by the
    /// immediately previous frontend can still close after a rolling update.
    pub(super) fn matches_pane_attachment(&self, attachment: &Self) -> bool {
        self.session_id == attachment.session_id
            && self.workspace_id == attachment.workspace_id
            && (self.owner_id == attachment.owner_id
                || attachment.owner_id.strip_suffix("-view") == Some(self.owner_id.as_str()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRetirementPolicySummary {
    pub kind: &'static str,
    pub grace_period_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneDepartureReceipt {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<SessionRetirementPolicySummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneAttachmentStatus {
    pub owner_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub state: &'static str,
    pub observer_attached: bool,
    pub controller_attached: bool,
}

pub(super) fn app_standalone_create_request(
    request: StandaloneCreateRequest,
) -> Result<StandaloneCreateRequest, String> {
    request
        .with_retirement_policy(
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: APP_STANDALONE_RETIREMENT_GRACE_MS,
            },
        )
        .map_err(|error| error.to_string())
}

impl HmuxManager {
    pub fn sweep_app_standalone_shell(
        &self,
        session_id: String,
        workspace_id: String,
        terminal_epoch: String,
        target_session_id: String,
        target_workspace_id: String,
        target_terminal_epoch: String,
    ) -> Result<PaneDepartureReceipt, String> {
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        validate_identifier("terminal epoch", &terminal_epoch)?;
        validate_identifier("target session id", &target_session_id)?;
        validate_identifier("target workspace id", &target_workspace_id)?;
        validate_identifier("target terminal epoch", &target_terminal_epoch)?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Hmux retirement coordination is unavailable".to_string())?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let target = match catalog.find(&SessionSelector::new(
            &target_session_id,
            Some(target_workspace_id),
        )) {
            Ok(target) => target,
            Err(ClientError::SessionNotFound { .. }) => {
                return Ok(preserved_receipt("target_unavailable", None));
            }
            Err(error) => return Err(error.to_string()),
        };
        if target.lifecycle != hmux_client::SessionLifecycle::Ready
            || target.session_class != hmux_client::SessionClass::Managed
            || target.provider_id != "local-shell"
            || target.terminal_epoch != target_terminal_epoch
        {
            return Ok(preserved_receipt(
                "target_unavailable",
                target.retirement_policy,
            ));
        }
        let selector = SessionSelector::new(&session_id, Some(workspace_id));
        let descriptor = match catalog.find(&selector) {
            Ok(descriptor) => descriptor,
            Err(ClientError::SessionNotFound { .. }) => {
                return Ok(preserved_receipt("source_absent", None));
            }
            Err(error) => return Err(error.to_string()),
        };
        let expected_policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
            grace_period_ms: APP_STANDALONE_RETIREMENT_GRACE_MS,
        };
        if descriptor.lifecycle != hmux_client::SessionLifecycle::Ready {
            return Ok(preserved_receipt(
                "source_exited",
                descriptor.retirement_policy,
            ));
        }
        if descriptor.session_class != hmux_client::SessionClass::Standalone
            || descriptor.provider_id != "local-shell"
            || descriptor.terminal_epoch != terminal_epoch
            || descriptor.retirement_policy != Some(expected_policy)
        {
            return Ok(preserved_receipt(
                "generation_changed",
                descriptor.retirement_policy,
            ));
        }
        let session = catalog.open(&selector).map_err(|error| error.to_string())?;
        match session.apply_retirement_sweep() {
            Ok(receipt) => Ok(project_receipt(receipt, descriptor.retirement_policy)),
            Err(error) => Ok(project_client_error(&error, descriptor.retirement_policy)),
        }
    }

    pub fn abandon_unpresented_creation(
        &self,
        session_id: String,
        workspace_id: String,
    ) -> Result<PaneDepartureReceipt, String> {
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Hmux creation coordination is unavailable".to_string())?;
        let created = self
            .pending_created
            .lock()
            .map_err(|_| "Hmux pending create registry is unavailable".to_string())?
            .remove(&session_id);
        let Some(created) = created else {
            return Ok(preserved_receipt("creation_authority_unavailable", None));
        };
        if created.session().descriptor().workspace_id != workspace_id {
            self.pending_created
                .lock()
                .map_err(|_| "Hmux pending create registry is unavailable".to_string())?
                .insert(session_id, created);
            return Ok(preserved_receipt("generation_changed", None));
        }
        let policy = created.session().descriptor().retirement_policy;
        match created.abandon_unpresented_creation() {
            Ok(receipt) => Ok(project_receipt(receipt, policy)),
            Err(error) => Ok(project_client_error(&error, policy)),
        }
    }

    pub fn pane_attachment_status(
        &self,
        owner_id: String,
        session_id: String,
        workspace_id: String,
    ) -> Result<PaneAttachmentStatus, String> {
        validate_identifier("pane owner id", &owner_id)?;
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        let target =
            PaneAttachmentIdentity::new(owner_id.clone(), session_id.clone(), workspace_id.clone());
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Hmux attachment coordination is unavailable".to_string())?;
        let observer_attached = self.has_live_structured_pane_attachment(&target)?;
        Ok(PaneAttachmentStatus {
            owner_id,
            session_id,
            workspace_id,
            state: if observer_attached {
                "attached"
            } else {
                "detached"
            },
            observer_attached,
            controller_attached: false,
        })
    }

    pub fn depart_pane_gracefully(
        &self,
        owner_id: String,
        session_id: String,
        workspace_id: String,
    ) -> Result<PaneDepartureReceipt, String> {
        validate_identifier("pane owner id", &owner_id)?;
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        let target = PaneAttachmentIdentity::new(owner_id, session_id, workspace_id);

        // This lock spans attachment removal, confirmed detach, and the explicit
        // Host request so a replacement cannot publish midway through departure.
        let _operation = match self.operations.lock() {
            Ok(operation) => operation,
            Err(_) => {
                return Ok(preserved_receipt("attachment_coordination_poisoned", None));
            }
        };
        let structured = match self.take_structured_pane_attachments(&target) {
            Ok(attachments) => attachments,
            Err(_) => {
                return Ok(preserved_receipt("attachment_coordination_poisoned", None));
            }
        };
        if structured.is_empty() {
            return Ok(preserved_receipt("not_attached", None));
        }

        let structured_attach_started = structured.iter().try_fold(false, |started, attachment| {
            attachment.attachment_started().map(|next| started || next)
        });
        let attached_generations = structured
            .iter()
            .filter_map(|attachment| attachment.attached_generation())
            .collect::<Vec<_>>();
        let mut structured_detach_confirmed = true;
        for attachment in structured {
            if attachment.stop_confirmed().is_err() {
                structured_detach_confirmed = false;
            }
        }
        if structured_attach_started.is_err() || !structured_detach_confirmed {
            return Ok(preserved_receipt("attachment_detach_unconfirmed", None));
        }
        let Some(attached_generation) = attached_generations.first().cloned() else {
            return Ok(preserved_receipt(
                if structured_attach_started.unwrap_or(false) {
                    "attachment_generation_unavailable"
                } else {
                    "not_attached"
                },
                None,
            ));
        };
        if attached_generations
            .iter()
            .any(|generation| !generation.same_generation(&attached_generation))
        {
            return Ok(preserved_receipt("attachment_generation_conflict", None));
        }

        let catalog = match product_catalog() {
            Ok(catalog) => catalog,
            Err(error) => return Ok(project_client_error(&error, None)),
        };
        let selector =
            SessionSelector::new(target.session_id.clone(), Some(target.workspace_id.clone()));
        let session = match catalog.open(&selector) {
            Ok(session) => session,
            Err(error) => return Ok(project_client_error(&error, None)),
        };
        let policy = session.descriptor().retirement_policy;
        if !attached_generation.same_generation(session.descriptor()) {
            return Ok(preserved_receipt("generation_changed", policy));
        }
        match session.depart_gracefully() {
            Ok(receipt) => Ok(project_receipt(receipt, policy)),
            Err(error) => Ok(project_client_error(&error, policy)),
        }
    }
}

pub(crate) fn preserved_receipt(
    reason: impl Into<String>,
    policy: Option<SessionRetirementPolicy>,
) -> PaneDepartureReceipt {
    PaneDepartureReceipt {
        state: "session_preserved",
        reason: Some(reason.into()),
        policy: policy.map(project_policy),
    }
}

pub(crate) fn project_receipt(
    receipt: SessionRetirementReceipt,
    fallback_policy: Option<SessionRetirementPolicy>,
) -> PaneDepartureReceipt {
    PaneDepartureReceipt {
        state: match receipt.state {
            SessionRetirementReceiptState::PolicyUpdated => "policy_updated",
            SessionRetirementReceiptState::RetirementArmed => "retirement_armed",
            SessionRetirementReceiptState::Eligible => "eligible",
            SessionRetirementReceiptState::SessionPreserved => "session_preserved",
            SessionRetirementReceiptState::Refused => "refused",
        },
        reason: receipt.reason.map(project_reason).map(str::to_string),
        policy: receipt.policy.or(fallback_policy).map(project_policy),
    }
}

fn project_client_error(
    error: &ClientError,
    policy: Option<SessionRetirementPolicy>,
) -> PaneDepartureReceipt {
    let reason = match error {
        ClientError::MissingCapability { .. }
        | ClientError::HostRefused {
            code: HostErrorCode::UnsupportedCapability,
            ..
        } => "unsupported_capability",
        _ => error.code(),
    };
    preserved_receipt(reason, policy)
}

pub(super) fn project_policy(policy: SessionRetirementPolicy) -> SessionRetirementPolicySummary {
    match policy {
        SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 { grace_period_ms } => {
            SessionRetirementPolicySummary {
                kind: "after_graceful_last_client_departure_v1",
                grace_period_ms,
            }
        }
    }
}

fn project_reason(reason: SessionRetirementReceiptReason) -> &'static str {
    match reason {
        SessionRetirementReceiptReason::PolicyNotConfigured => "policy_not_configured",
        SessionRetirementReceiptReason::OtherClientsAttached => "other_clients_attached",
        SessionRetirementReceiptReason::ProviderBusy => "provider_busy",
        SessionRetirementReceiptReason::ProviderIdentityChanged => "provider_identity_changed",
        SessionRetirementReceiptReason::ProcessObservationUnavailable => {
            "process_observation_unavailable"
        }
        SessionRetirementReceiptReason::PersistenceUnavailable => "persistence_unavailable",
        SessionRetirementReceiptReason::SessionExited => "session_exited",
        SessionRetirementReceiptReason::GenerationChanged => "generation_changed",
        SessionRetirementReceiptReason::HostExiting => "host_exiting",
        SessionRetirementReceiptReason::ManagedSession => "managed_session",
        SessionRetirementReceiptReason::UnsupportedAction => "unsupported_action",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_create_alone_opts_into_the_two_second_policy() {
        let request = StandaloneCreateRequest::shell(std::env::temp_dir(), 24, 80).unwrap();
        assert_eq!(request.retirement_policy(), None);

        let request = app_standalone_create_request(request).unwrap();
        assert_eq!(
            request.retirement_policy(),
            Some(
                SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                    grace_period_ms: 2_000,
                },
            )
        );
    }

    #[test]
    fn legacy_capability_failure_is_a_typed_preserve_result() {
        let receipt = project_client_error(
            &ClientError::MissingCapability {
                capability: hmux_client::SESSION_RETIREMENT_CAPABILITY,
            },
            Some(
                SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                    grace_period_ms: 2_000,
                },
            ),
        );

        assert_eq!(receipt.state, "session_preserved");
        assert_eq!(receipt.reason.as_deref(), Some("unsupported_capability"));
        assert_eq!(receipt.policy.unwrap().grace_period_ms, 2_000);
    }

    #[test]
    fn persistence_failure_projects_without_a_fallback_action() {
        assert_eq!(
            project_reason(SessionRetirementReceiptReason::PersistenceUnavailable),
            "persistence_unavailable"
        );
    }

    #[test]
    fn departure_receipt_serializes_the_tauri_contract_without_protocol_names() {
        let receipt = project_receipt(
            SessionRetirementReceipt {
                request_id: "request-1".to_string(),
                state: SessionRetirementReceiptState::RetirementArmed,
                reason: None,
                policy: Some(
                    SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                        grace_period_ms: 2_000,
                    },
                ),
            },
            None,
        );

        assert_eq!(
            serde_json::to_value(receipt).unwrap(),
            serde_json::json!({
                "state": "retirement_armed",
                "policy": {
                    "kind": "after_graceful_last_client_departure_v1",
                    "gracePeriodMs": 2_000
                }
            })
        );
    }
}
