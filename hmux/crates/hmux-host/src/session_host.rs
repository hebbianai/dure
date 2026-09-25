mod input;
mod inspection;

#[cfg(feature = "ghostty-core-proof")]
use crate::local_discovery::{LifetimeLock, SessionDiscovery};
use crate::local_protocol::{
    ProcessProof, ReconnectCursor, RecoveredPresentation, ScreenSnapshot, ScreenSnapshotProfile,
    SessionFence, TerminalDefaultColors,
};
use crate::provider_epoch::{CompletedProviderEpoch, ExitTombstone, ProviderExitStatus};
use crate::terminal_replay::{
    AgentIdentityObservation, AgentRuntimeObservation, AgentStateReportFold,
    AgentStateReportObservation, ExecutionLocationObservation, IngestedTerminalOutput,
    PreparedTerminalResize, ProviderConversationIdentityObservation, ReplayResult,
    TerminalCheckpoint, TerminalPresentationDegradation, TerminalReplay, TerminalReplayError,
    TerminalReplayLimits, WorkingDirectoryObservation,
};
#[cfg(feature = "ghostty-core-proof")]
use crate::terminal_replay::{
    CapturedViewportFrame, CapturedViewportSource, ViewProjection, ViewportCaptureRequest,
    ViewportIntentApplication, ViewportIntentDisposition, WheelPtySink,
};
use std::borrow::Cow;
use std::collections::VecDeque;
use std::fmt;
#[cfg(feature = "ghostty-core-proof")]
use std::sync::Arc;
use std::time::Instant;

pub struct SessionHost {
    current: ProviderEpoch,
    retained: VecDeque<CompletedProviderEpoch>,
    retained_epoch_limit: usize,
    controller_generation: u64,
    rows: u16,
    columns: u16,
    replay_limits: TerminalReplayLimits,
}

pub struct PreparedSessionResize<'a> {
    host: &'a mut SessionHost,
    terminal: PreparedTerminalResize,
    rows: u16,
    columns: u16,
}

impl PreparedSessionResize<'_> {
    pub fn commit(self) -> Result<Option<TerminalPresentationDegradation>, SessionHostError> {
        let Self {
            host,
            terminal,
            rows,
            columns,
        } = self;
        let ProviderEpoch::Running { replay, .. } = &mut host.current else {
            unreachable!("the prepared resize exclusively borrows a running Host")
        };
        let presentation_degradation = replay.commit_resize(terminal)?;
        host.rows = rows;
        host.columns = columns;
        Ok(presentation_degradation)
    }
}

enum ProviderEpoch {
    Running {
        provider_process: ProcessProof,
        replay: Box<TerminalReplay>,
    },
    Exited(Box<CompletedProviderEpoch>),
    Transitioning,
}

#[cfg(feature = "ghostty-core-proof")]
pub struct DurableTerminalHistory<'a> {
    discovery: &'a SessionDiscovery,
    lifetime_lock: Arc<LifetimeLock>,
    recovered: Option<&'a TerminalCheckpoint>,
    terminal_default_colors: TerminalDefaultColors,
}

#[cfg(feature = "ghostty-core-proof")]
impl<'a> DurableTerminalHistory<'a> {
    pub fn new(
        discovery: &'a SessionDiscovery,
        lifetime_lock: Arc<LifetimeLock>,
        recovered: Option<&'a TerminalCheckpoint>,
    ) -> Self {
        Self {
            discovery,
            lifetime_lock,
            recovered,
            terminal_default_colors: TerminalDefaultColors::default(),
        }
    }

    #[must_use]
    pub fn with_terminal_default_colors(mut self, colors: TerminalDefaultColors) -> Self {
        self.terminal_default_colors = colors;
        self
    }
}

impl SessionHost {
    pub fn new(
        fence: SessionFence,
        provider_process: ProcessProof,
        rows: u16,
        columns: u16,
        replay_limits: TerminalReplayLimits,
        retained_epoch_limit: usize,
    ) -> Result<Self, SessionHostError> {
        Self::new_with_default_colors(
            fence,
            provider_process,
            rows,
            columns,
            replay_limits,
            retained_epoch_limit,
            TerminalDefaultColors::default(),
        )
    }

