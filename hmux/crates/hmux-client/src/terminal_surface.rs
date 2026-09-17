use crate::connection::{
    BufferedRecordRead, TerminalInputWriterCapability, TerminalProjectionHandle,
    TerminalSurfaceDetachHandle,
};
use crate::{
    AttachReplay, ClientError, ConnectionOptions, ConnectionRecord, LocalAttachRole,
    LocalConnection, TerminalUpstreamHandles,
};
#[cfg(feature = "local-runtime")]
use crate::{LocalSessionCatalog, SessionClass, SessionFence, SessionSelector};
use hmux_runtime_contract::{TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BASE_PROTOCOL_MINOR};
use hmux_session_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_PROMPT_CAPABILITY, AgentPromptCapabilitySelection,
    DEFAULT_MAX_FRAME_BYTES, FrameBody, LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
    MANAGED_AUTHORIZATION_GRANT_CAPABILITY, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, WORKING_DIRECTORY_FRAME_CAPABILITY,
};
#[cfg(feature = "local-runtime")]
use hmux_session_protocol::{AttachMode, select_managed_agent_prompt_capability};
use std::collections::VecDeque;
use std::fmt;
use std::time::{Duration, Instant};
use terminal_state_protocol::{
    AgentPromptInputIntent, ExistingConversationPromptTarget, FollowTail, FreshAgentPromptTarget,
    InputIntent, InputReceipt, InputRefusalReason, KeyInputIntent,
    MAX_AGENT_PROMPT_ADMISSION_WAIT_MS, MAX_VIEWPORT_FRAME_BYTES, PasteInputIntent,
    ProcessObservedFreshAgentPromptTarget, ResizeInputIntent, ResizeReceipt, RowTermination,
    ScrollRows, SetViewportRows, TerminalEvent, TerminalStateRecord, TextInputIntent,
    ViewportFrame, ViewportFrameAssembler, ViewportFrameAssembly, ViewportFrameProgress,
    ViewportIntent, WheelReceipt, agent_prompt_input_intent, decode_record, input_intent,
    input_receipt, terminal_state_record, viewport_intent,
};

const MAX_PENDING_SURFACE_EVENTS: usize = 64;
const MAX_BUFFERED_SURFACE_STEPS_PER_PASS: usize = 64;
const MAX_BUFFERED_SURFACE_PAYLOAD_BYTES_PER_PASS: usize =
    MAX_VIEWPORT_FRAME_BYTES + DEFAULT_MAX_FRAME_BYTES;
const AGENT_PROMPT_RECEIPT_MARGIN: Duration = Duration::from_millis(100);

/// Final correlated receipts for one orchestration-level command input.
/// Text and submit remain separate semantic records all the way to the Host;
/// there is intentionally no controller generation because terminal input
/// intents do not acquire a controller lease.
#[derive(Clone, Eq, PartialEq)]
pub struct TerminalCommandInputReceipt {
    terminal_epoch: String,
    text: Option<InputReceipt>,
    submit: Option<InputReceipt>,
}

impl fmt::Debug for TerminalCommandInputReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalCommandInputReceipt")
            .field("terminal_epoch", &self.terminal_epoch)
            .field(
                "text_record_id",
                &self
                    .text
                    .as_ref()
                    .map(|receipt| receipt.in_reply_to_record_id),
            )
            .field(
                "submit_record_id",
                &self
                    .submit
                    .as_ref()
                    .map(|receipt| receipt.in_reply_to_record_id),
            )
            .finish()
    }
}

impl TerminalCommandInputReceipt {
    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn text(&self) -> Option<&InputReceipt> {
        self.text.as_ref()
    }

    #[must_use]
    pub fn submit(&self) -> Option<&InputReceipt> {
        self.submit.as_ref()
    }
}

/// Failure posture for an ordered text-then-submit operation. Callers follow
/// `delivery_state` and never infer retry safety from `body_delivered == false`:
/// the first intent itself can have an unknown PTY outcome.
#[derive(Debug)]
pub struct TerminalCommandInputError {
    source: ClientError,
    body_delivered: bool,
}

impl TerminalCommandInputError {
    fn new(source: ClientError, body_delivered: bool) -> Self {
        Self {
            source,
            body_delivered,
        }
    }

    #[must_use]
    pub fn code(&self) -> &str {
        self.source.code()
    }

    #[must_use]
    pub fn body_delivered(&self) -> bool {
        self.body_delivered
    }

    /// Conservative retry posture projected from the semantic operation. A
    /// failed Host receipt can represent a partial PTY write, so only a final
    /// refusal is classified as definitely not written.
    #[must_use]
    pub fn delivery_state(&self) -> &'static str {
        if self.body_delivered {
            "body_written_submit_unknown"
        } else if matches!(
            self.source.code(),
            "hmux_terminal_input_outcome_unknown"
                | "hmux_terminal_input_failed"
                | "hmux_terminal_input_receipt_invalid"
        ) {
            "unknown"
        } else {
            "not_written"
        }
    }
}

impl fmt::Display for TerminalCommandInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for TerminalCommandInputError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// Final proof for one Host-atomic agent prompt operation.
#[derive(Clone, Eq, PartialEq)]
pub struct TerminalAgentPromptReceipt {
    terminal_epoch: String,
    input: InputReceipt,
    input_baseline_output_sequence: u64,
    agent_runtime_revision: Option<u64>,
}

impl fmt::Debug for TerminalAgentPromptReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalAgentPromptReceipt")
            .field("terminal_epoch", &self.terminal_epoch)
            .field("record_id", &self.input.in_reply_to_record_id)
            .field(
                "input_baseline_output_sequence",
                &self.input_baseline_output_sequence,
            )
            .field("agent_runtime_revision", &self.agent_runtime_revision)
            .finish()
    }
}

impl TerminalAgentPromptReceipt {
    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn input(&self) -> &InputReceipt {
        &self.input
    }

    #[must_use]
    pub fn input_baseline_output_sequence(&self) -> u64 {
        self.input_baseline_output_sequence
    }

    #[must_use]
    pub fn admitted_agent_runtime_revision(&self) -> Option<u64> {
        self.agent_runtime_revision
    }
}

/// Retry posture for a single agent-prompt operation. Only failures that
/// happen before the terminal record starts writing, plus final Host refusals,
/// are definitely safe to retry.
#[derive(Debug)]
pub struct TerminalAgentPromptError {
    source: ClientError,
    outcome_unknown: bool,
}

impl TerminalAgentPromptError {
    fn new(source: ClientError) -> Self {
        let outcome_unknown = terminal_input_outcome_is_unknown(source.code());
        Self {
            source,
            outcome_unknown,
        }
    }

    fn not_written(source: ClientError) -> Self {
        Self {
            source,
            outcome_unknown: false,
        }
    }

    #[must_use]
    pub fn code(&self) -> &str {
        self.source.code()
    }

    #[must_use]
    pub fn delivery_state(&self) -> &'static str {
        if self.outcome_unknown {
            "unknown"
        } else {
            "not_written"
        }
    }
}

impl fmt::Display for TerminalAgentPromptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for TerminalAgentPromptError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// One complete viewport frame plus an exact logical-text projection.
#[derive(Clone)]
pub struct TerminalSurfaceFrame {
    record_id: u64,
    terminal_epoch: String,
    through_output_seq: u64,
    state_revision: u64,
    viewport: ViewportFrame,
    text: String,
}

impl fmt::Debug for TerminalSurfaceFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalSurfaceFrame")
            .field("record_id", &self.record_id)
            .field("terminal_epoch", &self.terminal_epoch)
            .field("through_output_seq", &self.through_output_seq)
            .field("state_revision", &self.state_revision)
            .field("projection_revision", &self.viewport.projection_revision)
            .field("text", &"<redacted>")
            .finish()
    }
}

impl TerminalSurfaceFrame {
    pub fn decode(encoded: &[u8]) -> Result<Self, ClientError> {
        let decoded = decode_record(encoded)?;
        Self::from_decoded(decoded)
    }

    fn from_decoded(decoded: terminal_state_protocol::DecodedRecord) -> Result<Self, ClientError> {
        let record = decoded.record;
        let Some(terminal_state_record::Body::ViewportFrame(viewport)) = record.body else {
            return Err(ClientError::transport(
                "hmux_terminal_viewport_frame_required",
                "terminal surface projection requires a complete viewport frame",
            ));
        };
        let text = project_text(&viewport)?;
        Ok(Self {
            record_id: decoded.metadata.record_id,
            terminal_epoch: record.terminal_epoch,
            through_output_seq: record.through_output_seq,
            state_revision: record.state_revision,
            viewport,
            text,
        })
    }

