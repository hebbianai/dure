mod create_run;

use std::collections::BTreeMap;

use agent_orchestration::contract::{
    AnswerDecisionReceipt, AnswerDecisionRequest, CompleteDispatchReceipt, CompleteDispatchRequest,
    CreateRunReceipt, CreateRunRequest, DispatchContextReceipt, Event, GetInteractionRequest,
    InspectEventsRequest, OpenInteractionReceipt, OpenInteractionRequest, ReadEventsReceipt,
    ReadEventsRequest, TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest,
};
use agent_orchestration::domain::{
    AudienceGrant, AuthorityScope, CapabilityRef, DispatchId, DispatchRecord, DispatchState,
    Generation, IntegrationCapabilityReceipt, InteractionId, InteractionRecord, InteractionTarget,
    MessagePurpose, Revision, RunId, RuntimeRef, SessionIdentityRef, TaskId, TenantRef,
    WorkerEndpoint, WorkerEndpointFence, WorkspaceId, validate_idempotency_key, validate_timestamp,
};
use agent_orchestration::ports::state::{DeliveryEntry, StoreState};
use agent_orchestration::ports::{
    ReadEventsStoreRequest, ReadEventsStoreResult, Store, StoreError, StoreFuture, StoreHandle,
};
use agent_orchestration::service::InteractionService;
use dure_app::{
    AgentIdV1, AgentInteractionProfileV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1, DispatchIdV1,
    DomainStoreErrorV1, ProviderIdV1, RuntimeKindIdV1, TaskIdV1, WorkflowSessionGenerationV1,
    agent_runtime_native_launch_identity_v1, validate_workflow_effective_launch_identity,
    workflow_prepared_session_id,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{identity_conflict, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};
use crate::{
    agent_runtime_transition::selection_on,
    checkpoint_bindings::authority_on as checkpoint_authority_on,
};

pub const MAX_ORCHESTRATION_CONTEXT_BATCH_ITEMS: usize = 32;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationDispatchContextRequestV1 {
    pub schema_version: u16,
    pub target: InteractionTarget,
    pub session: WorkflowSessionGenerationV1,
    pub integration_receipt: IntegrationCapabilityReceipt,
    pub idempotency_key: String,
    pub resolved_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrchestrationDispatchContextResolutionV1 {
    Found(Box<DispatchContextReceipt>),
    NoDispatch,
    DomainError(DomainStoreErrorV1),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrchestrationDispatchContextBatchItemV1 {
    pub session: WorkflowSessionGenerationV1,
    pub resolution: OrchestrationDispatchContextResolutionV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationDispatchSessionInspectionOutcomeV1 {
    ActiveDispatch,
    Unassigned,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationDispatchSessionInspectionReceiptV1 {
    pub schema_version: u16,
    pub outcome: OrchestrationDispatchSessionInspectionOutcomeV1,
    pub session: WorkflowSessionGenerationV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<InteractionTarget>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrchestrationManagedCreateKeyStateV1 {
    NotRequired,
    Present,
    Missing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationDispatchSessionRebindRequestV1 {
    pub schema_version: u16,
    pub operation_id: String,
    pub source: WorkflowSessionGenerationV1,
    pub target: WorkflowSessionGenerationV1,
    pub rebound_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationDispatchGenerationV1 {
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
}

fn validate_dispatch_session_rebind(
    schema_version: u16,
    operation_id: &str,
    source: &WorkflowSessionGenerationV1,
    target: &WorkflowSessionGenerationV1,
    rebound_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    if schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
        return Err(invalid("schemaVersion", "must be 1"));
    }
    validate_idempotency_key(operation_id).map_err(|error| invalid(error.field, error.code))?;
    source.validate()?;
    target.validate()?;
    validate_timestamp("reboundAtMs", rebound_at_ms)
        .map_err(|error| invalid(error.field, error.code))?;
    if source == target {
        return Err(invalid(
            "target",
            "must identify a different Session generation",
        ));
    }
    if source.workspace_id != target.workspace_id || source.provider_id != target.provider_id {
        return Err(invalid(
            "target",
            "must preserve the source workspace and provider",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OrchestrationDispatchRuntimeAuthorityV1 {
    pub(crate) agent_id: AgentIdV1,
    pub(crate) binding_generation: i64,
    pub(crate) runtime_kind_id: RuntimeKindIdV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OrchestrationDispatchSessionRebindMutationV1 {
    operation_id: String,
    source: WorkflowSessionGenerationV1,
    target: WorkflowSessionGenerationV1,
    expected_source_dispatch_authority: Option<OrchestrationDispatchRuntimeAuthorityV1>,
    expected_target_dispatch_authority: Option<OrchestrationDispatchRuntimeAuthorityV1>,
    target_launch_idempotency_key: Option<String>,
    rebound_at_ms: i64,
}

impl OrchestrationDispatchSessionRebindMutationV1 {
    pub(crate) fn try_new(
        schema_version: u16,
        operation_id: String,
        source: WorkflowSessionGenerationV1,
        target: WorkflowSessionGenerationV1,
        target_launch_idempotency_key: Option<String>,
        rebound_at_ms: i64,
    ) -> Result<Self, DomainStoreErrorV1> {
        validate_dispatch_session_rebind(
            schema_version,
            &operation_id,
            &source,
            &target,
            rebound_at_ms,
        )?;
        if let Some(key) = &target_launch_idempotency_key {
            validate_idempotency_key(key).map_err(|error| invalid(error.field, error.code))?;
        }
        Ok(Self {
            operation_id,
            source,
            target,
            expected_source_dispatch_authority: None,
            expected_target_dispatch_authority: None,
            target_launch_idempotency_key,
            rebound_at_ms,
        })
    }

    fn from_request(
        request: &OrchestrationDispatchSessionRebindRequestV1,
        target_launch_idempotency_key: Option<&str>,
    ) -> Result<Self, DomainStoreErrorV1> {
        Self::try_new(
            request.schema_version,
            request.operation_id.clone(),
            request.source.clone(),
            request.target.clone(),
            target_launch_idempotency_key.map(str::to_owned),
            request.rebound_at_ms,
        )
    }

    pub(crate) fn from_committed_native_runtime_transition(
        record: &AgentRuntimeTransitionRecordV1,
        rebound_at_ms: i64,
    ) -> Result<Option<Self>, DomainStoreErrorV1> {
        record.validate()?;
        if record.state != AgentRuntimeTransitionStateV1::Committed {
            return Err(identity_conflict(
                "agent runtime transition",
                record.intent.operation_id.as_str(),
                "only a committed transition may move reporting lineage",
            ));
        }
        let (
            AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority,
            },
            Some(AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: target_authority,
            }),
        ) = (&record.intent.source_authority, &record.target_authority)
        else {
            return Ok(None);
        };
        let source = WorkflowSessionGenerationV1::from_checkpoint_authority(
            source_authority,
            &record.intent.source.provider_id,
        );
        let target = WorkflowSessionGenerationV1::from_checkpoint_authority(
            target_authority,
            &record.intent.source.provider_id,
        );
        if source_authority.binding.agent_id != target_authority.binding.agent_id
            || source_authority.binding.runtime_kind_id != target_authority.binding.runtime_kind_id
        {
            return Err(identity_conflict(
                "agent runtime transition",
                record.intent.operation_id.as_str(),
                "reporting lineage cannot cross Agents or runtime kinds",
            ));
        }
        if source == target {
            return Ok(None);
        }
        source.validate()?;
        target.validate()?;
        validate_timestamp("reboundAtMs", rebound_at_ms)
            .map_err(|error| invalid(error.field, error.code))?;
        let target_attempt_operation_id = record
            .last_repair_operation_id
            .as_ref()
            .unwrap_or(&record.intent.operation_id);
        let target_launch_idempotency_key =
            record.target_launch_idempotency_key.clone().or_else(|| {
                Some(
                    agent_runtime_native_launch_identity_v1(target_attempt_operation_id)
                        .launch_idempotency_key,
                )
            });
        Ok(Some(Self {
            operation_id: target_attempt_operation_id.as_str().to_owned(),
            source,
            target,
            expected_source_dispatch_authority: Some(OrchestrationDispatchRuntimeAuthorityV1 {
                agent_id: source_authority.binding.agent_id.clone(),
                binding_generation: source_authority.binding.binding_generation,
                runtime_kind_id: source_authority.binding.runtime_kind_id.clone(),
            }),
            expected_target_dispatch_authority: Some(OrchestrationDispatchRuntimeAuthorityV1 {
                agent_id: target_authority.binding.agent_id.clone(),
                binding_generation: target_authority.binding.binding_generation,
                runtime_kind_id: target_authority.binding.runtime_kind_id.clone(),
            }),
            target_launch_idempotency_key,
            rebound_at_ms,
        }))
    }

    pub(crate) fn source(&self) -> &WorkflowSessionGenerationV1 {
        &self.source
    }

    pub(crate) fn target(&self) -> &WorkflowSessionGenerationV1 {
        &self.target
    }

    pub(crate) fn append_verified_native_successor(
        mut self,
        successor: Self,
    ) -> Result<Self, DomainStoreErrorV1> {
        if self.target != successor.source {
            return Err(identity_conflict(
                "agent runtime transition",
                &successor.operation_id,
                "the committed native transition chain is not contiguous",
            ));
        }
        let (Some(boundary), Some(next_source)) = (
            &self.expected_target_dispatch_authority,
            &successor.expected_source_dispatch_authority,
        ) else {
            return Err(identity_conflict(
                "agent runtime transition",
                &successor.operation_id,
                "the committed native transition chain has no Dispatch authority",
            ));
        };
        if boundary != next_source {
            return Err(identity_conflict(
                "agent runtime transition",
                &successor.operation_id,
                "the committed native transition authority chain is not contiguous",
            ));
        }
        self.operation_id = successor.operation_id;
        self.target = successor.target;
        self.expected_target_dispatch_authority = successor.expected_target_dispatch_authority;
        self.target_launch_idempotency_key = successor.target_launch_idempotency_key;
        self.rebound_at_ms = successor.rebound_at_ms;
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationDispatchSessionRebindOutcomeV1 {
    Rebound,
    Unassigned,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationDispatchSessionRebindReceiptV1 {
    pub schema_version: u16,
    pub operation_id: String,
    pub outcome: OrchestrationDispatchSessionRebindOutcomeV1,
    pub source: WorkflowSessionGenerationV1,
    pub target: WorkflowSessionGenerationV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExistingSessionRunAuthority {
    pub authority: AuthorityScope,
    pub runtime_ref: RuntimeRef,
    pub provider_conversation_id: Option<String>,
}

impl OrchestrationDispatchContextRequestV1 {
    fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
            return Err(invalid("schemaVersion", "must be 1"));
        }
        self.target
            .validate()
            .map_err(|error| invalid(error.field, error.code))?;
        self.session.validate()?;
        self.integration_receipt
            .validate()
            .map_err(|error| invalid(error.field, error.code))?;
        validate_idempotency_key(&self.idempotency_key)
            .map_err(|error| invalid(error.field, error.code))?;
        validate_timestamp("resolvedAtMs", self.resolved_at_ms)
            .map_err(|error| invalid(error.field, error.code))?;
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct WorkflowInteractionStore {
    pool: SqlitePool,
}

impl WorkflowInteractionStore {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn mutate<T>(
        &self,
        authority: &AuthorityScope,
        transition: impl FnOnce(&mut StoreState) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.transact(authority, |state| {
            transition(state).map(|result| (result, true))
        })
        .await
    }

    async fn transact<T>(
        &self,
        authority: &AuthorityScope,
        transition: impl FnOnce(&mut StoreState) -> Result<(T, bool), StoreError>,
    ) -> Result<T, StoreError> {
        let mut connection = self.pool.acquire().await.map_err(|_| unavailable())?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .map_err(|_| unavailable())?;
        let outcome = async {
            let mut state = load_state(&mut connection, authority).await?;
            let (result, changed) = transition(&mut state)?;
            if changed {
                persist_state(&mut connection, authority, &state).await?;
            }
            Ok(result)
        }
        .await;
        finish_store_transaction(&mut connection, outcome).await
    }

    async fn read_transact<T>(
        &self,
        authority: &AuthorityScope,
        transition: impl Fn(&mut StoreState) -> Result<(T, bool), StoreError>,
    ) -> Result<T, StoreError> {
        let mut connection = self.pool.acquire().await.map_err(|_| unavailable())?;
        sqlx::query("BEGIN")
            .execute(&mut *connection)
            .await
            .map_err(|_| unavailable())?;
        let outcome = async {
            let mut state = load_state(&mut connection, authority).await?;
            transition(&mut state)
        }
        .await;
        let (result, changed) = finish_store_transaction(&mut connection, outcome).await?;
        if !changed {
            return Ok(result);
        }
        drop(connection);
        self.transact(authority, transition).await
    }

    async fn inspect<T>(
        &self,
        authority: &AuthorityScope,
        query: impl FnOnce(&StoreState) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut connection = self.pool.acquire().await.map_err(|_| unavailable())?;
        sqlx::query("BEGIN")
            .execute(&mut *connection)
            .await
            .map_err(|_| unavailable())?;
        let outcome = async {
            let state = load_state(&mut connection, authority).await?;
            query(&state)
        }
        .await;
        finish_store_transaction(&mut connection, outcome).await
    }
}

impl Store for WorkflowInteractionStore {
    fn create_run<'a>(
        &'a self,
        request: CreateRunRequest,
        context: DispatchContextReceipt,
        fingerprint: String,
    ) -> StoreFuture<'a, CreateRunReceipt> {
        Box::pin(async move { self.create_durable_run(request, context, fingerprint).await })
    }

    fn open_interaction<'a>(
        &'a self,
        request: OpenInteractionRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, OpenInteractionReceipt> {
        let authority = request.interaction.common().target.authority.clone();
        Box::pin(async move {
            self.mutate(&authority, |state| state.open(request, fingerprint))
                .await
        })
    }

    fn interaction<'a>(
        &'a self,
        request: &'a GetInteractionRequest,
    ) -> StoreFuture<'a, Option<InteractionRecord>> {
        Box::pin(async move {
            self.inspect(&request.authority, |state| Ok(state.interaction(request)))
                .await
        })
    }

    fn answer_decision<'a>(
        &'a self,
        request: AnswerDecisionRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, AnswerDecisionReceipt> {
        let authority = request.target.authority.clone();
        Box::pin(async move {
            self.mutate(&authority, |state| state.answer(request, fingerprint))
                .await
        })
    }

    fn complete_dispatch<'a>(
        &'a self,
        request: CompleteDispatchRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, CompleteDispatchReceipt> {
        let authority = request.target.authority.clone();
        Box::pin(async move {
            self.mutate(&authority, |state| state.complete(request, fingerprint))
                .await
        })
    }

    fn inspect_events<'a>(
        &'a self,
        request: InspectEventsRequest,
    ) -> StoreFuture<'a, ReadEventsReceipt> {
        Box::pin(async move {
            self.inspect(request.authority(), |state| state.inspect_events(&request))
                .await
        })
    }

    fn read_events<'a>(
        &'a self,
        request: ReadEventsRequest,
        acknowledgement_fingerprint: Option<String>,
    ) -> StoreFuture<'a, ReadEventsReceipt> {
        let authority = request.authority.clone();
        Box::pin(async move {
            self.read_transact(&authority, |state| {
                state.read_events(request.clone(), acknowledgement_fingerprint.clone())
            })
            .await
        })
    }

    fn read_events_batch<'a>(
        &'a self,
        authority: AuthorityScope,
        requests: Vec<ReadEventsStoreRequest>,
    ) -> StoreFuture<'a, Vec<ReadEventsStoreResult>> {
        Box::pin(async move {
            self.read_transact(&authority, |state| {
                state.read_events_batch(&authority, requests.clone())
            })
            .await
        })
    }

    fn transition_delivery_wake<'a>(
        &'a self,
        request: TransitionDeliveryWakeRequest,
    ) -> StoreFuture<'a, TransitionDeliveryWakeReceipt> {
        let authority = request.authority.clone();
        Box::pin(async move {
            self.mutate(&authority, |state| state.transition_delivery_wake(request))
                .await
        })
    }
}

struct ExactLocalBinding {
    agent_id: AgentIdV1,
    binding_generation: i64,
}

async fn exact_local_binding(
    connection: &mut SqliteConnection,
    request: &CreateRunRequest,
) -> Result<ExactLocalBinding, StoreError> {
    if request.authority.tenant_ref.is_some() {
        return Err(StoreError::GenerationConflict);
    }
    let rows = sqlx::query(
        r#"
        SELECT
            agent.agent_id,
            agent.workspace_id,
            agent.provider_id,
            binding.runtime_kind_id,
            binding.binding_generation
        FROM session_bindings AS binding
        JOIN agent_checkpoint_binding_authorities AS authority
          ON authority.agent_id = binding.agent_id
        JOIN agents AS agent ON agent.agent_id = binding.agent_id
        WHERE binding.session_id = ?1
          AND authority.session_id = ?1
          AND authority.runtime_workspace_id = ?2
          AND authority.runner_principal = ?3
          AND authority.runner_instance = ?4
          AND authority.channel_epoch = ?5
          AND authority.host_instance_id = ?6
          AND authority.terminal_epoch = ?7
          AND authority.binding_generation = binding.binding_generation
        "#,
    )
    .bind(request.session.session_id.as_str())
    .bind(request.session.workspace_id.as_str())
    .bind(request.session.runner_principal.as_str())
    .bind(request.session.runner_instance.as_str())
    .bind(request.session.channel_epoch.as_str())
    .bind(request.session.host_instance_id.as_str())
    .bind(request.session.terminal_epoch.as_str())
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    if rows.len() != 1 {
        return Err(StoreError::GenerationConflict);
    }
    let row = &rows[0];
    let workspace_id: String = row.try_get("workspace_id").map_err(|_| corrupt())?;
    let provider_id: String = row.try_get("provider_id").map_err(|_| corrupt())?;
    let runtime_ref: String = row.try_get("runtime_kind_id").map_err(|_| corrupt())?;
    let requested_provider = request.session.provider_id.as_str();
    if workspace_id != request.authority.workspace_id.as_str()
        || runtime_ref != request.runtime_ref.as_str()
        || !(provider_id == requested_provider
            || provider_id.strip_prefix("provider.") == Some(requested_provider))
    {
        return Err(StoreError::GenerationConflict);
    }
    Ok(ExactLocalBinding {
        agent_id: AgentIdV1::new(
            row.try_get::<String, _>("agent_id")
                .map_err(|_| corrupt())?,
        )
        .map_err(|_| corrupt())?,
        binding_generation: row.try_get("binding_generation").map_err(|_| corrupt())?,
    })
}

async fn ensure_session_is_unassigned(
    connection: &mut SqliteConnection,
    request: &CreateRunRequest,
) -> Result<(), StoreError> {
    let active: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM workflow_dispatch_launches AS launch
        JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = launch.dispatch_id
        WHERE dispatch.state = 'starting'
          AND launch.state = 'active'
          AND launch.session_id = ?1
          AND launch.workspace_id = ?2
          AND launch.runner_principal = ?3
          AND launch.runner_instance = ?4
          AND launch.channel_epoch = ?5
          AND launch.host_instance_id = ?6
          AND launch.terminal_epoch = ?7
        "#,
    )
    .bind(request.session.session_id.as_str())
    .bind(request.session.workspace_id.as_str())
    .bind(request.session.runner_principal.as_str())
    .bind(request.session.runner_instance.as_str())
    .bind(request.session.channel_epoch.as_str())
    .bind(request.session.host_instance_id.as_str())
    .bind(request.session.terminal_epoch.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    if active != 0 {
        return Err(StoreError::StateConflict {
            code: "session_already_dispatched",
        });
    }
    Ok(())
}

async fn insert_canonical_run(
    connection: &mut SqliteConnection,
    request: &CreateRunRequest,
    context: &DispatchContextReceipt,
    binding: &ExactLocalBinding,
    fingerprint: &str,
) -> Result<(), StoreError> {
    let target = &context.target;
    sqlx::query(
        r#"
        INSERT INTO workflow_runs (
            run_id, contribution_id, coordinator_agent_id, coordinator_session_id,
            coordinator_binding_generation, created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
    )
    .bind(target.run_id.as_str())
    .bind(request.workflow_kind_ref.as_str())
    .bind(binding.agent_id.as_str())
    .bind(request.session.session_id.as_str())
    .bind(binding.binding_generation)
    .bind(request.created_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    sqlx::query(
        r#"
        INSERT INTO workflow_tasks (
            task_id, run_id, schema_version, summary, instructions, state,
            created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, 1, ?3, ?4, 'dispatched', ?5, ?5)
        "#,
    )
    .bind(target.task_id.as_str())
    .bind(target.run_id.as_str())
    .bind(&request.task.summary)
    .bind(&request.task.instructions)
    .bind(request.created_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    sqlx::query(
        r#"
        INSERT INTO workflow_dispatches (
            dispatch_id, task_id, provider_id, runtime_kind_id, target_reference,
            generation, state, completion_result, created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', NULL, ?7, ?7)
        "#,
    )
    .bind(target.dispatch_id.as_str())
    .bind(target.task_id.as_str())
    .bind(request.session.provider_id.as_str())
    .bind(request.runtime_ref.as_str())
    .bind(request.target_reference.as_str())
    .bind(i64::try_from(target.generation.get()).map_err(|_| corrupt())?)
    .bind(request.created_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    sqlx::query(
        r#"
        INSERT INTO workflow_dispatch_launches (
            dispatch_id, launch_idempotency_key, delivery_mode, state, session_id,
            workspace_id, provider_id, runner_principal, runner_instance, channel_epoch,
            host_instance_id, terminal_epoch, start_error_code,
            prompt_delivery_idempotency_key, prompt_delivery_state,
            prompt_delivery_evidence_json, prompt_delivery_error_code, updated_at_ms
        ) VALUES (
            ?1, ?2, 'durable_inbox', 'active', ?3, ?4, ?5, ?6, ?7, ?8,
            ?9, ?10, NULL, NULL, NULL, NULL, NULL, ?11
        )
        "#,
    )
    .bind(target.dispatch_id.as_str())
    .bind(format!("run:{fingerprint}"))
    .bind(request.session.session_id.as_str())
    .bind(request.session.workspace_id.as_str())
    .bind(request.session.provider_id.as_str())
    .bind(request.session.runner_principal.as_str())
    .bind(request.session.runner_instance.as_str())
    .bind(request.session.channel_epoch.as_str())
    .bind(request.session.host_instance_id.as_str())
    .bind(request.session.terminal_epoch.as_str())
    .bind(request.created_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|_| unavailable())?;

    let endpoint = WorkerEndpoint {
        endpoint_ref: context.endpoint_fence.endpoint_ref.clone(),
        participant: context.participant.clone(),
        session_identity: context.endpoint_fence.session_identity.clone(),
        generation: context.target.generation,
        delivery_capability: context.delivery_capability.clone(),
        acknowledgement_capability: context.acknowledgement_capability.clone(),
        wake_capability: context.wake_capability.clone(),
        integration_receipt: context.integration_receipt.clone(),
    };
    let authority = authority_key(&request.authority)?;
    let negotiation_digest =
        store_negotiation_digest(target, &request.session, &request.integration_receipt)?;
    insert_context_authority(
        connection,
        ContextAuthorityInsert {
            target,
            authority_key: &authority,
            context,
            worker_endpoint_json: encode_store(&endpoint)?,
            worker_session_json: encode_store(&request.session)?,
            coordinator_grant_json: encode_store(&context.coordinator_grant)?,
            negotiation_idempotency_key: &request.idempotency_key,
            negotiation_digest: &negotiation_digest,
            created_at_ms: request.created_at_ms,
        },
    )
    .await
    .map_err(|_| unavailable())?;
    Ok(())
}

struct ContextAuthorityInsert<'a> {
    target: &'a InteractionTarget,
    authority_key: &'a str,
    context: &'a DispatchContextReceipt,
    worker_endpoint_json: String,
    worker_session_json: String,
    coordinator_grant_json: String,
    negotiation_idempotency_key: &'a str,
    negotiation_digest: &'a str,
    created_at_ms: i64,
}

async fn insert_context_authority(
    connection: &mut SqliteConnection,
    insert: ContextAuthorityInsert<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO workflow_interaction_authorities (
            dispatch_id,
            authority_key,
            workspace_id,
            tenant_ref,
            revision,
            blocked_by,
            interaction_capability,
            completion_capability,
            worker_endpoint_json,
            worker_session_json,
            coordinator_grant_json,
            coordinator_reply_capability,
            negotiation_idempotency_key,
            negotiation_digest,
            created_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, 1, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
        "#,
    )
    .bind(insert.target.dispatch_id.as_str())
    .bind(insert.authority_key)
    .bind(insert.target.authority.workspace_id.as_str())
    .bind(
        insert
            .target
            .authority
            .tenant_ref
            .as_ref()
            .map(TenantRef::as_str),
    )
    .bind(insert.context.interaction_capability.as_str())
    .bind(insert.context.completion_capability.as_str())
    .bind(insert.worker_endpoint_json)
    .bind(insert.worker_session_json)
    .bind(insert.coordinator_grant_json)
    .bind(insert.context.coordinator_reply_capability.as_str())
    .bind(insert.negotiation_idempotency_key)
    .bind(insert.negotiation_digest)
    .bind(insert.created_at_ms)
    .execute(&mut *connection)
    .await?;
    Ok(())
}

pub(crate) async fn negotiate_dispatch_context(
    pool: &SqlitePool,
    request: &OrchestrationDispatchContextRequestV1,
    proposal: &DispatchContextReceipt,
) -> Result<DispatchContextReceipt, DomainStoreErrorV1> {
    request.validate()?;
    proposal
        .validate()
        .map_err(|error| invalid(error.field, error.code))?;
    if proposal.target != request.target
        || proposal.dispatch_revision != Revision::INITIAL
        || proposal.dispatch_state != DispatchState::Active
        || proposal.successor_required
        || proposal.integration_receipt != request.integration_receipt
        || proposal.endpoint_fence.session_identity != session_identity(&request.session)?
    {
        return Err(invalid(
            "contextProposal",
            "must match the exact negotiated Dispatch and Session",
        ));
    }

    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("negotiate_orchestration_context", error))?;
    begin_immediate(&mut connection, "negotiate_orchestration_context").await?;
    let result = async {
        validate_canonical_dispatch(&mut connection, request).await?;
        let authority_key = authority_key(&request.target.authority)
            .map_err(|_| storage("orchestration_context", "authority could not be encoded"))?;
        let digest = negotiation_digest(request)?;
        if let Some(row) = sqlx::query(
            r#"
            SELECT
                revision,
                'starting' AS dispatch_state,
                blocked_by,
                0 AS successor_required,
                interaction_capability,
                completion_capability,
                worker_endpoint_json,
                worker_session_json,
                coordinator_grant_json,
                coordinator_reply_capability,
                negotiation_idempotency_key,
                negotiation_digest
            FROM workflow_interaction_authorities
            WHERE dispatch_id = ?1
            "#,
        )
        .bind(request.target.dispatch_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_orchestration_context", error))?
        {
            let stored_key: String = row
                .try_get("negotiation_idempotency_key")
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
            let stored_digest: String = row
                .try_get("negotiation_digest")
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
            if stored_key == request.idempotency_key && stored_digest != digest {
                return Err(DomainStoreErrorV1::IdempotencyConflict {
                    reason: "Dispatch context key is bound to different negotiation evidence"
                        .into(),
                });
            }
            if stored_digest != digest {
                return Err(identity_conflict(
                    "orchestration_dispatch_context",
                    request.target.dispatch_id.as_str(),
                    "the active Dispatch is already bound to different integration evidence",
                ));
            }
            let stored_session: WorkflowSessionGenerationV1 = decode_domain(
                row.try_get("worker_session_json")
                    .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
                "orchestration worker Session",
            )?;
            if stored_session != request.session {
                return Err(identity_conflict(
                    "orchestration_dispatch_context",
                    request.target.dispatch_id.as_str(),
                    "the exact worker Session generation changed",
                ));
            }
            return context_from_row(row, &request.target);
        }

        let endpoint = WorkerEndpoint {
            endpoint_ref: proposal.endpoint_fence.endpoint_ref.clone(),
            participant: proposal.participant.clone(),
            session_identity: proposal.endpoint_fence.session_identity.clone(),
            generation: proposal.target.generation,
            delivery_capability: proposal.delivery_capability.clone(),
            acknowledgement_capability: proposal.acknowledgement_capability.clone(),
            wake_capability: proposal.wake_capability.clone(),
            integration_receipt: proposal.integration_receipt.clone(),
        };
        endpoint
            .validate()
            .map_err(|error| invalid(error.field, error.code))?;
        insert_context_authority(
            &mut connection,
            ContextAuthorityInsert {
                target: &request.target,
                authority_key: &authority_key,
                context: proposal,
                worker_endpoint_json: encode_domain(
                    &endpoint,
                    "orchestration worker endpoint",
                )?,
                worker_session_json: encode_domain(
                    &request.session,
                    "orchestration worker Session",
                )?,
                coordinator_grant_json: encode_domain(
                    &proposal.coordinator_grant,
                    "orchestration coordinator grant",
                )?,
                negotiation_idempotency_key: &request.idempotency_key,
                negotiation_digest: &digest,
                created_at_ms: request.resolved_at_ms,
            },
        )
        .await
        .map_err(|error| map_sqlx("insert_orchestration_context", error))?;
        sqlx::query(
            "INSERT INTO workflow_interaction_cursors (authority_key, next_cursor) VALUES (?1, 1) ON CONFLICT(authority_key) DO NOTHING",
        )
        .bind(authority_key)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("initialize_orchestration_cursor", error))?;
        Ok(proposal.clone())
    }
    .await;
    finish_transaction(&mut connection, "negotiate_orchestration_context", result).await
}

pub(crate) async fn dispatch_context_for_exact_session(
    pool: &SqlitePool,
    task_id: &dure_app::TaskIdV1,
    dispatch_id: &dure_app::DispatchIdV1,
    generation: i64,
    session: &WorkflowSessionGenerationV1,
) -> Result<DispatchContextReceipt, DomainStoreErrorV1> {
    session.validate()?;
    let row = sqlx::query(
        r#"
        SELECT
            authority.workspace_id,
            authority.tenant_ref,
            authority.revision,
            dispatch.state AS dispatch_state,
            authority.blocked_by,
            CASE
                WHEN dispatch.state = 'completed'
                 AND NOT EXISTS (
                    SELECT 1
                    FROM workflow_interaction_deliveries AS delivery
                    JOIN workflow_interaction_events AS event
                      ON event.authority_key = delivery.authority_key
                     AND event.cursor = delivery.event_cursor
                    WHERE delivery.authority_key = authority.authority_key
                      AND json_extract(event.event_json, '$.target.dispatchId') = authority.dispatch_id
                      AND json_extract(delivery.delivery_json, '$.receipt.state') = 'queued'
                      AND ((json_extract(delivery.delivery_json, '$.receipt.participant') =
                          json_extract(authority.coordinator_grant_json, '$.participant')
                      AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                          json_extract(authority.coordinator_grant_json, '$.deliveryCapability'))
                      OR (json_extract(delivery.delivery_json, '$.receipt.participant') =
                          json_extract(authority.worker_endpoint_json, '$.participant')
                      AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                          json_extract(authority.worker_endpoint_json, '$.deliveryCapability')
                      AND json_extract(event.event_json, '$.kind.kind') = 'interaction_opened'))
                 )
                THEN 1
                ELSE 0
            END AS successor_required,
            authority.interaction_capability,
            authority.completion_capability,
            authority.worker_endpoint_json,
            authority.worker_session_json,
            authority.coordinator_grant_json,
            authority.coordinator_reply_capability,
            task.run_id,
            dispatch.task_id,
            dispatch.generation
        FROM workflow_interaction_authorities AS authority
        JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = authority.dispatch_id
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        WHERE dispatch.dispatch_id = ?1
        "#,
    )
    .bind(dispatch_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| map_sqlx("read_orchestration_context", error))?
    .ok_or_else(|| DomainStoreErrorV1::NotFound {
        entity: "orchestration_dispatch_context",
        id: dispatch_id.to_string(),
    })?;
    let stored_task_id: String = row
        .try_get("task_id")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let stored_generation: i64 = row
        .try_get("generation")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let stored_session: WorkflowSessionGenerationV1 = decode_domain(
        row.try_get("worker_session_json")
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        "orchestration worker Session",
    )?;
    if stored_task_id != task_id.as_str()
        || stored_generation != generation
        || stored_session != *session
    {
        return Err(identity_conflict(
            "orchestration_session_fence",
            dispatch_id.as_str(),
            "Task, Dispatch generation, and exact Session generation must match",
        ));
    }
    let workspace_id: String = row
        .try_get("workspace_id")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let tenant_ref: Option<String> = row
        .try_get("tenant_ref")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let target = InteractionTarget {
        authority: AuthorityScope {
            workspace_id: WorkspaceId::new(workspace_id)
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
            tenant_ref: tenant_ref
                .map(TenantRef::new)
                .transpose()
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        },
        run_id: RunId::new(
            row.try_get::<String, _>("run_id")
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        )
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        task_id: TaskId::new(stored_task_id)
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        dispatch_id: DispatchId::new(dispatch_id.as_str())
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        generation: Generation::new(
            u64::try_from(stored_generation)
                .map_err(|_| storage("corrupt_orchestration_context", "generation is invalid"))?,
        )
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
    };
    context_from_row(row, &target)
}

pub(crate) async fn dispatch_contexts_for_exact_sessions(
    pool: &SqlitePool,
    sessions: &[WorkflowSessionGenerationV1],
) -> Result<Vec<OrchestrationDispatchContextBatchItemV1>, DomainStoreErrorV1> {
    if sessions.is_empty() || sessions.len() > MAX_ORCHESTRATION_CONTEXT_BATCH_ITEMS {
        return Err(invalid(
            "sessions",
            format!("must contain between 1 and {MAX_ORCHESTRATION_CONTEXT_BATCH_ITEMS} items"),
        ));
    }
    for (index, session) in sessions.iter().enumerate() {
        if sessions[..index].contains(session) {
            return Err(invalid("sessions", "must not contain duplicate Sessions"));
        }
    }
    let sessions_json = serde_json::to_string(sessions)
        .map_err(|error| serialization("orchestration Session batch", error))?;
    let rows = sqlx::query(
        r#"
        WITH requested AS (
            SELECT
                CAST(entry.key AS INTEGER) AS ordinal,
                json_extract(entry.value, '$.sessionId') AS session_id,
                json_extract(entry.value, '$.workspaceId') AS workspace_id,
                json_extract(entry.value, '$.providerId') AS provider_id,
                json_extract(entry.value, '$.runnerPrincipal') AS runner_principal,
                json_extract(entry.value, '$.runnerInstance') AS runner_instance,
                json_extract(entry.value, '$.channelEpoch') AS channel_epoch,
                json_extract(entry.value, '$.hostInstanceId') AS host_instance_id,
                json_extract(entry.value, '$.terminalEpoch') AS terminal_epoch
            FROM json_each(?1) AS entry
        ),
        candidates AS (
            SELECT
                requested.ordinal,
                run.run_id,
                task.task_id,
                dispatch.dispatch_id,
                dispatch.generation,
                dispatch.state AS dispatch_state,
                dispatch.updated_at_ms AS dispatch_updated_at_ms,
                coordinator.workspace_id AS authority_workspace_id,
                launch.delivery_mode,
                launch.launch_idempotency_key,
                launch.effective_launch_idempotency_key,
                authority.dispatch_id AS context_dispatch_id,
                authority.authority_key AS context_authority_key,
                authority.workspace_id AS context_workspace_id,
                authority.tenant_ref,
                authority.revision,
                authority.blocked_by,
                authority.interaction_capability,
                authority.completion_capability,
                authority.worker_endpoint_json,
                authority.worker_session_json,
                authority.coordinator_grant_json,
                authority.coordinator_reply_capability
            FROM requested
            JOIN workflow_dispatch_launches AS launch
              ON launch.state = 'active'
             AND launch.session_id = requested.session_id
             AND launch.workspace_id = requested.workspace_id
             AND launch.provider_id = requested.provider_id
             AND launch.runner_principal = requested.runner_principal
             AND launch.runner_instance = requested.runner_instance
             AND launch.channel_epoch = requested.channel_epoch
             AND launch.host_instance_id = requested.host_instance_id
             AND launch.terminal_epoch = requested.terminal_epoch
            JOIN workflow_dispatches AS dispatch
              ON dispatch.dispatch_id = launch.dispatch_id
             AND dispatch.state IN ('starting', 'completed')
            JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
            JOIN workflow_runs AS run ON run.run_id = task.run_id
            JOIN agents AS coordinator ON coordinator.agent_id = run.coordinator_agent_id
            LEFT JOIN workflow_interaction_authorities AS authority
              ON authority.dispatch_id = dispatch.dispatch_id
        ),
        delivery_facts AS (
            SELECT
                candidate.ordinal,
                candidate.dispatch_id,
                MIN(
                    CASE
                        WHEN candidate.dispatch_state = 'completed'
                         AND delivery.receipt_id IS NOT NULL
                        THEN CASE
                            WHEN json_valid(delivery.delivery_json) = 1
                             AND json_valid(candidate.coordinator_grant_json) = 1
                             AND json_valid(candidate.worker_endpoint_json) = 1
                             AND json_valid(event.event_json) = 1
                            THEN CASE
                                WHEN json_extract(delivery.delivery_json, '$.receipt.state') = 'queued'
                                 AND ((json_extract(delivery.delivery_json, '$.receipt.participant') =
                                     json_extract(candidate.coordinator_grant_json, '$.participant')
                                 AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                                     json_extract(candidate.coordinator_grant_json, '$.deliveryCapability'))
                                 OR (json_extract(delivery.delivery_json, '$.receipt.participant') =
                                     json_extract(candidate.worker_endpoint_json, '$.participant')
                                 AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                                     json_extract(candidate.worker_endpoint_json, '$.deliveryCapability')
                                 AND json_extract(event.event_json, '$.kind.kind') = 'interaction_opened'))
                                 AND candidate.dispatch_id =
                                     json_extract(event.event_json, '$.target.dispatchId')
                                THEN delivery.event_cursor
                                ELSE NULL
                            END
                            ELSE NULL
                        END
                        ELSE NULL
                    END
                ) AS first_cursor,
                SUM(
                    CASE
                        WHEN delivery.receipt_id IS NOT NULL
                        THEN CASE
                            WHEN json_valid(delivery.delivery_json) = 1
                             AND json_valid(candidate.coordinator_grant_json) = 1
                             AND json_valid(candidate.worker_endpoint_json) = 1
                             AND json_valid(event.event_json) = 1
                            THEN CASE
                                WHEN json_extract(delivery.delivery_json, '$.receipt.state') = 'queued'
                                 AND candidate.dispatch_id = json_extract(event.event_json, '$.target.dispatchId')
                                 AND ((json_extract(delivery.delivery_json, '$.receipt.participant') =
                                     json_extract(candidate.coordinator_grant_json, '$.participant')
                                 AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                                     json_extract(candidate.coordinator_grant_json, '$.deliveryCapability'))
                                 OR (json_extract(delivery.delivery_json, '$.receipt.participant') =
                                     json_extract(candidate.worker_endpoint_json, '$.participant')
                                 AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                                     json_extract(candidate.worker_endpoint_json, '$.deliveryCapability')
                                 AND json_extract(event.event_json, '$.kind.kind') = 'interaction_opened'))
                                THEN 1
                                ELSE 0
                            END
                            ELSE 0
                        END
                        ELSE 0
                    END
                ) AS queued_delivery_count,
                MAX(
                    CASE
                        WHEN candidate.dispatch_state = 'completed'
                         AND delivery.receipt_id IS NOT NULL
                         AND (
                            (
                                event.event_json IS NOT NULL
                                AND json_valid(event.event_json) != 1
                                AND json_valid(delivery.delivery_json) != 1
                            )
                            OR
                            (
                                json_valid(event.event_json) = 1
                                AND candidate.dispatch_id =
                                    json_extract(event.event_json, '$.target.dispatchId')
                                AND (
                                    json_valid(delivery.delivery_json) != 1
                                    OR (
                                        json_valid(delivery.delivery_json) = 1
                                        AND json_extract(
                                            delivery.delivery_json,
                                            '$.receipt.state'
                                        ) = 'queued'
                                        AND (json_valid(candidate.coordinator_grant_json) != 1
                                             OR json_valid(candidate.worker_endpoint_json) != 1)
                                    )
                                )
                            )
                            OR (
                                event.event_json IS NOT NULL
                                AND json_valid(event.event_json) != 1
                                AND json_valid(delivery.delivery_json) = 1
                                AND json_valid(candidate.coordinator_grant_json) = 1
                                AND json_valid(candidate.worker_endpoint_json) = 1
                                AND json_extract(delivery.delivery_json, '$.receipt.state') = 'queued'
                                AND ((json_extract(delivery.delivery_json, '$.receipt.participant') =
                                    json_extract(candidate.coordinator_grant_json, '$.participant')
                                AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                                    json_extract(candidate.coordinator_grant_json, '$.deliveryCapability'))
                                OR (json_extract(delivery.delivery_json, '$.receipt.participant') =
                                    json_extract(candidate.worker_endpoint_json, '$.participant')
                                AND json_extract(delivery.delivery_json, '$.delivery_capability') =
                                    json_extract(candidate.worker_endpoint_json, '$.deliveryCapability')))
                            )
                         )
                        THEN 1
                        ELSE 0
                    END
                ) AS delivery_json_corrupt
            FROM candidates AS candidate
            LEFT JOIN workflow_interaction_deliveries AS delivery
              ON delivery.authority_key = candidate.context_authority_key
            LEFT JOIN workflow_interaction_events AS event
              ON event.authority_key = delivery.authority_key
             AND event.cursor = delivery.event_cursor
            GROUP BY candidate.ordinal, candidate.dispatch_id
        ),
        candidate_facts AS (
            SELECT
                candidate.*,
                facts.first_cursor,
                facts.queued_delivery_count,
                facts.delivery_json_corrupt,
                MAX(facts.delivery_json_corrupt)
                    OVER (PARTITION BY candidate.ordinal) AS ordinal_delivery_json_corrupt,
                SUM(CASE WHEN candidate.dispatch_state = 'starting' THEN 1 ELSE 0 END)
                    OVER (PARTITION BY candidate.ordinal) AS active_count
            FROM candidates AS candidate
            JOIN delivery_facts AS facts
              ON facts.ordinal = candidate.ordinal
             AND facts.dispatch_id = candidate.dispatch_id
        ),
        ranked AS (
            SELECT
                candidate.*,
                ROW_NUMBER() OVER (
                    PARTITION BY candidate.ordinal
                    ORDER BY
                        CASE
                            WHEN candidate.dispatch_state = 'completed'
                             AND candidate.first_cursor IS NOT NULL THEN 0
                            WHEN candidate.dispatch_state = 'starting' THEN 1
                            ELSE 2
                        END,
                        CASE
                            WHEN candidate.dispatch_state = 'completed'
                             AND candidate.first_cursor IS NOT NULL
                            THEN candidate.first_cursor
                        END,
                        CASE
                            WHEN candidate.dispatch_state = 'completed'
                             AND candidate.first_cursor IS NOT NULL
                            THEN candidate.dispatch_id
                        END,
                        candidate.dispatch_updated_at_ms DESC,
                        candidate.dispatch_id DESC
                ) AS selection_rank
            FROM candidate_facts AS candidate
        )
        SELECT
            requested.ordinal,
            candidate.run_id,
            candidate.task_id,
            candidate.dispatch_id,
            candidate.generation,
            candidate.dispatch_state,
            candidate.dispatch_updated_at_ms,
            candidate.authority_workspace_id,
            candidate.delivery_mode,
            candidate.launch_idempotency_key,
            candidate.effective_launch_idempotency_key,
            candidate.context_dispatch_id,
            candidate.context_workspace_id,
            candidate.tenant_ref,
            candidate.revision,
            candidate.blocked_by,
            CASE
                WHEN candidate.dispatch_state = 'completed'
                 AND candidate.queued_delivery_count = 0
                THEN 1
                ELSE 0
            END AS successor_required,
            candidate.interaction_capability,
            candidate.completion_capability,
            candidate.worker_endpoint_json,
            candidate.worker_session_json,
            candidate.coordinator_grant_json,
            candidate.coordinator_reply_capability,
            candidate.ordinal_delivery_json_corrupt AS delivery_json_corrupt,
            candidate.active_count
        FROM requested
        LEFT JOIN ranked AS candidate
          ON candidate.ordinal = requested.ordinal
         AND candidate.selection_rank = 1
        ORDER BY requested.ordinal
        "#,
    )
    .bind(sessions_json)
    .fetch_all(pool)
    .await
    .map_err(|error| map_sqlx("resolve_orchestration_context_batch", error))?;

    if rows.len() != sessions.len() {
        return Err(storage(
            "corrupt_orchestration_context",
            "Session batch query returned an incomplete result",
        ));
    }
    let mut results = Vec::with_capacity(sessions.len());
    for (expected_ordinal, (session, row)) in sessions.iter().cloned().zip(rows).enumerate() {
        let ordinal: i64 = row
            .try_get("ordinal")
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
        if usize::try_from(ordinal).ok() != Some(expected_ordinal) {
            return Err(storage(
                "corrupt_orchestration_context",
                "Session batch result order is invalid",
            ));
        }
        let resolution = match session
            .validate()
            .and_then(|()| dispatch_context_from_batch_row(row, &session))
        {
            Ok(Some(context)) => OrchestrationDispatchContextResolutionV1::Found(Box::new(context)),
            Ok(None) => OrchestrationDispatchContextResolutionV1::NoDispatch,
            Err(error) => OrchestrationDispatchContextResolutionV1::DomainError(error),
        };
        results.push(OrchestrationDispatchContextBatchItemV1 {
            session,
            resolution,
        });
    }
    Ok(results)
}

fn dispatch_context_from_batch_row(
    row: sqlx::sqlite::SqliteRow,
    session: &WorkflowSessionGenerationV1,
) -> Result<Option<DispatchContextReceipt>, DomainStoreErrorV1> {
    let dispatch_id: Option<String> = row
        .try_get("dispatch_id")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let Some(dispatch_id) = dispatch_id else {
        return Ok(None);
    };
    let delivery_json_corrupt: i64 = row
        .try_get("delivery_json_corrupt")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    if delivery_json_corrupt != 0 {
        return Err(storage(
            "corrupt_orchestration_context",
            "stored delivery or event JSON is invalid",
        ));
    }
    let active_count: i64 = row
        .try_get("active_count")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    if active_count > 1 {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &session.session_id,
            "the exact Session generation resolves to multiple active Dispatches",
        ));
    }
    if active_count < 0 {
        return Err(storage(
            "corrupt_workflow_dispatch",
            "active Dispatch count is invalid",
        ));
    }
    dispatch_session_match(&row)?;
    let context_dispatch_id: Option<String> = row
        .try_get("context_dispatch_id")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let Some(context_dispatch_id) = context_dispatch_id else {
        return Err(DomainStoreErrorV1::NotFound {
            entity: "orchestration_dispatch_context",
            id: dispatch_id,
        });
    };
    if context_dispatch_id != dispatch_id {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &dispatch_id,
            "Dispatch context authority must match the resolved Dispatch",
        ));
    }
    let worker_session_json: String = row
        .try_get("worker_session_json")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let stored_session: WorkflowSessionGenerationV1 =
        decode_domain(worker_session_json, "orchestration worker Session")?;
    if stored_session != *session {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &dispatch_id,
            "Task, Dispatch generation, and exact Session generation must match",
        ));
    }
    let workspace_id: String = row
        .try_get("context_workspace_id")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let tenant_ref: Option<String> = row
        .try_get("tenant_ref")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let generation: i64 = row
        .try_get("generation")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let target = InteractionTarget {
        authority: AuthorityScope {
            workspace_id: WorkspaceId::new(workspace_id)
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
            tenant_ref: tenant_ref
                .map(TenantRef::new)
                .transpose()
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        },
        run_id: RunId::new(required_string(&row, "run_id")?)
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        task_id: TaskId::new(required_string(&row, "task_id")?)
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        dispatch_id: DispatchId::new(&dispatch_id)
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        generation: Generation::new(
            u64::try_from(generation)
                .map_err(|_| storage("corrupt_orchestration_context", "generation is invalid"))?,
        )
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
    };
    context_from_row(row, &target).map(Some)
}

