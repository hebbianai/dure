use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::{Arc, RwLock};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentIdV1, AgentInteractionBindingV1,
    AgentInteractionSessionIdV1, AgentInterruptTurnRequestV1, AgentPendingAnswerIntentV1,
    AgentProviderRuntimeFenceV1, AgentStartTurnIntentV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTimelineStore, AgentTurnEffectReceiptV1, DomainStoreErrorV1,
    OperationIdV1,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{OwnedSemaphorePermit, broadcast};
use tokio::time::timeout;

use crate::agent_conversation::{
    AgentConversationErrorV1, AgentConversationNotificationV1, AgentConversationService,
    AgentProviderCommandErrorV1, AgentProviderCommands,
};
use crate::{
    BACKEND_ERROR_KIND, BACKEND_PROTOCOL_API, BACKEND_RESPONSE_KIND, BackendDispatchError,
    BackendRequest, MAX_RESPONSE_BYTES, REQUEST_DEADLINE, REQUEST_IO_TIMEOUT, ServiceState,
    agent_conversation_api_error, backend_error_body, backend_observation,
    requests_persistent_connection, validate_request,
};

pub const CREATE_OPERATION: &str = "agent_conversation.create";
pub const INSPECT_OPERATION: &str = "agent_conversation.inspect";
pub const INSPECT_INPUT_OPERATION: &str = "agent_conversation.inspect_input";
pub const READ_QUEUE_OPERATION: &str = "agent_conversation.read_queue";
pub const READ_OPERATION: &str = "agent_conversation.read";
pub const RECOVER_OPERATION: &str = "agent_conversation.recover";
pub const SUBSCRIBE_OPERATION: &str = "agent_conversation.subscribe";
pub const START_TURN_OPERATION: &str = "agent_conversation.start_turn";
pub const CONTINUE_TURN_OPERATION: &str = "agent_conversation.continue_turn";
pub const STEER_TURN_OPERATION: &str = "agent_conversation.steer_turn";
pub const ENQUEUE_TURN_OPERATION: &str = "agent_conversation.enqueue_turn";
pub const CANCEL_QUEUED_TURN_OPERATION: &str = "agent_conversation.cancel_queued_turn";
pub const ANSWER_PENDING_OPERATION: &str = "agent_conversation.answer_pending";
pub const INTERRUPT_TURN_OPERATION: &str = "agent_conversation.interrupt_turn";

#[derive(Clone, Debug)]
pub enum AgentConversationApiErrorV1 {
    RequestInvalid,
    NotFound,
    Conflict,
    RuntimeUnavailable,
    SteerUnsupported,
    ProviderFailed(AgentProviderCommandErrorV1),
    StoreFailed,
}

impl AgentConversationApiErrorV1 {
    pub fn code(&self) -> &'static str {
        match self {
            Self::RequestInvalid => "agent_conversation_request_invalid",
            Self::NotFound => "agent_conversation_not_found",
            Self::Conflict => "agent_conversation_conflict",
            Self::RuntimeUnavailable => "agent_conversation_runtime_unavailable",
            Self::SteerUnsupported => "agent_conversation_steer_unsupported",
            Self::ProviderFailed(_) => "agent_conversation_provider_failed",
            Self::StoreFailed => "agent_conversation_store_failed",
        }
    }
}

impl From<AgentConversationErrorV1> for AgentConversationApiErrorV1 {
    fn from(error: AgentConversationErrorV1) -> Self {
        match error {
            AgentConversationErrorV1::Store(DomainStoreErrorV1::InvalidRecord { .. }) => {
                Self::RequestInvalid
            }
            AgentConversationErrorV1::Store(DomainStoreErrorV1::NotFound { .. }) => Self::NotFound,
            AgentConversationErrorV1::Store(
                DomainStoreErrorV1::IdentityConflict { .. }
                | DomainStoreErrorV1::IdempotencyConflict { .. },
            ) => Self::Conflict,
            AgentConversationErrorV1::Store(_) | AgentConversationErrorV1::Clock => {
                Self::StoreFailed
            }
            AgentConversationErrorV1::Provider(error) if error.code == "steer_unsupported" => {
                Self::SteerUnsupported
            }
            AgentConversationErrorV1::Provider(error) => Self::ProviderFailed(error),
        }
    }
}

