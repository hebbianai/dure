#[cfg(feature = "terminal-state-stream")]
use std::time::Duration;
use std::{borrow::Cow, fmt};

#[cfg(feature = "terminal-state-stream")]
use hmux_host::local_protocol::{
    AGENT_PROMPT_CAPABILITY, AgentPromptCapabilitySelection,
    LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
};
use hmux_host::local_protocol::{
    AgentRuntimeStateProjection, OperationReceiptReason, SessionFence,
};
use hmux_host::session_host::{SessionHost, SessionHostError};

#[cfg(any(windows, all(test, feature = "terminal-state-stream")))]
use crate::controller_input::SubmitScanner;
use crate::controller_input_effect::ControllerInputEffect;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum InputAdmission {
    Ordinary,
    #[cfg(feature = "terminal-state-stream")]
    AgentPrompt(ParsedAgentPromptAdmission),
    /// Automated body plus optional submit, admitted only while no
    /// unsubmitted controller draft is pending.
    #[cfg(feature = "terminal-state-stream")]
    DraftGuarded {
        wait: Duration,
    },
    /// Keys that answer one pending attention, admitted only while that
    /// attention is current and no key input reached the PTY since it was
    /// raised.
    #[cfg(feature = "terminal-state-stream")]
    AttentionResponse {
        expected_attention_id: String,
    },
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedAgentPromptAdmission {
    target: hmux_host::terminal_replay::AgentPromptTarget,
    wait: Duration,
    /// The prompt across its sender's retries, for the prompts unsent input
    /// holds back.
    key: hmux_host::terminal_replay::AgentPromptKey,
}

impl InputAdmission {
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn from_validated_structured(
        intent: &terminal_state_protocol::input_intent::Intent,
        agent_prompt_selection: Option<AgentPromptCapabilitySelection>,
        process_observed_agent_prompt: bool,
        host_provider_id: &str,
        draft_guarded_input: bool,
        attention_response_input: bool,
    ) -> Result<Self, &'static str> {
        use terminal_state_protocol::{agent_prompt_input_intent, input_intent};

        if let input_intent::Intent::AttentionResponse(response) = intent {
            // Never degrade to ordinary keys: an unnegotiated answer is an
            // authorization refusal, not unfenced input.
            return if attention_response_input {
                Ok(Self::AttentionResponse {
                    expected_attention_id: response.expected_attention_id.clone(),
                })
            } else {
                Err(hmux_runtime_contract::TERMINAL_ATTENTION_RESPONSE_INPUT_CAPABILITY)
            };
        }
        if let input_intent::Intent::DraftGuarded(guarded) = intent {
            // Never degrade to an ordinary write: an unnegotiated guard is an
            // authorization refusal, not an unguarded paste.
            return if draft_guarded_input {
                Ok(Self::DraftGuarded {
                    wait: Duration::from_millis(u64::from(guarded.admission_wait_ms)),
                })
            } else {
                Err(hmux_runtime_contract::TERMINAL_DRAFT_GUARDED_INPUT_CAPABILITY)
            };
        }
        let input_intent::Intent::AgentPrompt(prompt) = intent else {
            return Ok(Self::Ordinary);
        };
        let (target, wait) = match prompt.target.as_ref() {
            Some(agent_prompt_input_intent::Target::ProcessObservedFreshAgent(_))
                if agent_prompt_selection == Some(AgentPromptCapabilitySelection::Targeted)
                    && process_observed_agent_prompt =>
            {
                (
                    hmux_host::terminal_replay::AgentPromptTarget::ProcessObservedFreshAgent {
                        expected_provider_id: host_provider_id.to_string(),
                    },
                    Duration::from_millis(u64::from(prompt.admission_wait_ms)),
                )
            }
            Some(agent_prompt_input_intent::Target::FreshAgent(_))
                if agent_prompt_selection.is_some() =>
            {
                (
                    hmux_host::terminal_replay::AgentPromptTarget::FreshAgent,
                    Duration::from_millis(u64::from(prompt.admission_wait_ms)),
                )
            }
            Some(agent_prompt_input_intent::Target::FreshAgent(_)) => {
                return Err(AGENT_PROMPT_CAPABILITY);
            }
            Some(agent_prompt_input_intent::Target::ExistingConversation(target))
                if agent_prompt_selection == Some(AgentPromptCapabilitySelection::Targeted) =>
            {
                (
                    hmux_host::terminal_replay::AgentPromptTarget::ExistingConversation {
                        expected_provider_id: target.expected_provider_id.clone(),
                        expected_conversation_id: target.expected_conversation_id.clone(),
                    },
                    Duration::ZERO,
                )
            }
            Some(agent_prompt_input_intent::Target::ExistingConversation(_)) => {
                return Err(AGENT_PROMPT_CAPABILITY);
            }
            Some(agent_prompt_input_intent::Target::ProcessObservedFreshAgent(_)) => {
                return Err(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY);
            }
            None if agent_prompt_selection == Some(AgentPromptCapabilitySelection::LegacyFresh) => {
                (
                    hmux_host::terminal_replay::AgentPromptTarget::FreshAgent,
                    Duration::from_millis(u64::from(prompt.admission_wait_ms)),
                )
            }
            None => return Err(LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY),
        };
        Ok(Self::AgentPrompt(ParsedAgentPromptAdmission {
            target,
            wait,
            key: hmux_host::terminal_replay::AgentPromptKey::of(&prompt.utf8),
        }))
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn agent_prompt(
        &self,
    ) -> Option<(&hmux_host::terminal_replay::AgentPromptTarget, Duration)> {
        match self {
            Self::AgentPrompt(prompt) => Some((&prompt.target, prompt.wait)),
            Self::Ordinary | Self::DraftGuarded { .. } | Self::AttentionResponse { .. } => None,
        }
    }

    /// Names why an agent prompt was not written. An unsubmitted draft
    /// refuses a prompt to an existing conversation: say so, so the sender
    /// learns the agent reads its inbox once that input is submitted rather
    /// than that the provider runtime changed, and count the prompt among
    /// those the draft holds back. Returns the projection to publish when
    /// that count changed. A fresh prompt keeps its own reason: any earlier
    /// write has used its one-shot authority.
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn agent_prompt_refusal(
        &self,
        host: &mut SessionHost,
        fence: &SessionFence,
        reason: OperationReceiptReason,
    ) -> (OperationReceiptReason, Option<AgentRuntimeStateProjection>) {
        let Self::AgentPrompt(prompt) = self else {
            return (reason, None);
        };
        if reason != OperationReceiptReason::AgentRuntimeChanged
            || !matches!(
                prompt.target,
                hmux_host::terminal_replay::AgentPromptTarget::ExistingConversation { .. }
            )
            || !matches!(host.has_unsubmitted_controller_draft(fence), Ok(true))
        {
            return (reason, None);
        }
        // The refusal stands even if the presentation cannot be republished.
        let held = host.hold_agent_prompt(fence, prompt.key).ok().flatten();
        (OperationReceiptReason::UnsubmittedDraft, held)
    }

    /// Why this admission refuses before its first byte, read under the
    /// serialized PTY writer: a draft-guarded write finds a person's
    /// unsubmitted draft or an open question or approval prompt that its
    /// text would answer, or an attention response finds its attention
    /// answered or replaced. Agent prompts recheck their own authority.
    /// An open prompt refuses with the draft's reason: either way the
    /// terminal's input is the person's now, and the wire keeps one stable
    /// refusal that older clients already retry.
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn refusal_before_first_byte(
        &self,
        host: &SessionHost,
        fence: &SessionFence,
    ) -> Result<Option<OperationReceiptReason>, SessionHostError> {
        Ok(match self {
            Self::DraftGuarded { .. } => host
                .input_reserved_for_person(fence)?
                .then_some(OperationReceiptReason::UnsubmittedDraft),
            Self::AttentionResponse {
                expected_attention_id,
            } => (!host.attention_response_admitted(fence, expected_attention_id)?)
                .then_some(OperationReceiptReason::AttentionChanged),
            Self::Ordinary | Self::AgentPrompt(_) => None,
        })
    }

    /// The bounded Host wait for an unsubmitted draft, when this write is
    /// draft-guarded. Only the Unix Host waits; the Windows Host refuses at
    /// once and the client retries within its own budget.
    #[cfg(all(unix, feature = "terminal-state-stream"))]
    pub(crate) fn draft_guard_wait(&self) -> Option<Duration> {
        match self {
            Self::DraftGuarded { wait } => Some(*wait),
            Self::Ordinary | Self::AgentPrompt(_) | Self::AttentionResponse { .. } => None,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum PtyInput<'a> {
    Bytes(&'a [u8]),
    #[cfg(feature = "terminal-state-stream")]
    Structured(&'a terminal_state_protocol::InputIntent),
}

impl<'a> PtyInput<'a> {
    fn encode(
        self,
        _host: &mut SessionHost,
        _fence: &SessionFence,
    ) -> Result<Cow<'a, [u8]>, SessionHostError> {
        match self {
            Self::Bytes(bytes) => Ok(Cow::Borrowed(bytes)),
            #[cfg(feature = "terminal-state-stream")]
            Self::Structured(intent) => {
                Ok(Cow::Owned(_host.encode_structured_input(_fence, intent)?))
            }
        }
    }
}

pub(crate) struct InputTransaction {
    pub(crate) outcome: InputTransactionOutcome,
    pub(crate) runtime_state: Option<AgentRuntimeStateProjection>,
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) admitted_agent_runtime_revision: Option<u64>,
}

/// The provider-neutral result of one serialized PTY mutation attempt.
/// `NotWritten` includes failures with a proven zero-byte writer prefix;
/// `Failed` means at least one byte reached the PTY.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InputTransactionOutcome {
    Written,
    NotWritten(OperationReceiptReason),
    Failed(OperationReceiptReason),
}

impl InputTransactionOutcome {
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn is_written(self) -> bool {
        self == Self::Written
    }
}

pub(crate) struct PtyWriteOutcome {
    bytes_written: usize,
    outcome: Result<(), OperationReceiptReason>,
    pending: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InputTransactionFailurePhase {
    BeforeWrite,
    AfterWrite,
}

/// Preserves the only boundary that matters when projecting a failed input
/// operation into a receipt: whether the PTY may already have changed.
#[derive(Debug)]
pub(crate) struct InputTransactionFailure {
    phase: InputTransactionFailurePhase,
    source: SessionHostError,
}

impl InputTransactionFailure {
    fn before_write(source: SessionHostError) -> Self {
        Self {
            phase: InputTransactionFailurePhase::BeforeWrite,
            source,
        }
    }

    fn after_write(source: SessionHostError) -> Self {
        Self {
            phase: InputTransactionFailurePhase::AfterWrite,
            source,
        }
    }

    pub(crate) fn may_have_written(&self) -> bool {
        self.phase == InputTransactionFailurePhase::AfterWrite
    }

    pub(crate) fn operation_reason(&self) -> OperationReceiptReason {
        input_operation_reason(&self.source)
    }

    pub(crate) fn detail(&self) -> Option<String> {
        input_operation_detail(&self.source)
    }

    pub(crate) fn outcome(&self) -> InputTransactionOutcome {
        if self.may_have_written() {
            InputTransactionOutcome::Failed(self.operation_reason())
        } else {
            InputTransactionOutcome::NotWritten(self.operation_reason())
        }
    }
}

impl fmt::Display for InputTransactionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.source, formatter)
    }
}

