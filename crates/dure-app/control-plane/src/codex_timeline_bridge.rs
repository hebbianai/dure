use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentClientMessageIdV1, AgentInteractionBindingV1,
    AgentInteractionRequestIdV1, AgentInterruptTurnRequestV1, AgentPendingAnswerIntentV1,
    AgentPendingRequestDraftV1, AgentPendingRequestKindV1, AgentPendingRequestV1,
    AgentPendingSnapshotV1, AgentProviderEventCommitV1, AgentProviderEventIdentityV1,
    AgentProviderMessageIdV1, AgentStartTurnIntentV1, AgentTimelineItemBodyV1,
    AgentTimelineItemDraftV1, AgentTimelineLifecycleStateV1, AgentTimelineLiveTextV1,
    AgentTimelineMessageRoleV1, AgentTimelineMutationV1, AgentTimelineReadDirectionV1,
    AgentTimelineReadRequestV1, AgentTimelineReadV1, AgentTimelineRowV1, AgentTimelineStore,
    AgentTimelineTextFragmentV1, AgentTimelineTextKindV1, AgentTimelineToolStateV1, AgentTurnIdV1,
    MAX_AGENT_TIMELINE_EVENT_MUTATIONS_V1, MAX_AGENT_TIMELINE_PAGE_ITEMS_V1,
};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, oneshot, watch};
use tokio::time::{Duration, timeout};

use crate::agent_conversation::{
    AgentConversationService, AgentProviderCommandErrorV1, AgentProviderCommandFuture,
    AgentProviderCommands,
};
use crate::codex_app_server_protocol::provider_catalog_from_model_list;
use crate::json_rpc_socket_client::{
    JsonRpcSocketClient, JsonRpcSocketClientError, JsonRpcSocketIncoming, JsonRpcSocketIncomingV1,
};
use crate::provider_turn_settings::ProviderTurnSettings;

mod commands;
mod events;
mod history;
mod projection;

use projection::*;

const PENDING_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone)]
struct ActiveTurn {
    turn_id: AgentTurnIdV1,
    client_message_id: AgentClientMessageIdV1,
    provider_turn_id: Option<String>,
}

struct PendingAnswerFlight {
    delivered: watch::Receiver<bool>,
    confirmed: oneshot::Sender<()>,
    idempotency_key: String,
    provider_receipt: Value,
}

struct PendingRoute {
    request_id: AgentInteractionRequestIdV1,
    answer: Option<PendingAnswerFlight>,
}

struct PendingConfirmationGuard {
    client: JsonRpcSocketClient,
    armed: bool,
}

impl PendingConfirmationGuard {
    fn new(client: &JsonRpcSocketClient) -> Self {
        Self {
            client: client.clone(),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingConfirmationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.client.disconnect();
        }
    }
}

pub(crate) struct CodexTimelineBridge<S> {
    binding: AgentInteractionBindingV1,
    client: JsonRpcSocketClient,
    thread_id: String,
    settings: ProviderTurnSettings,
    service: Arc<AgentConversationService<S>>,
    sequence: Mutex<i64>,
    connection_generation: String,
    active_turn: Mutex<Option<ActiveTurn>>,
    conversation_established: Mutex<bool>,
    connected: AtomicBool,
    accepting_turns: AtomicBool,
    pending_routes: Mutex<BTreeMap<String, PendingRoute>>,
    timeline_projection: Mutex<CodexTimelineProjection>,
}