#[derive(Clone)]
struct DispatchSessionMatch {
    target: InteractionTarget,
    delivery_mode: String,
    launch_idempotency_key: String,
    effective_launch_idempotency_key: Option<String>,
}

impl DispatchSessionMatch {
    fn is_current_session_reporting(&self) -> bool {
        self.delivery_mode == "durable_inbox"
    }
}

struct ExactDispatchSessionMatch {
    dispatch: DispatchSessionMatch,
    session: WorkflowSessionGenerationV1,
    completed: bool,
}

fn dispatch_session_match(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<DispatchSessionMatch, DomainStoreErrorV1> {
    let delivery_mode = required_string(row, "delivery_mode")?;
    if !matches!(delivery_mode.as_str(), "pty_prompt" | "durable_inbox") {
        return Err(storage(
            "corrupt_workflow_dispatch",
            "workflow Dispatch has an unsupported delivery mode",
        ));
    }
    Ok(DispatchSessionMatch {
        target: dispatch_session_target(row)?,
        delivery_mode,
        launch_idempotency_key: required_string(row, "launch_idempotency_key")?,
        effective_launch_idempotency_key: row
            .try_get("effective_launch_idempotency_key")
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
    })
}

fn dispatch_session_target(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<InteractionTarget, DomainStoreErrorV1> {
    let generation: i64 = row
        .try_get("generation")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    Ok(InteractionTarget {
        authority: AuthorityScope {
            workspace_id: WorkspaceId::new(required_string(row, "authority_workspace_id")?)
                .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
            tenant_ref: None,
        },
        run_id: RunId::new(required_string(row, "run_id")?)
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
        task_id: TaskId::new(required_string(row, "task_id")?)
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
        dispatch_id: DispatchId::new(required_string(row, "dispatch_id")?)
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
        generation: Generation::new(
            u64::try_from(generation)
                .map_err(|_| storage("corrupt_workflow_dispatch", "generation is invalid"))?,
        )
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
    })
}

fn workflow_session_generation(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<WorkflowSessionGenerationV1, DomainStoreErrorV1> {
    let session = WorkflowSessionGenerationV1 {
        session_id: required_string(row, "session_id")?,
        workspace_id: required_string(row, "workspace_id")?,
        provider_id: ProviderIdV1::new(required_string(row, "provider_id")?)
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
        runner_principal: required_string(row, "runner_principal")?,
        runner_instance: required_string(row, "runner_instance")?,
        channel_epoch: required_string(row, "channel_epoch")?,
        host_instance_id: required_string(row, "host_instance_id")?,
        terminal_epoch: required_string(row, "terminal_epoch")?,
    };
    session.validate()?;
    Ok(session)
}

async fn exact_dispatch_session_match(
    connection: &mut SqliteConnection,
    task_id: &TaskIdV1,
    dispatch_id: &DispatchIdV1,
    generation: i64,
) -> Result<ExactDispatchSessionMatch, DomainStoreErrorV1> {
    if generation < 1 {
        return Err(invalid("generation", "must be positive"));
    }
    // A completed PTY launch is handed off only by the journaled runtime
    // transaction. This fallback is for an already-observed durable Inbox
    // reporting authority, which has no remaining coordinator delivery.
    let rows = sqlx::query(
        r#"
        SELECT
            run.run_id,
            task.task_id,
            dispatch.dispatch_id,
            dispatch.generation,
            dispatch.state AS dispatch_state,
            coordinator.workspace_id AS authority_workspace_id,
            launch.delivery_mode,
            launch.launch_idempotency_key,
            launch.effective_launch_idempotency_key,
            launch.session_id,
            launch.workspace_id,
            launch.provider_id,
            launch.runner_principal,
            launch.runner_instance,
            launch.channel_epoch,
            launch.host_instance_id,
            launch.terminal_epoch
        FROM workflow_dispatch_launches AS launch
        JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = launch.dispatch_id
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        JOIN workflow_runs AS run ON run.run_id = task.run_id
        JOIN agents AS coordinator ON coordinator.agent_id = run.coordinator_agent_id
        WHERE dispatch.task_id = ?1
          AND dispatch.dispatch_id = ?2
          AND dispatch.generation = ?3
          AND (
              dispatch.state = 'starting'
              OR (dispatch.state = 'completed' AND launch.delivery_mode = 'durable_inbox')
          )
          AND launch.state = 'active'
        "#,
    )
    .bind(task_id.as_str())
    .bind(dispatch_id.as_str())
    .bind(generation)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("resolve_orchestration_dispatch_session", error))?;
    if rows.len() != 1 {
        return Err(identity_conflict(
            "orchestration_dispatch_generation",
            dispatch_id.as_str(),
            "the exact Dispatch generation must resolve to one active Session launch or completed durable Inbox launch",
        ));
    }
    let row = &rows[0];
    let dispatch_state = required_string(row, "dispatch_state")?;
    let completed = match dispatch_state.as_str() {
        "starting" => false,
        "completed" => true,
        _ => {
            return Err(storage(
                "corrupt_workflow_dispatch",
                "the exact Dispatch has an unsupported lifecycle state",
            ));
        }
    };
    Ok(ExactDispatchSessionMatch {
        dispatch: dispatch_session_match(row)?,
        session: workflow_session_generation(row)?,
        completed,
    })
}

async fn active_dispatch_matches(
    connection: &mut SqliteConnection,
    session: &WorkflowSessionGenerationV1,
) -> Result<Vec<DispatchSessionMatch>, DomainStoreErrorV1> {
    dispatch_matches_in_state(connection, session, "starting").await
}

async fn dispatch_matches_in_state(
    connection: &mut SqliteConnection,
    session: &WorkflowSessionGenerationV1,
    dispatch_state: &'static str,
) -> Result<Vec<DispatchSessionMatch>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT
            run.run_id,
            task.task_id,
            dispatch.dispatch_id,
            dispatch.generation,
            coordinator.workspace_id AS authority_workspace_id,
            launch.delivery_mode,
            launch.launch_idempotency_key,
            launch.effective_launch_idempotency_key
        FROM workflow_dispatch_launches AS launch
        JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = launch.dispatch_id
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        JOIN workflow_runs AS run ON run.run_id = task.run_id
        JOIN agents AS coordinator ON coordinator.agent_id = run.coordinator_agent_id
        WHERE dispatch.state = ?9
          AND launch.state = 'active'
          AND launch.session_id = ?1
          AND launch.workspace_id = ?2
          AND launch.provider_id = ?3
          AND launch.runner_principal = ?4
          AND launch.runner_instance = ?5
          AND launch.channel_epoch = ?6
          AND launch.host_instance_id = ?7
          AND launch.terminal_epoch = ?8
        ORDER BY dispatch.updated_at_ms DESC, dispatch.dispatch_id DESC
        "#,
    )
    .bind(&session.session_id)
    .bind(&session.workspace_id)
    .bind(session.provider_id.as_str())
    .bind(&session.runner_principal)
    .bind(&session.runner_instance)
    .bind(&session.channel_epoch)
    .bind(&session.host_instance_id)
    .bind(&session.terminal_epoch)
    .bind(dispatch_state)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("resolve_orchestration_session", error))?;
    rows.into_iter()
        .map(|row| dispatch_session_match(&row))
        .collect()
}

