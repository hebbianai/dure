use hmux_host::local_protocol::{InputReceiptState, OperationReceiptReason};
#[cfg(feature = "terminal-state-stream")]
use terminal_state_protocol::{
    InputFailed, InputFailureReason, InputReceipt, InputRefusalReason, InputRefused,
    InputWrittenToPty, input_receipt,
};

use crate::input_transaction::InputTransactionOutcome;

pub(crate) fn classic_outcome(
    outcome: InputTransactionOutcome,
) -> (InputReceiptState, Option<OperationReceiptReason>) {
    match outcome {
        InputTransactionOutcome::Written => (InputReceiptState::WrittenToPty, None),
        InputTransactionOutcome::NotWritten(
            reason @ OperationReceiptReason::StaleControllerGeneration,
        ) => (InputReceiptState::Revoked, Some(reason)),
        // The legacy receipt has no distinct before-delivery write-failure
        // variant. Keep its wire shape conservative while Host state remains
        // unchanged and retryable under the serialized transaction contract.
        InputTransactionOutcome::NotWritten(reason @ OperationReceiptReason::PtyWriteFailed) => {
            (InputReceiptState::Failed, Some(reason))
        }
        InputTransactionOutcome::NotWritten(reason) => (InputReceiptState::Refused, Some(reason)),
        InputTransactionOutcome::Failed(reason) => (InputReceiptState::Failed, Some(reason)),
    }
}

#[cfg(feature = "terminal-state-stream")]
pub(crate) fn written(
    record_id: u64,
    input_baseline_output_sequence: u64,
    agent_runtime_revision: Option<u64>,
) -> InputReceipt {
    InputReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
            input_baseline_output_sequence: Some(input_baseline_output_sequence),
            agent_runtime_revision,
        })),
    }
}

#[cfg(feature = "terminal-state-stream")]
pub(crate) fn refused(
    record_id: u64,
    reason: InputRefusalReason,
    detail: Option<String>,
) -> InputReceipt {
    InputReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(input_receipt::Outcome::Refused(InputRefused {
            reason: reason as i32,
            detail,
        })),
    }
}

/// `detail` is the bounded failure class behind a catch-all reason; it is
/// only forwarded with `ResourceLimit`, the one wire reason that hides its
/// underlying cause.
#[cfg(feature = "terminal-state-stream")]
pub(crate) fn not_written(
    record_id: u64,
    reason: OperationReceiptReason,
    detail: Option<String>,
) -> InputReceipt {
    match reason {
        OperationReceiptReason::HostExiting => {
            refused(record_id, InputRefusalReason::HostExiting, None)
        }
        OperationReceiptReason::AuthorizationDenied
        | OperationReceiptReason::ControllerConflict
        | OperationReceiptReason::StaleControllerGeneration => {
            refused(record_id, InputRefusalReason::AuthorizationDenied, None)
        }
        OperationReceiptReason::InputTooLarge => {
            refused(record_id, InputRefusalReason::InputTooLarge, None)
        }
        OperationReceiptReason::AgentRuntimeChanged => {
            refused(record_id, InputRefusalReason::AgentRuntimeChanged, None)
        }
        OperationReceiptReason::ResourceLimit => {
            refused(record_id, InputRefusalReason::ResourceLimit, detail)
        }
        OperationReceiptReason::PtyWriteFailed
        | OperationReceiptReason::InvalidTerminalDimensions
        | OperationReceiptReason::PlatformResizeFailed => {
            failed(record_id, OperationReceiptReason::PtyWriteFailed, None)
        }
    }
}

/// An after-write failure: at least one byte reached the PTY. `HostExiting`
/// and the catch-all keep their own wire reason; everything else is the
/// PTY write itself. `detail` travels only with the catch-all.
#[cfg(feature = "terminal-state-stream")]
pub(crate) fn failed(
    record_id: u64,
    reason: OperationReceiptReason,
    detail: Option<String>,
) -> InputReceipt {
    let (reason, detail) = match reason {
        OperationReceiptReason::HostExiting => (InputFailureReason::HostExiting, None),
        OperationReceiptReason::ResourceLimit => (InputFailureReason::ResourceLimit, detail),
        _ => (InputFailureReason::PtyWriteFailed, None),
    };
    InputReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(input_receipt::Outcome::Failed(InputFailed {
            reason: reason as i32,
            detail,
        })),
    }
}