    pub fn new_with_default_colors(
        fence: SessionFence,
        provider_process: ProcessProof,
        rows: u16,
        columns: u16,
        replay_limits: TerminalReplayLimits,
        retained_epoch_limit: usize,
        terminal_default_colors: TerminalDefaultColors,
    ) -> Result<Self, SessionHostError> {
        if retained_epoch_limit == 0 {
            return Err(SessionHostError::InvalidRetainedEpochLimit);
        }
        let replay = TerminalReplay::new_with_default_colors(
            fence,
            rows,
            columns,
            replay_limits.clone(),
            terminal_default_colors,
        )?;
        Ok(Self::from_replay(
            replay,
            provider_process,
            rows,
            columns,
            replay_limits,
            retained_epoch_limit,
        ))
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn new_with_durable_terminal_history(
        fence: SessionFence,
        provider_process: ProcessProof,
        rows: u16,
        columns: u16,
        replay_limits: TerminalReplayLimits,
        retained_epoch_limit: usize,
        history: DurableTerminalHistory<'_>,
    ) -> Result<Self, SessionHostError> {
        if retained_epoch_limit == 0 {
            return Err(SessionHostError::InvalidRetainedEpochLimit);
        }
        let storage = history
            .discovery
            .cold_history_storage(history.lifetime_lock)
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        let replay = TerminalReplay::new_with_cold_history_storage_and_default_colors(
            fence,
            rows,
            columns,
            replay_limits.clone(),
            storage,
            history.recovered,
            history.terminal_default_colors,
        )?;
        Ok(Self::from_replay(
            replay,
            provider_process,
            rows,
            columns,
            replay_limits,
            retained_epoch_limit,
        ))
    }

    fn from_replay(
        replay: TerminalReplay,
        provider_process: ProcessProof,
        rows: u16,
        columns: u16,
        replay_limits: TerminalReplayLimits,
        retained_epoch_limit: usize,
    ) -> Self {
        Self {
            current: ProviderEpoch::Running {
                provider_process,
                replay: Box::new(replay),
            },
            retained: VecDeque::new(),
            retained_epoch_limit,
            controller_generation: 1,
            rows,
            columns,
            replay_limits,
        }
    }

    pub fn ingest_output(
        &mut self,
        expected_fence: &SessionFence,
        bytes: &[u8],
    ) -> Result<IngestedTerminalOutput, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.ingest_output(bytes)?)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn encode_structured_input(
        &mut self,
        expected_fence: &SessionFence,
        intent: &terminal_state_protocol::InputIntent,
    ) -> Result<Vec<u8>, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.encode_structured_input(intent)?)
    }

    pub fn restore_presentation(
        &mut self,
        expected_fence: &SessionFence,
        recovered: RecoveredPresentation,
        rows: u16,
        columns: u16,
        repaint_bytes: &[u8],
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.restore_presentation(recovered, rows, columns, repaint_bytes)?;
        Ok(())
    }

    pub fn restore_checkpoint(
        &mut self,
        expected_fence: &SessionFence,
        recovered: RecoveredPresentation,
        checkpoint: TerminalCheckpoint,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.restore_checkpoint(recovered, checkpoint)?;
        Ok(())
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn activate_durable_terminal_history(
        &self,
        expected_fence: &SessionFence,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.activate_durable_history()?;
        Ok(())
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn reconcile_terminal_history(
        &mut self,
        expected_fence: &SessionFence,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.reconcile_terminal_history()?)
    }

    pub fn observe_working_directory(
        &mut self,
        expected_fence: &SessionFence,
        observation: WorkingDirectoryObservation,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay
            .observe_working_directory(observation)
            .map_err(SessionHostError::from)
    }

    pub fn observe_execution_location(
        &mut self,
        expected_fence: &SessionFence,
        observation: ExecutionLocationObservation,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay
            .observe_execution_location(observation)
            .map_err(SessionHostError::from)
    }

    pub fn observe_agent_identity(
        &mut self,
        expected_fence: &SessionFence,
        observation: AgentIdentityObservation,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay
            .observe_agent_identity(observation)
            .map_err(SessionHostError::from)
    }

    pub fn observe_agent_runtime_state(
        &mut self,
        expected_fence: &SessionFence,
        observation: AgentRuntimeObservation,
    ) -> Result<Option<crate::local_protocol::AgentRuntimeStateProjection>, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay
            .observe_agent_runtime_state(observation)
            .map_err(SessionHostError::from)
    }

    pub fn matches_agent_runtime_quiescence(
        &self,
        expected_fence: &SessionFence,
        expected: &crate::local_protocol::ManagedProviderStopQuiescenceFence,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.agent_runtime_state().is_some_and(|current| {
            current.terminal_epoch == expected.terminal_epoch
                && current.revision == expected.runtime_revision
                && replay.current_output_seq() == expected.observed_through_output_seq
                && replay.is_semantically_quiescent()
        }))
    }

    /// Applies a due working deadline for the exact live epoch. An
    /// exited epoch has already published its final typed state, so expiry is
    /// an idempotent no-op rather than a way to mutate the tombstone.
    pub fn expire_agent_runtime_state(
        &mut self,
        expected_fence: &SessionFence,
        now: Instant,
    ) -> Result<Option<crate::local_protocol::AgentRuntimeStateProjection>, SessionHostError> {
        match &mut self.current {
            ProviderEpoch::Running { replay, .. } => {
                expected_fence
                    .ensure_matches(replay.fence())
                    .map_err(|_| SessionHostError::FenceMismatch)?;
                replay
                    .expire_agent_runtime_state(now)
                    .map_err(SessionHostError::from)
            }
            ProviderEpoch::Exited(completed) => {
                expected_fence
                    .ensure_matches(&completed.tombstone.fence)
                    .map_err(|_| SessionHostError::FenceMismatch)?;
                Ok(None)
            }
            ProviderEpoch::Transitioning => Err(SessionHostError::SessionExited),
        }
    }

    pub fn observe_provider_conversation_identity(
        &mut self,
        expected_fence: &SessionFence,
        observation: ProviderConversationIdentityObservation,
    ) -> Result<
        Option<crate::local_protocol::ProviderConversationIdentityProjection>,
        SessionHostError,
    > {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay
            .observe_provider_conversation_identity(observation)
            .map_err(SessionHostError::from)
    }

    /// Establish only the exact provider conversation identity and return the
    /// canonical projection even for an idempotent repeat. This deliberately
    /// leaves agent runtime activity/attention untouched.
    pub fn report_provider_conversation_identity(
        &mut self,
        expected_fence: &SessionFence,
        observation: ProviderConversationIdentityObservation,
    ) -> Result<
        (
            crate::local_protocol::ProviderConversationIdentityProjection,
            bool,
        ),
        SessionHostError,
    > {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        let changed = replay
            .observe_provider_conversation_identity(observation)
            .map_err(SessionHostError::from)?;
        let projection = changed
            .clone()
            .or_else(|| replay.provider_conversation_identity().cloned())
            .ok_or(SessionHostError::TerminalReplay(
                crate::terminal_replay::TerminalReplayError::InvalidProviderConversationIdentity,
            ))?;
        Ok((projection, changed.is_some()))
    }

    /// Folds one external agent state report. An exited provider epoch drops
    /// the report instead of failing: the reporter learns `DroppedExited`
    /// through its receipt, and the tombstone is never resurrected.
    pub fn apply_agent_state_report(
        &mut self,
        expected_fence: &SessionFence,
        report: AgentStateReportObservation,
    ) -> Result<AgentStateReportFold, SessionHostError> {
        match &mut self.current {
            ProviderEpoch::Running { replay, .. } => {
                expected_fence
                    .ensure_matches(replay.fence())
                    .map_err(|_| SessionHostError::FenceMismatch)?;
                replay
                    .apply_agent_state_report(report)
                    .map_err(SessionHostError::from)
            }
            ProviderEpoch::Exited(completed) => {
                expected_fence
                    .ensure_matches(&completed.tombstone.fence)
                    .map_err(|_| SessionHostError::FenceMismatch)?;
                Ok(AgentStateReportFold::DroppedExited)
            }
            ProviderEpoch::Transitioning => Err(SessionHostError::SessionExited),
        }
    }

    pub fn apply_agent_state_report_with_identity(
        &mut self,
        expected_fence: &SessionFence,
        report: AgentStateReportObservation,
        conversation_identity: Option<ProviderConversationIdentityObservation>,
    ) -> Result<
        (
            AgentStateReportFold,
            Option<crate::local_protocol::ProviderConversationIdentityProjection>,
            bool,
        ),
        SessionHostError,
    > {
        match &mut self.current {
            ProviderEpoch::Running { replay, .. } => {
                expected_fence
                    .ensure_matches(replay.fence())
                    .map_err(|_| SessionHostError::FenceMismatch)?;
                replay
                    .apply_agent_state_report_with_identity(report, conversation_identity)
                    .map_err(SessionHostError::from)
            }
            ProviderEpoch::Exited(completed) => {
                expected_fence
                    .ensure_matches(&completed.tombstone.fence)
                    .map_err(|_| SessionHostError::FenceMismatch)?;
                Ok((AgentStateReportFold::DroppedExited, None, false))
            }
            ProviderEpoch::Transitioning => Err(SessionHostError::SessionExited),
        }
    }

    pub fn complete_provider(
        &mut self,
        expected_fence: &SessionFence,
        status: ProviderExitStatus,
    ) -> Result<CompletedProviderEpoch, SessionHostError> {
        if let ProviderEpoch::Exited(completed) = &self.current {
            if expected_fence == &completed.tombstone.fence {
                return Ok((**completed).clone());
            }
            return Err(SessionHostError::FenceMismatch);
        }
        let (final_snapshot, final_output_seq) = match &mut self.current {
            ProviderEpoch::Running { replay, .. } => {
                expected_fence
                    .ensure_matches(replay.fence())
                    .map_err(|_| SessionHostError::FenceMismatch)?;
                if replay.has_agent_runtime_state() {
                    replay.observe_agent_runtime_state(AgentRuntimeObservation::exited())?;
                }
                (
                    replay.snapshot(ScreenSnapshotProfile::Full)?,
                    replay.current_output_seq(),
                )
            }
            ProviderEpoch::Transitioning => return Err(SessionHostError::ProviderStillRunning),
            ProviderEpoch::Exited(_) => unreachable!("the exited case returned above"),
        };
        // All fallible checks happen before the state move. Otherwise a stale
        // completion request could strand a healthy Host in the private
        // Transitioning sentinel and make later inspection look like data loss.
        let current = std::mem::replace(&mut self.current, ProviderEpoch::Transitioning);
        let ProviderEpoch::Running {
            provider_process,
            replay,
        } = current
        else {
            unreachable!("the running state was verified before replacement");
        };
        let completed = CompletedProviderEpoch {
            tombstone: ExitTombstone {
                provider_conversation_identity: final_snapshot
                    .provider_conversation_identity
                    .clone(),
                fence: replay.fence().clone(),
                provider_process,
                exit: crate::local_protocol::Exit {
                    final_output_seq,
                    exit_code: status.exit_code,
                    platform_status: status.platform_status,
                    reason: status.reason,
                },
                exit_kind: status.kind,
                created_unix_ms: status.created_unix_ms,
                failure: status.failure,
            },
            final_snapshot,
        };
        self.controller_generation = self.controller_generation.saturating_add(1);
        self.current = ProviderEpoch::Exited(Box::new(completed));
        let ProviderEpoch::Exited(completed) = &self.current else {
            unreachable!("provider completion always installs an exited epoch");
        };
        Ok((**completed).clone())
    }

    pub fn begin_replacement(
        &mut self,
        predecessor_fence: &SessionFence,
        successor_fence: SessionFence,
        provider_process: ProcessProof,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Exited(predecessor) = &self.current else {
            return Err(SessionHostError::ProviderStillRunning);
        };
        predecessor_fence
            .ensure_matches(&predecessor.tombstone.fence)
            .map_err(|_| SessionHostError::FenceMismatch)?;
        validate_successor(predecessor_fence, &successor_fence)?;
        let predecessor = (**predecessor).clone();
        self.retained.push_back(predecessor);
        while self.retained.len() > self.retained_epoch_limit {
            self.retained.pop_front();
        }
        self.controller_generation = self.controller_generation.saturating_add(1);
        self.current = ProviderEpoch::Running {
            provider_process,
            replay: Box::new(TerminalReplay::new(
                successor_fence,
                self.rows,
                self.columns,
                self.replay_limits.clone(),
            )?),
        };
        Ok(())
    }

    pub fn admit_mutation(
        &self,
        expected_fence: &SessionFence,
        controller_generation: u64,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        if controller_generation != self.controller_generation {
            return Err(SessionHostError::StaleControllerGeneration);
        }
        Ok(())
    }

    pub fn grant_control(
        &mut self,
        expected_fence: &SessionFence,
        expected_generation: u64,
    ) -> Result<(u64, u64), SessionHostError> {
        self.admit_mutation(expected_fence, expected_generation)?;
        let previous = self.controller_generation;
        self.controller_generation = self.controller_generation.saturating_add(1);
        Ok((previous, self.controller_generation))
    }

    pub fn release_control(
        &mut self,
        expected_fence: &SessionFence,
        generation: u64,
    ) -> Result<(u64, u64), SessionHostError> {
        self.admit_mutation(expected_fence, generation)?;
        let previous = self.controller_generation;
        self.controller_generation = self.controller_generation.saturating_add(1);
        Ok((previous, self.controller_generation))
    }

    pub fn resize(
        &mut self,
        expected_fence: &SessionFence,
        controller_generation: u64,
        rows: u16,
        columns: u16,
    ) -> Result<(), SessionHostError> {
        self.prepare_resize(expected_fence, controller_generation, rows, columns)?
            .commit()
            .map(|_| ())
    }

    pub fn prepare_resize(
        &mut self,
        expected_fence: &SessionFence,
        controller_generation: u64,
        rows: u16,
        columns: u16,
    ) -> Result<PreparedSessionResize<'_>, SessionHostError> {
        self.admit_mutation(expected_fence, controller_generation)?;
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        let terminal = replay.prepare_resize(rows, columns)?;
        Ok(PreparedSessionResize {
            host: self,
            terminal,
            rows,
            columns,
        })
    }

    #[must_use]
    pub fn controller_generation(&self) -> u64 {
        self.controller_generation
    }

    #[must_use]
    pub fn provider_process(&self) -> Option<&ProcessProof> {
        match &self.current {
            ProviderEpoch::Running {
                provider_process, ..
            } => Some(provider_process),
            ProviderEpoch::Exited(_) => None,
            ProviderEpoch::Transitioning => None,
        }
    }

    #[must_use]
    pub fn current_fence(&self) -> &SessionFence {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => replay.fence(),
            ProviderEpoch::Exited(completed) => &completed.tombstone.fence,
            ProviderEpoch::Transitioning => {
                unreachable!("the Host lifecycle lock never exposes a transitioning epoch")
            }
        }
    }

    pub fn current_snapshot(
        &self,
        profile: ScreenSnapshotProfile,
    ) -> Result<ScreenSnapshot, SessionHostError> {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => Ok(replay.snapshot(profile)?),
            ProviderEpoch::Exited(completed) => Ok(completed.final_snapshot.clone()),
            ProviderEpoch::Transitioning => Err(SessionHostError::ProviderStillRunning),
        }
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn attach_view_projection(
        &mut self,
        expected_fence: &SessionFence,
    ) -> Result<ViewProjection, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.attach_view_projection()?)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn apply_viewport_intent(
        &mut self,
        expected_fence: &SessionFence,
        projection: &mut ViewProjection,
        ingress: &terminal_state_protocol::DecodedRecord,
    ) -> Result<ViewportIntentDisposition, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.apply_viewport_intent(projection, ingress)?)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn route_viewport_intent(
        &mut self,
        expected_fence: &SessionFence,
        projection: &mut ViewProjection,
        ingress: &terminal_state_protocol::DecodedRecord,
        wheel_pty_sink: WheelPtySink,
    ) -> Result<ViewportIntentApplication, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.route_viewport_intent(projection, ingress, wheel_pty_sink)?)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn set_view_projection_rows(
        &mut self,
        expected_fence: &SessionFence,
        projection: &mut ViewProjection,
        viewport_rows: u16,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.set_view_projection_rows(projection, viewport_rows)?)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn capture_latest_viewport_frame(
        &mut self,
        expected_fence: &SessionFence,
        projection: &mut ViewProjection,
    ) -> Result<Option<CapturedViewportFrame>, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.capture_latest_viewport_frame(projection)?)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn capture_viewport_source(
        &mut self,
        expected_fence: &SessionFence,
        requests: &[ViewportCaptureRequest],
        maximum_capture_bytes: usize,
    ) -> Result<CapturedViewportSource, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.capture_viewport_source(requests, maximum_capture_bytes)?)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn detach_view_projection(
        &mut self,
        expected_fence: &SessionFence,
        projection: &mut ViewProjection,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.detach_view_projection(projection)?;
        Ok(())
    }

    pub fn current_checkpoint(&mut self) -> Result<TerminalCheckpoint, SessionHostError> {
        match &mut self.current {
            ProviderEpoch::Running { replay, .. } => Ok(replay.checkpoint()?),
            ProviderEpoch::Exited(_) => Err(SessionHostError::SessionExited),
            ProviderEpoch::Transitioning => Err(SessionHostError::ProviderStillRunning),
        }
    }

    #[must_use]
    pub fn current_agent_provider(&self) -> Option<crate::local_protocol::AgentProvider> {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => replay.current_agent_provider(),
            ProviderEpoch::Exited(_) | ProviderEpoch::Transitioning => None,
        }
    }

    #[must_use]
    pub fn has_agent_runtime_state(&self) -> bool {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => replay.has_agent_runtime_state(),
            ProviderEpoch::Exited(_) | ProviderEpoch::Transitioning => false,
        }
    }

    #[must_use]
    pub fn current_screen_contents(&self) -> Option<String> {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => Some(replay.screen_contents()),
            ProviderEpoch::Exited(_) | ProviderEpoch::Transitioning => None,
        }
    }

    pub fn replay_after(
        &self,
        expected_fence: &SessionFence,
        cursor: &ReconnectCursor,
    ) -> Result<ReplayResult, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.replay_after(cursor)?)
    }

    #[must_use]
    pub fn earliest_retained_output_seq(&self) -> u64 {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => replay.earliest_retained_output_seq(),
            ProviderEpoch::Exited(completed) => {
                completed.tombstone.exit.final_output_seq.saturating_add(1)
            }
            ProviderEpoch::Transitioning => 0,
        }
    }

    #[must_use]
    pub fn current_output_seq(&self) -> u64 {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => replay.current_output_seq(),
            ProviderEpoch::Exited(completed) => completed.tombstone.exit.final_output_seq,
            ProviderEpoch::Transitioning => 0,
        }
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[must_use]
    pub fn current_terminal_state_revision(&self) -> u64 {
        match &self.current {
            ProviderEpoch::Running { replay, .. } => replay.current_terminal_state_revision(),
            ProviderEpoch::Exited(_) | ProviderEpoch::Transitioning => 0,
        }
    }

    #[must_use]
    pub fn current_dimensions(&self) -> (u16, u16) {
        (self.rows, self.columns)
    }

    #[must_use]
    pub fn is_exited(&self) -> bool {
        matches!(self.current, ProviderEpoch::Exited(_))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionHostError {
    FenceMismatch,
    SessionExited,
    ProviderStillRunning,
    StaleControllerGeneration,
    InvalidSuccessor(&'static str),
    InvalidRetainedEpochLimit,
    TerminalReplay(TerminalReplayError),
}

impl fmt::Display for SessionHostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FenceMismatch => write!(formatter, "session fence does not match this epoch"),
            Self::SessionExited => write!(formatter, "provider epoch has exited"),
            Self::ProviderStillRunning => write!(formatter, "provider epoch is still running"),
            Self::StaleControllerGeneration => write!(formatter, "controller generation is stale"),
            Self::InvalidSuccessor(field) => {
                write!(formatter, "successor fence is invalid at {field}")
            }
            Self::InvalidRetainedEpochLimit => {
                write!(formatter, "retained epoch limit must be nonzero")
            }
            Self::TerminalReplay(error) => error.fmt(formatter),
        }
    }
}

