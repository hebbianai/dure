use super::{ProviderEpoch, SessionHost, SessionHostError};
use crate::local_protocol::{AgentRuntimeStateProjection, SessionFence};

impl SessionHost {
    /// Consumes fresh-prompt authority after a controller-to-PTY operation may
    /// have changed the terminal, without classifying control-only bytes as a
    /// pending draft.
    pub fn record_controller_write(
        &mut self,
        expected_fence: &SessionFence,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.record_controller_write();
        Ok(())
    }

    /// Marks a successful draft-capable controller-to-PTY write as user-owned
    /// runtime state. Submission and provider acknowledgement are separate,
    /// so automatic idle replacement cannot discard an unsubmitted draft or
    /// incomplete interaction that has no corresponding output delta.
    pub fn record_controller_input(
        &mut self,
        expected_fence: &SessionFence,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.record_controller_input();
        Ok(())
    }

    /// Observes whether the Host should wait for provider-event startup,
    /// proceed to the serialized PTY cut, or refuse this attempt.
    pub fn agent_prompt_admission(
        &self,
        expected_fence: &SessionFence,
        target: &crate::terminal_replay::AgentPromptTarget,
    ) -> Result<crate::terminal_replay::AgentPromptAdmission, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.agent_prompt_admission(target))
    }

    /// Rechecks one agent prompt under the caller's serialized PTY mutation
    /// lock without changing Host state. The written prefix commits all input
    /// effects after the writer returns.
    pub fn prepare_agent_prompt(
        &self,
        expected_fence: &SessionFence,
        target: &crate::terminal_replay::AgentPromptTarget,
    ) -> Result<Option<u64>, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.prepare_agent_prompt(target))
    }

    /// Commits an accepted Enter without replacing semantic provider activity.
    pub fn record_controller_submit(
        &mut self,
        expected_fence: &SessionFence,
    ) -> Result<Option<AgentRuntimeStateProjection>, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay
            .record_controller_submit()
            .map_err(SessionHostError::from)
    }
}
