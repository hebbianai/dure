use dure_app::{
    AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1, AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
    AgentDispatchStopAuthorizeRequestV1, AgentDispatchStopPlanTokenV1, AgentDispatchStopPreviewV1,
    AgentDispatchStopRecordV1, AgentDispatchStopRuntimeFenceV1, AgentDispatchStopStateV1,
    AgentDispatchStopStore, AgentDispatchStopTerminalRequestV1,
    AgentDispatchStopTerminalTransitionV1, AgentDispatchStopWorkspacePlanV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseIntentV1,
    AgentRuntimeCloseStoppedTransitionV1, AgentRuntimeCloseStore, AgentRuntimeSelectionV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1, AgentSpawnCommittedWorkspaceV1,
    AgentSpawnJournalStore, DomainStore, DomainStoreErrorV1, GitCheckoutRemovalPolicyV1,
    GitCheckoutRemovalRequestV1, OperationIdV1, preview_agent_dispatch_stop_v1,
};
use dure_git_checkout::GitCheckoutInstanceError;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::OwnedMutexGuard;

use crate::agent_runtime_projection::AgentRuntimeObservedV1;
use crate::{
    BackendDispatchError, BackendFailureDispositionV1, ServiceState, agent_runtime_projection,
    now_ms,
};

mod checkout;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DispatchStopPreviewBodyV1 {
    schema_version: u16,
    spawn_operation_id: OperationIdV1,
    #[serde(default = "default_workspace_disposition")]
    workspace_disposition: DispatchStopWorkspaceDispositionV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum DispatchStopWorkspaceDispositionV1 {
    Preserve,
    RemoveOwned,
}

fn default_workspace_disposition() -> DispatchStopWorkspaceDispositionV1 {
    DispatchStopWorkspaceDispositionV1::RemoveOwned
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DispatchStopApplyBodyV1 {
    schema_version: u16,
    operation_id: OperationIdV1,
    plan_token: AgentDispatchStopPlanTokenV1,
    expected_journal_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DispatchStopStatusBodyV1 {
    schema_version: u16,
    spawn_operation_id: OperationIdV1,
}

pub(super) async fn preview(
    state: &ServiceState,
    attempt_id: &str,
    body: DispatchStopPreviewBodyV1,
) -> Result<Value, BackendDispatchError> {
    require_schema(body.schema_version)?;
    let operation_id = stop_operation_id(attempt_id, &body.spawn_operation_id)?;
    let spawn = state
        .store
        .agent_spawn_receipt(&body.spawn_operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| terminal("agent_dispatch_stop_not_found"))?;
    let agent_id = spawn.plan.agent_id.clone();
    let agent_guard = state.agent_operations.acquire(&agent_id).await;

    if let Some(existing) = state
        .store
        .agent_dispatch_stop(&operation_id)
        .await
        .map_err(store_error)?
    {
        return preview_receipt(
            existing,
            &body.spawn_operation_id,
            body.workspace_disposition,
        );
    }
    let spawn = state
        .store
        .agent_spawn_receipt(&body.spawn_operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| terminal("agent_dispatch_stop_not_found"))?;
    let workspace_ownership = spawn
        .committed_workspace_ownership()
        .ok_or_else(|| terminal("agent_dispatch_stop_ownership_unsupported"))?;
    if matches!(
        (body.workspace_disposition, workspace_ownership),
        (
            DispatchStopWorkspaceDispositionV1::RemoveOwned,
            AgentSpawnCommittedWorkspaceV1::AdoptedProjectRoot { .. }
        )
    ) {
        return Err(terminal("agent_dispatch_stop_ownership_unsupported"));
    }
    let runtime = observe_runtime_for_stop_locked(state, &agent_id).await?;
    let (workspace_plan, _agent_guard) = match body.workspace_disposition {
        DispatchStopWorkspaceDispositionV1::Preserve => {
            (AgentDispatchStopWorkspacePlanV1::Preserve, agent_guard)
        }
        DispatchStopWorkspaceDispositionV1::RemoveOwned => {
            let AgentSpawnCommittedWorkspaceV1::DureOwned { workspace_id, .. } =
                workspace_ownership
            else {
                unreachable!("adopted roots are refused before checkout capture")
            };
            let (checkout, agent_guard) =
                checkout::owned_request(state, &spawn, workspace_id, agent_guard).await?;
            (
                AgentDispatchStopWorkspacePlanV1::RemoveOwned { checkout },
                agent_guard,
            )
        }
    };
    let planned_at_ms = clock_at_least(spawn.updated_at_ms.max(runtime.updated_at_ms()))?;
    let runtime = runtime.into_plan(planned_at_ms)?;
    let plan = preview_agent_dispatch_stop_v1(
        AgentDispatchStopPreviewV1 {
            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            operation_id,
            spawn_operation_id: body.spawn_operation_id,
            workspace_plan,
            planned_at_ms,
        },
        &spawn,
        runtime.selection,
        runtime.authority,
        runtime.fence,
    )
    .map_err(store_error)?;
    let record = state
        .store
        .plan_agent_dispatch_stop(&plan)
        .await
        .map_err(store_error)?;
    stop_receipt_response(Some(&record))
}

pub(super) async fn apply(
    state: &ServiceState,
    body: DispatchStopApplyBodyV1,
) -> Result<Value, BackendDispatchError> {
    require_schema(body.schema_version)?;
    if body.expected_journal_revision < 1 {
        return Err(terminal("agent_dispatch_stop_request_invalid"));
    }
    let existing = state
        .store
        .agent_dispatch_stop(&body.operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| terminal("agent_dispatch_stop_not_found"))?;
    let agent_id = existing.plan().agent_id().clone();
    let agent_guard = state.agent_operations.acquire(&agent_id).await;
    let current = state
        .store
        .agent_dispatch_stop(&body.operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| terminal("agent_dispatch_stop_not_found"))?;
    if current.plan().plan_token() != &body.plan_token {
        return Err(conflict("agent_dispatch_stop_conflict"));
    }
    if matches!(current.state(), AgentDispatchStopStateV1::Superseded) {
        if body.expected_journal_revision.checked_add(1) != Some(current.journal_revision()) {
            return Err(conflict("agent_dispatch_stop_conflict"));
        }
        return stop_receipt_response(Some(&current));
    }
    if matches!(
        current.state(),
        AgentDispatchStopStateV1::Succeeded { .. }
            | AgentDispatchStopStateV1::SourceRetained { .. }
            | AgentDispatchStopStateV1::WorkspacePreserved { .. }
            | AgentDispatchStopStateV1::WorkspaceReplaced { .. }
    ) {
        if body.expected_journal_revision.checked_add(2) != Some(current.journal_revision()) {
            return Err(conflict("agent_dispatch_stop_conflict"));
        }
        return stop_receipt_response(Some(&current));
    }
    if matches!(current.state(), AgentDispatchStopStateV1::Authorized { .. }) {
        if body.expected_journal_revision.checked_add(1) != Some(current.journal_revision()) {
            return Err(conflict("agent_dispatch_stop_conflict"));
        }
        state.agent_runtime_recovery_wake.notify_one();
        let terminal = drive_locked(state, &current, agent_guard).await?;
        return stop_receipt_response(Some(&terminal));
    }
    let request = authorize_request(&current, &body)?;
    let (authorized, _) = state
        .store
        .authorize_agent_dispatch_stop(&request)
        .await
        .map_err(store_error)?;
    state.agent_runtime_recovery_wake.notify_one();
    let terminal = drive_locked(state, &authorized, agent_guard).await?;
    stop_receipt_response(Some(&terminal))
}

pub(super) async fn status(
    state: &ServiceState,
    body: DispatchStopStatusBodyV1,
) -> Result<Value, BackendDispatchError> {
    require_schema(body.schema_version)?;
    let receipt = state
        .store
        .agent_dispatch_stop_for_spawn_operation(&body.spawn_operation_id)
        .await
        .map_err(store_error)?;
    stop_receipt_response(receipt.as_ref())
}

pub(super) async fn drive_locked(
    state: &ServiceState,
    stop: &AgentDispatchStopRecordV1,
    agent_guard: OwnedMutexGuard<()>,
) -> Result<AgentDispatchStopRecordV1, BackendDispatchError> {
    let child_operation_id = match stop.state() {
        AgentDispatchStopStateV1::Authorized {
            runtime_close_operation_id,
        } => runtime_close_operation_id,
        AgentDispatchStopStateV1::Succeeded { .. }
        | AgentDispatchStopStateV1::Superseded
        | AgentDispatchStopStateV1::SourceRetained { .. }
        | AgentDispatchStopStateV1::WorkspacePreserved { .. }
        | AgentDispatchStopStateV1::WorkspaceReplaced { .. } => return Ok(stop.clone()),
        AgentDispatchStopStateV1::Planned => {
            return Err(conflict("agent_dispatch_stop_not_authorized"));
        }
    };
    let child = state
        .store
        .agent_runtime_close(child_operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| retry("agent_dispatch_stop_runtime_unavailable"))?;
    let (transition, _agent_guard) = checkout::drive(state, stop, &child, agent_guard).await?;
    let child_updated_at_ms = match &transition {
        AgentDispatchStopTerminalTransitionV1::Preserved { runtime_close }
        | AgentDispatchStopTerminalTransitionV1::Succeeded { runtime_close, .. }
        | AgentDispatchStopTerminalTransitionV1::SourceRetained { runtime_close }
        | AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced { runtime_close } => {
            runtime_close.updated_at_ms
        }
    };
    state
        .store
        .terminalize_agent_dispatch_stop(&AgentDispatchStopTerminalRequestV1 {
            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            operation_id: stop.plan().operation_id().clone(),
            plan_token: stop.plan().plan_token().clone(),
            expected_journal_revision: stop.journal_revision(),
            transition,
            transitioned_at_ms: clock_at_least(stop.updated_at_ms().max(child_updated_at_ms))?,
        })
        .await
        .map_err(store_error)
}

struct DispatchStopRuntimePlan {
    selection: AgentRuntimeSelectionV1,
    authority: AgentRuntimeBindingAuthorityV1,
    fence: Option<AgentDispatchStopRuntimeFenceV1>,
}

enum DispatchStopRuntimeObservation {
    Stable {
        selection: Box<AgentRuntimeSelectionV1>,
        authority: Box<AgentRuntimeBindingAuthorityV1>,
    },
    Closed(Box<dure_app::AgentRuntimeCloseRecordV1>),
    Transitioning(Box<AgentRuntimeTransitionRecordV1>),
}

impl DispatchStopRuntimeObservation {
    fn updated_at_ms(&self) -> i64 {
        match self {
            Self::Stable { selection, .. } => selection.updated_at_ms,
            Self::Closed(close) => close.updated_at_ms,
            Self::Transitioning(transition) => transition.updated_at_ms,
        }
    }

    fn into_plan(
        self,
        planned_at_ms: i64,
    ) -> Result<DispatchStopRuntimePlan, BackendDispatchError> {
        match self {
            Self::Stable {
                selection,
                authority,
            } => Ok(DispatchStopRuntimePlan {
                selection: *selection,
                authority: *authority,
                fence: None,
            }),
            Self::Closed(close) => Ok(DispatchStopRuntimePlan {
                selection: close.intent.source.clone(),
                authority: close.intent.source_authority.clone(),
                fence: Some(AgentDispatchStopRuntimeFenceV1::Close { record: close }),
            }),
            Self::Transitioning(transition) => {
                let (selection, authority) = match transition.state {
                    AgentRuntimeTransitionStateV1::Admitted
                    | AgentRuntimeTransitionStateV1::SourceStopped
                    | AgentRuntimeTransitionStateV1::RepairRequired => (
                        transition.intent.source.clone(),
                        transition.intent.source_authority.clone(),
                    ),
                    AgentRuntimeTransitionStateV1::TargetStarted => (
                        transition
                            .intent
                            .target_selection_at(planned_at_ms)
                            .map_err(store_error)?,
                        transition
                            .target_authority
                            .clone()
                            .ok_or_else(|| conflict("agent_dispatch_stop_conflict"))?,
                    ),
                    AgentRuntimeTransitionStateV1::SourceRetained
                    | AgentRuntimeTransitionStateV1::Committed
                    | AgentRuntimeTransitionStateV1::Superseded => {
                        unreachable!("terminal transitions are not active")
                    }
                };
                Ok(DispatchStopRuntimePlan {
                    selection,
                    authority,
                    fence: Some(AgentDispatchStopRuntimeFenceV1::Transition { record: transition }),
                })
            }
        }
    }
}

async fn observe_runtime_for_stop_locked(
    state: &ServiceState,
    agent_id: &dure_app::AgentIdV1,
) -> Result<DispatchStopRuntimeObservation, BackendDispatchError> {
    match agent_runtime_projection::read_locked(state, agent_id)
        .await
        .map_err(observation_error)?
    {
        AgentRuntimeObservedV1::Unmanaged => Err(terminal("agent_dispatch_stop_runtime_not_found")),
        AgentRuntimeObservedV1::Stable {
            selection,
            authority,
        } => Ok(DispatchStopRuntimeObservation::Stable {
            selection,
            authority,
        }),
        AgentRuntimeObservedV1::Closed(close) => Ok(DispatchStopRuntimeObservation::Closed(close)),
        AgentRuntimeObservedV1::Transitioning { transition, .. } => {
            Ok(DispatchStopRuntimeObservation::Transitioning(transition))
        }
    }
}

fn authorize_request(
    stop: &AgentDispatchStopRecordV1,
    body: &DispatchStopApplyBodyV1,
) -> Result<AgentDispatchStopAuthorizeRequestV1, BackendDispatchError> {
    let plan = stop.plan();
    let runtime_close_intent = match plan.runtime_fence() {
        Some(AgentDispatchStopRuntimeFenceV1::Close { record }) => record.intent.clone(),
        Some(AgentDispatchStopRuntimeFenceV1::Transition { .. }) | None => {
            new_close_intent(plan, plan.stopped_transition_for_close())?
        }
    };
    let requested_at_ms = plan.planned_at_ms();
    Ok(AgentDispatchStopAuthorizeRequestV1 {
        schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
        operation_id: body.operation_id.clone(),
        plan_token: body.plan_token.clone(),
        expected_journal_revision: body.expected_journal_revision,
        runtime_close_intent,
        authorized_at_ms: requested_at_ms.max(stop.updated_at_ms()),
    })
}

fn new_close_intent(
    plan: &dure_app::AgentDispatchStopPlanV1,
    stopped_transition: Option<AgentRuntimeCloseStoppedTransitionV1>,
) -> Result<AgentRuntimeCloseIntentV1, BackendDispatchError> {
    let (operation_id, idempotency_key) = close_identity(plan.operation_id())?;
    Ok(AgentRuntimeCloseIntentV1 {
        schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
        operation_id,
        idempotency_key,
        source: plan.runtime_selection().clone(),
        source_authority: plan.runtime_authority().clone(),
        stopped_transition,
        requested_at_ms: plan.planned_at_ms(),
    })
}

async fn load_child(
    state: &ServiceState,
    operation_id: &OperationIdV1,
) -> Result<dure_app::AgentRuntimeCloseRecordV1, BackendDispatchError> {
    state
        .store
        .agent_runtime_close(operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| retry("agent_dispatch_stop_runtime_unavailable"))
}

fn preview_receipt(
    existing: AgentDispatchStopRecordV1,
    spawn_operation_id: &OperationIdV1,
    workspace_disposition: DispatchStopWorkspaceDispositionV1,
) -> Result<Value, BackendDispatchError> {
    let disposition_matches = matches!(
        (workspace_disposition, existing.plan().workspace_plan()),
        (
            DispatchStopWorkspaceDispositionV1::Preserve,
            AgentDispatchStopWorkspacePlanV1::Preserve
        ) | (
            DispatchStopWorkspaceDispositionV1::RemoveOwned,
            AgentDispatchStopWorkspacePlanV1::RemoveOwned { .. }
        )
    );
    if existing.plan().spawn().operation_id != *spawn_operation_id || !disposition_matches {
        return Err(conflict("agent_dispatch_stop_conflict"));
    }
    stop_receipt_response(Some(&existing))
}

fn stop_receipt_response(
    receipt: Option<&AgentDispatchStopRecordV1>,
) -> Result<Value, BackendDispatchError> {
    let Some(receipt) = receipt else {
        return Ok(json!({ "schemaVersion": 1, "receipt": null }));
    };
    let mut projected =
        serde_json::to_value(receipt).map_err(|_| retry("agent_dispatch_stop_store_failed"))?;
    if matches!(
        receipt.plan().workspace_plan(),
        AgentDispatchStopWorkspacePlanV1::RemoveOwned { .. }
    ) {
        let plan = projected
            .get_mut("plan")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| retry("agent_dispatch_stop_store_failed"))?;
        if plan.remove("workspaceDisposition").is_none() {
            return Err(retry("agent_dispatch_stop_store_failed"));
        }
        let spawn = plan
            .get_mut("spawn")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| retry("agent_dispatch_stop_store_failed"))?;
        if spawn.remove("workspaceOwnership").is_none() {
            return Err(retry("agent_dispatch_stop_store_failed"));
        }
    }
    Ok(json!({ "schemaVersion": 1, "receipt": projected }))
}

fn stop_operation_id(
    attempt_id: &str,
    spawn_operation_id: &OperationIdV1,
) -> Result<OperationIdV1, BackendDispatchError> {
    let digest = identity_digest(
        b"dure-agent-dispatch-stop-attempt/v1\0",
        &[
            attempt_id.as_bytes(),
            spawn_operation_id.as_str().as_bytes(),
        ],
    );
    OperationIdV1::new(format!("dispatch-stop-{digest}"))
        .map_err(|_| terminal("agent_dispatch_stop_request_invalid"))
}

fn close_identity(
    stop_operation_id: &OperationIdV1,
) -> Result<(OperationIdV1, String), BackendDispatchError> {
    let digest = identity_digest(
        b"dure-agent-dispatch-stop-runtime-close/v1\0",
        &[stop_operation_id.as_str().as_bytes()],
    );
    let operation_id = OperationIdV1::new(format!("dispatch-stop-close-{digest}"))
        .map_err(|_| terminal("agent_dispatch_stop_request_invalid"))?;
    Ok((operation_id, format!("dispatch-stop-close-{digest}")))
}

fn identity_digest(namespace: &[u8], fields: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest.update(namespace);
    for field in fields {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field);
    }
    format!("{:x}", digest.finalize())
}

