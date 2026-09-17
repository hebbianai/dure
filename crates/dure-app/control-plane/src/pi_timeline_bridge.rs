use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use dure_app::*;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::agent_conversation::{
    AgentConversationService, AgentProviderCommandErrorV1 as Error, AgentProviderCommandFuture,
    AgentProviderCommands,
};
use crate::json_rpc_socket_client::JsonRpcSocketIncoming;
use crate::managed_provider_connection::{AttachedProviderConnection, ManagedProviderConnection};
use crate::pi_session_client::PiSessionClient;
use crate::provider_timeline_journal::{
    ProviderTimelineJournal, evidence_value, now_ms, protocol_error, store_error,
};
use crate::provider_turn_settings::ProviderTurnSettings;
use crate::structured_provider_runtime::{
    StructuredProviderRuntimeErrorKindV1, StructuredProviderRuntimeErrorV1,
};

mod projection;
use projection::*;

#[derive(Default)]
struct Projection {
    anchors: BTreeMap<AgentClientMessageIdV1, PromptAnchor>,
    active: Option<TurnContext>,
    pending: BTreeMap<String, Value>,
}

struct PiTimelineBridge<S> {
    binding: AgentInteractionBindingV1,
    client: PiSessionClient,
    service: Arc<AgentConversationService<S>>,
    journal: ProviderTimelineJournal<S>,
    projection: Mutex<Projection>,
    established: AtomicBool,
    connected: AtomicBool,
    accepting: AtomicBool,
}

pub(crate) async fn attach<S: AgentTimelineStore + 'static>(
    binding: &AgentInteractionBindingV1,
    endpoint: &Path,
    cwd: &Path,
    settings: &ProviderTurnSettings,
    service: Arc<AgentConversationService<S>>,
) -> Result<AttachedProviderConnection, StructuredProviderRuntimeErrorV1> {
    attach_inner(binding, endpoint, cwd, settings, service)
        .await
        .map_err(|error| {
            StructuredProviderRuntimeErrorV1::new(
                StructuredProviderRuntimeErrorKindV1::LaunchFailed,
                error.code,
            )
            .with_detail(Some(error.detail))
        })
}

async fn attach_inner<S: AgentTimelineStore + 'static>(
    binding: &AgentInteractionBindingV1,
    endpoint: &Path,
    cwd: &Path,
    settings: &ProviderTurnSettings,
    service: Arc<AgentConversationService<S>>,
) -> Result<AttachedProviderConnection, Error> {
    let (client, events) = PiSessionClient::connect(endpoint, cwd, binding).await?;
    let state = client.state().await?;
    if let Some(model) = &settings.model {
        let actual = format!(
            "{}/{}",
            crate::pi_session_client::field(&state.model, "provider")?,
            crate::pi_session_client::field(&state.model, "id")?
        );
        if actual != model.as_str() {
            return Err(protocol_error(
                "Pi did not select the requested exact model",
            ));
        }
    }
    if settings
        .effort
        .as_ref()
        .is_some_and(|effort| effort.as_str() != state.thinking_level)
    {
        return Err(protocol_error(
            "Pi did not select the requested thinking level",
        ));
    }
    let journal = ProviderTimelineJournal::new(service.clone(), binding).await?;
    let existing = journal.existing_rows().await?;
    let mut projection = Projection {
        active: existing.active_turn.map(|turn| TurnContext {
            turn_id: turn.turn_id,
            client_message_id: turn.client_message_id,
        }),
        ..Default::default()
    };
    for row in &existing.rows {
        if let Some(value) = evidence_value(row, "provider.pi", "prompt_anchor") {
            let anchor: PromptAnchor = serde_json::from_value(value).map_err(store_error)?;
            projection
                .anchors
                .insert(anchor.context.client_message_id.clone(), anchor);
        }
    }
    for row in &existing.rows {
        if let Some(value) = evidence_value(row, "provider.pi", "prompt_without_message") {
            let client: AgentClientMessageIdV1 =
                serde_json::from_value(value).map_err(store_error)?;
            projection.anchors.remove(&client);
        }
    }
    let bridge = Arc::new(PiTimelineBridge {
        binding: binding.clone(),
        client,
        service: service.clone(),
        journal,
        projection: Mutex::new(projection),
        established: AtomicBool::new(binding.provider_conversation_ref.is_some()),
        connected: AtomicBool::new(true),
        accepting: AtomicBool::new(true),
    });
    bridge.sync(&mut *bridge.projection.lock().await).await?;
    bridge
        .journal
        .append_once(vec![item(
            "session-ready",
            None,
            None,
            AgentTimelineItemBodyV1::Lifecycle {
                state: AgentTimelineLifecycleStateV1::SessionReady,
                detail: None,
            },
            binding.created_at_ms,
        )?])
        .await?;
    let initialized = item(
        &format!("initialized:{}", binding.runtime.runtime_generation),
        None,
        None,
        AgentTimelineItemBodyV1::ProviderEvidence {
            namespace: "provider.pi".into(),
            kind: "provider_session_initialized".into(),
            value: json!({
                "model": format!("{}/{}", state.model["provider"].as_str().unwrap_or_default(), state.model["id"].as_str().unwrap_or_default()),
                "permissionMode": "default", "effort": state.thinking_level,
            }),
        },
        binding.updated_at_ms,
    )?;
    bridge.journal.append_once(vec![initialized]).await?;
    if let Ok(catalog) = bridge.client.catalog(&state).await {
        let row = item(
            &format!("catalog:{}", binding.runtime.runtime_generation),
            None,
            None,
            AgentTimelineItemBodyV1::ProviderEvidence {
                namespace: "provider.pi".into(),
                kind: "provider_catalog".into(),
                value: catalog,
            },
            binding.updated_at_ms,
        )?;
        let _ = bridge.journal.append_once(vec![row]).await;
    }
    let binding = service
        .binding(&binding.interaction_session_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| protocol_error("Pi binding missing after attachment"))?;
    Ok(AttachedProviderConnection {
        binding,
        connection: bridge.clone(),
        commands: bridge.clone(),
        handler: bridge.spawn(events),
    })
}

