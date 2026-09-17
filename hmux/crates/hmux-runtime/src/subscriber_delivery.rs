use std::collections::HashMap;
use std::fmt;
use std::io;
#[cfg(feature = "terminal-state-stream")]
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use hmux_host::local_protocol::{FrameBody, ScreenSnapshot};

use crate::host_resource_budget::ConnectionPermit;
use crate::runtime_diagnostics::{
    RuntimeDiagnosticEvent, RuntimeDiagnosticFields, RuntimeDiagnostics,
};
use crate::subscriber_queue::{BoundedQueue, PushError};

pub(crate) const QUEUE_MAX_RECORDS: usize = 1_024;
pub(crate) const QUEUE_MAX_ACCOUNTED_BYTES: usize = 5 * 1024 * 1024;
pub(crate) const QUEUE_RECORD_OVERHEAD_BYTES: usize = 512;
const QUEUE_PROJECTION_RESERVE_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub(crate) enum OutboundRecord {
    Json(Arc<FrameBody>),
    #[cfg(feature = "terminal-state-stream")]
    TerminalState(Arc<[u8]>),
    #[cfg(feature = "terminal-state-stream")]
    TerminalViewportBatch(Arc<TerminalViewportBatch>),
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone)]
pub(crate) struct TerminalViewportBatch {
    terminal_epoch: Arc<str>,
    records: Arc<[Arc<[u8]>]>,
}

#[cfg(feature = "terminal-state-stream")]
impl TerminalViewportBatch {
    fn new(terminal_epoch: Arc<str>, records: Arc<[Arc<[u8]>]>) -> Self {
        Self {
            terminal_epoch,
            records,
        }
    }

    fn has_terminal_epoch(&self, terminal_epoch: &str) -> bool {
        self.terminal_epoch.as_ref() == terminal_epoch
    }
}

#[cfg(feature = "terminal-state-stream")]
impl Deref for TerminalViewportBatch {
    type Target = [Arc<[u8]>];

    fn deref(&self) -> &Self::Target {
        &self.records
    }
}

impl fmt::Debug for OutboundRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(body) => formatter.debug_tuple("Json").field(body).finish(),
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalState(bytes) => formatter
                .debug_struct("TerminalState")
                .field("encoded_len", &bytes.len())
                .finish(),
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalViewportBatch(records) => formatter
                .debug_struct("TerminalViewportBatch")
                .field("record_count", &records.len())
                .field(
                    "encoded_len",
                    &records.iter().map(|record| record.len()).sum::<usize>(),
                )
                .finish(),
        }
    }
}

pub(crate) type FrameQueue = BoundedQueue<OutboundRecord>;

#[derive(Clone)]
#[cfg(feature = "terminal-state-stream")]
pub(crate) struct StructuredStateBatch {
    records: Arc<[Arc<[u8]>]>,
    accounted_bytes: usize,
    viewport_terminal_epoch: Option<Arc<str>>,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum StructuredStateBatchError {
    Empty,
    AccountingOverflow,
    ViewportQueueLimit { actual: usize, maximum: usize },
}

#[cfg(feature = "terminal-state-stream")]
impl fmt::Display for StructuredStateBatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => {
                formatter.write_str("structured terminal batch must contain at least one record")
            }
            Self::AccountingOverflow => {
                formatter.write_str("structured terminal batch accounting overflowed")
            }
            Self::ViewportQueueLimit { actual, maximum } => write!(
                formatter,
                "complete viewport batch requires {actual} accounted bytes, maximum is {maximum}"
            ),
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
impl std::error::Error for StructuredStateBatchError {}

#[cfg(feature = "terminal-state-stream")]
impl StructuredStateBatch {
    pub(crate) fn new(records: Vec<Vec<u8>>) -> Result<Self, StructuredStateBatchError> {
        Self::new_inner(records, None)
    }

    pub(crate) fn new_viewport(
        records: Vec<Vec<u8>>,
        terminal_epoch: String,
    ) -> Result<Self, StructuredStateBatchError> {
        Self::new_inner(records, Some(Arc::from(terminal_epoch)))
    }

    fn new_inner(
        records: Vec<Vec<u8>>,
        viewport_terminal_epoch: Option<Arc<str>>,
    ) -> Result<Self, StructuredStateBatchError> {
        if records.is_empty() {
            return Err(StructuredStateBatchError::Empty);
        }
        let mut accounted_bytes = 0_usize;
        let mut shared_records = Vec::with_capacity(records.len());
        for record in records {
            accounted_bytes = accounted_bytes
                .checked_add(record.len())
                .and_then(|total| total.checked_add(QUEUE_RECORD_OVERHEAD_BYTES))
                .ok_or(StructuredStateBatchError::AccountingOverflow)?;
            shared_records.push(Arc::<[u8]>::from(record));
        }
        if viewport_terminal_epoch.is_some() && accounted_bytes > QUEUE_MAX_ACCOUNTED_BYTES {
            return Err(StructuredStateBatchError::ViewportQueueLimit {
                actual: accounted_bytes,
                maximum: QUEUE_MAX_ACCOUNTED_BYTES,
            });
        }
        Ok(Self {
            records: shared_records.into(),
            accounted_bytes,
            viewport_terminal_epoch,
        })
    }

    fn queue_entries(&self) -> impl Iterator<Item = (OutboundRecord, usize)> + '_ {
        self.records.iter().map(|record| {
            (
                OutboundRecord::TerminalState(Arc::clone(record)),
                record.len().saturating_add(QUEUE_RECORD_OVERHEAD_BYTES),
            )
        })
    }

