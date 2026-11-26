use std::time::{SystemTime, UNIX_EPOCH};

use super::{ProviderEpoch, SessionHost, SessionHostError};
use crate::local_protocol::{AgentRuntimeStateProjection, SessionFence};
use crate::terminal_replay::{AgentPromptKey, ControllerDraftEdit};

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
    /// automation and inbox wakes without waiting for an Enter. Returns the
    /// projection to publish when that releases held agent prompts.
    pub fn record_controller_draft_edit(
        &mut self,
        expected_fence: &SessionFence,
        edit: ControllerDraftEdit,
    ) -> Result<Option<AgentRuntimeStateProjection>, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay
            .record_controller_draft_edit(edit)
            .map_err(SessionHostError::from)
    }

    /// Records that the person's unsent input refused an agent prompt to the
    /// running conversation, so the pane and session listings can say how
    /// many prompts it holds and since when. Returns the projection to
    /// publish when that count changed.
    pub fn hold_agent_prompt(
        &mut self,
        expected_fence: &SessionFence,
        prompt: AgentPromptKey,
    ) -> Result<Option<AgentRuntimeStateProjection>, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        let now_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        replay
            .hold_agent_prompt(prompt, now_unix_ms)
            .map_err(SessionHostError::from)
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

    /// Reports whether draft-guarded automation must leave the terminal to
    /// its person: they have an unsubmitted draft, or the provider reports an
    /// open question or approval prompt that typed text would answer. Read
    /// under the serialized PTY writer before the first byte, like the draft.
    pub fn input_reserved_for_person(
        &self,
        expected_fence: &SessionFence,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.has_unsubmitted_controller_draft() || replay.has_open_provider_prompt())
    }

    /// Records a bare Escape that reached the PTY. During a provider-reported
    /// working turn it is the only sign of a person interrupting that turn,
    /// so the Host admits agent prompts while the pane stays busy for idle
    /// replacement, account switches and hibernation.
    pub fn record_controller_interrupt_request(
        &mut self,
        expected_fence: &SessionFence,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.record_controller_interrupt_request();
        Ok(())
    }

    /// Reports whether a bare Escape reached a provider-reported working turn
    /// that no later provider report or accepted submit has superseded.
    pub fn has_interrupt_request(
        &self,
        expected_fence: &SessionFence,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.has_interrupt_request())
    }

    /// Records that controller key input reached the PTY, so an attention it
    /// may have answered admits no attention response any more.
    pub fn record_controller_key_input(
        &mut self,
        expected_fence: &SessionFence,
    ) -> Result<(), SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &mut self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        replay.record_controller_key_input();
        Ok(())
    }

    /// Rechecks one attention response under the caller's serialized PTY
    /// writer: the attention it names is current and unanswered.
    pub fn attention_response_admitted(
        &self,
        expected_fence: &SessionFence,
        expected_attention_id: &str,
    ) -> Result<bool, SessionHostError> {
        let ProviderEpoch::Running { replay, .. } = &self.current else {
            return Err(SessionHostError::SessionExited);
        };
        expected_fence
            .ensure_matches(replay.fence())
            .map_err(|_| SessionHostError::FenceMismatch)?;
        Ok(replay.attention_response_admitted(expected_attention_id))
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