async fn drainable_completed_dispatch_matches(
    connection: &mut SqliteConnection,
    session: &WorkflowSessionGenerationV1,
) -> Result<Vec<DispatchSessionMatch>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT
            run.run_id,
            task.task_id,
            dispatch.dispatch_id,
            dispatch.generation,
            coordinator.workspace_id AS authority_workspace_id,
            launch.delivery_mode,
            launch.launch_idempotency_key,
            launch.effective_launch_idempotency_key,
            MIN(delivery.event_cursor) AS first_cursor
        FROM workflow_interaction_deliveries AS delivery
        JOIN workflow_interaction_events AS event
          ON event.authority_key = delivery.authority_key
         AND event.cursor = delivery.event_cursor
        JOIN workflow_interaction_authorities AS authority
          ON authority.authority_key = delivery.authority_key
         AND authority.dispatch_id = json_extract(event.event_json, '$.target.dispatchId')
        JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = authority.dispatch_id
        JOIN workflow_dispatch_launches AS launch ON launch.dispatch_id = dispatch.dispatch_id
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        JOIN workflow_runs AS run ON run.run_id = task.run_id
        JOIN agents AS coordinator ON coordinator.agent_id = run.coordinator_agent_id
        WHERE dispatch.state = 'completed'
          AND launch.state = 'active'
          AND json_extract(delivery.delivery_json, '$.receipt.state') = 'queued'
          AND ((json_extract(delivery.delivery_json, '$.receipt.participant') =
              json_extract(authority.coordinator_grant_json, '$.participant')
          AND json_extract(delivery.delivery_json, '$.delivery_capability') =
              json_extract(authority.coordinator_grant_json, '$.deliveryCapability'))
          OR (json_extract(delivery.delivery_json, '$.receipt.participant') =
              json_extract(authority.worker_endpoint_json, '$.participant')
          AND json_extract(event.event_json, '$.kind.kind') = 'interaction_opened'
          AND json_extract(delivery.delivery_json, '$.delivery_capability') =
              json_extract(authority.worker_endpoint_json, '$.deliveryCapability')))
          AND launch.session_id = ?1
          AND launch.workspace_id = ?2
          AND launch.provider_id = ?3
          AND launch.runner_principal = ?4
          AND launch.runner_instance = ?5
          AND launch.channel_epoch = ?6
          AND launch.host_instance_id = ?7
          AND launch.terminal_epoch = ?8
        GROUP BY
            run.run_id,
            task.task_id,
            dispatch.dispatch_id,
            dispatch.generation,
            coordinator.workspace_id
            , launch.delivery_mode
            , launch.launch_idempotency_key
            , launch.effective_launch_idempotency_key
        ORDER BY first_cursor, dispatch.dispatch_id
        "#,
    )
    .bind(&session.session_id)
    .bind(&session.workspace_id)
    .bind(session.provider_id.as_str())
    .bind(&session.runner_principal)
    .bind(&session.runner_instance)
    .bind(&session.channel_epoch)
    .bind(&session.host_instance_id)
    .bind(&session.terminal_epoch)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("resolve_orchestration_context", error))?;
    rows.into_iter()
        .map(|row| dispatch_session_match(&row))
        .collect()
}