    fn viewport_queue_entry(&self) -> Option<(OutboundRecord, usize, Arc<str>)> {
        let terminal_epoch = self.viewport_terminal_epoch.as_ref()?;
        let batch =
            TerminalViewportBatch::new(Arc::clone(terminal_epoch), Arc::clone(&self.records));
        Some((
            OutboundRecord::TerminalViewportBatch(Arc::new(batch)),
            self.accounted_bytes,
            Arc::clone(terminal_epoch),
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SnapshotProjection {
    agent_identity: bool,
    agent_runtime_state: bool,
    provider_conversation_identity: bool,
    working_directory: bool,
}

impl SnapshotProjection {
    pub(crate) const fn new(
        agent_runtime_state: bool,
        provider_conversation_identity: bool,
    ) -> Self {
        Self {
            agent_identity: false,
            agent_runtime_state,
            provider_conversation_identity,
            working_directory: false,
        }
    }

    pub(crate) const fn with_agent_identity(mut self, agent_identity: bool) -> Self {
        self.agent_identity = agent_identity;
        self
    }

    pub(crate) const fn with_working_directory(mut self, working_directory: bool) -> Self {
        self.working_directory = working_directory;
        self
    }

    pub(crate) fn apply(self, mut snapshot: ScreenSnapshot) -> ScreenSnapshot {
        if !self.agent_runtime_state {
            snapshot.agent_runtime_state = None;
            snapshot.semantic_idle_ms = None;
        }
        if !self.provider_conversation_identity {
            snapshot.provider_conversation_identity = None;
        }
        snapshot
    }
}

struct PreparedVariant {
    body: Arc<FrameBody>,
    accounted_bytes: usize,
}

/// One Host event prepared for fanout.
///
/// The full payload is moved into one `Arc`. Snapshot capability projections
/// are materialized at most once per distinct projection, after the subscriber
/// registry lock has been released. Every recipient then clones only an Arc.
pub(crate) struct PreparedFrame {
    full: PreparedVariant,
    without_agent_state: Option<PreparedVariant>,
    without_provider_identity: Option<PreparedVariant>,
    without_semantic_state: Option<PreparedVariant>,
}

impl PreparedFrame {
    pub(crate) fn new(body: FrameBody) -> Self {
        let accounted_bytes = accounted_bytes(&body);
        Self {
            full: PreparedVariant {
                body: Arc::new(body),
                accounted_bytes,
            },
            without_agent_state: None,
            without_provider_identity: None,
            without_semantic_state: None,
        }
    }

    fn for_projection(&mut self, projection: SnapshotProjection) -> &PreparedVariant {
        if !matches!(self.full.body.as_ref(), FrameBody::ScreenSnapshot(_)) {
            return &self.full;
        }
        match (
            projection.agent_runtime_state,
            projection.provider_conversation_identity,
        ) {
            (true, true) => &self.full,
            (false, true) => Self::projected(&self.full, &mut self.without_agent_state, projection),
            (true, false) => {
                Self::projected(&self.full, &mut self.without_provider_identity, projection)
            }
            (false, false) => {
                Self::projected(&self.full, &mut self.without_semantic_state, projection)
            }
        }
    }

    fn projected<'a>(
        full: &PreparedVariant,
        slot: &'a mut Option<PreparedVariant>,
        projection: SnapshotProjection,
    ) -> &'a PreparedVariant {
        slot.get_or_insert_with(|| {
            let body = match full.body.as_ref() {
                FrameBody::ScreenSnapshot(snapshot) => {
                    FrameBody::ScreenSnapshot(projection.apply(snapshot.clone()))
                }
                _ => unreachable!("only screen snapshots have projection variants"),
            };
            PreparedVariant {
                accounted_bytes: accounted_bytes(&body),
                body: Arc::new(body),
            }
        })
    }

    #[cfg(test)]
    fn materialized_variants(&self) -> usize {
        1 + usize::from(self.without_agent_state.is_some())
            + usize::from(self.without_provider_identity.is_some())
            + usize::from(self.without_semantic_state.is_some())
    }
}

pub(crate) struct SubscriberDelivery {
    queue: Arc<FrameQueue>,
    backpressure: Arc<AtomicBool>,
    diagnostics: RuntimeDiagnostics,
    projection: SnapshotProjection,
    terminal_delivery: TerminalDelivery,
    #[cfg(feature = "terminal-state-stream")]
    terminal_base_protocol_minor: Option<u8>,
    #[cfg(feature = "terminal-state-stream")]
    viewport_multipart: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalDelivery {
    None,
    #[cfg(feature = "terminal-state-stream")]
    Viewport,
}

struct SubscriberEntry {
    delivery: Arc<SubscriberDelivery>,
    /// Keeps a committed attachment inside the Host-wide active ceiling even
    /// if its initial socket reply fails before ordinary detach cleanup runs.
    _connection_permit: Option<ConnectionPermit>,
}

impl Drop for SubscriberEntry {
    fn drop(&mut self) {
        self.delivery.close();
    }
}

/// Registry access can only return stable delivery handles. Queue admission is
/// deliberately not exposed through this lock boundary.
pub(crate) struct SubscriberRegistry {
    entries: Mutex<HashMap<u64, SubscriberEntry>>,
}

impl SubscriberRegistry {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn insert(
        &self,
        client_id: u64,
        delivery: Arc<SubscriberDelivery>,
        connection_permit: Option<ConnectionPermit>,
    ) -> io::Result<()> {
        let replaced = {
            let mut entries = self.entries.lock().map_err(|_| registry_poisoned())?;
            entries.insert(
                client_id,
                SubscriberEntry {
                    delivery,
                    _connection_permit: connection_permit,
                },
            )
        };
        drop(replaced);
        Ok(())
    }

    pub(crate) fn delivery(&self, client_id: u64) -> io::Result<Option<Arc<SubscriberDelivery>>> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| registry_poisoned())?
            .get(&client_id)
            .map(|entry| Arc::clone(&entry.delivery)))
    }

