use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use hmux_host::local_protocol::OperationReceiptReason;
use hmux_host::terminal_replay::AgentPromptAdmission;

use crate::Result;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentPromptWaitOutcome {
    Ready,
    Refused,
    TimedOut,
}

impl AgentPromptWaitOutcome {
    pub(crate) fn not_written_reason(self, host_exiting: bool) -> Option<OperationReceiptReason> {
        match self {
            Self::Ready => None,
            Self::Refused | Self::TimedOut => Some(if host_exiting {
                OperationReceiptReason::HostExiting
            } else {
                OperationReceiptReason::AgentRuntimeChanged
            }),
        }
    }
}

/// Wake coordination for Host-owned agent-prompt readiness. The revision is
/// deliberately not readiness state; every observation is re-derived from the
/// authoritative SessionHost while holding its own lock.
#[derive(Default)]
struct AgentPromptAdmissionState {
    revision: u64,
    in_flight_publications: usize,
    sealed: bool,
}

#[derive(Default)]
pub(crate) struct AgentPromptAdmissionSignal {
    state: Mutex<AgentPromptAdmissionState>,
    changed: Condvar,
}

pub(crate) struct AgentPromptPublicationPermit<'a> {
    signal: &'a AgentPromptAdmissionSignal,
}

impl Drop for AgentPromptPublicationPermit<'_> {
    fn drop(&mut self) {
        let Ok(mut state) = self.signal.state.lock() else {
            return;
        };
        state.in_flight_publications = state.in_flight_publications.saturating_sub(1);
        self.signal.changed.notify_all();
    }
}

impl AgentPromptAdmissionSignal {
    pub(crate) fn notify(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.revision = state.revision.wrapping_add(1);
        self.changed.notify_all();
    }

    pub(crate) fn begin_publication(&self) -> Result<AgentPromptPublicationPermit<'_>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "agent prompt admission signal lock poisoned")?;
        if state.sealed {
            return Err("agent prompt publication is already sealed".into());
        }
        state.in_flight_publications = state
            .in_flight_publications
            .checked_add(1)
            .ok_or("agent prompt publication count exhausted")?;
        Ok(AgentPromptPublicationPermit { signal: self })
    }

    /// Makes provider exit visible, wakes waiters, and prevents Exit from
    /// overtaking any correlated prompt receipt already being produced.
    pub(crate) fn seal_and_wait_for_publications(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "agent prompt admission signal lock poisoned")?;
        state.sealed = true;
        state.revision = state.revision.wrapping_add(1);
        self.changed.notify_all();
        while state.in_flight_publications != 0 {
            state = self
                .changed
                .wait(state)
                .map_err(|_| "agent prompt publication wait poisoned")?;
        }
        Ok(())
    }

    pub(crate) fn wait(
        &self,
        timeout: Duration,
        mut observe: impl FnMut() -> Result<AgentPromptAdmission>,
    ) -> Result<AgentPromptWaitOutcome> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or("agent prompt admission deadline overflowed")?;
        loop {
            let observed_revision = self
                .state
                .lock()
                .map_err(|_| "agent prompt admission signal lock poisoned")?
                .revision;
            match observe()? {
                AgentPromptAdmission::Eligible => {
                    return Ok(AgentPromptWaitOutcome::Ready);
                }
                AgentPromptAdmission::Refused => {
                    return Ok(AgentPromptWaitOutcome::Refused);
                }
                AgentPromptAdmission::Pending => {}
            }

            let now = Instant::now();
            if now >= deadline {
                return Ok(AgentPromptWaitOutcome::TimedOut);
            }
            let revision = self
                .state
                .lock()
                .map_err(|_| "agent prompt admission signal lock poisoned")?;
            if revision.revision != observed_revision {
                continue;
            }
            let (next, timed_out) = self
                .changed
                .wait_timeout_while(
                    revision,
                    deadline.saturating_duration_since(now),
                    |current| current.revision == observed_revision,
                )
                .map_err(|_| "agent prompt admission signal wait poisoned")?;
            if timed_out.timed_out() && next.revision == observed_revision {
                // Re-enter once so a transition racing the timeout is decided
                // by the authoritative Host observation, not this wake token.
                continue;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    #[test]
    fn notification_only_rechecks_authoritative_readiness() {
        let signal = Arc::new(AgentPromptAdmissionSignal::default());
        let eligible = Arc::new(AtomicBool::new(false));
        let worker_signal = Arc::clone(&signal);
        let worker_eligible = Arc::clone(&eligible);
        let worker = thread::spawn(move || {
            worker_signal
                .wait(Duration::from_secs(1), || {
                    Ok(if worker_eligible.load(Ordering::Acquire) {
                        AgentPromptAdmission::Eligible
                    } else {
                        AgentPromptAdmission::Pending
                    })
                })
                .unwrap()
        });

        eligible.store(true, Ordering::Release);
        signal.notify();
        assert_eq!(worker.join().unwrap(), AgentPromptWaitOutcome::Ready);
    }

    #[test]
    fn missing_provider_event_times_out_without_inventing_readiness() {
        let signal = AgentPromptAdmissionSignal::default();
        assert_eq!(
            signal
                .wait(Duration::from_millis(1), || {
                    Ok(AgentPromptAdmission::Pending)
                })
                .unwrap(),
            AgentPromptWaitOutcome::TimedOut
        );
    }

    #[test]
    fn deadline_rechecks_authoritative_readiness_before_timing_out() {
        use std::sync::atomic::AtomicUsize;

        let signal = AgentPromptAdmissionSignal::default();
        let observations = AtomicUsize::new(0);
        assert_eq!(
            signal
                .wait(Duration::from_millis(1), || {
                    Ok(if observations.fetch_add(1, Ordering::AcqRel) == 0 {
                        AgentPromptAdmission::Pending
                    } else {
                        AgentPromptAdmission::Eligible
                    })
                })
                .unwrap(),
            AgentPromptWaitOutcome::Ready
        );
        assert!(observations.load(Ordering::Acquire) >= 2);
    }

    #[test]
    fn final_wait_outcome_maps_to_one_shared_not_written_reason() {
        assert_eq!(
            AgentPromptWaitOutcome::Ready.not_written_reason(false),
            None
        );
        assert_eq!(
            AgentPromptWaitOutcome::Refused.not_written_reason(false),
            Some(OperationReceiptReason::AgentRuntimeChanged)
        );
        assert_eq!(
            AgentPromptWaitOutcome::TimedOut.not_written_reason(false),
            Some(OperationReceiptReason::AgentRuntimeChanged)
        );
        assert_eq!(
            AgentPromptWaitOutcome::TimedOut.not_written_reason(true),
            Some(OperationReceiptReason::HostExiting)
        );
    }

    #[test]
    fn exit_seal_waits_for_the_correlated_prompt_publication() {
        use std::sync::mpsc;

        let signal = Arc::new(AgentPromptAdmissionSignal::default());
        let permit = signal.begin_publication().unwrap();
        let worker_signal = Arc::clone(&signal);
        let (sealed_tx, sealed_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            worker_signal.seal_and_wait_for_publications().unwrap();
            sealed_tx.send(()).unwrap();
        });

        let mut state = signal.state.lock().unwrap();
        while !state.sealed {
            state = signal.changed.wait(state).unwrap();
        }
        drop(state);
        assert!(sealed_rx.try_recv().is_err());
        drop(permit);
        sealed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
        assert!(signal.begin_publication().is_err());
    }
}