async fn latest_completed_dispatch_match(
    connection: &mut SqliteConnection,
    session: &WorkflowSessionGenerationV1,
) -> Result<Option<DispatchSessionMatch>, DomainStoreErrorV1> {
    Ok(dispatch_matches_in_state(connection, session, "completed")
        .await?
        .into_iter()
        .next())
}

pub(crate) async fn inspect_dispatch_session(
    pool: &SqlitePool,
    session: &WorkflowSessionGenerationV1,
) -> Result<OrchestrationDispatchSessionInspectionReceiptV1, DomainStoreErrorV1> {
    session.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("inspect_orchestration_session", error))?;
    let matches = active_dispatch_matches(&mut connection, session).await?;
    if matches.len() > 1 {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &session.session_id,
            "the exact Session generation resolves to multiple active Dispatches",
        ));
    }
    Ok(OrchestrationDispatchSessionInspectionReceiptV1 {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        outcome: if matches.is_empty() {
            OrchestrationDispatchSessionInspectionOutcomeV1::Unassigned
        } else {
            OrchestrationDispatchSessionInspectionOutcomeV1::ActiveDispatch
        },
        session: session.clone(),
        target: matches.into_iter().next().map(|value| value.target),
    })
}

pub(crate) async fn target_for_exact_session(
    pool: &SqlitePool,
    session: &WorkflowSessionGenerationV1,
) -> Result<InteractionTarget, DomainStoreErrorV1> {
    session.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("resolve_orchestration_context", error))?;
    sqlx::query("BEGIN")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("resolve_orchestration_context", error))?;
    let result = async {
        // Drain an older completed Dispatch before returning an already-created
        // successor, so a rollover cannot strand either participant's delivery.
        let drainable = drainable_completed_dispatch_matches(&mut connection, session).await?;
        let active = active_dispatch_matches(&mut connection, session).await?;
        if active.len() > 1 {
            return Err(identity_conflict(
                "orchestration_session_fence",
                &session.session_id,
                "the exact Session generation resolves to multiple active Dispatches",
            ));
        }
        let fallback = if drainable.is_empty() && active.is_empty() {
            latest_completed_dispatch_match(&mut connection, session).await?
        } else {
            None
        };
        drainable
            .into_iter()
            .next()
            .or_else(|| active.into_iter().next())
            .or(fallback)
            .map(|matched| matched.target)
            .ok_or_else(|| {
                identity_conflict(
                    "orchestration_session_fence",
                    &session.session_id,
                    "the exact Session generation must resolve to one active or completed Dispatch",
                )
            })
    }
    .await;
    finish_transaction(&mut connection, "resolve_orchestration_context", result).await
}

