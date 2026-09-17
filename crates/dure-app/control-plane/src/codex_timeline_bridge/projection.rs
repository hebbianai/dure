use std::collections::{BTreeMap, BTreeSet};

use dure_app::{
    AgentClientMessageIdV1, AgentInteractionRequestIdV1, AgentProviderMessageIdV1,
    AgentTimelineItemBodyV1, AgentTimelineItemIdV1, AgentTimelineLifecycleStateV1,
    AgentTimelineLiveTextV1, AgentTimelineMessageRoleV1, AgentTimelineRowV1,
    AgentTimelineStreamIdV1, AgentTimelineTextKindV1, AgentTimelineToolStateV1,
    AgentTurnFailureReasonV1, AgentTurnIdV1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::agent_conversation::AgentProviderCommandErrorV1;

#[derive(Clone)]
pub(super) struct CodexTurnContext {
    pub(super) turn_id: AgentTurnIdV1,
    pub(super) client_message_id: AgentClientMessageIdV1,
    pub(super) observed_at_ms: i64,
}

pub(super) struct TimelineItemContext {
    pub(super) turn_id: Option<AgentTurnIdV1>,
    pub(super) client_message_id: Option<AgentClientMessageIdV1>,
    pub(super) provider_message_id: Option<AgentProviderMessageIdV1>,
    pub(super) created_at_ms: i64,
}

pub(super) struct CodexTextIdentity<'a> {
    pub(super) item_id: &'a str,
    pub(super) kind: AgentTimelineTextKindV1,
    pub(super) provider_message_id: AgentProviderMessageIdV1,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct AssistantTextPlan {
    pub(super) suffix: String,
    pub(super) finish: bool,
    pub(super) final_text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ProjectedText {
    Live(BTreeMap<String, AgentTimelineLiveTextV1>),
    Completed {
        kind: AgentTimelineTextKindV1,
        text: String,
    },
}

#[derive(Default)]
pub(super) struct CodexTimelineProjection {
    pub(super) provider_items: BTreeSet<String>,
    pub(super) client_messages: BTreeSet<String>,
    pub(super) text: BTreeMap<String, ProjectedText>,
    text_provider_ids_by_turn: BTreeMap<String, Vec<AgentProviderMessageIdV1>>,
    pub(super) tools: BTreeMap<String, AgentTimelineItemBodyV1>,
    pub(super) turn_by_client_message: BTreeMap<String, AgentTurnIdV1>,
    pub(super) turn_lifecycle: BTreeMap<String, AgentTimelineLifecycleStateV1>,
    conversation_title: Option<String>,
}

impl CodexTimelineProjection {
    pub(super) fn file_approval_input(
        &self,
        thread_id: &str,
        method: &str,
        params: &Value,
    ) -> Option<&Value> {
        if method != "item/fileChange/requestApproval"
            || params.get("threadId").and_then(Value::as_str) != Some(thread_id)
        {
            return None;
        }
        let item_id = params.get("itemId")?.as_str()?;
        let provider_id = provider_message_id(item_id).ok()?;
        match self.tools.get(provider_id.as_str())? {
            AgentTimelineItemBodyV1::Tool {
                name,
                state: AgentTimelineToolStateV1::Running,
                input,
                ..
            } if name == "fileChange" => input.as_ref(),
            _ => None,
        }
    }

    /// Adopts a provider-reported conversation title. Returns true when the
    /// title actually changed, i.e. a new evidence row is worth appending.
    /// Empty and cleared titles never regress an already-shown one.
    pub(super) fn adopt_conversation_title(&mut self, title: &str) -> bool {
        let title = title.trim();
        if title.is_empty() || self.conversation_title.as_deref() == Some(title) {
            return false;
        }
        self.conversation_title = Some(title.to_owned());
        true
    }

    pub(super) fn absorb_row(&mut self, row: &AgentTimelineRowV1) {
        if let AgentTimelineItemBodyV1::ProviderEvidence { kind, value, .. } = &row.item.body
            && kind == "conversation_title"
            && let Some(title) = value.get("title").and_then(Value::as_str)
        {
            self.conversation_title = Some(title.to_owned());
        }
        if let Some(client_message_id) = &row.item.client_message_id {
            self.client_messages
                .insert(client_message_id.as_str().into());
            if let Some(turn_id) = &row.item.turn_id {
                self.turn_by_client_message
                    .insert(client_message_id.as_str().into(), turn_id.clone());
            }
        }
        if let (Some(turn_id), AgentTimelineItemBodyV1::Lifecycle { state, .. }) =
            (&row.item.turn_id, &row.item.body)
        {
            self.turn_lifecycle
                .insert(turn_id.as_str().into(), state.clone());
        }
        let Some(provider_message_id) = &row.item.provider_message_id else {
            return;
        };
        let provider_key = provider_message_id.as_str().to_owned();
        self.provider_items.insert(provider_key.clone());
        if matches!(
            &row.item.body,
            AgentTimelineItemBodyV1::Message {
                role: AgentTimelineMessageRoleV1::Assistant,
                ..
            } | AgentTimelineItemBodyV1::Reasoning { .. }
        ) {
            self.remember_text_provider(row.item.turn_id.as_ref(), provider_message_id);
        }
        match &row.item.body {
            AgentTimelineItemBodyV1::Message {
                role: AgentTimelineMessageRoleV1::Assistant,
                markdown,
            } => {
                self.text.insert(
                    provider_key,
                    ProjectedText::Completed {
                        kind: AgentTimelineTextKindV1::Assistant,
                        text: markdown.clone(),
                    },
                );
            }
            AgentTimelineItemBodyV1::Reasoning { text } => {
                if let Some(ProjectedText::Completed {
                    kind: AgentTimelineTextKindV1::Reasoning,
                    text: existing,
                }) = self.text.get_mut(&provider_key)
                {
                    if !existing.is_empty() && !text.is_empty() {
                        existing.push_str("\n\n");
                    }
                    existing.push_str(text);
                } else {
                    self.text.insert(
                        provider_key,
                        ProjectedText::Completed {
                            kind: AgentTimelineTextKindV1::Reasoning,
                            text: text.clone(),
                        },
                    );
                }
            }
            body @ AgentTimelineItemBodyV1::Tool { .. } => {
                self.tools.insert(provider_key, body.clone());
            }
            _ => {}
        }
    }

    pub(super) fn absorb_live_text(&mut self, live: &AgentTimelineLiveTextV1) {
        if let Some(client_message_id) = &live.client_message_id {
            self.client_messages
                .insert(client_message_id.as_str().into());
            if let Some(turn_id) = &live.turn_id {
                self.turn_by_client_message
                    .insert(client_message_id.as_str().into(), turn_id.clone());
            }
        }
        let provider_key = live.provider_message_id.as_str().to_owned();
        self.provider_items.insert(provider_key.clone());
        self.remember_text_provider(live.turn_id.as_ref(), &live.provider_message_id);
        match self.text.entry(provider_key) {
            std::collections::btree_map::Entry::Occupied(mut entry) => match entry.get_mut() {
                ProjectedText::Live(streams) => {
                    streams.insert(live.stream_id.as_str().into(), live.clone());
                }
                completed @ ProjectedText::Completed { .. } => {
                    *completed = ProjectedText::Live(BTreeMap::from([(
                        live.stream_id.as_str().into(),
                        live.clone(),
                    )]));
                }
            },
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(ProjectedText::Live(BTreeMap::from([(
                    live.stream_id.as_str().into(),
                    live.clone(),
                )])));
            }
        }
    }

    pub(super) fn remember_text_provider(
        &mut self,
        turn_id: Option<&AgentTurnIdV1>,
        provider_message_id: &AgentProviderMessageIdV1,
    ) {
        let Some(turn_id) = turn_id else {
            return;
        };
        let providers = self
            .text_provider_ids_by_turn
            .entry(turn_id.as_str().into())
            .or_default();
        if !providers.contains(provider_message_id) {
            providers.push(provider_message_id.clone());
        }
    }

    pub(super) fn provider_for_history_text(
        &self,
        turn_id: &AgentTurnIdV1,
        kind: &AgentTimelineTextKindV1,
        ordinal: usize,
        observed: &AgentProviderMessageIdV1,
    ) -> AgentProviderMessageIdV1 {
        // App-server guarantees item identity within one streamed lifecycle. A
        // resumed snapshot can rematerialize the same turn with different item
        // ids, so its ordered turn shape selects the already durable identity.
        if self.text.contains_key(observed.as_str()) {
            return observed.clone();
        }
        self.text_provider_ids_by_turn
            .get(turn_id.as_str())
            .into_iter()
            .flatten()
            .filter(|provider_message_id| {
                self.text
                    .get(provider_message_id.as_str())
                    .is_some_and(|text| text.has_kind(kind))
            })
            .nth(ordinal)
            .cloned()
            .unwrap_or_else(|| observed.clone())
    }
}

impl ProjectedText {
    fn has_kind(&self, expected: &AgentTimelineTextKindV1) -> bool {
        match self {
            Self::Live(streams) => streams.values().any(|stream| &stream.kind == expected),
            Self::Completed { kind, .. } => kind == expected,
        }
    }
}

pub(super) fn turn_client_message_id(
    turn: &Value,
) -> Result<AgentClientMessageIdV1, AgentProviderCommandErrorV1> {
    if let Some(client_message_id) = turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("userMessage"))
        .and_then(|item| item.get("clientId"))
        .and_then(Value::as_str)
        .and_then(|id| AgentClientMessageIdV1::new(id.to_owned()).ok())
    {
        return Ok(client_message_id);
    }
    let provider_turn_id = field_string(turn, "id")?;
    AgentClientMessageIdV1::new(format!(
        "codex-message-{}",
        &digest(&json!(provider_turn_id))[..24]
    ))
    .map_err(|_| AgentProviderCommandErrorV1::new("event_invalid", "invalid client message id"))
}