struct BoundRuntime {
    binding: AgentInteractionBindingV1,
    commands: Arc<dyn AgentProviderCommands>,
}

/// Provider-neutral command lookup. Provider adapters register only a complete,
/// exact binding after their private runtime has reached readiness.
#[derive(Default)]
pub struct AgentConversationRuntimeRegistry {
    runtimes: RwLock<BTreeMap<AgentInteractionSessionIdV1, BoundRuntime>>,
    command_blocks: RwLock<BTreeMap<AgentInteractionSessionIdV1, BTreeSet<OperationIdV1>>>,
}

impl AgentConversationRuntimeRegistry {
    pub fn preflight(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<(), AgentConversationApiErrorV1> {
        let runtimes = self
            .runtimes
            .read()
            .map_err(|_| AgentConversationApiErrorV1::RuntimeUnavailable)?;
        if runtimes
            .get(&binding.interaction_session_id)
            .is_some_and(|current| !current.binding.same_runtime_authority(binding))
        {
            return Err(AgentConversationApiErrorV1::Conflict);
        }
        Ok(())
    }

    pub fn register(
        &self,
        binding: AgentInteractionBindingV1,
        commands: Arc<dyn AgentProviderCommands>,
    ) -> Result<(), AgentConversationApiErrorV1> {
        let mut runtimes = self
            .runtimes
            .write()
            .map_err(|_| AgentConversationApiErrorV1::RuntimeUnavailable)?;
        if let Some(current) = runtimes.get(&binding.interaction_session_id)
            && !current.binding.same_runtime_authority(&binding)
        {
            return Err(AgentConversationApiErrorV1::Conflict);
        }
        runtimes.insert(
            binding.interaction_session_id.clone(),
            BoundRuntime { binding, commands },
        );
        Ok(())
    }

    pub fn retire(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        runtime: &AgentProviderRuntimeFenceV1,
    ) -> Result<bool, AgentConversationApiErrorV1> {
        let mut runtimes = self
            .runtimes
            .write()
            .map_err(|_| AgentConversationApiErrorV1::RuntimeUnavailable)?;
        if runtimes
            .get(interaction_session_id)
            .is_some_and(|bound| bound.binding.runtime == *runtime)
        {
            runtimes.remove(interaction_session_id);
            return Ok(true);
        }
        Ok(false)
    }

    /// Projects a durable runtime-close admission into the command hot path.
    /// Registration remains allowed so a recovered provider process can be
    /// attached solely for exact stop, but no further user command resolves.
    pub fn block_commands_for_close(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        operation_id: &OperationIdV1,
    ) -> Result<(), AgentConversationApiErrorV1> {
        self.command_blocks
            .write()
            .map_err(|_| AgentConversationApiErrorV1::RuntimeUnavailable)?
            .entry(interaction_session_id.clone())
            .or_default()
            .insert(operation_id.clone());
        Ok(())
    }

    /// Releases only the hot-path projection of a close attempt whose durable
    /// journal retained the source. The caller owns the per-Agent operation
    /// lock and advances the journal before removing this block.
    pub fn unblock_commands_after_retained_close(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        operation_id: &OperationIdV1,
    ) -> Result<(), AgentConversationApiErrorV1> {
        let mut blocks = self
            .command_blocks
            .write()
            .map_err(|_| AgentConversationApiErrorV1::RuntimeUnavailable)?;
        let remove_session = blocks
            .get_mut(interaction_session_id)
            .is_some_and(|owners| {
                owners.remove(operation_id);
                owners.is_empty()
            });
        if remove_session {
            blocks.remove(interaction_session_id);
        }
        Ok(())
    }

    fn resolve(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<Arc<dyn AgentProviderCommands>, AgentConversationApiErrorV1> {
        if self
            .command_blocks
            .read()
            .map_err(|_| AgentConversationApiErrorV1::RuntimeUnavailable)?
            .contains_key(&binding.interaction_session_id)
        {
            return Err(AgentConversationApiErrorV1::NotFound);
        }
        let runtimes = self
            .runtimes
            .read()
            .map_err(|_| AgentConversationApiErrorV1::RuntimeUnavailable)?;
        let bound = runtimes
            .get(&binding.interaction_session_id)
            .ok_or(AgentConversationApiErrorV1::RuntimeUnavailable)?;
        if !bound.binding.same_runtime_authority(binding) {
            return Err(AgentConversationApiErrorV1::Conflict);
        }
        Ok(Arc::clone(&bound.commands))
    }
}

pub struct AgentConversationSubscriptionV1 {
    pub initial: AgentTimelineReadV1,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub notifications: broadcast::Receiver<AgentConversationNotificationV1>,
}

pub struct AgentConversationApi<S> {
    runtime_registry: Arc<AgentConversationRuntimeRegistry>,
    service: Arc<AgentConversationService<S>>,
}

impl<S> AgentConversationApi<S>
where
    S: AgentTimelineStore + 'static,
{
    pub fn new(
        service: Arc<AgentConversationService<S>>,
        runtime_registry: Arc<AgentConversationRuntimeRegistry>,
    ) -> Self {
        Self {
            runtime_registry,
            service,
        }
    }

    pub async fn dispatch(
        &self,
        operation: &str,
        body: &Value,
    ) -> Option<Result<Value, AgentConversationApiErrorV1>>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        match operation {
            CREATE_OPERATION => Some(self.create(body).await),
            INSPECT_OPERATION => Some(self.inspect(body).await),
            READ_OPERATION => Some(self.read(body).await),
            READ_QUEUE_OPERATION => Some(self.read_queue(body).await),
            INSPECT_INPUT_OPERATION => Some(self.inspect_input(body).await),
            START_TURN_OPERATION => Some(self.start_turn(body).await),
            CONTINUE_TURN_OPERATION => Some(self.continue_turn(body).await),
            STEER_TURN_OPERATION => Some(self.steer_turn(body).await),
            ENQUEUE_TURN_OPERATION => Some(self.enqueue_turn(body).await),
            CANCEL_QUEUED_TURN_OPERATION => Some(self.cancel_queued_turn(body).await),
            ANSWER_PENDING_OPERATION => Some(self.answer_pending(body).await),
            INTERRUPT_TURN_OPERATION => Some(self.interrupt_turn(body).await),
            _ => None,
        }
    }

    pub async fn subscribe(
        &self,
        body: &Value,
    ) -> Result<AgentConversationSubscriptionV1, AgentConversationApiErrorV1> {
        let request: AgentTimelineReadRequestV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        request
            .validate()
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let notifications = self.service.subscribe();
        let initial = self.service.read(&request).await?;
        Ok(AgentConversationSubscriptionV1 {
            interaction_session_id: request.interaction_session_id,
            initial,
            notifications,
        })
    }

    pub(crate) async fn publish_goal_change(
        &self,
        agent_id: &AgentIdV1,
    ) -> Result<(), AgentConversationApiErrorV1> {
        self.service
            .publish_goal_change(agent_id)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn publish_recovery_change(
        &self,
        agent_id: &AgentIdV1,
    ) -> Result<(), AgentConversationApiErrorV1> {
        self.service.publish_projection_change(agent_id,
            crate::agent_conversation::AgentConversationNotificationKindV1::Recovery)
            .await.map_err(Into::into)
    }

    pub(crate) fn notifications(&self) -> broadcast::Receiver<AgentConversationNotificationV1> {
        self.service.subscribe()
    }

    pub(crate) async fn start_goal_turn(
        &self,
        request: &dure_app::AgentGoalTurnRequestV1,
    ) -> Result<Option<AgentTurnEffectReceiptV1>, AgentConversationApiErrorV1>
    where
        S: dure_app::AgentGoalStore,
    {
        let commands = self
            .commands(&request.intent.interaction_session_id)
            .await?;
        self.service
            .start_goal_turn(commands.as_ref(), request)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn start_recovery_turn(
        &self,
        record: &dure_app::AgentRecoveryRecordV1,
    ) -> Result<Option<AgentTurnEffectReceiptV1>, AgentConversationApiErrorV1>
    where
        S: dure_app::AgentRecoveryStore,
    {
        let commands = self.commands(&record.source.interaction_session_id).await?;
        self.service
            .start_recovery_turn(commands.as_ref(), &record.attempt_id)
            .await
            .map_err(Into::into)
    }

    async fn create(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct CreateBody {
            schema_version: u16,
            binding: AgentInteractionBindingV1,
        }

        let body: CreateBody = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        if body.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1 {
            return Err(AgentConversationApiErrorV1::RequestInvalid);
        }
        self.runtime_registry.preflight(&body.binding)?;
        let binding = self.service.create(&body.binding).await?;
        Ok(json!({ "schemaVersion": 1, "binding": binding }))
    }

    async fn inspect(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct InspectBody {
            schema_version: u16,
            agent_id: AgentIdV1,
        }

        let body: InspectBody = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        if body.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1 {
            return Err(AgentConversationApiErrorV1::RequestInvalid);
        }
        let binding = self.service.binding_for_agent(&body.agent_id).await?;
        Ok(json!({ "schemaVersion": 1, "binding": binding }))
    }

    async fn read(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        let request: AgentTimelineReadRequestV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        request
            .validate()
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let read = self.service.read(&request).await?;
        Ok(json!({ "schemaVersion": 1, "read": read }))
    }

    async fn start_turn(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        let intent: AgentStartTurnIntentV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let receipt = self.start_turn_intent(&intent).await?;
        Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
    }

    async fn continue_turn(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        let request: dure_app::AgentContinueTurnRequestV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        request
            .validate()
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let commands = self
            .commands(&request.intent.interaction_session_id)
            .await?;
        let receipt = self
            .service
            .continue_turn(commands.as_ref(), &request)
            .await?;
        Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
    }

    async fn enqueue_turn(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        let intent: AgentStartTurnIntentV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let receipt = self.service.enqueue_turn(&intent).await?;
        Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
    }

    async fn inspect_input(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        let request: dure_app::AgentInputReadRequestV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        if request.schema_version != 1 {
            return Err(AgentConversationApiErrorV1::RequestInvalid);
        }
        Ok(json!({ "schemaVersion": 1, "input": self.service.inspect_input(&request).await? }))
    }

    async fn read_queue(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        let request: dure_app::AgentQueueReadRequestV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        if request.schema_version != 1 {
            return Err(AgentConversationApiErrorV1::RequestInvalid);
        }
        let page = self.service.read_queue(&request).await?;
        Ok(json!({"schemaVersion": 1, "page": page}))
    }

    async fn cancel_queued_turn(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        let request: dure_app::AgentCancelQueuedTurnV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let receipt = self.service.cancel_queued_turn(&request).await?;
        Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
    }

    pub(crate) async fn start_queued_turn(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<Option<AgentTurnEffectReceiptV1>, AgentConversationApiErrorV1>
    where
        S: dure_app::AgentQueuedTurnStore,
    {
        let commands = self.commands(&binding.interaction_session_id).await?;
        self.service
            .start_queued_turn(commands.as_ref(), binding)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn start_turn_intent(
        &self,
        intent: &AgentStartTurnIntentV1,
    ) -> Result<AgentTurnEffectReceiptV1, AgentConversationApiErrorV1> {
        intent
            .validate()
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let commands = self.commands(&intent.interaction_session_id).await?;
        self.service
            .start_turn(commands.as_ref(), intent)
            .await
            .map_err(Into::into)
    }

    async fn steer_turn(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        let intent: AgentStartTurnIntentV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        intent
            .validate()
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let commands = self.commands(&intent.interaction_session_id).await?;
        let receipt = self.service.steer_turn(commands.as_ref(), &intent).await?;
        if receipt.state == dure_app::AgentTurnEffectStateV1::Failed
            && receipt
                .provider_receipt
                .as_ref()
                .and_then(|value| value.get("errorCode"))
                .and_then(Value::as_str)
                == Some("steer_unsupported")
        {
            return Err(AgentConversationApiErrorV1::SteerUnsupported);
        }
        Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
    }

    async fn answer_pending(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        let intent: AgentPendingAnswerIntentV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        intent
            .validate()
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let commands = self.commands(&intent.interaction_session_id).await?;
        let receipt = self
            .service
            .answer_pending(commands.as_ref(), &intent)
            .await?;
        Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
    }

    async fn interrupt_turn(&self, body: &Value) -> Result<Value, AgentConversationApiErrorV1> {
        let request: AgentInterruptTurnRequestV1 = serde_json::from_value(body.clone())
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        request
            .validate()
            .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
        let commands = self.commands(&request.interaction_session_id).await?;
        let receipt = self
            .service
            .interrupt_turn(commands.as_ref(), &request)
            .await?;
        Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
    }

    async fn commands(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
    ) -> Result<Arc<dyn AgentProviderCommands>, AgentConversationApiErrorV1> {
        let binding = self
            .service
            .binding(interaction_session_id)
            .await?
            .ok_or(AgentConversationApiErrorV1::NotFound)?;
        self.runtime_registry.resolve(&binding)
    }
}

async fn write_persistent_frame(stream: &mut UnixStream, value: &Value) -> io::Result<()> {
    let mut source = serde_json::to_vec(value)?;
    if source.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "backend subscription frame is too large",
        ));
    }
    source.push(b'\n');
    timeout(REQUEST_IO_TIMEOUT, async {
        stream.write_all(&source).await?;
        stream.flush().await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "backend response timed out"))?
}

async fn stream_subscription(
    state: Arc<ServiceState>,
    stream: UnixStream,
    request_id: String,
    mut subscription: AgentConversationSubscriptionV1,
    _subscription_permit: OwnedSemaphorePermit,
) -> io::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    loop {
        let notification = tokio::select! {
            read = reader.read_u8() => {
                let _ = read;
                return Ok(());
            }
            notification = subscription.notifications.recv() => notification,
        };
        let event = match notification {
            Ok(notification)
                if notification.interaction_session_id == subscription.interaction_session_id =>
            {
                json!({
                    "schemaVersion": 1,
                    "apiVersion": BACKEND_PROTOCOL_API,
                    "kind": "dure.backend.event",
                    "backend": backend_observation(&state.descriptor),
                    "event": {
                        "schemaVersion": 1,
                        "topic": "agent_conversation.changed",
                        "subscriptionRequestId": request_id,
                        "notification": notification,
                    },
                })
            }
            Ok(_) => continue,
            Err(broadcast::error::RecvError::Lagged(_)) => json!({
                "schemaVersion": 1,
                "apiVersion": BACKEND_PROTOCOL_API,
                "kind": "dure.backend.event",
                "backend": backend_observation(&state.descriptor),
                "event": {
                    "schemaVersion": 1,
                    "topic": "agent_conversation.reset_required",
                    "subscriptionRequestId": request_id,
                    "interactionSessionId": subscription.interaction_session_id,
                },
            }),
            Err(broadcast::error::RecvError::Closed) => return Ok(()),
        };
        let mut source = serde_json::to_vec(&event)?;
        if source.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "backend subscription frame is too large",
            ));
        }
        source.push(b'\n');
        timeout(REQUEST_IO_TIMEOUT, async {
            writer.write_all(&source).await?;
            writer.flush().await
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "backend event timed out"))??;
    }
}