pub(crate) async fn session_for_dispatch_target(
    pool: &SqlitePool,
    task_id: &TaskIdV1,
    dispatch_id: &DispatchIdV1,
    generation: i64,
) -> Result<WorkflowSessionGenerationV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("resolve_orchestration_dispatch_session", error))?;
    Ok(
        exact_dispatch_session_match(&mut connection, task_id, dispatch_id, generation)
            .await?
            .session,
    )
}

fn rebind_receipt(
    request: &OrchestrationDispatchSessionRebindMutationV1,
    matched: Option<&DispatchSessionMatch>,
) -> OrchestrationDispatchSessionRebindReceiptV1 {
    OrchestrationDispatchSessionRebindReceiptV1 {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        operation_id: request.operation_id.clone(),
        outcome: if matched.is_some() {
            OrchestrationDispatchSessionRebindOutcomeV1::Rebound
        } else {
            OrchestrationDispatchSessionRebindOutcomeV1::Unassigned
        },
        source: request.source.clone(),
        target: request.target.clone(),
        run_id: matched.map(|value| value.target.run_id.to_string()),
        task_id: matched.map(|value| value.target.task_id.to_string()),
        dispatch_id: matched.map(|value| value.target.dispatch_id.to_string()),
        generation: matched.and_then(|value| i64::try_from(value.target.generation.get()).ok()),
    }
}

fn rebind_worker_session_state(
    state: &mut StoreState,
    target: &InteractionTarget,
    session_identity: SessionIdentityRef,
) -> Result<(), StoreError> {
    state.validate()?;
    let dispatch = state
        .dispatches
        .iter_mut()
        .find(|dispatch| dispatch.target == *target)
        .ok_or(StoreError::NotFound {
            resource: "dispatch",
        })?;
    dispatch.worker_endpoint.session_identity = session_identity;
    let endpoint = dispatch.worker_endpoint.clone();

    for delivery in &mut state.deliveries {
        let belongs_to_target = state
            .events
            .iter()
            .any(|event| event.cursor == delivery.receipt.event_cursor && event.target == *target);
        if belongs_to_target
            && delivery.receipt.participant == endpoint.participant
            && delivery.delivery_capability == endpoint.delivery_capability
        {
            let receipt_endpoint =
                delivery
                    .receipt
                    .endpoint
                    .as_mut()
                    .ok_or(StoreError::Corrupt {
                        code: "worker_delivery_endpoint_missing",
                    })?;
            receipt_endpoint.endpoint_ref = endpoint.endpoint_ref.clone();
            receipt_endpoint.session_identity = endpoint.session_identity.clone();
            receipt_endpoint.generation = endpoint.generation;
        }
    }
    state.validate()
}

async fn move_dispatch_session(
    connection: &mut SqliteConnection,
    request: &OrchestrationDispatchSessionRebindMutationV1,
    source: &DispatchSessionMatch,
) -> Result<(), DomainStoreErrorV1> {
    if source.delivery_mode == "pty_prompt" {
        let effective_launch_idempotency_key = request
            .target_launch_idempotency_key
            .as_deref()
            .ok_or_else(|| {
                identity_conflict(
                    "workflow_effective_launch_identity",
                    source.target.dispatch_id.as_str(),
                    "a pty_prompt Dispatch rebind requires the exact target create key",
                )
            })?;
        validate_dispatch_effective_launch_identity(
            source,
            &request.target,
            effective_launch_idempotency_key,
        )?;
    }
    let updated = sqlx::query(
        r#"
        UPDATE workflow_dispatch_launches
        SET session_id = ?1,
            workspace_id = ?2,
            provider_id = ?3,
            runner_principal = ?4,
            runner_instance = ?5,
            channel_epoch = ?6,
            host_instance_id = ?7,
            terminal_epoch = ?8,
            effective_launch_idempotency_key = CASE
                WHEN delivery_mode = 'pty_prompt' THEN ?9
                ELSE effective_launch_idempotency_key
            END,
            updated_at_ms = MAX(updated_at_ms, ?10)
        WHERE dispatch_id = ?11
          AND state = 'active'
          AND session_id = ?12
          AND workspace_id = ?13
          AND provider_id = ?14
          AND runner_principal = ?15
          AND runner_instance = ?16
          AND channel_epoch = ?17
          AND host_instance_id = ?18
          AND terminal_epoch = ?19
          AND (delivery_mode = 'durable_inbox' OR ?9 IS NOT NULL)
          AND launch_idempotency_key = ?20
        "#,
    )
    .bind(&request.target.session_id)
    .bind(&request.target.workspace_id)
    .bind(request.target.provider_id.as_str())
    .bind(&request.target.runner_principal)
    .bind(&request.target.runner_instance)
    .bind(&request.target.channel_epoch)
    .bind(&request.target.host_instance_id)
    .bind(&request.target.terminal_epoch)
    .bind(&request.target_launch_idempotency_key)
    .bind(request.rebound_at_ms)
    .bind(source.target.dispatch_id.as_str())
    .bind(&request.source.session_id)
    .bind(&request.source.workspace_id)
    .bind(request.source.provider_id.as_str())
    .bind(&request.source.runner_principal)
    .bind(&request.source.runner_instance)
    .bind(&request.source.channel_epoch)
    .bind(&request.source.host_instance_id)
    .bind(&request.source.terminal_epoch)
    .bind(&source.launch_idempotency_key)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("rebind_orchestration_session", error))?;
    if updated.rows_affected() != 1 {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &request.source.session_id,
            "the source Session generation changed during rebind",
        ));
    }

    if let Some(row) = sqlx::query(
        r#"
        SELECT worker_endpoint_json, worker_session_json
        FROM workflow_interaction_authorities
        WHERE dispatch_id = ?1
        "#,
    )
    .bind(source.target.dispatch_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_orchestration_context", error))?
    {
        let stored_session: WorkflowSessionGenerationV1 = decode_domain(
            row.try_get("worker_session_json")
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
            "orchestration worker Session",
        )?;
        if stored_session != request.source {
            return Err(identity_conflict(
                "orchestration_session_fence",
                source.target.dispatch_id.as_str(),
                "the stored worker Session does not match the source generation",
            ));
        }
        let endpoint: WorkerEndpoint = decode_domain(
            row.try_get("worker_endpoint_json")
                .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
            "orchestration worker endpoint",
        )?;
        let mut state = load_state(connection, &source.target.authority)
            .await
            .map_err(|error| map_orchestration_store("load rebind state", error))?;
        rebind_worker_session_state(
            &mut state,
            &source.target,
            session_identity(&request.target)?,
        )
        .map_err(|error| map_orchestration_store("rebind worker Session", error))?;
        persist_state(connection, &source.target.authority, &state)
            .await
            .map_err(|error| map_orchestration_store("persist rebind state", error))?;
        let digest = negotiation_evidence(
            &source.target,
            &request.target,
            &endpoint.integration_receipt,
        )
        .map_err(|error| serialization("orchestration negotiation evidence", error))?;
        let updated_authority = sqlx::query(
            r#"
            UPDATE workflow_interaction_authorities
            SET worker_session_json = ?1,
                negotiation_digest = ?2,
                updated_at_ms = MAX(updated_at_ms, ?3)
            WHERE dispatch_id = ?4
            "#,
        )
        .bind(encode_domain(
            &request.target,
            "orchestration worker Session",
        )?)
        .bind(format!("{:x}", Sha256::digest(digest)))
        .bind(request.rebound_at_ms)
        .bind(source.target.dispatch_id.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("rebind_orchestration_context", error))?;
        if updated_authority.rows_affected() != 1 {
            return Err(storage(
                "corrupt_orchestration_context",
                "the Dispatch authority disappeared during rebind",
            ));
        }
    }
    Ok(())
}

fn validate_dispatch_effective_launch_identity(
    matched: &DispatchSessionMatch,
    session: &WorkflowSessionGenerationV1,
    effective_launch_idempotency_key: &str,
) -> Result<(), DomainStoreErrorV1> {
    let dispatch_id = DispatchIdV1::new(matched.target.dispatch_id.as_str())
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let prepared_session_id = workflow_prepared_session_id(&dispatch_id)?;
    validate_workflow_effective_launch_identity(
        &prepared_session_id,
        &matched.launch_idempotency_key,
        session,
        effective_launch_idempotency_key,
    )
}

async fn rebind_dispatch_session_on_validated(
    connection: &mut SqliteConnection,
    request: &OrchestrationDispatchSessionRebindMutationV1,
) -> Result<OrchestrationDispatchSessionRebindReceiptV1, DomainStoreErrorV1> {
    let mut source_active = active_dispatch_matches(connection, &request.source).await?;
    let mut target_active = active_dispatch_matches(connection, &request.target).await?;
    let mut source_drainable =
        drainable_completed_dispatch_matches(connection, &request.source).await?;
    let mut target_drainable =
        drainable_completed_dispatch_matches(connection, &request.target).await?;
    if request.expected_source_dispatch_authority.is_some() {
        source_active.retain(DispatchSessionMatch::is_current_session_reporting);
        source_drainable.retain(DispatchSessionMatch::is_current_session_reporting);
    }
    if request.expected_target_dispatch_authority.is_some() {
        target_active.retain(DispatchSessionMatch::is_current_session_reporting);
        target_drainable.retain(DispatchSessionMatch::is_current_session_reporting);
    }
    if source_active.len() > 1 || target_active.len() > 1 {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &request.source.session_id,
            "a Session generation resolves to multiple active Dispatches",
        ));
    }
    if let Some(expected_authority) = &request.expected_source_dispatch_authority {
        for matched in source_active.iter().chain(source_drainable.iter()) {
            require_dispatch_runtime_authority(connection, matched, expected_authority).await?;
        }
    }
    if let Some(expected_authority) = &request.expected_target_dispatch_authority {
        for matched in target_active.iter().chain(target_drainable.iter()) {
            require_dispatch_runtime_authority(connection, matched, expected_authority).await?;
        }
    }
    let source_active = source_active.pop();
    let target_active = target_active.pop();

    if source_active.is_some()
        && target_active.is_some()
        && source_drainable.is_empty()
        && target_drainable.is_empty()
    {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &request.source.session_id,
            "the source and target are already assigned to different active Dispatches",
        ));
    }

    // A current Session may already have enrolled a successor after rehost.
    // Rescue completed deliveries without replacing either active authority.
    if target_active.is_none() {
        if let Some(source) = source_active {
            source_drainable.insert(0, source);
        }
    }
    for source in &source_drainable {
        move_dispatch_session(connection, request, source).await?;
    }

    let matched = target_active
        .as_ref()
        .or_else(|| source_drainable.first())
        .or_else(|| target_drainable.first());
    Ok(rebind_receipt(request, matched))
}

