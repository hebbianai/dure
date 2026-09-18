use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AgentCompletePendingAnswerV1, AgentCompleteTurnEffectV1, AgentHistoryHydrationAuthorityV1,
    AgentHistorySnapshotReceiptV1, AgentHistorySnapshotV1, AgentInteractionBindingV1,
    AgentInteractionSessionIdV1, AgentInterruptTurnReceiptV1, AgentInterruptTurnRequestV1,
    AgentPendingAnswerIntentV1, AgentPendingAnswerReceiptV1, AgentPendingAnswerStateV1,
    AgentPendingRequestV1, AgentPendingSnapshotV1, AgentProviderCursorV1,
    AgentProviderEventCommitV1, AgentProviderGapV1, AgentProviderRuntimeFenceV1,
    AgentRuntimeReplacementV1, AgentStartTurnIntentV1, AgentTimelineCommitReceiptV1,
    AgentTimelineCursorV1, AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTimelineStore, AgentTurnEffectReceiptV1, AgentTurnEffectStateV1,
    DomainStoreErrorV1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::broadcast;

pub(crate) mod continuation;

const SUBSCRIPTION_CAPACITY: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProviderCommandErrorV1 {
    pub code: String,
    pub detail: String,
}

impl AgentProviderCommandErrorV1 {
    pub fn new(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: bounded_provider_diagnostic(code.into(), 256),
            detail: bounded_provider_diagnostic(detail.into(), 8192),
        }
    }

    fn receipt(&self) -> Value {
        json!({ "errorCode": self.code, "errorDetail": self.detail })
    }
}

// Bound provider diagnostics once, before either the response or durable JSON
// receipt consumes them. Even maximally escaped text fits the receipt budget.
fn bounded_provider_diagnostic(mut value: String, max_chars: usize) -> String {
    if let Some((boundary, _)) = value.char_indices().nth(max_chars) {
        value.truncate(boundary);
        value.push('…');
    }
    value
}

impl std::fmt::Display for AgentProviderCommandErrorV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "provider command {}: {}", self.code, self.detail)
    }
}

impl std::error::Error for AgentProviderCommandErrorV1 {}

pub type AgentProviderCommandFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Value, AgentProviderCommandErrorV1>> + Send + 'a>>;

/// Provider-private command adapter. Event translation travels in the opposite
/// direction through `commit_provider_event`; the common service never branches
/// on provider identity.
pub trait AgentProviderCommands: Send + Sync {
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a>;

    /// Delivers one user message into the RUNNING turn, applied by the
    /// provider at its next tool boundary. Providers without a mid-turn
    /// channel keep the default refusal and clients fall back to queueing.
    fn steer_turn<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
        _intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async {
            Err(AgentProviderCommandErrorV1::new(
                "steer_unsupported",
                "this provider cannot accept mid-turn input",
            ))
        })
    }

    fn answer_pending<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentPendingAnswerIntentV1,
        request: &'a AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a>;

    fn interrupt_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        request: &'a AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a>;
}

#[derive(Debug)]
pub enum AgentConversationErrorV1 {
    Store(DomainStoreErrorV1),
    Provider(AgentProviderCommandErrorV1),
    Clock,
}

impl std::fmt::Display for AgentConversationErrorV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => error.fmt(formatter),
            Self::Provider(error) => error.fmt(formatter),
            Self::Clock => formatter.write_str("system clock is before the Unix epoch"),
        }
    }
}

impl std::error::Error for AgentConversationErrorV1 {}