/// The receipt-detail token shape the session protocol validator accepts:
/// 3..=64 bytes of `[a-z0-9_]` starting with a letter. Every producer below
/// is bounded to it so a refusal can always be encoded and delivered.
pub const FAILURE_CLASS_MAX_BYTES: usize = 64;

impl SessionHostError {
    /// Bounded snake_case failure class for receipts and diagnostics. The
    /// wire receipt reason is a closed enum, so every Host failure that the
    /// enum cannot name collapses to its catch-all; this token carries the
    /// exact underlying class so the real cause survives to the client.
    /// Never prose: clients and journals match on it.
    pub fn failure_class(&self) -> Cow<'static, str> {
        match self {
            Self::FenceMismatch => Cow::Borrowed("fence_mismatch"),
            Self::SessionExited => Cow::Borrowed("session_exited"),
            Self::ProviderStillRunning => Cow::Borrowed("provider_still_running"),
            Self::StaleControllerGeneration => Cow::Borrowed("stale_controller_generation"),
            Self::InvalidSuccessor(field) => {
                Cow::Owned(bounded_failure_class(format!("invalid_successor_{field}")))
            }
            Self::InvalidRetainedEpochLimit => Cow::Borrowed("invalid_retained_epoch_limit"),
            Self::TerminalReplay(TerminalReplayError::TerminalEngineFailure {
                operation,
                code,
            }) => {
                // The code leads so a long operation name truncates, never
                // the number; a sign has no place in the token alphabet.
                let sign = if *code < 0 { "neg" } else { "" };
                Cow::Owned(bounded_failure_class(format!(
                    "replay_engine_failure_{sign}{}_{operation}",
                    code.unsigned_abs()
                )))
            }
            Self::TerminalReplay(error) => Cow::Owned(format!("replay_{}", error.class_token())),
        }
    }
}