impl std::error::Error for InputTransactionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

pub(crate) fn input_operation_reason(error: &SessionHostError) -> OperationReceiptReason {
    match error {
        SessionHostError::StaleControllerGeneration => {
            OperationReceiptReason::StaleControllerGeneration
        }
        SessionHostError::SessionExited | SessionHostError::FenceMismatch => {
            OperationReceiptReason::HostExiting
        }
        _ => OperationReceiptReason::ResourceLimit,
    }
}

/// The bounded failure class behind a `ResourceLimit` refusal. The wire
/// reason enum is closed, so every Host failure it cannot name collapses to
/// that catch-all; the detail carries the exact class so the real cause
/// reaches the client instead of a misleading "resource limit". Reasons the
/// enum names exactly carry no detail.
pub(crate) fn input_operation_detail(error: &SessionHostError) -> Option<String> {
    match input_operation_reason(error) {
        OperationReceiptReason::ResourceLimit => Some(error.failure_class().into_owned()),
        _ => None,
    }
}

impl PtyWriteOutcome {
    pub(crate) fn from_progress(
        expected_bytes: usize,
        bytes_written: usize,
        outcome: Result<(), OperationReceiptReason>,
    ) -> Self {
        let exact_write = bytes_written == expected_bytes;
        let bytes_written = bytes_written.min(expected_bytes);
        let outcome = match outcome {
            Ok(()) if exact_write => Ok(()),
            Ok(()) => Err(OperationReceiptReason::PtyWriteFailed),
            Err(reason) => Err(reason),
        };
        Self {
            bytes_written,
            outcome,
            pending: false,
        }
    }
}

