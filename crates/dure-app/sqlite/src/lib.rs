//! SQLite-backed durable application state.
//!
//! This adapter persists domain identity and operation history. It deliberately
//! does not persist PTY bytes, terminal epochs or sequences, controller leases,
//! process liveness, or any other live Hmux runtime fact.

use std::path::{Path, PathBuf};

use dure_app::{
    AgentCheckpointBindingAuthorityV1, AgentCheckpointIdentityV1, AgentCheckpointObservationV1,
    AgentCheckpointRecordV1, AgentCheckpointWriteReceiptV1, AgentCheckpointWriteRequestV1,
    AgentDispatchStopStore, AgentIdV1, AgentRecordV1, AgentRuntimeTransitionStore,
    AgentSpawnJournalEventV1, AgentSpawnJournalReceiptV1, AgentSpawnJournalStore,
    AgentSpawnPlanIntentDraftV1, AgentSpawnPlanV1, AgentTimelineStore, ClientViewAuthorityV1,
    ClientViewGenerationAdvanceRequestV1, ClientViewGenerationReceiptV1, ClientViewIdentityV1,
    ClientViewNamespaceV1, ClientViewRecordV1, ClientViewWriteReceiptV1, ClientViewWriteRequestV1,
    DelegateOncePromptActivityRequestV1, DelegateOncePromptClaimRequestV1,
    DelegateOncePromptOutcomeRequestV1, DelegateOnceReceiptV1, DelegateOnceRequestV1,
    DelegateOnceSessionBindingRequestV1, DelegateOnceStartFailureRequestV1, DispatchIdV1,
    DomainStore, DomainStoreErrorV1, DomainStoreFuture, OperationEventIdV1, OperationEventV1,
    OperationIdV1, OperationReceiptV1, PluginApplyJournalEventV2, PluginApplyJournalReceiptV2,
    PluginApplyJournalStore, PluginNativeApplyAuthorityStore, PluginNativeOwnershipKeyV2,
    PluginNativeOwnershipReceiptV2, PluginNativePhysicalTargetBindingV2, ProjectIdV1,
    ProjectRecordV1, ProviderCredentialProfileRegistrationV1, ProviderCredentialProfileStore,
    ProviderLaunchDefaultsPutReceiptV1, ProviderLaunchDefaultsPutRequestV1,
    ProviderLaunchDefaultsV1, ReviewIdV1, ReviewTargetRecordV1, ReviewTargetRetentionPolicyV1,
    ReviewTargetRootSnapshotV1, ReviewTargetSweepReceiptV1, SessionBindingRecordV1,
    StoreSchemaInfoV1, TaskIdV1, WorkflowEffectiveLaunchRepairRequestV1,
    WorkflowPromptDeliveryClaimV1, WorkflowStore, WorkspaceIdV1, WorkspaceRecordV1,
};
use sqlx::SqlitePool;

mod agent_bootstrap;
mod agent_dispatch_stop;
mod agent_goals;
mod agent_queue;
mod agent_runtime_checkout;
mod agent_runtime_close;
mod agent_runtime_dispatch;
mod agent_runtime_rehost;
mod agent_runtime_removal;
mod agent_runtime_transition;
mod agent_spawn;
mod agent_timeline;
mod browser_profiles;
mod checkpoint_bindings;
mod checkpoints;
mod client_views;
mod error;
mod operations;
mod orchestration;
mod plugin_apply;
mod plugin_native_target_binding;
mod provider_credential_profiles;
mod provider_recovery;
mod provider_recovery_usage;
mod agent_recovery;
mod provider_launch_defaults;
mod records;
mod schedule_occurrences;
mod schedule_runs;
mod schedule_schema;
mod schedules;
mod schema;
mod session_checkout;
mod workflow;
mod workflow_effect_bindings;
mod workflow_graph;
mod workspace_catalog;

pub use session_checkout::SessionCheckoutAdmission;

pub use orchestration::{
    ExistingSessionRunAuthority, MAX_ORCHESTRATION_CONTEXT_BATCH_ITEMS,
    OrchestrationDispatchContextBatchItemV1, OrchestrationDispatchContextRequestV1,
    OrchestrationDispatchContextResolutionV1, OrchestrationDispatchGenerationV1,
    OrchestrationDispatchSessionInspectionReceiptV1, OrchestrationDispatchSessionRebindReceiptV1,
    OrchestrationDispatchSessionRebindRequestV1, OrchestrationManagedCreateKeyStateV1,
    session_identity as orchestration_session_identity,
};

