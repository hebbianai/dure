mod agent_identity;
mod agent_runtime;
mod canonical_snapshot;
mod causal_reports;
#[cfg(feature = "ghostty-core-proof")]
mod cold_history;
#[cfg(feature = "ghostty-core-proof")]
mod cold_history_journal;
#[cfg(feature = "ghostty-core-proof")]
mod composite_viewport_source;
mod delta_retention;
mod execution_location;
#[cfg(feature = "ghostty-core-proof")]
mod ghostty_core_proof;
#[cfg(feature = "ghostty-core-proof")]
mod ghostty_state_projection;
mod terminal_core;
#[cfg(feature = "ghostty-core-proof")]
mod terminal_history_transfer;
#[cfg(not(feature = "ghostty-core-proof"))]
mod terminal_model;
#[cfg(feature = "ghostty-core-proof")]
mod view_projection;
#[cfg(feature = "ghostty-core-proof")]
mod viewport_source;
mod working_directory;

use crate::local_protocol::{
    AGENT_STATE_REPORT_MAX_WORKING_TTL_MS, AgentIdentityProjection, AgentProvider,
    AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
    AgentRuntimeStateProjection, AgentRuntimeStateSource, ExecutionLocation,
    ExecutionLocationProjection, ExecutionLocationSource, OutputDelta,
    ProviderConversationIdentityProjection, ProviderConversationIdentitySource, ReconnectCursor,
    RecoveredPresentation, ReplayGap, SessionFence, TerminalDefaultColors,
    WorkingDirectoryProjection,
};
pub use agent_identity::AgentIdentityObservation;
use agent_runtime::PendingControllerInput;
pub use agent_runtime::{
    AgentRuntimeObservation, AgentStateReportFold, AgentStateReportObservation,
};
pub use canonical_snapshot::TerminalProjections;
pub use execution_location::ExecutionLocationObservation;
use std::time::{Duration, Instant};

const DEFAULT_WORKING_TTL_MS: u64 = 30_000;
/// A source-issued completion identity makes delivery retry-safe, so the Host
/// can wait through the provider's immediate successor-turn boundary before
/// publishing user-visible quiescence. Native goal runtimes commonly finish
/// one internal turn and submit the next within a few milliseconds.
const IDENTIFIED_TURN_COMPLETION_SETTLE_MS: u64 = 250;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WorkingDeadline {
    expires_at: Instant,
    state_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingTurnCompletion {
    expires_at: Instant,
    state_revision: Option<u64>,
    report: AgentStateReportObservation,
}

/// The exact provider target of one Host-serialized prompt operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentPromptTarget {
    FreshAgent,
    ProcessObservedFreshAgent {
        expected_provider_id: String,
    },
    ExistingConversation {
        expected_provider_id: String,
        expected_conversation_id: String,
    },
}

impl AgentPromptTarget {
    fn is_fresh(&self) -> bool {
        matches!(
            self,
            Self::FreshAgent | Self::ProcessObservedFreshAgent { .. }
        )
    }

    fn expected_provider_id(&self) -> Option<&str> {
        match self {
            Self::FreshAgent => None,
            Self::ProcessObservedFreshAgent {
                expected_provider_id,
            }
            | Self::ExistingConversation {
                expected_provider_id,
                ..
            } => Some(expected_provider_id),
        }
    }

    fn unresolved_authority(&self) -> AgentPromptAdmission {
        if self.is_fresh() {
            AgentPromptAdmission::Pending
        } else {
            AgentPromptAdmission::Refused
        }
    }
}

/// Host-owned readiness for an agent prompt. Pending provider-event authority
/// can still converge; every other non-eligible state is a final refusal for
/// the current attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentPromptAdmission {
    Pending,
    Eligible,
    Refused,
}

fn runtime_agent_prompt_admission(
    target: &AgentPromptTarget,
    runtime: &AgentRuntimeStateProjection,
    required_source: AgentRuntimeStateSource,
) -> AgentPromptAdmission {
    if runtime.source != required_source || runtime.lifecycle == AgentRuntimeLifecycle::Starting {
        return target.unresolved_authority();
    }
    if runtime.lifecycle != AgentRuntimeLifecycle::Running
        || runtime.attention != AgentRuntimeAttention::None
        || runtime.attention_id.is_some()
        || runtime.activity != AgentRuntimeActivity::Waiting
    {
        return AgentPromptAdmission::Refused;
    }
    AgentPromptAdmission::Eligible
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderConversationIdentityObservation {
    pub provider_id: String,
    pub conversation_id: String,
    pub source: ProviderConversationIdentitySource,
}

impl ProviderConversationIdentityObservation {
    #[must_use]
    pub fn new(
        provider_id: impl Into<String>,
        conversation_id: impl Into<String>,
        source: ProviderConversationIdentitySource,
    ) -> Self {
        Self {
            provider_id: provider_id.into(),
            conversation_id: conversation_id.into(),
            source,
        }
    }
}
#[cfg(feature = "ghostty-core-proof")]
use crate::local_discovery::ColdHistoryStorage;
#[cfg(feature = "ghostty-core-proof")]
use cold_history::{
    ColdHistoryIdentity, ColdHistoryLimits, ColdHistoryProjectionSource, ColdHistoryStore,
    DurableColdHistoryAdoption, InMemoryColdHistoryJournal, adopt_durable_history,
};
#[cfg(feature = "ghostty-core-proof")]
use cold_history_journal::DurableColdHistoryJournal;
use delta_retention::DeltaRetention;
#[cfg(feature = "ghostty-core-proof")]
use ghostty_core_proof::GhosttyProofAdapter;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::ops::Deref;
#[cfg(feature = "ghostty-core-proof")]
use std::sync::atomic::{AtomicU64, Ordering};
use terminal_core::TerminalCore;
#[cfg(feature = "ghostty-core-proof")]
use terminal_core::TerminalCoreEvent;
use terminal_core::{TerminalCoreCheckpoint, TerminalCoreCheckpointFormat};
#[cfg(feature = "ghostty-core-proof")]
use terminal_history_transfer::TerminalHistoryTransfer;
#[cfg(not(feature = "ghostty-core-proof"))]
use terminal_model::TerminalModel;
#[cfg(feature = "ghostty-core-proof")]
use terminal_state_protocol::{
    ClipboardFormat, ClipboardWriteRequestEvent, TerminalEvent, TerminalStateRecord,
    terminal_event, terminal_state_record,
};
#[cfg(feature = "ghostty-core-proof")]
use view_projection::ViewportProjectionCache;
#[cfg(feature = "ghostty-core-proof")]
pub use view_projection::{
    CapturedViewportFrame, CapturedViewportSource, ViewProjection, ViewportCaptureRequest,
    ViewportIntentApplication, ViewportIntentDisposition, WheelIntentRoute, WheelPtySink,
};
pub use working_directory::WorkingDirectoryObservation;
use working_directory::valid_path;

const DEFAULT_SCROLLBACK_ROWS: usize = 4_096;
const DEFAULT_HISTORY_LOGICAL_LINES: usize = 20_000;
const ACCEPTED_TURN_COMPLETION_IDS_CAPACITY: usize = 512;
#[cfg(feature = "ghostty-core-proof")]
static NEXT_VIEWPORT_SOURCE_OWNER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalCheckpointEncoding {
    LegacyAnsiRedrawV1,
    EngineNativeV1 { engine_fingerprint: String },
}

pub const TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION: u16 = 2;

/// Exact durable cold-root receipt fenced into the same presentation
/// checkpoint as the Ghostty hot snapshot.
///
/// Chunk bytes live beside the logical session discovery record. This small
/// receipt selects one committed prefix, so recovery never combines a newer
/// cold root with an older hot snapshot after a crash.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalColdHistoryCheckpoint {
    pub schema_version: u16,
    pub history_namespace: String,
    pub store_id: String,
    pub root_generation: u64,
    pub end_boundary_token: [u8; 16],
    pub end_logical_line_id: u64,
    pub root_digest: [u8; 32],
}

impl TerminalColdHistoryCheckpoint {
    pub(crate) fn validate(&self) -> Result<(), TerminalReplayError> {
        if self.schema_version != TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION
            || self.history_namespace.is_empty()
            || self.history_namespace.len() > 256
            || self.store_id.is_empty()
            || self.store_id.len() > 256
            || self.root_generation == 0
            || self.end_logical_line_id == 0
        {
            return Err(TerminalReplayError::InvalidRecoveredPresentation);
        }
        Ok(())
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct TerminalCheckpoint {
    pub fence: SessionFence,
    pub sequence_through: u64,
    pub state_revision: u64,
    pub rows: u16,
    pub columns: u16,
    pub encoding: TerminalCheckpointEncoding,
    pub payload: Vec<u8>,
    pub alternate_screen: bool,
    pub cursor_visible: bool,
    pub cold_history: Option<TerminalColdHistoryCheckpoint>,
}

impl fmt::Debug for TerminalCheckpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalCheckpoint")
            .field("fence", &self.fence)
            .field("sequence_through", &self.sequence_through)
            .field("state_revision", &self.state_revision)
            .field("rows", &self.rows)
            .field("columns", &self.columns)
            .field("encoding", &self.encoding)
            .field("payload_len", &self.payload.len())
            .field("alternate_screen", &self.alternate_screen)
            .field("cursor_visible", &self.cursor_visible)
            .field("cold_history", &self.cold_history)
            .finish()
    }
}

/// One atomically parsed PTY output batch plus terminal-generated replies.
///
/// `pty_replies` are input bytes generated by terminal semantics (for example
/// DA/DSR responses), not observer output. The runtime must move them to the
/// existing ordered PTY writer only after releasing the Host actor lock.
#[derive(Clone, PartialEq)]
pub struct IngestedTerminalOutput {
    pub delta: OutputDelta,
    pub pty_replies: Vec<u8>,
    pub pty_reply_overflow: bool,
    #[cfg(feature = "ghostty-core-proof")]
    pub terminal_records: Vec<TerminalStateRecord>,
    #[cfg(feature = "ghostty-core-proof")]
    pub terminal_event_overflow: bool,
    pub projection_changed: bool,
    pub presentation_degradation: Option<TerminalPresentationDegradation>,
    pub history_degradation: Option<TerminalReplayError>,
}

impl fmt::Debug for IngestedTerminalOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("IngestedTerminalOutput");
        debug
            .field("delta", &self.delta)
            .field("pty_replies_len", &self.pty_replies.len())
            .field("pty_reply_overflow", &self.pty_reply_overflow);
        #[cfg(feature = "ghostty-core-proof")]
        debug
            .field("terminal_record_count", &self.terminal_records.len())
            .field("terminal_event_overflow", &self.terminal_event_overflow);
        debug
            .field("projection_changed", &self.projection_changed)
            .field("presentation_degradation", &self.presentation_degradation)
            .field("history_degradation", &self.history_degradation)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalPresentationDegradation {
    MutationObservation,
    MutationProjection,
}

