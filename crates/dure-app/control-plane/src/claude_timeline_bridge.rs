use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentClientMessageIdV1, AgentHistoryHydrationDispositionV1,
    AgentHistorySnapshotV1, AgentInteractionBindingV1, AgentInteractionRequestIdV1,
    AgentInteractionSessionIdV1, AgentInterruptTurnRequestV1, AgentPendingAnswerIntentV1,
    AgentPendingRequestDraftV1, AgentPendingRequestKindV1, AgentPendingRequestV1,
    AgentPendingSnapshotV1, AgentProviderEventCommitV1, AgentProviderEventIdentityV1,
    AgentProviderGapV1, AgentProviderMessageIdV1, AgentProviderRuntimeFenceV1,
    AgentStartTurnIntentV1, AgentTimelineItemBodyV1, AgentTimelineItemDraftV1,
    AgentTimelineItemIdV1, AgentTimelineLifecycleStateV1, AgentTimelineMutationV1,
    AgentTimelineStore, AgentTimelineStreamIdV1, AgentTimelineTextFragmentV1,
    AgentTimelineTextKindV1, AgentTimelineToolStateV1, AgentTurnFailureReasonV1,
    MAX_AGENT_HISTORY_ITEMS_V1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::agent_conversation::{
    AgentConversationErrorV1, AgentConversationService, AgentProviderCommandErrorV1,
    AgentProviderCommandFuture, AgentProviderCommands,
};
use crate::claude_sdk_host_client::{
    ClaudeDch1Client, ClaudeDch1EventFrame, ClaudeDch1ProviderEvent, ClaudeDch1QueryIdentity,
};

const MAX_REPLAY_PAGES: usize = 1024;
const MAX_HISTORY_PAGES: usize = 64;
const MAX_HISTORY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeTimelineBridgeError {
    reason: String,
}

impl ClaudeTimelineBridgeError {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }
}

impl std::fmt::Display for ClaudeTimelineBridgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "dure_claude_timeline_bridge_{}", self.reason)
    }
}

impl std::error::Error for ClaudeTimelineBridgeError {}

pub type ClaudeDch1TransportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Value, ClaudeTimelineBridgeError>> + Send + 'a>>;

pub trait ClaudeDch1Transport: Send + Sync {
    fn call<'a>(&'a self, action: &'a str, payload: Value) -> ClaudeDch1TransportFuture<'a>;
}

impl ClaudeDch1Transport for ClaudeDch1Client {
    fn call<'a>(&'a self, action: &'a str, payload: Value) -> ClaudeDch1TransportFuture<'a> {
        Box::pin(async move {
            self.request(action, payload)
                .await
                .map_err(|error| ClaudeTimelineBridgeError::new(error.reason()))
        })
    }
}

/// One interaction projection over a shared DCH1 transport. The transport is
/// cloned from the backend's single SDK-host connection; this bridge never
/// opens a per-pane Node connection or process.
pub struct ClaudeTimelineBridge<S, T> {
    history_released: AtomicBool,
    identity: ClaudeDch1QueryIdentity,
    interaction_session_id: AgentInteractionSessionIdV1,
    service: Arc<AgentConversationService<S>>,
    transport: T,
}