/// A bounded SQLite pool implementing the durable domain-store port.
#[derive(Clone)]
pub struct SqliteDomainStore {
    pool: SqlitePool,
    path: PathBuf,
    schema_info: StoreSchemaInfoV1,
}

impl SqliteDomainStore {
    /// Verifies that an existing database can be opened by this host without
    /// creating or mutating the database.
    pub async fn preflight(path: impl AsRef<Path>) -> Result<(), DomainStoreErrorV1> {
        schema::preflight_database(path.as_ref()).await
    }

    /// Opens or creates a domain database at `path`.
    ///
    /// Existing metadata is inspected read-only before writable SQLite options
    /// are enabled, so a database requiring a newer host fails closed before
    /// any domain schema or record is changed.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, DomainStoreErrorV1> {
        let (pool, path, schema_info) = schema::open_database(path.as_ref()).await?;
        let store = Self {
            pool,
            path,
            schema_info,
        };
        if let Err(error) = operations::rebuild_receipts(&store.pool).await {
            store.pool.close().await;
            return Err(error);
        }
        if let Err(error) = agent_spawn::rebuild_receipts(&store.pool).await {
            store.pool.close().await;
            return Err(error);
        }
        if let Err(error) = plugin_apply::rebuild_receipts(&store.pool).await {
            store.pool.close().await;
            return Err(error);
        }
        if let Err(error) = plugin_native_target_binding::rebuild_bindings(&store.pool).await {
            store.pool.close().await;
            return Err(error);
        }
        if let Err(error) = plugin_apply::rebuild_ownership(&store.pool).await {
            store.pool.close().await;
            return Err(error);
        }
        Ok(store)
    }

    pub async fn list_agent_spawn_receipts(
        &self,
        after: Option<&OperationIdV1>,
        selector: Option<&str>,
    ) -> Result<Vec<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
        agent_spawn::list_receipts(&self.pool, after, selector).await
    }

    pub fn database_path(&self) -> &Path {
        &self.path
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn commit_agent_runtime_native_rehost(
        &self,
        request: &dure_app::AgentRuntimeNativeRehostCommitV1,
    ) -> Result<dure_app::AgentRuntimeNativeRehostCommitReceiptV1, DomainStoreErrorV1> {
        agent_runtime_rehost::commit(&self.pool, request).await
    }

    pub async fn commit_initial_agent_runtime_native_adoption(
        &self,
        source_authority: Option<&AgentCheckpointBindingAuthorityV1>,
        target_authority: &AgentCheckpointBindingAuthorityV1,
        target_selection: &dure_app::AgentRuntimeSelectionV1,
        dispatch_rebind: Option<&OrchestrationDispatchSessionRebindRequestV1>,
        target_launch_idempotency_key: &str,
        checkout: Option<&dure_app::SessionCheckoutBindingV1>,
    ) -> Result<dure_app::AgentRuntimeSelectionV1, DomainStoreErrorV1> {
        agent_runtime_rehost::commit_initial_native_adoption(
            &self.pool,
            source_authority,
            target_authority,
            target_selection,
            dispatch_rebind,
            target_launch_idempotency_key,
            checkout,
        )
        .await
    }

    pub async fn agent_runtime_native_rehost_receipt(
        &self,
        agent_id: &AgentIdV1,
    ) -> Result<Option<dure_app::AgentRuntimeNativeRehostReceiptV1>, DomainStoreErrorV1> {
        agent_runtime_rehost::receipt(&self.pool, agent_id).await
    }

    pub async fn provider_launch_defaults(
        &self,
    ) -> Result<ProviderLaunchDefaultsV1, DomainStoreErrorV1> {
        provider_launch_defaults::read(&self.pool).await
    }

    pub async fn put_provider_launch_defaults(
        &self,
        request: &ProviderLaunchDefaultsPutRequestV1,
        updated_at_ms: i64,
    ) -> Result<ProviderLaunchDefaultsPutReceiptV1, DomainStoreErrorV1> {
        provider_launch_defaults::put(&self.pool, request, updated_at_ms).await
    }

    pub async fn append_agent_spawn_plan_resolving_provider_defaults<F>(
        &self,
        draft: AgentSpawnPlanIntentDraftV1,
        event_id: OperationEventIdV1,
        recorded_at_ms: i64,
        admit: F,
    ) -> Result<AgentSpawnJournalReceiptV1, DomainStoreErrorV1>
    where
        F: FnOnce(AgentSpawnPlanV1) -> Result<AgentSpawnPlanV1, DomainStoreErrorV1>,
    {
        agent_spawn::append_planned_resolving_provider_defaults(
            &self.pool,
            draft,
            event_id,
            recorded_at_ms,
            admit,
        )
        .await
    }

    pub fn interaction_service(&self) -> agent_orchestration::service::InteractionService {
        orchestration::interaction_service(self.pool.clone())
    }

    pub async fn negotiate_orchestration_dispatch_context(
        &self,
        request: &OrchestrationDispatchContextRequestV1,
        proposal: &agent_orchestration::contract::DispatchContextReceipt,
    ) -> Result<agent_orchestration::contract::DispatchContextReceipt, DomainStoreErrorV1> {
        orchestration::negotiate_dispatch_context(&self.pool, request, proposal).await
    }

    pub async fn orchestration_dispatch_context_for_exact_session(
        &self,
        task_id: &TaskIdV1,
        dispatch_id: &DispatchIdV1,
        generation: i64,
        session: &dure_app::WorkflowSessionGenerationV1,
    ) -> Result<agent_orchestration::contract::DispatchContextReceipt, DomainStoreErrorV1> {
        orchestration::dispatch_context_for_exact_session(
            &self.pool,
            task_id,
            dispatch_id,
            generation,
            session,
        )
        .await
    }

    pub async fn orchestration_dispatch_contexts_for_exact_sessions(
        &self,
        sessions: &[dure_app::WorkflowSessionGenerationV1],
    ) -> Result<Vec<OrchestrationDispatchContextBatchItemV1>, DomainStoreErrorV1> {
        orchestration::dispatch_contexts_for_exact_sessions(&self.pool, sessions).await
    }

    pub async fn orchestration_target_for_exact_session(
        &self,
        session: &dure_app::WorkflowSessionGenerationV1,
    ) -> Result<agent_orchestration::domain::InteractionTarget, DomainStoreErrorV1> {
        orchestration::target_for_exact_session(&self.pool, session).await
    }

    pub async fn orchestration_session_for_dispatch_target(
        &self,
        task_id: &TaskIdV1,
        dispatch_id: &DispatchIdV1,
        generation: i64,
    ) -> Result<dure_app::WorkflowSessionGenerationV1, DomainStoreErrorV1> {
        orchestration::session_for_dispatch_target(&self.pool, task_id, dispatch_id, generation)
            .await
    }

    pub async fn inspect_orchestration_dispatch_session(
        &self,
        session: &dure_app::WorkflowSessionGenerationV1,
    ) -> Result<OrchestrationDispatchSessionInspectionReceiptV1, DomainStoreErrorV1> {
        orchestration::inspect_dispatch_session(&self.pool, session).await
    }

    pub async fn rebind_orchestration_dispatch_session(
        &self,
        request: &OrchestrationDispatchSessionRebindRequestV1,
        target_launch_idempotency_key: Option<&str>,
    ) -> Result<OrchestrationDispatchSessionRebindReceiptV1, DomainStoreErrorV1> {
        orchestration::rebind_dispatch_session(&self.pool, request, target_launch_idempotency_key)
            .await
    }

    pub async fn reconcile_orchestration_dispatch_session(
        &self,
        expected_agent_id: Option<&dure_app::AgentIdV1>,
        expected_runtime_kind_id: &dure_app::RuntimeKindIdV1,
        request: &OrchestrationDispatchSessionRebindRequestV1,
        exact: &OrchestrationDispatchGenerationV1,
        target_launch_idempotency_key: Option<&str>,
    ) -> Result<OrchestrationDispatchSessionRebindReceiptV1, DomainStoreErrorV1> {
        orchestration::reconcile_dispatch_session(
            &self.pool,
            expected_agent_id,
            expected_runtime_kind_id,
            request,
            exact,
            target_launch_idempotency_key,
        )
        .await
    }

    pub async fn reconcile_orchestration_dispatch_runtime_transition(
        &self,
        expected_agent_id: &dure_app::AgentIdV1,
        exact: &OrchestrationDispatchGenerationV1,
        source: &dure_app::WorkflowSessionGenerationV1,
        target: &dure_app::WorkflowSessionGenerationV1,
        reconciled_at_ms: i64,
    ) -> Result<Option<OrchestrationDispatchSessionRebindReceiptV1>, DomainStoreErrorV1> {
        agent_runtime_dispatch::reconcile_committed_transition_chain(
            &self.pool,
            expected_agent_id,
            exact,
            source,
            target,
            reconciled_at_ms,
        )
        .await
    }

    pub async fn orchestration_reporting_agent_for_exact_dispatch(
        &self,
        exact: &OrchestrationDispatchGenerationV1,
    ) -> Result<Option<dure_app::AgentIdV1>, DomainStoreErrorV1> {
        orchestration::reporting_agent_for_exact_dispatch(&self.pool, exact).await
    }

    pub async fn orchestration_dispatch_uses_managed_create_key(
        &self,
        session: &dure_app::WorkflowSessionGenerationV1,
    ) -> Result<bool, DomainStoreErrorV1> {
        orchestration::dispatch_uses_managed_create_key(&self.pool, session).await
    }

    pub async fn exact_orchestration_dispatch_managed_create_key_state(
        &self,
        exact: &OrchestrationDispatchGenerationV1,
        session: &dure_app::WorkflowSessionGenerationV1,
        expected_runtime_kind_id: &dure_app::RuntimeKindIdV1,
    ) -> Result<OrchestrationManagedCreateKeyStateV1, DomainStoreErrorV1> {
        orchestration::exact_dispatch_managed_create_key_state(
            &self.pool,
            exact,
            session,
            expected_runtime_kind_id,
        )
        .await
    }

    pub async fn repair_workflow_effective_launch(
        &self,
        request: &WorkflowEffectiveLaunchRepairRequestV1,
    ) -> Result<(), DomainStoreErrorV1> {
        workflow::repair_effective_launch(&self.pool, request).await
    }

    pub async fn repair_orchestration_workflow_effective_launch(
        &self,
        request: &WorkflowEffectiveLaunchRepairRequestV1,
        expected_runtime_kind_id: &dure_app::RuntimeKindIdV1,
    ) -> Result<(), DomainStoreErrorV1> {
        workflow::repair_effective_launch_for_runtime(
            &self.pool,
            request,
            Some(expected_runtime_kind_id),
        )
        .await
    }

    pub async fn orchestration_run_authority_for_exact_session(
        &self,
        session: &dure_app::WorkflowSessionGenerationV1,
    ) -> Result<ExistingSessionRunAuthority, DomainStoreErrorV1> {
        orchestration::run_authority_for_exact_session(&self.pool, session).await
    }
}