pub(super) fn codex_turn_id(
    provider_turn_id: &str,
) -> Result<AgentTurnIdV1, AgentProviderCommandErrorV1> {
    AgentTurnIdV1::new(format!(
        "codex-turn-{}",
        &digest(&json!(provider_turn_id))[..24]
    ))
    .map_err(|_| AgentProviderCommandErrorV1::new("event_invalid", "invalid turn id"))
}

pub(super) fn provider_timestamp_ms(
    value: &Value,
    field: &str,
) -> Result<Option<i64>, AgentProviderCommandErrorV1> {
    let Some(seconds) = value.get(field) else {
        return Ok(None);
    };
    if seconds.is_null() {
        return Ok(None);
    }
    let seconds = seconds.as_i64().ok_or_else(|| {
        AgentProviderCommandErrorV1::new("event_invalid", format!("invalid {field}"))
    })?;
    seconds
        .checked_mul(1_000)
        .map(Some)
        .ok_or_else(|| AgentProviderCommandErrorV1::new("event_invalid", "timestamp overflow"))
}

pub(super) fn terminal_turn_state(turn: &Value) -> Option<AgentTimelineLifecycleStateV1> {
    match turn.get("status").and_then(Value::as_str) {
        Some("completed") => Some(AgentTimelineLifecycleStateV1::TurnCompleted),
        Some("interrupted") => Some(AgentTimelineLifecycleStateV1::TurnCanceled),
        Some("failed") => Some(AgentTimelineLifecycleStateV1::TurnFailed),
        _ => None,
    }
}

