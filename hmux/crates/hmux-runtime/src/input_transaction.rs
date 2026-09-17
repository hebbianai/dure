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
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedAgentPromptAdmission {
    target: hmux_host::terminal_replay::AgentPromptTarget,
    wait: Duration,
}

impl InputAdmission {
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn from_validated_structured(
        intent: &terminal_state_protocol::input_intent::Intent,
        agent_prompt_selection: Option<AgentPromptCapabilitySelection>,
        process_observed_agent_prompt: bool,
        host_provider_id: &str,
    ) -> Result<Self, &'static str> {
        use terminal_state_protocol::{agent_prompt_input_intent, input_intent};

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
        }))
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn agent_prompt(
        &self,
    ) -> Option<(&hmux_host::terminal_replay::AgentPromptTarget, Duration)> {
        match self {
            Self::AgentPrompt(prompt) => Some((&prompt.target, prompt.wait)),
            Self::Ordinary => None,
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
