use std::sync::atomic::Ordering;

use hmux_host::local_protocol::{FrameBody, OperationReceiptReason};

use crate::controller_input_effect::ControllerInputEffect;
pub(crate) use crate::input_transaction::{InputAdmission, PtyInput};
use crate::input_transaction::{
    InputStep, InputTransactionOutcome, PreparedInput, PtyWriteOutcome, input_operation_detail,
    input_operation_reason,
};

use super::{Result, ServerState, lock, lock_pty_writer_preserving_liveness};

pub(crate) struct InputApplication {
    pub(crate) controller_generation: u64,
    pub(crate) outcome: InputTransactionOutcome,
    /// Bounded failure-class token behind a catch-all wire reason; `None`
    /// whenever the wire reason already names the exact cause.
    pub(crate) detail: Option<String>,
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) input_baseline_output_sequence: Option<u64>,
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) admitted_agent_runtime_revision: Option<u64>,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Copy)]
pub(crate) struct InputTimingCorrelation {
    pub(crate) client_id: u64,
    pub(crate) record_id: u64,
}

/// Applies both legacy JSON and structured input through one PTY mutation
/// authority. This module is intentionally release-dark capable: control-only
/// and legacy clients still write input when terminal-state-stream is absent.
pub(crate) fn apply_pty_input(
    state: &ServerState,
    input: PtyInput<'_>,
    input_effect: ControllerInputEffect,
    admission: InputAdmission,
    requested_controller_generation: Option<u64>,
    #[cfg(feature = "terminal-state-stream")] timing_correlation: Option<InputTimingCorrelation>,
    #[cfg(not(feature = "terminal-state-stream"))] _timing_correlation: Option<()>,
) -> Result<InputApplication> {
    #[cfg(feature = "terminal-state-stream")]
    if let Some((target, wait)) = admission.agent_prompt() {
        use hmux_host::terminal_replay::AgentPromptAdmission;

        let waited = state.agent_prompt_admission.wait(wait, || {
            if state.termination_requested.load(Ordering::Acquire)
                || state.provider_exit_observed.load(Ordering::Acquire)
            {
                return Ok(AgentPromptAdmission::Refused);
            }
            let host = lock(&state.host)?;
            Ok(host
                .agent_prompt_admission(&state.fence, target)
                .unwrap_or(AgentPromptAdmission::Refused))
        })?;
        if waited != crate::agent_prompt_admission::AgentPromptWaitOutcome::Ready {
            let host = lock(&state.host)?;
            let host_exiting = state.termination_requested.load(Ordering::Acquire)
                || state.provider_exit_observed.load(Ordering::Acquire)
                || matches!(
                    host.agent_prompt_admission(&state.fence, target),
                    Err(hmux_host::session_host::SessionHostError::SessionExited
                        | hmux_host::session_host::SessionHostError::FenceMismatch)
                );
            let reason = waited
                .not_written_reason(host_exiting)
                .expect("a non-ready wait must have a refusal reason");
            let controller_generation = host.controller_generation();
            return Ok(InputApplication {
                controller_generation,
                outcome: InputTransactionOutcome::NotWritten(reason),
                detail: None,
                input_baseline_output_sequence: None,
                admitted_agent_runtime_revision: None,
            });
        }
    }

    let _input = lock_pty_writer_preserving_liveness(&state.pty_input_serial, "input frame");
    let mut prepared: Option<PreparedInput<'_>> = None;
    let mut mutation_generation = requested_controller_generation;
    loop {
        let mut writer = lock_pty_writer_preserving_liveness(&state.pty_writer, "input");
        let mut host = lock(&state.host)?;
        let controller_generation = host.controller_generation();
        let generation = *mutation_generation.get_or_insert(controller_generation);
        let refusal = if state.termination_requested.load(Ordering::Acquire)
            || state.provider_exit_observed.load(Ordering::Acquire)
        {
            Some((OperationReceiptReason::HostExiting, None))
        } else {
            host.admit_mutation(&state.fence, generation)
                .err()
                .map(|error| (input_operation_reason(&error), input_operation_detail(&error)))
        };
        if let Some((reason, detail)) = refusal {
            return Ok(failed_application(
                controller_generation,
                prepared.as_ref(),
                reason,
                detail,
            ));
        }
        // Previously generated replies precede the first byte of a later frame.
        // Replies generated during a partial frame wait behind that frame.
        if prepared
            .as_ref()
            .is_none_or(|input| input.bytes_written() == 0)
        {
            match writer.flush_replies() {
                Ok(true) => {}
                Ok(false) => {
                    drop(host);
                    drop(writer);
                    if wait_for_pty_input(state).is_err() {
                        return Ok(failed_application(
                            controller_generation,
                            prepared.as_ref(),
                            OperationReceiptReason::PtyWriteFailed,
                            None,
                        ));
                    }
                    continue;
                }
                Err(_) => {
                    return Ok(failed_application(
                        controller_generation,
                        prepared.as_ref(),
                        OperationReceiptReason::PtyWriteFailed,
                        None,
                    ));
                }
            }
        }
        if prepared.is_none() {
            prepared = Some(
                match PreparedInput::new(
                    &mut host,
                    &state.fence,
                    input,
                    input_effect,
                    admission.clone(),
                ) {
                    Ok(prepared) => prepared,
                    Err(failure) => {
                        return Ok(failed_application(
                            controller_generation,
                            None,
                            failure.operation_reason(),
                            failure.detail(),
                        ));
                    }
                },
            );
        }
        let prepared = prepared
            .as_mut()
            .expect("input was prepared under the I/O lock");
        let step = {
            let mut scanner = lock(&state.controller_submit)?;
            prepared.advance(&mut host, &state.fence, &mut scanner, |bytes| {
                PtyWriteOutcome::nonblocking(bytes.len(), writer.write_input(bytes))
            })
        };
        #[cfg(feature = "terminal-state-stream")]
        state.agent_prompt_admission.notify();
        let (transaction, runtime_state) = match step {
            Ok(InputStep::Pending(runtime_state)) => (None, runtime_state),
            Ok(InputStep::Complete(mut transaction)) => {
                let runtime_state = transaction.runtime_state.take();
                (Some(transaction), runtime_state)
            }
            Err(failure) => {
                return Ok(failure_projection(
                    controller_generation,
                    Some(prepared),
                    failure.outcome(),
                    failure.detail(),
                ));
            }
        };
        #[cfg(feature = "terminal-state-stream")]
        let input_baseline_output_sequence = transaction
            .as_ref()
            .filter(|transaction| transaction.outcome.is_written())
            .map(|_| host.current_output_seq());
        #[cfg(feature = "terminal-state-stream")]
        if let Some(baseline) = input_baseline_output_sequence
            .filter(|_| input_effect.retains_pending_draft() && prepared.bytes_written() > 0)
        {
            state.viewport_publication.arm_next_output_after_input(
                baseline,
                std::time::Instant::now(),
                timing_correlation,
            );
        }
        let application = transaction.map(|transaction| InputApplication {
            controller_generation,
            outcome: transaction.outcome,
            detail: None,
            #[cfg(feature = "terminal-state-stream")]
            input_baseline_output_sequence,
            #[cfg(feature = "terminal-state-stream")]
            admitted_agent_runtime_revision: transaction.admitted_agent_runtime_revision,
        });
        if let Some(runtime_state) = runtime_state {
            let _publish_order = lock(&state.publish_order)?;
            drop(host);
            drop(writer);
            state.broadcast_ordered(FrameBody::AgentRuntimeState(runtime_state));
        } else {
            drop(host);
            drop(writer);
        }
        if let Some(application) = application {
            return Ok(application);
        }
        // Only whole-frame ordering is retained while waiting: output, resize,
        // exact observation and termination are free to acquire their locks.
        if wait_for_pty_input(state).is_err() {
            return Ok(failed_application(
                controller_generation,
                Some(prepared),
                OperationReceiptReason::PtyWriteFailed,
                None,
            ));
        }
    }
}

