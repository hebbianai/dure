//! Durable authority for stopping one canonical Agent with an explicit workspace disposition.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AgentExecutionProfileV1, AgentIdV1, AgentInteractionProfileV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeCloseIntentV1, AgentRuntimeCloseRecordV1, AgentRuntimeCloseStateV1,
    AgentRuntimeCloseStoppedTransitionV1, AgentRuntimeReplacementAuthorityUpdateV1,
    AgentRuntimeSelectionV1, AgentRuntimeTargetFailureKindV1, AgentRuntimeTargetFailureV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1, AgentSpawnAuthorityV1,
    AgentSpawnCommittedWorkspaceV1, AgentSpawnJournalReceiptV1, AgentSpawnPlanTokenV1,
    AgentSpawnWorkspaceLeaseV1, DomainStoreErrorV1, DomainStoreFuture,
    GIT_CHECKOUT_SCHEMA_VERSION_V1, GitCheckoutRegistrationV1, GitCheckoutRemovalPolicyV1,
    GitCheckoutRemovalReceiptV1, GitCheckoutRemovalRequestV1, OperationIdV1, WorkspaceIdV1,
};

pub const AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1: u16 = 1;

fn invalid(field: &'static str, reason: impl Into<String>) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

/// CAS identity for one exact immutable stop plan; it is not authentication.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct AgentDispatchStopPlanTokenV1(String);

impl AgentDispatchStopPlanTokenV1 {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for AgentDispatchStopPlanTokenV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let valid = value.strip_prefix("sha256:").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        });
        valid
            .then_some(Self(value))
            .ok_or_else(|| serde::de::Error::custom("invalid Agent stop plan token"))
    }
}

/// Successful spawn ownership projected by the stop preview boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "workspaceOwnership", rename_all = "snake_case")]
#[non_exhaustive]
pub enum AgentDispatchStopSpawnWorkspaceV1 {
    AdoptedProjectRoot {
        #[serde(rename = "workspaceId")]
        workspace_id: WorkspaceIdV1,
    },
    DureOwned {
        #[serde(rename = "workspaceId")]
        workspace_id: WorkspaceIdV1,
        lease: AgentSpawnWorkspaceLeaseV1,
    },
}

impl AgentDispatchStopSpawnWorkspaceV1 {
    pub fn workspace_id(&self) -> &WorkspaceIdV1 {
        match self {
            Self::AdoptedProjectRoot { workspace_id } | Self::DureOwned { workspace_id, .. } => {
                workspace_id
            }
        }
    }
}

/// It is neither deserializable nor caller-constructible. Preview resolves the
/// canonical spawn receipt into this committed ownership sum type.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AgentDispatchStopSpawnReceiptV1 {
    pub operation_id: OperationIdV1,
    pub plan_token: AgentSpawnPlanTokenV1,
    pub authority: AgentSpawnAuthorityV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout_registration: Option<GitCheckoutRegistrationV1>,
    #[serde(flatten)]
    pub workspace: AgentDispatchStopSpawnWorkspaceV1,
}

/// A typed workspace effect frozen into one immutable stop plan.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "workspaceDisposition",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum AgentDispatchStopWorkspacePlanV1 {
    Preserve,
    RemoveOwned {
        #[serde(rename = "ownedCheckout")]
        checkout: GitCheckoutRemovalRequestV1,
    },
}

impl AgentDispatchStopWorkspacePlanV1 {
    pub fn owned_checkout(&self) -> Option<&GitCheckoutRemovalRequestV1> {
        match self {
            Self::Preserve => None,
            Self::RemoveOwned { checkout } => Some(checkout),
        }
    }

    pub fn is_preserve(&self) -> bool {
        matches!(self, Self::Preserve)
    }
}

/// Resolved preview inputs. A refused preview creates no plan.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDispatchStopPreviewV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub spawn_operation_id: OperationIdV1,
    pub workspace_plan: AgentDispatchStopWorkspacePlanV1,
    pub planned_at_ms: i64,
}

/// Exact non-effect runtime observation frozen by preview. Absence means one
/// stable runtime selection and authority; active journals carry their whole
/// immutable record so apply cannot adopt a post-consent successor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentDispatchStopRuntimeFenceV1 {
    Close {
        record: Box<AgentRuntimeCloseRecordV1>,
    },
    Transition {
        record: Box<AgentRuntimeTransitionRecordV1>,
    },
}

/// Immutable, inert stop plan admitted from canonical spawn and Git evidence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDispatchStopPlanV1 {
    schema_version: u16,
    operation_id: OperationIdV1,
    agent_id: AgentIdV1,
    spawn: AgentDispatchStopSpawnReceiptV1,
    runtime_selection: AgentRuntimeSelectionV1,
    runtime_authority: AgentRuntimeBindingAuthorityV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_fence: Option<AgentDispatchStopRuntimeFenceV1>,
    #[serde(flatten)]
    workspace_plan: AgentDispatchStopWorkspacePlanV1,
    planned_at_ms: i64,
    plan_token: AgentDispatchStopPlanTokenV1,
}

impl AgentDispatchStopPlanV1 {
    pub fn operation_id(&self) -> &OperationIdV1 {
        &self.operation_id
    }

    pub fn agent_id(&self) -> &AgentIdV1 {
        &self.agent_id
    }

    pub fn spawn(&self) -> &AgentDispatchStopSpawnReceiptV1 {
        &self.spawn
    }

    pub fn runtime_selection(&self) -> &AgentRuntimeSelectionV1 {
        &self.runtime_selection
    }

    pub fn runtime_authority(&self) -> &AgentRuntimeBindingAuthorityV1 {
        &self.runtime_authority
    }

    pub fn runtime_fence(&self) -> Option<&AgentDispatchStopRuntimeFenceV1> {
        self.runtime_fence.as_ref()
    }