impl AgentSpawnJournalStore for SqliteDomainStore {
    fn append_agent_spawn_event<'a>(
        &'a self,
        event: &'a AgentSpawnJournalEventV1,
    ) -> DomainStoreFuture<'a, AgentSpawnJournalReceiptV1> {
        Box::pin(agent_spawn::append_event(&self.pool, event))
    }

    fn agent_spawn_receipt<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentSpawnJournalReceiptV1>> {
        Box::pin(agent_spawn::receipt(&self.pool, operation_id))
    }

    fn agent_spawn_receipt_by_idempotency_key<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<AgentSpawnJournalReceiptV1>> {
        Box::pin(agent_spawn::receipt_by_idempotency_key(
            &self.pool,
            idempotency_key,
        ))
    }

    fn agent_spawn_receipt_by_agent_id<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentSpawnJournalReceiptV1>> {
        Box::pin(agent_spawn::receipt_by_agent_id(&self.pool, agent_id))
    }

    fn rebuild_agent_spawn_receipts(&self) -> DomainStoreFuture<'_, usize> {
        Box::pin(agent_spawn::rebuild_receipts(&self.pool))
    }
}

impl AgentDispatchStopStore for SqliteDomainStore {
    fn plan_agent_dispatch_stop<'a>(
        &'a self,
        plan: &'a dure_app::AgentDispatchStopPlanV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentDispatchStopRecordV1> {
        Box::pin(agent_dispatch_stop::plan(&self.pool, plan))
    }

    fn authorize_agent_dispatch_stop<'a>(
        &'a self,
        request: &'a dure_app::AgentDispatchStopAuthorizeRequestV1,
    ) -> DomainStoreFuture<
        'a,
        (
            dure_app::AgentDispatchStopRecordV1,
            dure_app::AgentRuntimeCloseRecordV1,
        ),
    > {
        Box::pin(agent_dispatch_stop::authorize(&self.pool, request))
    }

    fn terminalize_agent_dispatch_stop<'a>(
        &'a self,
        request: &'a dure_app::AgentDispatchStopTerminalRequestV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentDispatchStopRecordV1> {
        Box::pin(agent_dispatch_stop::terminalize(&self.pool, request))
    }

    fn agent_dispatch_stop<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentDispatchStopRecordV1>> {
        Box::pin(agent_dispatch_stop::stop(&self.pool, operation_id))
    }

    fn agent_dispatch_stop_for_spawn_operation<'a>(
        &'a self,
        spawn_operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentDispatchStopRecordV1>> {
        Box::pin(agent_dispatch_stop::stop_for_spawn_operation(
            &self.pool,
            spawn_operation_id,
        ))
    }

    fn active_agent_dispatch_stop<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentDispatchStopRecordV1>> {
        Box::pin(agent_dispatch_stop::active_stop(&self.pool, agent_id))
    }

    fn agent_dispatch_stop_recovery_candidates(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>> {
        Box::pin(agent_dispatch_stop::recovery_candidates(&self.pool))
    }
}