pub(super) async fn handle_subscription(
    state: Arc<ServiceState>,
    mut reader: BufReader<UnixStream>,
    request: BackendRequest,
) -> io::Result<()> {
    let request_id = request.request_id.clone();
    let response = match validate_request(&request, &state) {
        Ok(_) if !requests_persistent_connection(&request) => json!({
            "schemaVersion": 1,
            "apiVersion": BACKEND_PROTOCOL_API,
            "kind": BACKEND_ERROR_KIND,
            "requestId": request_id,
            "backend": backend_observation(&state.descriptor),
            "error": backend_error_body(BackendDispatchError::terminal(
                "agent_conversation_subscription_requires_persistent_connection",
            )),
        }),
        Ok(_) => match Arc::clone(&state.request_slots).try_acquire_owned() {
            Err(_) => json!({
                "schemaVersion": 1,
                "apiVersion": BACKEND_PROTOCOL_API,
                "kind": BACKEND_ERROR_KIND,
                "requestId": request_id,
                "backend": backend_observation(&state.descriptor),
                "error": {
                    "code": "backend_busy",
                    "message": "backend request capacity is exhausted",
                    "details": { "disposition": "retry_same" }
                },
            }),
            Ok(permit) => {
                let subscribed = timeout(
                    REQUEST_DEADLINE,
                    state.agent_conversations.subscribe(&request.body),
                )
                .await;
                drop(permit);
                match subscribed {
                    Err(_) => json!({
                        "schemaVersion": 1,
                        "apiVersion": BACKEND_PROTOCOL_API,
                        "kind": BACKEND_ERROR_KIND,
                        "requestId": request_id,
                        "backend": backend_observation(&state.descriptor),
                        "error": {
                            "code": "backend_request_deadline_exceeded",
                            "message": "backend request deadline exceeded",
                            "details": { "disposition": "retry_same" }
                        },
                    }),
                    Ok(Err(error)) => json!({
                        "schemaVersion": 1,
                        "apiVersion": BACKEND_PROTOCOL_API,
                        "kind": BACKEND_ERROR_KIND,
                        "requestId": request_id,
                        "backend": backend_observation(&state.descriptor),
                        "error": backend_error_body(agent_conversation_api_error(error)),
                    }),
                    Ok(Ok(subscription)) => {
                        match Arc::clone(&state.subscription_slots).try_acquire_owned() {
                            Err(_) => json!({
                                "schemaVersion": 1,
                                "apiVersion": BACKEND_PROTOCOL_API,
                                "kind": BACKEND_ERROR_KIND,
                                "requestId": request_id,
                                "backend": backend_observation(&state.descriptor),
                                "error": {
                                    "code": "backend_subscription_capacity",
                                    "message": "backend subscription capacity is exhausted",
                                    "details": { "disposition": "retry_same" }
                                },
                            }),
                            Ok(subscription_permit) => {
                                let response = json!({
                                    "schemaVersion": 1,
                                    "apiVersion": BACKEND_PROTOCOL_API,
                                    "kind": BACKEND_RESPONSE_KIND,
                                    "requestId": request_id,
                                    "backend": backend_observation(&state.descriptor),
                                    "result": {
                                        "schemaVersion": 1,
                                        "read": subscription.initial,
                                    },
                                });
                                write_persistent_frame(reader.get_mut(), &response).await?;
                                if !reader.buffer().is_empty() {
                                    return Ok(());
                                }
                                return stream_subscription(
                                    state,
                                    reader.into_inner(),
                                    request_id,
                                    subscription,
                                    subscription_permit,
                                )
                                .await;
                            }
                        }
                    }
                }
            }
        },
        Err(code) => json!({
            "schemaVersion": 1,
            "apiVersion": BACKEND_PROTOCOL_API,
            "kind": BACKEND_ERROR_KIND,
            "requestId": request_id,
            "backend": backend_observation(&state.descriptor),
            "error": { "code": code, "message": "backend request rejected" },
        }),
    };
    write_persistent_frame(reader.get_mut(), &response).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use dure_app::{
        AgentExecutionProfileV1, AgentProviderRuntimeFenceV1, AgentRecordV1, AgentTimelineEpochV1,
        AgentTimelineStore, DomainStore, ProjectIdV1, ProjectRecordV1, ProviderIdV1, WorkspaceIdV1,
        WorkspaceRecordV1,
    };
    use dure_app_sqlite::SqliteDomainStore;
    use tempfile::TempDir;
    use tokio::io::AsyncBufReadExt;

    #[tokio::test]
    async fn subscription_initial_snapshot_can_exceed_the_request_frame_limit() {
        let (writer, reader) = UnixStream::pair().unwrap();
        let response = json!({
            "schemaVersion": 1,
            "kind": BACKEND_RESPONSE_KIND,
            "result": { "read": "x".repeat(crate::MAX_REQUEST_BYTES as usize) },
        });
        let expected = serde_json::to_vec(&response).unwrap();
        assert!(expected.len() as u64 > crate::MAX_REQUEST_BYTES);
        assert!(expected.len() as u64 <= MAX_RESPONSE_BYTES);
        let mut reader = BufReader::new(reader);
        let mut received = Vec::new();

        let write = async move {
            let mut writer = writer;
            write_persistent_frame(&mut writer, &response).await
        };
        let (written, read) = tokio::join!(write, reader.read_until(b'\n', &mut received));

        written.expect("a valid backend response must retain its frame");
        assert_eq!(read.unwrap(), expected.len() + 1);
        assert_eq!(received.last(), Some(&b'\n'));
        received.pop();
        assert_eq!(received, expected);
    }

    struct FakeCommands;

    impl AgentProviderCommands for FakeCommands {
        fn start_turn<'a>(
            &'a self,
            _binding: &'a AgentInteractionBindingV1,
            _intent: &'a AgentStartTurnIntentV1,
        ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
            Box::pin(async { Ok(json!({})) })
        }

        fn answer_pending<'a>(
            &'a self,
            _binding: &'a AgentInteractionBindingV1,
            _intent: &'a AgentPendingAnswerIntentV1,
            _request: &'a dure_app::AgentPendingRequestV1,
        ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
            Box::pin(async { Ok(json!({})) })
        }

        fn interrupt_turn<'a>(
            &'a self,
            _binding: &'a AgentInteractionBindingV1,
            _request: &'a AgentInterruptTurnRequestV1,
        ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
            Box::pin(async { Ok(json!({})) })
        }
    }

    fn binding() -> AgentInteractionBindingV1 {
        AgentInteractionBindingV1 {
            schema_version: 1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("thread-1".into()),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-1".into(),
                provider_epoch: "provider-1".into(),
            },
            timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn durable_close_projection_blocks_commands_even_if_stop_recovery_registers_again() {
        let registry = AgentConversationRuntimeRegistry::default();
        let binding = binding();
        registry
            .register(binding.clone(), Arc::new(FakeCommands))
            .unwrap();
        assert!(registry.resolve(&binding).is_ok());

        registry
            .block_commands_for_close(
                &binding.interaction_session_id,
                &OperationIdV1::new("runtime-close-1").unwrap(),
            )
            .unwrap();
        registry
            .block_commands_for_close(
                &binding.interaction_session_id,
                &OperationIdV1::new("runtime-close-2").unwrap(),
            )
            .unwrap();
        registry
            .register(binding.clone(), Arc::new(FakeCommands))
            .unwrap();

        assert!(matches!(
            registry.resolve(&binding),
            Err(AgentConversationApiErrorV1::NotFound)
        ));

        registry
            .unblock_commands_after_retained_close(
                &binding.interaction_session_id,
                &OperationIdV1::new("runtime-close-1").unwrap(),
            )
            .unwrap();
        assert!(matches!(
            registry.resolve(&binding),
            Err(AgentConversationApiErrorV1::NotFound)
        ));
        registry
            .unblock_commands_after_retained_close(
                &binding.interaction_session_id,
                &OperationIdV1::new("runtime-close-2").unwrap(),
            )
            .unwrap();
        assert!(registry.resolve(&binding).is_ok());
    }

    #[tokio::test]
    async fn subscribe_keeps_durable_history_available_without_a_live_runtime() {
        let root = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteDomainStore::open(root.path().join("domain.sqlite"))
                .await
                .unwrap(),
        );
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: ProjectIdV1::new("project-1").unwrap(),
                root_path: root.path().to_string_lossy().into_owned(),
                display_name: "Project".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
                project_id: ProjectIdV1::new("project-1").unwrap(),
                root_path: root.path().to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: AgentIdV1::new("agent-1").unwrap(),
                workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                display_name: "Codex".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store.create_agent_interaction(&binding()).await.unwrap();

        let service = Arc::new(AgentConversationService::new(store));
        let registry = Arc::new(AgentConversationRuntimeRegistry::default());
        let api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));
        let request = json!({
            "schemaVersion": 1,
            "interactionSessionId": "interaction-1",
            "direction": "tail",
            "cursor": null,
            "limit": 100,
        });
        let mut subscription = api.subscribe(&request).await.unwrap();

        registry
            .register(binding(), Arc::new(FakeCommands))
            .unwrap();
        registry
            .retire(&binding().interaction_session_id, &binding().runtime)
            .unwrap();
        service.invalidate_runtime(&binding()).await.unwrap();
        let notification =
            tokio::time::timeout(Duration::from_secs(1), subscription.notifications.recv())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            notification.kinds,
            vec![crate::agent_conversation::AgentConversationNotificationKindV1::Runtime]
        );
    }
}