/// Classifies the app-server's `TurnError.codexErrorInfo` into the shared
/// turn-failure vocabulary. The enum is the provider's own contract (codex
/// app-server protocol v2), so no text matching is involved. `None` means the
/// error carried no classification at all.
pub(super) fn codex_error_reason(error: &Value) -> Option<AgentTurnFailureReasonV1> {
    match error.get("codexErrorInfo")? {
        Value::String(info) => Some(match info.as_str() {
            "usageLimitExceeded" => AgentTurnFailureReasonV1::UsageLimit,
            "rateLimitExceeded" => AgentTurnFailureReasonV1::RateLimit,
            "unauthorized" => AgentTurnFailureReasonV1::AuthenticationFailed,
            "contextWindowExceeded" => AgentTurnFailureReasonV1::ContextWindowExceeded,
            _ => AgentTurnFailureReasonV1::ProviderError,
        }),
        // Transport variants ({httpConnectionFailed: {httpStatusCode}}, ...)
        // only classify through the upstream HTTP status they forward.
        Value::Object(info) => Some(
            match info
                .values()
                .next()
                .and_then(|detail| detail.get("httpStatusCode"))
                .and_then(Value::as_u64)
            {
                Some(401 | 403) => AgentTurnFailureReasonV1::AuthenticationFailed,
                Some(429) => AgentTurnFailureReasonV1::RateLimit,
                _ => AgentTurnFailureReasonV1::ProviderError,
            },
        ),
        _ => None,
    }
}