    pub fn stopped_transition_for_close(&self) -> Option<AgentRuntimeCloseStoppedTransitionV1> {
        match self.runtime_fence.as_ref() {
            Some(AgentDispatchStopRuntimeFenceV1::Close { record }) => {
                record.intent.stopped_transition.clone()
            }
            Some(AgentDispatchStopRuntimeFenceV1::Transition { record })
                if matches!(
                    record.state,
                    AgentRuntimeTransitionStateV1::SourceStopped
                        | AgentRuntimeTransitionStateV1::RepairRequired
                ) =>
            {
                Some(AgentRuntimeCloseStoppedTransitionV1 {
                    operation_id: record.intent.operation_id.clone(),
                    journal_revision: record.journal_revision
                        + i64::from(record.permits_target_effects()),
                })
            }
            Some(AgentDispatchStopRuntimeFenceV1::Transition { .. }) | None => None,
        }
    }

    /// Derives the sole journal convergence authorized by this frozen plan.
    /// The store commits this CAS with child-close admission and parent
    /// authorization in one transaction.
    pub fn runtime_transition_advance_for_authorize(
        &self,
    ) -> Result<Option<AgentRuntimeTransitionAdvanceRequestV1>, DomainStoreErrorV1> {
        let Some(AgentDispatchStopRuntimeFenceV1::Transition { record }) = &self.runtime_fence
        else {
            return Ok(None);
        };
        let advance = match record.state {
            AgentRuntimeTransitionStateV1::Admitted => {
                Some(AgentRuntimeTransitionAdvanceV1::SourceRetained)
            }
            AgentRuntimeTransitionStateV1::SourceStopped if !record.is_dormant() => {
                Some(AgentRuntimeTransitionAdvanceV1::RepairRequired {
                    failure: AgentRuntimeTargetFailureV1::new(
                        AgentRuntimeTargetFailureKindV1::TargetInvalid,
                        "agent_dispatch_stop_target_superseded",
                    )?,
                    replacement_authority:
                        AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
                })
            }
            AgentRuntimeTransitionStateV1::SourceStopped
            | AgentRuntimeTransitionStateV1::RepairRequired => None,
            AgentRuntimeTransitionStateV1::TargetStarted => {
                Some(AgentRuntimeTransitionAdvanceV1::Committed)
            }
            AgentRuntimeTransitionStateV1::SourceRetained
            | AgentRuntimeTransitionStateV1::Committed
            | AgentRuntimeTransitionStateV1::Superseded => {
                return Err(invalid(
                    "runtimeFence",
                    "a terminal transition cannot authorize an Agent stop",
                ));
            }
        };
        Ok(
            advance.map(|advance| AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: crate::AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
                operation_id: record.intent.operation_id.clone(),
                expected_journal_revision: record.journal_revision,
                advance,
                advanced_at_ms: self.planned_at_ms,
            }),
        )
    }

    pub fn workspace_plan(&self) -> &AgentDispatchStopWorkspacePlanV1 {
        &self.workspace_plan
    }

    pub fn owned_checkout(&self) -> Option<&GitCheckoutRemovalRequestV1> {
        self.workspace_plan.owned_checkout()
    }

    pub fn plan_token(&self) -> &AgentDispatchStopPlanTokenV1 {
        &self.plan_token
    }

    pub fn planned_at_ms(&self) -> i64 {
        self.planned_at_ms
    }
}

pub fn preview_agent_dispatch_stop_v1(
    preview: AgentDispatchStopPreviewV1,
    spawn_receipt: &AgentSpawnJournalReceiptV1,
    runtime_selection: AgentRuntimeSelectionV1,
    runtime_authority: AgentRuntimeBindingAuthorityV1,
    runtime_fence: Option<AgentDispatchStopRuntimeFenceV1>,
) -> Result<AgentDispatchStopPlanV1, DomainStoreErrorV1> {
    if preview.schema_version != AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1 {
        return Err(invalid("schemaVersion", "unsupported Agent stop schema"));
    }
    if preview.planned_at_ms < 0 {
        return Err(invalid("plannedAtMs", "must not be negative"));
    }
    if spawn_receipt.operation_id != preview.spawn_operation_id {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop spawn",
            id: preview.spawn_operation_id.as_str().into(),
            reason: "resolved canonical spawn receipt has a different operation".into(),
        });
    }
    // A later spawn event must not invalidate an already frozen stop plan.
    if preview.planned_at_ms < spawn_receipt.created_at_ms
        || preview.planned_at_ms < runtime_selection.updated_at_ms
    {
        return Err(invalid(
            "plannedAtMs",
            "must not precede spawn creation or the resolved runtime authority",
        ));
    }
    let spawn_workspace = match spawn_receipt.committed_workspace_ownership() {
        Some(AgentSpawnCommittedWorkspaceV1::AdoptedProjectRoot { workspace_id }) => {
            AgentDispatchStopSpawnWorkspaceV1::AdoptedProjectRoot {
                workspace_id: workspace_id.clone(),
            }
        }
        Some(AgentSpawnCommittedWorkspaceV1::DureOwned {
            workspace_id,
            lease,
        }) => AgentDispatchStopSpawnWorkspaceV1::DureOwned {
            workspace_id: workspace_id.clone(),
            lease: lease.clone(),
        },
        None => {
            return Err(invalid(
                "spawnReceipt",
                "Agent spawn has no committed workspace ownership",
            ));
        }
    };
    if matches!(
        (&preview.workspace_plan, &spawn_workspace),
        (
            AgentDispatchStopWorkspacePlanV1::RemoveOwned { .. },
            AgentDispatchStopSpawnWorkspaceV1::AdoptedProjectRoot { .. }
        )
    ) {
        return Err(invalid(
            "workspaceDisposition",
            "remove_owned requires one Dure-created checkout lease",
        ));
    }
    runtime_authority.validate_for_selection(&runtime_selection)?;
    validate_runtime_fence(
        runtime_fence.as_ref(),
        &runtime_selection,
        &runtime_authority,
        preview.planned_at_ms,
    )?;
    if runtime_selection.agent_id != spawn_receipt.plan.agent_id {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop preview",
            id: runtime_selection.agent_id.as_str().into(),
            reason: "runtime selection does not belong to the spawned Agent".into(),
        });
    }

    let mut plan = AgentDispatchStopPlanV1 {
        schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
        operation_id: preview.operation_id,
        agent_id: spawn_receipt.plan.agent_id.clone(),
        spawn: AgentDispatchStopSpawnReceiptV1 {
            operation_id: spawn_receipt.operation_id.clone(),
            plan_token: spawn_receipt.plan.plan_token.clone(),
            authority: spawn_receipt.plan.authority.clone(),
            checkout_registration: spawn_receipt.checkout_registration.clone(),
            workspace: spawn_workspace,
        },
        runtime_selection,
        runtime_authority,
        runtime_fence,
        workspace_plan: preview.workspace_plan,
        planned_at_ms: preview.planned_at_ms,
        plan_token: AgentDispatchStopPlanTokenV1(String::new()),
    };
    plan.plan_token = stop_plan_token(&plan);
    Ok(plan)
}