async fn require_dispatch_runtime_authority(
    connection: &mut SqliteConnection,
    matched: &DispatchSessionMatch,
    expected: &OrchestrationDispatchRuntimeAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    let actual = dispatch_runtime_authority(connection, matched).await?;
    if actual.runtime_kind_id != expected.runtime_kind_id
        || actual.agent_id != expected.agent_id
        || actual.binding_generation > expected.binding_generation
    {
        return Err(identity_conflict(
            "orchestration_runtime_authority",
            matched.target.dispatch_id.as_str(),
            "the Dispatch origin does not match the committed runtime transition lineage",
        ));
    }
    Ok(())
}

async fn dispatch_runtime_authority(
    connection: &mut SqliteConnection,
    matched: &DispatchSessionMatch,
) -> Result<OrchestrationDispatchRuntimeAuthorityV1, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            dispatch.runtime_kind_id,
            run.coordinator_agent_id,
            run.coordinator_binding_generation
        FROM workflow_dispatches AS dispatch
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        JOIN workflow_runs AS run ON run.run_id = task.run_id
        WHERE dispatch.dispatch_id = ?1
          AND task.task_id = ?2
        "#,
    )
    .bind(matched.target.dispatch_id.as_str())
    .bind(matched.target.task_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("validate_orchestration_runtime_authority", error))?;
    let Some(row) = row else {
        return Err(identity_conflict(
            "orchestration_runtime_authority",
            matched.target.dispatch_id.as_str(),
            "the exact Dispatch runtime authority disappeared",
        ));
    };
    let runtime_kind_id = RuntimeKindIdV1::new(
        row.try_get::<String, _>("runtime_kind_id")
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
    )
    .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let agent_id = AgentIdV1::new(
        row.try_get::<String, _>("coordinator_agent_id")
            .map_err(|error| storage("corrupt_workflow_run", error.to_string()))?,
    )
    .map_err(|error| storage("corrupt_workflow_run", error.to_string()))?;
    let binding_generation: i64 = row
        .try_get("coordinator_binding_generation")
        .map_err(|error| storage("corrupt_workflow_run", error.to_string()))?;
    Ok(OrchestrationDispatchRuntimeAuthorityV1 {
        agent_id,
        binding_generation,
        runtime_kind_id,
    })
}

async fn current_reporting_target_runtime_authority(
    connection: &mut SqliteConnection,
    dispatch_authority: &OrchestrationDispatchRuntimeAuthorityV1,
    target: &WorkflowSessionGenerationV1,
) -> Result<OrchestrationDispatchRuntimeAuthorityV1, DomainStoreErrorV1> {
    let authority = checkpoint_authority_on(connection, &dispatch_authority.agent_id)
        .await?
        .ok_or_else(|| {
            identity_conflict(
                "orchestration_runtime_authority",
                dispatch_authority.agent_id.as_str(),
                "the reporting Agent has no current native runtime authority",
            )
        })?;
    if let Some(selection) = selection_on(connection, &dispatch_authority.agent_id).await? {
        let runtime_authority = AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: authority.clone(),
        };
        if selection.interaction_profile != AgentInteractionProfileV1::NativeCli
            || selection.provider_id != target.provider_id
            || runtime_authority
                .validate_for_selection(&selection)
                .is_err()
        {
            return Err(identity_conflict(
                "orchestration_runtime_authority",
                dispatch_authority.agent_id.as_str(),
                "the reporting Agent no longer selects the requested native runtime authority",
            ));
        }
    }
    let current =
        WorkflowSessionGenerationV1::from_checkpoint_authority(&authority, &target.provider_id);
    if authority.binding.runtime_kind_id != dispatch_authority.runtime_kind_id
        || authority.binding.binding_generation < dispatch_authority.binding_generation
        || current != *target
    {
        return Err(identity_conflict(
            "orchestration_runtime_authority",
            dispatch_authority.agent_id.as_str(),
            "the requested reporting target is not the Agent's current native generation",
        ));
    }
    Ok(OrchestrationDispatchRuntimeAuthorityV1 {
        agent_id: authority.binding.agent_id,
        binding_generation: authority.binding.binding_generation,
        runtime_kind_id: authority.binding.runtime_kind_id,
    })
}

pub(crate) async fn reporting_agent_for_exact_dispatch(
    pool: &SqlitePool,
    exact: &OrchestrationDispatchGenerationV1,
) -> Result<Option<AgentIdV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("resolve_reporting_dispatch_agent", error))?;
    reporting_runtime_authority_for_exact_dispatch_on(&mut connection, exact, None)
        .await
        .map(|authority| authority.map(|authority| authority.agent_id))
}

pub(crate) async fn reporting_runtime_authority_for_exact_dispatch_on(
    connection: &mut SqliteConnection,
    requested: &OrchestrationDispatchGenerationV1,
    expected_agent_id: Option<&AgentIdV1>,
) -> Result<Option<OrchestrationDispatchRuntimeAuthorityV1>, DomainStoreErrorV1> {
    let exact = exact_dispatch_session_match(
        connection,
        &requested.task_id,
        &requested.dispatch_id,
        requested.generation,
    )
    .await?;
    if !exact.dispatch.is_current_session_reporting() {
        return Ok(None);
    }
    let authority = dispatch_runtime_authority(connection, &exact.dispatch).await?;
    if expected_agent_id.is_some_and(|expected| expected != &authority.agent_id) {
        return Err(identity_conflict(
            "orchestration_runtime_authority",
            requested.dispatch_id.as_str(),
            "the exact reporting Dispatch owner changed while awaiting reconciliation",
        ));
    }
    Ok(Some(authority))
}

pub(crate) async fn rebind_dispatch_session_on(
    connection: &mut SqliteConnection,
    request: &OrchestrationDispatchSessionRebindMutationV1,
) -> Result<OrchestrationDispatchSessionRebindReceiptV1, DomainStoreErrorV1> {
    rebind_dispatch_session_on_validated(connection, request).await
}

pub(crate) async fn rebind_dispatch_session(
    pool: &SqlitePool,
    request: &OrchestrationDispatchSessionRebindRequestV1,
    target_launch_idempotency_key: Option<&str>,
) -> Result<OrchestrationDispatchSessionRebindReceiptV1, DomainStoreErrorV1> {
    let request = OrchestrationDispatchSessionRebindMutationV1::from_request(
        request,
        target_launch_idempotency_key,
    )?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("rebind_orchestration_session", error))?;
    begin_immediate(&mut connection, "rebind_orchestration_session").await?;
    let result = rebind_dispatch_session_on_validated(&mut connection, &request).await;
    finish_transaction(&mut connection, "rebind_orchestration_session", result).await
}

pub(crate) async fn reconcile_dispatch_session(
    pool: &SqlitePool,
    expected_agent_id: Option<&AgentIdV1>,
    expected_runtime_kind_id: &RuntimeKindIdV1,
    request: &OrchestrationDispatchSessionRebindRequestV1,
    exact: &OrchestrationDispatchGenerationV1,
    target_launch_idempotency_key: Option<&str>,
) -> Result<OrchestrationDispatchSessionRebindReceiptV1, DomainStoreErrorV1> {
    let mut request = OrchestrationDispatchSessionRebindMutationV1::from_request(
        request,
        target_launch_idempotency_key,
    )?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("reconcile_orchestration_session", error))?;
    begin_immediate(&mut connection, "reconcile_orchestration_session").await?;
    let result = async {
        let matched = exact_dispatch_session_match(
            &mut connection,
            &exact.task_id,
            &exact.dispatch_id,
            exact.generation,
        )
        .await?;
        let dispatch_authority =
            dispatch_runtime_authority(&mut connection, &matched.dispatch).await?;
        if &dispatch_authority.runtime_kind_id != expected_runtime_kind_id {
            return Err(identity_conflict(
                "orchestration_runtime_authority",
                exact.dispatch_id.as_str(),
                "the exact Dispatch runtime does not match the Hmux rehost proof",
            ));
        }
        if matched.dispatch.is_current_session_reporting() {
            let expected_agent_id = expected_agent_id.ok_or_else(|| {
                identity_conflict(
                    "orchestration_runtime_authority",
                    exact.dispatch_id.as_str(),
                    "the reporting Dispatch has no locked Agent authority",
                )
            })?;
            if &dispatch_authority.agent_id != expected_agent_id {
                return Err(identity_conflict(
                    "orchestration_runtime_authority",
                    exact.dispatch_id.as_str(),
                    "the exact reporting Dispatch owner changed while awaiting reconciliation",
                ));
            }
            let target_authority = current_reporting_target_runtime_authority(
                &mut connection,
                &dispatch_authority,
                &request.target,
            )
            .await?;
            request.expected_source_dispatch_authority = Some(dispatch_authority);
            request.expected_target_dispatch_authority = Some(target_authority);
        }
        reconcile_dispatch_session_on(&mut connection, &request, exact).await
    }
    .await;
    finish_transaction(&mut connection, "reconcile_orchestration_session", result).await
}

pub(crate) async fn reconcile_dispatch_session_on(
    connection: &mut SqliteConnection,
    request: &OrchestrationDispatchSessionRebindMutationV1,
    requested: &OrchestrationDispatchGenerationV1,
) -> Result<OrchestrationDispatchSessionRebindReceiptV1, DomainStoreErrorV1> {
    let exact = exact_dispatch_session_match(
        connection,
        &requested.task_id,
        &requested.dispatch_id,
        requested.generation,
    )
    .await?;
    if exact.session != request.source && exact.session != request.target {
        return Err(identity_conflict(
            "orchestration_session_fence",
            requested.dispatch_id.as_str(),
            "the exact Dispatch generation changed to an unrelated Session launch",
        ));
    }
    let expected_exact_authority = if exact.session == request.source {
        request.expected_source_dispatch_authority.as_ref()
    } else {
        request.expected_target_dispatch_authority.as_ref()
    };
    if let Some(expected_authority) = expected_exact_authority {
        require_dispatch_runtime_authority(connection, &exact.dispatch, expected_authority).await?;
    }

    // Preserve the established whole-Session handoff first: an enrolled
    // successor or a completed Dispatch with queued coordinator delivery
    // remains the current context authority. A fully observed completed
    // predecessor is then converged by its exact immutable Dispatch fence.
    rebind_dispatch_session_on_validated(connection, request).await?;
    let exact = exact_dispatch_session_match(
        connection,
        &requested.task_id,
        &requested.dispatch_id,
        requested.generation,
    )
    .await?;
    if exact.session == request.source {
        if !exact.completed {
            return Err(identity_conflict(
                "orchestration_session_fence",
                requested.dispatch_id.as_str(),
                "an active exact Dispatch did not converge to the target Session generation",
            ));
        }
        move_dispatch_session(connection, request, &exact.dispatch).await?;
    } else if exact.session != request.target {
        return Err(identity_conflict(
            "orchestration_session_fence",
            requested.dispatch_id.as_str(),
            "the exact Dispatch generation changed during reconciliation",
        ));
    } else if let Some(expected_authority) = &request.expected_target_dispatch_authority {
        require_dispatch_runtime_authority(connection, &exact.dispatch, expected_authority).await?;
    }
    Ok(rebind_receipt(request, Some(&exact.dispatch)))
}

pub(crate) async fn dispatch_uses_managed_create_key(
    pool: &SqlitePool,
    session: &WorkflowSessionGenerationV1,
) -> Result<bool, DomainStoreErrorV1> {
    session.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_orchestration_delivery_mode", error))?;
    let active = active_dispatch_matches(&mut connection, session).await?;
    if active.len() > 1 {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &session.session_id,
            "a Session generation resolves to multiple active Dispatches",
        ));
    }
    let drainable = drainable_completed_dispatch_matches(&mut connection, session).await?;
    Ok(active
        .iter()
        .chain(&drainable)
        .any(|matched| matched.delivery_mode == "pty_prompt"))
}

pub(crate) async fn exact_dispatch_managed_create_key_state(
    pool: &SqlitePool,
    requested: &OrchestrationDispatchGenerationV1,
    session: &WorkflowSessionGenerationV1,
    expected_runtime_kind_id: &RuntimeKindIdV1,
) -> Result<OrchestrationManagedCreateKeyStateV1, DomainStoreErrorV1> {
    session.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_orchestration_delivery_mode", error))?;
    let exact = exact_dispatch_session_match(
        &mut connection,
        &requested.task_id,
        &requested.dispatch_id,
        requested.generation,
    )
    .await?;
    if exact.session != *session {
        return Err(identity_conflict(
            "orchestration_session_fence",
            requested.dispatch_id.as_str(),
            "the exact Dispatch generation must match the expected Session launch",
        ));
    }
    if dispatch_runtime_authority(&mut connection, &exact.dispatch)
        .await?
        .runtime_kind_id
        != *expected_runtime_kind_id
    {
        return Err(identity_conflict(
            "orchestration_runtime_authority",
            requested.dispatch_id.as_str(),
            "the exact Dispatch runtime does not match the Hmux reconciliation",
        ));
    }
    let matched = exact.dispatch;
    if matched.delivery_mode != "pty_prompt" {
        return Ok(OrchestrationManagedCreateKeyStateV1::NotRequired);
    }
    let Some(effective_launch_idempotency_key) =
        matched.effective_launch_idempotency_key.as_deref()
    else {
        return Ok(OrchestrationManagedCreateKeyStateV1::Missing);
    };
    validate_dispatch_effective_launch_identity(
        &matched,
        session,
        effective_launch_idempotency_key,
    )?;
    Ok(OrchestrationManagedCreateKeyStateV1::Present)
}

