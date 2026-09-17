use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use dure_app::*;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::agent_conversation::{
    AgentConversationService, AgentProviderCommandErrorV1 as CommandError,
    AgentProviderCommandFuture, AgentProviderCommands,
};
use crate::managed_provider_connection::{AttachedProviderConnection, ManagedProviderConnection};
use crate::opencode_session_client::{
    OpenCodeEvents, OpenCodeSessionClient, PendingKind, SessionId,
};
use crate::provider_turn_settings::ProviderTurnSettings;
use crate::structured_provider_runtime::{
    StructuredProviderRuntimeErrorKindV1, StructuredProviderRuntimeErrorV1,
};

use crate::provider_timeline_journal::{ProviderTimelineJournal, digest, now_ms};

mod projection;
use projection::*;

#[derive(Default)]
struct Projection {
    turns: BTreeMap<String, TurnContext>,
    pending: BTreeMap<String, (PendingKind, Value)>,
    accepted_turn: Option<String>,
}

pub(crate) struct OpenCodeTimelineBridge<S> {
    binding: AgentInteractionBindingV1,
    session: SessionId,
    client: OpenCodeSessionClient,
    settings: ProviderTurnSettings,
    service: Arc<AgentConversationService<S>>,
    journal: ProviderTimelineJournal<S>,
    projection: Mutex<Projection>,
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
    async {
        let client = OpenCodeSessionClient::connect(endpoint, cwd)
            .await
            .map_err(provider_error)?;
        client.health().await.map_err(provider_error)?;
        let session = SessionId::for_binding(binding).map_err(provider_error)?;
        if binding.provider_conversation_ref.is_some() {
            client.session(&session).await.map_err(provider_error)?;
        } else {
            client.create(&session).await.map_err(provider_error)?;
        }
        // Subscribe before the authoritative snapshot so changes during hydration
        // are observed afterwards. Each notification reads provider-owned state.
        let events = client.events().await.map_err(provider_error)?;
        let journal = ProviderTimelineJournal::new(Arc::clone(&service), binding).await?;
        let bridge = Arc::new(OpenCodeTimelineBridge {
            binding: binding.clone(),
            session,
            client,
            settings: settings.clone(),
            service: Arc::clone(&service),
            journal,
            projection: Mutex::new(Projection::default()),
            connected: AtomicBool::new(true),
            accepting: AtomicBool::new(true),
        });
        if binding.provider_conversation_ref.is_none() {
            bridge
                .journal
                .commit(vec![
                    AgentTimelineMutationV1::EstablishProviderConversation {
                        provider_conversation_ref: bridge.session.as_str().into(),
                        established_at_ms: now_ms()?,
                    },
                ])
                .await?;
        }
        bridge.hydrate().await?;
        let binding = service
            .binding(&binding.interaction_session_id)
            .await
            .map_err(store_error)?
            .ok_or_else(|| protocol_error("binding missing after attach"))?;
        Ok(AttachedProviderConnection {
            binding,
            connection: bridge.clone(),
            commands: bridge.clone(),
            handler: bridge.spawn(events),
        })
    }
    .await
    .map_err(|error: CommandError| {
        StructuredProviderRuntimeErrorV1::new(
            StructuredProviderRuntimeErrorKindV1::LaunchFailed,
            error.code,
        )
        .with_detail(Some(error.detail))
    })
}

