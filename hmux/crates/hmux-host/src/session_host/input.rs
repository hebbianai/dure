use super::{ProviderEpoch, SessionHost, SessionHostError};
use crate::local_protocol::{AgentRuntimeStateProjection, SessionFence};
use crate::terminal_replay::ControllerDraftEdit;

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

    /// Records one accepted edit of the person's unsubmitted line. Typed
    /// characters are counted and Backspaces count against them, so a draft
    /// that was typed and then erased again stops refusing draft-guarded
    /// automation and inbox wakes without waiting for an Enter.
    pub fn record_controller_draft_edit(
        &mut self,
        expected_fence: &SessionFence,
        edit: ControllerDraftEdit,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.record_controller_draft_edit(edit);
        Ok(())
    }

    /// Reports whether accepted draft-capable controller input still awaits a
    /// submit. Draft-guarded automation reads this under the serialized PTY
    /// writer before its first byte, so no keystroke can interleave.
    pub fn has_unsubmitted_controller_draft(
        &self,
        expected_fence: &SessionFence,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.has_unsubmitted_controller_draft())
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