impl From<DomainStoreErrorV1> for AgentConversationErrorV1 {
    fn from(error: DomainStoreErrorV1) -> Self {
        Self::Store(error)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentConversationNotificationKindV1 {
    Timeline,
    LiveText,
    PendingRequests,
    HistoryGap,
    Runtime,
    Goal,
    Recovery,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConversationNotificationV1 {
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub timeline_cursor: AgentTimelineCursorV1,
    pub kinds: Vec<AgentConversationNotificationKindV1>,
}

/// Detached provider-neutral conversation authority. Broadcast messages are
/// invalidation hints only; reconnect always fetches the durable store first.
pub struct AgentConversationService<S> {
    store: Arc<S>,
    notifications: broadcast::Sender<AgentConversationNotificationV1>,
    backend_home: Option<std::path::PathBuf>,
}

impl<S> AgentConversationService<S>
where
    S: AgentTimelineStore + 'static,
{
    pub fn new(store: Arc<S>) -> Self {
        let (notifications, _) = broadcast::channel(SUBSCRIPTION_CAPACITY);
        Self {
            store,
            notifications,
            backend_home: None,
        }
    }

    pub(crate) fn with_backend_home(mut self, home: impl Into<std::path::PathBuf>) -> Self {
        self.backend_home = Some(home.into());
        self
    }

    pub(crate) fn backend_home(&self) -> Option<&std::path::Path> {
        self.backend_home.as_deref()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentConversationNotificationV1> {
        self.notifications.subscribe()
    }

    pub async fn create(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<AgentInteractionBindingV1, AgentConversationErrorV1> {
        Ok(self.store.create_agent_interaction(binding).await?)
    }

    pub async fn binding(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
    ) -> Result<Option<AgentInteractionBindingV1>, AgentConversationErrorV1> {
        Ok(self.store.agent_interaction(interaction_session_id).await?)
    }

    pub async fn binding_for_agent(
        &self,
        agent_id: &dure_app::AgentIdV1,
    ) -> Result<Option<AgentInteractionBindingV1>, AgentConversationErrorV1> {
        Ok(self.store.agent_interaction_for_agent(agent_id).await?)
    }

    pub async fn replace_runtime(
        &self,
        replacement: &AgentRuntimeReplacementV1,
    ) -> Result<AgentInteractionBindingV1, AgentConversationErrorV1> {
        let binding = self
            .store
            .replace_agent_interaction_runtime(replacement)
            .await?;
        let read = self
            .store
            .read_agent_timeline(&AgentTimelineReadRequestV1 {
                schema_version: replacement.schema_version,
                interaction_session_id: replacement.interaction_session_id.clone(),
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: 1,
            })
            .await?;
        let cursor = match read {
            AgentTimelineReadV1::Page { page } => page.final_cursor,
            AgentTimelineReadV1::Reset { .. } => {
                return Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "agent_interaction_runtime",
                    id: replacement.interaction_session_id.to_string(),
                    reason: "runtime replacement did not converge to the current timeline".into(),
                }
                .into());
            }
        };
        self.publish_after_commit(
            replacement.interaction_session_id.clone(),
            cursor,
            vec![
                AgentConversationNotificationKindV1::Timeline,
                AgentConversationNotificationKindV1::LiveText,
                AgentConversationNotificationKindV1::PendingRequests,
            ],
        );
        Ok(binding)
    }

    pub async fn read(
        &self,
        request: &AgentTimelineReadRequestV1,
    ) -> Result<AgentTimelineReadV1, AgentConversationErrorV1> {
        Ok(self.store.read_agent_timeline(request).await?)
    }

    pub async fn provider_cursor(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        runtime: &AgentProviderRuntimeFenceV1,
    ) -> Result<AgentProviderCursorV1, AgentConversationErrorV1> {
        Ok(self
            .store
            .agent_provider_cursor(interaction_session_id, runtime)
            .await?)
    }

    pub async fn commit_provider_event(
        &self,
        event: &AgentProviderEventCommitV1,
    ) -> Result<AgentTimelineCommitReceiptV1, AgentConversationErrorV1> {
        let receipt = self.store.apply_agent_provider_event(event).await?;
        let mut kinds = Vec::new();
        if receipt.timeline_changed {
            kinds.push(AgentConversationNotificationKindV1::Timeline);
        }
        if receipt.live_text_changed {
            kinds.push(AgentConversationNotificationKindV1::LiveText);
        }
        if receipt.pending_changed {
            kinds.push(AgentConversationNotificationKindV1::PendingRequests);
        }
        self.publish_after_commit(
            event.interaction_session_id.clone(),
            receipt.timeline_cursor.clone(),
            kinds,
        );
        Ok(receipt)
    }

    pub async fn record_provider_gap(
        &self,
        gap: &AgentProviderGapV1,
    ) -> Result<AgentTimelineCommitReceiptV1, AgentConversationErrorV1> {
        let receipt = self.store.record_agent_provider_gap(gap).await?;
        if !receipt.duplicate {
            self.publish_after_commit(
                gap.interaction_session_id.clone(),
                receipt.timeline_cursor.clone(),
                vec![
                    AgentConversationNotificationKindV1::HistoryGap,
                    AgentConversationNotificationKindV1::Timeline,
                ],
            );
        }
        Ok(receipt)
    }

    pub async fn reconcile_history(
        &self,
        snapshot: &AgentHistorySnapshotV1,
    ) -> Result<AgentHistorySnapshotReceiptV1, AgentConversationErrorV1> {
        let receipt = self.store.reconcile_agent_history(snapshot).await?;
        if receipt.newly_completed {
            self.publish_after_commit(
                snapshot.binding.interaction_session_id.clone(),
                receipt.timeline_cursor.clone(),
                vec![AgentConversationNotificationKindV1::Timeline],
            );
        }
        Ok(receipt)
    }

    pub async fn history_hydration_authority(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
    ) -> Result<AgentHistoryHydrationAuthorityV1, AgentConversationErrorV1> {
        self.store
            .agent_history_hydration_authority(interaction_session_id)
            .await
            .map_err(Into::into)
    }

    pub async fn reconcile_pending_snapshot(
        &self,
        snapshot: &AgentPendingSnapshotV1,
    ) -> Result<AgentTimelineCommitReceiptV1, AgentConversationErrorV1> {
        let receipt = self
            .store
            .reconcile_agent_pending_snapshot(snapshot)
            .await?;
        if receipt.pending_changed {
            self.publish_after_commit(
                snapshot.interaction_session_id.clone(),
                receipt.timeline_cursor.clone(),
                vec![AgentConversationNotificationKindV1::PendingRequests],
            );
        }
        Ok(receipt)
    }

    pub async fn invalidate_runtime(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<(), AgentConversationErrorV1> {
        let read = self
            .store
            .read_agent_timeline(&AgentTimelineReadRequestV1 {
                schema_version: dure_app::AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: binding.interaction_session_id.clone(),
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: 1,
            })
            .await?;
        let AgentTimelineReadV1::Page { page } = read else {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "agent_interaction_runtime",
                id: binding.interaction_session_id.to_string(),
                reason: "runtime invalidation did not resolve the current timeline".into(),
            }
            .into());
        };
        if !page.binding.same_runtime_authority(binding) {
            return Ok(());
        }
        self.publish_after_commit(
            binding.interaction_session_id.clone(),
            page.final_cursor,
            vec![AgentConversationNotificationKindV1::Runtime],
        );
        Ok(())
    }

    pub async fn start_turn<P>(
        &self,
        provider: &P,
        intent: &AgentStartTurnIntentV1,
    ) -> Result<AgentTurnEffectReceiptV1, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
    {
        let prepared = self.store.record_agent_turn_intent(intent).await?;
        self.execute_prepared_start(provider, intent, prepared)
            .await
    }

    pub async fn continue_turn<P>(
        &self,
        provider: &P,
        request: &dure_app::AgentContinueTurnRequestV1,
    ) -> Result<Option<AgentTurnEffectReceiptV1>, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
    {
        let Some(prepared) = self.store.prepare_agent_continuation_turn(request).await? else {
            return Ok(None);
        };
        self.execute_prepared_start(provider, &request.intent, prepared)
            .await
            .map(Some)
    }

    pub(crate) async fn enqueue_turn(
        &self,
        intent: &AgentStartTurnIntentV1,
    ) -> Result<dure_app::AgentQueuedTurnRecordV1, AgentConversationErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        let receipt = self.store.enqueue_agent_turn(intent).await?;
        self.publish_after_commit(
            intent.interaction_session_id.clone(),
            receipt.timeline_cursor.clone(),
            vec![AgentConversationNotificationKindV1::Timeline],
        );
        Ok(receipt)
    }

    pub(crate) async fn inspect_input(
        &self,
        request: &dure_app::AgentInputReadRequestV1,
    ) -> Result<Option<dure_app::AgentInputReceiptV1>, AgentConversationErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        Ok(self
            .store
            .inspect_agent_input(&request.interaction_session_id, &request.client_message_id)
            .await?)
    }