fn wait_for_pty_input(state: &ServerState) -> std::io::Result<()> {
    match super::poll_fd(
        state.pty_fd,
        libc::POLLOUT,
        std::time::Duration::from_millis(20),
    ) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => Ok(()),
        Err(error) => Err(error),
    }
}

fn failed_application(
    controller_generation: u64,
    prepared: Option<&PreparedInput<'_>>,
    reason: OperationReceiptReason,
    detail: Option<String>,
) -> InputApplication {
    failure_projection(
        controller_generation,
        prepared,
        prepared.map_or(InputTransactionOutcome::NotWritten(reason), |input| {
            input.failure(reason)
        }),
        detail,
    )
}

fn failure_projection(
    controller_generation: u64,
    prepared: Option<&PreparedInput<'_>>,
    outcome: InputTransactionOutcome,
    detail: Option<String>,
) -> InputApplication {
    #[cfg(not(feature = "terminal-state-stream"))]
    let _ = prepared;
    InputApplication {
        controller_generation,
        outcome,
        detail,
        #[cfg(feature = "terminal-state-stream")]
        input_baseline_output_sequence: None,
        #[cfg(feature = "terminal-state-stream")]
        admitted_agent_runtime_revision: prepared.and_then(PreparedInput::admitted_revision),
    }
}