impl AgentTimelineStore for SqliteDomainStore {
    fn create_agent_interaction<'a>(
        &'a self,
        binding: &'a dure_app::AgentInteractionBindingV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentInteractionBindingV1> {
        Box::pin(agent_timeline::create(&self.pool, binding))
    }

    fn agent_interaction<'a>(
        &'a self,
        interaction_session_id: &'a dure_app::AgentInteractionSessionIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentInteractionBindingV1>> {
        Box::pin(agent_timeline::binding(&self.pool, interaction_session_id))
    }

    fn agent_interaction_for_agent<'a>(
        &'a self,
        agent_id: &'a dure_app::AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentInteractionBindingV1>> {
        Box::pin(agent_timeline::binding_for_agent(&self.pool, agent_id))
    }

    fn replace_agent_interaction_runtime<'a>(
        &'a self,
        replacement: &'a dure_app::AgentRuntimeReplacementV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentInteractionBindingV1> {
        Box::pin(agent_timeline::replace_runtime(&self.pool, replacement))
    }

    fn agent_provider_cursor<'a>(
        &'a self,
        interaction_session_id: &'a dure_app::AgentInteractionSessionIdV1,
        runtime: &'a dure_app::AgentProviderRuntimeFenceV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentProviderCursorV1> {
        Box::pin(agent_timeline::provider_cursor(
            &self.pool,
            interaction_session_id,
            runtime,
        ))
    }

    fn apply_agent_provider_event<'a>(
        &'a self,
        event: &'a dure_app::AgentProviderEventCommitV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentTimelineCommitReceiptV1> {
        Box::pin(agent_timeline::apply_provider_event(&self.pool, event))
    }

    fn record_agent_provider_gap<'a>(
        &'a self,
        gap: &'a dure_app::AgentProviderGapV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentTimelineCommitReceiptV1> {
        Box::pin(agent_timeline::record_provider_gap(&self.pool, gap))
    }

    fn agent_history_hydration_authority<'a>(
        &'a self,
        interaction_session_id: &'a dure_app::AgentInteractionSessionIdV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentHistoryHydrationAuthorityV1> {
        Box::pin(agent_timeline::history_hydration_authority(
            &self.pool,
            interaction_session_id,
        ))
    }

    fn reconcile_agent_history<'a>(
        &'a self,
        snapshot: &'a dure_app::AgentHistorySnapshotV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentHistorySnapshotReceiptV1> {
        Box::pin(agent_timeline::reconcile_history(&self.pool, snapshot))
    }

    fn reconcile_agent_pending_snapshot<'a>(
        &'a self,
        snapshot: &'a dure_app::AgentPendingSnapshotV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentTimelineCommitReceiptV1> {
        Box::pin(agent_timeline::reconcile_pending_snapshot(
            &self.pool, snapshot,
        ))
    }

    fn record_agent_turn_intent<'a>(
        &'a self,
        intent: &'a dure_app::AgentStartTurnIntentV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentTurnEffectReceiptV1> {
        Box::pin(agent_timeline::record_turn_intent(&self.pool, intent))
    }

    fn prepare_agent_continuation_turn<'a>(
        &'a self,
        request: &'a dure_app::AgentContinueTurnRequestV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentTurnEffectReceiptV1>> {
        Box::pin(agent_timeline::prepare_continuation_turn(&self.pool, request))
    }

    fn record_agent_steer_intent<'a>(
        &'a self,
        intent: &'a dure_app::AgentStartTurnIntentV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentTurnEffectReceiptV1> {
        Box::pin(agent_timeline::record_steer_intent(&self.pool, intent))
    }

    fn complete_agent_turn_effect<'a>(
        &'a self,
        completion: &'a dure_app::AgentCompleteTurnEffectV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentTurnEffectReceiptV1> {
        Box::pin(agent_timeline::complete_turn_effect(&self.pool, completion))
    }

    fn prepare_agent_pending_answer<'a>(
        &'a self,
        intent: &'a dure_app::AgentPendingAnswerIntentV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentPendingAnswerReceiptV1> {
        Box::pin(agent_timeline::prepare_pending_answer(&self.pool, intent))
    }

    fn complete_agent_pending_answer<'a>(
        &'a self,
        completion: &'a dure_app::AgentCompletePendingAnswerV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentPendingAnswerReceiptV1> {
        Box::pin(agent_timeline::complete_pending_answer(
            &self.pool, completion,
        ))
    }

    fn read_agent_timeline<'a>(
        &'a self,
        request: &'a dure_app::AgentTimelineReadRequestV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentTimelineReadV1> {
        Box::pin(agent_timeline::read(&self.pool, request))
    }
}

