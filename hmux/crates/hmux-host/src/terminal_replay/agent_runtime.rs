use super::{
    DEFAULT_WORKING_TTL_MS, TerminalReplay, TerminalReplayError, WorkingDeadline,
    validate_agent_runtime_observation,
};
use std::time::{Duration, Instant};

use crate::local_protocol::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
    AgentRuntimeStateProjection, AgentRuntimeStateSource, AgentStateReportObservationFence,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentRuntimeObservation {
    pub lifecycle: AgentRuntimeLifecycle,
    pub activity: AgentRuntimeActivity,
    pub attention: AgentRuntimeAttention,
    pub source: AgentRuntimeStateSource,
    /// Working only because of background work after the provider's turn
    /// ended; its prompt accepts input.
    pub background_work: bool,
}

impl AgentRuntimeObservation {
    #[must_use]
    pub const fn new(
        lifecycle: AgentRuntimeLifecycle,
        activity: AgentRuntimeActivity,
        attention: AgentRuntimeAttention,
        source: AgentRuntimeStateSource,
    ) -> Self {
        Self {
            lifecycle,
            activity,
            attention,
            source,
            background_work: false,
        }
    }

    /// The same observation of an existing projection, so a republish keeps
    /// every Host fact it does not change.
    #[must_use]
    pub(super) fn of(current: &AgentRuntimeStateProjection) -> Self {
        Self {
            background_work: current.background_work,
            ..Self::new(
                current.lifecycle,
                current.activity,
                current.attention,
                current.source,
            )
        }
    }

    #[must_use]
    pub const fn working(source: AgentRuntimeStateSource) -> Self {
        Self::new(
            AgentRuntimeLifecycle::Running,
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
            source,
        )
    }

    #[must_use]
    pub const fn waiting(source: AgentRuntimeStateSource) -> Self {
        Self::new(
            AgentRuntimeLifecycle::Running,
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            source,
        )
    }

    #[must_use]
    pub const fn exited() -> Self {
        Self::new(
            AgentRuntimeLifecycle::Exited,
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            AgentRuntimeStateSource::ProcessLifecycle,
        )
    }
}

/// One externally delivered agent state report, before the Host folds it into
/// a `provider_event` observation. Reports carry no lifecycle: the Host keeps
/// its current lifecycle so a report can never resurrect an exited provider.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentStateReportObservation {
    pub progress: Option<crate::local_protocol::AgentProgressReport>,
    pub activity: AgentRuntimeActivity,
    pub attention: AgentRuntimeAttention,
    pub turn_completed: bool,
    pub turn_completion_id: Option<String>,
    pub causality: Option<crate::local_protocol::AgentStateReportCausality>,
    pub working_ttl_ms: Option<u64>,
    pub expected_observation: Option<AgentStateReportObservationFence>,
    /// Background work the provider started is in flight; see
    /// `AgentStateReport::background_work`.
    pub background_work: bool,
}

impl AgentStateReportObservation {
    /// Background work keeps the session busy whatever the foreground does,
    /// so the Host folds every background report as working.
    pub(super) fn projected_activity(&self) -> AgentRuntimeActivity {
        if self.background_work {
            AgentRuntimeActivity::Working
        } else {
            self.activity
        }
    }
}

/// Fold outcome for one agent state report. `Applied` carries the projection
/// to broadcast; `NoOp` means the report matched current state and produced no
/// new revision; `DroppedExited` means the provider epoch had already exited
/// and the report was discarded before any observation was constructed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentStateReportFold {
    Applied(AgentRuntimeStateProjection),
    NoOp,
    DroppedExited,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PendingControllerInput {
    None,
    /// Draft-capable input was accepted. When it followed a submit the
    /// provider has not acknowledged yet, erasing the draft again returns to
    /// that submit's wait instead of admitting a prompt into the new turn.
    Draft {
        after_unacknowledged_submit: bool,
    },
    Submitted,
}

/// One change to the provider's unsubmitted line, derived from accepted
/// controller input. The Host never reads the line editor: it counts the
/// characters it wrote and the Backspaces that erase them, and stops
/// counting at the first input it cannot follow.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControllerDraftEdit {
    /// This many characters typed or pasted at the end of the line.
    Inserted(usize),
    /// Backspace erased up to this many characters before the cursor.
    Erased(usize),
    /// Text may have been inserted in a way the Host cannot count:
    /// completion, history recall, a yank or an unrecognized sequence.
    InsertedUncounted,
    /// The cursor moved into the line or a word was erased: an existing
    /// draft changed in a way the Host cannot count, but an empty line
    /// stays empty.
    EditedUncounted,
}

/// The Host's estimate of the unsubmitted text in the provider's line
/// editor. Counting is intentionally independent of terminal output: line
/// editors may retain or erase a draft without echoing it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ControllerDraft {
    /// Nothing typed since the last accepted submit, or every typed
    /// character was erased again.
    Empty,
    /// This many characters (never zero) stand at the end of the line, with
    /// the cursor after them.
    Counted(usize),
    /// Text whose length the Host cannot follow. Only a submit clears it.
    Uncounted,
}