/// Compact proof projected only from the exact child runtime-close record.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AgentDispatchStopRuntimeReceiptV1 {
    pub operation_id: OperationIdV1,
    pub journal_revision: i64,
    pub outcome: AgentRuntimeCloseStateV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AgentDispatchStopStateV1 {
    Planned,
    /// A newer exact plan proved that this inert preview no longer names the
    /// Agent's current runtime. No child close or checkout effect was admitted.
    Superseded,
    Authorized {
        runtime_close_operation_id: OperationIdV1,
    },
    Succeeded {
        runtime: AgentDispatchStopRuntimeReceiptV1,
        workspace: GitCheckoutRemovalReceiptV1,
    },
    WorkspacePreserved {
        runtime: AgentDispatchStopRuntimeReceiptV1,
    },
    SourceRetained {
        runtime: AgentDispatchStopRuntimeReceiptV1,
    },
    WorkspaceReplaced {
        runtime: AgentDispatchStopRuntimeReceiptV1,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDispatchStopRecordV1 {
    plan: AgentDispatchStopPlanV1,
    state: AgentDispatchStopStateV1,
    journal_revision: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl AgentDispatchStopRecordV1 {
    pub fn planned(plan: AgentDispatchStopPlanV1) -> Self {
        let planned_at_ms = plan.planned_at_ms;
        Self {
            plan,
            state: AgentDispatchStopStateV1::Planned,
            journal_revision: 1,
            created_at_ms: planned_at_ms,
            updated_at_ms: planned_at_ms,
        }
    }

    pub fn plan(&self) -> &AgentDispatchStopPlanV1 {
        &self.plan
    }

    pub fn state(&self) -> &AgentDispatchStopStateV1 {
        &self.state
    }

    pub fn journal_revision(&self) -> i64 {
        self.journal_revision
    }

    pub fn created_at_ms(&self) -> i64 {
        self.created_at_ms
    }

    pub fn updated_at_ms(&self) -> i64 {
        self.updated_at_ms
    }

    pub fn effects_are_authorized(&self) -> bool {
        matches!(self.state, AgentDispatchStopStateV1::Authorized { .. })
    }

    pub fn workspace_was_preserved(&self) -> bool {
        matches!(
            self.state,
            AgentDispatchStopStateV1::Superseded
                | AgentDispatchStopStateV1::SourceRetained { .. }
                | AgentDispatchStopStateV1::WorkspacePreserved { .. }
                | AgentDispatchStopStateV1::WorkspaceReplaced { .. }
        )
    }

    pub fn projection_is_finalizable(&self) -> bool {
        matches!(
            self.state,
            AgentDispatchStopStateV1::Succeeded { .. }
                | AgentDispatchStopStateV1::WorkspacePreserved { .. }
                | AgentDispatchStopStateV1::WorkspaceReplaced { .. }
        )
    }
}

/// Replaces only an inert plan whose exact frozen runtime is disproven by a
/// newer plan that the store has already validated against current authority.
pub fn supersede_agent_dispatch_stop_v1(
    current: &AgentDispatchStopRecordV1,
    successor: &AgentDispatchStopPlanV1,
) -> Result<AgentDispatchStopRecordV1, DomainStoreErrorV1> {
    if current.plan.operation_id == successor.operation_id
        || current.plan.agent_id != successor.agent_id
        || current.plan.spawn.operation_id != successor.spawn.operation_id
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop successor",
            id: successor.operation_id.as_str().into(),
            reason: "successor does not replace the same Agent spawn attempt".into(),
        });
    }
    if current.state != AgentDispatchStopStateV1::Planned {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "only a planned Agent stop can be superseded".into(),
        });
    }
    if current.plan.runtime_selection == successor.runtime_selection
        && current.plan.runtime_authority == successor.runtime_authority
        && current.plan.runtime_fence == successor.runtime_fence
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop",
            id: successor.agent_id.as_str().into(),
            reason: "an exact current runtime plan is already active".into(),
        });
    }
    let superseded_at_ms = current.updated_at_ms.max(successor.planned_at_ms);
    advance(
        current,
        AgentDispatchStopStateV1::Superseded,
        superseded_at_ms,
    )
}

/// Replays the childless terminal transition from the backend-owned journal.
/// The SQLite adapter writes this state only in the same transaction that
/// admits the exact successor plan which proved the frozen runtime stale.
pub fn replay_superseded_agent_dispatch_stop_v1(
    current: &AgentDispatchStopRecordV1,
    superseded_at_ms: i64,
) -> Result<AgentDispatchStopRecordV1, DomainStoreErrorV1> {
    if current.state != AgentDispatchStopStateV1::Planned {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "only a planned Agent stop can replay supersession".into(),
        });
    }
    if superseded_at_ms < current.updated_at_ms {
        return Err(invalid("supersededAtMs", "must not move backward"));
    }
    advance(
        current,
        AgentDispatchStopStateV1::Superseded,
        superseded_at_ms,
    )
}