impl<S> CodexTimelineBridge<S>
where
    S: AgentTimelineStore + 'static,
{
    pub(crate) async fn new(
        binding: AgentInteractionBindingV1,
        client: JsonRpcSocketClient,
        thread_id: String,
        settings: ProviderTurnSettings,
        service: Arc<AgentConversationService<S>>,
    ) -> Result<Self, AgentProviderCommandErrorV1> {
        let sequence = service
            .provider_cursor(&binding.interaction_session_id, &binding.runtime)
            .await
            .map_err(conversation_error)?
            .committed_through_sequence;
        let conversation_established = binding.provider_conversation_ref.is_some();
        let bridge = Self {
            binding,
            client,
            thread_id,
            settings,
            service,
            sequence: Mutex::new(sequence),
            connection_generation: connection_generation()?,
            active_turn: Mutex::new(None),
            conversation_established: Mutex::new(conversation_established),
            connected: AtomicBool::new(true),
            accepting_turns: AtomicBool::new(true),
            pending_routes: Mutex::new(BTreeMap::new()),
            timeline_projection: Mutex::new(CodexTimelineProjection::default()),
        };
        bridge.reconcile_empty_pending_snapshot().await?;
        Ok(bridge)
    }

    pub(crate) fn spawn(
        self: &Arc<Self>,
        mut incoming: JsonRpcSocketIncoming,
    ) -> tokio::task::JoinHandle<()> {
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                if bridge.handle_incoming(event).await.is_err() {
                    break;
                }
            }
            bridge.accepting_turns.store(false, Ordering::SeqCst);
            bridge.connected.store(false, Ordering::SeqCst);
            bridge.client.disconnect();
            let _ = bridge.reconcile_empty_pending_snapshot().await;
            bridge.pending_routes.lock().await.clear();
        })
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst) && self.client.is_connected()
    }

    async fn reconcile_empty_pending_snapshot(&self) -> Result<(), AgentProviderCommandErrorV1> {
        let observed_through_sequence = *self.sequence.lock().await;
        self.service
            .reconcile_pending_snapshot(&AgentPendingSnapshotV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: self.binding.interaction_session_id.clone(),
                runtime: self.binding.runtime.clone(),
                observed_through_sequence,
                requests: Vec::new(),
                observed_at_ms: now_ms()?,
            })
            .await
            .map_err(conversation_error)?;
        Ok(())
    }

    pub(crate) async fn begin_idle_drain(&self) -> bool {
        self.accepting_turns.store(false, Ordering::SeqCst);
        self.active_turn.lock().await.is_none()
    }

    pub(crate) fn cancel_drain(&self) {
        self.accepting_turns.store(true, Ordering::SeqCst);
    }

    pub(crate) async fn hydrate_active_turn(
        &self,
        thread: &Value,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        let Some(turn) = thread
            .get("turns")
            .and_then(Value::as_array)
            .and_then(|turns| turns.last())
            .filter(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress"))
        else {
            return Ok(());
        };
        let provider_turn_id = field_string(turn, "id")?.to_owned();
        let projection = self.timeline_projection.lock().await;
        let client_message_id = turn_client_message_id(turn)?;
        let turn_id = projection
            .turn_by_client_message
            .get(client_message_id.as_str())
            .cloned()
            .unwrap_or(codex_turn_id(&provider_turn_id)?);
        drop(projection);
        *self.active_turn.lock().await = Some(ActiveTurn {
            turn_id,
            client_message_id,
            provider_turn_id: Some(provider_turn_id),
        });
        Ok(())
    }

    pub(crate) async fn record_session_ready(&self) -> Result<(), AgentProviderCommandErrorV1> {
        // The logical session outlives replaceable empty Codex threads, so its
        // lifecycle row must replay with identical identity and content.
        self.commit(
            "thread/ready",
            &json!({ "threadId": self.thread_id }),
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: timeline_item_id(
                        "session-ready",
                        self.binding.interaction_session_id.as_str(),
                    )?,
                    turn_id: None,
                    client_message_id: None,
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: AgentTimelineLifecycleStateV1::SessionReady,
                        detail: None,
                    },
                    created_at_ms: self.binding.created_at_ms,
                },
            }],
        )
        .await?;

        let provider_catalog = self
            .client
            .request(
                "model/list",
                json!({ "includeHidden": false, "limit": 100 }),
            )
            .await
            .ok()
            .and_then(|response| provider_catalog_from_model_list(&response));
        let Some(catalog) = provider_catalog else {
            return Ok(());
        };
        let Ok(item) = provider_catalog_draft(&self.binding, &catalog) else {
            return Ok(());
        };
        // Picker discovery is optional evidence. Provider/version gaps or a
        // rejected observation never revoke an otherwise ready conversation.
        let _ = self
            .commit(
                "model/list",
                &catalog,
                vec![AgentTimelineMutationV1::Append { item }],
            )
            .await;
        Ok(())
    }

    pub(crate) async fn establish_thread(
        &self,
        established_at_ms: i64,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        let mut conversation_established = self.conversation_established.lock().await;
        if *conversation_established {
            return Ok(());
        }
        self.commit(
            "thread/established",
            &json!({ "threadId": self.thread_id }),
            vec![AgentTimelineMutationV1::EstablishProviderConversation {
                provider_conversation_ref: self.thread_id.clone(),
                established_at_ms,
            }],
        )
        .await?;
        *conversation_established = true;
        Ok(())
    }

    async fn commit(
        &self,
        method: &str,
        source: &Value,
        mutations: Vec<AgentTimelineMutationV1>,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        let mut sequence = self.sequence.lock().await;
        let next_sequence = sequence.checked_add(1).ok_or_else(|| {
            AgentProviderCommandErrorV1::new("codex_timeline_store", "provider sequence overflow")
        })?;
        let event = AgentProviderEventCommitV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: self.binding.interaction_session_id.clone(),
            event: AgentProviderEventIdentityV1 {
                runtime: self.binding.runtime.clone(),
                sequence: next_sequence,
            },
            source_fingerprint: source_fingerprint(method, source),
            mutations,
            recorded_at_ms: now_ms()?,
        };
        self.service
            .commit_provider_event(&event)
            .await
            .map_err(conversation_error)?;
        *sequence = next_sequence;
        Ok(())
    }

    fn item(
        &self,
        key: &str,
        body: AgentTimelineItemBodyV1,
        turn_id: Option<AgentTurnIdV1>,
        client_message_id: Option<AgentClientMessageIdV1>,
        provider_message_id: Option<AgentProviderMessageIdV1>,
        created_at_ms: i64,
    ) -> Result<AgentTimelineItemDraftV1, AgentProviderCommandErrorV1> {
        self.item_for_turn(
            key,
            &format!("live:{created_at_ms}"),
            body,
            TimelineItemContext {
                turn_id,
                client_message_id,
                provider_message_id,
                created_at_ms,
            },
        )
    }

    fn item_for_turn(
        &self,
        key: &str,
        scope: &str,
        body: AgentTimelineItemBodyV1,
        context: TimelineItemContext,
    ) -> Result<AgentTimelineItemDraftV1, AgentProviderCommandErrorV1> {
        Ok(AgentTimelineItemDraftV1 {
            item_id: timeline_item_id(key, &format!("{}:{scope}", self.thread_id))?,
            turn_id: context.turn_id,
            client_message_id: context.client_message_id,
            provider_message_id: context.provider_message_id,
            body,
            created_at_ms: context.created_at_ms,
        })
    }

    fn tool_item(
        &self,
        item: &Value,
        state: AgentTimelineToolStateV1,
        turn_id: Option<AgentTurnIdV1>,
        client_message_id: Option<AgentClientMessageIdV1>,
        created_at_ms: i64,
    ) -> Result<AgentTimelineItemDraftV1, AgentProviderCommandErrorV1> {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("codex-tool");
        let name = item.get("type").and_then(Value::as_str).unwrap_or("tool");
        let terminal = state != AgentTimelineToolStateV1::Running;
        Ok(AgentTimelineItemDraftV1 {
            item_id: timeline_item_id(id, &format!("{name}:{state:?}"))?,
            turn_id,
            client_message_id,
            provider_message_id: Some(provider_message_id(id)?),
            body: AgentTimelineItemBodyV1::Tool {
                tool_call_id: id.into(),
                name: name.into(),
                state,
                input: Some(tool_input(item)),
                output: terminal.then(|| tool_output(item)),
            },
            created_at_ms,
        })
    }

    fn exact_binding(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        if !self.binding.same_runtime_authority(binding) {
            return Err(AgentProviderCommandErrorV1::new(
                "stale_runtime",
                "Codex app-server binding is stale",
            ));
        }
        Ok(())
    }
}