    pub(crate) fn snapshot(&self) -> io::Result<Vec<(u64, Arc<SubscriberDelivery>)>> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| registry_poisoned())?
            .iter()
            .map(|(client_id, entry)| (*client_id, Arc::clone(&entry.delivery)))
            .collect())
    }

    pub(crate) fn remove(&self, client_id: u64) -> io::Result<()> {
        let removed = self
            .entries
            .lock()
            .map_err(|_| registry_poisoned())?
            .remove(&client_id);
        drop(removed);
        Ok(())
    }

    pub(crate) fn remove_if_same(
        &self,
        client_id: u64,
        expected: &Arc<SubscriberDelivery>,
    ) -> io::Result<bool> {
        let mut entries = self.entries.lock().map_err(|_| registry_poisoned())?;
        let removed = entries
            .get(&client_id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.delivery, expected))
            .then(|| entries.remove(&client_id))
            .flatten();
        drop(entries);
        let did_remove = removed.is_some();
        drop(removed);
        Ok(did_remove)
    }
}

fn registry_poisoned() -> io::Error {
    io::Error::other("Hmux subscriber registry lock was poisoned")
}

impl SubscriberDelivery {
    pub(crate) fn new(
        queue: Arc<FrameQueue>,
        backpressure: Arc<AtomicBool>,
        diagnostics: RuntimeDiagnostics,
        projection: SnapshotProjection,
    ) -> Arc<Self> {
        Arc::new(Self {
            queue,
            backpressure,
            diagnostics,
            projection,
            terminal_delivery: TerminalDelivery::None,
            #[cfg(feature = "terminal-state-stream")]
            terminal_base_protocol_minor: None,
            #[cfg(feature = "terminal-state-stream")]
            viewport_multipart: false,
        })
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn new_viewport(
        queue: Arc<FrameQueue>,
        backpressure: Arc<AtomicBool>,
        diagnostics: RuntimeDiagnostics,
        projection: SnapshotProjection,
        terminal_base_protocol_minor: u8,
        viewport_multipart: bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            queue,
            backpressure,
            diagnostics,
            projection,
            terminal_delivery: TerminalDelivery::Viewport,
            terminal_base_protocol_minor: Some(terminal_base_protocol_minor),
            viewport_multipart,
        })
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn terminal_base_protocol_minor(&self) -> Option<u8> {
        self.terminal_base_protocol_minor
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn supports_viewport_multipart(&self) -> bool {
        self.viewport_multipart
    }

    #[cfg(test)]
    pub(crate) fn queue(&self) -> &Arc<FrameQueue> {
        &self.queue
    }

    pub(crate) fn backpressure(&self) -> &Arc<AtomicBool> {
        &self.backpressure
    }

    pub(crate) fn close(&self) {
        self.queue.close();
    }

    pub(crate) fn accepts(&self, body: &FrameBody) -> bool {
        (self.terminal_delivery == TerminalDelivery::None
            || !matches!(
                body,
                FrameBody::OutputDelta(_) | FrameBody::ScreenSnapshot(_)
            ))
            && (!matches!(body, FrameBody::AgentRuntimeState(_))
                || self.projection.agent_runtime_state)
            && (!matches!(body, FrameBody::AgentIdentity(_)) || self.accepts_agent_identity())
            && (!matches!(body, FrameBody::WorkingDirectory(_)) || self.accepts_working_directory())
            && (!matches!(body, FrameBody::ProviderConversationIdentity(_))
                || self.projection.provider_conversation_identity)
    }

    fn accepts_agent_identity(&self) -> bool {
        #[cfg(feature = "terminal-state-stream")]
        {
            self.terminal_delivery == TerminalDelivery::Viewport && self.projection.agent_identity
        }
        #[cfg(not(feature = "terminal-state-stream"))]
        {
            false
        }
    }

    fn accepts_working_directory(&self) -> bool {
        #[cfg(feature = "terminal-state-stream")]
        {
            self.terminal_delivery == TerminalDelivery::Viewport
                && self.projection.working_directory
        }
        #[cfg(not(feature = "terminal-state-stream"))]
        {
            false
        }
    }

    pub(crate) fn deliver(&self, frame: &mut PreparedFrame) -> bool {
        if !self.accepts(frame.full.body.as_ref()) {
            return true;
        }
        let variant = frame.for_projection(self.projection);
        let output_sequence = diagnostic_output_sequence(variant.body.as_ref());
        match self.queue.try_push(
            OutboundRecord::Json(Arc::clone(&variant.body)),
            variant.accounted_bytes,
        ) {
            Ok(()) => return true,
            Err(PushError::Closed) => return false,
            Err(PushError::Full) => {}
        }
        // Preserve a priority lane for the typed failure frame. The outbound
        // writer stops draining stale deltas, reports resource pressure, and
        // only then closes the socket so clients can distinguish backpressure
        // from an unexplained EOF.
        self.backpressure.store(true, Ordering::Release);
        let fields =
            RuntimeDiagnosticFields::backpressure(variant.accounted_bytes, output_sequence);
        let fields = match self.queue.host_resource_snapshot() {
            Some(snapshot) => fields.with_resources(snapshot),
            None => fields,
        };
        self.diagnostics
            .record(RuntimeDiagnosticEvent::SubscriberBackpressure, fields);
        false
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn deliver_structured(&self, batch: &StructuredStateBatch) -> bool {
        if self.terminal_delivery == TerminalDelivery::None {
            return true;
        }
        match self.queue.try_push_batch(batch.queue_entries()) {
            Ok(()) => return true,
            Err(PushError::Closed) => return false,
            Err(PushError::Full) => {}
        }
        self.backpressure.store(true, Ordering::Release);
        let fields = RuntimeDiagnosticFields::backpressure(batch.accounted_bytes, None);
        let fields = match self.queue.host_resource_snapshot() {
            Some(snapshot) => fields.with_resources(snapshot),
            None => fields,
        };
        self.diagnostics
            .record(RuntimeDiagnosticEvent::SubscriberBackpressure, fields);
        false
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn deliver_viewport(&self, batch: &StructuredStateBatch) -> bool {
        if self.terminal_delivery != TerminalDelivery::Viewport {
            return true;
        }
        let Some((record, accounted_bytes, terminal_epoch)) = batch.viewport_queue_entry() else {
            return false;
        };
        match self.queue.try_replace_matching_or_push(
            record,
            accounted_bytes,
            |candidate| {
                matches!(
                candidate,
                OutboundRecord::TerminalViewportBatch(batch)
                    if batch.has_terminal_epoch(&terminal_epoch)
                )
            },
            |candidate| {
                matches!(
                    candidate,
                    OutboundRecord::Json(body) if matches!(body.as_ref(), FrameBody::Exit(_))
                )
            },
        ) {
            Ok(()) => return true,
            Err(PushError::Closed) => return false,
            Err(PushError::Full) => {}
        }
        self.backpressure.store(true, Ordering::Release);
        let fields = RuntimeDiagnosticFields::backpressure(accounted_bytes, None);
        let fields = match self.queue.host_resource_snapshot() {
            Some(snapshot) => fields.with_resources(snapshot),
            None => fields,
        };
        self.diagnostics
            .record(RuntimeDiagnosticEvent::SubscriberBackpressure, fields);
        false
    }
}

fn diagnostic_output_sequence(body: &FrameBody) -> Option<u64> {
    match body {
        FrameBody::OutputDelta(delta) => Some(delta.output_seq),
        FrameBody::ScreenSnapshot(snapshot) => Some(snapshot.sequence_through),
        FrameBody::Exit(exit) => Some(exit.final_output_seq),
        _ => None,
    }
}

pub(crate) fn accounted_bytes(body: &FrameBody) -> usize {
    let binary_payload = match body {
        FrameBody::OutputDelta(delta) => delta.bytes.len(),
        FrameBody::ScreenSnapshot(snapshot) => snapshot.repaint_bytes.len(),
        _ => {
            return serde_json::to_vec(body)
                .map_or(QUEUE_MAX_ACCOUNTED_BYTES, |bytes| bytes.len())
                .saturating_add(QUEUE_RECORD_OVERHEAD_BYTES);
        }
    };
    let base64_bytes = binary_payload
        .saturating_add(2)
        .saturating_div(3)
        .saturating_mul(4);
    let projection_reserve = match body {
        FrameBody::OutputDelta(delta)
            if delta.working_directory.is_some() || delta.agent_identity.is_some() =>
        {
            QUEUE_PROJECTION_RESERVE_BYTES
        }
        FrameBody::ScreenSnapshot(_) => QUEUE_PROJECTION_RESERVE_BYTES,
        _ => 0,
    };
    QUEUE_RECORD_OVERHEAD_BYTES
        .saturating_add(base64_bytes)
        .saturating_add(projection_reserve)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_protocol::{
        AgentIdentityProjection, AgentIdentitySource, AgentProvider, AgentRuntimeActivity,
        AgentRuntimeAttention, AgentRuntimeLifecycle, AgentRuntimeStateProjection,
        AgentRuntimeStateSource, Detach, ScreenSnapshotProfile, SessionFence,
    };

    fn snapshot() -> FrameBody {
        FrameBody::ScreenSnapshot(ScreenSnapshot {
            fence: SessionFence {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-1".into(),
            },
            sequence_through: 3,
            rows: 24,
            columns: 80,
            encoding: hmux_host::local_protocol::ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: vec![b'x'; 64 * 1024],
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: Some(AgentRuntimeStateProjection {
                terminal_epoch: "terminal-1".into(),
                revision: 1,
                observed_through_output_seq: 3,
                lifecycle: AgentRuntimeLifecycle::Running,
                activity: AgentRuntimeActivity::Working,
                attention: AgentRuntimeAttention::None,
                attention_id: None,
                source: AgentRuntimeStateSource::ProviderEvent,
                turn_completed_count: 0,
            }),
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: Some(ScreenSnapshotProfile::Full),
            in_reply_to_request_id: None,
        })
    }

    fn delivery(projection: SnapshotProjection) -> Arc<SubscriberDelivery> {
        SubscriberDelivery::new(
            Arc::new(BoundedQueue::new(
                2_000,
                256 * 1024 * 1024,
                std::time::Duration::from_secs(5),
            )),
            Arc::new(AtomicBool::new(false)),
            RuntimeDiagnostics::disabled(),
            projection,
        )
    }

    #[cfg(feature = "terminal-state-stream")]
    fn viewport_delivery() -> Arc<SubscriberDelivery> {
        SubscriberDelivery::new_viewport(
            Arc::new(BoundedQueue::new(
                4,
                4 * 1024,
                std::time::Duration::from_secs(5),
            )),
            Arc::new(AtomicBool::new(false)),
            RuntimeDiagnostics::disabled(),
            SnapshotProjection::new(false, false),
            5,
            true,
        )
    }

    #[cfg(feature = "terminal-state-stream")]
    fn ordered_viewport_delivery() -> Arc<SubscriberDelivery> {
        SubscriberDelivery::new_viewport(
            Arc::new(BoundedQueue::new(
                16,
                1024 * 1024,
                std::time::Duration::from_secs(5),
            )),
            Arc::new(AtomicBool::new(false)),
            RuntimeDiagnostics::disabled(),
            SnapshotProjection::new(false, false),
            5,
            true,
        )
    }

    #[cfg(feature = "terminal-state-stream")]
    fn viewport_frame(
        projection_revision: u64,
        title: &str,
    ) -> terminal_state_protocol::ViewportFrame {
        use terminal_state_protocol::{
            BufferId, CellStyle, Grapheme, InputModes, MouseEncoding, MouseTrackingMode,
            RowTermination, TerminalCell, TerminalColorOverrides, TerminalRow, TerminalTables,
            UnderlineKind, UnicodeWidthProfile, ViewportAnchorStatus, ViewportFrame,
        };

        ViewportFrame {
            projection_revision,
            damage_base_projection_revision: 0,
            canonical_columns: 1,
            viewport_rows: 1,
            active_buffer: BufferId::Normal as i32,
            rows: vec![TerminalRow {
                row_id: projection_revision,
                continues_from_previous: false,
                cells: vec![TerminalCell {
                    grapheme_index: 0,
                    style_index: 0,
                }],
                termination: RowTermination::HardBreak as i32,
                logical_line_id: projection_revision,
                logical_cell_offset: 0,
                logical_cell_span: 1,
            }],
            tables: Some(TerminalTables {
                graphemes: vec![Grapheme {
                    text: "x".into(),
                    display_width: 1,
                }],
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
            through_event_id: 0,
            title: title.into(),
            working_directory_uri: String::new(),
            follow_tail: true,
            has_more_before: false,
            has_more_after: false,
            changed_row_indices: Vec::new(),
            applied_intent_seq: projection_revision,
            anchor_status: ViewportAnchorStatus::FollowTail as i32,
            rows_from_tail: Some(0),
            input_output_timing: None,
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn viewport_batch(
        terminal_epoch: &str,
        projection_revision: u64,
        title: &str,
    ) -> StructuredStateBatch {
        use terminal_state_protocol::{ViewportFrameBatch, encode_viewport_frame_parts};

        let frame = viewport_frame(projection_revision, title);
        let records = encode_viewport_frame_parts(ViewportFrameBatch {
            record_id_start: projection_revision * 2,
            schema_minor: 5,
            terminal_epoch,
            through_output_seq: projection_revision,
            state_revision: projection_revision,
            batch_id: title.as_bytes(),
            frame: &frame,
            max_chunk_bytes: 64,
        })
        .unwrap();
        assert!(records.len() > 1, "queue fixture must remain multipart");
        StructuredStateBatch::new_viewport(records, terminal_epoch.into()).unwrap()
    }

    #[cfg(feature = "terminal-state-stream")]
    fn terminal_barrier_batch(event: bool) -> StructuredStateBatch {
        use terminal_state_protocol::{
            BellEvent, InputReceipt, InputWrittenToPty, TerminalEvent, TerminalStateRecord,
            encode_record, input_receipt, terminal_event, terminal_state_record,
        };

        let body = if event {
            terminal_state_record::Body::Event(TerminalEvent {
                event_id: 1,
                event: Some(terminal_event::Event::Bell(BellEvent {})),
            })
        } else {
            terminal_state_record::Body::InputReceipt(InputReceipt {
                in_reply_to_record_id: 77,
                outcome: Some(input_receipt::Outcome::WrittenToPty(
                    InputWrittenToPty::default(),
                )),
            })
        };
        StructuredStateBatch::new(vec![
            encode_record(
                if event { 91 } else { 90 },
                &TerminalStateRecord {
                    schema_minor: 4,
                    terminal_epoch: "terminal-a".into(),
                    through_output_seq: 2,
                    state_revision: 2,
                    body: Some(body),
                },
            )
            .unwrap(),
        ])
        .unwrap()
    }

    #[test]
    fn one_to_one_thousand_recipients_share_bounded_payload_variants() {
        for count in [1, 10, 100, 1_000] {
            let recipients = (0..count)
                .map(|index| delivery(SnapshotProjection::new(index % 2 == 0, index % 3 == 0)))
                .collect::<Vec<_>>();
            let mut frame = PreparedFrame::new(snapshot());
            let started = std::time::Instant::now();
            let mut latencies = Vec::with_capacity(count);
            for recipient in &recipients {
                let delivery_started = std::time::Instant::now();
                assert!(recipient.deliver(&mut frame));
                latencies.push(delivery_started.elapsed());
            }
            let elapsed = started.elapsed();
            latencies.sort_unstable();
            let p95_index = count.saturating_mul(95).div_ceil(100).saturating_sub(1);
            let p95 = latencies[p95_index];
            let queued_bytes = recipients
                .iter()
                .map(|recipient| recipient.queue().queued_accounted_bytes())
                .sum::<usize>();

            assert!(frame.materialized_variants() <= 4);
            assert!(elapsed < std::time::Duration::from_secs(2));
            assert!(p95 < std::time::Duration::from_millis(10));
            eprintln!(
                "hmux fanout recipients={count} elapsed_us={} delivery_p95_ns={} payload_variants={} queued_bytes={queued_bytes}",
                elapsed.as_micros(),
                p95.as_nanos(),
                frame.materialized_variants(),
            );
        }
    }

    #[test]
    fn semantic_frames_still_require_explicit_projection_capability() {
        let identity = FrameBody::AgentIdentity(AgentIdentityProjection {
            terminal_epoch: "terminal-1".into(),
            observed_through_output_seq: 0,
            agent: Some(AgentProvider::Codex),
            source: AgentIdentitySource::ProcessInspection,
        });
        let state = FrameBody::AgentRuntimeState(AgentRuntimeStateProjection {
            terminal_epoch: "terminal-1".into(),
            revision: 1,
            observed_through_output_seq: 0,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 0,
        });
        let ordinary = FrameBody::Detach(Detach { reason: None });
        let observer = delivery(SnapshotProjection::new(false, false));

        assert!(!observer.accepts(&identity));
        assert!(!observer.accepts(&state));
        assert!(observer.accepts(&ordinary));
        assert!(
            !delivery(SnapshotProjection::new(false, false).with_agent_identity(true))
                .accepts(&identity)
        );
        #[cfg(feature = "terminal-state-stream")]
        assert!(
            SubscriberDelivery::new_viewport(
                Arc::new(BoundedQueue::new(
                    4,
                    4 * 1024,
                    std::time::Duration::from_secs(5),
                )),
                Arc::new(AtomicBool::new(false)),
                RuntimeDiagnostics::disabled(),
                SnapshotProjection::new(false, false).with_agent_identity(true),
                5,
                true,
            )
            .accepts(&identity)
        );
    }

    #[test]
    fn working_directory_frames_require_the_frame_capability_and_viewport_delivery() {
        use hmux_host::local_protocol::{WorkingDirectoryProjection, WorkingDirectorySource};

        let working_directory = FrameBody::WorkingDirectory(WorkingDirectoryProjection {
            terminal_epoch: "terminal-1".into(),
            observed_through_output_seq: 0,
            path: "/tmp/project".into(),
            source: WorkingDirectorySource::ProcessInspection,
        });
        // Legacy delivery never carries the discrete frame, negotiated or not:
        // pre-frame clients hard-fail on an unknown frame kind.
        assert!(!delivery(SnapshotProjection::new(false, false)).accepts(&working_directory));
        assert!(
            !delivery(SnapshotProjection::new(false, false).with_working_directory(true))
                .accepts(&working_directory)
        );
        #[cfg(feature = "terminal-state-stream")]
        {
            let viewport = |projection: SnapshotProjection| {
                SubscriberDelivery::new_viewport(
                    Arc::new(BoundedQueue::new(
                        4,
                        4 * 1024,
                        std::time::Duration::from_secs(5),
                    )),
                    Arc::new(AtomicBool::new(false)),
                    RuntimeDiagnostics::disabled(),
                    projection,
                    5,
                    true,
                )
            };
            assert!(
                !viewport(SnapshotProjection::new(false, false)).accepts(&working_directory)
            );
            assert!(
                viewport(SnapshotProjection::new(false, false).with_working_directory(true))
                    .accepts(&working_directory)
            );
        }
    }

    #[test]
    fn detached_snapshot_cannot_deliver_or_remove_a_replacement_entry() {
        let registry = SubscriberRegistry::new();
        let original = delivery(SnapshotProjection::new(false, false));
        registry.insert(7, Arc::clone(&original), None).unwrap();
        let stale = registry.snapshot().unwrap().pop().unwrap().1;
        registry.remove(7).unwrap();

        let mut frame = PreparedFrame::new(FrameBody::Detach(Detach { reason: None }));
        assert!(!stale.deliver(&mut frame));

        let replacement = delivery(SnapshotProjection::new(true, true));
        registry.insert(7, Arc::clone(&replacement), None).unwrap();
        assert!(!registry.remove_if_same(7, &stale).unwrap());
        assert!(Arc::ptr_eq(
            &registry.delivery(7).unwrap().unwrap(),
            &replacement
        ));
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn viewport_delivery_retains_only_one_latest_complete_batch() {
        let delivery = viewport_delivery();
        let first = StructuredStateBatch::new_viewport(vec![vec![1], vec![2]], "terminal-a".into())
            .unwrap();
        let latest =
            StructuredStateBatch::new_viewport(vec![vec![3], vec![4]], "terminal-a".into())
                .unwrap();
        assert!(delivery.deliver_viewport(&first));
        assert!(delivery.deliver_viewport(&latest));
        delivery.close();

        let Some(OutboundRecord::TerminalViewportBatch(records)) = delivery.queue().pop() else {
            panic!("latest viewport batch was not queued atomically");
        };
        assert_eq!(
            records.iter().map(AsRef::as_ref).collect::<Vec<_>>(),
            vec![&[3][..], &[4][..]]
        );
        assert!(delivery.queue().pop().is_none());
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn multipart_capability_keeps_every_existing_terminal_record_on_the_base_minor() {
        use std::sync::atomic::AtomicU64;

        use hmux_runtime_contract::{
            TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_MULTIPART_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            selected_terminal_base_protocol_minor,
        };
        use terminal_state_protocol::{
            BellEvent, InputReceipt, InputWrittenToPty, ResizeAppliedToTerminal, ResizeReceipt,
            TerminalEvent, TerminalStateRecord, decode_record, input_receipt, resize_receipt,
            terminal_event, terminal_state_record,
        };

        let selected_capabilities = [
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            TERMINAL_INPUT_INTENT_CAPABILITY,
            TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        ]
        .map(str::to_string);
        let selected_minor = selected_terminal_base_protocol_minor(&selected_capabilities).unwrap();
        let bodies = [
            terminal_state_record::Body::ViewportFrame(viewport_frame(1, "direct-frame")),
            terminal_state_record::Body::InputReceipt(InputReceipt {
                in_reply_to_record_id: 11,
                outcome: Some(input_receipt::Outcome::WrittenToPty(
                    InputWrittenToPty::default(),
                )),
            }),
            terminal_state_record::Body::ResizeReceipt(ResizeReceipt {
                in_reply_to_record_id: 12,
                outcome: Some(resize_receipt::Outcome::AppliedToTerminal(
                    ResizeAppliedToTerminal {
                        columns: 120,
                        rows: 40,
                    },
                )),
            }),
            terminal_state_record::Body::Event(TerminalEvent {
                event_id: 13,
                event: Some(terminal_event::Event::Bell(BellEvent {})),
            }),
        ];

        let next_record_id = AtomicU64::new(1);
        for body in bodies {
            let encoded = crate::terminal_surface::encode_structured_record(
                &next_record_id,
                TerminalStateRecord {
                    schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
                    terminal_epoch: "terminal-base-minor".into(),
                    through_output_seq: 1,
                    state_revision: 1,
                    body: Some(body),
                },
                selected_minor,
                true,
            )
            .unwrap();
            assert_eq!(encoded.len(), 1, "small existing records stay direct");
            let decoded = decode_record(&encoded[0]).unwrap();
            assert_eq!(decoded.metadata.protocol_minor, 4);
            assert_eq!(decoded.record.schema_minor, 4);
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn prepared_viewport_gets_its_record_identity_only_at_ordered_enqueue() {
        use std::sync::atomic::AtomicU64;
        use terminal_state_protocol::{
            InputReceipt, InputWrittenToPty, TerminalStateRecord, decode_record, input_receipt,
            terminal_state_record,
        };

        let next_record_id = AtomicU64::new(1);
        let mut prepared_viewport = crate::terminal_surface::prepare_structured_record(
            TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: "terminal-ordered-encoding".into(),
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::ViewportFrame(viewport_frame(
                    1,
                    "prepared-before-receipt",
                ))),
            },
            4,
            true,
        )
        .unwrap();
        let receipt = crate::terminal_surface::encode_structured_record(
            &next_record_id,
            TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: "terminal-ordered-encoding".into(),
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                    in_reply_to_record_id: 7,
                    outcome: Some(input_receipt::Outcome::WrittenToPty(
                        InputWrittenToPty::default(),
                    )),
                })),
            },
            4,
            true,
        )
        .unwrap();
        crate::terminal_surface::sequence_prepared_structured_record(
            &next_record_id,
            &mut prepared_viewport,
        )
        .unwrap();

        let receipt_id = decode_record(&receipt[0]).unwrap().metadata.record_id;
        let viewport_id = decode_record(&prepared_viewport[0])
            .unwrap()
            .metadata
            .record_id;
        assert!(receipt_id < viewport_id);
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn maximum_viewport_batch_fits_atomic_queue_admission_and_oversize_is_typed() {
        use std::sync::atomic::AtomicU64;
        use terminal_state_protocol::{
            Grapheme, MAX_PAYLOAD_BYTES, MAX_VIEWPORT_FRAME_BYTES, MAX_VIEWPORT_FRAME_PARTS,
            TerminalStateRecord, decode_record, terminal_state_record,
        };

        let mut frame = viewport_frame(1, "near-maximum-viewport");
        frame
            .tables
            .as_mut()
            .unwrap()
            .graphemes
            .extend((0..4_000).map(|_| Grapheme {
                text: "x".repeat(1024),
                display_width: 1,
            }));
        let legacy_error = crate::terminal_surface::encode_structured_record(
            &AtomicU64::new(1),
            TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: "terminal-legacy".into(),
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::ViewportFrame(frame.clone())),
            },
            4,
            false,
        )
        .expect_err("a legacy peer cannot receive multipart viewport records");
        assert_eq!(
            legacy_error.to_string(),
            "complete viewport requires terminal_viewport_multipart_v1 capability"
        );
        let records = crate::terminal_surface::encode_structured_record(
            &AtomicU64::new(1),
            TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: "terminal-maximum".into(),
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::ViewportFrame(frame.clone())),
            },
            4,
            true,
        )
        .unwrap();
        assert!(records.len() > 1 && records.len() <= MAX_VIEWPORT_FRAME_PARTS);
        for encoded in &records {
            let decoded = decode_record(encoded).unwrap();
            assert_eq!(decoded.metadata.protocol_minor, 5);
            assert_eq!(decoded.record.schema_minor, 5);
        }
        let first = decode_record(&records[0]).unwrap();
        let Some(terminal_state_record::Body::ViewportFramePart(part)) = first.record.body else {
            panic!("near-maximum viewport was not encoded as parts");
        };
        assert!(part.total_frame_bytes as usize > MAX_PAYLOAD_BYTES);
        assert!(part.total_frame_bytes as usize <= MAX_VIEWPORT_FRAME_BYTES);

        let batch = StructuredStateBatch::new_viewport(records, "terminal-maximum".into())
            .expect("the maximum protocol frame must fit one atomic queue admission");
        assert!(batch.accounted_bytes <= QUEUE_MAX_ACCOUNTED_BYTES);

        frame
            .tables
            .as_mut()
            .unwrap()
            .graphemes
            .extend((0..200).map(|_| Grapheme {
                text: "y".repeat(1024),
                display_width: 1,
            }));
        let oversize_error = crate::terminal_surface::encode_structured_record(
            &AtomicU64::new(1),
            TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: "terminal-oversized".into(),
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::ViewportFrame(frame)),
            },
            4,
            true,
        )
        .expect_err("a complete viewport above the atomic protocol cap must fail closed");
        assert!(matches!(
            oversize_error.resource_limit_bounds(),
            Some((actual, maximum))
                if actual > MAX_VIEWPORT_FRAME_BYTES && maximum == MAX_VIEWPORT_FRAME_BYTES
        ));

        let actual = QUEUE_MAX_ACCOUNTED_BYTES + 1;
        match StructuredStateBatch::new_viewport(
            vec![vec![0; actual - QUEUE_RECORD_OVERHEAD_BYTES]],
            "terminal-oversized".into(),
        ) {
            Err(StructuredStateBatchError::ViewportQueueLimit {
                actual,
                maximum: QUEUE_MAX_ACCOUNTED_BYTES,
            }) if actual == QUEUE_MAX_ACCOUNTED_BYTES + 1 => {}
            _ => panic!("oversized viewport queue admission did not fail with its typed limit"),
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn viewport_delivery_preserves_nonreplaceable_terminal_records() {
        let delivery = viewport_delivery();
        let receipt = StructuredStateBatch::new(vec![vec![9, 8, 7]]).unwrap();

        assert!(delivery.deliver_structured(&receipt));
        delivery.close();

        let Some(OutboundRecord::TerminalState(record)) = delivery.queue().pop() else {
            panic!("viewport receipt was not queued as a nonreplaceable terminal record");
        };
        assert_eq!(record.as_ref(), &[9, 8, 7]);
        assert!(delivery.queue().pop().is_none());
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn viewport_delivery_crosses_receipts_and_effects_but_not_lifecycle_barriers() {
        use hmux_host::local_protocol::Exit;
        use terminal_state_protocol::{decode_record, terminal_state_record};

        let delivery = ordered_viewport_delivery();
        assert!(delivery.deliver_viewport(&viewport_batch("terminal-a", 1, "a-1")));
        assert!(delivery.deliver_viewport(&viewport_batch("terminal-a", 2, "a-2")));
        assert!(delivery.deliver_structured(&terminal_barrier_batch(false)));
        assert!(delivery.deliver_viewport(&viewport_batch("terminal-a", 3, "a-3")));
        assert!(delivery.deliver_viewport(&viewport_batch("terminal-b", 1, "b-1")));
        assert!(delivery.deliver_viewport(&viewport_batch("terminal-b", 2, "b-2")));
        assert!(delivery.deliver_structured(&terminal_barrier_batch(true)));
        assert!(delivery.deliver_viewport(&viewport_batch("terminal-b", 3, "b-3")));
        assert!(
            delivery.deliver(&mut PreparedFrame::new(FrameBody::Exit(Exit {
                final_output_seq: 3,
                exit_code: Some(0),
                platform_status: None,
                reason: "test-exit".into(),
            })))
        );
        assert!(delivery.deliver_viewport(&viewport_batch("terminal-b", 4, "b-4")));
        delivery.close();

        let mut ordered = Vec::new();
        while let Some(record) = delivery.queue().pop() {
            match record {
                OutboundRecord::TerminalViewportBatch(records) => {
                    assert!(records.len() > 1, "one logical batch must stay atomic");
                    let decoded = decode_record(&records[0]).unwrap();
                    let Some(terminal_state_record::Body::ViewportFramePart(part)) =
                        decoded.record.body
                    else {
                        panic!("viewport queue entry carried a non-viewport record");
                    };
                    ordered.push(format!(
                        "viewport:{}:{}",
                        decoded.record.terminal_epoch,
                        String::from_utf8(part.batch_id).unwrap()
                    ));
                }
                OutboundRecord::TerminalState(record) => {
                    let decoded = decode_record(&record).unwrap();
                    ordered.push(match decoded.record.body {
                        Some(terminal_state_record::Body::InputReceipt(_)) => "receipt".into(),
                        Some(terminal_state_record::Body::Event(_)) => "event".into(),
                        _ => panic!("unexpected terminal barrier"),
                    });
                }
                OutboundRecord::Json(body) if matches!(body.as_ref(), FrameBody::Exit(_)) => {
                    ordered.push("exit".into());
                }
                OutboundRecord::Json(_) => panic!("unexpected JSON record"),
            }
        }
        assert_eq!(
            ordered,
            [
                "receipt",
                "viewport:terminal-a:a-3",
                "event",
                "viewport:terminal-b:b-3",
                "exit",
                "viewport:terminal-b:b-4",
            ]
        );
    }
}
