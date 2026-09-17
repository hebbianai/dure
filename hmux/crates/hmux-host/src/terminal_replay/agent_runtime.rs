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
    pub activity: AgentRuntimeActivity,
    pub attention: AgentRuntimeAttention,
    pub turn_completed: bool,
    pub turn_completion_id: Option<String>,
    pub causality: Option<crate::local_protocol::AgentStateReportCausality>,
    pub working_ttl_ms: Option<u64>,
    pub expected_observation: Option<AgentStateReportObservationFence>,
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
    Draft,
    Submitted,
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

    /// Records draft-capable user input only after the PTY accepted it. This
    /// is intentionally independent of terminal output sequencing: line
    /// editors may retain a draft without echoing it, and automatic
    /// replacement must preserve that invisible state.
    pub fn record_controller_input(&mut self) {
        self.record_controller_write();
        self.pending_controller_input = PendingControllerInput::Draft;
    }

    #[must_use]
    pub fn has_pending_controller_input(&self) -> bool {
        self.pending_controller_input != PendingControllerInput::None
    }

    pub(crate) fn is_semantically_quiescent(&self) -> bool {
        !self.has_pending_controller_input()
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
        if self.pending_controller_input == PendingControllerInput::Submitted {
            self.pending_controller_input = PendingControllerInput::None;
        }
    }
}