    #[must_use]
    pub fn record_id(&self) -> u64 {
        self.record_id
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn through_output_seq(&self) -> u64 {
        self.through_output_seq
    }

    #[must_use]
    pub fn state_revision(&self) -> u64 {
        self.state_revision
    }

    #[must_use]
    pub fn viewport(&self) -> &ViewportFrame {
        &self.viewport
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    fn progress(&self) -> ViewportFrameProgress {
        ViewportFrameProgress {
            terminal_epoch: self.terminal_epoch.clone(),
            through_output_seq: self.through_output_seq,
            state_revision: self.state_revision,
            projection_revision: self.viewport.projection_revision,
            applied_intent_seq: self.viewport.applied_intent_seq,
        }
    }
}

/// Whether an attached surface only observes frames or may also write to the
/// terminal. Both use the observer attach mode; writable admission comes only
/// from the semantic input capability.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalSurfaceAccess {
    ReadOnly,
    Writer,
}

/// A correlated final binary outcome. There is intentionally no accepted,
/// revoked, or released state because semantic input has no controller lease.
#[derive(Clone, PartialEq)]
pub enum TerminalIntentReceipt {
    Input(InputReceipt),
    Resize(ResizeReceipt),
    Wheel(WheelReceipt),
}

impl fmt::Debug for TerminalIntentReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(receipt) => formatter
                .debug_struct("TerminalInputReceipt")
                .field("in_reply_to_record_id", &receipt.in_reply_to_record_id)
                .finish_non_exhaustive(),
            Self::Resize(receipt) => formatter
                .debug_struct("TerminalResizeReceipt")
                .field("in_reply_to_record_id", &receipt.in_reply_to_record_id)
                .finish_non_exhaustive(),
            Self::Wheel(receipt) => formatter
                .debug_struct("TerminalWheelReceipt")
                .field("in_reply_to_record_id", &receipt.in_reply_to_record_id)
                .finish_non_exhaustive(),
        }
    }
}

pub enum TerminalSurfaceEvent {
    Frame(Box<TerminalSurfaceFrame>),
    Event(TerminalEvent),
    Receipt(TerminalIntentReceipt),
    Control(Box<FrameBody>),
}

impl fmt::Debug for TerminalSurfaceEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Frame(frame) => formatter.debug_tuple("Frame").field(frame).finish(),
            Self::Event(event) => formatter
                .debug_struct("Event")
                .field("event_id", &event.event_id)
                .finish_non_exhaustive(),
            Self::Receipt(receipt) => formatter.debug_tuple("Receipt").field(receipt).finish(),
            Self::Control(body) => formatter.debug_tuple("Control").field(body).finish(),
        }
    }
}

/// One ephemeral terminal projection and its single underlying connection.
///
/// The leaf retains only the latest complete bounded frame. It has no history
/// cache, PTY handle, controller generation, or reconnectable projection id.
pub struct TerminalSurfaceAttachment {
    connection: LocalConnection,
    projection: TerminalProjectionHandle,
    input_writer: Option<TerminalInputWriterCapability>,
    current: TerminalSurfaceFrame,
    initial_agent_identity: Option<crate::AgentIdentityDescriptor>,
    initial_agent_runtime_state: Option<crate::AgentRuntimeStateDescriptor>,
    initial_provider_conversation_identity: Option<crate::ProviderConversationIdentityDescriptor>,
    initial_working_directory: Option<crate::WorkingDirectoryDescriptor>,
    initial_delivery_records: Vec<Vec<u8>>,
    pending_delivery_parts: Vec<Vec<u8>>,
    delivery_queue: VecDeque<TerminalSurfaceDelivery>,
    delivery_queue_bytes: usize,
    deferred_delivery_error: Option<ClientError>,
    read_mode: Option<TerminalSurfaceReadMode>,
    next_record_id: u64,
    next_viewport_intent_seq: u64,
    pending_events: VecDeque<TerminalSurfaceEvent>,
    viewport_frames: ViewportFrameAssembler,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TerminalSurfaceReadMode {
    Events,
    Delivery,
}

struct TerminalDeliveryBatch {
    records: VecDeque<Vec<u8>>,
    replaceable_viewport: bool,
}

enum TerminalSurfaceDelivery {
    Terminal(TerminalDeliveryBatch),
    Control(Box<FrameBody>),
}

impl TerminalSurfaceDelivery {
    fn is_replaceable_viewport(&self) -> bool {
        matches!(
            self,
            Self::Terminal(TerminalDeliveryBatch {
                replaceable_viewport: true,
                ..
            })
        )
    }

    fn is_exit(&self) -> bool {
        matches!(self, Self::Control(body) if matches!(body.as_ref(), FrameBody::Exit(_)))
    }

    fn accounted_bytes(&self) -> usize {
        match self {
            Self::Terminal(batch) => batch.records.iter().map(Vec::len).sum(),
            Self::Control(_) => DEFAULT_MAX_FRAME_BYTES,
        }
    }
}

impl fmt::Debug for TerminalSurfaceAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalSurfaceAttachment")
            .field("writer", &self.input_writer.is_some())
            .field("current", &self.current)
            .finish_non_exhaustive()
    }
}

impl TerminalSurfaceAttachment {
    /// Builds the only attach posture this leaf uses. A writable surface is
    /// still an observer and never asks for shared input or a controller lease.
    #[must_use]
    pub fn connection_options(
        access: TerminalSurfaceAccess,
        authorization_proof_reference: Option<String>,
    ) -> ConnectionOptions {
        Self::connection_options_with_capabilities(access, authorization_proof_reference, true, &[])
    }