fn is_mcp_tool_approval(params: &Value) -> bool {
    params
        .pointer("/_meta/codex_approval_kind")
        .and_then(Value::as_str)
        == Some("mcp_tool_call")
}

fn normalized_pending_payload(method: &str, id: &Value, params: &Value) -> Value {
    let provider_request = json!({ "id": id, "method": method, "params": params });
    if method == "item/tool/requestUserInput" {
        let questions = params
            .get("questions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|question| {
                let options = question
                    .get("options")
                    .filter(|options| options.is_array())
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                json!({
                    "id": question.get("id"),
                    "header": question.get("header"),
                    "question": question.get("question"),
                    "multiSelect": false,
                    "allowOther": question.get("isOther").and_then(Value::as_bool).unwrap_or(false),
                    "isSecret": question.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                    "options": options,
                })
            })
            .collect::<Vec<_>>();
        return json!({ "input": { "questions": questions }, "providerRequest": provider_request });
    }
    let mcp_tool_approval =
        method == "mcpServer/elicitation/request" && is_mcp_tool_approval(params);
    let description = params
        .get("message")
        .filter(|_| mcp_tool_approval)
        .and_then(Value::as_str)
        .or_else(|| params.get("reason").and_then(Value::as_str));
    let description = description.or_else(|| params.get("command").and_then(Value::as_str));
    let blocked_path = params
        .get("cwd")
        .and_then(Value::as_str)
        .or_else(|| params.get("grantRoot").and_then(Value::as_str));
    let mut payload = json!({
        "presentation": {
            "description": description,
            "blockedPath": blocked_path,
        },
        "providerRequest": provider_request,
    });
    if mcp_tool_approval
        && let Some(meta) = payload
            .pointer_mut("/providerRequest/params/_meta")
            .and_then(Value::as_object_mut)
        && let Some(input) = meta.remove("tool_params")
    {
        // Move arguments into the common presentation without growing the bounded payload.
        payload["input"] = input;
    }
    if method == "item/commandExecution/requestApproval"
        && let Some(route) = payload
            .pointer_mut("/providerRequest/params")
            .and_then(Value::as_object_mut)
        && route.get("command").is_some_and(Value::is_string)
        && let Some(command) = route.remove("command")
    {
        payload["input"] = json!({ "command": command });
    }
    payload
}

/// The provider-owned conversation title ("thread name" in codex UIs) rides
/// the timeline as durable evidence; pane headers and the Spaces navigator
/// read the newest value. The agent name stays the only user-renamable
/// identity — this is a description, never an identity.
fn conversation_title_draft(
    thread_id: &str,
    title: &str,
    observed_at_ms: i64,
) -> Result<AgentTimelineItemDraftV1, AgentProviderCommandErrorV1> {
    Ok(AgentTimelineItemDraftV1 {
        item_id: timeline_item_id(
            "conversation-title",
            &format!("{thread_id}:live:{observed_at_ms}"),
        )?,
        turn_id: None,
        client_message_id: None,
        provider_message_id: None,
        body: AgentTimelineItemBodyV1::ProviderEvidence {
            namespace: "provider.codex".into(),
            kind: "conversation_title".into(),
            value: json!({ "title": title }),
        },
        created_at_ms: observed_at_ms,
    })
}

fn provider_catalog_draft(
    binding: &AgentInteractionBindingV1,
    catalog: &Value,
) -> Result<AgentTimelineItemDraftV1, AgentProviderCommandErrorV1> {
    Ok(AgentTimelineItemDraftV1 {
        item_id: timeline_item_id(
            "provider-catalog",
            &format!(
                "{}:{}:{}",
                binding.runtime.runtime_generation,
                binding.runtime.provider_epoch,
                source_fingerprint("model/list", catalog),
            ),
        )?,
        turn_id: None,
        client_message_id: None,
        provider_message_id: None,
        body: AgentTimelineItemBodyV1::ProviderEvidence {
            namespace: "provider.codex".into(),
            kind: "provider_catalog".into(),
            value: catalog.clone(),
        },
        created_at_ms: binding.updated_at_ms,
    })
}

fn notification_belongs_to_thread(method: &str, params: &Value, thread_id: &str) -> bool {
    if method == "thread/started" {
        return params.pointer("/thread/id").and_then(Value::as_str) == Some(thread_id);
    }
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
}

fn notification_turn_id<'a>(method: &str, params: &'a Value) -> Option<&'a str> {
    match method {
        "turn/started" | "turn/completed" => params.pointer("/turn/id").and_then(Value::as_str),
        "item/agentMessage/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta"
        | "turn/plan/updated"
        | "item/started"
        | "item/completed"
        | "error" => params.get("turnId").and_then(Value::as_str),
        _ => None,
    }
}

fn provider_turn_matches(active: &ActiveTurn, observed: Option<&str>) -> bool {
    match (active.provider_turn_id.as_deref(), observed) {
        (Some(expected), Some(observed)) => expected == observed,
        (None, Some(_)) | (_, None) => true,
    }
}