pub(crate) async fn run_authority_for_exact_session(
    pool: &SqlitePool,
    session: &WorkflowSessionGenerationV1,
) -> Result<ExistingSessionRunAuthority, DomainStoreErrorV1> {
    session.validate()?;
    let rows = sqlx::query(
        r#"
        SELECT
            agent.workspace_id,
            agent.provider_id,
            binding.runtime_kind_id,
            binding.provider_conversation_id
        FROM session_bindings AS binding
        JOIN agent_checkpoint_binding_authorities AS authority
          ON authority.agent_id = binding.agent_id
        JOIN agents AS agent ON agent.agent_id = binding.agent_id
        WHERE binding.session_id = ?1
          AND authority.session_id = ?1
          AND authority.runtime_workspace_id = ?2
          AND authority.runner_principal = ?3
          AND authority.runner_instance = ?4
          AND authority.channel_epoch = ?5
          AND authority.host_instance_id = ?6
          AND authority.terminal_epoch = ?7
          AND authority.binding_generation = binding.binding_generation
        "#,
    )
    .bind(&session.session_id)
    .bind(&session.workspace_id)
    .bind(&session.runner_principal)
    .bind(&session.runner_instance)
    .bind(&session.channel_epoch)
    .bind(&session.host_instance_id)
    .bind(&session.terminal_epoch)
    .fetch_all(pool)
    .await
    .map_err(|error| map_sqlx("resolve_orchestration_run_authority", error))?;
    if rows.len() != 1 {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &session.session_id,
            "the exact Session generation must resolve to one current authority",
        ));
    }
    let row = &rows[0];
    let provider_id: String = row
        .try_get("provider_id")
        .map_err(|error| storage("corrupt_orchestration_authority", error.to_string()))?;
    if !(provider_id == session.provider_id.as_str()
        || provider_id.strip_prefix("provider.") == Some(session.provider_id.as_str()))
    {
        return Err(identity_conflict(
            "orchestration_session_fence",
            &session.session_id,
            "the exact Session provider must match its current authority",
        ));
    }
    Ok(ExistingSessionRunAuthority {
        authority: AuthorityScope {
            workspace_id: WorkspaceId::new(required_string(row, "workspace_id")?)
                .map_err(|error| storage("corrupt_orchestration_authority", error.to_string()))?,
            tenant_ref: None,
        },
        runtime_ref: RuntimeRef::new(required_string(row, "runtime_kind_id")?)
            .map_err(|error| storage("corrupt_orchestration_authority", error.to_string()))?,
        provider_conversation_id: row
            .try_get("provider_conversation_id")
            .map_err(|error| storage("corrupt_orchestration_authority", error.to_string()))?,
    })
}

async fn validate_canonical_dispatch(
    connection: &mut SqliteConnection,
    request: &OrchestrationDispatchContextRequestV1,
) -> Result<(), DomainStoreErrorV1> {
    if request.target.authority.tenant_ref.is_some() {
        return Err(invalid(
            "target.authority.tenantRef",
            "the local adapter has no canonical tenant binding",
        ));
    }
    let row = sqlx::query(
        r#"
        SELECT
            run.run_id,
            coordinator.workspace_id AS authority_workspace_id,
            dispatch.task_id,
            dispatch.generation,
            dispatch.state AS dispatch_state,
            launch.state AS launch_state,
            launch.session_id,
            launch.workspace_id,
            launch.provider_id,
            launch.runner_principal,
            launch.runner_instance,
            launch.channel_epoch,
            launch.host_instance_id,
            launch.terminal_epoch
        FROM workflow_dispatches AS dispatch
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        JOIN workflow_runs AS run ON run.run_id = task.run_id
        JOIN agents AS coordinator ON coordinator.agent_id = run.coordinator_agent_id
        JOIN workflow_dispatch_launches AS launch ON launch.dispatch_id = dispatch.dispatch_id
        WHERE dispatch.dispatch_id = ?1
        "#,
    )
    .bind(request.target.dispatch_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("validate_orchestration_dispatch", error))?
    .ok_or_else(|| DomainStoreErrorV1::NotFound {
        entity: "workflow_dispatch",
        id: request.target.dispatch_id.to_string(),
    })?;
    let run_id: String = row
        .try_get("run_id")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let task_id: String = row
        .try_get("task_id")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let authority_workspace_id: String = row
        .try_get("authority_workspace_id")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let generation: i64 = row
        .try_get("generation")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let dispatch_state: String = row
        .try_get("dispatch_state")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    let launch_state: String = row
        .try_get("launch_state")
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
    if run_id != request.target.run_id.as_str()
        || task_id != request.target.task_id.as_str()
        || authority_workspace_id != request.target.authority.workspace_id.as_str()
        || u64::try_from(generation).ok() != Some(request.target.generation.get())
        || dispatch_state != "starting"
        || launch_state != "active"
    {
        return Err(identity_conflict(
            "orchestration_dispatch_fence",
            request.target.dispatch_id.as_str(),
            "Run, Task, Dispatch generation, and active state must match",
        ));
    }
    let stored_session = WorkflowSessionGenerationV1 {
        session_id: required_string(&row, "session_id")?,
        workspace_id: required_string(&row, "workspace_id")?,
        provider_id: dure_app::ProviderIdV1::new(required_string(&row, "provider_id")?)
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?,
        runner_principal: required_string(&row, "runner_principal")?,
        runner_instance: required_string(&row, "runner_instance")?,
        channel_epoch: required_string(&row, "channel_epoch")?,
        host_instance_id: required_string(&row, "host_instance_id")?,
        terminal_epoch: required_string(&row, "terminal_epoch")?,
    };
    if stored_session != request.session {
        return Err(identity_conflict(
            "orchestration_session_fence",
            request.target.dispatch_id.as_str(),
            "the exact Session generation must match the canonical launch receipt",
        ));
    }
    Ok(())
}

fn context_dispatch_lifecycle(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<(DispatchState, bool), DomainStoreErrorV1> {
    let dispatch_state: String = row
        .try_get("dispatch_state")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let blocked_by: Option<String> = row
        .try_get("blocked_by")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    let successor_required: i64 = row
        .try_get("successor_required")
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    match (
        dispatch_state.as_str(),
        blocked_by.is_some(),
        successor_required,
    ) {
        ("starting", false, 0) => Ok((DispatchState::Active, false)),
        ("starting", true, 0) => Ok((DispatchState::Blocked, false)),
        ("completed", false, 0) => Ok((DispatchState::Completed, false)),
        ("completed", false, 1) => Ok((DispatchState::Completed, true)),
        _ => Err(storage(
            "corrupt_orchestration_context",
            "Dispatch state, blocking authority, and successor lifecycle disagree",
        )),
    }
}

fn context_from_row(
    row: sqlx::sqlite::SqliteRow,
    target: &InteractionTarget,
) -> Result<DispatchContextReceipt, DomainStoreErrorV1> {
    let revision = positive_revision(
        row.try_get("revision")
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
    )?;
    let mut endpoint: WorkerEndpoint = decode_domain(
        row.try_get("worker_endpoint_json")
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        "orchestration worker endpoint",
    )?;
    restore_wake_capability(&mut endpoint);
    let coordinator_grant: AudienceGrant = decode_domain(
        row.try_get("coordinator_grant_json")
            .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?,
        "orchestration coordinator grant",
    )?;
    let (dispatch_state, successor_required) = context_dispatch_lifecycle(&row)?;
    let receipt = DispatchContextReceipt {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        target: target.clone(),
        dispatch_revision: revision,
        dispatch_state,
        successor_required,
        participant: endpoint.participant.clone(),
        interaction_capability: capability_from_row(&row, "interaction_capability")?,
        completion_capability: capability_from_row(&row, "completion_capability")?,
        delivery_capability: endpoint.delivery_capability.clone(),
        acknowledgement_capability: endpoint.acknowledgement_capability.clone(),
        wake_capability: endpoint.wake_capability.clone(),
        endpoint_fence: WorkerEndpointFence {
            endpoint_ref: endpoint.endpoint_ref,
            session_identity: endpoint.session_identity,
            generation: endpoint.generation,
            delivery_capability: endpoint.delivery_capability,
            acknowledgement_capability: endpoint.acknowledgement_capability,
        },
        coordinator_grant,
        coordinator_reply_capability: capability_from_row(&row, "coordinator_reply_capability")?,
        integration_receipt: endpoint.integration_receipt,
    };
    receipt
        .validate()
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    Ok(receipt)
}

async fn load_state(
    connection: &mut SqliteConnection,
    authority: &AuthorityScope,
) -> Result<StoreState, StoreError> {
    let key = authority_key(authority)?;
    let mut dispatches = Vec::new();
    let rows = sqlx::query(
        r#"
        SELECT
            authority.workspace_id,
            authority.tenant_ref,
            authority.revision,
            authority.blocked_by,
            authority.interaction_capability,
            authority.completion_capability,
            authority.worker_endpoint_json,
            run.run_id,
            dispatch.task_id,
            dispatch.dispatch_id,
            dispatch.generation,
            dispatch.state AS dispatch_state,
            launch.state AS launch_state,
            launch.delivery_mode,
            launch.prompt_delivery_state
        FROM workflow_interaction_authorities AS authority
        JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = authority.dispatch_id
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        JOIN workflow_runs AS run ON run.run_id = task.run_id
        JOIN workflow_dispatch_launches AS launch ON launch.dispatch_id = dispatch.dispatch_id
        WHERE authority.authority_key = ?1
        ORDER BY dispatch.dispatch_id
        "#,
    )
    .bind(&key)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    for row in rows {
        let workspace_id: String = row.try_get("workspace_id").map_err(|_| corrupt())?;
        let tenant_ref: Option<String> = row.try_get("tenant_ref").map_err(|_| corrupt())?;
        if workspace_id != authority.workspace_id.as_str()
            || tenant_ref.as_deref() != authority.tenant_ref.as_ref().map(TenantRef::as_str)
        {
            return Err(corrupt());
        }
        let blocked_by = row
            .try_get::<Option<String>, _>("blocked_by")
            .map_err(|_| corrupt())?
            .map(InteractionId::new)
            .transpose()
            .map_err(|_| corrupt())?;
        let dispatch_state: String = row.try_get("dispatch_state").map_err(|_| corrupt())?;
        let launch_state: String = row.try_get("launch_state").map_err(|_| corrupt())?;
        let delivery_mode: String = row.try_get("delivery_mode").map_err(|_| corrupt())?;
        let prompt_delivery_state: Option<String> = row
            .try_get("prompt_delivery_state")
            .map_err(|_| corrupt())?;
        let delivery_is_ready = delivery_mode == "durable_inbox"
            || (delivery_mode == "pty_prompt"
                && prompt_delivery_state.as_deref() == Some("written_to_pty"));
        let state = if dispatch_state == "completed" {
            DispatchState::Completed
        } else if blocked_by.is_some() && delivery_is_ready {
            DispatchState::Blocked
        } else if dispatch_state == "starting" && launch_state == "active" && delivery_is_ready {
            DispatchState::Active
        } else {
            return Err(StoreError::StateConflict {
                code: "dispatch_not_interactive",
            });
        };
        let generation: i64 = row.try_get("generation").map_err(|_| corrupt())?;
        let mut worker_endpoint: WorkerEndpoint =
            decode_store(row.try_get("worker_endpoint_json").map_err(|_| corrupt())?)?;
        restore_wake_capability(&mut worker_endpoint);
        let record = DispatchRecord {
            target: InteractionTarget {
                authority: authority.clone(),
                run_id: RunId::new(row.try_get::<String, _>("run_id").map_err(|_| corrupt())?)
                    .map_err(|_| corrupt())?,
                task_id: TaskId::new(row.try_get::<String, _>("task_id").map_err(|_| corrupt())?)
                    .map_err(|_| corrupt())?,
                dispatch_id: DispatchId::new(
                    row.try_get::<String, _>("dispatch_id")
                        .map_err(|_| corrupt())?,
                )
                .map_err(|_| corrupt())?,
                generation: Generation::new(u64::try_from(generation).map_err(|_| corrupt())?)
                    .map_err(|_| corrupt())?,
            },
            revision: positive_revision_store(row.try_get("revision").map_err(|_| corrupt())?)?,
            state,
            blocked_by,
            interaction_capability: CapabilityRef::new(
                row.try_get::<String, _>("interaction_capability")
                    .map_err(|_| corrupt())?,
            )
            .map_err(|_| corrupt())?,
            completion_capability: CapabilityRef::new(
                row.try_get::<String, _>("completion_capability")
                    .map_err(|_| corrupt())?,
            )
            .map_err(|_| corrupt())?,
            worker_endpoint,
        };
        record.validate().map_err(|_| corrupt())?;
        dispatches.push(record);
    }
    let interactions = decode_store_rows(
        connection,
        "SELECT record_json FROM workflow_interactions WHERE authority_key = ?1 ORDER BY interaction_id",
        &key,
        "record_json",
    )
    .await?;
    let events: Vec<Event> = decode_store_rows(
        connection,
        "SELECT event_json FROM workflow_interaction_events WHERE authority_key = ?1 ORDER BY cursor",
        &key,
        "event_json",
    )
    .await?;
    let mut deliveries: Vec<DeliveryEntry> = decode_store_rows(
        connection,
        "SELECT delivery_json FROM workflow_interaction_deliveries WHERE authority_key = ?1 ORDER BY event_cursor, receipt_id",
        &key,
        "delivery_json",
    )
    .await?;
    for delivery in &mut deliveries {
        if delivery.receipt.endpoint.is_none() || delivery.wake_capability.is_some() {
            continue;
        }
        let Some(event) = events
            .iter()
            .find(|event| event.cursor == delivery.receipt.event_cursor)
        else {
            continue;
        };
        let Some(dispatch) = dispatches
            .iter()
            .find(|dispatch| dispatch.target == event.target)
        else {
            continue;
        };
        delivery.wake_capability = dispatch.worker_endpoint.wake_capability.clone();
    }
    let mut idempotency = BTreeMap::new();
    for row in sqlx::query(
        "SELECT operation_key, entry_json FROM workflow_interaction_idempotency WHERE authority_key = ?1 ORDER BY operation_key",
    )
    .bind(&key)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| unavailable())?
    {
        idempotency.insert(
            row.try_get("operation_key").map_err(|_| corrupt())?,
            decode_store(row.try_get("entry_json").map_err(|_| corrupt())?)?,
        );
    }
    let mut acknowledgement_idempotency = BTreeMap::new();
    for row in sqlx::query(
        "SELECT operation_key, fingerprint FROM workflow_interaction_acknowledgements WHERE authority_key = ?1 ORDER BY operation_key",
    )
    .bind(&key)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| unavailable())?
    {
        acknowledgement_idempotency.insert(
            row.try_get("operation_key").map_err(|_| corrupt())?,
            row.try_get("fingerprint").map_err(|_| corrupt())?,
        );
    }
    let next_cursor = sqlx::query_scalar::<_, i64>(
        "SELECT next_cursor FROM workflow_interaction_cursors WHERE authority_key = ?1",
    )
    .bind(&key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| unavailable())?
    .unwrap_or(1);
    let state = StoreState {
        dispatches,
        interactions,
        events,
        deliveries,
        idempotency,
        acknowledgement_idempotency,
        next_cursor: u64::try_from(next_cursor).map_err(|_| corrupt())?,
    };
    state.validate()?;
    Ok(state)
}