impl<S: AgentTimelineStore + 'static> PiTimelineBridge<S> {
    async fn sync(
        &self,
        projection: &mut Projection,
    ) -> Result<crate::pi_session_client::Entries, Error> {
        let state = self.client.state().await?;
        let entries = self.client.entries().await?;
        let materialized = self.client.is_materialized(&state)?;
        if materialized && !self.established.load(Ordering::SeqCst) {
            self.journal
                .commit(vec![
                    AgentTimelineMutationV1::EstablishProviderConversation {
                        provider_conversation_ref: self.client.session.as_str().into(),
                        established_at_ms: now_ms()?,
                    },
                ])
                .await?;
            self.established.store(true, Ordering::SeqCst);
        } else if !materialized && self.established.load(Ordering::SeqCst) {
            return Err(protocol_error("Pi lost its persisted conversation"));
        }
        let history = project(&entries, &projection.anchors)?;
        self.journal.append_once(history.items).await?;
        if !state.busy() {
            if let Some(active) = projection.active.clone() {
                if history.completed.contains(&active.client_message_id) {
                    projection.active = None;
                } else {
                    let status = self
                        .client
                        .rpc
                        .request(
                            "prompt_status",
                            json!({"clientMessageId":active.client_message_id}),
                        )
                        .await
                        .map_err(store_error)?;
                    if matches!(
                        status.get("status").and_then(Value::as_str),
                        Some("accepted" | "rejected")
                    ) {
                        let has_message = history.accepted.contains_key(&active.client_message_id);
                        if !has_message {
                            self.journal
                                .append_once(vec![item(
                                    &format!("no-message:{}", active.client_message_id),
                                    Some(&active),
                                    None,
                                    AgentTimelineItemBodyV1::ProviderEvidence {
                                        namespace: "provider.pi".into(),
                                        kind: "prompt_without_message".into(),
                                        value: json!(active.client_message_id),
                                    },
                                    now_ms()?,
                                )?])
                                .await?;
                            projection.anchors.remove(&active.client_message_id);
                        }
                        let end = if has_message || status["status"] == "rejected" {
                            AgentTimelineLifecycleStateV1::TurnFailed
                        } else {
                            AgentTimelineLifecycleStateV1::TurnCompleted
                        };
                        self.journal
                            .append_once(vec![lifecycle(&active, end, now_ms()?)?])
                            .await?;
                        projection.active = None;
                    }
                }
            }
        }
        let mut pending = BTreeMap::new();
        let mut requests = Vec::new();
        for request in state.pending_ui {
            let draft = pending_draft(&request, projection.active.as_ref())?;
            pending.insert(draft.request_id.to_string(), request);
            requests.push(draft);
        }
        self.service
            .reconcile_pending_snapshot(&AgentPendingSnapshotV1 {
                schema_version: 1,
                interaction_session_id: self.binding.interaction_session_id.clone(),
                runtime: self.binding.runtime.clone(),
                observed_through_sequence: self.journal.sequence().await,
                requests,
                observed_at_ms: now_ms()?,
            })
            .await
            .map_err(store_error)?;
        projection.pending = pending;
        Ok(entries)
    }

    fn spawn(self: &Arc<Self>, mut incoming: JsonRpcSocketIncoming) -> tokio::task::JoinHandle<()> {
        let bridge = self.clone();
        tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                if event.method == "pi/changed"
                    && bridge
                        .sync(&mut *bridge.projection.lock().await)
                        .await
                        .is_err()
                {
                    break;
                }
            }
            bridge.connected.store(false, Ordering::SeqCst);
        })
    }

    fn exact_binding(&self, binding: &AgentInteractionBindingV1) -> Result<(), Error> {
        if !self.connected.load(Ordering::SeqCst)
            || !self.client.rpc.is_connected()
            || !self.binding.same_runtime_authority(binding)
            || binding
                .provider_conversation_ref
                .as_deref()
                .is_some_and(|id| id != self.client.session.as_str())
        {
            return Err(protocol_error("Pi runtime binding is stale"));
        }
        Ok(())
    }
}