/// Authorization CAS. The store must commit this parent transition and admit
/// the exact admitted or reusable child close in one transaction.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDispatchStopAuthorizeRequestV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub plan_token: AgentDispatchStopPlanTokenV1,
    pub expected_journal_revision: i64,
    pub runtime_close_intent: AgentRuntimeCloseIntentV1,
    pub authorized_at_ms: i64,
}

/// Reduces the parent only after the store admits or reloads `runtime_close`
/// from `request.runtime_close_intent` inside the authorization transaction.
pub fn authorize_agent_dispatch_stop_v1(
    current: &AgentDispatchStopRecordV1,
    request: &AgentDispatchStopAuthorizeRequestV1,
    runtime_close: &AgentRuntimeCloseRecordV1,
) -> Result<(AgentDispatchStopRecordV1, AgentRuntimeCloseRecordV1), DomainStoreErrorV1> {
    validate_cas(
        current,
        request.schema_version,
        &request.operation_id,
        &request.plan_token,
        request.expected_journal_revision,
    )?;
    request.runtime_close_intent.validate()?;
    validate_close_intent(&current.plan, &request.runtime_close_intent)?;
    runtime_close.validate()?;
    if runtime_close.intent != request.runtime_close_intent {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop runtime close",
            id: runtime_close.intent.operation_id.as_str().into(),
            reason: "admitted or reused child does not match the requested close intent".into(),
        });
    }
    if request.authorized_at_ms < current.plan.planned_at_ms
        || request.authorized_at_ms < runtime_close.created_at_ms
    {
        return Err(invalid(
            "authorizedAtMs",
            "must not precede the plan or child close admission",
        ));
    }
    let authorized = AgentDispatchStopStateV1::Authorized {
        runtime_close_operation_id: runtime_close.intent.operation_id.clone(),
    };
    if authorization_replay_matches(current, &authorized, runtime_close, request) {
        return Ok((current.clone(), runtime_close.clone()));
    }
    ensure_current_revision(current, request.expected_journal_revision)?;
    if current.state != AgentDispatchStopStateV1::Planned {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "only a planned Agent stop can authorize effects".into(),
        });
    }
    Ok((
        advance(current, authorized, request.authorized_at_ms)?,
        runtime_close.clone(),
    ))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum AgentDispatchStopTerminalTransitionV1 {
    Preserved {
        runtime_close: Box<AgentRuntimeCloseRecordV1>,
    },
    Succeeded {
        runtime_close: Box<AgentRuntimeCloseRecordV1>,
        workspace: GitCheckoutRemovalReceiptV1,
    },
    SourceRetained {
        runtime_close: Box<AgentRuntimeCloseRecordV1>,
    },
    WorkspaceReplaced {
        runtime_close: Box<AgentRuntimeCloseRecordV1>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDispatchStopTerminalRequestV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub plan_token: AgentDispatchStopPlanTokenV1,
    pub expected_journal_revision: i64,
    pub transition: AgentDispatchStopTerminalTransitionV1,
    pub transitioned_at_ms: i64,
}

pub fn terminalize_agent_dispatch_stop_v1(
    current: &AgentDispatchStopRecordV1,
    request: &AgentDispatchStopTerminalRequestV1,
) -> Result<AgentDispatchStopRecordV1, DomainStoreErrorV1> {
    validate_cas(
        current,
        request.schema_version,
        &request.operation_id,
        &request.plan_token,
        request.expected_journal_revision,
    )?;
    let state = terminal_state(&current.plan, &request.transition)?;
    if request.transitioned_at_ms < transition_runtime_close(&request.transition).updated_at_ms {
        return Err(invalid(
            "transitionedAtMs",
            "must not precede the terminal child close",
        ));
    }
    if terminal_replay_matches(&current.state, &state)
        && request.expected_journal_revision.checked_add(1) == Some(current.journal_revision)
    {
        return Ok(current.clone());
    }
    ensure_current_revision(current, request.expected_journal_revision)?;
    let AgentDispatchStopStateV1::Authorized {
        runtime_close_operation_id,
    } = &current.state
    else {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "only an authorized Agent stop can become terminal".into(),
        });
    };
    if request.transitioned_at_ms < current.updated_at_ms {
        return Err(invalid("transitionedAtMs", "must not move backward"));
    }
    if terminal_runtime_operation_id(&state) != Some(runtime_close_operation_id) {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop runtime close",
            id: terminal_runtime_operation_id(&state)
                .map_or("missing", OperationIdV1::as_str)
                .into(),
            reason: "terminal proof does not match the authorized child close".into(),
        });
    }
    advance(current, state, request.transitioned_at_ms)
}