impl ProviderCredentialProfileStore for SqliteDomainStore {
    fn provider_credential_profiles<'a>(
        &'a self,
        provider_id: &'a dure_app::ProviderIdV1,
    ) -> DomainStoreFuture<'a, Vec<dure_app::ProviderCredentialProfileV1>> {
        Box::pin(provider_credential_profiles::profiles(&self.pool, provider_id))
    }

    fn register_provider_credential_profile<'a>(
        &'a self,
        expected_credential_generation: Option<&'a str>,
        registration: &'a ProviderCredentialProfileRegistrationV1,
    ) -> DomainStoreFuture<'a, ProviderCredentialProfileRegistrationV1> {
        Box::pin(provider_credential_profiles::register(
            &self.pool,
            expected_credential_generation,
            registration,
        ))
    }

    fn provider_credential_profile<'a>(
        &'a self,
        provider_id: &'a dure_app::ProviderIdV1,
        reference_id: &'a str,
    ) -> DomainStoreFuture<'a, Option<ProviderCredentialProfileRegistrationV1>> {
        Box::pin(provider_credential_profiles::profile(
            &self.pool,
            provider_id,
            reference_id,
        ))
    }

    fn provider_credential_profile_for_launch_reference<'a>(
        &'a self,
        provider_id: &'a dure_app::ProviderIdV1,
        launch_reference: &'a str,
    ) -> DomainStoreFuture<'a, Option<ProviderCredentialProfileRegistrationV1>> {
        Box::pin(provider_credential_profiles::profile_for_launch_reference(
            &self.pool,
            provider_id,
            launch_reference,
        ))
    }
}