    fn connection_options_with_capabilities(
        access: TerminalSurfaceAccess,
        authorization_proof_reference: Option<String>,
        request_authorization_grant: bool,
        additional_capabilities: &[&'static str],
    ) -> ConnectionOptions {
        let has_authorization_proof = authorization_proof_reference.is_some();
        let mut optional_capabilities = vec![
            AGENT_IDENTITY_PROJECTION_CAPABILITY,
            PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            WORKING_DIRECTORY_FRAME_CAPABILITY,
        ];
        if has_authorization_proof && request_authorization_grant {
            optional_capabilities.push(MANAGED_AUTHORIZATION_GRANT_CAPABILITY);
        }
        optional_capabilities.extend_from_slice(additional_capabilities);
        let options =
            ConnectionOptions::new(LocalAttachRole::Observer, authorization_proof_reference)
                .with_optional_capabilities(&optional_capabilities)
                .with_terminal_viewport_projection()
                .with_agent_runtime_state()
                .with_terminal_viewport_wheel()
                .with_terminal_viewport_multipart();
        match access {
            TerminalSurfaceAccess::ReadOnly => options,
            TerminalSurfaceAccess::Writer => options
                .with_terminal_input_intents()
                .with_terminal_default_colors(),
        }
    }

    /// Builds the explicit attach posture for one Host-atomic agent prompt
    /// operation. A remote gateway may supply the local managed grant;
    /// direct local callers pass the grant they minted for this attachment.
    #[must_use]
    pub fn agent_prompt_connection_options(
        authorization_proof_reference: Option<String>,
    ) -> ConnectionOptions {
        let request_authorization_grant = authorization_proof_reference.is_some();
        Self::connection_options_with_capabilities(
            TerminalSurfaceAccess::ReadOnly,
            authorization_proof_reference,
            request_authorization_grant,
            &[
                AGENT_PROMPT_CAPABILITY,
                PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            ],
        )
    }

    /// Opens one exact local managed generation for an agent prompt while
    /// keeping discovery fencing and the one-use proof inside hmux-client.
    #[cfg(feature = "local-runtime")]
    pub fn connect_local_agent_prompt(
        catalog: &LocalSessionCatalog,
        expected: &SessionFence,
    ) -> Result<Self, ClientError> {
        let session = catalog.open(&SessionSelector::new(
            &expected.session_id,
            Some(expected.workspace_id.clone()),
        ))?;
        if session.descriptor().session_class != SessionClass::Managed {
            return Err(ClientError::transport(
                "hmux_agent_prompt_requires_managed",
                "agent prompt input requires a managed session",
            ));
        }
        if !session.descriptor().matches_fence(expected) {
            return Err(ClientError::transport(
                "hmux_expected_generation_mismatch",
                "managed session generation changed before exact input",
            ));
        }
        let selected_prompt = select_managed_agent_prompt_capability(
            AttachMode::Observer,
            true,
            &session.descriptor().capabilities,
            &session.descriptor().capabilities,
        );
        let proof = session.managed_attach_authorization_proof()?;
        let mut options = Self::agent_prompt_connection_options(Some(proof));
        if selected_prompt == Some(AgentPromptCapabilitySelection::LegacyFresh) {
            options = options.with_legacy_agent_prompt_fallback();
        }
        let connection = session.connect_with_options(options)?;
        Self::from_connection(connection)
    }

    /// Installs the complete viewport frame consumed during the real attach
    /// handshake. Dialing and relay identity remain outside this leaf.
    pub fn from_connection(connection: LocalConnection) -> Result<Self, ClientError> {
        let projection = connection.terminal_projection_handle()?;
        let input_writer = connection.terminal_input_writer_capability();
        if connection.attach_replay() != &AttachReplay::TerminalViewportFrame {
            return Err(ClientError::transport(
                "hmux_terminal_viewport_seed_required",
                "terminal surface attach requires one complete viewport seed",
            ));
        }
        let initial_agent_identity = connection
            .initial_terminal_state()
            .and_then(|initial| initial.agent_identity())
            .cloned()
            .map(crate::observer::project_agent_identity);
        let initial_agent_runtime_state = connection
            .initial_terminal_state()
            .and_then(|initial| initial.agent_runtime_state())
            .cloned()
            .map(crate::observer::project_agent_runtime_state)
            .transpose()?;
        let initial_provider_conversation_identity = connection
            .initial_terminal_state()
            .and_then(|initial| initial.provider_conversation_identity())
            .cloned()
            .map(crate::observer::project_provider_conversation_identity);
        let initial_working_directory = connection
            .initial_terminal_state()
            .and_then(|initial| initial.working_directory())
            .cloned()
            .map(crate::observer::project_working_directory_projection);
        let (current, viewport_frames, initial_delivery_records) = {
            let initial = connection.initial_terminal_state().ok_or_else(|| {
                ClientError::transport(
                    "hmux_terminal_viewport_seed_required",
                    "terminal surface attach has no viewport seed",
                )
            })?;
            let mut assembler = ViewportFrameAssembler::default();
            let mut current = None;
            let initial_delivery_records = initial.records().map(<[u8]>::to_vec).collect();
            for encoded in initial.records() {
                let decoded = decode_record(encoded)?;
                let complete = match assembler.push_downstream(decoded) {
                    ViewportFrameAssembly::Downstream(decoded) => Some(decoded),
                    ViewportFrameAssembly::Pending => None,
                    ViewportFrameAssembly::Complete(decoded) => Some(decoded),
                    ViewportFrameAssembly::ResyncRequired(_) => {
                        return Err(invalid_viewport_seed(
                            "terminal surface attach has an invalid viewport seed batch",
                        ));
                    }
                };
                if let Some(decoded) = complete {
                    if current.is_some() {
                        return Err(invalid_viewport_seed(
                            "terminal surface attach has more than one viewport seed",
                        ));
                    }
                    current = Some(TerminalSurfaceFrame::from_decoded(decoded)?);
                }
            }
            if assembler.discard_incomplete() {
                return Err(invalid_viewport_seed(
                    "terminal surface attach has an incomplete viewport seed batch",
                ));
            }
            let current = current.ok_or_else(|| {
                ClientError::transport(
                    "hmux_terminal_viewport_seed_required",
                    "terminal surface attach has no viewport seed",
                )
            })?;
            assembler.set_installed(current.progress());
            (current, assembler, initial_delivery_records)
        };
        let next_viewport_intent_seq = current
            .viewport
            .applied_intent_seq
            .checked_add(1)
            .ok_or_else(sequence_exhausted)?;
        Ok(Self {
            connection,
            projection,
            input_writer,
            current,
            initial_agent_identity,
            initial_agent_runtime_state,
            initial_provider_conversation_identity,
            initial_working_directory,
            initial_delivery_records,
            pending_delivery_parts: Vec::new(),
            delivery_queue: VecDeque::new(),
            delivery_queue_bytes: 0,
            deferred_delivery_error: None,
            read_mode: None,
            next_record_id: 1,
            next_viewport_intent_seq,
            pending_events: VecDeque::new(),
            viewport_frames,
        })
    }

    #[must_use]
    pub fn current_frame(&self) -> &TerminalSurfaceFrame {
        &self.current
    }

    /// Host-owned runtime state captured in the same attach transaction as
    /// the initial viewport. It is absent for ordinary shells and older Hosts.
    #[must_use]
    pub fn initial_agent_runtime_state(&self) -> Option<&crate::AgentRuntimeStateDescriptor> {
        self.initial_agent_runtime_state.as_ref()
    }

    #[must_use]
    pub fn initial_agent_identity(&self) -> Option<&crate::AgentIdentityDescriptor> {
        self.initial_agent_identity.as_ref()
    }

    /// Host-owned identity captured in the same attach transaction as the
    /// initial viewport. It is absent for ordinary shells and older Hosts.
    #[must_use]
    pub fn initial_provider_conversation_identity(
        &self,
    ) -> Option<&crate::ProviderConversationIdentityDescriptor> {
        self.initial_provider_conversation_identity.as_ref()
    }

    /// Host-owned working directory captured in the same attach transaction as
    /// the initial viewport. It is absent for ordinary shells and older Hosts.
    #[must_use]
    pub fn initial_working_directory(&self) -> Option<&crate::WorkingDirectoryDescriptor> {
        self.initial_working_directory.as_ref()
    }

    #[must_use]
    pub fn selected_capabilities(&self) -> &[String] {
        &self.connection.hello_ack().selected_capabilities
    }

    /// Exact binary records that seeded this attachment after the complete
    /// viewport batch passed the high-level surface reducer.
    #[must_use]
    pub fn initial_delivery_records(&self) -> &[Vec<u8>] {
        &self.initial_delivery_records
    }

    /// Capability-bearing upstream handles minted by this exact attachment.
    #[must_use]
    pub fn upstream_handles(&self) -> TerminalUpstreamHandles {
        self.connection.terminal_upstream_handles()
    }

    /// Interrupts a blocked downstream read without adding a polling loop.
    pub fn interrupt_handle(&self) -> Result<crate::ConnectionInterrupt, ClientError> {
        self.connection.interrupt_handle()
    }

    /// Cloneable, attachment-scoped departure authority. This lets an adapter
    /// ask the Host to close a surface whose downstream read is currently
    /// blocked, without treating input or focus as lifecycle authority.
    #[must_use]
    pub fn detach_handle(&self) -> TerminalSurfaceDetachHandle {
        self.connection.terminal_surface_detach_handle()
    }

    /// Returns exact binary records only after their complete state transition
    /// has been accepted. Multipart viewport records are released together and
    /// remain independently reassemblable by the projection client.
    pub fn read_delivery_record(&mut self) -> Result<ConnectionRecord, ClientError> {
        self.select_read_mode(TerminalSurfaceReadMode::Delivery)?;
        if self.front_is_unemitted_replaceable_viewport() && self.deferred_delivery_error.is_none()
        {
            self.collapse_complete_buffered_viewports()?;
        }
        if let Some(record) = self.pop_staged_delivery_record() {
            return Ok(record);
        }
        if let Some(error) = self.deferred_delivery_error.take() {
            return Err(error);
        }

        self.stage_next_delivery_blocking()?;
        if self.front_is_unemitted_replaceable_viewport() {
            self.collapse_complete_buffered_viewports()?;
        }
        self.pop_staged_delivery_record().ok_or_else(|| {
            ClientError::transport(
                "hmux_terminal_surface_delivery_missing",
                "terminal surface completed a delivery read without staging a record",
            )
        })
    }

    fn stage_next_delivery_blocking(&mut self) -> Result<(), ClientError> {
        loop {
            let record = match self.connection.read_record() {
                Ok(record) => record,
                Err(error) if self.viewport_frames.discard_incomplete() => {
                    self.pending_delivery_parts.clear();
                    return Err(invalid_viewport_batch(format!(
                        "viewport frame batch was interrupted by transport loss: {error}"
                    )));
                }
                Err(error) => return Err(error),
            };
            if self.stage_delivery_record(record)? {
                return Ok(());
            }
        }
    }

    fn collapse_complete_buffered_viewports(&mut self) -> Result<(), ClientError> {
        // This is a monotonic work budget, not retained queue memory. The
        // already-staged candidate is deliberately excluded so one complete
        // newer near-limit multipart batch can still replace it atomically.
        let mut consumed_payload_bytes = 0_usize;
        for _ in 0..MAX_BUFFERED_SURFACE_STEPS_PER_PASS {
            if consumed_payload_bytes
                > MAX_BUFFERED_SURFACE_PAYLOAD_BYTES_PER_PASS - DEFAULT_MAX_FRAME_BYTES
            {
                return Ok(());
            }
            let record = match self.connection.read_record_if_complete_buffered() {
                Ok(BufferedRecordRead::NotReady) => return Ok(()),
                Ok(BufferedRecordRead::Ready(record)) => record,
                Ok(BufferedRecordRead::Consumed {
                    record,
                    payload_bytes,
                }) => {
                    debug_assert!(payload_bytes <= DEFAULT_MAX_FRAME_BYTES);
                    consumed_payload_bytes = consumed_payload_bytes.saturating_add(payload_bytes);
                    let Some(record) = record else {
                        continue;
                    };
                    record
                }
                Err(error) if self.viewport_frames.discard_incomplete() => {
                    self.pending_delivery_parts.clear();
                    self.deferred_delivery_error = Some(invalid_viewport_batch(format!(
                        "viewport frame batch was interrupted by transport loss: {error}"
                    )));
                    return Ok(());
                }
                Err(error) if error.code() == "hmux_transport_interrupted" => return Err(error),
                Err(error) => {
                    self.deferred_delivery_error = Some(error);
                    return Ok(());
                }
            };
            match self.stage_delivery_record(record) {
                Ok(true)
                    if self
                        .delivery_queue
                        .back()
                        .is_some_and(|record| record.is_exit()) =>
                {
                    return Ok(());
                }
                Ok(_) => {}
                Err(error) => {
                    self.deferred_delivery_error = Some(error);
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    /// Returns true once one complete logical delivery has been staged.
    fn stage_delivery_record(&mut self, record: ConnectionRecord) -> Result<bool, ClientError> {
        let event = self.project_connection_record(record, true)?;
        match event {
            None => Ok(false),
            Some(TerminalSurfaceEvent::Control(body)) => {
                self.delivery_queue
                    .push_back(TerminalSurfaceDelivery::Control(body));
                self.delivery_queue_bytes = self
                    .delivery_queue_bytes
                    .saturating_add(DEFAULT_MAX_FRAME_BYTES);
                Ok(true)
            }
            Some(_) => Ok(true),
        }
    }

    fn pop_staged_delivery_record(&mut self) -> Option<ConnectionRecord> {
        if matches!(
            self.delivery_queue.front(),
            Some(TerminalSurfaceDelivery::Control(_))
        ) {
            let Some(TerminalSurfaceDelivery::Control(body)) = self.delivery_queue.pop_front()
            else {
                unreachable!("the delivery queue front was checked as control")
            };
            self.delivery_queue_bytes = self
                .delivery_queue_bytes
                .saturating_sub(DEFAULT_MAX_FRAME_BYTES);
            return Some(ConnectionRecord::Control(body));
        }

        let batch = match self.delivery_queue.front_mut() {
            Some(TerminalSurfaceDelivery::Terminal(batch)) => batch,
            Some(TerminalSurfaceDelivery::Control(_)) => unreachable!(),
            None => return None,
        };
        let record = batch.records.pop_front()?;
        batch.replaceable_viewport = false;
        self.delivery_queue_bytes = self.delivery_queue_bytes.saturating_sub(record.len());
        if batch.records.is_empty() {
            self.delivery_queue.pop_front();
        }
        Some(ConnectionRecord::TerminalState(record))
    }

    fn front_is_unemitted_replaceable_viewport(&self) -> bool {
        self.delivery_queue
            .front()
            .is_some_and(TerminalSurfaceDelivery::is_replaceable_viewport)
    }

    fn stage_terminal_delivery(&mut self, records: Vec<Vec<u8>>, replaceable_viewport: bool) {
        let record_bytes = records.iter().map(Vec::len).sum::<usize>();
        if replaceable_viewport {
            let replacement_floor = self
                .delivery_queue
                .iter()
                .enumerate()
                .filter_map(|(index, delivery)| delivery.is_exit().then_some(index + 1))
                .next_back()
                .unwrap_or(0);
            let bytes_before = self.delivery_queue_bytes;
            let mut retained_bytes = 0;
            let mut index = 0;
            self.delivery_queue.retain(|delivery| {
                let keep = index < replacement_floor || !delivery.is_replaceable_viewport();
                if keep {
                    retained_bytes += delivery.accounted_bytes();
                }
                index += 1;
                keep
            });
            debug_assert!(retained_bytes <= bytes_before);
            self.delivery_queue_bytes = retained_bytes;
        }
        self.delivery_queue
            .push_back(TerminalSurfaceDelivery::Terminal(TerminalDeliveryBatch {
                records: records.into(),
                replaceable_viewport,
            }));
        self.delivery_queue_bytes = self.delivery_queue_bytes.saturating_add(record_bytes);
    }

    #[cfg(test)]
    fn buffered_delivery_bytes(&self) -> usize {
        self.pending_delivery_parts
            .iter()
            .map(Vec::len)
            .fold(self.delivery_queue_bytes, usize::saturating_add)
    }

    #[cfg(test)]
    pub(crate) fn buffered_delivery_usage_for_test(&self) -> (usize, usize) {
        (self.delivery_queue.len(), self.buffered_delivery_bytes())
    }

    pub fn read_event(&mut self) -> Result<TerminalSurfaceEvent, ClientError> {
        self.select_read_mode(TerminalSurfaceReadMode::Events)?;
        if let Some(event) = self.pending_events.pop_front() {
            return Ok(event);
        }
        self.read_next_event()
    }

    /// Reads the next event under one absolute deadline for both the first
    /// byte and completion of every frame needed to produce that event. An
    /// error can discard an incomplete multipart viewport, so callers reattach
    /// instead of retrying this surface after failure.
    pub fn read_event_before(
        &mut self,
        deadline: Instant,
    ) -> Result<TerminalSurfaceEvent, ClientError> {
        self.select_read_mode(TerminalSurfaceReadMode::Events)?;
        if let Some(event) = self.pending_events.pop_front() {
            return Ok(event);
        }
        self.read_next_event_before(deadline)
    }

    fn read_next_event(&mut self) -> Result<TerminalSurfaceEvent, ClientError> {
        self.select_read_mode(TerminalSurfaceReadMode::Events)?;
        self.read_next_event_mode(false, None)
    }

    fn read_next_event_before(
        &mut self,
        deadline: Instant,
    ) -> Result<TerminalSurfaceEvent, ClientError> {
        self.select_read_mode(TerminalSurfaceReadMode::Events)?;
        self.read_next_event_mode(false, Some(deadline))
    }

    fn select_read_mode(&mut self, mode: TerminalSurfaceReadMode) -> Result<(), ClientError> {
        if self.read_mode.is_some_and(|selected| selected != mode) {
            return Err(ClientError::transport(
                "hmux_terminal_surface_delivery_mode_changed",
                "terminal surface cannot mix high-level reads with binary delivery",
            ));
        }
        self.read_mode = Some(mode);
        Ok(())
    }

    fn read_next_event_mode(
        &mut self,
        capture_delivery: bool,
        deadline: Option<Instant>,
    ) -> Result<TerminalSurfaceEvent, ClientError> {
        loop {
            let record = match match deadline {
                Some(deadline) => self.connection.read_record_before(deadline),
                None => self.connection.read_record(),
            } {
                Ok(record) => record,
                Err(error) if self.viewport_frames.discard_incomplete() => {
                    self.pending_delivery_parts.clear();
                    return Err(invalid_viewport_batch(format!(
                        "viewport frame batch was interrupted by transport loss: {error}"
                    )));
                }
                Err(error) => return Err(error),
            };
            if let Some(event) = self.project_connection_record(record, capture_delivery)? {
                return Ok(event);
            }
        }
    }

    pub fn send_text_confirmed(
        &mut self,
        text: String,
        timeout: Duration,
    ) -> Result<InputReceipt, ClientError> {
        let receipt = self.send_intent_confirmed(
            move |_| InputIntent {
                intent: Some(input_intent::Intent::Text(TextInputIntent {
                    utf8: text.into_bytes(),
                })),
            },
            ReceiptKind::Input,
            timeout,
        )?;
        let TerminalIntentReceipt::Input(receipt) = receipt else {
            unreachable!("input receipt kind is fixed before the write")
        };
        Ok(receipt)
    }

    fn send_paste_before(
        &mut self,
        text: String,
        deadline: Instant,
    ) -> Result<InputReceipt, ClientError> {
        let receipt = self.send_intent_before(
            move |_| InputIntent {
                intent: Some(input_intent::Intent::Paste(PasteInputIntent {
                    utf8: text.into_bytes(),
                })),
            },
            ReceiptKind::Input,
            deadline,
        )?;
        let TerminalIntentReceipt::Input(receipt) = receipt else {
            unreachable!("input receipt kind is fixed before the write")
        };
        Ok(receipt)
    }

    pub fn send_key_confirmed(
        &mut self,
        key: String,
        code: String,
        modifiers: u32,
        repeat: bool,
        timeout: Duration,
    ) -> Result<InputReceipt, ClientError> {
        let receipt = self.send_intent_confirmed(
            move |_| InputIntent {
                intent: Some(input_intent::Intent::Key(KeyInputIntent {
                    key,
                    code,
                    modifiers,
                    repeat,
                })),
            },
            ReceiptKind::Input,
            timeout,
        )?;
        let TerminalIntentReceipt::Input(receipt) = receipt else {
            unreachable!("input receipt kind is fixed before the write")
        };
        Ok(receipt)
    }

    fn send_key_before(
        &mut self,
        key: String,
        code: String,
        modifiers: u32,
        repeat: bool,
        deadline: Instant,
    ) -> Result<InputReceipt, ClientError> {
        let receipt = self.send_intent_before(
            move |_| InputIntent {
                intent: Some(input_intent::Intent::Key(KeyInputIntent {
                    key,
                    code,
                    modifiers,
                    repeat,
                })),
            },
            ReceiptKind::Input,
            deadline,
        )?;
        let TerminalIntentReceipt::Input(receipt) = receipt else {
            unreachable!("input receipt kind is fixed before the write")
        };
        Ok(receipt)
    }

    pub fn send_paste_confirmed(
        &mut self,
        text: String,
        timeout: Duration,
    ) -> Result<InputReceipt, ClientError> {
        let receipt = self.send_intent_confirmed(
            move |_| InputIntent {
                intent: Some(input_intent::Intent::Paste(PasteInputIntent {
                    utf8: text.into_bytes(),
                })),
            },
            ReceiptKind::Input,
            timeout,
        )?;
        let TerminalIntentReceipt::Input(receipt) = receipt else {
            unreachable!("input receipt kind is fixed before the write")
        };
        Ok(receipt)
    }

    /// Sends external command text as paste followed, when requested, by one
    /// semantic Enter key on the same attachment. The Host encodes paste using
    /// the application's terminal mode, so read coalescing cannot turn submit
    /// into part of a bracketed paste. Receipts prove PTY writes, not acceptance.
    pub fn send_command_input_confirmed(
        &mut self,
        text: String,
        submit: bool,
        timeout: Duration,
    ) -> Result<TerminalCommandInputReceipt, TerminalCommandInputError> {
        validate_timeout(timeout).map_err(|error| TerminalCommandInputError::new(error, false))?;
        let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
            TerminalCommandInputError::new(
                ClientError::transport(
                    "hmux_terminal_command_input_deadline_invalid",
                    "terminal command input deadline overflowed",
                ),
                false,
            )
        })?;
        self.send_command_input_before(text, submit, deadline)
    }

    /// Delivers a fresh managed-agent prompt as one capability-gated Host
    /// operation. The Host encodes body plus submit and admits the one-shot
    /// write only from provider-event state inside its serialized PTY transaction.
    pub fn send_fresh_agent_prompt_confirmed(
        &mut self,
        prompt: String,
        timeout: Duration,
    ) -> Result<TerminalAgentPromptReceipt, TerminalAgentPromptError> {
        self.send_fresh_agent_prompt_target_confirmed(
            prompt,
            agent_prompt_input_intent::Target::FreshAgent(FreshAgentPromptTarget {}),
            timeout,
        )
    }

    /// Delivers the first prompt to a provider whose conversation identity is
    /// created by that prompt. The Host binds eligibility to its immutable
    /// launch provider and a matching process observation.
    pub fn send_process_observed_fresh_agent_prompt_confirmed(
        &mut self,
        prompt: String,
        timeout: Duration,
    ) -> Result<TerminalAgentPromptReceipt, TerminalAgentPromptError> {
        let target = if self.input_writer.as_ref().is_some_and(|writer| {
            writer.agent_prompt_selection() == Some(AgentPromptCapabilitySelection::Targeted)
                && !writer.supports_process_observed_agent_prompt()
        }) {
            agent_prompt_input_intent::Target::FreshAgent(FreshAgentPromptTarget {})
        } else {
            agent_prompt_input_intent::Target::ProcessObservedFreshAgent(
                ProcessObservedFreshAgentPromptTarget {},
            )
        };
        self.send_fresh_agent_prompt_target_confirmed(prompt, target, timeout)
    }

    fn send_fresh_agent_prompt_target_confirmed(
        &mut self,
        prompt: String,
        target: agent_prompt_input_intent::Target,
        timeout: Duration,
    ) -> Result<TerminalAgentPromptReceipt, TerminalAgentPromptError> {
        let admission_wait =
            timeout
                .saturating_sub(AGENT_PROMPT_RECEIPT_MARGIN)
                .min(Duration::from_millis(u64::from(
                    MAX_AGENT_PROMPT_ADMISSION_WAIT_MS,
                )));
        let admission_wait_ms = admission_wait.as_millis().try_into().map_err(|_| {
            TerminalAgentPromptError::not_written(ClientError::transport(
                "hmux_agent_prompt_deadline_invalid",
                "fresh agent prompt admission wait overflowed",
            ))
        })?;
        self.send_agent_prompt_target_confirmed(prompt, target, admission_wait_ms, timeout)
    }

    pub fn send_existing_idle_agent_prompt_confirmed(
        &mut self,
        prompt: String,
        expected: &crate::ProviderConversationIdentitySeed,
        timeout: Duration,
    ) -> Result<TerminalAgentPromptReceipt, TerminalAgentPromptError> {
        self.send_agent_prompt_target_confirmed(
            prompt,
            agent_prompt_input_intent::Target::ExistingConversation(
                ExistingConversationPromptTarget {
                    expected_provider_id: expected.provider_id().to_string(),
                    expected_conversation_id: expected.conversation_id().to_string(),
                },
            ),
            0,
            timeout,
        )
    }

    fn send_agent_prompt_target_confirmed(
        &mut self,
        prompt: String,
        target: agent_prompt_input_intent::Target,
        admission_wait_ms: u32,
        timeout: Duration,
    ) -> Result<TerminalAgentPromptReceipt, TerminalAgentPromptError> {
        validate_timeout(timeout).map_err(TerminalAgentPromptError::not_written)?;
        let agent_prompt_selection = self
            .input_writer
            .as_ref()
            .and_then(TerminalInputWriterCapability::agent_prompt_selection);
        let capability_available = matches!(
            (&target, agent_prompt_selection),
            (agent_prompt_input_intent::Target::FreshAgent(_), Some(_))
                | (
                    agent_prompt_input_intent::Target::ProcessObservedFreshAgent(_),
                    Some(AgentPromptCapabilitySelection::Targeted),
                )
                | (
                    agent_prompt_input_intent::Target::ExistingConversation(_),
                    Some(AgentPromptCapabilitySelection::Targeted),
                )
        );
        if !capability_available {
            return Err(TerminalAgentPromptError::not_written(
                ClientError::MissingCapability {
                    capability: AGENT_PROMPT_CAPABILITY,
                },
            ));
        }
        let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
            TerminalAgentPromptError::not_written(ClientError::transport(
                "hmux_agent_prompt_deadline_invalid",
                "agent prompt deadline overflowed",
            ))
        })?;
        let terminal_epoch = self.current.terminal_epoch.clone();
        let receipt = self
            .send_intent_before(
                move |_| InputIntent {
                    intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
                        utf8: prompt.into_bytes(),
                        admission_wait_ms,
                        target: Some(target),
                    })),
                },
                ReceiptKind::Input,
                deadline,
            )
            .map_err(TerminalAgentPromptError::new)?;
        let TerminalIntentReceipt::Input(input) = receipt else {
            unreachable!("agent prompt always expects an input receipt")
        };
        let (input_baseline_output_sequence, agent_runtime_revision) =
            require_written_agent_prompt(&input, agent_prompt_selection)
                .map_err(TerminalAgentPromptError::new)?;
        Ok(TerminalAgentPromptReceipt {
            terminal_epoch,
            input,
            input_baseline_output_sequence,
            agent_runtime_revision,
        })
    }

    fn send_command_input_before(
        &mut self,
        text: String,
        submit: bool,
        deadline: Instant,
    ) -> Result<TerminalCommandInputReceipt, TerminalCommandInputError> {
        if text.is_empty() && !submit {
            return Err(TerminalCommandInputError::new(
                ClientError::transport(
                    "hmux_terminal_command_input_empty",
                    "terminal command input requires text, submit, or both",
                ),
                false,
            ));
        }

        if Instant::now() >= deadline {
            return Err(TerminalCommandInputError::new(
                command_input_not_started_timeout(),
                false,
            ));
        }
        let terminal_epoch = self.current.terminal_epoch.clone();
        let text = if text.is_empty() {
            None
        } else {
            let receipt = self
                .send_paste_before(text, deadline)
                .map_err(|error| TerminalCommandInputError::new(error, false))?;
            Some(
                require_written_input(receipt)
                    .map_err(|error| TerminalCommandInputError::new(error, false))?,
            )
        };

        let submit = if submit {
            let receipt = self
                .send_key_before("Enter".to_string(), "Enter".to_string(), 0, false, deadline)
                .map_err(|error| TerminalCommandInputError::new(error, text.is_some()))?;
            Some(
                require_written_input(receipt)
                    .map_err(|error| TerminalCommandInputError::new(error, text.is_some()))?,
            )
        } else {
            None
        };

        Ok(TerminalCommandInputReceipt {
            terminal_epoch,
            text,
            submit,
        })
    }

    pub fn send_resize_confirmed(
        &mut self,
        columns: u32,
        rows: u32,
        timeout: Duration,
    ) -> Result<ResizeReceipt, ClientError> {
        let receipt = self.send_intent_confirmed(
            move |geometry_generation| InputIntent {
                intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                    columns,
                    rows,
                    geometry_generation,
                })),
            },
            ReceiptKind::Resize,
            timeout,
        )?;
        let TerminalIntentReceipt::Resize(receipt) = receipt else {
            unreachable!("resize receipt kind is fixed before the write")
        };
        Ok(receipt)
    }

    pub fn scroll_rows_confirmed(
        &mut self,
        rows: i32,
        timeout: Duration,
    ) -> Result<TerminalSurfaceFrame, ClientError> {
        self.send_viewport_confirmed(
            viewport_intent::Intent::ScrollRows(ScrollRows { rows }),
            timeout,
        )
    }

    pub fn follow_tail_confirmed(
        &mut self,
        timeout: Duration,
    ) -> Result<TerminalSurfaceFrame, ClientError> {
        self.send_viewport_confirmed(viewport_intent::Intent::FollowTail(FollowTail {}), timeout)
    }

    pub fn set_viewport_rows_confirmed(
        &mut self,
        rows: u32,
        timeout: Duration,
    ) -> Result<TerminalSurfaceFrame, ClientError> {
        self.send_viewport_confirmed(
            viewport_intent::Intent::SetViewportRows(SetViewportRows { rows }),
            timeout,
        )
    }

    pub fn detach(mut self) -> Result<(), ClientError> {
        self.connection.detach("terminal_surface_detach")
    }

    /// Detaches this exact surface and waits for Host-side registration
    /// cleanup before returning. A local adapter uses this completion proof
    /// when the next WebView generation must not overlap the old geometry
    /// proposal.
    pub fn detach_confirmed(mut self, timeout: Duration) -> Result<(), ClientError> {
        self.connection
            .detach_confirmed("terminal_surface_detach", timeout)
    }

    fn project_connection_record(
        &mut self,
        record: ConnectionRecord,
        capture_delivery: bool,
    ) -> Result<Option<TerminalSurfaceEvent>, ClientError> {
        match record {
            ConnectionRecord::Control(body) => {
                if self.viewport_frames.discard_incomplete() {
                    self.pending_delivery_parts.clear();
                    return Err(invalid_viewport_batch(
                        "viewport frame batch was interrupted by a control record",
                    ));
                }
                if let FrameBody::AgentRuntimeState(state) = body.as_ref() {
                    drop(crate::observer::project_agent_runtime_state(state.clone())?);
                }
                Ok(Some(TerminalSurfaceEvent::Control(body)))
            }
            ConnectionRecord::TerminalState(encoded) => {
                let decoded = match decode_record(&encoded) {
                    Ok(decoded) => decoded,
                    Err(error) if self.viewport_frames.discard_incomplete() => {
                        self.pending_delivery_parts.clear();
                        return Err(invalid_viewport_batch(format!(
                            "viewport frame batch was interrupted by an invalid record: {error}"
                        )));
                    }
                    Err(error) => return Err(error.into()),
                };
                let multipart = matches!(
                    decoded.record.body.as_ref(),
                    Some(terminal_state_record::Body::ViewportFramePart(_))
                );
                let mut delivery_record = Some(encoded);
                if capture_delivery && multipart {
                    self.pending_delivery_parts.push(
                        delivery_record
                            .take()
                            .expect("the decoded delivery record is still owned here"),
                    );
                }
                let mut direct_delivery = None;
                let mut complete_multipart_delivery = false;
                let decoded = match self.viewport_frames.push_downstream(decoded) {
                    ViewportFrameAssembly::Downstream(decoded) => {
                        if capture_delivery {
                            direct_delivery = delivery_record.take();
                        }
                        decoded
                    }
                    ViewportFrameAssembly::Pending => return Ok(None),
                    ViewportFrameAssembly::Complete(decoded) => {
                        complete_multipart_delivery = capture_delivery;
                        decoded
                    }
                    ViewportFrameAssembly::ResyncRequired(reason) => {
                        self.pending_delivery_parts.clear();
                        return Err(invalid_viewport_batch(reason));
                    }
                };
                let completed_delivery = complete_multipart_delivery
                    .then(|| self.pending_delivery_parts.drain(..).collect::<Vec<_>>());
                let event = match decoded.record.body.as_ref() {
                    Some(terminal_state_record::Body::ViewportFrame(_)) => {
                        let frame = TerminalSurfaceFrame::from_decoded(decoded)?;
                        self.install_frame(&frame)?;
                        self.connection
                            .accept_complete_terminal_viewport(&frame.progress())?;
                        TerminalSurfaceEvent::Frame(Box::new(frame))
                    }
                    Some(terminal_state_record::Body::Event(event)) => {
                        TerminalSurfaceEvent::Event(event.clone())
                    }
                    Some(terminal_state_record::Body::InputReceipt(receipt)) => {
                        TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Input(receipt.clone()))
                    }
                    Some(terminal_state_record::Body::ResizeReceipt(receipt)) => {
                        TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Resize(*receipt))
                    }
                    Some(terminal_state_record::Body::WheelReceipt(receipt)) => {
                        TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Wheel(*receipt))
                    }
                    _ => {
                        self.pending_delivery_parts.clear();
                        return Err(ClientError::transport(
                            "hmux_terminal_surface_record_invalid",
                            "terminal surface received a non-viewport terminal record",
                        ));
                    }
                };
                let replaceable_viewport = matches!(&event, TerminalSurfaceEvent::Frame(_));
                if let Some(records) = direct_delivery.map(|record| vec![record]) {
                    self.stage_terminal_delivery(records, replaceable_viewport);
                } else if let Some(records) = completed_delivery {
                    self.stage_terminal_delivery(records, replaceable_viewport);
                }
                Ok(Some(event))
            }
        }
    }

    fn send_intent_confirmed(
        &mut self,
        intent: impl FnOnce(u64) -> InputIntent,
        receipt_kind: ReceiptKind,
        timeout: Duration,
    ) -> Result<TerminalIntentReceipt, ClientError> {
        validate_timeout(timeout)?;
        let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
            ClientError::transport(
                "hmux_terminal_input_deadline_invalid",
                "terminal input deadline overflowed",
            )
        })?;
        self.send_intent_before(intent, receipt_kind, deadline)
    }

    fn send_intent_before(
        &mut self,
        intent: impl FnOnce(u64) -> InputIntent,
        receipt_kind: ReceiptKind,
        deadline: Instant,
    ) -> Result<TerminalIntentReceipt, ClientError> {
        self.select_read_mode(TerminalSurfaceReadMode::Events)?;
        let writer = self
            .input_writer
            .clone()
            .ok_or(ClientError::MissingCapability {
                capability: TERMINAL_INPUT_INTENT_CAPABILITY,
            })?;
        let record_id = self.take_record_id()?;
        let record = self.input_record(intent(record_id));
        if let Err(error) = writer.send_input_before(record_id, &record, deadline) {
            if error.is_write_not_started() {
                return Err(error);
            }
            return Err(self.outcome_unknown(receipt_kind, error));
        }
        loop {
            if Instant::now() >= deadline {
                return Err(self.outcome_unknown(
                    receipt_kind,
                    "the final binary receipt did not arrive before the deadline",
                ));
            }
            let event = self
                .read_next_event_before(deadline)
                .map_err(|error| self.outcome_unknown(receipt_kind, error))?;
            match event {
                TerminalSurfaceEvent::Frame(_) => {}
                TerminalSurfaceEvent::Event(event) => self
                    .defer_surface_event(TerminalSurfaceEvent::Event(event))
                    .map_err(|error| self.outcome_unknown(receipt_kind, error))?,
                TerminalSurfaceEvent::Receipt(receipt)
                    if receipt_kind.matches(&receipt, record_id) =>
                {
                    return Ok(receipt);
                }
                TerminalSurfaceEvent::Receipt(_) => {
                    return Err(self.outcome_unknown(
                        receipt_kind,
                        "the Host returned an uncorrelated terminal intent receipt",
                    ));
                }
                TerminalSurfaceEvent::Control(body) => {
                    if !self
                        .defer_live_control(body)
                        .map_err(|error| self.outcome_unknown(receipt_kind, error))?
                    {
                        return Err(self.outcome_unknown(
                            receipt_kind,
                            "the terminal connection ended before the final binary receipt",
                        ));
                    }
                }
            }
        }
    }

    fn send_viewport_confirmed(
        &mut self,
        intent: viewport_intent::Intent,
        timeout: Duration,
    ) -> Result<TerminalSurfaceFrame, ClientError> {
        validate_timeout(timeout)?;
        self.select_read_mode(TerminalSurfaceReadMode::Events)?;
        let record_id = self.take_record_id()?;
        let intent_seq = self.next_viewport_intent_seq;
        let record = TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            terminal_epoch: self.current.terminal_epoch.clone(),
            through_output_seq: self.current.through_output_seq,
            state_revision: self.current.state_revision,
            body: Some(terminal_state_record::Body::ViewportIntent(
                ViewportIntent {
                    observed_projection_revision: self.current.viewport.projection_revision,
                    intent_seq,
                    intent: Some(intent),
                },
            )),
        };
        self.projection
            .send_viewport_intent(record_id, &record)
            .map_err(|error| self.viewport_outcome_unknown(error))?;
        self.next_viewport_intent_seq = intent_seq.checked_add(1).ok_or_else(sequence_exhausted)?;
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err(self.viewport_outcome_unknown(
                    "the viewport acknowledgement did not arrive before the deadline",
                ));
            }
            match self
                .read_next_event_before(deadline)
                .map_err(|error| self.viewport_outcome_unknown(error))?
            {
                TerminalSurfaceEvent::Frame(frame)
                    if frame.viewport.applied_intent_seq >= intent_seq =>
                {
                    return Ok(*frame);
                }
                TerminalSurfaceEvent::Frame(_) => {}
                TerminalSurfaceEvent::Event(event) => self
                    .defer_surface_event(TerminalSurfaceEvent::Event(event))
                    .map_err(|error| self.viewport_outcome_unknown(error))?,
                TerminalSurfaceEvent::Receipt(_) => {
                    return Err(self.viewport_outcome_unknown(
                        "an unrelated terminal receipt crossed a viewport acknowledgement",
                    ));
                }
                TerminalSurfaceEvent::Control(body) => {
                    if !self
                        .defer_live_control(body)
                        .map_err(|error| self.viewport_outcome_unknown(error))?
                    {
                        return Err(self.viewport_outcome_unknown(
                            "the terminal connection ended before the viewport acknowledgement",
                        ));
                    }
                }
            }
        }
    }

    fn input_record(&self, intent: InputIntent) -> TerminalStateRecord {
        TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            terminal_epoch: self.current.terminal_epoch.clone(),
            through_output_seq: self.current.through_output_seq,
            state_revision: self.current.state_revision,
            body: Some(terminal_state_record::Body::InputIntent(intent)),
        }
    }

    fn install_frame(&mut self, frame: &TerminalSurfaceFrame) -> Result<(), ClientError> {
        if frame.terminal_epoch != self.current.terminal_epoch
            || frame.viewport.projection_revision <= self.current.viewport.projection_revision
            || frame.state_revision < self.current.state_revision
            || frame.through_output_seq < self.current.through_output_seq
            || frame.viewport.applied_intent_seq < self.current.viewport.applied_intent_seq
        {
            return Err(ClientError::transport(
                "hmux_terminal_viewport_progress_invalid",
                "terminal viewport frame moved a projection high-water backward",
            ));
        }
        self.next_viewport_intent_seq = self.next_viewport_intent_seq.max(
            frame
                .viewport
                .applied_intent_seq
                .checked_add(1)
                .ok_or_else(sequence_exhausted)?,
        );
        self.current = frame.clone();
        self.viewport_frames.set_installed(frame.progress());
        Ok(())
    }

    fn defer_live_control(&mut self, body: Box<FrameBody>) -> Result<bool, ClientError> {
        if matches!(body.as_ref(), FrameBody::Exit(_)) {
            return Ok(false);
        }
        self.defer_surface_event(TerminalSurfaceEvent::Control(body))?;
        Ok(true)
    }

    fn defer_surface_event(&mut self, event: TerminalSurfaceEvent) -> Result<(), ClientError> {
        if self.pending_events.len() >= MAX_PENDING_SURFACE_EVENTS {
            return Err(ClientError::transport(
                "terminal_surface_event_backlog",
                "terminal surface event backlog exceeded its bound",
            ));
        }
        self.pending_events.push_back(event);
        Ok(())
    }

    fn take_record_id(&mut self) -> Result<u64, ClientError> {
        let record_id = self.next_record_id;
        self.next_record_id = record_id.checked_add(1).ok_or_else(sequence_exhausted)?;
        Ok(record_id)
    }

    fn outcome_unknown(&self, kind: ReceiptKind, error: impl fmt::Display) -> ClientError {
        self.connection.shutdown();
        ClientError::transport(
            kind.outcome_unknown_code(),
            format!("terminal intent outcome is unknown; it must not be retried: {error}"),
        )
    }

    fn viewport_outcome_unknown(&self, error: impl fmt::Display) -> ClientError {
        self.connection.shutdown();
        ClientError::transport(
            "hmux_terminal_viewport_outcome_unknown",
            format!("terminal viewport outcome is unknown: {error}"),
        )
    }
}