/// The reason a failed turn carries as its lifecycle detail; `None` for any
/// other terminal status, so callers cannot attach a reason to a completed
/// or interrupted turn.
pub(super) fn turn_failure_reason(turn: &Value) -> Option<AgentTurnFailureReasonV1> {
    if turn.get("status").and_then(Value::as_str) != Some("failed") {
        return None;
    }
    Some(
        turn.get("error")
            .and_then(codex_error_reason)
            .unwrap_or(AgentTurnFailureReasonV1::ProviderError),
    )
}

pub(super) fn text_delta_method(kind: &AgentTimelineTextKindV1) -> &'static str {
    match kind {
        AgentTimelineTextKindV1::Assistant => "item/agentMessage/delta",
        AgentTimelineTextKindV1::Reasoning => "item/reasoning/summaryTextDelta",
        AgentTimelineTextKindV1::ToolInput => "item/toolInput/delta",
    }
}

pub(super) fn should_append_tool_snapshot(
    existing: Option<&AgentTimelineItemBodyV1>,
    candidate: &AgentTimelineItemBodyV1,
) -> Result<bool, AgentProviderCommandErrorV1> {
    let AgentTimelineItemBodyV1::Tool {
        state: candidate_state,
        ..
    } = candidate
    else {
        return Err(history_conflict("Codex tool candidate is not a tool"));
    };
    let Some(existing) = existing else {
        return Ok(true);
    };
    let AgentTimelineItemBodyV1::Tool {
        state: existing_state,
        ..
    } = existing
    else {
        return Err(history_conflict(
            "provider item identity changed from a non-tool to a tool",
        ));
    };
    if *existing_state != AgentTimelineToolStateV1::Running {
        if *candidate_state == AgentTimelineToolStateV1::Running || existing == candidate {
            return Ok(false);
        }
        return Err(history_conflict(
            "terminal Codex tool snapshot changed after it was committed",
        ));
    }
    if *candidate_state == AgentTimelineToolStateV1::Running {
        if existing == candidate {
            return Ok(false);
        }
        return Err(history_conflict(
            "running Codex tool input changed for the same item",
        ));
    }
    Ok(true)
}

pub(super) fn assistant_text_plan(
    live_text: &str,
    snapshot_text: &str,
    terminal: bool,
) -> Result<AssistantTextPlan, AgentProviderCommandErrorV1> {
    let suffix = if let Some(suffix) = snapshot_text.strip_prefix(live_text) {
        suffix.to_owned()
    } else if live_text.starts_with(snapshot_text) {
        String::new()
    } else {
        return Err(history_conflict(
            "assistant live text is not a prefix of the Codex thread snapshot",
        ));
    };
    let final_text = if suffix.is_empty() {
        live_text.to_owned()
    } else {
        snapshot_text.to_owned()
    };
    Ok(AssistantTextPlan {
        suffix,
        finish: terminal,
        final_text,
    })
}