    pub(crate) async fn read_queue(
        &self,
        request: &dure_app::AgentQueueReadRequestV1,
    ) -> Result<dure_app::AgentQueuedInputPageV1, AgentConversationErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        Ok(self
            .store
            .read_queued_agent_turns(&request.interaction_session_id, request.after_sequence)
            .await?)
    }

    pub(crate) async fn cancel_queued_turn(
        &self,
        request: &dure_app::AgentCancelQueuedTurnV1,
    ) -> Result<dure_app::AgentQueuedTurnRecordV1, AgentConversationErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        let receipt = self
            .store
            .cancel_queued_agent_turn(request, now_ms()?)
            .await?;
        self.publish_after_commit(
            request.interaction_session_id.clone(),
            receipt.timeline_cursor.clone(),
            vec![AgentConversationNotificationKindV1::Timeline],
        );
        Ok(receipt)
    }

    pub(crate) async fn start_queued_turn<P>(
        &self,
        provider: &P,
        binding: &AgentInteractionBindingV1,
    ) -> Result<Option<AgentTurnEffectReceiptV1>, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
        S: dure_app::AgentQueuedTurnStore,
    {
        let Some(prepared) = self
            .store
            .prepare_queued_agent_turn(&binding.interaction_session_id, &binding.runtime, now_ms()?)
            .await?
        else {
            return Ok(None);
        };
        self.execute_prepared_start(provider, &prepared.intent.clone(), prepared)
            .await
            .map(Some)
    }

    pub(crate) async fn start_goal_turn<P>(
        &self,
        provider: &P,
        request: &dure_app::AgentGoalTurnRequestV1,
    ) -> Result<Option<AgentTurnEffectReceiptV1>, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
        S: dure_app::AgentGoalStore,
    {
        let Some(prepared) = self.store.prepare_agent_goal_turn(request).await? else {
            self.publish_goal_change(&request.agent_id).await?;
            return Ok(None);
        };
        self.execute_prepared_start(provider, &request.intent, prepared)
            .await
            .map(Some)
    }

    pub(crate) async fn start_recovery_turn<P>(
        &self,
        provider: &P,
        attempt_id: &str,
    ) -> Result<Option<AgentTurnEffectReceiptV1>, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
        S: dure_app::AgentRecoveryStore,
    {
        let Some(prepared) = self.store
            .prepare_agent_recovery_turn(attempt_id, now_ms()?).await? else {
            return Ok(None);
        };
        self.execute_prepared_start(provider, &prepared.intent.clone(), prepared)
            .await
            .map(Some)
    }

    async fn execute_prepared_start<P>(
        &self,
        provider: &P,
        intent: &AgentStartTurnIntentV1,
        prepared: AgentTurnEffectReceiptV1,
    ) -> Result<AgentTurnEffectReceiptV1, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
    {
        if prepared.newly_prepared {
            self.publish_after_commit(
                intent.interaction_session_id.clone(),
                prepared.timeline_cursor.clone(),
                vec![AgentConversationNotificationKindV1::Timeline],
            );
        } else {
            return Ok(prepared);
        }
        let binding = self
            .exact_binding(&intent.interaction_session_id, &intent.runtime)
            .await?;
        match provider.start_turn(&binding, intent).await {
            Ok(provider_receipt) => Ok(self
                .store
                .complete_agent_turn_effect(&AgentCompleteTurnEffectV1 {
                    schema_version: intent.schema_version,
                    interaction_session_id: intent.interaction_session_id.clone(),
                    runtime: intent.runtime.clone(),
                    client_message_id: intent.client_message_id.clone(),
                    state: AgentTurnEffectStateV1::Accepted,
                    provider_receipt: Some(provider_receipt),
                    updated_at_ms: now_ms()?,
                })
                .await?),
            Err(error) => {
                let failed = self
                    .store
                    .complete_agent_turn_effect(&AgentCompleteTurnEffectV1 {
                        schema_version: intent.schema_version,
                        interaction_session_id: intent.interaction_session_id.clone(),
                        runtime: intent.runtime.clone(),
                        client_message_id: intent.client_message_id.clone(),
                        state: AgentTurnEffectStateV1::Failed,
                        provider_receipt: Some(error.receipt()),
                        updated_at_ms: now_ms()?,
                    })
                    .await?;
                self.publish_after_commit(
                    intent.interaction_session_id.clone(),
                    failed.timeline_cursor,
                    vec![AgentConversationNotificationKindV1::Timeline],
                );
                Err(AgentConversationErrorV1::Provider(error))
            }
        }
    }

    /// Mid-turn steering: journal the user row into the running turn, then
    /// hand the message to the provider, which applies it at its next tool
    /// boundary. Same durable effect machinery as start_turn.
    pub async fn steer_turn<P>(
        &self,
        provider: &P,
        intent: &AgentStartTurnIntentV1,
    ) -> Result<AgentTurnEffectReceiptV1, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
    {
        let prepared = self.store.record_agent_steer_intent(intent).await?;
        if prepared.newly_prepared {
            self.publish_after_commit(
                intent.interaction_session_id.clone(),
                prepared.timeline_cursor.clone(),
                vec![AgentConversationNotificationKindV1::Timeline],
            );
        } else {
            return Ok(prepared);
        }
        let binding = self
            .exact_binding(&intent.interaction_session_id, &intent.runtime)
            .await?;
        match provider.steer_turn(&binding, intent).await {
            Ok(provider_receipt) => Ok(self
                .store
                .complete_agent_turn_effect(&AgentCompleteTurnEffectV1 {
                    schema_version: intent.schema_version,
                    interaction_session_id: intent.interaction_session_id.clone(),
                    runtime: intent.runtime.clone(),
                    client_message_id: intent.client_message_id.clone(),
                    state: AgentTurnEffectStateV1::Accepted,
                    provider_receipt: Some(provider_receipt),
                    updated_at_ms: now_ms()?,
                })
                .await?),
            Err(error) => {
                self.store
                    .complete_agent_turn_effect(&AgentCompleteTurnEffectV1 {
                        schema_version: intent.schema_version,
                        interaction_session_id: intent.interaction_session_id.clone(),
                        runtime: intent.runtime.clone(),
                        client_message_id: intent.client_message_id.clone(),
                        state: AgentTurnEffectStateV1::Failed,
                        provider_receipt: Some(error.receipt()),
                        updated_at_ms: now_ms()?,
                    })
                    .await?;
                Err(AgentConversationErrorV1::Provider(error))
            }
        }
    }

    pub async fn answer_pending<P>(
        &self,
        provider: &P,
        intent: &AgentPendingAnswerIntentV1,
    ) -> Result<AgentPendingAnswerReceiptV1, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
    {
        let prepared = self.store.prepare_agent_pending_answer(intent).await?;
        if !prepared.newly_prepared {
            return Ok(prepared);
        }
        let binding = self
            .exact_binding(&intent.interaction_session_id, &intent.runtime)
            .await?;
        match provider
            .answer_pending(&binding, intent, &prepared.request)
            .await
        {
            Ok(provider_receipt) => {
                self.complete_pending_answer_success(
                    &intent.idempotency_key,
                    &intent.interaction_session_id,
                    provider_receipt,
                )
                .await
            }
            Err(error) => {
                self.store
                    .complete_agent_pending_answer(&AgentCompletePendingAnswerV1 {
                        schema_version: intent.schema_version,
                        idempotency_key: intent.idempotency_key.clone(),
                        state: AgentPendingAnswerStateV1::Failed,
                        provider_receipt: Some(error.receipt()),
                        updated_at_ms: now_ms()?,
                    })
                    .await?;
                Err(AgentConversationErrorV1::Provider(error))
            }
        }
    }

    pub(crate) async fn complete_pending_answer_success(
        &self,
        idempotency_key: &str,
        interaction_session_id: &AgentInteractionSessionIdV1,
        provider_receipt: Value,
    ) -> Result<AgentPendingAnswerReceiptV1, AgentConversationErrorV1> {
        let receipt = self
            .store
            .complete_agent_pending_answer(&AgentCompletePendingAnswerV1 {
                schema_version: dure_app::AGENT_TIMELINE_SCHEMA_VERSION_V1,
                idempotency_key: idempotency_key.into(),
                state: AgentPendingAnswerStateV1::Succeeded,
                provider_receipt: Some(provider_receipt),
                updated_at_ms: now_ms()?,
            })
            .await?;
        let page = self
            .store
            .read_agent_timeline(&AgentTimelineReadRequestV1 {
                schema_version: dure_app::AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction_session_id.clone(),
                direction: dure_app::AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: 1,
            })
            .await?;
        if let AgentTimelineReadV1::Page { page } = page {
            self.publish_after_commit(
                interaction_session_id.clone(),
                page.final_cursor,
                vec![
                    AgentConversationNotificationKindV1::Timeline,
                    AgentConversationNotificationKindV1::PendingRequests,
                ],
            );
        }
        Ok(receipt)
    }

    pub async fn interrupt_turn<P>(
        &self,
        provider: &P,
        request: &AgentInterruptTurnRequestV1,
    ) -> Result<AgentInterruptTurnReceiptV1, AgentConversationErrorV1>
    where
        P: AgentProviderCommands + ?Sized,
    {
        request.validate()?;
        let binding = self
            .exact_binding(&request.interaction_session_id, &request.runtime)
            .await?;
        let provider_receipt = provider.interrupt_turn(&binding, request).await?;
        Ok(AgentInterruptTurnReceiptV1 {
            request: request.clone(),
            provider_receipt,
            completed_at_ms: now_ms()?,
        })
    }

    async fn exact_binding(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        runtime: &AgentProviderRuntimeFenceV1,
    ) -> Result<AgentInteractionBindingV1, AgentConversationErrorV1> {
        let binding = self
            .store
            .agent_interaction(interaction_session_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent_interaction",
                id: interaction_session_id.to_string(),
            })?;
        if binding.runtime != *runtime {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "agent_interaction_runtime",
                id: interaction_session_id.to_string(),
                reason: "command runtime is stale".into(),
            }
            .into());
        }
        Ok(binding)
    }

    pub(crate) async fn publish_goal_change(
        &self,
        agent_id: &dure_app::AgentIdV1,
    ) -> Result<(), AgentConversationErrorV1> {
        self.publish_projection_change(agent_id, AgentConversationNotificationKindV1::Goal).await
    }

    pub(crate) async fn publish_projection_change(
        &self,
        agent_id: &dure_app::AgentIdV1,
        kind: AgentConversationNotificationKindV1,
    ) -> Result<(), AgentConversationErrorV1> {
        let Some(binding) = self.store.agent_interaction_for_agent(agent_id).await? else {
            return Ok(());
        };
        if let AgentTimelineReadV1::Page { page } = self
            .read(&AgentTimelineReadRequestV1 {
                schema_version: 1,
                interaction_session_id: binding.interaction_session_id.clone(),
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: 1,
            })
            .await?
        {
            self.publish_after_commit(
                binding.interaction_session_id,
                page.final_cursor,
                vec![kind],
            );
        }
        Ok(())
    }

    fn publish_after_commit(
        &self,
        interaction_session_id: AgentInteractionSessionIdV1,
        timeline_cursor: AgentTimelineCursorV1,
        kinds: Vec<AgentConversationNotificationKindV1>,
    ) {
        if kinds.is_empty() {
            return;
        }
        let _ = self.notifications.send(AgentConversationNotificationV1 {
            interaction_session_id,
            timeline_cursor,
            kinds,
        });
    }
}

impl From<AgentProviderCommandErrorV1> for AgentConversationErrorV1 {
    fn from(error: AgentProviderCommandErrorV1) -> Self {
        Self::Provider(error)
    }
}

fn now_ms() -> Result<i64, AgentConversationErrorV1> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AgentConversationErrorV1::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| AgentConversationErrorV1::Clock)
}

#[cfg(test)]
mod tests;