impl<S: AgentTimelineStore + 'static> ManagedProviderConnection for PiTimelineBridge<S> {
    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst) && self.client.rpc.is_connected()
    }
    fn begin_idle_drain(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            let mut projection = self.projection.lock().await;
            self.accepting.store(false, Ordering::SeqCst);
            self.sync(&mut projection).await.is_ok()
                && projection.active.is_none()
                && self.client.state().await.is_ok_and(|state| !state.busy())
        })
    }
    fn cancel_drain(&self) {
        self.accepting.store(true, Ordering::SeqCst);
    }
}

impl<S: AgentTimelineStore + 'static> AgentProviderCommands for PiTimelineBridge<S> {
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            let mut projection = self.projection.lock().await;
            if !self.accepting.load(Ordering::SeqCst) {
                return Err(Error::new("runtime_draining", "Pi is switching runtimes"));
            }
            let entries = self.sync(&mut projection).await?;
            let history = project(&entries, &projection.anchors)?;
            if let Some(id) = history.accepted.get(&intent.client_message_id) {
                return Ok(json!({"entryId":id}));
            }
            if projection
                .active
                .as_ref()
                .is_some_and(|turn| turn.client_message_id != intent.client_message_id)
                || self.client.state().await?.busy()
            {
                return Err(Error::new("turn_busy", "Pi already has an active turn"));
            }
            let context = TurnContext {
                turn_id: intent.turn_id.clone(),
                client_message_id: intent.client_message_id.clone(),
            };
            let anchor = projection
                .anchors
                .entry(intent.client_message_id.clone())
                .or_insert_with(|| PromptAnchor {
                    context: context.clone(),
                    previous_leaf: entries.leaf_id.clone(),
                    runtime: self.binding.runtime.clone(),
                })
                .clone();
            if anchor.runtime != self.binding.runtime {
                return Err(Error::new(
                    "pi_prompt_outcome_unknown",
                    "The previous Pi process did not persist this prompt; an automatic resend cannot be proven safe",
                ));
            }
            if anchor.context != context || anchor.previous_leaf != entries.leaf_id {
                return Err(protocol_error(
                    "Pi prompt boundary changed before submission",
                ));
            }
            self.journal
                .append_once(vec![item(
                    &format!("prompt:{}", intent.client_message_id),
                    Some(&context),
                    None,
                    AgentTimelineItemBodyV1::ProviderEvidence {
                        namespace: "provider.pi".into(),
                        kind: "prompt_anchor".into(),
                        value: serde_json::to_value(&anchor).map_err(store_error)?,
                    },
                    now_ms()?,
                )?])
                .await?;
            projection.active = Some(context);
            self.client
                .rpc
                .request(
                    "prompt",
                    json!({"clientMessageId":intent.client_message_id,"message":intent.input}),
                )
                .await
                .map_err(store_error)
        })
    }

    fn answer_pending<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentPendingAnswerIntentV1,
        request: &'a AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            let mut projection = self.projection.lock().await;
            let provider = projection
                .pending
                .get(intent.request_id.as_str())
                .ok_or_else(|| protocol_error("Pi question is no longer pending"))?;
            if request.request.request_id != intent.request_id {
                return Err(protocol_error("Pi answer targets another question"));
            }
            let reply = pending_answer(provider, &intent.answer)?;
            let receipt = self
                .client
                .rpc
                .request("extension_ui_response", reply)
                .await
                .map_err(store_error)?;
            self.service
                .complete_pending_answer_success(
                    &intent.idempotency_key,
                    &intent.interaction_session_id,
                    receipt.clone(),
                )
                .await
                .map_err(store_error)?;
            projection.pending.remove(intent.request_id.as_str());
            Ok(receipt)
        })
    }

    fn interrupt_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        request: &'a AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            let projection = self.projection.lock().await;
            let active = projection
                .active
                .as_ref()
                .ok_or_else(|| Error::new("turn_not_active", "Pi has no active Dure turn"))?;
            if active.turn_id != request.turn_id
                || active.client_message_id != request.client_message_id
            {
                return Err(Error::new(
                    "stale_turn",
                    "Pi active turn does not match the interrupt",
                ));
            }
            if !self.client.state().await?.busy() {
                return Err(Error::new("turn_not_active", "Pi has completed this turn"));
            }
            self.client
                .rpc
                .request("abort", json!({}))
                .await
                .map_err(store_error)
        })
    }
}