fn bounded_failure_class(raw: String) -> String {
    let mut token: String = raw
        .chars()
        .map(|character| match character {
            'a'..='z' | '0'..='9' | '_' => character,
            'A'..='Z' => character.to_ascii_lowercase(),
            _ => '_',
        })
        .take(FAILURE_CLASS_MAX_BYTES)
        .collect();
    while token.ends_with('_') {
        token.pop();
    }
    token
}

impl std::error::Error for SessionHostError {}

impl From<TerminalReplayError> for SessionHostError {
    fn from(error: TerminalReplayError) -> Self {
        Self::TerminalReplay(error)
    }
}

fn validate_successor(
    predecessor: &SessionFence,
    successor: &SessionFence,
) -> Result<(), SessionHostError> {
    for (field, matches) in [
        (
            "workspace_id",
            predecessor.workspace_id == successor.workspace_id,
        ),
        ("session_id", predecessor.session_id == successor.session_id),
        (
            "runner_principal",
            predecessor.runner_principal == successor.runner_principal,
        ),
        (
            "host_instance_id",
            predecessor.host_instance_id == successor.host_instance_id,
        ),
    ] {
        if !matches {
            return Err(SessionHostError::InvalidSuccessor(field));
        }
    }
    if predecessor.runner_instance == successor.runner_instance {
        return Err(SessionHostError::InvalidSuccessor("runner_instance"));
    }
    if successor.channel_epoch <= predecessor.channel_epoch {
        return Err(SessionHostError::InvalidSuccessor("channel_epoch"));
    }
    if predecessor.terminal_epoch == successor.terminal_epoch {
        return Err(SessionHostError::InvalidSuccessor("terminal_epoch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    mod quiescence;
    use super::*;
    use crate::provider_epoch::ProviderExitKind;

    fn fence(runner: &str, channel: u64, terminal: &str) -> SessionFence {
        SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "principal".into(),
            runner_instance: runner.into(),
            channel_epoch: channel,
            host_instance_id: "host-stable".into(),
            terminal_epoch: terminal.into(),
        }
    }

    fn process(id: u32) -> ProcessProof {
        ProcessProof {
            process_id: id,
            start_marker: format!("start-{id}"),
        }
    }

    fn exit_status(kind: ProviderExitKind) -> ProviderExitStatus {
        ProviderExitStatus {
            exit_code: Some(0),
            platform_status: None,
            kind,
            reason: format!("{kind:?}"),
            created_unix_ms: 10,
            failure: None,
        }
    }

    fn host() -> SessionHost {
        SessionHost::new(
            fence("runner-1", 1, "terminal-1"),
            process(11),
            24,
            80,
            TerminalReplayLimits::default(),
            2,
        )
        .unwrap()
    }

    #[test]
    fn stale_fence_cannot_mutate_provider_conversation_identity() {
        let mut host = host();
        let stale = fence("runner-stale", 2, "terminal-stale");
        let target = crate::terminal_replay::AgentPromptTarget::FreshAgent;
        assert!(matches!(
            host.prepare_agent_prompt(&stale, &target),
            Err(SessionHostError::FenceMismatch)
        ));
        assert_eq!(
            host.observe_provider_conversation_identity(
                &stale,
                ProviderConversationIdentityObservation::new(
                    "codex",
                    "conversation-stale",
                    crate::local_protocol::ProviderConversationIdentitySource::ProviderEvent,
                ),
            ),
            Err(SessionHostError::FenceMismatch)
        );
        assert!(
            host.current_snapshot(ScreenSnapshotProfile::Full)
                .unwrap()
                .provider_conversation_identity
                .is_none()
        );
    }

    #[test]
    fn identity_only_report_preserves_runtime_state_and_replays_canonical_projection() {
        let mut host = host();
        let current = fence("runner-1", 1, "terminal-1");
        host.observe_agent_runtime_state(
            &current,
            AgentRuntimeObservation::working(
                crate::local_protocol::AgentRuntimeStateSource::ControllerInput,
            ),
        )
        .unwrap();
        let before = host
            .current_snapshot(ScreenSnapshotProfile::Full)
            .unwrap()
            .agent_runtime_state;
        let observation = || {
            ProviderConversationIdentityObservation::new(
                "codex",
                "conversation-exact",
                crate::local_protocol::ProviderConversationIdentitySource::ProviderEvent,
            )
        };

        let (first, first_changed) = host
            .report_provider_conversation_identity(&current, observation())
            .unwrap();
        let (replayed, replayed_changed) = host
            .report_provider_conversation_identity(&current, observation())
            .unwrap();
        let snapshot = host.current_snapshot(ScreenSnapshotProfile::Full).unwrap();

        assert!(first_changed);
        assert!(!replayed_changed);
        assert_eq!(replayed, first);
        assert_eq!(snapshot.agent_runtime_state, before);
        assert_eq!(
            snapshot.provider_conversation_identity.as_deref(),
            Some(&first)
        );
    }

    #[test]
    fn trailing_output_precedes_one_idempotent_exit_tombstone() {
        let mut host = host();
        let first = fence("runner-1", 1, "terminal-1");
        host.observe_agent_runtime_state(
            &first,
            AgentRuntimeObservation::working(
                crate::local_protocol::AgentRuntimeStateSource::ProviderEvent,
            ),
        )
        .unwrap();
        host.ingest_output(&first, b"ready\n").unwrap();
        host.ingest_output(&first, b"final\n").unwrap();
        let first_tombstone = host
            .complete_provider(&first, exit_status(ProviderExitKind::Normal))
            .unwrap()
            .tombstone;
        let replayed = host
            .complete_provider(&first, exit_status(ProviderExitKind::Normal))
            .unwrap();

        assert_eq!(first_tombstone.exit.final_output_seq, 2);
        assert_eq!(replayed.tombstone, first_tombstone);
        assert_eq!(
            replayed.final_snapshot.sequence_through,
            replayed.tombstone.exit.final_output_seq
        );
        assert_eq!(
            host.admit_mutation(&first, 1),
            Err(SessionHostError::SessionExited)
        );
        let final_state = replayed.final_snapshot.agent_runtime_state.unwrap();
        assert_eq!(
            final_state.lifecycle,
            crate::local_protocol::AgentRuntimeLifecycle::Exited
        );
        assert_eq!(
            final_state.activity,
            crate::local_protocol::AgentRuntimeActivity::Waiting
        );
        assert_eq!(
            final_state.attention,
            crate::local_protocol::AgentRuntimeAttention::None
        );
        assert_eq!(final_state.observed_through_output_seq, 2);
    }

    #[test]
    fn exited_epochs_drop_state_reports_before_any_observation_exists() {
        use crate::local_protocol::{AgentRuntimeActivity, AgentRuntimeAttention};

        let mut host = host();
        let current = fence("runner-1", 1, "terminal-1");
        let report = AgentStateReportObservation {
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            turn_completed: true,
            turn_completion_id: None,
            causality: None,
            working_ttl_ms: None,
            expected_observation: None,
        };
        assert!(matches!(
            host.apply_agent_state_report(&current, report.clone())
                .unwrap(),
            AgentStateReportFold::Applied(_)
        ));

        host.complete_provider(&current, exit_status(ProviderExitKind::Normal))
            .unwrap();
        assert_eq!(
            host.apply_agent_state_report(&current, report.clone())
                .unwrap(),
            AgentStateReportFold::DroppedExited
        );
        assert_eq!(
            host.apply_agent_state_report(&fence("runner-other", 1, "terminal-other"), report,),
            Err(SessionHostError::FenceMismatch)
        );
    }

    #[test]
    fn running_host_exposes_ordered_replay_for_the_current_fence() {
        let mut host = host();
        let current = fence("runner-1", 1, "terminal-1");
        host.ingest_output(&current, b"one").unwrap();
        host.ingest_output(&current, b"two").unwrap();

        let ReplayResult::Deltas(deltas) = host
            .replay_after(
                &current,
                &ReconnectCursor {
                    terminal_epoch: current.terminal_epoch.clone(),
                    after_output_seq: 0,
                },
            )
            .unwrap()
        else {
            panic!("retained cursor should produce ordered deltas")
        };

        assert_eq!(host.earliest_retained_output_seq(), 1);
        assert_eq!(
            deltas
                .iter()
                .map(|delta| delta.output_seq)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn replacement_clears_predecessor_working_directory_projection() {
        let mut host = host();
        let predecessor = fence("runner-1", 1, "terminal-1");
        host.observe_working_directory(
            &predecessor,
            WorkingDirectoryObservation::new(
                "/predecessor",
                crate::local_protocol::WorkingDirectorySource::LaunchFallback,
            ),
        )
        .unwrap();
        host.ingest_output(&predecessor, b"ready").unwrap();
        host.complete_provider(&predecessor, exit_status(ProviderExitKind::Normal))
            .unwrap();

        let successor = fence("runner-2", 2, "terminal-2");
        host.begin_replacement(&predecessor, successor.clone(), process(12))
            .unwrap();

        assert!(
            host.inspect(&successor)
                .unwrap()
                .0
                .working_directory
                .is_none()
        );
        assert_eq!(
            host.inspect(&predecessor)
                .unwrap()
                .0
                .working_directory
                .unwrap()
                .path,
            "/predecessor"
        );
    }

    #[test]
    fn exit_classification_does_not_change_host_retention() {
        for kind in [
            ProviderExitKind::Normal,
            ProviderExitKind::UsageLimit,
            ProviderExitKind::AuthenticationFailed,
        ] {
            let mut host = host();
            let current = fence("runner-1", 1, "terminal-1");
            host.ingest_output(&current, b"bounded final output")
                .unwrap();
            let completed = host.complete_provider(&current, exit_status(kind)).unwrap();
            assert!(completed.final_snapshot.agent_runtime_state.is_none());
            let (_, tombstone) = host.inspect(&current).unwrap();
            assert_eq!(tombstone.unwrap().exit_kind, kind);
            assert!(host.provider_process().is_none());
        }
    }

    #[test]
    fn completion_retains_the_latest_verified_conversation_without_a_client() {
        let mut host = host();
        let current = fence("runner-1", 1, "terminal-1");
        let observation = |id| {
            ProviderConversationIdentityObservation::new(
                "claude",
                id,
                crate::local_protocol::ProviderConversationIdentitySource::ProviderEvent,
            )
        };
        host.report_provider_conversation_identity(&current, observation("conversation-first"))
            .unwrap();
        let mut continuation = observation("conversation-latest");
        continuation.previous_conversation_id = Some("conversation-first".into());
        host.report_provider_conversation_identity(&current, continuation)
            .unwrap();
        let completed = host
            .complete_provider(&current, exit_status(ProviderExitKind::Normal))
            .unwrap();
        let identity = completed
            .tombstone
            .provider_conversation_identity
            .as_ref()
            .unwrap();
        assert_eq!(identity.conversation_id, "conversation-latest");
        assert_eq!(identity.fence, current);
        assert_eq!(
            Some(identity),
            completed
                .final_snapshot
                .provider_conversation_identity
                .as_ref()
        );
        assert_eq!(
            host.complete_provider(&current, exit_status(ProviderExitKind::Normal))
                .unwrap(),
            completed
        );
    }

    #[test]
    fn stale_completion_cannot_destroy_running_provider_state() {
        let mut host = host();
        let current = fence("runner-1", 1, "terminal-1");
        let stale = fence("runner-stale", 2, "terminal-stale");
        host.ingest_output(&current, b"still running").unwrap();

        assert_eq!(
            host.complete_provider(&stale, exit_status(ProviderExitKind::Normal)),
            Err(SessionHostError::FenceMismatch)
        );
        assert!(host.provider_process().is_some());
        assert_eq!(
            host.ingest_output(&current, b" after rejection")
                .unwrap()
                .output_seq,
            2
        );
    }

    #[test]
    fn explicit_replacement_preserves_host_and_rejects_predecessor_fences() {
        let mut host = host();
        let predecessor = fence("runner-1", 1, "terminal-1");
        host.ingest_output(&predecessor, b"predecessor").unwrap();
        host.complete_provider(&predecessor, exit_status(ProviderExitKind::UsageLimit))
            .unwrap();
        let successor = fence("runner-2", 2, "terminal-2");
        host.begin_replacement(&predecessor, successor.clone(), process(12))
            .unwrap();

        assert!(host.inspect(&predecessor).unwrap().1.is_some());
        assert_eq!(
            host.admit_mutation(&predecessor, host.controller_generation()),
            Err(SessionHostError::FenceMismatch)
        );
        assert_eq!(
            host.admit_mutation(&successor, 1),
            Err(SessionHostError::StaleControllerGeneration)
        );
        assert!(
            host.admit_mutation(&successor, host.controller_generation())
                .is_ok()
        );
    }

    #[test]
    fn client_detach_releases_only_control_and_provider_keeps_running() {
        let mut host = host();
        let current = fence("runner-1", 1, "terminal-1");
        let initial_generation = host.controller_generation();
        let (_, controlling_generation) = host.grant_control(&current, initial_generation).unwrap();

        let (_, detached_generation) = host
            .release_control(&current, controlling_generation)
            .unwrap();

        assert!(host.provider_process().is_some());
        assert_eq!(
            host.ingest_output(&current, b"after detach")
                .unwrap()
                .output_seq,
            1
        );
        assert_eq!(host.controller_generation(), detached_generation);
    }

    #[test]
    fn exactly_one_successor_preserves_logical_identity_and_fences_predecessor() {
        let mut host = host();
        let predecessor = fence("runner-1", 1, "terminal-1");
        host.ingest_output(&predecessor, b"final predecessor screen")
            .unwrap();
        host.complete_provider(
            &predecessor,
            exit_status(ProviderExitKind::AuthenticationFailed),
        )
        .unwrap();
        let successor = fence("runner-2", 2, "terminal-2");
        host.begin_replacement(&predecessor, successor.clone(), process(12))
            .unwrap();

        assert_eq!(host.current_fence().workspace_id, predecessor.workspace_id);
        assert_eq!(host.current_fence().session_id, predecessor.session_id);
        assert_eq!(
            host.current_fence().host_instance_id,
            predecessor.host_instance_id
        );
        assert_ne!(
            host.current_fence().runner_instance,
            predecessor.runner_instance
        );
        assert!(host.current_fence().channel_epoch > predecessor.channel_epoch);
        assert_ne!(
            host.current_fence().terminal_epoch,
            predecessor.terminal_epoch
        );
        assert_eq!(
            host.begin_replacement(
                &predecessor,
                fence("runner-3", 3, "terminal-3"),
                process(13)
            ),
            Err(SessionHostError::ProviderStillRunning)
        );
        assert_eq!(
            host.admit_mutation(&predecessor, host.controller_generation()),
            Err(SessionHostError::FenceMismatch)
        );
        assert!(host.inspect(&predecessor).unwrap().1.is_some());
        assert!(host.inspect(&successor).unwrap().1.is_none());
    }
}