impl<S, T> ClaudeTimelineBridge<S, T>
where
    S: AgentTimelineStore + 'static,
    T: ClaudeDch1Transport,
{
    pub fn new(
        service: Arc<AgentConversationService<S>>,
        transport: T,
        interaction_session_id: AgentInteractionSessionIdV1,
        identity: ClaudeDch1QueryIdentity,
    ) -> Result<Self, ClaudeTimelineBridgeError> {
        identity
            .validate()
            .map_err(|error| ClaudeTimelineBridgeError::new(error.reason()))?;
        Ok(Self {
            history_released: AtomicBool::new(false),
            identity,
            interaction_session_id,
            service,
            transport,
        })
    }

    pub fn identity(&self) -> &ClaudeDch1QueryIdentity {
        &self.identity
    }

    pub fn validate_attached_snapshot(
        &self,
        snapshot: &Value,
    ) -> Result<(), ClaudeTimelineBridgeError> {
        let queries = object(snapshot, "snapshot_invalid")?
            .get("queries")
            .and_then(Value::as_array)
            .ok_or_else(|| ClaudeTimelineBridgeError::new("snapshot_invalid"))?;
        let found = queries.iter().any(|query| {
            object(query, "snapshot_invalid")
                .ok()
                .and_then(|query| query.get("identity"))
                .and_then(|identity| {
                    serde_json::from_value::<ClaudeDch1QueryIdentity>(identity.clone()).ok()
                })
                .is_some_and(|identity| identity == self.identity)
        });
        if !found {
            return Err(ClaudeTimelineBridgeError::new("query_missing"));
        }
        Ok(())
    }

    /// Replays every uncommitted private event, commits it canonically, and
    /// only then acknowledges the DCH1 source cursor. The final complete
    /// pending snapshot converges the durable projection without resending a
    /// prompt.
    pub async fn reconcile(&self) -> Result<(), ClaudeTimelineBridgeError> {
        self.reconcile_history().await?;
        self.reconcile_provider_projection().await
    }

    /// Commits only the private live replay owned by a Query that attachment
    /// cleanup has already retired. It never claims that an incomplete
    /// provider transcript was hydrated.
    pub(crate) async fn reconcile_retired_provider_projection(
        &self,
    ) -> Result<(), ClaudeTimelineBridgeError> {
        self.reconcile_provider_projection().await
    }

    async fn reconcile_provider_projection(&self) -> Result<(), ClaudeTimelineBridgeError> {
        let runtime = self.runtime_fence();
        let mut after = self
            .service
            .provider_cursor(&self.interaction_session_id, &runtime)
            .await
            .map_err(conversation_error)?
            .committed_through_sequence;
        let mut pages = 0_usize;
        let mut last_acknowledged = None;
        loop {
            loop {
                pages += 1;
                if pages > MAX_REPLAY_PAGES {
                    return Err(ClaudeTimelineBridgeError::new("replay_page_limit"));
                }
                let response = self
                    .transport
                    .call(
                        "replay",
                        json!({
                            "identity": self.identity,
                            "afterSequence": after,
                        }),
                    )
                    .await?;
                let page = replay_page(&response)?;
                if let Some((requested_after, dropped_through)) = page.gap {
                    if requested_after != after {
                        return Err(ClaudeTimelineBridgeError::new("gap_cursor_mismatch"));
                    }
                    self.service
                        .record_provider_gap(&AgentProviderGapV1 {
                            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                            interaction_session_id: self.interaction_session_id.clone(),
                            runtime: runtime.clone(),
                            requested_after_sequence: requested_after,
                            dropped_through_sequence: dropped_through,
                            observed_at_ms: now_ms()?,
                        })
                        .await
                        .map_err(conversation_error)?;
                    after = dropped_through;
                }
                let prior_after = after;
                let page_has_more = page.has_more;
                let page_latest_sequence = page.latest_sequence;
                for event in page.events {
                    if event.sequence != after + 1 {
                        return Err(ClaudeTimelineBridgeError::new("replay_sequence_unordered"));
                    }
                    let terminal = event.kind == "query_exited";
                    self.commit_event(&event).await?;
                    after = event.sequence;
                    if terminal {
                        if page_has_more || page_latest_sequence != after {
                            return Err(ClaudeTimelineBridgeError::new("terminal_event_not_final"));
                        }
                        self.reconcile_terminal_pending(&runtime, after).await?;
                        self.ack(after).await?;
                        return Ok(());
                    }
                }
                if after > prior_after {
                    self.ack(after).await?;
                    last_acknowledged = Some(after);
                }
                if page_has_more {
                    if after == prior_after {
                        return Err(ClaudeTimelineBridgeError::new("replay_stalled"));
                    }
                    continue;
                }
                if after != page_latest_sequence {
                    return Err(ClaudeTimelineBridgeError::new("replay_incomplete"));
                }
                break;
            }
            let pending = self.load_pending_snapshot().await?;
            if pending.observed_through_sequence < after {
                return Err(ClaudeTimelineBridgeError::new(
                    "pending_snapshot_cursor_stale",
                ));
            }
            if pending.observed_through_sequence > after {
                continue;
            }
            self.service
                .reconcile_pending_snapshot(&AgentPendingSnapshotV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: self.interaction_session_id.clone(),
                    runtime: runtime.clone(),
                    observed_through_sequence: after,
                    requests: pending.requests,
                    observed_at_ms: now_ms()?,
                })
                .await
                .map_err(conversation_error)?;
            if after > 0 && last_acknowledged != Some(after) {
                self.ack(after).await?;
            }
            return Ok(());
        }
    }

    async fn reconcile_history(&self) -> Result<(), ClaudeTimelineBridgeError> {
        if self.history_released.load(Ordering::Acquire) {
            return Ok(());
        }
        let authority = self
            .service
            .history_hydration_authority(&self.interaction_session_id)
            .await
            .map_err(conversation_error)?;
        let binding = authority.binding;
        if binding.interaction_session_id != self.interaction_session_id
            || binding.runtime != self.runtime_fence()
        {
            return Err(ClaudeTimelineBridgeError::new("history_binding_stale"));
        }
        match authority.disposition {
            AgentHistoryHydrationDispositionV1::Complete
            | AgentHistoryHydrationDispositionV1::KnownGap => {
                self.release_history().await?;
                return Ok(());
            }
            AgentHistoryHydrationDispositionV1::Seedable => {}
        }
        let provider_conversation_ref = binding
            .provider_conversation_ref
            .as_deref()
            .ok_or_else(|| ClaudeTimelineBridgeError::new("history_identity_missing"))?;

        let mut offset = 0_usize;
        let mut pages = 0_usize;
        let mut bytes = 0_usize;
        let mut items = Vec::new();
        loop {
            pages += 1;
            if pages > MAX_HISTORY_PAGES {
                return Err(ClaudeTimelineBridgeError::new("history_page_limit"));
            }
            let response = self
                .transport
                .call(
                    "history_page",
                    json!({ "identity": self.identity, "offset": offset }),
                )
                .await?;
            let page = history_page(&response, offset)?;
            match page {
                HistoryPage::Incomplete => {
                    // Provider history is a replaceable projection, not an
                    // admission requirement for the live Query. Preserve the
                    // binding's incomplete bit and continue from live replay.
                    self.release_history().await?;
                    return Ok(());
                }
                HistoryPage::Complete {
                    page_items,
                    next_offset,
                    has_more,
                } => {
                    for raw in page_items {
                        bytes = bytes
                            .checked_add(
                                serde_json::to_vec(&raw)
                                    .map_err(|_| {
                                        ClaudeTimelineBridgeError::new("history_item_invalid")
                                    })?
                                    .len(),
                            )
                            .ok_or_else(|| {
                                ClaudeTimelineBridgeError::new("history_bounds_exceeded")
                            })?;
                        if bytes > MAX_HISTORY_BYTES || items.len() >= MAX_AGENT_HISTORY_ITEMS_V1 {
                            return Err(ClaudeTimelineBridgeError::new("history_bounds_exceeded"));
                        }
                        items.push(history_item(provider_conversation_ref, raw)?);
                    }
                    if has_more {
                        if next_offset <= offset {
                            return Err(ClaudeTimelineBridgeError::new("history_page_stalled"));
                        }
                        offset = next_offset;
                        continue;
                    }
                    if next_offset != items.len() {
                        return Err(ClaudeTimelineBridgeError::new(
                            "history_snapshot_incomplete",
                        ));
                    }
                    break;
                }
            }
        }

        let receipt = self
            .service
            .reconcile_history(&AgentHistorySnapshotV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                binding,
                items,
                observed_at_ms: now_ms()?,
            })
            .await
            .map_err(conversation_error)?;
        if !receipt.binding.history_complete {
            return Err(ClaudeTimelineBridgeError::new("history_commit_incomplete"));
        }
        self.release_history().await
    }

    async fn release_history(&self) -> Result<(), ClaudeTimelineBridgeError> {
        self.transport
            .call("ack_history", json!({ "identity": self.identity }))
            .await?;
        self.history_released.store(true, Ordering::Release);
        Ok(())
    }

    /// Commits one push event from the shared client's central dispatcher.
    /// Callers route frames by identity; a duplicate replay remains harmless.
    pub async fn ingest_pushed(
        &self,
        frame: &ClaudeDch1EventFrame,
    ) -> Result<bool, ClaudeTimelineBridgeError> {
        if frame.identity != self.identity {
            return Ok(false);
        }
        let cursor = self
            .service
            .provider_cursor(&self.interaction_session_id, &self.runtime_fence())
            .await
            .map_err(conversation_error)?;
        if frame.event.sequence <= cursor.committed_through_sequence {
            self.commit_event(&frame.event).await?;
            if frame.event.kind == "query_exited" {
                self.reconcile_terminal_pending(&cursor.runtime, cursor.committed_through_sequence)
                    .await?;
            }
            self.ack(cursor.committed_through_sequence).await?;
            return Ok(true);
        }
        if frame.event.sequence > cursor.committed_through_sequence + 1 {
            self.reconcile().await?;
            return Ok(true);
        }
        self.commit_event(&frame.event).await?;
        if frame.event.kind == "query_exited" {
            self.reconcile_terminal_pending(&cursor.runtime, frame.event.sequence)
                .await?;
        }
        self.ack(frame.event.sequence).await?;
        Ok(true)
    }

    async fn commit_event(
        &self,
        event: &ClaudeDch1ProviderEvent,
    ) -> Result<(), ClaudeTimelineBridgeError> {
        let commit = map_event(
            &self.interaction_session_id,
            &self.identity,
            event,
            now_ms()?,
        )?;
        self.service
            .commit_provider_event(&commit)
            .await
            .map_err(conversation_error)?;
        Ok(())
    }

    async fn ack(&self, sequence: i64) -> Result<(), ClaudeTimelineBridgeError> {
        self.transport
            .call(
                "ack",
                json!({
                    "identity": self.identity,
                    "sequence": sequence,
                }),
            )
            .await?;
        Ok(())
    }

    async fn load_pending_snapshot(&self) -> Result<PendingSnapshot, ClaudeTimelineBridgeError> {
        let pending = self
            .transport
            .call("pending_snapshot", json!({ "identity": self.identity }))
            .await?;
        pending_snapshot(&pending)
    }

    async fn reconcile_terminal_pending(
        &self,
        runtime: &AgentProviderRuntimeFenceV1,
        terminal_sequence: i64,
    ) -> Result<(), ClaudeTimelineBridgeError> {
        let pending = self.load_pending_snapshot().await?;
        if pending.observed_through_sequence != terminal_sequence {
            return Err(ClaudeTimelineBridgeError::new(
                "terminal_pending_snapshot_cursor_mismatch",
            ));
        }
        self.service
            .reconcile_pending_snapshot(&AgentPendingSnapshotV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: self.interaction_session_id.clone(),
                runtime: runtime.clone(),
                observed_through_sequence: terminal_sequence,
                requests: pending.requests,
                observed_at_ms: now_ms()?,
            })
            .await
            .map_err(conversation_error)?;
        Ok(())
    }

    fn runtime_fence(&self) -> AgentProviderRuntimeFenceV1 {
        AgentProviderRuntimeFenceV1 {
            runtime_generation: self.identity.runtime_generation.clone(),
            provider_epoch: self.identity.query_epoch.clone(),
        }
    }

    fn command_identity(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<Value, AgentProviderCommandErrorV1> {
        if binding.interaction_session_id != self.interaction_session_id
            || binding.runtime != self.runtime_fence()
        {
            return Err(AgentProviderCommandErrorV1::new(
                "stale_runtime",
                "Claude bridge binding does not match its Query",
            ));
        }
        serde_json::to_value(&self.identity)
            .map_err(|error| AgentProviderCommandErrorV1::new("identity_encode", error.to_string()))
    }
}