impl<S: AgentTimelineStore + 'static> OpenCodeTimelineBridge<S> {
    async fn hydrate(&self) -> Result<(), CommandError> {
        let mut projection = self.projection.lock().await;
        let existing = self.journal.existing_rows().await?;
        projection.accepted_turn = existing
            .active_turn
            .as_ref()
            .map(|turn| user_message_id(&turn.client_message_id));
        for row in &existing.rows {
            if let (Some(client), Some(turn)) = (&row.item.client_message_id, &row.item.turn_id) {
                projection
                    .turns
                    .entry(user_message_id(client))
                    .or_insert_with(|| TurnContext {
                        turn_id: turn.clone(),
                        client_message_id: client.clone(),
                    });
            }
        }
        for message in self
            .client
            .messages(&self.session)
            .await
            .map_err(provider_error)?
        {
            self.project_message(&mut projection, &message).await?;
        }
        self.sync_pending(&mut projection).await?;
        self.journal
            .append_once(vec![item(
                &format!("session-ready:{}", self.session.as_str()),
                None,
                None,
                AgentTimelineItemBodyV1::Lifecycle {
                    state: AgentTimelineLifecycleStateV1::SessionReady,
                    detail: None,
                },
                self.binding.created_at_ms,
            )?])
            .await?;
        // Catalog discovery cannot revoke an otherwise attached conversation.
        if let Ok(catalog) = self.client.catalog().await {
            if let Ok(item) = item(
                &format!(
                    "catalog:{}:{}",
                    self.binding.runtime.runtime_generation,
                    digest(&catalog.to_string())
                ),
                None,
                None,
                AgentTimelineItemBodyV1::ProviderEvidence {
                    namespace: "provider.opencode".into(),
                    kind: "provider_catalog".into(),
                    value: catalog,
                },
                self.binding.updated_at_ms,
            ) {
                let _ = self.journal.append_once(vec![item]).await;
            }
        }
        Ok(())
    }

    async fn project_message(
        &self,
        projection: &mut Projection,
        message: &Value,
    ) -> Result<(), CommandError> {
        let (items, completed_user) = message_items(message, &mut projection.turns)?;
        self.journal.append_once(items).await?;
        if completed_user.as_ref() == projection.accepted_turn.as_ref() {
            projection.accepted_turn = None;
        }
        Ok(())
    }

    async fn sync_pending(&self, projection: &mut Projection) -> Result<(), CommandError> {
        let pending = self
            .client
            .pending(&self.session)
            .await
            .map_err(provider_error)?;
        let mut drafts = Vec::new();
        let mut routes = BTreeMap::new();
        for (kind, request) in pending {
            if crate::opencode_connection_driver::automatically_answers(
                &self.settings.permission_mode,
                kind,
                &request,
            ) {
                continue;
            }
            let draft = pending_draft(kind, &request)?;
            routes.insert(draft.request_id.to_string(), (kind, request));
            drafts.push(draft);
        }
        self.service
            .reconcile_pending_snapshot(&AgentPendingSnapshotV1 {
                schema_version: 1,
                interaction_session_id: self.binding.interaction_session_id.clone(),
                runtime: self.binding.runtime.clone(),
                observed_through_sequence: self.journal.sequence().await,
                requests: drafts,
                observed_at_ms: now_ms()?,
            })
            .await
            .map_err(store_error)?;
        projection.pending = routes;
        Ok(())
    }

    fn spawn(self: &Arc<Self>, mut events: OpenCodeEvents) -> tokio::task::JoinHandle<()> {
        let bridge = self.clone();
        tokio::spawn(async move {
            while let Ok(event) = events.next().await {
                if bridge.handle_event(&event).await.is_err() {
                    break;
                }
            }
            bridge.connected.store(false, Ordering::SeqCst);
        })
    }

    async fn handle_event(&self, event: &Value) -> Result<(), CommandError> {
        let properties = event.get("properties").unwrap_or(&Value::Null);
        let session = properties
            .get("sessionID")
            .or_else(|| properties.pointer("/info/sessionID"))
            .or_else(|| properties.pointer("/part/sessionID"))
            .and_then(Value::as_str);
        if session != Some(self.session.as_str()) {
            return Ok(());
        }
        let mut projection = self.projection.lock().await;
        match event.get("type").and_then(Value::as_str) {
            Some("message.updated" | "message.part.updated") => {
                let id = properties
                    .pointer("/info/id")
                    .or_else(|| properties.pointer("/part/messageID"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol_error("message event lacks identity"))?;
                if let Some(message) = self
                    .client
                    .message(&self.session, id)
                    .await
                    .map_err(provider_error)?
                {
                    self.project_message(&mut projection, &message).await?;
                }
            }
            Some(
                "permission.asked" | "permission.replied" | "question.asked" | "question.replied"
                | "question.rejected",
            ) => self.sync_pending(&mut projection).await?,
            Some("session.error") => {
                if let Some(user) = projection.accepted_turn.take() {
                    if let Some(context) = projection.turns.get(&user) {
                        let item = lifecycle(
                            &user,
                            context,
                            AgentTimelineLifecycleStateV1::TurnFailed,
                            now_ms()?,
                        )?;
                        self.journal.append_once(vec![item]).await?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn exact_binding(&self, binding: &AgentInteractionBindingV1) -> Result<(), CommandError> {
        if !self.connected.load(Ordering::SeqCst)
            || !self.binding.same_runtime_authority(binding)
            || binding.provider_conversation_ref.as_deref() != Some(self.session.as_str())
        {
            return Err(protocol_error("runtime binding is stale"));
        }
        Ok(())
    }
}

impl<S: AgentTimelineStore + 'static> ManagedProviderConnection for OpenCodeTimelineBridge<S> {
    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
    fn begin_idle_drain(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            let projection = self.projection.lock().await;
            self.accepting.store(false, Ordering::SeqCst);
            projection.accepted_turn.is_none()
                && self
                    .client
                    .is_busy(&self.session)
                    .await
                    .is_ok_and(|busy| !busy)
        })
    }
    fn cancel_drain(&self) {
        self.accepting.store(true, Ordering::SeqCst);
    }
}

impl<S: AgentTimelineStore + 'static> AgentProviderCommands for OpenCodeTimelineBridge<S> {
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            let mut projection = self.projection.lock().await;
            if !self.accepting.load(Ordering::SeqCst) {
                return Err(CommandError::new(
                    "runtime_draining",
                    "OpenCode is switching runtimes",
                ));
            }
            if projection.accepted_turn.is_some()
                || self
                    .client
                    .is_busy(&self.session)
                    .await
                    .map_err(provider_error)?
            {
                return Err(CommandError::new(
                    "turn_busy",
                    "OpenCode already has an active turn",
                ));
            }
            let id = user_message_id(&intent.client_message_id);
            projection.turns.insert(
                id.clone(),
                TurnContext {
                    turn_id: intent.turn_id.clone(),
                    client_message_id: intent.client_message_id.clone(),
                },
            );
            if self
                .client
                .message(&self.session, &id)
                .await
                .map_err(provider_error)?
                .is_some()
            {
                return Ok(json!({"messageID": id}));
            }
            self.client
                .prompt(
                    &self.session,
                    &id,
                    &intent.input,
                    self.settings.model.as_ref(),
                    self.settings.effort.as_ref(),
                )
                .await
                .map_err(provider_error)?;
            projection.accepted_turn = Some(id.clone());
            Ok(json!({"messageID": id}))
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
            let (kind, provider) = projection
                .pending
                .get(intent.request_id.as_str())
                .cloned()
                .ok_or_else(|| protocol_error("pending request is no longer live"))?;
            if request.request.request_id != intent.request_id {
                return Err(protocol_error("pending request identity changed"));
            }
            let answer = pending_answer(kind, &provider, &intent.answer)?;
            self.client
                .reply(kind, field(&provider, "id")?, answer.clone())
                .await
                .map_err(provider_error)?;
            self.service
                .complete_pending_answer_success(
                    &intent.idempotency_key,
                    &intent.interaction_session_id,
                    answer.clone(),
                )
                .await
                .map_err(store_error)?;
            projection.pending.remove(intent.request_id.as_str());
            Ok(answer)
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
                .accepted_turn
                .as_ref()
                .and_then(|id| projection.turns.get(id))
                .ok_or_else(|| {
                    CommandError::new("turn_not_active", "OpenCode has no active Dure turn")
                })?;
            if active.turn_id != request.turn_id
                || active.client_message_id != request.client_message_id
            {
                return Err(CommandError::new(
                    "stale_turn",
                    "OpenCode active turn does not match the interrupt",
                ));
            }
            if !self
                .client
                .is_busy(&self.session)
                .await
                .map_err(provider_error)?
            {
                return Err(CommandError::new(
                    "turn_not_active",
                    "OpenCode has completed this turn",
                ));
            }
            self.client
                .abort(&self.session)
                .await
                .map_err(provider_error)?;
            Ok(json!({"interrupted": true}))
        })
    }
}

fn user_message_id(client: &AgentClientMessageIdV1) -> String {
    format!("msg_dure_{}", digest(client.as_str()))
}
fn protocol_error(detail: &str) -> CommandError {
    CommandError::new("opencode_protocol_invalid", detail)
}
fn provider_error(error: crate::opencode_session_client::Error) -> CommandError {
    CommandError::new("opencode_session_unavailable", format!("{error:?}"))
}
fn store_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("opencode_timeline_store", error.to_string())
}