fn terminal_state(
    plan: &AgentDispatchStopPlanV1,
    transition: &AgentDispatchStopTerminalTransitionV1,
) -> Result<AgentDispatchStopStateV1, DomainStoreErrorV1> {
    Ok(match transition {
        AgentDispatchStopTerminalTransitionV1::Preserved { runtime_close } => {
            if !plan.workspace_plan.is_preserve() {
                return Err(invalid(
                    "workspaceDisposition",
                    "only a preserve plan can finish without a checkout receipt",
                ));
            }
            AgentDispatchStopStateV1::WorkspacePreserved {
                runtime: runtime_receipt(plan, runtime_close, AgentRuntimeCloseStateV1::Stopped)?,
            }
        }
        AgentDispatchStopTerminalTransitionV1::Succeeded {
            runtime_close,
            workspace,
        } => {
            let runtime = runtime_receipt(plan, runtime_close, AgentRuntimeCloseStateV1::Stopped)?;
            let Some(owned_checkout) = plan.owned_checkout() else {
                return Err(invalid(
                    "workspaceDisposition",
                    "a preserve plan cannot accept a checkout removal receipt",
                ));
            };
            if workspace.schema_version != GIT_CHECKOUT_SCHEMA_VERSION_V1 {
                return Err(invalid(
                    "workspace.schemaVersion",
                    "unsupported Git checkout removal receipt schema",
                ));
            }
            if workspace.instance.schema_version != GIT_CHECKOUT_SCHEMA_VERSION_V1 {
                return Err(invalid(
                    "workspace.instance.schemaVersion",
                    "unsupported Git checkout instance schema",
                ));
            }
            if workspace.instance != owned_checkout.instance {
                return Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "Agent dispatch stop checkout",
                    id: plan.spawn.workspace.workspace_id().as_str().into(),
                    reason: "removal receipt does not match the frozen checkout instance".into(),
                });
            }
            AgentDispatchStopStateV1::Succeeded {
                runtime,
                workspace: workspace.clone(),
            }
        }
        AgentDispatchStopTerminalTransitionV1::SourceRetained { runtime_close } => {
            AgentDispatchStopStateV1::SourceRetained {
                runtime: runtime_receipt(
                    plan,
                    runtime_close,
                    AgentRuntimeCloseStateV1::SourceRetained,
                )?,
            }
        }
        AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced { runtime_close } => {
            if plan.owned_checkout().is_none() {
                return Err(invalid(
                    "workspaceDisposition",
                    "a preserve plan cannot report checkout replacement",
                ));
            }
            AgentDispatchStopStateV1::WorkspaceReplaced {
                runtime: runtime_receipt(plan, runtime_close, AgentRuntimeCloseStateV1::Stopped)?,
            }
        }
    })
}

fn validate_close_intent(
    plan: &AgentDispatchStopPlanV1,
    intent: &AgentRuntimeCloseIntentV1,
) -> Result<(), DomainStoreErrorV1> {
    if intent.operation_id == plan.operation_id
        || intent.source != plan.runtime_selection
        || intent.source_authority != plan.runtime_authority
        || intent.stopped_transition != plan.stopped_transition_for_close()
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop runtime close",
            id: intent.operation_id.as_str().into(),
            reason: "child close does not match the frozen operation and runtime authority".into(),
        });
    }
    Ok(())
}

fn validate_runtime_fence(
    fence: Option<&AgentDispatchStopRuntimeFenceV1>,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentRuntimeBindingAuthorityV1,
    planned_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    match fence {
        None => Ok(()),
        Some(AgentDispatchStopRuntimeFenceV1::Close { record }) => {
            record.validate()?;
            if planned_at_ms < record.updated_at_ms {
                return Err(invalid(
                    "plannedAtMs",
                    "must not precede the frozen runtime close",
                ));
            }
            if record.intent.source != *selection || record.intent.source_authority != *authority {
                return Err(invalid(
                    "runtimeFence",
                    "close record does not match the frozen runtime",
                ));
            }
            Ok(())
        }
        Some(AgentDispatchStopRuntimeFenceV1::Transition { record }) => {
            record.validate()?;
            if planned_at_ms < record.updated_at_ms {
                return Err(invalid(
                    "plannedAtMs",
                    "must not precede the frozen runtime transition",
                ));
            }
            let matches = match record.state {
                AgentRuntimeTransitionStateV1::Admitted
                | AgentRuntimeTransitionStateV1::SourceStopped
                | AgentRuntimeTransitionStateV1::RepairRequired => {
                    record.intent.source == *selection
                        && record.intent.source_authority == *authority
                }
                AgentRuntimeTransitionStateV1::TargetStarted => {
                    record.intent.target_selection_at(planned_at_ms)? == *selection
                        && record.target_authority.as_ref() == Some(authority)
                }
                AgentRuntimeTransitionStateV1::SourceRetained
                | AgentRuntimeTransitionStateV1::Committed
                | AgentRuntimeTransitionStateV1::Superseded => false,
            };
            if !matches {
                return Err(invalid(
                    "runtimeFence",
                    "transition record does not match the frozen runtime",
                ));
            }
            Ok(())
        }
    }
}

fn terminal_runtime_operation_id(state: &AgentDispatchStopStateV1) -> Option<&OperationIdV1> {
    match state {
        AgentDispatchStopStateV1::Succeeded { runtime, .. }
        | AgentDispatchStopStateV1::WorkspacePreserved { runtime }
        | AgentDispatchStopStateV1::SourceRetained { runtime }
        | AgentDispatchStopStateV1::WorkspaceReplaced { runtime } => Some(&runtime.operation_id),
        AgentDispatchStopStateV1::Planned
        | AgentDispatchStopStateV1::Superseded
        | AgentDispatchStopStateV1::Authorized { .. } => None,
    }
}

fn transition_runtime_close(
    transition: &AgentDispatchStopTerminalTransitionV1,
) -> &AgentRuntimeCloseRecordV1 {
    match transition {
        AgentDispatchStopTerminalTransitionV1::Preserved { runtime_close }
        | AgentDispatchStopTerminalTransitionV1::Succeeded { runtime_close, .. }
        | AgentDispatchStopTerminalTransitionV1::SourceRetained { runtime_close }
        | AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced { runtime_close } => {
            runtime_close
        }
    }
}