impl<S, T> AgentProviderCommands for ClaudeTimelineBridge<S, T>
where
    S: AgentTimelineStore + 'static,
    T: ClaudeDch1Transport,
{
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            let identity = self.command_identity(binding)?;
            self.transport
                .call(
                    "start_turn",
                    json!({
                        "identity": identity,
                        "turn": {
                            "clientMessageId": intent.client_message_id,
                            "input": intent.input,
                        },
                    }),
                )
                .await
                .map_err(provider_error)
        })
    }

    fn steer_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            let identity = self.command_identity(binding)?;
            self.transport
                .call(
                    "steer_turn",
                    json!({
                        "identity": identity,
                        "turn": {
                            "clientMessageId": intent.client_message_id,
                            "input": intent.input,
                        },
                    }),
                )
                .await
                .map_err(provider_error)
        })
    }

    fn answer_pending<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentPendingAnswerIntentV1,
        request: &'a AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            let identity = self.command_identity(binding)?;
            let mut answer = intent.answer.as_object().cloned().ok_or_else(|| {
                AgentProviderCommandErrorV1::new("answer_invalid", "answer must be an object")
            })?;
            answer.insert(
                "requestId".into(),
                Value::String(intent.request_id.to_string()),
            );
            answer.insert(
                "clientMessageId".into(),
                Value::String(intent.client_message_id.to_string()),
            );
            answer.insert(
                "kind".into(),
                Value::String(
                    match request.request.kind {
                        AgentPendingRequestKindV1::Permission => "permission",
                        AgentPendingRequestKindV1::Question => "question",
                    }
                    .into(),
                ),
            );
            self.transport
                .call(
                    "answer_interaction",
                    json!({ "identity": identity, "answer": answer }),
                )
                .await
                .map_err(provider_error)
        })
    }

    fn interrupt_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        request: &'a AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            let identity = self.command_identity(binding)?;
            self.transport
                .call(
                    "interrupt_turn",
                    json!({
                        "identity": identity,
                        "request": {
                            "clientMessageId": request.client_message_id,
                            "interruptRequestId": request.interrupt_request_id,
                        },
                    }),
                )
                .await
                .map_err(provider_error)
        })
    }
}