impl DomainStore for SqliteDomainStore {
    fn schema_info(&self) -> &StoreSchemaInfoV1 {
        &self.schema_info
    }

    fn upsert_project<'a>(&'a self, record: &'a ProjectRecordV1) -> DomainStoreFuture<'a, ()> {
        Box::pin(records::upsert_project(&self.pool, record))
    }

    fn project<'a>(
        &'a self,
        project_id: &'a ProjectIdV1,
    ) -> DomainStoreFuture<'a, Option<ProjectRecordV1>> {
        Box::pin(records::project(&self.pool, project_id))
    }

    fn upsert_workspace<'a>(&'a self, record: &'a WorkspaceRecordV1) -> DomainStoreFuture<'a, ()> {
        Box::pin(records::upsert_workspace(&self.pool, record))
    }

    fn workspace<'a>(
        &'a self,
        workspace_id: &'a WorkspaceIdV1,
    ) -> DomainStoreFuture<'a, Option<WorkspaceRecordV1>> {
        Box::pin(records::workspace(&self.pool, workspace_id))
    }

    fn upsert_agent<'a>(&'a self, record: &'a AgentRecordV1) -> DomainStoreFuture<'a, ()> {
        Box::pin(records::upsert_agent(&self.pool, record))
    }

    fn agent<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRecordV1>> {
        Box::pin(records::agent(&self.pool, agent_id))
    }

    fn upsert_session_binding<'a>(
        &'a self,
        record: &'a SessionBindingRecordV1,
    ) -> DomainStoreFuture<'a, ()> {
        Box::pin(records::upsert_session_binding(&self.pool, record))
    }

    fn session_binding<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<SessionBindingRecordV1>> {
        Box::pin(records::session_binding(&self.pool, agent_id))
    }

    fn upsert_agent_checkpoint_binding_authority<'a>(
        &'a self,
        record: &'a AgentCheckpointBindingAuthorityV1,
    ) -> DomainStoreFuture<'a, ()> {
        Box::pin(checkpoint_bindings::upsert(&self.pool, record))
    }

    fn agent_checkpoint_binding_authority<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentCheckpointBindingAuthorityV1>> {
        Box::pin(checkpoint_bindings::get(&self.pool, agent_id))
    }

    fn converge_agent_checkpoint_provider_conversation<'a>(
        &'a self,
        expected: &'a AgentCheckpointBindingAuthorityV1,
        provider_conversation_id: &'a str,
    ) -> DomainStoreFuture<'a, AgentCheckpointBindingAuthorityV1> {
        Box::pin(checkpoint_bindings::converge_provider_conversation(
            &self.pool,
            expected,
            provider_conversation_id,
        ))
    }

    fn agent_checkpoint_observations<'a>(
        &'a self,
        agent_ids: &'a [AgentIdV1],
    ) -> DomainStoreFuture<'a, Vec<AgentCheckpointObservationV1>> {
        Box::pin(checkpoint_bindings::observations(&self.pool, agent_ids))
    }

    fn agent_checkpoint<'a>(
        &'a self,
        identity: &'a AgentCheckpointIdentityV1,
    ) -> DomainStoreFuture<'a, Option<AgentCheckpointRecordV1>> {
        Box::pin(checkpoints::checkpoint(&self.pool, identity))
    }

    fn write_agent_checkpoint<'a>(
        &'a self,
        request: &'a AgentCheckpointWriteRequestV1,
    ) -> DomainStoreFuture<'a, AgentCheckpointWriteReceiptV1> {
        Box::pin(checkpoints::write_checkpoint(&self.pool, request))
    }

    fn client_view_authority<'a>(
        &'a self,
        namespace: &'a ClientViewNamespaceV1,
    ) -> DomainStoreFuture<'a, Option<ClientViewAuthorityV1>> {
        Box::pin(client_views::authority(&self.pool, namespace))
    }

    fn advance_client_view_generation<'a>(
        &'a self,
        request: &'a ClientViewGenerationAdvanceRequestV1,
    ) -> DomainStoreFuture<'a, ClientViewGenerationReceiptV1> {
        Box::pin(client_views::advance_generation(&self.pool, request))
    }

    fn client_view<'a>(
        &'a self,
        identity: &'a ClientViewIdentityV1,
    ) -> DomainStoreFuture<'a, Option<ClientViewRecordV1>> {
        Box::pin(client_views::view(&self.pool, identity))
    }

    fn write_client_view<'a>(
        &'a self,
        request: &'a ClientViewWriteRequestV1,
    ) -> DomainStoreFuture<'a, ClientViewWriteReceiptV1> {
        Box::pin(client_views::write_view(&self.pool, request))
    }

    fn create_review_target<'a>(
        &'a self,
        record: &'a ReviewTargetRecordV1,
    ) -> DomainStoreFuture<'a, ()> {
        Box::pin(records::create_review_target(&self.pool, record))
    }

    fn review_target<'a>(
        &'a self,
        review_id: &'a ReviewIdV1,
    ) -> DomainStoreFuture<'a, Option<ReviewTargetRecordV1>> {
        Box::pin(records::review_target(&self.pool, review_id))
    }

    fn reconcile_review_target_roots<'a>(
        &'a self,
        snapshot: &'a ReviewTargetRootSnapshotV1,
        policy: &'a ReviewTargetRetentionPolicyV1,
    ) -> DomainStoreFuture<'a, ReviewTargetSweepReceiptV1> {
        Box::pin(records::reconcile_review_target_roots(
            &self.pool, snapshot, policy,
        ))
    }

    fn append_operation_event<'a>(
        &'a self,
        event: &'a OperationEventV1,
    ) -> DomainStoreFuture<'a, OperationReceiptV1> {
        Box::pin(operations::append_event(&self.pool, event))
    }

    fn operation_receipt<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<OperationReceiptV1>> {
        Box::pin(operations::operation_receipt(&self.pool, operation_id))
    }

    fn rebuild_operation_receipts(&self) -> DomainStoreFuture<'_, usize> {
        Box::pin(operations::rebuild_receipts(&self.pool))
    }
}