fn authorization_replay_matches(
    current: &AgentDispatchStopRecordV1,
    authorized: &AgentDispatchStopStateV1,
    runtime_close: &AgentRuntimeCloseRecordV1,
    request: &AgentDispatchStopAuthorizeRequestV1,
) -> bool {
    match &current.state {
        state @ AgentDispatchStopStateV1::Authorized { .. } => {
            state == authorized
                && request.expected_journal_revision.checked_add(1)
                    == Some(current.journal_revision)
        }
        state @ (AgentDispatchStopStateV1::Succeeded { .. }
        | AgentDispatchStopStateV1::WorkspacePreserved { .. }
        | AgentDispatchStopStateV1::SourceRetained { .. }
        | AgentDispatchStopStateV1::WorkspaceReplaced { .. }) => {
            terminal_runtime_receipt(state).is_some_and(|receipt| {
                receipt.operation_id == runtime_close.intent.operation_id
                    && receipt.journal_revision == runtime_close.journal_revision
                    && receipt.outcome == runtime_close.state
            }) && request.expected_journal_revision.checked_add(2) == Some(current.journal_revision)
        }
        AgentDispatchStopStateV1::Planned | AgentDispatchStopStateV1::Superseded => false,
    }
}

fn terminal_runtime_receipt(
    state: &AgentDispatchStopStateV1,
) -> Option<&AgentDispatchStopRuntimeReceiptV1> {
    match state {
        AgentDispatchStopStateV1::Succeeded { runtime, .. }
        | AgentDispatchStopStateV1::WorkspacePreserved { runtime }
        | AgentDispatchStopStateV1::SourceRetained { runtime }
        | AgentDispatchStopStateV1::WorkspaceReplaced { runtime } => Some(runtime),
        AgentDispatchStopStateV1::Planned
        | AgentDispatchStopStateV1::Superseded
        | AgentDispatchStopStateV1::Authorized { .. } => None,
    }
}

fn terminal_replay_matches(
    current: &AgentDispatchStopStateV1,
    requested: &AgentDispatchStopStateV1,
) -> bool {
    match (current, requested) {
        (
            AgentDispatchStopStateV1::Succeeded {
                runtime: current_runtime,
                workspace: current_workspace,
            },
            AgentDispatchStopStateV1::Succeeded {
                runtime: requested_runtime,
                workspace: requested_workspace,
            },
        ) => {
            current_runtime == requested_runtime
                && current_workspace.instance == requested_workspace.instance
        }
        (
            AgentDispatchStopStateV1::WorkspacePreserved { runtime: current },
            AgentDispatchStopStateV1::WorkspacePreserved { runtime: requested },
        ) => current == requested,
        (
            AgentDispatchStopStateV1::SourceRetained { runtime: current },
            AgentDispatchStopStateV1::SourceRetained { runtime: requested },
        )
        | (
            AgentDispatchStopStateV1::WorkspaceReplaced { runtime: current },
            AgentDispatchStopStateV1::WorkspaceReplaced { runtime: requested },
        ) => current == requested,
        _ => false,
    }
}

fn runtime_receipt(
    plan: &AgentDispatchStopPlanV1,
    record: &AgentRuntimeCloseRecordV1,
    expected: AgentRuntimeCloseStateV1,
) -> Result<AgentDispatchStopRuntimeReceiptV1, DomainStoreErrorV1> {
    record.validate()?;
    validate_close_intent(plan, &record.intent)?;
    if record.state != expected {
        return Err(invalid(
            "runtimeClose.state",
            "does not match the requested terminal outcome",
        ));
    }
    Ok(AgentDispatchStopRuntimeReceiptV1 {
        operation_id: record.intent.operation_id.clone(),
        journal_revision: record.journal_revision,
        outcome: expected,
    })
}

fn validate_cas(
    current: &AgentDispatchStopRecordV1,
    schema_version: u16,
    operation_id: &OperationIdV1,
    plan_token: &AgentDispatchStopPlanTokenV1,
    expected_revision: i64,
) -> Result<(), DomainStoreErrorV1> {
    if schema_version != AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1 {
        return Err(invalid("schemaVersion", "unsupported Agent stop schema"));
    }
    if expected_revision < 1 {
        return Err(invalid("expectedJournalRevision", "must be positive"));
    }
    if operation_id != &current.plan.operation_id || plan_token != &current.plan.plan_token {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "Agent dispatch stop",
            id: operation_id.as_str().into(),
            reason: "operation or immutable plan token changed".into(),
        });
    }
    Ok(())
}

fn ensure_current_revision(
    current: &AgentDispatchStopRecordV1,
    expected_revision: i64,
) -> Result<(), DomainStoreErrorV1> {
    if current.journal_revision != expected_revision {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.plan.agent_id.as_str().into(),
            expected_revision,
            actual_revision: Some(current.journal_revision),
        });
    }
    Ok(())
}

fn advance(
    current: &AgentDispatchStopRecordV1,
    state: AgentDispatchStopStateV1,
    transitioned_at_ms: i64,
) -> Result<AgentDispatchStopRecordV1, DomainStoreErrorV1> {
    let journal_revision = current
        .journal_revision
        .checked_add(1)
        .ok_or_else(|| invalid("journalRevision", "overflowed"))?;
    let mut next = current.clone();
    next.state = state;
    next.journal_revision = journal_revision;
    next.updated_at_ms = transitioned_at_ms;
    Ok(next)
}