struct ReplayPage {
    events: Vec<ClaudeDch1ProviderEvent>,
    gap: Option<(i64, i64)>,
    has_more: bool,
    latest_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum HistoryPageWire {
    Complete {
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<HistoryItemWire>,
        #[serde(rename = "nextOffset")]
        next_offset: usize,
        offset: usize,
    },
    Incomplete {
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<Value>,
        #[serde(rename = "nextOffset")]
        next_offset: usize,
        offset: usize,
        reason: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryItemWire {
    source_id: String,
    provider_message_id: Option<String>,
    body: AgentTimelineItemBodyV1,
    created_at_ms: i64,
}

enum HistoryPage {
    Complete {
        page_items: Vec<HistoryItemWire>,
        next_offset: usize,
        has_more: bool,
    },
    Incomplete,
}

fn history_page(
    value: &Value,
    expected_offset: usize,
) -> Result<HistoryPage, ClaudeTimelineBridgeError> {
    let page: HistoryPageWire = serde_json::from_value(value.clone())
        .map_err(|_| ClaudeTimelineBridgeError::new("history_page_invalid"))?;
    match page {
        HistoryPageWire::Incomplete {
            has_more,
            items,
            next_offset,
            offset,
            reason,
        } => {
            if expected_offset != 0
                || offset != 0
                || next_offset != 0
                || has_more
                || !items.is_empty()
                || !safe_history_reason(&reason)
            {
                return Err(ClaudeTimelineBridgeError::new("history_page_invalid"));
            }
            Ok(HistoryPage::Incomplete)
        }
        HistoryPageWire::Complete {
            has_more,
            items,
            next_offset,
            offset,
        } => {
            if offset != expected_offset
                || next_offset != offset.saturating_add(items.len())
                || (has_more && items.is_empty())
            {
                return Err(ClaudeTimelineBridgeError::new("history_page_invalid"));
            }
            Ok(HistoryPage::Complete {
                page_items: items,
                next_offset,
                has_more,
            })
        }
    }
}

fn history_item(
    provider_conversation_ref: &str,
    raw: HistoryItemWire,
) -> Result<AgentTimelineItemDraftV1, ClaudeTimelineBridgeError> {
    if raw.created_at_ms < 0 {
        return Err(ClaudeTimelineBridgeError::new("history_item_invalid"));
    }
    let item_id = AgentTimelineItemIdV1::new(format!(
        "claude-history-{}",
        digest(&(provider_conversation_ref, &raw.source_id))?
    ))
    .map_err(|_| ClaudeTimelineBridgeError::new("history_item_identity_invalid"))?;
    let provider_message_id = raw
        .provider_message_id
        .as_deref()
        .map(provider_message_id)
        .transpose()?;
    Ok(AgentTimelineItemDraftV1 {
        item_id,
        turn_id: None,
        client_message_id: None,
        provider_message_id,
        body: raw.body,
        created_at_ms: raw.created_at_ms,
    })
}

fn safe_history_reason(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

struct PendingSnapshot {
    observed_through_sequence: i64,
    requests: Vec<AgentPendingRequestDraftV1>,
}

fn replay_page(value: &Value) -> Result<ReplayPage, ClaudeTimelineBridgeError> {
    let value = object(value, "replay_invalid")?;
    let events = value
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| ClaudeTimelineBridgeError::new("replay_invalid"))?
        .iter()
        .map(|event| {
            let event: ClaudeDch1ProviderEvent = serde_json::from_value(event.clone())
                .map_err(|_| ClaudeTimelineBridgeError::new("replay_event_invalid"))?;
            if event.sequence < 1 {
                return Err(ClaudeTimelineBridgeError::new("replay_event_invalid"));
            }
            Ok(event)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let gap = match value.get("gap") {
        None | Some(Value::Null) => None,
        Some(gap) => {
            let gap = object(gap, "replay_gap_invalid")?;
            let requested_after = integer(gap, "requestedAfter", "replay_gap_invalid")?;
            let dropped_through = integer(gap, "droppedThrough", "replay_gap_invalid")?;
            if requested_after < 0 || dropped_through <= requested_after {
                return Err(ClaudeTimelineBridgeError::new("replay_gap_invalid"));
            }
            Some((requested_after, dropped_through))
        }
    };
    let latest_sequence = integer(value, "latestSequence", "replay_invalid")?;
    let has_more = value
        .get("hasMore")
        .and_then(Value::as_bool)
        .ok_or_else(|| ClaudeTimelineBridgeError::new("replay_invalid"))?;
    Ok(ReplayPage {
        events,
        gap,
        has_more,
        latest_sequence,
    })
}

fn pending_requests(
    value: &Value,
) -> Result<Vec<AgentPendingRequestDraftV1>, ClaudeTimelineBridgeError> {
    value
        .as_array()
        .ok_or_else(|| ClaudeTimelineBridgeError::new("pending_snapshot_invalid"))?
        .iter()
        .map(pending_request)
        .collect()
}

fn pending_snapshot(value: &Value) -> Result<PendingSnapshot, ClaudeTimelineBridgeError> {
    let value = object(value, "pending_snapshot_invalid")?;
    let observed_through_sequence =
        integer(value, "observedThroughSequence", "pending_snapshot_invalid")?;
    if observed_through_sequence < 0 {
        return Err(ClaudeTimelineBridgeError::new("pending_snapshot_invalid"));
    }
    let requests = pending_requests(
        value
            .get("requests")
            .ok_or_else(|| ClaudeTimelineBridgeError::new("pending_snapshot_invalid"))?,
    )?;
    Ok(PendingSnapshot {
        observed_through_sequence,
        requests,
    })
}

fn pending_request(value: &Value) -> Result<AgentPendingRequestDraftV1, ClaudeTimelineBridgeError> {
    let request = object(value, "pending_request_invalid")?;
    let kind = match string(request, "kind", "pending_request_invalid")? {
        "permission" => AgentPendingRequestKindV1::Permission,
        "question" => AgentPendingRequestKindV1::Question,
        _ => {
            return Err(ClaudeTimelineBridgeError::new(
                "pending_request_kind_invalid",
            ));
        }
    };
    Ok(AgentPendingRequestDraftV1 {
        request_id: interaction_request_id(string(
            request,
            "requestId",
            "pending_request_invalid",
        )?)?,
        kind,
        turn_id: None,
        client_message_id: client_message_id(string(
            request,
            "clientMessageId",
            "pending_request_invalid",
        )?)?,
        payload: value.clone(),
        created_at_ms: 0,
    })
}

fn map_event(
    interaction_session_id: &AgentInteractionSessionIdV1,
    identity: &ClaudeDch1QueryIdentity,
    event: &ClaudeDch1ProviderEvent,
    observed_at_ms: i64,
) -> Result<AgentProviderEventCommitV1, ClaudeTimelineBridgeError> {
    let payload = object(&event.payload, "event_payload_invalid")?;
    let mut mutations = Vec::new();
    match event.kind.as_str() {
        "initialized" | "user_message_accepted" | "provider_turn_result" => {}
        "provider_session_initialized" => {
            mutations.push(AgentTimelineMutationV1::EstablishProviderConversation {
                provider_conversation_ref: string(
                    payload,
                    "providerSessionId",
                    "provider_session_initialized_invalid",
                )?
                .into(),
                established_at_ms: observed_at_ms,
            });
            mutations.push(AgentTimelineMutationV1::Append {
                item: item(
                    identity,
                    event.sequence,
                    "session-ready",
                    AgentTimelineItemBodyV1::Lifecycle {
                        state: AgentTimelineLifecycleStateV1::SessionReady,
                        detail: None,
                    },
                    None,
                    None,
                    observed_at_ms,
                )?,
            });
            mutations.push(provider_evidence(identity, event, observed_at_ms)?);
        }
        "assistant_delta" | "reasoning_delta" | "tool_input_delta" => {
            let provider_message_id = provider_message_id(string(
                payload,
                "providerMessageId",
                "message_delta_invalid",
            )?)?;
            let block_index = integer(payload, "blockIndex", "message_delta_invalid")?;
            if block_index < 0 {
                return Err(ClaudeTimelineBridgeError::new("message_delta_invalid"));
            }
            let text = string(payload, "text", "message_delta_invalid")?.to_owned();
            let text_kind = match event.kind.as_str() {
                "assistant_delta" => AgentTimelineTextKindV1::Assistant,
                "reasoning_delta" => AgentTimelineTextKindV1::Reasoning,
                _ => AgentTimelineTextKindV1::ToolInput,
            };
            let key = format!("{}:{block_index}:{}", provider_message_id, event.kind);
            mutations.push(AgentTimelineMutationV1::AppendText {
                fragment: AgentTimelineTextFragmentV1 {
                    stream_id: timeline_stream_id(identity, block_index, &key)?,
                    item_id: timeline_item_id(identity, &key)?,
                    kind: text_kind,
                    fragment: text,
                    turn_id: None,
                    client_message_id: None,
                    provider_message_id,
                    observed_at_ms,
                },
            });
        }
        "assistant_message_completed" => {
            let provider_message_id = provider_message_id(string(
                payload,
                "providerMessageId",
                "assistant_completed_invalid",
            )?)?;
            mutations.push(AgentTimelineMutationV1::FinishTextForProviderMessage {
                provider_message_id,
                finished_at_ms: observed_at_ms,
            });
            if let Some(error) = payload.get("error").and_then(Value::as_str) {
                mutations.push(AgentTimelineMutationV1::Append {
                    item: item(
                        identity,
                        event.sequence,
                        "assistant-error",
                        AgentTimelineItemBodyV1::Error {
                            code: "provider_assistant_error".into(),
                            message: error.into(),
                        },
                        None,
                        None,
                        observed_at_ms,
                    )?,
                });
            }
        }
        "tool_started" | "tool_result" => {
            let reason = if event.kind == "tool_started" {
                "tool_started_invalid"
            } else {
                "tool_result_invalid"
            };
            if payload.get("parentToolUseId") != Some(&Value::Null) {
                return Err(ClaudeTimelineBridgeError::new(reason));
            }
            let terminal = event.kind == "tool_result";
            let state = if !terminal {
                AgentTimelineToolStateV1::Running
            } else if payload
                .get("isError")
                .and_then(Value::as_bool)
                .ok_or_else(|| ClaudeTimelineBridgeError::new(reason))?
            {
                AgentTimelineToolStateV1::Failed
            } else {
                AgentTimelineToolStateV1::Completed
            };
            let input = payload
                .get("input")
                .cloned()
                .ok_or_else(|| ClaudeTimelineBridgeError::new(reason))?;
            let output = terminal
                .then(|| {
                    payload
                        .get("output")
                        .cloned()
                        .ok_or_else(|| ClaudeTimelineBridgeError::new(reason))
                })
                .transpose()?;
            let provider_message_id =
                provider_message_id(string(payload, "providerMessageId", reason)?)?;
            mutations.push(AgentTimelineMutationV1::Append {
                item: item(
                    identity,
                    event.sequence,
                    if terminal {
                        "tool-terminal"
                    } else {
                        "tool-running"
                    },
                    AgentTimelineItemBodyV1::Tool {
                        tool_call_id: string(payload, "toolCallId", reason)?.into(),
                        name: string(payload, "name", reason)?.into(),
                        state,
                        input: Some(input),
                        output,
                    },
                    None,
                    Some(provider_message_id),
                    observed_at_ms,
                )?,
            });
        }
        "turn_completed" | "turn_failed" => {
            let client_message_id =
                client_message_id(string(payload, "clientMessageId", "turn_terminal_invalid")?)?;
            mutations.push(AgentTimelineMutationV1::Append {
                item: item(
                    identity,
                    event.sequence,
                    "turn-terminal",
                    AgentTimelineItemBodyV1::Lifecycle {
                        state: if event.kind == "turn_completed" {
                            AgentTimelineLifecycleStateV1::TurnCompleted
                        } else {
                            AgentTimelineLifecycleStateV1::TurnFailed
                        },
                        // The host forwards the driver's classified reason as a
                        // token; anything outside the shared vocabulary is
                        // dropped rather than rendered as prose.
                        detail: if event.kind == "turn_failed" {
                            payload
                                .get("reason")
                                .and_then(Value::as_str)
                                .and_then(AgentTurnFailureReasonV1::from_token)
                                .map(|reason| reason.as_token().into())
                        } else {
                            None
                        },
                    },
                    Some(client_message_id),
                    None,
                    observed_at_ms,
                )?,
            });
        }
        "query_exited" => {
            mutations.push(AgentTimelineMutationV1::Append {
                item: item(
                    identity,
                    event.sequence,
                    "query-exited",
                    AgentTimelineItemBodyV1::Lifecycle {
                        state: AgentTimelineLifecycleStateV1::SessionExited,
                        detail: Some(event.payload.to_string()),
                    },
                    None,
                    None,
                    observed_at_ms,
                )?,
            });
        }
        "interaction_requested" => {
            mutations.push(AgentTimelineMutationV1::PutPending {
                request: pending_request(&event.payload)?,
            });
        }
        "interaction_resolved" => {
            mutations.push(AgentTimelineMutationV1::ResolvePending {
                request_id: interaction_request_id(string(
                    payload,
                    "requestId",
                    "interaction_resolved_invalid",
                )?)?,
                outcome: event.payload.clone(),
                resolved_at_ms: observed_at_ms,
            });
        }
        "interaction_cancelled" => {
            mutations.push(AgentTimelineMutationV1::CancelPending {
                request_id: interaction_request_id(string(
                    payload,
                    "requestId",
                    "interaction_cancelled_invalid",
                )?)?,
                reason: string(payload, "reason", "interaction_cancelled_invalid")?.into(),
                canceled_at_ms: observed_at_ms,
            });
        }
        _ => mutations.push(provider_evidence(identity, event, observed_at_ms)?),
    }
    Ok(AgentProviderEventCommitV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: interaction_session_id.clone(),
        event: AgentProviderEventIdentityV1 {
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: identity.runtime_generation.clone(),
                provider_epoch: identity.query_epoch.clone(),
            },
            sequence: event.sequence,
        },
        source_fingerprint: format!("sha256:{}", digest(event)?),
        mutations,
        recorded_at_ms: observed_at_ms,
    })
}

fn provider_evidence(
    identity: &ClaudeDch1QueryIdentity,
    event: &ClaudeDch1ProviderEvent,
    observed_at_ms: i64,
) -> Result<AgentTimelineMutationV1, ClaudeTimelineBridgeError> {
    Ok(AgentTimelineMutationV1::Append {
        item: item(
            identity,
            event.sequence,
            "provider-evidence",
            AgentTimelineItemBodyV1::ProviderEvidence {
                namespace: "provider.claude".into(),
                kind: event.kind.clone(),
                value: event.payload.clone(),
            },
            None,
            None,
            observed_at_ms,
        )?,
    })
}

fn item(
    identity: &ClaudeDch1QueryIdentity,
    sequence: i64,
    suffix: &str,
    body: AgentTimelineItemBodyV1,
    client_message_id: Option<AgentClientMessageIdV1>,
    provider_message_id: Option<AgentProviderMessageIdV1>,
    created_at_ms: i64,
) -> Result<AgentTimelineItemDraftV1, ClaudeTimelineBridgeError> {
    Ok(AgentTimelineItemDraftV1 {
        item_id: timeline_item_id(identity, &format!("{sequence}:{suffix}"))?,
        turn_id: None,
        client_message_id,
        provider_message_id,
        body,
        created_at_ms,
    })
}

fn timeline_item_id(
    identity: &ClaudeDch1QueryIdentity,
    key: &str,
) -> Result<AgentTimelineItemIdV1, ClaudeTimelineBridgeError> {
    AgentTimelineItemIdV1::new(format!("claude-item-{}", digest(&(identity, key))?))
        .map_err(|_| ClaudeTimelineBridgeError::new("timeline_item_id_invalid"))
}

fn timeline_stream_id(
    identity: &ClaudeDch1QueryIdentity,
    block_index: i64,
    key: &str,
) -> Result<AgentTimelineStreamIdV1, ClaudeTimelineBridgeError> {
    AgentTimelineStreamIdV1::new(format!(
        "claude-stream-{block_index:010}-{}",
        digest(&(identity, key))?
    ))
    .map_err(|_| ClaudeTimelineBridgeError::new("timeline_stream_id_invalid"))
}

fn client_message_id(value: &str) -> Result<AgentClientMessageIdV1, ClaudeTimelineBridgeError> {
    AgentClientMessageIdV1::new(value)
        .map_err(|_| ClaudeTimelineBridgeError::new("client_message_id_invalid"))
}

fn provider_message_id(value: &str) -> Result<AgentProviderMessageIdV1, ClaudeTimelineBridgeError> {
    AgentProviderMessageIdV1::new(value)
        .map_err(|_| ClaudeTimelineBridgeError::new("provider_message_id_invalid"))
}

fn interaction_request_id(
    value: &str,
) -> Result<AgentInteractionRequestIdV1, ClaudeTimelineBridgeError> {
    AgentInteractionRequestIdV1::new(value)
        .map_err(|_| ClaudeTimelineBridgeError::new("interaction_request_id_invalid"))
}

fn object<'a>(
    value: &'a Value,
    reason: &'static str,
) -> Result<&'a Map<String, Value>, ClaudeTimelineBridgeError> {
    value
        .as_object()
        .ok_or_else(|| ClaudeTimelineBridgeError::new(reason))
}

fn string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    reason: &'static str,
) -> Result<&'a str, ClaudeTimelineBridgeError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ClaudeTimelineBridgeError::new(reason))
}

fn integer(
    object: &Map<String, Value>,
    field: &str,
    reason: &'static str,
) -> Result<i64, ClaudeTimelineBridgeError> {
    object
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| ClaudeTimelineBridgeError::new(reason))
}

fn digest(value: &impl serde::Serialize) -> Result<String, ClaudeTimelineBridgeError> {
    let source = serde_json::to_vec(value)
        .map_err(|_| ClaudeTimelineBridgeError::new("source_not_serializable"))?;
    Ok(format!("{:x}", Sha256::digest(source)))
}

fn provider_error(error: ClaudeTimelineBridgeError) -> AgentProviderCommandErrorV1 {
    AgentProviderCommandErrorV1::new("claude_dch1", error.to_string())
}

fn conversation_error(error: AgentConversationErrorV1) -> ClaudeTimelineBridgeError {
    ClaudeTimelineBridgeError::new(format!("conversation_{error}"))
}

fn now_ms() -> Result<i64, ClaudeTimelineBridgeError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ClaudeTimelineBridgeError::new("clock_invalid"))?;
    i64::try_from(duration.as_millis()).map_err(|_| ClaudeTimelineBridgeError::new("clock_invalid"))
}

#[cfg(test)]
mod tests;