#[derive(Clone, Copy)]
enum ReceiptKind {
    Input,
    Resize,
}

impl ReceiptKind {
    fn matches(self, receipt: &TerminalIntentReceipt, record_id: u64) -> bool {
        match (self, receipt) {
            (Self::Input, TerminalIntentReceipt::Input(receipt)) => {
                receipt.in_reply_to_record_id == record_id
            }
            (Self::Resize, TerminalIntentReceipt::Resize(receipt)) => {
                receipt.in_reply_to_record_id == record_id
            }
            _ => false,
        }
    }

    fn outcome_unknown_code(self) -> &'static str {
        match self {
            Self::Input => "hmux_terminal_input_outcome_unknown",
            Self::Resize => "hmux_terminal_resize_outcome_unknown",
        }
    }
}

fn validate_timeout(timeout: Duration) -> Result<(), ClientError> {
    if timeout.is_zero() {
        return Err(ClientError::transport(
            "hmux_terminal_intent_timeout_invalid",
            "terminal intent receipt timeout must be greater than zero",
        ));
    }
    Ok(())
}

fn command_input_not_started_timeout() -> ClientError {
    ClientError::transport(
        "hmux_terminal_command_input_not_started",
        "terminal command input deadline elapsed before any input was written",
    )
}

/// The Host's bounded failure class behind a catch-all reason, when present.
fn detail_suffix(detail: Option<&str>) -> String {
    detail
        .map(|detail| format!(", {detail}"))
        .unwrap_or_default()
}