fn pending_response(
    method: &str,
    params: &Value,
    answer: &Value,
) -> Result<Value, AgentProviderCommandErrorV1> {
    let decision = answer.get("decision").and_then(Value::as_str);
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => Ok(json!({
            "decision": if decision == Some("allow") { "accept" } else { "decline" },
        })),
        "mcpServer/elicitation/request" if is_mcp_tool_approval(params) => Ok(json!({
            "action": if decision == Some("allow") { "accept" } else { "decline" },
        })),
        "item/permissions/requestApproval" => {
            let mut permissions = Map::new();
            if decision == Some("allow") {
                for key in ["network", "fileSystem"] {
                    if let Some(value) = params.pointer(&format!("/permissions/{key}"))
                        && !value.is_null()
                    {
                        permissions.insert(key.into(), value.clone());
                    }
                }
            }
            Ok(json!({ "permissions": permissions, "scope": "turn" }))
        }
        "item/tool/requestUserInput" => {
            let submitted = answer.get("answers").and_then(Value::as_object);
            let mut answers = Map::new();
            for question in params
                .get("questions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(id) = question.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(text) = question.get("question").and_then(Value::as_str) else {
                    continue;
                };
                let key = question.get("id").and_then(Value::as_str).unwrap_or(text);
                let values = submitted
                    .and_then(|submitted| submitted.get(key))
                    .and_then(Value::as_str)
                    .map(|value| vec![Value::String(value.into())])
                    .unwrap_or_default();
                answers.insert(id.into(), json!({ "answers": values }));
            }
            Ok(json!({ "answers": answers }))
        }
        _ => Err(AgentProviderCommandErrorV1::new(
            "answer_invalid",
            "unsupported Codex request",
        )),
    }
}

fn provider_client_error(error: JsonRpcSocketClientError) -> AgentProviderCommandErrorV1 {
    AgentProviderCommandErrorV1::new(format!("codex_app_server_{}", error.code), error.detail)
}

fn conversation_error(error: impl std::fmt::Display) -> AgentProviderCommandErrorV1 {
    AgentProviderCommandErrorV1::new("codex_timeline_store", error.to_string())
}

fn connection_generation() -> Result<String, AgentProviderCommandErrorV1> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        AgentProviderCommandErrorV1::new(
            "connection_identity_unavailable",
            "Codex connection identity could not be generated",
        )
    })?;
    let mut generation = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut generation, "{byte:02x}").map_err(|_| {
            AgentProviderCommandErrorV1::new(
                "connection_identity_unavailable",
                "Codex connection identity could not be encoded",
            )
        })?;
    }
    Ok(generation)
}

fn now_ms() -> Result<i64, AgentProviderCommandErrorV1> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AgentProviderCommandErrorV1::new("clock_invalid", "clock before epoch"))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| AgentProviderCommandErrorV1::new("clock_invalid", "clock overflow"))
}

#[cfg(test)]
mod tests {
    use dure_app::{
        AgentExecutionProfileV1, AgentIdV1, AgentInteractionSessionIdV1,
        AgentProviderRuntimeFenceV1, AgentRecordV1, AgentTimelineCursorV1, AgentTimelineEpochV1,
        DomainStore, ProjectIdV1, ProjectRecordV1, ProviderIdV1, ProviderPermissionModeV1,
        WorkspaceIdV1, WorkspaceRecordV1,
    };
    use futures_util::{SinkExt, StreamExt};
    use tempfile::TempDir;
    use tokio::net::UnixListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use super::*;

    async fn conversation_fixture() -> (
        TempDir,
        Arc<AgentConversationService<crate::SqliteDomainStore>>,
        AgentInteractionBindingV1,
    ) {
        let temporary = TempDir::new().unwrap();
        let store = Arc::new(
            crate::SqliteDomainStore::open(temporary.path().join("domain.sqlite"))
                .await
                .unwrap(),
        );
        let project_id = ProjectIdV1::new("project-history").unwrap();
        let workspace_id = WorkspaceIdV1::new("workspace-history").unwrap();
        let agent_id = AgentIdV1::new("agent-history").unwrap();
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: project_id.clone(),
                root_path: temporary.path().to_string_lossy().into_owned(),
                display_name: "History".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id,
                root_path: temporary.path().to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: agent_id.clone(),
                workspace_id,
                provider_id: ProviderIdV1::new("codex").unwrap(),
                display_name: "History".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        let binding = AgentInteractionBindingV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-history")
                .unwrap(),
            agent_id,
            provider_id: ProviderIdV1::new("codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("thread-history".into()),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-history".into(),
                provider_epoch: "provider-history".into(),
            },
            timeline_epoch: AgentTimelineEpochV1::new("timeline-history").unwrap(),
            binding_revision: 1,
            history_complete: false,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
        service.create(&binding).await.unwrap();
        (temporary, service, binding)
    }