mod prepared;
pub(crate) use prepared::{InputStep, PreparedInput};

/// Windows supplies one complete blocking write; Unix advances the same
/// transaction in nonblocking steps without retaining Host state while waiting.
#[cfg(any(windows, all(test, feature = "terminal-state-stream")))]
pub(crate) fn apply_input_transaction(
    host: &mut SessionHost,
    fence: &SessionFence,
    scanner: &mut SubmitScanner,
    input: PtyInput<'_>,
    input_effect: ControllerInputEffect,
    admission: InputAdmission,
    write: impl FnOnce(&[u8]) -> PtyWriteOutcome,
) -> Result<InputTransaction, InputTransactionFailure> {
    let mut prepared = PreparedInput::new(host, fence, input, input_effect, admission)?;
    match prepared.advance(host, fence, scanner, write)? {
        InputStep::Complete(transaction) => Ok(transaction),
        InputStep::Pending(_runtime_state) => {
            unreachable!("a synchronous writer must report completion")
        }
    }
}

#[cfg(test)]
mod failure_phase_tests {
    use super::*;
    use hmux_host::terminal_replay::TerminalReplayError;

    #[test]
    fn unnamed_host_failures_keep_their_class_behind_the_catch_all_reason() {
        let engine = SessionHostError::TerminalReplay(TerminalReplayError::TerminalEngineFailure {
            operation: "encode key",
            code: -1,
        });
        assert_eq!(
            input_operation_reason(&engine),
            OperationReceiptReason::ResourceLimit
        );
        assert_eq!(
            input_operation_detail(&engine).as_deref(),
            Some("replay_engine_failure_neg1_encode_key")
        );
        assert_eq!(
            InputTransactionFailure::before_write(SessionHostError::TerminalReplay(
                TerminalReplayError::InvalidStructuredInput
            ))
            .detail()
            .as_deref(),
            Some("replay_invalid_structured_input")
        );
        assert_eq!(
            input_operation_detail(&SessionHostError::ProviderStillRunning).as_deref(),
            Some("provider_still_running")
        );
    }

