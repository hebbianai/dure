use crate::{CommandFailure, CommandOutput, OutputLimitAction, TimeoutStage};
use std::process::ExitStatus;
use std::time::{Duration, Instant};

pub(crate) const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadState {
    Pending,
    Complete,
    Exceeded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OutputStream {
    Stdout,
    Stderr,
}

impl OutputStream {
    pub(crate) fn unavailable(self) -> CommandFailure {
        match self {
            Self::Stdout => CommandFailure::StdoutUnavailable,
            Self::Stderr => CommandFailure::StderrUnavailable,
        }
    }

    pub(crate) fn configure(self) -> CommandFailure {
        match self {
            Self::Stdout => CommandFailure::StdoutConfigure,
            Self::Stderr => CommandFailure::StderrConfigure,
        }
    }

    pub(crate) fn read_failure(self) -> CommandFailure {
        match self {
            Self::Stdout => CommandFailure::StdoutRead,
            Self::Stderr => CommandFailure::StderrRead,
        }
    }
}

pub(crate) trait SupervisedProcess {
    fn terminate(&mut self) -> Result<(), CommandFailure>;

    fn read_available(
        &mut self,
        stream: OutputStream,
        captured: &mut Vec<u8>,
        output_limit: usize,
    ) -> Result<ReadState, CommandFailure>;

    fn close_output(&mut self, stream: OutputStream);

    fn observe_exit(&mut self) -> Result<bool, CommandFailure>;

    fn finish(&mut self) -> Result<ExitStatus, CommandFailure>;
}

trait Clock {
    fn now(&self) -> Instant;
    fn sleep(&mut self, duration: Duration);
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

pub(crate) fn supervise(
    process: impl SupervisedProcess,
    deadline: Instant,
    output_limit: usize,
    output_limit_action: OutputLimitAction,
) -> Result<CommandOutput, CommandFailure> {
    supervise_with_clock(
        process,
        deadline,
        output_limit,
        output_limit_action,
        &mut SystemClock,
    )
}

fn supervise_with_clock(
    process: impl SupervisedProcess,
    deadline: Instant,
    output_limit: usize,
    output_limit_action: OutputLimitAction,
    clock: &mut impl Clock,
) -> Result<CommandOutput, CommandFailure> {
    let mut execution = Supervision::new(process, deadline, output_limit, output_limit_action);
    while !execution.poll(|| clock.now())? {
        clock.sleep(PROCESS_POLL_INTERVAL);
    }
    Ok(execution.into_output())
}

pub(crate) async fn supervise_async<S, F>(
    process: impl SupervisedProcess,
    deadline: Instant,
    output_limit: usize,
    output_limit_action: OutputLimitAction,
    mut sleep: S,
) -> Result<CommandOutput, CommandFailure>
where
    S: FnMut(Duration) -> F,
    F: std::future::Future<Output = ()>,
{
    let mut execution = Supervision::new(process, deadline, output_limit, output_limit_action);
    while !execution.poll(Instant::now)? {
        sleep(PROCESS_POLL_INTERVAL).await;
    }
    Ok(execution.into_output())
}

struct Supervision<P> {
    process: P,
    deadline: Instant,
    output_limit: usize,
    output_limit_action: OutputLimitAction,
    stdout: Capture,
    stderr: Capture,
    status: Option<ExitStatus>,
}

impl<P: SupervisedProcess> Supervision<P> {
    fn new(
        process: P,
        deadline: Instant,
        output_limit: usize,
        output_limit_action: OutputLimitAction,
    ) -> Self {
        Self {
            process,
            deadline,
            output_limit,
            output_limit_action,
            stdout: Capture::new(OutputStream::Stdout),
            stderr: Capture::new(OutputStream::Stderr),
            status: None,
        }
    }

    fn poll(&mut self, now: impl FnOnce() -> Instant) -> Result<bool, CommandFailure> {
        self.stdout.read(&mut self.process, self.output_limit)?;
        self.stderr.read(&mut self.process, self.output_limit)?;
        if self.status.is_none() && self.process.observe_exit()? {
            // The leader's exit is the authority to end the owned process tree. Cleanup
            // must happen before waiting for pipe closure because a background descendant
            // may have inherited an otherwise-unused stdout handle.
            self.status = Some(self.process.finish()?);
            // Cleanup and pipe closure can become observable in the same poll. Re-read
            // before classifying a deadline-edge result as an incomplete drain.
            self.stdout.read(&mut self.process, self.output_limit)?;
            self.stderr.read(&mut self.process, self.output_limit)?;
        }
        if self.output_limit_action == OutputLimitAction::TerminateProcessTree
            && (self.stdout.exceeded || self.stderr.exceeded)
        {
            // finish() has already retired an exited leader. Never signal its
            // numeric process group again after reaping that identity anchor.
            if self.status.is_none() {
                self.process.terminate()?;
            }
            return Err(CommandFailure::OutputLimit);
        }
        if self.status.is_some() && self.stdout.done && self.stderr.done {
            return Ok(true);
        }
        if now() >= self.deadline {
            let stage = if self.status.is_none() {
                TimeoutStage::ProcessExit
            } else if !self.stdout.done {
                TimeoutStage::StdoutDrain
            } else {
                TimeoutStage::StderrDrain
            };
            return Err(CommandFailure::Timeout(stage));
        }
        Ok(false)
    }

    fn into_output(self) -> CommandOutput {
        CommandOutput {
            status: self
                .status
                .expect("completed supervision has a leader status"),
            stdout: self.stdout.bytes,
            stderr: self.stderr.bytes,
            exceeded_limit: self.stdout.exceeded || self.stderr.exceeded,
        }
    }
}

struct Capture {
    stream: OutputStream,
    bytes: Vec<u8>,
    done: bool,
    exceeded: bool,
}

impl Capture {
    fn new(stream: OutputStream) -> Self {
        Self {
            stream,
            bytes: Vec::new(),
            done: false,
            exceeded: false,
        }
    }

    fn read(
        &mut self,
        process: &mut impl SupervisedProcess,
        limit: usize,
    ) -> Result<(), CommandFailure> {
        if !self.done {
            match process.read_available(self.stream, &mut self.bytes, limit)? {
                ReadState::Pending => {}
                ReadState::Complete => self.done = true,
                ReadState::Exceeded => {
                    self.done = true;
                    self.exceeded = true;
                }
            }
            if self.done {
                process.close_output(self.stream);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    #[cfg(unix)]
    fn success_status() -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(0)
    }

    #[cfg(windows)]
    fn success_status() -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(0)
    }

    struct FakeClock {
        now: Instant,
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.now
        }

        fn sleep(&mut self, duration: Duration) {
            self.now += duration;
        }
    }

    struct FakeProcess {
        reads: VecDeque<Result<ReadState, CommandFailure>>,
        stderr_reads: VecDeque<Result<ReadState, CommandFailure>>,
        exits: VecDeque<Result<bool, CommandFailure>>,
        finish: Result<ExitStatus, CommandFailure>,
        dropped: Rc<Cell<bool>>,
        termination: Result<(), CommandFailure>,
        termination_calls: Rc<Cell<usize>>,
    }

    impl SupervisedProcess for FakeProcess {
        fn terminate(&mut self) -> Result<(), CommandFailure> {
            self.termination_calls.set(self.termination_calls.get() + 1);
            self.termination
        }

        fn read_available(
            &mut self,
            stream: OutputStream,
            _captured: &mut Vec<u8>,
            _output_limit: usize,
        ) -> Result<ReadState, CommandFailure> {
            if stream == OutputStream::Stderr {
                self.stderr_reads
                    .pop_front()
                    .unwrap_or(Ok(ReadState::Pending))
            } else {
                self.reads.pop_front().unwrap_or(Ok(ReadState::Pending))
            }
        }

        fn close_output(&mut self, _stream: OutputStream) {}

        fn observe_exit(&mut self) -> Result<bool, CommandFailure> {
            self.exits.pop_front().unwrap_or(Ok(false))
        }

        fn finish(&mut self) -> Result<ExitStatus, CommandFailure> {
            self.finish
        }
    }

    impl Drop for FakeProcess {
        fn drop(&mut self) {
            self.dropped.set(true);
        }
    }

    fn fake(
        reads: impl IntoIterator<Item = Result<ReadState, CommandFailure>>,
        exits: impl IntoIterator<Item = Result<bool, CommandFailure>>,
        finish: Result<ExitStatus, CommandFailure>,
    ) -> (FakeProcess, Rc<Cell<bool>>) {
        let dropped = Rc::new(Cell::new(false));
        (
            FakeProcess {
                reads: reads.into_iter().collect(),
                stderr_reads: [Ok(ReadState::Complete)].into(),
                exits: exits.into_iter().collect(),
                finish,
                dropped: Rc::clone(&dropped),
                termination: Ok(()),
                termination_calls: Rc::new(Cell::new(0)),
            },
            dropped,
        )
    }

    fn run_fake(
        process: FakeProcess,
        clock: &mut FakeClock,
    ) -> Result<CommandOutput, CommandFailure> {
        let deadline = clock.now + PROCESS_POLL_INTERVAL;
        supervise_with_clock(process, deadline, 8, OutputLimitAction::CloseStream, clock)
    }

    #[test]
    fn strict_limit_terminates_without_waiting_for_exit_or_other_stream() {
        let (mut process, dropped) =
            fake([Ok(ReadState::Exceeded)], [Ok(false)], Ok(success_status()));
        process.stderr_reads.clear();
        let termination_calls = Rc::clone(&process.termination_calls);
        let now = Instant::now();
        let mut clock = FakeClock { now };
        assert_eq!(
            supervise_with_clock(
                process,
                now + Duration::from_secs(30),
                8,
                OutputLimitAction::TerminateProcessTree,
                &mut clock,
            )
            .unwrap_err(),
            CommandFailure::OutputLimit
        );
        assert_eq!(clock.now, now);
        assert_eq!(termination_calls.get(), 1);
        assert!(dropped.get());
    }

    #[test]
    fn strict_limit_preserves_a_termination_failure() {
        let (mut process, dropped) =
            fake([Ok(ReadState::Exceeded)], [Ok(false)], Ok(success_status()));
        process.termination = Err(CommandFailure::Cleanup);
        let now = Instant::now();
        let mut clock = FakeClock { now };
        assert_eq!(
            supervise_with_clock(
                process,
                now,
                8,
                OutputLimitAction::TerminateProcessTree,
                &mut clock,
            )
            .unwrap_err(),
            CommandFailure::Cleanup
        );
        assert!(dropped.get());
    }

    #[test]
    fn strict_limit_after_final_drain_does_not_signal_a_reaped_identity() {
        let (process, dropped) = fake(
            [Ok(ReadState::Pending), Ok(ReadState::Exceeded)],
            [Ok(true)],
            Ok(success_status()),
        );
        let termination_calls = Rc::clone(&process.termination_calls);
        let now = Instant::now();
        let mut clock = FakeClock { now };
        assert_eq!(
            supervise_with_clock(
                process,
                now,
                8,
                OutputLimitAction::TerminateProcessTree,
                &mut clock,
            )
            .unwrap_err(),
            CommandFailure::OutputLimit
        );
        assert_eq!(termination_calls.get(), 0);
        assert!(dropped.get());
    }

    #[test]
    fn stderr_drain_timeout_drops_owned_process() {
        let (mut process, dropped) =
            fake([Ok(ReadState::Complete)], [Ok(true)], Ok(success_status()));
        process.stderr_reads.clear();
        let mut clock = FakeClock {
            now: Instant::now(),
        };
        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::Timeout(TimeoutStage::StderrDrain)
        );
        assert!(dropped.get());
    }

    #[test]
    fn stderr_read_failure_drops_owned_process() {
        let (mut process, dropped) = fake([Ok(ReadState::Pending)], [], Ok(success_status()));
        process.stderr_reads = [Err(CommandFailure::StderrRead)].into();
        let mut clock = FakeClock {
            now: Instant::now(),
        };
        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::StderrRead
        );
        assert!(dropped.get());
    }

    #[test]
    fn process_exit_timeout_drops_owned_process() {
        let (process, dropped) = fake(
            [Ok(ReadState::Complete)],
            [Ok(false), Ok(false)],
            Ok(success_status()),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::Timeout(TimeoutStage::ProcessExit)
        );
        assert!(dropped.get());
    }

    #[test]
    fn stdout_drain_timeout_drops_owned_process() {
        let (process, dropped) = fake(
            [
                Ok(ReadState::Pending),
                Ok(ReadState::Pending),
                Ok(ReadState::Pending),
            ],
            [Ok(true)],
            Ok(success_status()),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::Timeout(TimeoutStage::StdoutDrain)
        );
        assert!(dropped.get());
    }

    #[test]
    fn exit_observation_gets_a_final_nonblocking_drain_before_timeout() {
        let (process, dropped) = fake(
            [Ok(ReadState::Pending), Ok(ReadState::Complete)],
            [Ok(true)],
            Ok(success_status()),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        let output = supervise_with_clock(
            process,
            clock.now,
            8,
            OutputLimitAction::CloseStream,
            &mut clock,
        )
        .expect("final drain wins");

        assert!(output.status.success());
        assert!(!output.exceeded_limit);
        assert!(dropped.get());
    }

    #[test]
    fn final_drain_preserves_output_limit_classification() {
        let (process, dropped) = fake(
            [Ok(ReadState::Pending), Ok(ReadState::Exceeded)],
            [Ok(true)],
            Ok(success_status()),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        let output = supervise_with_clock(
            process,
            clock.now,
            8,
            OutputLimitAction::CloseStream,
            &mut clock,
        )
        .expect("limit is an outcome");

        assert!(output.status.success());
        assert!(output.exceeded_limit);
        assert!(dropped.get());
    }

    #[test]
    fn final_drain_failure_drops_the_owned_process() {
        let (process, dropped) = fake(
            [Ok(ReadState::Pending), Err(CommandFailure::StdoutRead)],
            [Ok(true)],
            Ok(success_status()),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        assert_eq!(
            supervise_with_clock(
                process,
                clock.now,
                8,
                OutputLimitAction::CloseStream,
                &mut clock
            )
            .unwrap_err(),
            CommandFailure::StdoutRead
        );
        assert!(dropped.get());
    }

    #[test]
    fn stdout_failure_drops_owned_process() {
        let (process, dropped) = fake([Err(CommandFailure::StdoutRead)], [], Ok(success_status()));
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::StdoutRead
        );
        assert!(dropped.get());
    }

    #[test]
    fn wait_failure_drops_owned_process() {
        let (process, dropped) = fake(
            [Ok(ReadState::Complete)],
            [Err(CommandFailure::ProcessWait)],
            Ok(success_status()),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::ProcessWait
        );
        assert!(dropped.get());
    }

    #[test]
    fn cleanup_failure_is_preserved_and_drops_owned_process() {
        let (process, dropped) = fake(
            [Ok(ReadState::Complete)],
            [Ok(true)],
            Err(CommandFailure::Cleanup),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::Cleanup
        );
        assert!(dropped.get());
    }

    #[test]
    fn reap_failure_is_preserved_and_drops_owned_process() {
        let (process, dropped) = fake(
            [Ok(ReadState::Complete)],
            [Ok(true)],
            Err(CommandFailure::ProcessWait),
        );
        let mut clock = FakeClock {
            now: Instant::now(),
        };

        assert_eq!(
            run_fake(process, &mut clock).unwrap_err(),
            CommandFailure::ProcessWait
        );
        assert!(dropped.get());
    }
}