impl Deref for IngestedTerminalOutput {
    type Target = OutputDelta;

    fn deref(&self) -> &Self::Target {
        &self.delta
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalReplayLimits {
    pub max_rows: u16,
    pub max_columns: u16,
    pub max_cells: usize,
    pub max_delta_bytes: usize,
    pub max_retained_bytes: usize,
    pub max_retained_records: usize,
    pub max_snapshot_bytes: usize,
    pub max_checkpoint_bytes: usize,
    pub max_history_logical_lines: usize,
    pub max_cold_history_bytes: usize,
    pub max_history_transfer_offer_bytes: usize,
    pub max_pending_history_transfer_bytes: usize,
    pub max_working_directory_bytes: usize,
    pub max_execution_target_bytes: usize,
}

impl Default for TerminalReplayLimits {
    fn default() -> Self {
        Self {
            max_rows: 512,
            max_columns: 1024,
            max_cells: 256 * 1024,
            max_delta_bytes: 64 * 1024,
            max_retained_bytes: 4 * 1024 * 1024,
            max_retained_records: 4096,
            max_snapshot_bytes: 768 * 1024,
            max_checkpoint_bytes: 7 * 1024 * 1024,
            max_history_logical_lines: DEFAULT_HISTORY_LOGICAL_LINES,
            max_cold_history_bytes: 512 * 1024 * 1024,
            max_history_transfer_offer_bytes: 4 * 1024 * 1024,
            max_pending_history_transfer_bytes: 8 * 1024 * 1024,
            max_working_directory_bytes: 4096,
            max_execution_target_bytes: 512,
        }
    }
}

pub struct TerminalReplay {
    fence: SessionFence,
    terminal: Box<dyn TerminalCore>,
    #[cfg(feature = "ghostty-core-proof")]
    viewport_projection_cache: ViewportProjectionCache,
    #[cfg(feature = "ghostty-core-proof")]
    next_view_projection_id: u64,
    #[cfg(feature = "ghostty-core-proof")]
    viewport_source_owner: u64,
    #[cfg(feature = "ghostty-core-proof")]
    history_transfer: TerminalHistoryTransfer,
    terminal_state_revision: u64,
    #[cfg(feature = "ghostty-core-proof")]
    terminal_event_id: u64,
    output_seq: u64,
    retained: DeltaRetention,
    /// A resize is ordered before the next PTY bytes. Carry the new grid once
    /// with that delta so every observer can resize its parser before applying
    /// the provider redraw, without broadcasting a full screen snapshot.
    pending_output_geometry: Option<(u16, u16)>,
    working_directory: Option<WorkingDirectoryProjection>,
    execution_location: Option<ExecutionLocationProjection>,
    agent_identity: Option<AgentIdentityProjection>,
    agent_runtime_state: Option<AgentRuntimeStateProjection>,
    agent_runtime_changed_at: Option<Instant>,
    working_deadline: Option<WorkingDeadline>,
    pending_turn_completion: Option<PendingTurnCompletion>,
    accepted_turn_completion_id_order: VecDeque<String>,
    accepted_turn_completion_ids: HashSet<String>,
    report_causality: Option<crate::local_protocol::AgentStateReportCausality>,
    provider_conversation_identity: Option<ProviderConversationIdentityProjection>,
    recovered_presentation: Option<RecoveredPresentation>,
    #[cfg(feature = "ghostty-core-proof")]
    recovered_history_boundary: Option<RecoveredHistoryBoundary>,
    // Input delivery and provider activity are independent. A submitted input
    // awaits a provider observation; an unsubmitted draft must survive it.
    pending_controller_input: PendingControllerInput,
    // A fresh prompt is one-shot within a terminal epoch. The first actual
    // non-empty PTY prefix consumes it through the common controller-input
    // fold; read-only preparation never changes this fact.
    fresh_agent_prompt_consumed: bool,
    limits: TerminalReplayLimits,
}

#[cfg(feature = "ghostty-core-proof")]
struct RecoveredHistoryBoundary {
    projection_cold: ColdHistoryProjectionSource,
    checkpoint_cold: Option<TerminalColdHistoryCheckpoint>,
}

pub(crate) struct PreparedTerminalResize {
    rows: u16,
    columns: u16,
    terminal_state_revision: u64,
    changed: bool,
}

#[cfg(feature = "ghostty-core-proof")]
pub(crate) struct TerminalColdHistoryAdoption(DurableColdHistoryAdoption);

#[cfg(feature = "ghostty-core-proof")]
impl TerminalColdHistoryAdoption {
    pub(crate) fn checkpoint(&self) -> &TerminalColdHistoryCheckpoint {
        self.0.checkpoint()
    }
}

#[cfg(feature = "ghostty-core-proof")]
enum ColdHistoryPersistence {
    InMemory,
    Durable {
        journal: DurableColdHistoryJournal,
        selected: Option<TerminalColdHistoryCheckpoint>,
    },
}

impl TerminalReplay {
    #[cfg(feature = "ghostty-core-proof")]
    pub(crate) fn adopt_durable_checkpoint(
        discovery_root: &std::path::Path,
        checkpoint: &TerminalCheckpoint,
        target_store_id: &str,
        limits: &TerminalReplayLimits,
    ) -> Result<Option<TerminalColdHistoryAdoption>, TerminalReplayError> {
        validate_fence(&checkpoint.fence)?;
        validate_limits(limits)?;
        if let Some(source) = &checkpoint.cold_history {
            source.validate()?;
        }
        let Some(source) = retained_cold_history(checkpoint, limits.max_history_logical_lines)
        else {
            return Ok(None);
        };
        adopt_durable_history(
            discovery_root,
            source,
            target_store_id,
            ColdHistoryLimits {
                maximum_logical_lines: limits.max_history_logical_lines,
                maximum_bytes: limits.max_cold_history_bytes,
                maximum_offer_bytes: limits.max_history_transfer_offer_bytes,
            },
        )
        .map(TerminalColdHistoryAdoption)
        .map(Some)
    }

    pub fn prevalidate_durable_checkpoint(
        discovery_root: &std::path::Path,
        checkpoint: &TerminalCheckpoint,
        limits: &TerminalReplayLimits,
    ) -> Result<(), TerminalReplayError> {
        validate_fence(&checkpoint.fence)?;
        validate_limits(limits)?;
        validate_dimensions(checkpoint.rows, checkpoint.columns, limits)?;
        // Prove the engine-native hot state before touching the source
        // lifecycle. This restoration is isolated and never becomes a second
        // terminal authority.
        let _hot = restore_terminal_core(
            checkpoint,
            &checkpoint.fence.terminal_epoch,
            limits.max_history_logical_lines,
        )?;
        #[cfg(feature = "ghostty-core-proof")]
        if let Some(selected) = &checkpoint.cold_history {
            selected.validate()?;
        }
        #[cfg(feature = "ghostty-core-proof")]
        if let Some(selected) = retained_cold_history(checkpoint, limits.max_history_logical_lines)
        {
            let storage = ColdHistoryStorage::inspect(
                discovery_root.to_path_buf(),
                &selected.history_namespace,
                &selected.store_id,
            )
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
            let journal = DurableColdHistoryJournal::new(storage);
            let cold_limits = ColdHistoryLimits {
                maximum_logical_lines: limits.max_history_logical_lines,
                maximum_bytes: limits.max_cold_history_bytes,
                maximum_offer_bytes: limits.max_history_transfer_offer_bytes,
            };
            let _cold = ColdHistoryStore::open_durable(
                ColdHistoryIdentity::new(&selected.history_namespace, &selected.store_id),
                &checkpoint.fence.terminal_epoch,
                cold_limits,
                journal,
                Some(selected),
            )?;
        }
        #[cfg(not(feature = "ghostty-core-proof"))]
        {
            let _ = discovery_root;
            if checkpoint.cold_history.is_some() {
                return Err(TerminalReplayError::InvalidRecoveredPresentation);
            }
        }
        Ok(())
    }

    pub fn new(
        fence: SessionFence,
        rows: u16,
        columns: u16,
        limits: TerminalReplayLimits,
    ) -> Result<Self, TerminalReplayError> {
        Self::new_with_default_colors(
            fence,
            rows,
            columns,
            limits,
            TerminalDefaultColors::default(),
        )
    }

    /// Accepts legacy creation hints for wire compatibility without injecting
    /// presentation colors into the terminal core.
    pub fn new_with_default_colors(
        fence: SessionFence,
        rows: u16,
        columns: u16,
        limits: TerminalReplayLimits,
        terminal_default_colors: TerminalDefaultColors,
    ) -> Result<Self, TerminalReplayError> {
        terminal_default_colors
            .validate()
            .map_err(|_| TerminalReplayError::InvalidTerminalDefaultColors)?;
        #[cfg(feature = "ghostty-core-proof")]
        {
            Self::new_with_persistence(
                fence,
                rows,
                columns,
                limits,
                ColdHistoryPersistence::InMemory,
            )
        }
        #[cfg(not(feature = "ghostty-core-proof"))]
        {
            Self::new_without_cold_history(fence, rows, columns, limits)
        }
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[cfg(test)]
    pub(crate) fn new_with_cold_history_storage(
        fence: SessionFence,
        rows: u16,
        columns: u16,
        limits: TerminalReplayLimits,
        storage: ColdHistoryStorage,
        recovered: Option<&TerminalCheckpoint>,
    ) -> Result<Self, TerminalReplayError> {
        Self::new_with_cold_history_storage_and_default_colors(
            fence,
            rows,
            columns,
            limits,
            storage,
            recovered,
            TerminalDefaultColors::default(),
        )
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub(crate) fn new_with_cold_history_storage_and_default_colors(
        fence: SessionFence,
        rows: u16,
        columns: u16,
        limits: TerminalReplayLimits,
        storage: ColdHistoryStorage,
        recovered: Option<&TerminalCheckpoint>,
        terminal_default_colors: TerminalDefaultColors,
    ) -> Result<Self, TerminalReplayError> {
        terminal_default_colors
            .validate()
            .map_err(|_| TerminalReplayError::InvalidTerminalDefaultColors)?;
        if let Some(selected) = recovered.and_then(|checkpoint| checkpoint.cold_history.as_ref()) {
            selected.validate()?;
        }
        let selected = recovered.and_then(|checkpoint| {
            retained_cold_history(checkpoint, limits.max_history_logical_lines).cloned()
        });
        let (history_namespace, store_id) = selected.as_ref().map_or_else(
            || (fence.terminal_epoch.as_str(), "cold-v1"),
            |checkpoint| {
                (
                    checkpoint.history_namespace.as_str(),
                    checkpoint.store_id.as_str(),
                )
            },
        );
        let storage = storage
            .bind(history_namespace, store_id)
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        Self::new_with_persistence(
            fence,
            rows,
            columns,
            limits,
            ColdHistoryPersistence::Durable {
                journal: DurableColdHistoryJournal::new(storage),
                selected,
            },
        )
    }

    #[cfg(feature = "ghostty-core-proof")]
    fn new_with_persistence(
        fence: SessionFence,
        rows: u16,
        columns: u16,
        limits: TerminalReplayLimits,
        persistence: ColdHistoryPersistence,
    ) -> Result<Self, TerminalReplayError> {
        validate_fence(&fence)?;
        validate_limits(&limits)?;
        validate_dimensions(rows, columns, &limits)?;
        let terminal = create_terminal_core(
            rows,
            columns,
            &fence.terminal_epoch,
            limits.max_history_logical_lines,
        )?;
        let viewport_source_owner = NEXT_VIEWPORT_SOURCE_OWNER
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_add(1)
            })
            .map_err(|_| TerminalReplayError::TerminalStateRevisionExhausted)?;
        let selected = match &persistence {
            ColdHistoryPersistence::InMemory => None,
            ColdHistoryPersistence::Durable { selected, .. } => selected.as_ref(),
        };
        let identity = selected.map_or_else(
            || ColdHistoryIdentity::new(&fence.terminal_epoch, "cold-v1"),
            |checkpoint| {
                ColdHistoryIdentity::new(&checkpoint.history_namespace, &checkpoint.store_id)
            },
        );
        let cold_limits = ColdHistoryLimits {
            maximum_logical_lines: limits.max_history_logical_lines,
            maximum_bytes: limits.max_cold_history_bytes,
            maximum_offer_bytes: limits.max_history_transfer_offer_bytes,
        };
        let cold_store = match persistence {
            ColdHistoryPersistence::InMemory => ColdHistoryStore::open(
                identity,
                &fence.terminal_epoch,
                cold_limits,
                InMemoryColdHistoryJournal::default(),
            )?,
            ColdHistoryPersistence::Durable { journal, selected } => {
                ColdHistoryStore::open_durable(
                    identity,
                    &fence.terminal_epoch,
                    cold_limits,
                    journal,
                    selected.as_ref(),
                )?
            }
        };
        let history_transfer =
            TerminalHistoryTransfer::new(cold_store, limits.max_pending_history_transfer_bytes)?;
        Ok(Self {
            fence,
            terminal,
            viewport_projection_cache: ViewportProjectionCache::new(),
            next_view_projection_id: 1,
            viewport_source_owner,
            history_transfer,
            terminal_state_revision: 1,
            terminal_event_id: 0,
            output_seq: 0,
            retained: DeltaRetention::new(limits.max_retained_records, limits.max_retained_bytes),
            pending_output_geometry: None,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            agent_runtime_changed_at: None,
            working_deadline: None,
            pending_turn_completion: None,
            accepted_turn_completion_id_order: VecDeque::new(),
            accepted_turn_completion_ids: HashSet::new(),
            report_causality: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
            recovered_history_boundary: None,
            pending_controller_input: PendingControllerInput::None,
            fresh_agent_prompt_consumed: false,
            limits,
        })
    }

    #[cfg(not(feature = "ghostty-core-proof"))]
    fn new_without_cold_history(
        fence: SessionFence,
        rows: u16,
        columns: u16,
        limits: TerminalReplayLimits,
    ) -> Result<Self, TerminalReplayError> {
        validate_fence(&fence)?;
        validate_limits(&limits)?;
        validate_dimensions(rows, columns, &limits)?;
        let terminal = create_terminal_core(
            rows,
            columns,
            &fence.terminal_epoch,
            limits.max_history_logical_lines,
        )?;
        Ok(Self {
            fence,
            terminal,
            terminal_state_revision: 1,
            output_seq: 0,
            retained: DeltaRetention::new(limits.max_retained_records, limits.max_retained_bytes),
            pending_output_geometry: None,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            agent_runtime_changed_at: None,
            working_deadline: None,
            pending_turn_completion: None,
            accepted_turn_completion_id_order: VecDeque::new(),
            accepted_turn_completion_ids: HashSet::new(),
            report_causality: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
            pending_controller_input: PendingControllerInput::None,
            fresh_agent_prompt_consumed: false,
            limits,
        })
    }

    #[must_use]
    pub fn fence(&self) -> &SessionFence {
        &self.fence
    }

    #[must_use]
    pub fn current_output_seq(&self) -> u64 {
        self.output_seq
    }

    #[must_use]
    pub fn earliest_retained_output_seq(&self) -> u64 {
        self.retained.earliest_sequence(self.output_seq)
    }

    /// Monotonic Host-local terminal observation revision. Unlike output
    /// sequence, this also advances for an output-free geometry mutation.
    #[must_use]
    pub fn current_terminal_state_revision(&self) -> u64 {
        self.terminal_state_revision
    }

    /// Sequences and parses one complete PTY read. Callers serialize access to
    /// this object at the PTY ownership boundary, which makes a snapshot at N
    /// and the following live delta at N+1 one indivisible ordering contract.
    pub fn ingest_output(
        &mut self,
        bytes: &[u8],
    ) -> Result<IngestedTerminalOutput, TerminalReplayError> {
        if bytes.is_empty() {
            return Err(TerminalReplayError::EmptyOutput);
        }
        if bytes.len() > self.limits.max_delta_bytes {
            return Err(TerminalReplayError::DeltaTooLarge {
                actual: bytes.len(),
                maximum: self.limits.max_delta_bytes,
            });
        }
        #[cfg(feature = "ghostty-core-proof")]
        let mut successor_terminal = if self.recovered_history_boundary.is_some() {
            let (rows, columns) = self.terminal.size();
            let cold_history = self.history_transfer.checkpoint_receipt()?;
            Some(create_terminal_core_after_recovered_history(
                rows,
                columns,
                &self.fence.terminal_epoch,
                self.limits.max_history_logical_lines,
                cold_history.as_ref(),
            )?)
        } else {
            None
        };
        #[cfg(feature = "ghostty-core-proof")]
        let crossed_recovered_boundary = successor_terminal.is_some();
        #[cfg(feature = "ghostty-core-proof")]
        let mut history_degradation = if crossed_recovered_boundary {
            None
        } else {
            self.admit_history_or_degrade(bytes.len())
        };
        #[cfg(not(feature = "ghostty-core-proof"))]
        let history_degradation = None;
        let output_seq = self
            .output_seq
            .checked_add(1)
            .ok_or(TerminalReplayError::SequenceExhausted)?;
        let terminal_state_revision = self
            .terminal_state_revision
            .checked_add(1)
            .ok_or(TerminalReplayError::TerminalStateRevisionExhausted)?;
        #[cfg(feature = "ghostty-core-proof")]
        let core_write = match successor_terminal.as_mut() {
            Some(terminal) => terminal.process(bytes)?,
            None => self.terminal.process(bytes)?,
        };
        #[cfg(not(feature = "ghostty-core-proof"))]
        let core_write = self.terminal.process(bytes)?;
        #[cfg(feature = "ghostty-core-proof")]
        if let Some(terminal) = successor_terminal {
            self.terminal = terminal;
            self.recovered_history_boundary = None;
        }
        #[cfg(feature = "ghostty-core-proof")]
        if history_degradation.is_none() {
            history_degradation = self.drain_history_transfers_after_mutation();
        }
        #[cfg(feature = "ghostty-core-proof")]
        let presentation_changed = core_write.projection_changed || crossed_recovered_boundary;
        #[cfg(not(feature = "ghostty-core-proof"))]
        let presentation_changed = true;
        #[cfg(feature = "ghostty-core-proof")]
        let terminal_events = core_write
            .events
            .into_iter()
            .filter_map(|event| match event {
                TerminalCoreEvent::ClipboardWrite(content)
                    if std::str::from_utf8(&content).is_ok() =>
                {
                    Some(terminal_event::Event::ClipboardWriteRequest(
                        ClipboardWriteRequestEvent {
                            format: ClipboardFormat::Utf8Text as i32,
                            content,
                        },
                    ))
                }
                TerminalCoreEvent::ClipboardWrite(_) => None,
            })
            .collect::<Vec<_>>();
        #[cfg(feature = "ghostty-core-proof")]
        let state_changed = presentation_changed || !terminal_events.is_empty();
        #[cfg(not(feature = "ghostty-core-proof"))]
        let state_changed = presentation_changed;
        if state_changed {
            self.terminal_state_revision = terminal_state_revision;
        }
        let delta = OutputDelta {
            terminal_epoch: self.fence.terminal_epoch.clone(),
            output_seq,
            bytes: bytes.to_vec(),
            rows: self.pending_output_geometry.map(|geometry| geometry.0),
            columns: self.pending_output_geometry.map(|geometry| geometry.1),
            working_directory: None,
            execution_location: self.execution_location.clone(),
            agent_identity: None,
        };
        self.pending_output_geometry = None;
        self.output_seq = output_seq;
        self.retained.push(delta.clone());
        #[cfg(feature = "ghostty-core-proof")]
        let terminal_records = terminal_events
            .into_iter()
            .map(|event| {
                self.terminal_event_id = self
                    .terminal_event_id
                    .checked_add(1)
                    .ok_or(TerminalReplayError::TerminalEventSequenceExhausted)?;
                Ok(TerminalStateRecord {
                    schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
                    terminal_epoch: self.fence.terminal_epoch.clone(),
                    through_output_seq: output_seq,
                    state_revision: self.terminal_state_revision,
                    body: Some(terminal_state_record::Body::Event(TerminalEvent {
                        event_id: self.terminal_event_id,
                        event: Some(event),
                    })),
                })
            })
            .collect::<Result<Vec<_>, TerminalReplayError>>()?;
        Ok(IngestedTerminalOutput {
            delta,
            pty_replies: core_write.pty_replies,
            pty_reply_overflow: core_write.pty_reply_overflow,
            #[cfg(feature = "ghostty-core-proof")]
            terminal_records,
            #[cfg(feature = "ghostty-core-proof")]
            terminal_event_overflow: core_write.event_overflow,
            projection_changed: presentation_changed,
            presentation_degradation: core_write.presentation_degradation,
            history_degradation,
        })
    }

    #[cfg(feature = "ghostty-core-proof")]
    fn admit_history_or_degrade(&mut self, incoming_bytes: usize) -> Option<TerminalReplayError> {
        match self
            .history_transfer
            .ensure_history_capacity(self.terminal.history_transfer_source(), incoming_bytes)
        {
            Ok(()) => None,
            Err(error) => {
                self.history_transfer
                    .abandon(self.terminal.history_transfer_source());
                Some(error)
            }
        }
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub(crate) fn reconcile_terminal_history(&mut self) -> Result<bool, TerminalReplayError> {
        if self.recovered_history_boundary.is_some() {
            return Ok(true);
        }
        self.history_transfer
            .reconcile_pending(self.terminal.history_transfer_source())
    }

    #[cfg(feature = "ghostty-core-proof")]
    fn drain_history_transfers_after_mutation(&mut self) -> Option<TerminalReplayError> {
        for _ in 0..64 {
            match self
                .history_transfer
                .drive_after_mutation(self.terminal.history_transfer_source())
            {
                terminal_history_transfer::HistoryTransferProgress::Committed(_) => continue,
                terminal_history_transfer::HistoryTransferProgress::Idle
                | terminal_history_transfer::HistoryTransferProgress::Backpressured { .. } => {
                    return None;
                }
                terminal_history_transfer::HistoryTransferProgress::Degraded(error) => {
                    self.history_transfer
                        .abandon(self.terminal.history_transfer_source());
                    return Some(error);
                }
            }
        }
        None
    }

    pub fn observe_working_directory(
        &mut self,
        observation: WorkingDirectoryObservation,
    ) -> Result<bool, TerminalReplayError> {
        self.validate_working_directory(&observation.path)?;
        Ok(self
            .apply_working_directory(observation, self.output_seq)?
            .is_some())
    }

    pub fn observe_execution_location(
        &mut self,
        observation: ExecutionLocationObservation,
    ) -> Result<bool, TerminalReplayError> {
        self.validate_execution_location(&observation.location)?;
        let projection = ExecutionLocationProjection {
            terminal_epoch: self.fence.terminal_epoch.clone(),
            observed_through_output_seq: self.output_seq,
            location: observation.location,
            source: ExecutionLocationSource::ProcessInspection,
        };
        // Semantic change only — the observation fence (observed_through_output_seq)
        // advances with every output delta, so a whole-projection compare flags a
        // streaming session as "changed" on every 750ms identity poll and the
        // runtime identity loop then broadcasts a full screen snapshot per poll
        // (up to ~700KiB, full clear+rewrite in every subscriber). Mirror the
        // working-directory/agent-identity discipline: compare what the location
        // MEANS, keep the fence as bookkeeping.
        let changed = self.execution_location.as_ref().is_none_or(|current| {
            current.location != projection.location || current.source != projection.source
        });
        self.execution_location = Some(projection);
        Ok(changed)
    }

    pub fn observe_agent_identity(
        &mut self,
        observation: AgentIdentityObservation,
    ) -> Result<bool, TerminalReplayError> {
        let projection = AgentIdentityProjection {
            terminal_epoch: self.fence.terminal_epoch.clone(),
            observed_through_output_seq: self.output_seq,
            agent: observation.agent,
            source: observation.source,
        };
        let changed = self.agent_identity.as_ref().is_none_or(|current| {
            current.agent != projection.agent || current.source != projection.source
        });
        self.agent_identity = Some(projection);
        Ok(changed)
    }

    #[must_use]
    pub fn current_agent_provider(&self) -> Option<AgentProvider> {
        self.agent_identity
            .as_ref()
            .and_then(|identity| identity.agent)
    }

    #[must_use]
    pub fn has_agent_runtime_state(&self) -> bool {
        self.agent_runtime_state.is_some()
    }

    #[must_use]
    pub fn agent_runtime_state(&self) -> Option<&AgentRuntimeStateProjection> {
        self.agent_runtime_state.as_ref()
    }

    pub fn observe_provider_conversation_identity(
        &mut self,
        observation: ProviderConversationIdentityObservation,
    ) -> Result<Option<ProviderConversationIdentityProjection>, TerminalReplayError> {
        if !valid_opaque_identity(&observation.provider_id)
            || !valid_opaque_identity(&observation.conversation_id)
        {
            return Err(TerminalReplayError::InvalidProviderConversationIdentity);
        }
        if let Some(current) = self.provider_conversation_identity.as_ref() {
            if current.provider_id == observation.provider_id
                && current.conversation_id == observation.conversation_id
            {
                if current.source == ProviderConversationIdentitySource::LaunchRequest
                    && observation.source == ProviderConversationIdentitySource::ProviderEvent
                {
                    let projection = ProviderConversationIdentityProjection {
                        fence: self.fence.clone(),
                        revision: current
                            .revision
                            .checked_add(1)
                            .ok_or(TerminalReplayError::StateRevisionExhausted)?,
                        observed_through_output_seq: self.output_seq,
                        provider_id: observation.provider_id,
                        conversation_id: observation.conversation_id,
                        source: ProviderConversationIdentitySource::ProviderEvent,
                    };
                    self.provider_conversation_identity = Some(projection.clone());
                    return Ok(Some(projection));
                }
                return Ok(None);
            }
            return Err(TerminalReplayError::ProviderConversationIdentityConflict);
        }
        let projection = ProviderConversationIdentityProjection {
            fence: self.fence.clone(),
            revision: 1,
            observed_through_output_seq: self.output_seq,
            provider_id: observation.provider_id,
            conversation_id: observation.conversation_id,
            source: observation.source,
        };
        self.provider_conversation_identity = Some(projection.clone());
        Ok(Some(projection))
    }

    #[must_use]
    pub fn provider_conversation_identity(
        &self,
    ) -> Option<&ProviderConversationIdentityProjection> {
        self.provider_conversation_identity.as_ref()
    }

    #[must_use]
    pub fn screen_contents(&self) -> String {
        self.terminal.screen_contents()
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn encode_structured_input(
        &mut self,
        intent: &terminal_state_protocol::InputIntent,
    ) -> Result<Vec<u8>, TerminalReplayError> {
        self.terminal.encode_input(intent)
    }

    #[must_use]
    pub fn agent_prompt_admission(&self, target: &AgentPromptTarget) -> AgentPromptAdmission {
        if self.has_pending_controller_input()
            || (target.is_fresh() && self.fresh_agent_prompt_consumed)
        {
            return AgentPromptAdmission::Refused;
        }
        if self.provider_conversation_identity.is_none() {
            if let AgentPromptTarget::ProcessObservedFreshAgent {
                expected_provider_id,
            } = target
            {
                let Some(agent) = self.current_agent_provider() else {
                    return AgentPromptAdmission::Pending;
                };
                if agent.as_str() != expected_provider_id {
                    return AgentPromptAdmission::Pending;
                }
                let Some(runtime) = self.agent_runtime_state.as_ref() else {
                    return AgentPromptAdmission::Pending;
                };
                return runtime_agent_prompt_admission(
                    target,
                    runtime,
                    AgentRuntimeStateSource::ProcessLifecycle,
                );
            }
        }
        let Some(identity) = self.provider_conversation_identity.as_ref() else {
            // A provider may persist its first conversation only after input.
            // Its fenced readiness report can admit fresh input without
            // claiming that a resumable conversation already exists.
            return match (target, self.agent_runtime_state.as_ref()) {
                (AgentPromptTarget::FreshAgent, Some(runtime)) => runtime_agent_prompt_admission(
                    target,
                    runtime,
                    AgentRuntimeStateSource::ProviderEvent,
                ),
                _ => target.unresolved_authority(),
            };
        };
        if identity.source != ProviderConversationIdentitySource::ProviderEvent {
            return target.unresolved_authority();
        }
        if target
            .expected_provider_id()
            .is_some_and(|expected| identity.provider_id != expected)
            || matches!(
                target,
                AgentPromptTarget::ExistingConversation {
                    expected_conversation_id,
                    ..
                } if identity.conversation_id.as_str() != expected_conversation_id.as_str()
            )
        {
            return AgentPromptAdmission::Refused;
        }
        let Some(runtime) = self.agent_runtime_state.as_ref() else {
            return target.unresolved_authority();
        };
        runtime_agent_prompt_admission(target, runtime, AgentRuntimeStateSource::ProviderEvent)
    }

    /// Prepares the exact provider target under the caller's serialized PTY
    /// mutation lock. This is intentionally read-only: the exact written
    /// prefix is the sole authority that consumes fresh-prompt or idle-turn
    /// state, so a proven zero-byte writer failure remains retryable.
    #[must_use]
    pub fn prepare_agent_prompt(&self, target: &AgentPromptTarget) -> Option<u64> {
        if self.agent_prompt_admission(target) != AgentPromptAdmission::Eligible {
            return None;
        }
        self.agent_runtime_state
            .as_ref()
            .map(|state| state.revision)
    }

    /// Folds one external agent state report as a `provider_event`
    /// observation, applying the provider-authority rules that cannot be
    /// expressed as a plain observation: exited epochs drop the report before
    /// any observation exists, lifecycle is never changed by a report, a
    /// `none` attention preserves the current attention episode, and
    /// `turn_completed` bypasses no-op suppression so completion counts always
    /// reach subscribers.
    pub fn apply_agent_state_report(
        &mut self,
        report: AgentStateReportObservation,
    ) -> Result<AgentStateReportFold, TerminalReplayError> {
        self.apply_agent_state_report_at(report, Instant::now())
    }

    fn apply_agent_state_report_at(
        &mut self,
        report: AgentStateReportObservation,
        now: Instant,
    ) -> Result<AgentStateReportFold, TerminalReplayError> {
        self.apply_agent_state_report_at_with_settlement(report, now, true)
    }

    fn apply_agent_state_report_at_with_settlement(
        &mut self,
        report: AgentStateReportObservation,
        now: Instant,
        settle_identified_completion: bool,
    ) -> Result<AgentStateReportFold, TerminalReplayError> {
        if !self.agent_state_report_observation_matches(report.expected_observation.as_ref()) {
            return Ok(AgentStateReportFold::NoOp);
        }
        if report.turn_completion_id.is_some() && !report.turn_completed {
            return Err(TerminalReplayError::InvalidAgentRuntimeState);
        }
        if report.attention != AgentRuntimeAttention::None
            && report.activity != AgentRuntimeActivity::Waiting
        {
            return Err(TerminalReplayError::InvalidAgentRuntimeState);
        }
        if settle_identified_completion && !self.causal_report_matches(&report)? {
            return Ok(AgentStateReportFold::NoOp);
        }
        if self
            .agent_runtime_state
            .as_ref()
            .is_some_and(|current| current.lifecycle == AgentRuntimeLifecycle::Exited)
        {
            return Ok(AgentStateReportFold::DroppedExited);
        }
        if report
            .turn_completion_id
            .as_ref()
            .is_some_and(|completion_id| self.accepted_turn_completion_ids.contains(completion_id))
        {
            return Ok(AgentStateReportFold::NoOp);
        }
        if settle_identified_completion && report.turn_completed {
            if let Some(completion_id) = report.turn_completion_id.as_ref() {
                if self
                    .pending_turn_completion
                    .as_ref()
                    .and_then(|pending| pending.report.turn_completion_id.as_ref())
                    == Some(completion_id)
                {
                    // A delivery retry acknowledges the same candidate without
                    // extending its deadline or double-counting it.
                    return Ok(AgentStateReportFold::NoOp);
                }
                let acknowledges_input = report.expected_observation.is_none();
                let input_projection = if acknowledges_input
                    && self.pending_controller_input == PendingControllerInput::Submitted
                {
                    self.agent_runtime_state
                        .clone()
                        .map(|current| {
                            self.fold_agent_runtime_observation(
                                AgentRuntimeObservation::new(
                                    current.lifecycle,
                                    current.activity,
                                    current.attention,
                                    current.source,
                                ),
                                false,
                                true,
                                now,
                            )
                        })
                        .transpose()?
                        .flatten()
                } else {
                    None
                };
                // A distinct later completion supersedes the candidate. Retire
                // its identity so a delayed retry cannot resurrect it after
                // this newer boundary has been observed.
                self.retire_pending_turn_completion();
                self.remember_report_causality(&report);
                let mut report = report;
                // The observation fence authorized admission. Terminal output
                // produced while the provider settles is presentation, not a
                // second authority over whether this turn completed.
                report.expected_observation = None;
                self.pending_turn_completion = Some(PendingTurnCompletion {
                    expires_at: now
                        .checked_add(Duration::from_millis(IDENTIFIED_TURN_COMPLETION_SETTLE_MS))
                        .unwrap_or(now),
                    state_revision: self
                        .agent_runtime_state
                        .as_ref()
                        .map(|current| current.revision),
                    report,
                });
                if acknowledges_input {
                    self.acknowledge_controller_submit();
                }
                return Ok(input_projection
                    .map_or(AgentStateReportFold::NoOp, AgentStateReportFold::Applied));
            }
        }
        // Reports never change lifecycle. Without a prior observation the
        // provider is emitting events, so the epoch is observably running.
        let lifecycle = self
            .agent_runtime_state
            .as_ref()
            .map_or(AgentRuntimeLifecycle::Running, |current| current.lifecycle);
        // A waiting report without attention does not clear a current
        // attention episode: providers whose idle notifications carry no
        // attention detail must not churn or duplicate attention identities.
        // A working report legitimately ends the episode because non-none
        // attention always implies waiting.
        let attention = match (report.activity, report.attention) {
            (AgentRuntimeActivity::Waiting, AgentRuntimeAttention::None) => self
                .agent_runtime_state
                .as_ref()
                .map_or(AgentRuntimeAttention::None, |current| current.attention),
            (_, attention) => attention,
        };
        let observation = AgentRuntimeObservation::new(
            lifecycle,
            report.activity,
            attention,
            AgentRuntimeStateSource::ProviderEvent,
        );
        let completion_id = report.turn_completion_id.clone();
        let acknowledges_input =
            settle_identified_completion && report.expected_observation.is_none();
        let projection = self.fold_agent_runtime_observation(
            observation,
            report.turn_completed,
            acknowledges_input,
            now,
        )?;
        if settle_identified_completion {
            self.remember_report_causality(&report);
        }
        // Every later report supersedes a pending candidate, even when its
        // activity is unchanged. Retire only after the fallible fold succeeds.
        self.retire_pending_turn_completion();
        // A snapshot-fenced read or delayed settlement cannot acknowledge input
        // accepted since the original observation. Only a new semantic event can.
        if acknowledges_input {
            self.acknowledge_controller_submit();
        }
        if projection.is_some() {
            if let Some(completion_id) = completion_id {
                self.remember_turn_completion_id(completion_id);
            }
        }
        self.working_deadline = if report.activity == AgentRuntimeActivity::Working {
            let ttl_ms = report
                .working_ttl_ms
                .unwrap_or(DEFAULT_WORKING_TTL_MS)
                .min(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS);
            let expires_at = now
                .checked_add(Duration::from_millis(ttl_ms))
                .unwrap_or(now);
            self.agent_runtime_state
                .as_ref()
                .map(|current| WorkingDeadline {
                    expires_at,
                    state_revision: current.revision,
                })
        } else {
            None
        };
        Ok(match projection {
            Some(projection) => AgentStateReportFold::Applied(projection),
            None => AgentStateReportFold::NoOp,
        })
    }

    /// Expires transient controller observations without inventing semantic completion.
    /// This never inspects terminal output. A single Host-owned deadline is
    /// revision-fenced so refreshed observations and every later typed state
    /// win without spawning stale timer mutations.
    pub fn expire_agent_runtime_state(
        &mut self,
        now: Instant,
    ) -> Result<Option<AgentRuntimeStateProjection>, TerminalReplayError> {
        if let Some(pending) = self.pending_turn_completion.as_ref() {
            if now < pending.expires_at {
                // While completion settles, its shorter deadline owns the
                // state. An older working lease must not publish waiting first.
                return Ok(None);
            }
            let pending = self
                .pending_turn_completion
                .take()
                .expect("pending completion was present");
            if self
                .agent_runtime_state
                .as_ref()
                .map(|current| current.revision)
                != pending.state_revision
            {
                if let Some(completion_id) = pending.report.turn_completion_id {
                    self.remember_turn_completion_id(completion_id);
                }
                return Ok(None);
            }
            return match self.apply_agent_state_report_at_with_settlement(
                pending.report,
                now,
                false,
            )? {
                AgentStateReportFold::Applied(projection) => Ok(Some(projection)),
                AgentStateReportFold::NoOp | AgentStateReportFold::DroppedExited => Ok(None),
            };
        }
        let Some(deadline) = self.working_deadline else {
            return Ok(None);
        };
        if now < deadline.expires_at {
            return Ok(None);
        }
        let Some(current) = self.agent_runtime_state.as_ref() else {
            self.working_deadline = None;
            return Ok(None);
        };
        if current.revision != deadline.state_revision
            || current.lifecycle != AgentRuntimeLifecycle::Running
            || current.activity != AgentRuntimeActivity::Working
        {
            self.working_deadline = None;
            return Ok(None);
        }
        let source = current.source;
        if matches!(
            source,
            AgentRuntimeStateSource::ProviderEvent | AgentRuntimeStateSource::OrchestrationEvent
        ) {
            // Silence cannot complete a provider task or release its descendants.
            // Retain the last confirmed state until a typed report or process exit.
            self.working_deadline = None;
            return Ok(None);
        }
        let observation = AgentRuntimeObservation::new(
            AgentRuntimeLifecycle::Running,
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            source,
        );
        let projection = self.fold_agent_runtime_observation(observation, false, false, now)?;
        self.working_deadline = None;
        Ok(projection)
    }

    /// Applies the two semantic facts carried by one wire report as one
    /// transaction. A late failure (for example revision exhaustion) restores
    /// every field touched by either fold so no unbroadcast partial projection
    /// can survive.
    pub fn apply_agent_state_report_with_identity(
        &mut self,
        report: AgentStateReportObservation,
        conversation_identity: Option<ProviderConversationIdentityObservation>,
    ) -> Result<
        (
            AgentStateReportFold,
            Option<ProviderConversationIdentityProjection>,
            bool,
        ),
        TerminalReplayError,
    > {
        self.apply_agent_state_report_with_identity_at(
            report,
            conversation_identity,
            Instant::now(),
        )
    }

    fn apply_agent_state_report_with_identity_at(
        &mut self,
        report: AgentStateReportObservation,
        conversation_identity: Option<ProviderConversationIdentityObservation>,
        now: Instant,
    ) -> Result<
        (
            AgentStateReportFold,
            Option<ProviderConversationIdentityProjection>,
            bool,
        ),
        TerminalReplayError,
    > {
        let reported_conversation_identity = conversation_identity.is_some();
        if !self.agent_state_report_observation_matches(report.expected_observation.as_ref())
            || !self.causal_report_matches(&report)?
        {
            return Ok((
                AgentStateReportFold::NoOp,
                reported_conversation_identity
                    .then(|| self.provider_conversation_identity.clone())
                    .flatten(),
                false,
            ));
        }
        if report.turn_completion_id.is_some() && !report.turn_completed {
            return Err(TerminalReplayError::InvalidAgentRuntimeState);
        }
        if report
            .turn_completion_id
            .as_ref()
            .is_some_and(|completion_id| self.accepted_turn_completion_ids.contains(completion_id))
        {
            return Ok((
                AgentStateReportFold::NoOp,
                reported_conversation_identity
                    .then(|| self.provider_conversation_identity.clone())
                    .flatten(),
                false,
            ));
        }
        let previous_agent_runtime_state = self.agent_runtime_state.clone();
        let previous_agent_runtime_changed_at = self.agent_runtime_changed_at;
        let previous_controller_input = self.pending_controller_input;
        let previous_working_deadline = self.working_deadline;
        let previous_pending_turn_completion = self.pending_turn_completion.clone();
        let previous_completion_id_order = self.accepted_turn_completion_id_order.clone();
        let previous_completion_ids = self.accepted_turn_completion_ids.clone();
        let previous_report_causality = self.report_causality.clone();
        // A newer report may retire a pending completion before its fallible
        // state fold. Snapshot the bounded identity index with the projections
        // so a late failure cannot leave a partial duplicate-suppression write.
        let previous_conversation_identity = self.provider_conversation_identity.clone();
        let result = (|| {
            let changed_conversation_projection = conversation_identity
                .map(|identity| self.observe_provider_conversation_identity(identity))
                .transpose()?
                .flatten();
            let conversation_projection = reported_conversation_identity
                .then(|| self.provider_conversation_identity.clone())
                .flatten();
            let state_fold = self.apply_agent_state_report_at(report, now)?;
            Ok((
                state_fold,
                conversation_projection,
                changed_conversation_projection.is_some(),
            ))
        })();
        if result.is_err() {
            self.agent_runtime_state = previous_agent_runtime_state;
            self.agent_runtime_changed_at = previous_agent_runtime_changed_at;
            self.pending_controller_input = previous_controller_input;
            self.working_deadline = previous_working_deadline;
            self.pending_turn_completion = previous_pending_turn_completion;
            self.accepted_turn_completion_id_order = previous_completion_id_order;
            self.accepted_turn_completion_ids = previous_completion_ids;
            self.report_causality = previous_report_causality;
            self.provider_conversation_identity = previous_conversation_identity;
        }
        result
    }

    fn remember_turn_completion_id(&mut self, completion_id: String) {
        if !self
            .accepted_turn_completion_ids
            .insert(completion_id.clone())
        {
            return;
        }
        if self.accepted_turn_completion_id_order.len() >= ACCEPTED_TURN_COMPLETION_IDS_CAPACITY {
            if let Some(evicted) = self.accepted_turn_completion_id_order.pop_front() {
                self.accepted_turn_completion_ids.remove(&evicted);
            }
        }
        self.accepted_turn_completion_id_order
            .push_back(completion_id);
    }

    fn retire_pending_turn_completion(&mut self) {
        let Some(pending) = self.pending_turn_completion.take() else {
            return;
        };
        if let Some(completion_id) = pending.report.turn_completion_id {
            self.remember_turn_completion_id(completion_id);
        }
    }

    fn agent_state_report_observation_matches(
        &self,
        expected: Option<&crate::local_protocol::AgentStateReportObservationFence>,
    ) -> bool {
        expected.is_none_or(|expected| {
            expected.terminal_epoch == self.fence.terminal_epoch
                && expected.output_sequence == self.output_seq
                && self
                    .agent_runtime_state
                    .as_ref()
                    .is_some_and(|current| current.revision == expected.runtime_revision)
        })
    }

    fn fold_agent_runtime_observation(
        &mut self,
        observation: AgentRuntimeObservation,
        turn_completed: bool,
        acknowledges_input: bool,
        now: Instant,
    ) -> Result<Option<AgentRuntimeStateProjection>, TerminalReplayError> {
        let unchanged = self.agent_runtime_state.as_ref().is_some_and(|current| {
            current.lifecycle == observation.lifecycle
                && current.activity == observation.activity
                && current.attention == observation.attention
                && current.source == observation.source
        });
        // A new input acknowledgement ends the old semantic idle epoch even
        // when activity is waiting on both sides. Advance before clearing the
        // pending input so revision exhaustion cannot revalidate an old fence.
        let input_acknowledged = acknowledges_input
            && self.pending_controller_input == PendingControllerInput::Submitted;
        if unchanged && !turn_completed && !input_acknowledged {
            return Ok(None);
        }

        let revision = self
            .agent_runtime_state
            .as_ref()
            .map_or(Some(1), |current| current.revision.checked_add(1))
            .ok_or(TerminalReplayError::StateRevisionExhausted)?;
        let attention_id = match observation.attention {
            AgentRuntimeAttention::None => None,
            _ => self
                .agent_runtime_state
                .as_ref()
                .filter(|current| current.attention == observation.attention)
                .and_then(|current| current.attention_id.clone())
                .or_else(|| Some(format!("attention-{revision}"))),
        };
        let turn_completed_count = self
            .agent_runtime_state
            .as_ref()
            .map_or(0, |current| current.turn_completed_count)
            .saturating_add(u64::from(turn_completed));
        let projection = AgentRuntimeStateProjection {
            terminal_epoch: self.fence.terminal_epoch.clone(),
            revision,
            observed_through_output_seq: self.output_seq,
            lifecycle: observation.lifecycle,
            activity: observation.activity,
            attention: observation.attention,
            attention_id,
            source: observation.source,
            turn_completed_count,
        };
        self.agent_runtime_state = Some(projection.clone());
        self.agent_runtime_changed_at = Some(now);
        Ok(Some(projection))
    }

    pub(crate) fn prepare_resize(
        &mut self,
        rows: u16,
        columns: u16,
    ) -> Result<PreparedTerminalResize, TerminalReplayError> {
        validate_dimensions(rows, columns, &self.limits)?;
        let changed = self.terminal.size() != (rows, columns);
        let terminal_state_revision = if changed {
            self.terminal_state_revision
                .checked_add(1)
                .ok_or(TerminalReplayError::TerminalStateRevisionExhausted)?
        } else {
            self.terminal_state_revision
        };
        Ok(PreparedTerminalResize {
            rows,
            columns,
            terminal_state_revision,
            changed,
        })
    }

    pub fn resize(&mut self, rows: u16, columns: u16) -> Result<(), TerminalReplayError> {
        let prepared = self.prepare_resize(rows, columns)?;
        self.commit_resize(prepared).map(|_| ())
    }

    pub(crate) fn commit_resize(
        &mut self,
        prepared: PreparedTerminalResize,
    ) -> Result<Option<TerminalPresentationDegradation>, TerminalReplayError> {
        if !prepared.changed {
            return Ok(None);
        }
        let mutation = self.terminal.resize(prepared.rows, prepared.columns)?;
        self.terminal_state_revision = prepared.terminal_state_revision;
        self.pending_output_geometry = Some((prepared.rows, prepared.columns));
        Ok(mutation.presentation_degradation)
    }

    pub fn checkpoint(&mut self) -> Result<TerminalCheckpoint, TerminalReplayError> {
        #[cfg(feature = "ghostty-core-proof")]
        self.reconcile_terminal_history()?;
        let TerminalCoreCheckpoint {
            format,
            engine_fingerprint,
            rows,
            columns,
            bytes,
        } = self.terminal.checkpoint(self.limits.max_checkpoint_bytes)?;
        #[cfg(not(feature = "ghostty-core-proof"))]
        let _ = &engine_fingerprint;
        let encoding = match format {
            #[cfg(not(feature = "ghostty-core-proof"))]
            TerminalCoreCheckpointFormat::LegacyAnsiRedrawV1 => {
                TerminalCheckpointEncoding::LegacyAnsiRedrawV1
            }
            #[cfg(feature = "ghostty-core-proof")]
            TerminalCoreCheckpointFormat::EngineNativeV1 => {
                TerminalCheckpointEncoding::EngineNativeV1 {
                    engine_fingerprint: engine_fingerprint
                        .ok_or(TerminalReplayError::InvalidRecoveredPresentation)?,
                }
            }
        };
        #[cfg(feature = "ghostty-core-proof")]
        let cold_history = match self.recovered_history_boundary.as_ref() {
            Some(boundary) => boundary.checkpoint_cold.clone(),
            None => self.history_transfer.checkpoint_receipt()?,
        };
        Ok(TerminalCheckpoint {
            fence: self.fence.clone(),
            sequence_through: self.output_seq,
            state_revision: self.terminal_state_revision,
            rows,
            columns,
            encoding,
            payload: bytes,
            alternate_screen: self.terminal.alternate_screen(),
            cursor_visible: self.terminal.cursor_visible(),
            #[cfg(feature = "ghostty-core-proof")]
            cold_history,
            #[cfg(not(feature = "ghostty-core-proof"))]
            cold_history: None,
        })
    }

    /// Seeds presentation from one exact predecessor before successor output
    /// sequence 1. The bytes are parsed into canonical screen state but never
    /// enter delta retention or advance `output_seq`.
    pub fn restore_presentation(
        &mut self,
        recovered: RecoveredPresentation,
        rows: u16,
        columns: u16,
        repaint_bytes: &[u8],
    ) -> Result<(), TerminalReplayError> {
        self.restore_checkpoint(
            recovered.clone(),
            TerminalCheckpoint {
                fence: recovered.source_fence.clone(),
                sequence_through: recovered.sequence_through,
                state_revision: 1,
                rows,
                columns,
                encoding: TerminalCheckpointEncoding::LegacyAnsiRedrawV1,
                payload: repaint_bytes.to_vec(),
                alternate_screen: false,
                cursor_visible: true,
                cold_history: None,
            },
        )
    }

    #[cfg(feature = "ghostty-core-proof")]
    fn prepare_recovered_history_boundary(
        &self,
        checkpoint: &TerminalCheckpoint,
    ) -> Result<(TerminalHistoryTransfer, RecoveredHistoryBoundary), TerminalReplayError> {
        let checkpoint_cold =
            retained_cold_history(checkpoint, self.limits.max_history_logical_lines).cloned();
        let projection_cold = self.history_transfer.store().capture_projection_source()?;
        let mut sealing_terminal = restore_terminal_core_with_hot_reserve(
            checkpoint,
            &self.fence.terminal_epoch,
            self.limits.max_history_logical_lines,
            1,
        )?;
        sealing_terminal.seal_primary_screen_as_history()?;
        let mut transaction = self
            .history_transfer
            .store()
            .begin_append_transaction(&self.fence.terminal_epoch, checkpoint_cold.as_ref())?;
        let source = sealing_terminal.history_transfer_source();
        while let Some(offer) = source.next_history_transfer_offer()? {
            let acknowledgement = transaction.stage(offer)?;
            source.acknowledge_history_transfer(&acknowledgement)?;
        }
        if source.retained_pending_history_bytes()? != 0 {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let sealed_history = self.history_transfer.with_store(transaction.commit()?)?;
        if sealed_history.checkpoint_receipt()?.is_none() {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        Ok((
            sealed_history,
            RecoveredHistoryBoundary {
                projection_cold,
                checkpoint_cold,
            },
        ))
    }

    pub fn restore_checkpoint(
        &mut self,
        recovered: RecoveredPresentation,
        checkpoint: TerminalCheckpoint,
    ) -> Result<(), TerminalReplayError> {
        #[cfg(feature = "ghostty-core-proof")]
        let inherited_cold_history =
            retained_cold_history(&checkpoint, self.limits.max_history_logical_lines).is_some();
        let result = self.restore_checkpoint_inner(recovered, checkpoint);
        #[cfg(feature = "ghostty-core-proof")]
        if result.is_err() && inherited_cold_history {
            // The selected archive and restored hot state are one presentation
            // transaction. Keeping only the archive after a failed restore
            // would combine predecessor logical ids with a fresh terminal.
            self.history_transfer
                .abandon(self.terminal.history_transfer_source());
        }
        result
    }

    fn restore_checkpoint_inner(
        &mut self,
        recovered: RecoveredPresentation,
        checkpoint: TerminalCheckpoint,
    ) -> Result<(), TerminalReplayError> {
        validate_fence(&recovered.source_fence)?;
        if self.output_seq != 0
            || self.recovered_presentation.is_some()
            || recovered.captured_unix_ms == 0
            || recovered.source_fence.workspace_id != self.fence.workspace_id
            || recovered.source_fence.runner_principal != self.fence.runner_principal
            || recovered.source_fence.terminal_epoch == self.fence.terminal_epoch
        {
            return Err(TerminalReplayError::InvalidRecoveredPresentation);
        }
        if checkpoint.fence != recovered.source_fence
            || checkpoint.sequence_through != recovered.sequence_through
        {
            return Err(TerminalReplayError::InvalidRecoveredPresentation);
        }
        validate_dimensions(checkpoint.rows, checkpoint.columns, &self.limits)?;
        if checkpoint.payload.is_empty()
            || checkpoint.payload.len() > self.limits.max_checkpoint_bytes
        {
            return Err(TerminalReplayError::InvalidRecoveredPresentation);
        }
        if let Some(cold_history) = &checkpoint.cold_history {
            cold_history.validate()?;
            if !matches!(
                &checkpoint.encoding,
                TerminalCheckpointEncoding::EngineNativeV1 { .. }
            ) {
                return Err(TerminalReplayError::InvalidRecoveredPresentation);
            }
        }

        let target_dimensions = self.terminal.size();
        #[cfg(feature = "ghostty-core-proof")]
        if self.history_transfer.checkpoint_receipt()?.as_ref()
            != retained_cold_history(&checkpoint, self.limits.max_history_logical_lines)
        {
            return Err(TerminalReplayError::InvalidRecoveredPresentation);
        }
        let terminal_state_revision = self
            .terminal_state_revision
            .checked_add(1)
            .ok_or(TerminalReplayError::TerminalStateRevisionExhausted)?;
        let mut terminal = restore_terminal_core(
            &checkpoint,
            &self.fence.terminal_epoch,
            self.limits.max_history_logical_lines,
        )?;
        let pending_output_geometry = if target_dimensions != (checkpoint.rows, checkpoint.columns)
        {
            terminal.resize(target_dimensions.0, target_dimensions.1)?;
            Some(target_dimensions)
        } else {
            self.pending_output_geometry
        };
        #[cfg(feature = "ghostty-core-proof")]
        let (history_transfer, recovered_history_boundary) =
            self.prepare_recovered_history_boundary(&checkpoint)?;
        // The replacement is fully constructed at the current presentation
        // geometry before any actor-owned state changes. From this point on no
        // operation is fallible, so observers can see only the predecessor or
        // the complete replacement at one new state revision.
        self.terminal = terminal;
        self.terminal_state_revision = terminal_state_revision;
        self.pending_output_geometry = pending_output_geometry;
        self.recovered_presentation = Some(recovered);
        #[cfg(feature = "ghostty-core-proof")]
        {
            self.history_transfer = history_transfer;
            self.recovered_history_boundary = Some(recovered_history_boundary);
        }
        Ok(())
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub(crate) fn activate_durable_history(&self) -> Result<(), TerminalReplayError> {
        self.history_transfer.activate_selected_root()
    }

    pub fn replay_after(
        &self,
        cursor: &ReconnectCursor,
    ) -> Result<ReplayResult, TerminalReplayError> {
        if cursor.terminal_epoch != self.fence.terminal_epoch {
            return Err(TerminalReplayError::TerminalEpochMismatch);
        }
        if cursor.after_output_seq > self.output_seq {
            return Err(TerminalReplayError::CursorAhead {
                requested: cursor.after_output_seq,
                current: self.output_seq,
            });
        }
        Ok(self
            .retained
            .replay_after(cursor, &self.fence.terminal_epoch, self.output_seq))
    }
}

fn restore_terminal_core(
    checkpoint: &TerminalCheckpoint,
    terminal_epoch: &str,
    maximum_history_logical_lines: usize,
) -> Result<Box<dyn TerminalCore>, TerminalReplayError> {
    restore_terminal_core_with_hot_reserve(
        checkpoint,
        terminal_epoch,
        maximum_history_logical_lines,
        DEFAULT_SCROLLBACK_ROWS.min(maximum_history_logical_lines),
    )
}

fn restore_terminal_core_with_hot_reserve(
    checkpoint: &TerminalCheckpoint,
    terminal_epoch: &str,
    maximum_history_logical_lines: usize,
    hot_reserve_rows: usize,
) -> Result<Box<dyn TerminalCore>, TerminalReplayError> {
    match &checkpoint.encoding {
        TerminalCheckpointEncoding::LegacyAnsiRedrawV1 => {
            let mut terminal = create_terminal_core_with_hot_reserve(
                checkpoint.rows,
                checkpoint.columns,
                terminal_epoch,
                maximum_history_logical_lines,
                hot_reserve_rows,
            )?;
            terminal.process(&checkpoint.payload)?;
            Ok(terminal)
        }
        TerminalCheckpointEncoding::EngineNativeV1 { engine_fingerprint } => {
            #[cfg(feature = "ghostty-core-proof")]
            {
                const FINGERPRINT: &str = "libghostty-vt:47147324cee9d12b537f0ea204bf16449d706b3a";
                if engine_fingerprint != FINGERPRINT {
                    return Err(TerminalReplayError::InvalidRecoveredPresentation);
                }
                Ok(Box::new(GhosttyProofAdapter::from_snapshot(
                    &checkpoint.payload,
                    hot_reserve_rows,
                    terminal_epoch,
                    retained_cold_history(checkpoint, maximum_history_logical_lines),
                )?))
            }
            #[cfg(not(feature = "ghostty-core-proof"))]
            {
                let _ = engine_fingerprint;
                Err(TerminalReplayError::InvalidRecoveredPresentation)
            }
        }
    }
}

#[cfg(feature = "ghostty-core-proof")]
fn create_terminal_core_after_recovered_history(
    rows: u16,
    columns: u16,
    terminal_epoch: &str,
    maximum_history_logical_lines: usize,
    cold_history: Option<&TerminalColdHistoryCheckpoint>,
) -> Result<Box<dyn TerminalCore>, TerminalReplayError> {
    Ok(Box::new(GhosttyProofAdapter::new_with_cold_history(
        rows,
        columns,
        DEFAULT_SCROLLBACK_ROWS.min(maximum_history_logical_lines),
        maximum_history_logical_lines,
        terminal_epoch,
        cold_history,
    )?))
}

fn create_terminal_core(
    rows: u16,
    columns: u16,
    terminal_epoch: &str,
    maximum_history_logical_lines: usize,
) -> Result<Box<dyn TerminalCore>, TerminalReplayError> {
    create_terminal_core_with_hot_reserve(
        rows,
        columns,
        terminal_epoch,
        maximum_history_logical_lines,
        DEFAULT_SCROLLBACK_ROWS.min(maximum_history_logical_lines),
    )
}

fn create_terminal_core_with_hot_reserve(
    rows: u16,
    columns: u16,
    terminal_epoch: &str,
    maximum_history_logical_lines: usize,
    hot_reserve_rows: usize,
) -> Result<Box<dyn TerminalCore>, TerminalReplayError> {
    #[cfg(feature = "ghostty-core-proof")]
    {
        Ok(Box::new(GhosttyProofAdapter::new(
            rows,
            columns,
            hot_reserve_rows,
            maximum_history_logical_lines,
            terminal_epoch,
        )?))
    }
    #[cfg(not(feature = "ghostty-core-proof"))]
    {
        let _ = (terminal_epoch, hot_reserve_rows);
        let terminal = TerminalModel::new(rows, columns, maximum_history_logical_lines);
        Ok(Box::new(terminal))
    }
}

#[cfg(feature = "ghostty-core-proof")]
/// Selects only the prefix that fits the current Host retention authority.
/// Logical line ids start at one and remain contiguous across cold PAGEs, so
/// the end anchor minus one is the retained logical-line count.
fn retained_cold_history(
    checkpoint: &TerminalCheckpoint,
    maximum_history_logical_lines: usize,
) -> Option<&TerminalColdHistoryCheckpoint> {
    let maximum = u64::try_from(maximum_history_logical_lines).unwrap_or(u64::MAX);
    checkpoint
        .cold_history
        .as_ref()
        .filter(|cold| cold.end_logical_line_id.saturating_sub(1) <= maximum)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplayResult {
    Deltas(Vec<OutputDelta>),
    Gap(ReplayGap),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalReplayError {
    InvalidFence {
        field: &'static str,
    },
    InvalidLimit {
        field: &'static str,
    },
    InvalidDimensions {
        rows: u16,
        columns: u16,
    },
    EmptyOutput,
    DeltaTooLarge {
        actual: usize,
        maximum: usize,
    },
    SnapshotLimitTooSmall {
        minimum: usize,
        actual: usize,
    },
    SequenceExhausted,
    TerminalStateRevisionExhausted,
    TerminalEventSequenceExhausted,
    StateRevisionExhausted,
    TerminalEpochMismatch,
    CursorAhead {
        requested: u64,
        current: u64,
    },
    InvalidWorkingDirectory,
    InvalidExecutionLocation,
    InvalidAgentRuntimeState,
    InvalidProviderConversationIdentity,
    ProviderConversationIdentityConflict,
    InvalidRecoveredPresentation,
    InvalidStructuredProjection {
        reason: &'static str,
    },
    InvalidStructuredInput,
    InvalidTerminalDefaultColors,
    ColdHistoryInvariant,
    ColdHistoryJournalUnavailable,
    ColdHistoryRecoveryRequired,
    ColdHistoryRetentionRequired,
    ColdHistoryOfferRequiresContinuation,
    ColdHistoryProjectionBudgetExceeded,
    ViewportCaptureBudgetExceeded {
        actual: usize,
        maximum: usize,
    },
    ColdHistoryCellWidthExceedsColumns {
        display_width: u32,
        columns: u16,
    },
    HistoryStorageBackpressure {
        pending_bytes: usize,
        maximum_pending_bytes: usize,
    },
    TerminalEngineFailure {
        operation: &'static str,
        code: i32,
    },
}

impl fmt::Display for TerminalReplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFence { field } => {
                write!(formatter, "session fence field {field} is invalid")
            }
            Self::InvalidLimit { field } => {
                write!(formatter, "terminal replay limit {field} is invalid")
            }
            Self::InvalidDimensions { rows, columns } => {
                write!(
                    formatter,
                    "terminal dimensions {rows}x{columns} exceed configured bounds"
                )
            }
            Self::EmptyOutput => write!(formatter, "empty PTY reads are not sequenced"),
            Self::DeltaTooLarge { actual, maximum } => {
                write!(
                    formatter,
                    "output delta length {actual} exceeds maximum {maximum}"
                )
            }
            Self::SnapshotLimitTooSmall { minimum, actual } => write!(
                formatter,
                "snapshot limit {actual} is smaller than safe redraw prefix {minimum}"
            ),
            Self::SequenceExhausted => write!(formatter, "terminal output sequence is exhausted"),
            Self::TerminalStateRevisionExhausted => {
                write!(formatter, "terminal state revision is exhausted")
            }
            Self::TerminalEventSequenceExhausted => {
                write!(formatter, "terminal event sequence is exhausted")
            }
            Self::StateRevisionExhausted => {
                write!(formatter, "agent runtime state revision is exhausted")
            }
            Self::TerminalEpochMismatch => {
                write!(formatter, "replay cursor belongs to another terminal epoch")
            }
            Self::CursorAhead { requested, current } => write!(
                formatter,
                "replay cursor {requested} is ahead of current output sequence {current}"
            ),
            Self::InvalidWorkingDirectory => {
                write!(
                    formatter,
                    "working directory projection is invalid or exceeds its limit"
                )
            }
            Self::InvalidExecutionLocation => {
                write!(formatter, "execution location projection is invalid")
            }
            Self::InvalidAgentRuntimeState => {
                write!(formatter, "agent runtime state observation is inconsistent")
            }
            Self::InvalidProviderConversationIdentity => {
                write!(formatter, "provider conversation identity is invalid")
            }
            Self::ProviderConversationIdentityConflict => {
                write!(
                    formatter,
                    "provider conversation identity conflicts with the current provider epoch"
                )
            }
            Self::InvalidRecoveredPresentation => {
                write!(formatter, "recovered terminal presentation is inconsistent")
            }
            Self::InvalidStructuredProjection { reason } => {
                write!(
                    formatter,
                    "structured terminal projection is inconsistent: {reason}"
                )
            }
            Self::InvalidStructuredInput => {
                write!(formatter, "structured terminal input is invalid")
            }
            Self::InvalidTerminalDefaultColors => {
                write!(formatter, "terminal default colors are invalid")
            }
            Self::ColdHistoryInvariant => {
                write!(formatter, "cold terminal history is inconsistent")
            }
            Self::ColdHistoryJournalUnavailable => {
                write!(formatter, "cold terminal history journal is unavailable")
            }
            Self::ColdHistoryRecoveryRequired => {
                write!(formatter, "cold terminal history requires journal recovery")
            }
            Self::ColdHistoryRetentionRequired => {
                write!(
                    formatter,
                    "cold terminal history requires explicit compaction"
                )
            }
            Self::ColdHistoryOfferRequiresContinuation => {
                write!(
                    formatter,
                    "cold terminal history offer ended inside a logical line"
                )
            }
            Self::ColdHistoryProjectionBudgetExceeded => {
                write!(
                    formatter,
                    "cold terminal history projection exceeded its work budget"
                )
            }
            Self::ViewportCaptureBudgetExceeded { actual, maximum } => write!(
                formatter,
                "terminal viewport capture requires {actual} bytes, maximum is {maximum}"
            ),
            Self::ColdHistoryCellWidthExceedsColumns {
                display_width,
                columns,
            } => write!(
                formatter,
                "cold terminal history cell width {display_width} exceeds {columns} columns"
            ),
            Self::HistoryStorageBackpressure {
                pending_bytes,
                maximum_pending_bytes,
            } => write!(
                formatter,
                "terminal history storage is backpressured at {pending_bytes} bytes (maximum {maximum_pending_bytes})"
            ),
            Self::TerminalEngineFailure { operation, code } => {
                write!(
                    formatter,
                    "terminal engine {operation} failed with code {code}"
                )
            }
        }
    }
}

fn valid_opaque_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
        })
}

fn validate_agent_runtime_observation(
    observation: AgentRuntimeObservation,
) -> Result<(), TerminalReplayError> {
    let attention_is_none = observation.attention == AgentRuntimeAttention::None;
    let attention_matches_activity = attention_is_none
        || observation.activity == crate::local_protocol::AgentRuntimeActivity::Waiting;
    let exit_is_consistent = observation.lifecycle
        != crate::local_protocol::AgentRuntimeLifecycle::Exited
        || (observation.activity == crate::local_protocol::AgentRuntimeActivity::Waiting
            && attention_is_none);
    if attention_matches_activity && exit_is_consistent {
        Ok(())
    } else {
        Err(TerminalReplayError::InvalidAgentRuntimeState)
    }
}

impl TerminalReplayError {
    /// Bounded snake_case class token for receipts and diagnostics. Clients
    /// and journals match on it, so it is never prose and never localized.
    pub fn class_token(&self) -> &'static str {
        match self {
            Self::InvalidFence { .. } => "invalid_fence",
            Self::InvalidLimit { .. } => "invalid_limit",
            Self::InvalidDimensions { .. } => "invalid_dimensions",
            Self::EmptyOutput => "empty_output",
            Self::DeltaTooLarge { .. } => "delta_too_large",
            Self::SnapshotLimitTooSmall { .. } => "snapshot_limit_too_small",
            Self::SequenceExhausted => "sequence_exhausted",
            Self::TerminalStateRevisionExhausted => "terminal_state_revision_exhausted",
            Self::TerminalEventSequenceExhausted => "terminal_event_sequence_exhausted",
            Self::StateRevisionExhausted => "state_revision_exhausted",
            Self::TerminalEpochMismatch => "terminal_epoch_mismatch",
            Self::CursorAhead { .. } => "cursor_ahead",
            Self::InvalidWorkingDirectory => "invalid_working_directory",
            Self::InvalidExecutionLocation => "invalid_execution_location",
            Self::InvalidAgentRuntimeState => "invalid_agent_runtime_state",
            Self::InvalidProviderConversationIdentity => "invalid_provider_conversation_identity",
            Self::ProviderConversationIdentityConflict => "provider_conversation_identity_conflict",
            Self::InvalidRecoveredPresentation => "invalid_recovered_presentation",
            Self::InvalidStructuredProjection { .. } => "invalid_structured_projection",
            Self::InvalidStructuredInput => "invalid_structured_input",
            Self::InvalidTerminalDefaultColors => "invalid_terminal_default_colors",
            Self::ColdHistoryInvariant => "cold_history_invariant",
            Self::ColdHistoryJournalUnavailable => "cold_history_journal_unavailable",
            Self::ColdHistoryRecoveryRequired => "cold_history_recovery_required",
            Self::ColdHistoryRetentionRequired => "cold_history_retention_required",
            Self::ColdHistoryOfferRequiresContinuation => {
                "cold_history_offer_requires_continuation"
            }
            Self::ColdHistoryProjectionBudgetExceeded => "cold_history_projection_budget_exceeded",
            Self::ViewportCaptureBudgetExceeded { .. } => "viewport_capture_budget_exceeded",
            Self::ColdHistoryCellWidthExceedsColumns { .. } => {
                "cold_history_cell_width_exceeds_columns"
            }
            Self::HistoryStorageBackpressure { .. } => "history_storage_backpressure",
            Self::TerminalEngineFailure { .. } => "terminal_engine_failure",
        }
    }
}

impl std::error::Error for TerminalReplayError {}

fn validate_fence(fence: &SessionFence) -> Result<(), TerminalReplayError> {
    for (field, value) in [
        ("workspace_id", fence.workspace_id.as_str()),
        ("session_id", fence.session_id.as_str()),
        ("runner_principal", fence.runner_principal.as_str()),
        ("runner_instance", fence.runner_instance.as_str()),
        ("host_instance_id", fence.host_instance_id.as_str()),
        ("terminal_epoch", fence.terminal_epoch.as_str()),
    ] {
        if value.is_empty() || value.len() > 256 {
            return Err(TerminalReplayError::InvalidFence { field });
        }
    }
    Ok(())
}

fn validate_limits(limits: &TerminalReplayLimits) -> Result<(), TerminalReplayError> {
    for (field, value) in [
        ("max_rows", usize::from(limits.max_rows)),
        ("max_columns", usize::from(limits.max_columns)),
        ("max_cells", limits.max_cells),
        ("max_delta_bytes", limits.max_delta_bytes),
        ("max_retained_bytes", limits.max_retained_bytes),
        ("max_retained_records", limits.max_retained_records),
        ("max_snapshot_bytes", limits.max_snapshot_bytes),
        ("max_checkpoint_bytes", limits.max_checkpoint_bytes),
        (
            "max_history_logical_lines",
            limits.max_history_logical_lines,
        ),
        ("max_cold_history_bytes", limits.max_cold_history_bytes),
        (
            "max_history_transfer_offer_bytes",
            limits.max_history_transfer_offer_bytes,
        ),
        (
            "max_pending_history_transfer_bytes",
            limits.max_pending_history_transfer_bytes,
        ),
        (
            "max_working_directory_bytes",
            limits.max_working_directory_bytes,
        ),
        (
            "max_execution_target_bytes",
            limits.max_execution_target_bytes,
        ),
    ] {
        if value == 0 {
            return Err(TerminalReplayError::InvalidLimit { field });
        }
    }
    Ok(())
}

impl TerminalReplay {
    fn validate_execution_location(
        &self,
        location: &ExecutionLocation,
    ) -> Result<(), TerminalReplayError> {
        match location {
            ExecutionLocation::Local => Ok(()),
            ExecutionLocation::Ssh { target }
                if !target.is_empty()
                    && target.len() <= self.limits.max_execution_target_bytes
                    && target.trim() == target
                    && !target
                        .chars()
                        .any(|character| character.is_control() || character.is_whitespace()) =>
            {
                Ok(())
            }
            ExecutionLocation::Ssh { .. } => Err(TerminalReplayError::InvalidExecutionLocation),
        }
    }

    fn validate_working_directory(&self, path: &str) -> Result<(), TerminalReplayError> {
        if valid_path(path, self.limits.max_working_directory_bytes) {
            Ok(())
        } else {
            Err(TerminalReplayError::InvalidWorkingDirectory)
        }
    }

    fn apply_working_directory(
        &mut self,
        observation: WorkingDirectoryObservation,
        observed_through_output_seq: u64,
    ) -> Result<Option<WorkingDirectoryProjection>, TerminalReplayError> {
        self.validate_working_directory(&observation.path)?;
        let projection = WorkingDirectoryProjection {
            terminal_epoch: self.fence.terminal_epoch.clone(),
            observed_through_output_seq,
            path: observation.path,
            source: observation.source,
        };
        let changed = self.working_directory.as_ref().is_none_or(|current| {
            current.path != projection.path || current.source != projection.source
        });
        self.working_directory = Some(projection.clone());
        Ok(changed.then_some(projection))
    }
}

fn validate_dimensions(
    rows: u16,
    columns: u16,
    limits: &TerminalReplayLimits,
) -> Result<(), TerminalReplayError> {
    if rows == 0
        || columns == 0
        || rows > limits.max_rows
        || columns > limits.max_columns
        || usize::from(rows) * usize::from(columns) > limits.max_cells
    {
        return Err(TerminalReplayError::InvalidDimensions { rows, columns });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