pub(super) fn history_conflict(detail: impl Into<String>) -> AgentProviderCommandErrorV1 {
    AgentProviderCommandErrorV1::new("codex_history_conflict", detail)
}

pub(super) fn is_tool_item(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some(
            "commandExecution"
                | "fileChange"
                | "mcpToolCall"
                | "dynamicToolCall"
                | "collabAgentToolCall"
                | "webSearch"
                | "imageView"
                | "imageGeneration"
        )
    )
}

pub(super) fn snapshot_tool_state(
    item: &Value,
    terminal_phase: bool,
) -> Result<AgentTimelineToolStateV1, AgentProviderCommandErrorV1> {
    match item.get("status").and_then(Value::as_str) {
        Some("completed") => Ok(AgentTimelineToolStateV1::Completed),
        Some("declined" | "interrupted" | "canceled") => Ok(AgentTimelineToolStateV1::Canceled),
        Some("failed") => Ok(AgentTimelineToolStateV1::Failed),
        Some("inProgress" | "running") if terminal_phase => Err(history_conflict(
            "terminal Codex turn contains a running tool snapshot",
        )),
        Some("inProgress" | "running") => Ok(AgentTimelineToolStateV1::Running),
        Some(status) => Err(history_conflict(format!(
            "unknown Codex tool status {status}"
        ))),
        None if terminal_phase => Ok(AgentTimelineToolStateV1::Completed),
        None => Ok(AgentTimelineToolStateV1::Running),
    }
}

pub(super) fn completed_text(item: &Value) -> Option<String> {
    match item.get("type").and_then(Value::as_str) {
        Some("agentMessage") => item.get("text").and_then(Value::as_str).map(str::to_owned),
        Some("reasoning") => {
            let values = item
                .get("summary")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .chain(
                    item.get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten(),
                )
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            (!values.is_empty()).then(|| values.join("\n\n"))
        }
        _ => None,
    }
}

pub(super) fn tool_input(item: &Value) -> Value {
    compact_value(
        &json!({
            "command": item.get("command"),
            "cwd": item.get("cwd"),
            "changes": item.get("changes"),
            "arguments": item.get("arguments"),
            "prompt": item.get("prompt"),
            "tool": item.get("tool"),
        }),
        48 * 1024,
    )
}

pub(super) fn tool_output(item: &Value) -> Value {
    compact_value(
        &json!({
            "status": item.get("status"),
            "exitCode": item.get("exitCode"),
            "durationMs": item.get("durationMs"),
            "aggregatedOutput": item.get("aggregatedOutput"),
            "result": item.get("result"),
            "error": item.get("error"),
            "contentItems": item.get("contentItems"),
        }),
        64 * 1024,
    )
}

pub(super) fn compact_value(value: &Value, limit: usize) -> Value {
    match serde_json::to_vec(value) {
        Ok(encoded) if encoded.len() <= limit => value.clone(),
        _ => json!({ "truncated": true }),
    }
}

pub(super) fn field_string<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, AgentProviderCommandErrorV1> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        AgentProviderCommandErrorV1::new("event_invalid", format!("missing {field}"))
    })
}

pub(super) fn timeline_item_id(
    key: &str,
    scope: &str,
) -> Result<AgentTimelineItemIdV1, AgentProviderCommandErrorV1> {
    AgentTimelineItemIdV1::new(format!("codex-item-{}", digest(&json!([key, scope]))))
        .map_err(|_| AgentProviderCommandErrorV1::new("event_invalid", "invalid item id"))
}

pub(super) fn timeline_stream_id(
    key: &str,
    scope: &str,
) -> Result<AgentTimelineStreamIdV1, AgentProviderCommandErrorV1> {
    AgentTimelineStreamIdV1::new(format!("codex-stream-{}", digest(&json!([key, scope]))))
        .map_err(|_| AgentProviderCommandErrorV1::new("event_invalid", "invalid stream id"))
}

