#[cfg(unix)]
use std::io;

use super::*;
use crate::controller_input::{SubmitScanner, fold_written_input_prefix};

/// Encodes once and retains exact delivery progress across PTY readiness waits.
/// The caller serializes whole input frames, but holds the Host only for each
/// nonblocking write and its corresponding semantic commit.
pub(crate) struct PreparedInput<'a> {
    encoded: Cow<'a, [u8]>,
    written: usize,
    effect: ControllerInputEffect,
    admission: InputAdmission,
    #[cfg(feature = "terminal-state-stream")]
    admitted_revision: Option<u64>,
}

pub(crate) enum InputStep {
    Pending(Option<AgentRuntimeStateProjection>),
    Complete(InputTransaction),
}

impl<'a> PreparedInput<'a> {
    pub(crate) fn new(
        host: &mut SessionHost,
        fence: &SessionFence,
        input: PtyInput<'a>,
        effect: ControllerInputEffect,
        admission: InputAdmission,
    ) -> Result<Self, InputTransactionFailure> {
        Ok(Self {
            encoded: input
                .encode(host, fence)
                .map_err(InputTransactionFailure::before_write)?,
            written: 0,
            effect,
            admission,
            #[cfg(feature = "terminal-state-stream")]
            admitted_revision: None,
        })
    }

    #[cfg(unix)]
    pub(crate) fn bytes_written(&self) -> usize {
        self.written
    }

    pub(crate) fn failure(&self, reason: OperationReceiptReason) -> InputTransactionOutcome {
        if self.written == 0 {
            InputTransactionOutcome::NotWritten(reason)
        } else {
            InputTransactionOutcome::Failed(if reason == OperationReceiptReason::HostExiting {
                OperationReceiptReason::PtyWriteFailed
            } else {
                reason
            })
        }
    }

    #[cfg(all(unix, feature = "terminal-state-stream"))]
    pub(crate) fn admitted_revision(&self) -> Option<u64> {
        self.admitted_revision
    }

    pub(crate) fn advance(
        &mut self,
        host: &mut SessionHost,
        fence: &SessionFence,
        scanner: &mut SubmitScanner,
        write: impl FnOnce(&[u8]) -> PtyWriteOutcome,
    ) -> Result<InputStep, InputTransactionFailure> {
        #[cfg(feature = "terminal-state-stream")]
        let prepared_revision = if self.written == 0 {
            if let Some((target, _)) = self.admission.agent_prompt() {
                let Some(revision) = host
                    .prepare_agent_prompt(fence, target)
                    .map_err(InputTransactionFailure::before_write)?
                else {
                    return Ok(InputStep::Complete(InputTransaction {
                        outcome: self.failure(OperationReceiptReason::AgentRuntimeChanged),
                        runtime_state: None,
                        admitted_agent_runtime_revision: None,
                    }));
                };
                Some(revision)
            } else {
                None
            }
        } else {
            self.admitted_revision
        };
        #[cfg(not(feature = "terminal-state-stream"))]
        let _ = &self.admission;

        let progress = write(&self.encoded[self.written..]);
        let start = self.written;
        self.written += progress.bytes_written;
        let prefix = &self.encoded[start..self.written];
        #[cfg(feature = "terminal-state-stream")]
        if !prefix.is_empty() {
            self.admitted_revision = prepared_revision;
        }
        let runtime_state = if self.effect.retains_pending_draft() && !prefix.is_empty() {
            fold_written_input_prefix(host, fence, scanner, prefix, start > 0)
                .map_err(InputTransactionFailure::after_write)?
        } else {
            if !prefix.is_empty() {
                host.record_controller_write(fence)
                    .map_err(InputTransactionFailure::after_write)?;
            }
            None
        };
        if progress.pending {
            return Ok(InputStep::Pending(runtime_state));
        }
        Ok(InputStep::Complete(InputTransaction {
            outcome: match progress.outcome {
                Ok(()) => InputTransactionOutcome::Written,
                Err(reason) => self.failure(reason),
            },
            runtime_state,
            #[cfg(feature = "terminal-state-stream")]
            admitted_agent_runtime_revision: self.admitted_revision,
        }))
    }
}

impl PtyWriteOutcome {
    /// One nonblocking attempt, never a readiness wait under the Host lock.
    #[cfg(unix)]
    pub(crate) fn nonblocking(expected: usize, outcome: io::Result<usize>) -> Self {
        match outcome {
            Ok(count) if count > 0 && count < expected => Self {
                bytes_written: count,
                outcome: Ok(()),
                pending: true,
            },
            Ok(count) if count == expected => Self::from_progress(expected, count, Ok(())),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Self {
                    bytes_written: 0,
                    outcome: Ok(()),
                    pending: true,
                }
            }
            Ok(count) => {
                Self::from_progress(expected, count, Err(OperationReceiptReason::PtyWriteFailed))
            }
            Err(_) => Self::from_progress(expected, 0, Err(OperationReceiptReason::PtyWriteFailed)),
        }
    }
}