fn require_schema(schema_version: u16) -> Result<(), BackendDispatchError> {
    if schema_version != AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1 {
        return Err(terminal("agent_dispatch_stop_request_invalid"));
    }
    Ok(())
}

fn clock_at_least(minimum: i64) -> Result<i64, BackendDispatchError> {
    now_ms()
        .map(|value| value.max(minimum))
        .map_err(|_| retry("agent_dispatch_stop_clock_unavailable"))
}

fn observation_error(code: String) -> BackendDispatchError {
    match code.as_str() {
        "agent_runtime_observation_authority_unavailable"
        | "agent_runtime_observation_authority_stale" => conflict("agent_dispatch_stop_conflict"),
        _ => retry("agent_dispatch_stop_runtime_unavailable"),
    }
}

fn capture_error(error: GitCheckoutInstanceError) -> BackendDispatchError {
    match error.code {
        "worktree_path_not_distinct" | "worktree_request_invalid" => {
            terminal("agent_dispatch_stop_ownership_unsupported")
        }
        _ => retry("agent_dispatch_stop_checkout_unavailable"),
    }
}

fn store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    match error {
        DomainStoreErrorV1::NotFound { .. } => terminal("agent_dispatch_stop_not_found"),
        DomainStoreErrorV1::InvalidRecord {
            field: "spawnReceipt",
            ..
        } => terminal("agent_dispatch_stop_ownership_unsupported"),
        DomainStoreErrorV1::InvalidRecord { .. }
        | DomainStoreErrorV1::InvalidEventStream { .. } => {
            terminal("agent_dispatch_stop_request_invalid")
        }
        DomainStoreErrorV1::IdentityConflict { .. }
        | DomainStoreErrorV1::IdempotencyConflict { .. }
        | DomainStoreErrorV1::RevisionConflict { .. } => conflict("agent_dispatch_stop_conflict"),
        _ => retry("agent_dispatch_stop_store_failed"),
    }
}

fn terminal(code: &'static str) -> BackendDispatchError {
    BackendDispatchError::from(code).with_disposition(BackendFailureDispositionV1::Terminal)
}

fn conflict(code: &'static str) -> BackendDispatchError {
    BackendDispatchError::from(code).with_disposition(BackendFailureDispositionV1::StaleGeneration)
}

fn retry(code: &'static str) -> BackendDispatchError {
    BackendDispatchError::from(code).with_disposition(BackendFailureDispositionV1::RetrySame)
}