impl ControllerDraft {
    #[must_use]
    pub(super) fn is_empty(self) -> bool {
        self == Self::Empty
    }

    /// Folds one accepted edit. An erase counts only against characters the
    /// Host counted, so the estimate never reports an empty line while text
    /// the Host did not count may remain.
    #[must_use]
    pub(super) fn apply(self, edit: ControllerDraftEdit) -> Self {
        match (self, edit) {
            (_, ControllerDraftEdit::Inserted(0) | ControllerDraftEdit::Erased(0))
            | (Self::Uncounted, _) => self,
            (_, ControllerDraftEdit::InsertedUncounted)
            | (Self::Counted(_), ControllerDraftEdit::EditedUncounted) => Self::Uncounted,
            (
                Self::Empty,
                ControllerDraftEdit::Erased(_) | ControllerDraftEdit::EditedUncounted,
            ) => Self::Empty,
            (Self::Empty, ControllerDraftEdit::Inserted(count)) => Self::Counted(count),
            (Self::Counted(current), ControllerDraftEdit::Inserted(count)) => {
                Self::Counted(current.saturating_add(count))
            }
            (Self::Counted(current), ControllerDraftEdit::Erased(count)) => {
                if current > count {
                    Self::Counted(current - count)
                } else {
                    Self::Empty
                }
            }
        }
    }
}

impl TerminalReplay {
    pub fn observe_agent_runtime_state(
        &mut self,
        observation: AgentRuntimeObservation,
    ) -> Result<Option<AgentRuntimeStateProjection>, TerminalReplayError> {
        self.observe_agent_runtime_state_at(observation, Instant::now())
    }