/// Persistence restores records by replaying these public preview, childless
/// supersession, authorize, and terminalize boundaries against exact journal
/// authority; compact terminal receipts are never deserialized as fresh authority.
pub trait AgentDispatchStopStore: Send + Sync {
    /// Replays an exact operation first. A different current-runtime plan may
    /// atomically supersede its sole stale Planned blocker; Authorized and an
    /// exact frozen-runtime pair remain conflicts. Terminal attempts do not
    /// prevent a later retry.
    fn plan_agent_dispatch_stop<'a>(
        &'a self,
        plan: &'a AgentDispatchStopPlanV1,
    ) -> DomainStoreFuture<'a, AgentDispatchStopRecordV1>;

    /// Atomically converges the plan's exact runtime fence, admits or reloads
    /// `request.runtime_close_intent`, and authorizes the parent with that
    /// actual child record through the pure reducer.
    fn authorize_agent_dispatch_stop<'a>(
        &'a self,
        request: &'a AgentDispatchStopAuthorizeRequestV1,
    ) -> DomainStoreFuture<'a, (AgentDispatchStopRecordV1, AgentRuntimeCloseRecordV1)>;

    fn terminalize_agent_dispatch_stop<'a>(
        &'a self,
        request: &'a AgentDispatchStopTerminalRequestV1,
    ) -> DomainStoreFuture<'a, AgentDispatchStopRecordV1>;

    fn agent_dispatch_stop<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentDispatchStopRecordV1>>;

    /// Returns the active attempt, then an effect-terminal attempt, then a
    /// superseded attempt. Ties use greatest `(created_at_ms, operation_id)`.
    fn agent_dispatch_stop_for_spawn_operation<'a>(
        &'a self,
        spawn_operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentDispatchStopRecordV1>>;

    fn active_agent_dispatch_stop<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentDispatchStopRecordV1>>;

    /// Returns only Authorized parents for restart recovery under Agent locks.
    fn agent_dispatch_stop_recovery_candidates(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>>;
}

macro_rules! hash_fields {
    ($hash:expr, $($name:literal => $value:expr),+ $(,)?) => {
        $(hash_field($hash, $name, $value);)+
    };
}

fn stop_plan_token(plan: &AgentDispatchStopPlanV1) -> AgentDispatchStopPlanTokenV1 {
    match &plan.workspace_plan {
        AgentDispatchStopWorkspacePlanV1::Preserve => preserve_stop_plan_token(plan),
        AgentDispatchStopWorkspacePlanV1::RemoveOwned { checkout } => {
            legacy_remove_owned_stop_plan_token(plan, checkout)
        }
    }
}

fn legacy_remove_owned_stop_plan_token(
    plan: &AgentDispatchStopPlanV1,
    checkout: &GitCheckoutRemovalRequestV1,
) -> AgentDispatchStopPlanTokenV1 {
    let mut hash = Sha256::new();
    let spawn = &plan.spawn.authority;
    let AgentDispatchStopSpawnWorkspaceV1::DureOwned {
        workspace_id,
        lease,
    } = &plan.spawn.workspace
    else {
        unreachable!("remove_owned plans require Dure-owned spawn authority")
    };
    hash_fields!(&mut hash,
        "contract" => "dure.agent_dispatch_stop.plan/v1",
        "schema" => &plan.schema_version.to_string(),
        "operation" => plan.operation_id.as_str(),
        "agent" => plan.agent_id.as_str(),
        "spawn_operation" => plan.spawn.operation_id.as_str(),
        "spawn_plan" => plan.spawn.plan_token.as_str(),
        "backend" => &spawn.backend_id,
        "backend_generation" => &spawn.backend_generation,
        "project" => spawn.project_id.as_str(),
        "root" => &spawn.root_id,
        "repository" => &spawn.repository_id,
        "workspace" => workspace_id.as_str(),
        "lease" => &lease.lease_id,
        "lease_directory" => &lease.directory_name,
        "retirement" => &lease.retirement_id,
    );
    hash_runtime_selection(&mut hash, &plan.runtime_selection);
    hash_runtime_authority(&mut hash, &plan.runtime_authority);
    hash_runtime_fence(&mut hash, plan.runtime_fence.as_ref());
    hash_checkout_registration(&mut hash, plan.spawn.checkout_registration.as_ref());
    hash_fields!(&mut hash,
        "repository_path" => &checkout.repository_path,
        "checkout_schema" => &checkout.instance.schema_version.to_string(),
        "checkout_path" => &checkout.instance.canonical_path,
        "git_common_dir" => &checkout.instance.git_common_dir,
        "git_dir" => &checkout.instance.git_dir,
        "instance_token" => &checkout.instance.instance_token,
    );
    if checkout.policy == GitCheckoutRemovalPolicyV1::DiscardChanges {
        hash_field(&mut hash, "checkout_policy", checkout.policy.as_str());
    }
    hash_field(&mut hash, "planned_at", &plan.planned_at_ms.to_string());
    AgentDispatchStopPlanTokenV1(format!("sha256:{:x}", hash.finalize()))
}

fn preserve_stop_plan_token(plan: &AgentDispatchStopPlanV1) -> AgentDispatchStopPlanTokenV1 {
    let mut hash = Sha256::new();
    let spawn = &plan.spawn.authority;
    hash_fields!(&mut hash,
        "contract" => "dure.agent_dispatch_stop.plan/preserve-v1",
        "schema" => &plan.schema_version.to_string(),
        "operation" => plan.operation_id.as_str(),
        "agent" => plan.agent_id.as_str(),
        "spawn_operation" => plan.spawn.operation_id.as_str(),
        "spawn_plan" => plan.spawn.plan_token.as_str(),
        "backend" => &spawn.backend_id,
        "backend_generation" => &spawn.backend_generation,
        "project" => spawn.project_id.as_str(),
        "root" => &spawn.root_id,
        "repository" => &spawn.repository_id,
        "workspace_disposition" => "preserve",
    );
    match &plan.spawn.workspace {
        AgentDispatchStopSpawnWorkspaceV1::AdoptedProjectRoot { workspace_id } => {
            hash_fields!(&mut hash,
                "workspace_ownership" => "adopted_project_root",
                "workspace" => workspace_id.as_str(),
            );
        }
        AgentDispatchStopSpawnWorkspaceV1::DureOwned {
            workspace_id,
            lease,
        } => {
            hash_fields!(&mut hash,
                "workspace_ownership" => "dure_owned",
                "workspace" => workspace_id.as_str(),
                "lease" => &lease.lease_id,
                "lease_directory" => &lease.directory_name,
                "retirement" => &lease.retirement_id,
            );
        }
    }
    hash_runtime_selection(&mut hash, &plan.runtime_selection);
    hash_runtime_authority(&mut hash, &plan.runtime_authority);
    hash_runtime_fence(&mut hash, plan.runtime_fence.as_ref());
    hash_checkout_registration(&mut hash, plan.spawn.checkout_registration.as_ref());
    hash_field(&mut hash, "planned_at", &plan.planned_at_ms.to_string());
    AgentDispatchStopPlanTokenV1(format!("sha256:{:x}", hash.finalize()))
}