pub(super) fn provider_message_id(
    value: &str,
) -> Result<AgentProviderMessageIdV1, AgentProviderCommandErrorV1> {
    AgentProviderMessageIdV1::new(format!("codex-message-{}", digest(&json!(value))))
        .map_err(|_| AgentProviderCommandErrorV1::new("event_invalid", "invalid message id"))
}

pub(super) fn interaction_request_id(
    connection_generation: &str,
    method: &str,
    id: &Value,
) -> Result<AgentInteractionRequestIdV1, AgentProviderCommandErrorV1> {
    AgentInteractionRequestIdV1::new(format!(
        "codex-request-{}",
        digest(&json!([connection_generation, method, id]))
    ))
    .map_err(|_| AgentProviderCommandErrorV1::new("event_invalid", "invalid request id"))
}

pub(super) fn provider_request_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_default()
}

pub(super) fn source_fingerprint(method: &str, source: &Value) -> String {
    format!("sha256:{}", digest(&json!([method, source])))
}

fn digest(value: &Value) -> String {
    let source = serde_json::to_vec(value).unwrap_or_default();
    format!("{:x}", Sha256::digest(source))
}

#[cfg(test)]
mod turn_failure_reason_tests {
    use super::*;

    fn failed(error: Value) -> Value {
        json!({ "id": "turn-1", "status": "failed", "items": [], "error": error })
    }

    #[test]
    fn maps_the_app_server_error_enum_onto_the_shared_vocabulary() {
        for (info, expected) in [
            ("usageLimitExceeded", AgentTurnFailureReasonV1::UsageLimit),
            ("rateLimitExceeded", AgentTurnFailureReasonV1::RateLimit),
            (
                "unauthorized",
                AgentTurnFailureReasonV1::AuthenticationFailed,
            ),
            (
                "contextWindowExceeded",
                AgentTurnFailureReasonV1::ContextWindowExceeded,
            ),
            (
                "internalServerError",
                AgentTurnFailureReasonV1::ProviderError,
            ),
            ("someFutureVariant", AgentTurnFailureReasonV1::ProviderError),
        ] {
            let turn = failed(json!({ "message": "m", "codexErrorInfo": info }));
            assert_eq!(turn_failure_reason(&turn), Some(expected), "{info}");
        }
    }

    #[test]
    fn transport_variants_classify_only_through_their_http_status() {
        let unauthorized = failed(json!({
            "message": "m",
            "codexErrorInfo": { "responseStreamConnectionFailed": { "httpStatusCode": 401 } }
        }));
        assert_eq!(
            turn_failure_reason(&unauthorized),
            Some(AgentTurnFailureReasonV1::AuthenticationFailed)
        );
        let throttled = failed(json!({
            "message": "m",
            "codexErrorInfo": { "httpConnectionFailed": { "httpStatusCode": 429 } }
        }));
        assert_eq!(
            turn_failure_reason(&throttled),
            Some(AgentTurnFailureReasonV1::RateLimit)
        );
        let dropped = failed(json!({
            "message": "m",
            "codexErrorInfo": { "responseStreamDisconnected": { "httpStatusCode": null } }
        }));
        assert_eq!(
            turn_failure_reason(&dropped),
            Some(AgentTurnFailureReasonV1::ProviderError)
        );
    }

    #[test]
    fn a_failed_turn_without_classification_is_a_provider_error() {
        assert_eq!(
            turn_failure_reason(&failed(json!({ "message": "boom" }))),
            Some(AgentTurnFailureReasonV1::ProviderError)
        );
        assert_eq!(
            turn_failure_reason(&json!({ "id": "turn-1", "status": "failed" })),
            Some(AgentTurnFailureReasonV1::ProviderError)
        );
        assert_eq!(codex_error_reason(&json!({ "message": "boom" })), None);
    }

    #[test]
    fn only_a_failed_status_carries_a_reason() {
        for status in ["completed", "interrupted", "inProgress"] {
            let turn = json!({
                "id": "turn-1",
                "status": status,
                "error": { "message": "m", "codexErrorInfo": "usageLimitExceeded" }
            });
            assert_eq!(turn_failure_reason(&turn), None, "{status}");
        }
    }
}