    pub(super) fn observe_agent_runtime_state_at(
        &mut self,
        observation: AgentRuntimeObservation,
        now: Instant,
    ) -> Result<Option<AgentRuntimeStateProjection>, TerminalReplayError> {
        validate_agent_runtime_observation(observation)?;
        // Process inspection can prove that a provider exists, but not that
        // its active turn is idle. Its running/waiting observation is only an
        // initial baseline; a typed controller or provider fact is stronger.
        if observation.source == AgentRuntimeStateSource::ProcessLifecycle
            && observation.lifecycle == AgentRuntimeLifecycle::Running
            && observation.activity == AgentRuntimeActivity::Waiting
            && (self.agent_runtime_state.is_some() || self.pending_turn_completion.is_some())
        {
            return Ok(None);
        }
        let working_observation = observation.activity == AgentRuntimeActivity::Working;
        let controller_submit =
            observation.source == AgentRuntimeStateSource::ControllerInput && working_observation;
        let acknowledges_input = matches!(
            observation.source,
            AgentRuntimeStateSource::ProviderEvent | AgentRuntimeStateSource::OrchestrationEvent
        );
        let projection =
            self.fold_agent_runtime_observation(observation, false, acknowledges_input, now)?;
        // A typed runtime observation supersedes an Escape the Host saw: the
        // provider, its process or a controller submit now says what the turn
        // did. A repeated process-inspection baseline returned above instead.
        self.interrupt_requested = false;
        if acknowledges_input {
            self.acknowledge_controller_submit();
        }
        // A repeated controller-submit remains a fresh acknowledgement even
        // when the projection is a no-op. Commit these related mutations only
        // after the fallible fold so revision exhaustion cannot erase pending
        // input after bytes already crossed the PTY boundary.
        if controller_submit {
            self.pending_controller_input = PendingControllerInput::None;
            // A controller-owned successor is newer than an uncommitted
            // provider completion even when `working` is a projection no-op.
            self.retire_pending_turn_completion();
        }
        // Legacy controller estimates and semantic working observations share
        // one revision-fenced deadline. Repeated observations refresh that
        // deadline; later accepted state supersedes it. Semantic sessions do
        // not enter this path for controller submits.
        self.working_deadline = if working_observation {
            let expires_at = now
                .checked_add(Duration::from_millis(DEFAULT_WORKING_TTL_MS))
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
        Ok(projection)
    }

    /// Records that a controller operation may have reached the PTY. This
    /// consumes fresh-prompt authority without inventing a pending draft for
    /// control-only traffic.
    pub fn record_controller_write(&mut self) {
        self.fresh_agent_prompt_consumed = true;
    }

    /// Records draft-capable user input only after the PTY accepted it, when
    /// the Host cannot count what that input put into the line.
    pub fn record_controller_input(&mut self) {
        self.record_controller_draft_edit(ControllerDraftEdit::InsertedUncounted);
    }

    /// Records one accepted edit of the unsubmitted line. This is
    /// intentionally independent of terminal output sequencing: line editors
    /// may retain or erase a draft without echoing it, and automatic
    /// replacement must preserve that invisible state. The Host therefore
    /// counts only what it wrote. A count that returns to zero is an empty
    /// prompt again, which releases draft-guarded automation and the
    /// pending-input fact alike; input the Host cannot follow holds both
    /// until the next accepted submit.
    pub fn record_controller_draft_edit(&mut self, edit: ControllerDraftEdit) {
        self.record_controller_write();
        let before = self.unsubmitted_controller_draft;
        let after = before.apply(edit);
        self.unsubmitted_controller_draft = after;
        self.pending_controller_input = match (self.pending_controller_input, after.is_empty()) {
            (PendingControllerInput::None, false) => PendingControllerInput::Draft {
                after_unacknowledged_submit: false,
            },
            (PendingControllerInput::Submitted, false) => PendingControllerInput::Draft {
                after_unacknowledged_submit: true,
            },
            (
                PendingControllerInput::Draft {
                    after_unacknowledged_submit,
                },
                true,
            ) if !before.is_empty() => {
                if after_unacknowledged_submit {
                    PendingControllerInput::Submitted
                } else {
                    PendingControllerInput::None
                }
            }
            (pending, _) => pending,
        };
    }

    #[must_use]
    pub fn has_pending_controller_input(&self) -> bool {
        self.pending_controller_input != PendingControllerInput::None
    }

    /// Whether draft-capable input reached the PTY after its last submit
    /// without every counted character being erased again. Line editors may
    /// erase text without echoing it, so input the Host cannot count
    /// conservatively remains pending until the next accepted submit.
    #[must_use]
    pub fn has_unsubmitted_controller_draft(&self) -> bool {
        !self.unsubmitted_controller_draft.is_empty()
    }

    /// Records that a bare Escape reached the PTY. While the provider reports
    /// an unfinished turn, that keypress is the only sign the Host can see of
    /// a person interrupting it: Claude Code runs no hook for an interrupt,
    /// so the turn's working lease would otherwise refuse every prompt until
    /// a later turn reports. The Host does not guess the provider's state:
    /// the projection stays `working` and semantic quiescence stays blocked,
    /// but agent prompt admission treats the prompt as able to take input
    /// until the next provider report or accepted submit. An Escape that
    /// closed a menu instead therefore only widens admission; it never makes
    /// the pane look idle. Outside a provider-reported working turn Escape
    /// is a plain control write.
    pub fn record_controller_interrupt_request(&mut self) {
        self.record_controller_write();
        if self.agent_runtime_state.as_ref().is_some_and(|state| {
            state.source == AgentRuntimeStateSource::ProviderEvent
                && state.lifecycle == AgentRuntimeLifecycle::Running
                && state.activity == AgentRuntimeActivity::Working
                && !state.background_work
        }) {
            self.interrupt_requested = true;
        }
    }

    /// Whether a bare Escape reached a provider-reported working turn that no
    /// later provider report or accepted submit has superseded.
    #[must_use]
    pub fn has_interrupt_request(&self) -> bool {
        self.interrupt_requested
    }

    pub(crate) fn is_semantically_quiescent(&self) -> bool {
        !self.has_pending_controller_input()
            && !self.interrupt_requested
            && self
                .agent_runtime_state
                .as_ref()
                .is_some_and(|state| state.is_semantically_quiescent())
    }

    pub(crate) fn semantic_idle_ms_at(&self, now: Instant) -> Option<u64> {
        if !self.is_semantically_quiescent() {
            return None;
        }
        let elapsed = now.checked_duration_since(self.agent_runtime_changed_at?)?;
        u64::try_from(elapsed.as_millis()).ok()
    }

    /// A PTY submit consumes input authority, not provider activity. Retain
    /// the legacy bounded estimate only until a semantic reporter owns state.
    pub fn record_controller_submit(
        &mut self,
    ) -> Result<Option<AgentRuntimeStateProjection>, TerminalReplayError> {
        self.record_controller_write();
        // The submit bytes already crossed the PTY boundary, so the draft is
        // no longer unsubmitted even if the fallible provider fold fails, and
        // the turn it starts has its own reports to answer an earlier Escape.
        self.unsubmitted_controller_draft = ControllerDraft::Empty;
        self.interrupt_requested = false;
        if self.pending_turn_completion.is_some()
            || self.agent_runtime_state.as_ref().is_some_and(|state| {
                matches!(
                    state.source,
                    AgentRuntimeStateSource::ProviderEvent
                        | AgentRuntimeStateSource::OrchestrationEvent
                )
            })
        {
            // A submit starts a new work boundary even if its provider begin
            // report is lost. An older completion cannot acknowledge it.
            if let Some(causality) = self.report_causality.as_mut() {
                causality.work_id = None;
            }
            self.pending_controller_input = PendingControllerInput::Submitted;
            return Ok(None);
        }
        if !self.has_agent_runtime_state() {
            return Ok(None);
        }
        self.observe_agent_runtime_state(AgentRuntimeObservation::working(
            AgentRuntimeStateSource::ControllerInput,
        ))
    }

    pub(super) fn acknowledge_controller_submit(&mut self) {
        self.pending_controller_input = match self.pending_controller_input {
            PendingControllerInput::Submitted => PendingControllerInput::None,
            PendingControllerInput::Draft {
                after_unacknowledged_submit: true,
            } => PendingControllerInput::Draft {
                after_unacknowledged_submit: false,
            },
            pending => pending,
        };
    }
}