fn hash_checkout_registration(hash: &mut Sha256, registration: Option<&GitCheckoutRegistrationV1>) {
    if let Some(registration) = registration {
        hash_fields!(hash,
            "registration_repository" => &registration.repository_path,
            "registration_schema" => &registration.instance.schema_version.to_string(),
            "registration_path" => &registration.instance.canonical_path,
            "registration_common_dir" => &registration.instance.git_common_dir,
            "registration_git_dir" => &registration.instance.git_dir,
            "registration_token" => &registration.instance.instance_token,
        );
    }
}

fn hash_runtime_selection(hash: &mut Sha256, value: &AgentRuntimeSelectionV1) {
    hash_fields!(hash,
        "runtime_schema" => &value.schema_version.to_string(),
        "runtime_agent" => value.agent_id.as_str(),
        "provider" => value.provider_id.as_str(),
        "interaction_profile" => match value.interaction_profile {
            AgentInteractionProfileV1::NativeCli => "native_cli",
            AgentInteractionProfileV1::StructuredProtocol => "structured_protocol",
        },
    );
    hash_execution_profile(hash, &value.execution_profile);
    hash_field(hash, "permission", value.permission_mode.as_str());
    hash_option(
        hash,
        "model",
        value.model.as_ref().map(|item| item.as_str()),
    );
    hash_option(
        hash,
        "effort",
        value.effort.as_ref().map(|item| item.as_str()),
    );
    hash_field(hash, "selection_revision", &value.revision.to_string());
    hash_option(
        hash,
        "selected_by",
        value
            .selected_by_operation_id
            .as_ref()
            .map(|id| id.as_str()),
    );
    hash_field(
        hash,
        "selection_updated_at",
        &value.updated_at_ms.to_string(),
    );
}

fn hash_runtime_fence(hash: &mut Sha256, value: Option<&AgentDispatchStopRuntimeFenceV1>) {
    if let Some(value) = value {
        let encoded = serde_json::to_string(value)
            .expect("validated Agent dispatch stop runtime fences are serializable");
        hash_field(hash, "runtime_fence", &encoded);
    }
}

fn hash_runtime_authority(hash: &mut Sha256, value: &AgentRuntimeBindingAuthorityV1) {
    match value {
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => {
            let binding = &authority.binding;
            hash_fields!(hash,
                "runtime_authority" => "native_cli",
                "checkpoint_schema" => &authority.schema_version.to_string(),
                "binding_agent" => binding.agent_id.as_str(),
                "runtime_kind" => binding.runtime_kind_id.as_str(),
                "session" => &binding.session_id,
            );
            hash_option(
                hash,
                "provider_conversation",
                binding.provider_conversation_id.as_deref(),
            );
            hash_option(
                hash,
                "credential_reference",
                binding.credential_reference_id.as_deref(),
            );
            hash_fields!(hash,
                "binding_generation" => &binding.binding_generation.to_string(),
                "bound_at" => &binding.bound_at_ms.to_string(),
                "runtime_workspace" => &authority.runtime_workspace_id,
                "runner_principal" => &authority.runner_principal,
                "runner_instance" => &authority.runner_instance,
                "channel_epoch" => &authority.channel_epoch,
                "host_instance" => &authority.host_instance_id,
                "terminal_epoch" => &authority.terminal_epoch,
                "authority_updated_at" => &authority.updated_at_ms.to_string(),
            );
        }
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            hash_fields!(hash,
                "runtime_authority" => "structured_protocol",
                "binding_schema" => &binding.schema_version.to_string(),
                "interaction_session" => binding.interaction_session_id.as_str(),
                "binding_agent" => binding.agent_id.as_str(),
                "binding_provider" => binding.provider_id.as_str(),
            );
            hash_execution_profile(hash, &binding.execution_profile);
            hash_option(
                hash,
                "provider_conversation",
                binding.provider_conversation_ref.as_deref(),
            );
            hash_fields!(hash,
                "runtime_generation" => &binding.runtime.runtime_generation,
                "provider_epoch" => &binding.runtime.provider_epoch,
                "timeline_epoch" => binding.timeline_epoch.as_str(),
                "binding_revision" => &binding.binding_revision.to_string(),
                "history_complete" => if binding.history_complete { "1" } else { "0" },
                "binding_created_at" => &binding.created_at_ms.to_string(),
                "binding_updated_at" => &binding.updated_at_ms.to_string(),
            );
        }
    }
}

fn hash_execution_profile(hash: &mut Sha256, value: &AgentExecutionProfileV1) {
    match value {
        AgentExecutionProfileV1::ProviderDefault => {
            hash_field(hash, "execution_profile", "provider_default")
        }
        AgentExecutionProfileV1::CredentialReference {
            reference_id,
            credential_generation,
        } => {
            hash_fields!(hash,
                "execution_profile" => "credential_reference",
                "execution_reference" => reference_id,
            );
            hash_option(
                hash,
                "credential_generation",
                credential_generation.as_deref(),
            );
        }
    }
}

fn hash_option(hash: &mut Sha256, name: &str, value: Option<&str>) {
    hash_field(hash, name, if value.is_some() { "some" } else { "none" });
    if let Some(value) = value {
        hash_field(hash, name, value);
    }
}

fn hash_field(hash: &mut Sha256, name: &str, value: &str) {
    hash.update((name.len() as u64).to_be_bytes());
    hash.update(name.as_bytes());
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value.as_bytes());
}

#[cfg(test)]
mod tests;