    #[test]
    fn honestly_named_refusals_carry_no_detail() {
        for error in [
            SessionHostError::StaleControllerGeneration,
            SessionHostError::SessionExited,
            SessionHostError::FenceMismatch,
        ] {
            assert_ne!(
                input_operation_reason(&error),
                OperationReceiptReason::ResourceLimit
            );
            assert_eq!(input_operation_detail(&error), None, "{error}");
        }
    }

    #[test]
    fn identical_host_failure_preserves_write_certainty() {
        let before = InputTransactionFailure::before_write(SessionHostError::SessionExited);
        let after = InputTransactionFailure::after_write(SessionHostError::SessionExited);

        assert_eq!(
            before.operation_reason(),
            OperationReceiptReason::HostExiting
        );
        assert!(!before.may_have_written());
        assert_eq!(
            after.operation_reason(),
            OperationReceiptReason::HostExiting
        );
        assert!(after.may_have_written());
    }

    #[test]
    fn stale_controller_failure_is_preserved_as_a_definite_non_write() {
        let failure =
            InputTransactionFailure::before_write(SessionHostError::StaleControllerGeneration);

        assert_eq!(
            failure.operation_reason(),
            OperationReceiptReason::StaleControllerGeneration
        );
        assert!(!failure.may_have_written());
    }
}

#[cfg(all(test, feature = "terminal-state-stream"))]
mod tests;