fn require_written_input(receipt: InputReceipt) -> Result<InputReceipt, ClientError> {
    match receipt.outcome {
        Some(input_receipt::Outcome::WrittenToPty(_)) => Ok(receipt),
        Some(input_receipt::Outcome::Refused(refused)) => Err(ClientError::transport(
            "hmux_terminal_input_refused",
            format!(
                "Hmux Host refused semantic terminal input ({}{})",
                refused.reason,
                detail_suffix(refused.detail.as_deref())
            ),
        )),
        Some(input_receipt::Outcome::Failed(failed)) => Err(ClientError::transport(
            "hmux_terminal_input_failed",
            format!(
                "Hmux Host failed semantic terminal input ({})",
                failed.reason
            ),
        )),
        None => Err(ClientError::transport(
            "hmux_terminal_input_receipt_invalid",
            "Hmux Host returned a semantic input receipt without a final outcome",
        )),
    }
}

fn require_written_agent_prompt(
    receipt: &InputReceipt,
    selection: Option<AgentPromptCapabilitySelection>,
) -> Result<(u64, Option<u64>), ClientError> {
    match receipt.outcome.as_ref() {
        Some(input_receipt::Outcome::WrittenToPty(written)) => {
            let input_baseline_output_sequence =
                written.input_baseline_output_sequence.ok_or_else(|| {
                    ClientError::transport(
                        "hmux_agent_prompt_receipt_invalid",
                        "Hmux Host omitted the agent prompt output high-water",
                    )
                })?;
            let agent_runtime_revision = written.agent_runtime_revision;
            if selection == Some(AgentPromptCapabilitySelection::Targeted)
                && agent_runtime_revision.is_none()
            {
                return Err(ClientError::transport(
                    "hmux_agent_prompt_receipt_invalid",
                    "Hmux Host omitted the admitted agent runtime revision",
                ));
            }
            Ok((input_baseline_output_sequence, agent_runtime_revision))
        }
        Some(input_receipt::Outcome::Refused(refused))
            if refused.reason == InputRefusalReason::AgentRuntimeChanged as i32 =>
        {
            Err(ClientError::transport(
                "hmux_agent_prompt_runtime_changed",
                "the Host refused the agent prompt because the provider runtime changed",
            ))
        }
        Some(input_receipt::Outcome::Refused(refused)) => Err(ClientError::transport(
            "hmux_agent_prompt_refused",
            format!(
                "Hmux Host refused the agent prompt ({}{})",
                refused.reason,
                detail_suffix(refused.detail.as_deref())
            ),
        )),
        Some(input_receipt::Outcome::Failed(failed)) => Err(ClientError::transport(
            "hmux_agent_prompt_failed",
            format!("Hmux Host failed the agent prompt ({})", failed.reason),
        )),
        None => Err(ClientError::transport(
            "hmux_agent_prompt_receipt_invalid",
            "Hmux Host returned an agent prompt receipt without a final outcome",
        )),
    }
}