impl PluginApplyJournalStore for SqliteDomainStore {
    fn append_plugin_apply_event<'a>(
        &'a self,
        event: &'a PluginApplyJournalEventV2,
    ) -> DomainStoreFuture<'a, PluginApplyJournalReceiptV2> {
        Box::pin(plugin_apply::append_event(&self.pool, event))
    }

    fn plugin_apply_receipt<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<PluginApplyJournalReceiptV2>> {
        Box::pin(plugin_apply::receipt(&self.pool, operation_id))
    }

    fn plugin_native_ownership<'a>(
        &'a self,
        ownership_key: &'a PluginNativeOwnershipKeyV2,
    ) -> DomainStoreFuture<'a, Option<PluginNativeOwnershipReceiptV2>> {
        Box::pin(plugin_apply::ownership(&self.pool, ownership_key))
    }

    fn rebuild_plugin_apply_receipts(&self) -> DomainStoreFuture<'_, usize> {
        Box::pin(plugin_apply::rebuild_receipts(&self.pool))
    }

    fn rebuild_plugin_native_ownership(&self) -> DomainStoreFuture<'_, usize> {
        Box::pin(plugin_apply::rebuild_ownership(&self.pool))
    }
}

impl PluginNativeApplyAuthorityStore for SqliteDomainStore {
    fn validate_plugin_native_target_bindings<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
        bindings: &'a [PluginNativePhysicalTargetBindingV2],
    ) -> DomainStoreFuture<'a, ()> {
        Box::pin(plugin_native_target_binding::validate_operation_bindings(
            &self.pool,
            operation_id,
            bindings,
        ))
    }

    fn rebuild_plugin_native_target_bindings(&self) -> DomainStoreFuture<'_, usize> {
        Box::pin(plugin_native_target_binding::rebuild_bindings(&self.pool))
    }
}