    #[tokio::test]
    async fn large_history_and_runtime_catalog_commit_through_the_bounded_event_contract() {
        let (temporary, service, binding) = conversation_fixture().await;
        let socket_path = temporary.path().join("app.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let mut model_list_requests = 0;
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(source) = message else {
                    continue;
                };
                let request: Value = serde_json::from_str(&source).unwrap();
                if request.get("method").and_then(Value::as_str) != Some("model/list") {
                    continue;
                }
                model_list_requests += 1;
                let reply = if model_list_requests == 1 {
                    json!({
                        "id": request.get("id"),
                        "result": {
                            "data": [{
                                "id": "gpt-fixture",
                                "model": "gpt-fixture",
                                "displayName": "GPT Fixture",
                                "supportedReasoningEfforts": [
                                    { "reasoningEffort": "low", "description": "Fast" },
                                    { "reasoningEffort": "ultra", "description": "Deep" },
                                ],
                                "defaultReasoningEffort": "low",
                                "isDefault": true,
                            }],
                            "nextCursor": null,
                        },
                    })
                } else {
                    json!({
                        "id": request.get("id"),
                        "error": { "code": -32601, "message": "method unavailable" },
                    })
                };
                socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .unwrap();
            }
        });
        let (client, incoming) = JsonRpcSocketClient::connect(&socket_path).await.unwrap();
        let bridge = CodexTimelineBridge::new(
            binding.clone(),
            client,
            "thread-history".into(),
            ProviderTurnSettings::new(ProviderPermissionModeV1::Default, None, None),
            Arc::clone(&service),
        )
        .await
        .unwrap();

        let mut items = vec![json!({
            "type": "userMessage",
            "id": "history-user",
            "clientId": "history-client-message",
            "content": [{ "text": "Inspect the workspace" }],
        })];
        items.extend((0..65).map(|index| {
            json!({
                "type": "commandExecution",
                "id": format!("history-command-{index}"),
                "status": "completed",
                "command": "true",
                "aggregatedOutput": "",
                "exitCode": 0,
            })
        }));
        bridge
            .reconcile_history(&json!({
                "id": "thread-history",
                "turns": [{
                    "id": "provider-turn-history",
                    "status": "completed",
                    "startedAt": 1,
                    "completedAt": 2,
                    "items": items,
                }],
            }))
            .await
            .unwrap();
        bridge.record_session_ready().await.unwrap();
        // Catalog discovery is optional and stable: an older provider can
        // reject a later probe without disconnecting or duplicating rows.
        bridge.record_session_ready().await.unwrap();

        let read = service
            .read(&AgentTimelineReadRequestV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: binding.interaction_session_id,
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: MAX_AGENT_TIMELINE_PAGE_ITEMS_V1,
            })
            .await
            .unwrap();
        let AgentTimelineReadV1::Page { page } = read else {
            panic!("history timeline reset unexpectedly");
        };
        assert_eq!(page.rows.len(), 70);
        assert!(page.rows.iter().any(|row| {
            row.item.body
                == AgentTimelineItemBodyV1::ProviderEvidence {
                    namespace: "provider.codex".into(),
                    kind: "provider_catalog".into(),
                    value: json!({
                        "models": [{
                            "value": "gpt-fixture",
                            "displayName": "GPT Fixture",
                            "supportsEffort": true,
                            "supportedEffortLevels": ["low", "ultra"],
                        }],
                    }),
                }
        }));

        drop(bridge);
        drop(incoming);
        server.abort();
    }

    #[tokio::test]
    async fn steering_targets_the_active_provider_turn_without_replacing_its_identity() {
        let (temporary, service, binding) = conversation_fixture().await;
        let socket_path = temporary.path().join("app.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(source))) = socket.next().await {
                let request: Value = serde_json::from_str(&source).unwrap();
                let response = match request["method"].as_str().unwrap() {
                    "turn/start" => json!({"result": {"turn": {"id": "provider-turn"}}}),
                    "turn/steer" if request["params"]["input"][0]["text"] == "rejected" => {
                        json!({"error": {"code": -32000, "message": "turn changed"}})
                    }
                    "turn/steer" => json!({"result": {"turnId": "provider-turn"}}),
                    method => panic!("unexpected provider request {method}"),
                };
                let mut response = response;
                response["id"] = request["id"].clone();
                sent.send(request).unwrap();
                socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .unwrap();
            }
        });
        let (client, incoming) = JsonRpcSocketClient::connect(&socket_path).await.unwrap();
        let bridge = CodexTimelineBridge::new(
            binding.clone(),
            client,
            "thread-history".into(),
            ProviderTurnSettings::new(ProviderPermissionModeV1::AutoEdit, None, None),
            service,
        )
        .await
        .unwrap();
        let initial = AgentStartTurnIntentV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id.clone(),
            runtime: binding.runtime.clone(),
            turn_id: AgentTurnIdV1::new("common-turn").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("initial-message").unwrap(),
            input: "start".into(),
            requested_at_ms: 1,
        };
        assert_eq!(
            bridge
                .steer_turn(&binding, &initial)
                .await
                .unwrap_err()
                .code,
            "turn_not_active"
        );
        bridge.start_turn(&binding, &initial).await.unwrap();
        assert_eq!(received.recv().await.unwrap()["method"], "turn/start");
        let mut steering = initial.clone();
        steering.client_message_id = AgentClientMessageIdV1::new("additional-message").unwrap();
        steering.input = "also make the handoff".into();
        let mut stale_binding = binding.clone();
        stale_binding.runtime.provider_epoch = "replaced".into();
        assert_eq!(
            bridge
                .steer_turn(&stale_binding, &steering)
                .await
                .unwrap_err()
                .code,
            "stale_runtime"
        );
        let mut stale_turn = steering.clone();
        stale_turn.turn_id = AgentTurnIdV1::new("old-turn").unwrap();
        assert_eq!(
            bridge
                .steer_turn(&binding, &stale_turn)
                .await
                .unwrap_err()
                .code,
            "stale_turn"
        );
        assert!(
            received.try_recv().is_err(),
            "stale identities cannot address another provider turn"
        );
        assert_eq!(
            bridge.steer_turn(&binding, &steering).await.unwrap(),
            json!({"turnId": "provider-turn"})
        );
        let request = received.recv().await.unwrap();
        assert_eq!(request["method"], "turn/steer");
        assert_eq!(
            request["params"],
            json!({
                "threadId": "thread-history", "expectedTurnId": "provider-turn",
                "clientUserMessageId": "additional-message",
                "input": [{"type": "text", "text": "also make the handoff", "text_elements": []}],
            })
        );
        steering.input = "rejected".into();
        assert_eq!(
            bridge
                .steer_turn(&binding, &steering)
                .await
                .unwrap_err()
                .detail,
            "turn changed"
        );
        assert_eq!(received.recv().await.unwrap()["method"], "turn/steer");
        assert!(
            received.try_recv().is_err(),
            "a rejected steering request must not start or replay a turn"
        );
        let active = bridge.active_turn.lock().await.clone().unwrap();
        assert_eq!(active.turn_id, initial.turn_id);
        assert_eq!(active.client_message_id, initial.client_message_id);
        assert_eq!(active.provider_turn_id.as_deref(), Some("provider-turn"));
        drop(bridge);
        drop(incoming);
        server.abort();
    }

    #[test]
    fn conversation_title_evidence_converges_to_the_newest_provider_title() {
        let mut projection = CodexTimelineProjection::default();
        assert!(!projection.adopt_conversation_title("   "));
        assert!(projection.adopt_conversation_title("Fix flaky pane recovery"));
        assert!(!projection.adopt_conversation_title("Fix flaky pane recovery"));
        assert!(!projection.adopt_conversation_title(""));
        assert!(projection.adopt_conversation_title("Ship steer support"));

        let draft = conversation_title_draft("thread-1", "Ship steer support", 42).unwrap();
        assert_eq!(draft.created_at_ms, 42);
        assert_eq!(
            draft.body,
            AgentTimelineItemBodyV1::ProviderEvidence {
                namespace: "provider.codex".into(),
                kind: "conversation_title".into(),
                value: json!({ "title": "Ship steer support" }),
            }
        );

        // A reattach replays the stored evidence: absorbing it must converge
        // the projection so the same title is not appended again.
        let mut resumed = CodexTimelineProjection::default();
        resumed.absorb_row(&AgentTimelineRowV1 {
            cursor: AgentTimelineCursorV1 {
                epoch: AgentTimelineEpochV1::new("epoch-1").unwrap(),
                sequence: 7,
            },
            item: draft.clone(),
        });
        assert!(!resumed.adopt_conversation_title("Ship steer support"));
        assert!(resumed.adopt_conversation_title("A different title"));
    }

    #[test]
    fn demultiplexes_root_and_child_thread_notifications() {
        let active = ActiveTurn {
            turn_id: AgentTurnIdV1::new("turn-1").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("message-1").unwrap(),
            provider_turn_id: Some("provider-turn-1".into()),
        };
        let root = json!({ "threadId": "thread-1", "turnId": "provider-turn-1" });
        let child = json!({ "threadId": "child-thread", "turnId": "child-turn" });
        let stale = json!({ "threadId": "thread-1", "turnId": "stale-turn" });

        assert!(notification_belongs_to_thread(
            "item/started",
            &root,
            "thread-1"
        ));
        assert!(!notification_belongs_to_thread(
            "item/started",
            &child,
            "thread-1"
        ));
        assert!(provider_turn_matches(
            &active,
            notification_turn_id("item/started", &root)
        ));
        assert!(!provider_turn_matches(
            &active,
            notification_turn_id("item/started", &stale)
        ));
    }

    #[test]
    fn converges_live_assistant_text_by_appending_only_the_missing_suffix() {
        assert_eq!(
            assistant_text_plan("hel", "hello", false).unwrap(),
            AssistantTextPlan {
                suffix: "lo".into(),
                finish: false,
                final_text: "hello".into(),
            }
        );
        assert_eq!(
            assistant_text_plan("hello", "hello", true).unwrap(),
            AssistantTextPlan {
                suffix: String::new(),
                finish: true,
                final_text: "hello".into(),
            }
        );
        assert_eq!(
            assistant_text_plan("hello", "hel", false).unwrap(),
            AssistantTextPlan {
                suffix: String::new(),
                finish: false,
                final_text: "hello".into(),
            }
        );
        assert!(assistant_text_plan("hex", "hello", true).is_err());
    }

    #[test]
    fn resumes_text_by_turn_kind_and_ordinal_when_provider_item_ids_change() {
        let turn_id = AgentTurnIdV1::new("turn-1").unwrap();
        let other_turn_id = AgentTurnIdV1::new("turn-2").unwrap();
        let first = provider_message_id("live-first").unwrap();
        let second = provider_message_id("live-second").unwrap();
        let resumed = provider_message_id("resumed-first").unwrap();
        let mut projection = CodexTimelineProjection::default();
        for provider_message_id in [&first, &second] {
            projection.remember_text_provider(Some(&turn_id), provider_message_id);
            projection.text.insert(
                provider_message_id.as_str().into(),
                ProjectedText::Completed {
                    kind: AgentTimelineTextKindV1::Assistant,
                    text: "identical text is still a distinct item".into(),
                },
            );
        }

        assert_eq!(
            projection.provider_for_history_text(
                &turn_id,
                &AgentTimelineTextKindV1::Assistant,
                0,
                &resumed,
            ),
            first
        );
        assert_eq!(
            projection.provider_for_history_text(
                &turn_id,
                &AgentTimelineTextKindV1::Assistant,
                1,
                &resumed,
            ),
            second
        );
        assert_eq!(
            projection.provider_for_history_text(
                &other_turn_id,
                &AgentTimelineTextKindV1::Assistant,
                0,
                &resumed,
            ),
            resumed
        );
    }

    #[test]
    fn advances_tool_snapshots_without_regressing_terminal_state() {
        let running = AgentTimelineItemBodyV1::Tool {
            tool_call_id: "tool-1".into(),
            name: "commandExecution".into(),
            state: AgentTimelineToolStateV1::Running,
            input: Some(json!({ "command": "pwd" })),
            output: None,
        };
        let completed = AgentTimelineItemBodyV1::Tool {
            tool_call_id: "tool-1".into(),
            name: "commandExecution".into(),
            state: AgentTimelineToolStateV1::Completed,
            input: Some(json!({ "command": "pwd" })),
            output: Some(json!({ "exitCode": 0 })),
        };
        assert!(!should_append_tool_snapshot(Some(&running), &running).unwrap());
        assert!(should_append_tool_snapshot(Some(&running), &completed).unwrap());
        assert!(!should_append_tool_snapshot(Some(&completed), &running).unwrap());
        assert!(!should_append_tool_snapshot(Some(&completed), &completed).unwrap());
    }

    #[test]
    fn completion_phase_finishes_statusless_tools() {
        let web_search = json!({ "type": "webSearch", "id": "search-1", "query": "hmux" });
        assert_eq!(
            snapshot_tool_state(&web_search, false).unwrap(),
            AgentTimelineToolStateV1::Running
        );
        assert_eq!(
            snapshot_tool_state(&web_search, true).unwrap(),
            AgentTimelineToolStateV1::Completed
        );
    }

    #[test]
    fn maps_permission_and_question_answers_to_exact_app_server_shapes() {
        assert_eq!(
            pending_response(
                "item/commandExecution/requestApproval",
                &json!({}),
                &json!({ "decision": "allow" }),
            )
            .expect("permission"),
            json!({ "decision": "accept" })
        );
        assert_eq!(
            pending_response(
                "item/tool/requestUserInput",
                &json!({ "questions": [{ "id": "database", "question": "Database?" }] }),
                &json!({ "answers": { "database": "SQLite" } }),
            )
            .expect("question"),
            json!({ "answers": { "database": { "answers": ["SQLite"] } } })
        );
    }

    #[test]
    fn file_approvals_use_only_the_matching_running_root_tool() {
        let mut projection = CodexTimelineProjection::default();
        let input = json!({"changes": [{
            "path": "/qa/result.txt", "kind": {"type": "add"}, "diff": "43\n",
        }]});
        let params = json!({"threadId": "root", "itemId": "edit-1"});
        let method = "item/fileChange/requestApproval";
        let key = provider_message_id("edit-1").unwrap().as_str().to_owned();
        assert!(
            projection
                .file_approval_input("root", method, &params)
                .is_none()
        );
        projection.tools.insert(
            key.clone(),
            AgentTimelineItemBodyV1::Tool {
                tool_call_id: "edit-1".into(),
                name: "fileChange".into(),
                state: AgentTimelineToolStateV1::Running,
                input: Some(input.clone()),
                output: None,
            },
        );
        assert_eq!(
            projection.file_approval_input("root", method, &params),
            Some(&input)
        );
        for (request_method, request_params) in [
            (method, json!({"threadId": "child", "itemId": "edit-1"})),
            (
                method,
                json!({"threadId": "root", "itemId": "another-edit"}),
            ),
            (method, json!({"threadId": "root"})),
            ("item/commandExecution/requestApproval", params.clone()),
        ] {
            assert!(
                projection
                    .file_approval_input("root", request_method, &request_params)
                    .is_none()
            );
        }
        for (name, state, tool_input) in [
            (
                "fileChange",
                AgentTimelineToolStateV1::Completed,
                Some(input.clone()),
            ),
            (
                "commandExecution",
                AgentTimelineToolStateV1::Running,
                Some(input),
            ),
            ("fileChange", AgentTimelineToolStateV1::Running, None),
        ] {
            projection.tools.insert(
                key.clone(),
                AgentTimelineItemBodyV1::Tool {
                    tool_call_id: "edit-1".into(),
                    name: name.into(),
                    state,
                    input: tool_input,
                    output: None,
                },
            );
            assert!(
                projection
                    .file_approval_input("root", method, &params)
                    .is_none()
            );
        }
    }

    #[test]
    fn exposes_mcp_arguments_without_duplicating_or_changing_the_answer_route() {
        for arguments in [
            json!({"body": {"agentId": "agent-qa", "objective": "Verify parcel data", "status": "active", "expectedRevision": 0}}),
            json!({"content": "x".repeat(dure_app::MAX_AGENT_TIMELINE_JSON_BYTES_V1 * 3 / 4)}),
        ] {
            let params = json!({
                "threadId": "thread-qa", "turnId": "turn-qa", "serverName": "dure-orchestration",
                "message": "Allow the requested tool?", "mode": "form",
                "_meta": {"codex_approval_kind": "mcp_tool_call", "tool_params": arguments},
            });
            let payload =
                normalized_pending_payload("mcpServer/elicitation/request", &json!(19), &params);
            assert_eq!(payload.get("input"), Some(&arguments));
            assert_eq!(params.pointer("/_meta/tool_params"), Some(&arguments));
            assert!(
                payload
                    .pointer("/providerRequest/params/_meta/tool_params")
                    .is_none()
            );
            assert_eq!(payload["providerRequest"]["id"], 19);
            assert_eq!(
                payload["providerRequest"]["params"]["threadId"],
                "thread-qa"
            );
            assert_eq!(payload["providerRequest"]["params"]["turnId"], "turn-qa");
            for (decision, action) in [("allow", "accept"), ("deny", "decline")] {
                assert_eq!(
                    pending_response(
                        payload["providerRequest"]["method"].as_str().unwrap(),
                        &payload["providerRequest"]["params"],
                        &json!({"decision": decision}),
                    )
                    .unwrap(),
                    json!({"action": action}),
                );
            }
            AgentPendingRequestDraftV1 {
                request_id: AgentInteractionRequestIdV1::new("request-qa").unwrap(),
                kind: AgentPendingRequestKindV1::Permission,
                turn_id: None,
                client_message_id: AgentClientMessageIdV1::new("message-qa").unwrap(),
                payload,
                created_at_ms: 1,
            }
            .validate()
            .unwrap();
        }
    }

    #[test]
    fn exposes_command_text_without_duplicating_or_changing_the_answer_route() {
        for command in [
            "printf 'FIRST\\n' > result.txt".to_owned(),
            "x".repeat(dure_app::MAX_AGENT_TIMELINE_JSON_BYTES_V1 * 3 / 4),
        ] {
            let params = json!({
                "threadId": "thread-qa", "turnId": "turn-qa", "itemId": "command-qa",
                "command": command, "cwd": "/tmp/disposable-qa", "reason": "Write the requested file",
                "availableDecisions": ["accept", "decline"],
            });
            let payload = normalized_pending_payload(
                "item/commandExecution/requestApproval",
                &json!(21),
                &params,
            );
            assert_eq!(payload.get("input"), Some(&json!({"command": command})));
            assert_eq!(params["command"], command);
            let mut route_params = params.clone();
            route_params.as_object_mut().unwrap().remove("command");
            assert_eq!(payload["providerRequest"]["params"], route_params);
            assert_eq!(payload["providerRequest"]["id"], 21);
            assert_eq!(payload["presentation"]["description"], params["reason"]);
            assert_eq!(payload["presentation"]["blockedPath"], params["cwd"]);
            for (decision, action) in [("allow", "accept"), ("deny", "decline")] {
                assert_eq!(
                    pending_response(
                        payload["providerRequest"]["method"].as_str().unwrap(),
                        &payload["providerRequest"]["params"],
                        &json!({"decision": decision}),
                    )
                    .unwrap(),
                    json!({"decision": action}),
                );
            }
            AgentPendingRequestDraftV1 {
                request_id: AgentInteractionRequestIdV1::new("request-command-qa").unwrap(),
                kind: AgentPendingRequestKindV1::Permission,
                turn_id: None,
                client_message_id: AgentClientMessageIdV1::new("message-command-qa").unwrap(),
                payload,
                created_at_ms: 1,
            }
            .validate()
            .unwrap();
        }
    }

    #[test]
    fn leaves_other_pending_metadata_and_absent_inputs_unchanged() {
        for (method, params) in [
            (
                "mcpServer/elicitation/request",
                json!({"_meta": {"codex_approval_kind": "mcp_tool_call"}}),
            ),
            (
                "mcpServer/elicitation/request",
                json!({"_meta": {"tool_params": {"body": "ordinary question"}}}),
            ),
            (
                "item/commandExecution/requestApproval",
                json!({"_meta": {"codex_approval_kind": "mcp_tool_call", "tool_params": {"body": "other method"}}}),
            ),
            (
                "item/commandExecution/requestApproval",
                json!({"command": null, "cwd": "/tmp/qa"}),
            ),
            (
                "item/commandExecution/requestApproval",
                json!({"command": 17}),
            ),
            (
                "item/fileChange/requestApproval",
                json!({"command": "unrelated method"}),
            ),
        ] {
            let payload = normalized_pending_payload(method, &json!(20), &params);
            assert!(payload.get("input").is_none());
            assert_eq!(payload["providerRequest"]["params"], params);
        }
    }

    #[test]
    fn maps_only_codex_mcp_tool_approvals_to_permission_answers() {
        let params = json!({
            "_meta": {"codex_approval_kind": "mcp_tool_call", "tool_name": "agent_goal_put"},
            "message": "Allow the Dure goal update?",
            "mode": "form", "requestedSchema": {"type": "object", "properties": {}},
        });
        for (decision, action) in [("allow", "accept"), ("deny", "decline")] {
            assert_eq!(
                pending_response(
                    "mcpServer/elicitation/request",
                    &params,
                    &json!({"decision": decision})
                )
                .unwrap(),
                json!({"action": action})
            );
        }
        let payload =
            normalized_pending_payload("mcpServer/elicitation/request", &json!(19), &params);
        assert_eq!(payload["presentation"]["description"], params["message"]);
        assert_eq!(payload["providerRequest"]["params"], params);
        for ordinary in [
            json!({"mode": "form", "message": "Account name?", "requestedSchema": {"type": "object"}}),
            json!({"mode": "url", "url": "https://example.com", "message": "Sign in"}),
            json!({"_meta": {"codex_approval_kind": "tool_suggestion"}}),
        ] {
            assert!(
                pending_response(
                    "mcpServer/elicitation/request",
                    &ordinary,
                    &json!({"decision": "allow"})
                )
                .is_err(),
                "a generic elicitation is not tool permission"
            );
        }
    }

    #[test]
    fn normalizes_codex_questions_into_the_common_pending_card_contract() {
        let payload = normalized_pending_payload(
            "item/tool/requestUserInput",
            &json!(4),
            &json!({
                "questions": [{
                    "id": "database",
                    "header": "Database",
                    "question": "Database?",
                    "isOther": true,
                    "isSecret": false,
                    "options": [{ "label": "SQLite", "description": "Local" }],
                }],
            }),
        );
        assert_eq!(
            payload.pointer("/input/questions/0/allowOther"),
            Some(&json!(true))
        );
        assert_eq!(payload.pointer("/providerRequest/id"), Some(&json!(4)));
    }

    #[test]
    fn normalizes_nullable_options_and_preserves_sensitive_question_identity() {
        let payload = normalized_pending_payload(
            "item/tool/requestUserInput",
            &json!(5),
            &json!({
                "questions": [{
                    "id": "token",
                    "question": "Token?",
                    "isOther": true,
                    "isSecret": true,
                    "options": null,
                }],
            }),
        );
        assert_eq!(
            payload.pointer("/input/questions/0/id"),
            Some(&json!("token"))
        );
        assert_eq!(
            payload.pointer("/input/questions/0/isSecret"),
            Some(&json!(true))
        );
        assert_eq!(
            payload.pointer("/input/questions/0/options"),
            Some(&json!([]))
        );
    }
}