fn terminal_input_outcome_is_unknown(code: &str) -> bool {
    matches!(
        code,
        "hmux_terminal_input_outcome_unknown"
            | "hmux_terminal_input_failed"
            | "hmux_terminal_input_receipt_invalid"
            | "hmux_agent_prompt_failed"
            | "hmux_agent_prompt_receipt_invalid"
    )
}

fn invalid_viewport_seed(message: impl Into<String>) -> ClientError {
    ClientError::transport("hmux_terminal_viewport_seed_invalid", message)
}

fn invalid_viewport_batch(message: impl Into<String>) -> ClientError {
    ClientError::transport("terminal_viewport_frame_parts_invalid", message)
}

fn sequence_exhausted() -> ClientError {
    ClientError::transport(
        "hmux_terminal_surface_sequence_exhausted",
        "terminal surface sequence is exhausted; reattach",
    )
}

fn project_text(viewport: &ViewportFrame) -> Result<String, ClientError> {
    let tables = viewport.tables.as_ref().ok_or_else(|| {
        ClientError::transport(
            "hmux_terminal_viewport_tables_missing",
            "terminal viewport frame has no frame-local tables",
        )
    })?;
    let mut text = String::new();
    for row in &viewport.rows {
        for cell in &row.cells {
            let grapheme = &tables.graphemes[cell.grapheme_index as usize];
            let style = &tables.styles[cell.style_index as usize];
            if style.flags & (1 << 5) != 0 {
                for _ in 0..grapheme.display_width {
                    text.push(' ');
                }
            } else {
                text.push_str(&grapheme.text);
            }
        }
        if RowTermination::try_from(row.termination) == Ok(RowTermination::HardBreak) {
            text.push('\n');
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_state_protocol::{
        BufferId, CellStyle, Grapheme, InputModes, MouseEncoding, MouseTrackingMode,
        RowTermination, TerminalCell, TerminalColorOverrides, TerminalRow, TerminalStateRecord,
        TerminalTables, UnderlineKind, UnicodeWidthProfile, ViewportAnchorStatus, encode_record,
        terminal_state_record,
    };

    fn complete_frame_record() -> TerminalStateRecord {
        TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: "terminal-surface-red".into(),
            through_output_seq: 23,
            state_revision: 11,
            body: Some(terminal_state_record::Body::ViewportFrame(ViewportFrame {
                projection_revision: 7,
                damage_base_projection_revision: 0,
                canonical_columns: 4,
                viewport_rows: 2,
                active_buffer: BufferId::Normal as i32,
                rows: vec![
                    TerminalRow {
                        row_id: 1,
                        continues_from_previous: false,
                        cells: vec![TerminalCell {
                            grapheme_index: 0,
                            style_index: 0,
                        }],
                        termination: RowTermination::SoftWrap as i32,
                        logical_line_id: 1,
                        logical_cell_offset: 0,
                        logical_cell_span: 2,
                    },
                    TerminalRow {
                        row_id: 2,
                        continues_from_previous: true,
                        cells: vec![TerminalCell {
                            grapheme_index: 1,
                            style_index: 0,
                        }],
                        termination: RowTermination::HardBreak as i32,
                        logical_line_id: 1,
                        logical_cell_offset: 2,
                        logical_cell_span: 2,
                    },
                ],
                tables: Some(TerminalTables {
                    graphemes: vec![
                        Grapheme {
                            text: "한".into(),
                            display_width: 2,
                        },
                        Grapheme {
                            text: "글".into(),
                            display_width: 2,
                        },
                    ],
                    styles: vec![CellStyle {
                        underline: UnderlineKind::None as i32,
                        ..CellStyle::default()
                    }],
                    hyperlinks: Vec::new(),
                }),
                cursor: None,
                input_modes: Some(InputModes {
                    mouse_tracking: MouseTrackingMode::None as i32,
                    mouse_encoding: MouseEncoding::Default as i32,
                    ..InputModes::default()
                }),
                color_overrides: Some(TerminalColorOverrides::default()),
                unicode_width: Some(UnicodeWidthProfile {
                    unicode_version: "test".into(),
                    ambiguous_width: 1,
                    emoji_width: 2,
                }),
                through_event_id: 3,
                title: "surface".into(),
                working_directory_uri: "file:///tmp".into(),
                follow_tail: true,
                has_more_before: true,
                has_more_after: false,
                changed_row_indices: Vec::new(),
                applied_intent_seq: 1,
                anchor_status: ViewportAnchorStatus::FollowTail as i32,
                rows_from_tail: Some(0),
                input_output_timing: None,
            })),
        }
    }

    #[test]
    fn complete_frame_projects_stable_text_without_splitting_a_soft_wrap() {
        let encoded = encode_record(41, &complete_frame_record()).unwrap();
        let frame = TerminalSurfaceFrame::decode(&encoded).unwrap();

        assert_eq!(frame.text(), "한글\n");
        assert_eq!(frame.record_id(), 41);
        assert_eq!(frame.terminal_epoch(), "terminal-surface-red");
        assert_eq!(frame.through_output_seq(), 23);
        assert_eq!(frame.viewport().title, "surface");
    }

    #[test]
    fn invisible_cells_project_as_display_width_spaces() {
        let mut record = complete_frame_record();
        let Some(terminal_state_record::Body::ViewportFrame(frame)) = record.body.as_mut() else {
            unreachable!()
        };
        frame.tables.as_mut().unwrap().styles[0].flags = 1 << 5;

        let encoded = encode_record(42, &record).unwrap();
        let frame = TerminalSurfaceFrame::decode(&encoded).unwrap();
        assert_eq!(frame.text(), "    \n");
    }
}