#[cfg(all(test, feature = "terminal-state-stream"))]
mod tests {
    use super::*;

    #[test]
    fn zero_byte_pty_failure_is_not_misreported_as_authorization_refusal() {
        let receipt = not_written(7, OperationReceiptReason::PtyWriteFailed, None);

        assert!(matches!(
            receipt.outcome,
            Some(input_receipt::Outcome::Failed(InputFailed { reason, detail: None }))
                if reason == InputFailureReason::PtyWriteFailed as i32
        ));
        assert_eq!(
            classic_outcome(InputTransactionOutcome::NotWritten(
                OperationReceiptReason::PtyWriteFailed,
            )),
            (
                InputReceiptState::Failed,
                Some(OperationReceiptReason::PtyWriteFailed),
            )
        );
    }

    #[test]
    fn host_refusals_keep_their_bounded_wire_reason() {
        for (operation, expected) in [
            (
                OperationReceiptReason::HostExiting,
                InputRefusalReason::HostExiting,
            ),
            (
                OperationReceiptReason::InputTooLarge,
                InputRefusalReason::InputTooLarge,
            ),
            (
                OperationReceiptReason::ResourceLimit,
                InputRefusalReason::ResourceLimit,
            ),
            (
                OperationReceiptReason::AgentRuntimeChanged,
                InputRefusalReason::AgentRuntimeChanged,
            ),
        ] {
            let receipt = not_written(11, operation, None);
            assert!(matches!(
                receipt.outcome,
                Some(input_receipt::Outcome::Refused(InputRefused { reason, detail: None }))
                    if reason == expected as i32
            ));
        }
    }

    #[test]
    fn after_write_failures_keep_their_own_wire_reason() {
        let receipt = failed(
            21,
            OperationReceiptReason::ResourceLimit,
            Some("replay_sequence_exhausted".to_string()),
        );
        assert!(matches!(
            receipt.outcome,
            Some(input_receipt::Outcome::Failed(InputFailed { reason, detail: Some(detail) }))
                if reason == InputFailureReason::ResourceLimit as i32
                    && detail == "replay_sequence_exhausted"
        ));
        let receipt = failed(22, OperationReceiptReason::HostExiting, None);
        assert!(matches!(
            receipt.outcome,
            Some(input_receipt::Outcome::Failed(InputFailed { reason, detail: None }))
                if reason == InputFailureReason::HostExiting as i32
        ));
        let receipt = failed(23, OperationReceiptReason::PtyWriteFailed, Some("x".into()));
        assert!(matches!(
            receipt.outcome,
            Some(input_receipt::Outcome::Failed(InputFailed { reason, detail: None }))
                if reason == InputFailureReason::PtyWriteFailed as i32
        ));
    }

    #[test]
    fn catch_all_refusal_carries_its_failure_class_and_honest_reasons_do_not() {
        let receipt = not_written(
            13,
            OperationReceiptReason::ResourceLimit,
            Some("replay_engine_failure_neg1_encode_key".to_string()),
        );
        assert!(matches!(
            receipt.outcome,
            Some(input_receipt::Outcome::Refused(InputRefused { reason, detail: Some(detail) }))
                if reason == InputRefusalReason::ResourceLimit as i32
                    && detail == "replay_engine_failure_neg1_encode_key"
        ));

        let receipt = not_written(
            14,
            OperationReceiptReason::HostExiting,
            Some("must_not_leak".to_string()),
        );
        assert!(matches!(
            receipt.outcome,
            Some(input_receipt::Outcome::Refused(InputRefused {
                detail: None,
                ..
            }))
        ));
    }
}