fn restore_wake_capability(endpoint: &mut WorkerEndpoint) {
    if endpoint.wake_capability.is_some() {
        return;
    }
    let mut digest = Sha256::new();
    digest.update(b"dure.worker-wake-capability/v1\0");
    digest.update(endpoint.delivery_capability.as_str().as_bytes());
    endpoint.wake_capability = Some(
        CapabilityRef::new(format!("capability-worker-wake-{:x}", digest.finalize()))
            .expect("derived wake capability is bounded and control-free"),
    );
}

async fn persist_state(
    connection: &mut SqliteConnection,
    authority: &AuthorityScope,
    state: &StoreState,
) -> Result<(), StoreError> {
    state.validate()?;
    let key = authority_key(authority)?;
    let latest_event_at = state
        .events
        .iter()
        .map(|event| event.recorded_at_ms)
        .max()
        .unwrap_or(0);
    for dispatch in &state.dispatches {
        if dispatch.target.authority != *authority {
            return Err(corrupt());
        }
        let updated = sqlx::query(
            r#"
            UPDATE workflow_interaction_authorities
            SET revision = ?1,
                blocked_by = ?2,
                worker_endpoint_json = ?3,
                updated_at_ms = MAX(updated_at_ms, ?4)
            WHERE authority_key = ?5 AND dispatch_id = ?6
            "#,
        )
        .bind(i64::try_from(dispatch.revision.get()).map_err(|_| corrupt())?)
        .bind(dispatch.blocked_by.as_ref().map(InteractionId::as_str))
        .bind(encode_store(&dispatch.worker_endpoint)?)
        .bind(latest_event_at)
        .bind(&key)
        .bind(dispatch.target.dispatch_id.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|_| unavailable())?;
        if updated.rows_affected() != 1 {
            return Err(corrupt());
        }
        if dispatch.state == DispatchState::Completed {
            persist_canonical_completion(connection, dispatch, state).await?;
        }
    }
    for interaction in &state.interactions {
        if interaction.common().target.authority != *authority {
            return Err(corrupt());
        }
        sqlx::query(
            r#"
            INSERT INTO workflow_interactions (authority_key, interaction_id, dispatch_id, record_json)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(authority_key, interaction_id)
            DO UPDATE SET record_json = excluded.record_json
            "#,
        )
        .bind(&key)
        .bind(interaction.common().id.as_str())
        .bind(interaction.common().target.dispatch_id.as_str())
        .bind(encode_store(interaction)?)
        .execute(&mut *connection)
        .await
        .map_err(|_| unavailable())?;
    }
    for event in &state.events {
        insert_immutable(
            connection,
            "INSERT INTO workflow_interaction_events (authority_key, cursor, event_json) VALUES (?1, ?2, ?3) ON CONFLICT(authority_key, cursor) DO NOTHING",
            "SELECT event_json FROM workflow_interaction_events WHERE authority_key = ?1 AND cursor = ?2",
            &key,
            i64::try_from(event.cursor.get()).map_err(|_| corrupt())?,
            encode_store(event)?,
        )
        .await?;
    }
    for delivery in &state.deliveries {
        sqlx::query(
            r#"
            INSERT INTO workflow_interaction_deliveries (authority_key, receipt_id, event_cursor, delivery_json)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(authority_key, receipt_id)
            DO UPDATE SET delivery_json = excluded.delivery_json
            "#,
        )
        .bind(&key)
        .bind(delivery.receipt.receipt_id.as_str())
        .bind(i64::try_from(delivery.receipt.event_cursor.get()).map_err(|_| corrupt())?)
        .bind(encode_store(delivery)?)
        .execute(&mut *connection)
        .await
        .map_err(|_| unavailable())?;
    }
    for (operation_key, entry) in &state.idempotency {
        insert_immutable_json_text_key(
            connection,
            "INSERT INTO workflow_interaction_idempotency (authority_key, operation_key, entry_json) VALUES (?1, ?2, ?3) ON CONFLICT(authority_key, operation_key) DO NOTHING",
            "SELECT entry_json FROM workflow_interaction_idempotency WHERE authority_key = ?1 AND operation_key = ?2",
            &key,
            operation_key,
            entry,
        )
        .await?;
    }
    for (operation_key, fingerprint) in &state.acknowledgement_idempotency {
        insert_immutable_text_key(
            connection,
            "INSERT INTO workflow_interaction_acknowledgements (authority_key, operation_key, fingerprint) VALUES (?1, ?2, ?3) ON CONFLICT(authority_key, operation_key) DO NOTHING",
            "SELECT fingerprint FROM workflow_interaction_acknowledgements WHERE authority_key = ?1 AND operation_key = ?2",
            &key,
            operation_key,
            fingerprint.clone(),
        )
        .await?;
    }
    let current = sqlx::query_scalar::<_, i64>(
        "SELECT next_cursor FROM workflow_interaction_cursors WHERE authority_key = ?1",
    )
    .bind(&key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| unavailable())?
    .unwrap_or(1);
    let next_cursor = i64::try_from(state.next_cursor).map_err(|_| corrupt())?;
    if next_cursor < current {
        return Err(corrupt());
    }
    sqlx::query(
        "INSERT INTO workflow_interaction_cursors (authority_key, next_cursor) VALUES (?1, ?2) ON CONFLICT(authority_key) DO UPDATE SET next_cursor = excluded.next_cursor",
    )
    .bind(key)
    .bind(next_cursor)
    .execute(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    Ok(())
}

async fn persist_canonical_completion(
    connection: &mut SqliteConnection,
    dispatch: &DispatchRecord,
    state: &StoreState,
) -> Result<(), StoreError> {
    let message = state
        .interactions
        .iter()
        .find(|interaction| {
            interaction.common().target == dispatch.target
                && matches!(
                    interaction,
                    InteractionRecord::Message {
                        purpose: MessagePurpose::CompletionReport,
                        ..
                    }
                )
        })
        .ok_or(StoreError::Corrupt {
            code: "completion_message_missing",
        })?;
    let completed_at_ms = message.common().created_at_ms;
    let result_markdown = &message.common().description_markdown;
    let updated = sqlx::query(
        r#"
        UPDATE workflow_dispatches
        SET state = 'completed', completion_result = ?1, updated_at_ms = MAX(updated_at_ms, ?2)
        WHERE dispatch_id = ?3
          AND (state = 'starting' OR (state = 'completed' AND completion_result = ?1))
        "#,
    )
    .bind(result_markdown)
    .bind(completed_at_ms)
    .bind(dispatch.target.dispatch_id.as_str())
    .execute(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    if updated.rows_affected() != 1 {
        return Err(StoreError::StateConflict {
            code: "canonical_completion_conflict",
        });
    }
    let task = sqlx::query(
        "UPDATE workflow_tasks SET state = 'completed', updated_at_ms = MAX(updated_at_ms, ?1) WHERE task_id = ?2",
    )
    .bind(completed_at_ms)
    .bind(dispatch.target.task_id.as_str())
    .execute(&mut *connection)
    .await
    .map_err(|_| unavailable())?;
    if task.rows_affected() != 1 {
        return Err(corrupt());
    }
    Ok(())
}

async fn decode_store_rows<T: serde::de::DeserializeOwned>(
    connection: &mut SqliteConnection,
    query: &str,
    authority_key: &str,
    column: &str,
) -> Result<Vec<T>, StoreError> {
    sqlx::query(query)
        .bind(authority_key)
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| unavailable())?
        .into_iter()
        .map(|row| decode_store(row.try_get(column).map_err(|_| corrupt())?))
        .collect()
}

async fn insert_immutable(
    connection: &mut SqliteConnection,
    insert: &str,
    select: &str,
    authority_key: &str,
    numeric_key: i64,
    value: String,
) -> Result<(), StoreError> {
    let inserted = sqlx::query(insert)
        .bind(authority_key)
        .bind(numeric_key)
        .bind(&value)
        .execute(&mut *connection)
        .await
        .map_err(|_| unavailable())?;
    if inserted.rows_affected() == 0 {
        let existing: String = sqlx::query_scalar(select)
            .bind(authority_key)
            .bind(numeric_key)
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| unavailable())?;
        if existing != value {
            return Err(corrupt());
        }
    }
    Ok(())
}

async fn insert_immutable_text_key(
    connection: &mut SqliteConnection,
    insert: &str,
    select: &str,
    authority_key: &str,
    text_key: &str,
    value: String,
) -> Result<(), StoreError> {
    let inserted = sqlx::query(insert)
        .bind(authority_key)
        .bind(text_key)
        .bind(&value)
        .execute(&mut *connection)
        .await
        .map_err(|_| unavailable())?;
    if inserted.rows_affected() == 0 {
        let existing: String = sqlx::query_scalar(select)
            .bind(authority_key)
            .bind(text_key)
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| unavailable())?;
        if existing != value {
            return Err(corrupt());
        }
    }
    Ok(())
}

async fn insert_immutable_json_text_key<T>(
    connection: &mut SqliteConnection,
    insert: &str,
    select: &str,
    authority_key: &str,
    text_key: &str,
    value: &T,
) -> Result<(), StoreError>
where
    T: Serialize + serde::de::DeserializeOwned,
{
    let encoded = encode_store(value)?;
    let inserted = sqlx::query(insert)
        .bind(authority_key)
        .bind(text_key)
        .bind(&encoded)
        .execute(&mut *connection)
        .await
        .map_err(|_| unavailable())?;
    if inserted.rows_affected() == 0 {
        let existing: String = sqlx::query_scalar(select)
            .bind(authority_key)
            .bind(text_key)
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| unavailable())?;
        let existing = decode_store::<T>(existing)?;
        let existing = serde_json::to_value(existing).map_err(|_| corrupt())?;
        let requested = serde_json::to_value(value).map_err(|_| corrupt())?;
        if existing != requested {
            return Err(corrupt());
        }
    }
    Ok(())
}

async fn finish_store_transaction<T>(
    connection: &mut SqliteConnection,
    outcome: Result<T, StoreError>,
) -> Result<T, StoreError> {
    match outcome {
        Ok(value) => {
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .map_err(|_| unavailable())?;
            Ok(value)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

pub fn session_identity(
    session: &WorkflowSessionGenerationV1,
) -> Result<SessionIdentityRef, DomainStoreErrorV1> {
    session.validate()?;
    let source = serde_json::to_vec(session)
        .map_err(|error| serialization("orchestration Session identity", error))?;
    SessionIdentityRef::new(format!("session-{:x}", Sha256::digest(source)))
        .map_err(|error| invalid(error.field, error.code))
}

fn negotiation_digest(
    request: &OrchestrationDispatchContextRequestV1,
) -> Result<String, DomainStoreErrorV1> {
    let source = negotiation_evidence(
        &request.target,
        &request.session,
        &request.integration_receipt,
    )
    .map_err(|error| serialization("orchestration negotiation evidence", error))?;
    Ok(format!("{:x}", Sha256::digest(source)))
}

fn store_negotiation_digest(
    target: &InteractionTarget,
    session: &agent_orchestration::domain::WorkerSessionGeneration,
    integration_receipt: &IntegrationCapabilityReceipt,
) -> Result<String, StoreError> {
    let source =
        negotiation_evidence(target, session, integration_receipt).map_err(|_| corrupt())?;
    Ok(format!("{:x}", Sha256::digest(source)))
}

fn negotiation_evidence<S: Serialize>(
    target: &InteractionTarget,
    session: &S,
    integration_receipt: &IntegrationCapabilityReceipt,
) -> Result<Vec<u8>, serde_json::Error> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Evidence<'a, S> {
        target: &'a InteractionTarget,
        session: &'a S,
        integration_receipt: &'a IntegrationCapabilityReceipt,
    }
    serde_json::to_vec(&Evidence {
        target,
        session,
        integration_receipt,
    })
}

fn authority_key(authority: &AuthorityScope) -> Result<String, StoreError> {
    let source = serde_json::to_vec(authority).map_err(|_| corrupt())?;
    Ok(format!("{:x}", Sha256::digest(source)))
}

fn required_string(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<String, DomainStoreErrorV1> {
    row.try_get::<Option<String>, _>(column)
        .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?
        .ok_or_else(|| storage("corrupt_workflow_dispatch", format!("{column} is missing")))
}

fn capability_from_row(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<CapabilityRef, DomainStoreErrorV1> {
    let value: String = row
        .try_get(column)
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))?;
    CapabilityRef::new(value)
        .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))
}

fn positive_revision(value: i64) -> Result<Revision, DomainStoreErrorV1> {
    Revision::new(
        u64::try_from(value)
            .map_err(|_| storage("corrupt_orchestration_context", "revision is invalid"))?,
    )
    .map_err(|error| storage("corrupt_orchestration_context", error.to_string()))
}

fn positive_revision_store(value: i64) -> Result<Revision, StoreError> {
    Revision::new(u64::try_from(value).map_err(|_| corrupt())?).map_err(|_| corrupt())
}

fn encode_domain(
    value: &impl Serialize,
    entity: &'static str,
) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(value).map_err(|error| serialization(entity, error))
}

fn decode_domain<T: serde::de::DeserializeOwned>(
    value: String,
    entity: &'static str,
) -> Result<T, DomainStoreErrorV1> {
    serde_json::from_str(&value).map_err(|error| serialization(entity, error))
}

fn encode_store(value: &impl Serialize) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| corrupt())
}

fn decode_store<T: serde::de::DeserializeOwned>(value: String) -> Result<T, StoreError> {
    serde_json::from_str(&value).map_err(|_| corrupt())
}

fn invalid(field: &'static str, reason: impl Into<String>) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

fn unavailable() -> StoreError {
    StoreError::Unavailable {
        code: "adapter_unavailable",
    }
}

fn corrupt() -> StoreError {
    StoreError::Corrupt {
        code: "adapter_data_invalid",
    }
}

fn map_orchestration_store(operation: &'static str, error: StoreError) -> DomainStoreErrorV1 {
    storage("orchestration_store", format!("{operation}: {error:?}"))
}

pub(crate) fn interaction_service(pool: SqlitePool) -> InteractionService {
    InteractionService::new(StoreHandle::new(WorkflowInteractionStore::new(pool)))
}