impl WorkflowStore for SqliteDomainStore {
    fn prepare_delegate_once_launch<'a>(
        &'a self,
        request: &'a DelegateOnceRequestV1,
        launch: &'a dure_app::WorkflowSessionLaunchRequestV1,
    ) -> DomainStoreFuture<'a, dure_app::WorkflowSessionLaunchRequestV1> {
        Box::pin(workflow::launch::prepare(&self.pool, request, launch))
    }

    fn delegate_once_launch<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<dure_app::WorkflowSessionLaunchRequestV1>> {
        Box::pin(workflow::launch::read(&self.pool, idempotency_key))
    }

    fn create_delegate_once<'a>(
        &'a self,
        request: &'a DelegateOnceRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1> {
        Box::pin(workflow::create(&self.pool, request))
    }

    fn delegate_once_receipt<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<DelegateOnceReceiptV1>> {
        Box::pin(workflow::receipt(&self.pool, idempotency_key))
    }

    fn delegate_once_receipt_for_dispatch<'a>(
        &'a self,
        task_id: &'a TaskIdV1,
        dispatch_id: &'a DispatchIdV1,
        generation: i64,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1> {
        Box::pin(workflow::receipt_for_exact_dispatch(
            &self.pool,
            task_id,
            dispatch_id,
            generation,
        ))
    }

    fn bind_delegate_once_session<'a>(
        &'a self,
        request: &'a DelegateOnceSessionBindingRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1> {
        Box::pin(workflow::bind_session(&self.pool, request))
    }

    fn fail_delegate_once_start<'a>(
        &'a self,
        request: &'a DelegateOnceStartFailureRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1> {
        Box::pin(workflow::fail_start(&self.pool, request))
    }

    fn claim_delegate_once_prompt<'a>(
        &'a self,
        request: &'a DelegateOncePromptClaimRequestV1,
    ) -> DomainStoreFuture<'a, WorkflowPromptDeliveryClaimV1> {
        Box::pin(workflow::claim_prompt(&self.pool, request))
    }

    fn record_delegate_once_prompt_outcome<'a>(
        &'a self,
        request: &'a DelegateOncePromptOutcomeRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1> {
        Box::pin(workflow::record_prompt_outcome(&self.pool, request))
    }

    fn record_delegate_once_prompt_activity<'a>(
        &'a self,
        request: &'a DelegateOncePromptActivityRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1> {
        Box::pin(workflow::record_prompt_activity(&self.pool, request))
    }
}

#[cfg(test)]
mod agent_dispatch_stop_tests;
#[cfg(test)]
mod agent_runtime_close_tests;
#[cfg(test)]
mod agent_runtime_transition_tests;
#[cfg(test)]
mod agent_spawn_tests;
#[cfg(test)]
mod agent_timeline_tests;
#[cfg(test)]
mod checkpoint_tests;
#[cfg(test)]
mod migration_test_support;
#[cfg(test)]
mod provider_credential_profiles_tests;
#[cfg(test)]
mod provider_recovery_tests;
#[cfg(test)]
mod provider_launch_defaults_tests;

#[cfg(test)]
mod client_view_tests;
#[cfg(test)]
mod plugin_apply_tests;
#[cfg(test)]
mod schedule_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod workflow_tests;
