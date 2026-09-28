//! Progress is an observation, independent of lifecycle and stop authority.
use super::*;
use crate::local_protocol::{
    AGENT_PROGRESS_QUIET_MS, AgentProgressPhase, AgentProgressProjection, AgentProgressReport,
};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Default)]
pub(super) struct ProgressTracker {
    projection: Option<AgentProgressProjection>,
    changed_at: Option<Instant>,
}

impl ProgressTracker {
    fn observe(&mut self, report: &AgentProgressReport, now: Instant) {
        if self.projection.as_ref().is_some_and(|p| {
            p.report.source_id == report.source_id && p.report.sequence >= report.sequence
        }) {
            return;
        }
        self.projection = Some(AgentProgressProjection {
            report: report.clone(),
            last_activity_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            quiet_threshold_ms: AGENT_PROGRESS_QUIET_MS,
            progress_unconfirmed: false,
        });
        self.changed_at = Some(now);
    }

    pub(super) fn projection(
        &self,
        observation: &AgentRuntimeObservation,
    ) -> Option<AgentProgressProjection> {
        self.projection.clone().map(|mut p| {
            if observation.lifecycle != AgentRuntimeLifecycle::Running
                || observation.activity != AgentRuntimeActivity::Working
            {
                p.progress_unconfirmed = false;
            }
            p
        })
    }
}

impl TerminalReplay {
    pub(super) fn observe_progress(
        &mut self,
        report: Option<&AgentProgressReport>,
        now: Instant,
    ) -> Result<(), TerminalReplayError> {
        if let Some(report) = report {
            if !report.is_valid() {
                return Err(TerminalReplayError::InvalidAgentRuntimeState);
            }
            self.agent_progress.observe(report, now);
        }
        Ok(())
    }

    pub(super) fn expire_progress(
        &mut self,
        now: Instant,
    ) -> Result<Option<AgentRuntimeStateProjection>, TerminalReplayError> {
        let Some(current) = &self.agent_runtime_state else {
            return Ok(None);
        };
        let Some(progress) = &self.agent_progress.projection else {
            return Ok(None);
        };
        if current.lifecycle != AgentRuntimeLifecycle::Running
            || current.activity != AgentRuntimeActivity::Working
            || progress.report.phase != AgentProgressPhase::Thinking
            || progress.progress_unconfirmed
            || !self.agent_progress.changed_at.is_some_and(|at| {
                now.saturating_duration_since(at)
                    >= Duration::from_millis(progress.quiet_threshold_ms)
            })
        {
            return Ok(None);
        }
        // Check before mutation: overflow cannot leave a partially published state.
        current
            .revision
            .checked_add(1)
            .ok_or(TerminalReplayError::StateRevisionExhausted)?;
        let observation = AgentRuntimeObservation::new(
            current.lifecycle,
            current.activity,
            current.attention,
            current.source,
        );
        self.agent_progress
            .projection
            .as_mut()
            .unwrap()
            .progress_unconfirmed = true;
        self.fold_agent_runtime_observation(observation, false, false, now)
    }
}
