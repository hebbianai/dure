//! Bytes travelling from the exec channel to a blocked reader thread.
//!
//! This is the wake path, and it is the single hardest thing this crate has to
//! get right. A Unix socket gets it free: `shutdown(Shutdown::Both)` makes the
//! kernel wake every thread blocked on any duplicate of the descriptor, with no
//! shared state at all. An SSH channel has no such object. Production hands a
//! connection to a dedicated reader thread and later `join()`s it, so a wake
//! that never arrives is not a missed event — it is an app that will not quit.
//!
//! `hmux-host`'s `SelfPipe` solves the same problem for a pipe-backed reader by
//! adding a second descriptor to its `poll` set. The pattern ports; the
//! descriptors do not. This reader never blocks in `poll(2)` — it blocks on a
//! condition variable owned by this process, because the thread that has the
//! bytes is a task on our own runtime rather than the kernel. A self-pipe here
//! would buy two file descriptors and a syscall to duplicate a `notify_all`,
//! and would drag in a `cfg(unix)` that the mobile targets this crate exists
//! for do not want. What is preserved is the property that matters: one
//! wake path, set before it is signalled, checked before anything else.

use std::collections::VecDeque;
use std::io;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Above this many buffered bytes the pump stops draining the channel, which
/// lets the SSH window close and pushes backpressure onto the remote gateway.
/// Nothing is ever dropped.
///
/// Two maximal frames (`FrameLimits::max_frame_bytes` is 1 MiB). One would
/// make the pump stop and restart in the middle of every large snapshot;
/// unbounded would violate the hmux rule that slow clients get backpressure,
/// never unbounded buffering.
const INBOUND_HIGH_WATER: usize = 2 * 1024 * 1024;

/// How much remote stderr text is kept for diagnostics.
const DIAGNOSTIC_LIMIT: usize = 512;

mod completion;
pub use completion::ChannelCompletion;

#[derive(Debug, Default)]
struct InboundState {
    chunks: VecDeque<Vec<u8>>,
    /// How far into `chunks.front()` the reader has already consumed.
    front_offset: usize,
    buffered: usize,
    end_of_data: bool,
    ended: bool,
    interrupted: bool,
    exit_status: Option<u32>,
    diagnostic: String,
}

impl InboundState {
    /// Copies out of the front chunk only. A short read is legal for `Read`
    /// and the frame codec loops over them, so there is no reason to stitch
    /// chunks together on the reader's thread.
    fn take(&mut self, buffer: &mut [u8]) -> usize {
        let start = self.front_offset;
        let (taken, exhausted) = match self.chunks.front() {
            None => return 0,
            Some(front) => {
                let taken = (front.len() - start).min(buffer.len());
                buffer[..taken].copy_from_slice(&front[start..start + taken]);
                (taken, start + taken == front.len())
            }
        };
        self.buffered -= taken;
        if exhausted {
            self.chunks.pop_front();
            self.front_offset = 0;
        } else {
            self.front_offset = start + taken;
        }
        taken
    }

    fn buffered_prefix(&self) -> Option<[u8; 4]> {
        if self.buffered < 4 {
            return None;
        }
        let mut prefix = [0_u8; 4];
        let mut copied = 0;
        for (index, chunk) in self.chunks.iter().enumerate() {
            let start = if index == 0 { self.front_offset } else { 0 };
            let available = &chunk[start..];
            let take = available.len().min(prefix.len() - copied);
            prefix[copied..copied + take].copy_from_slice(&available[..take]);
            copied += take;
            if copied == prefix.len() {
                return Some(prefix);
            }
        }
        None
    }

    fn completion(&self) -> ChannelCompletion {
        ChannelCompletion {
            exit_status: self.exit_status,
            diagnostic: self.diagnostic.clone(),
        }
    }
}

/// Everything the reader thread and the pump share about the inbound stream.
#[derive(Debug, Default)]
pub(crate) struct Inbound {
    state: Mutex<InboundState>,
    /// Wakes the blocked reader thread.
    readable: Condvar,
    /// Wakes the pump once the reader has made room.
    drained: Notify,
}

impl Inbound {
    fn lock(&self) -> std::sync::MutexGuard<'_, InboundState> {
        self.state.lock().expect("inbound state lock")
    }

    /// Blocking read for the frame reader. `timeout` of `None` waits forever.
    pub(crate) fn read(&self, buffer: &mut [u8], timeout: Option<Duration>) -> io::Result<usize> {
        let deadline = timeout.map(|budget| Instant::now() + budget);
        let mut state = self.lock();
        loop {
            // Checked before the buffered bytes, deliberately. A detach that
            // has already been requested must win, or a reader would start one
            // more frame nobody intends to consume and observe the interrupt a
            // frame later — which on a slow link is a visible hang.
            if state.interrupted {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the Hmux SSH transport read was interrupted",
                ));
            }
            if state.buffered > 0 {
                let was_over = state.buffered > INBOUND_HIGH_WATER;
                let taken = state.take(buffer);
                if was_over && state.buffered <= INBOUND_HIGH_WATER {
                    self.drained.notify_one();
                }
                return Ok(taken);
            }
            if state.end_of_data || state.ended {
                return Ok(0);
            }
            match deadline {
                None => state = self.readable.wait(state).expect("inbound state lock"),
                Some(at) => {
                    let now = Instant::now();
                    if now >= at {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "no Hmux frame arrived over SSH before the deadline",
                        ));
                    }
                    let (next, _) = self
                        .readable
                        .wait_timeout(state, at - now)
                        .expect("inbound state lock");
                    state = next;
                }
            }
        }
    }

    /// Waits for the first byte of a frame without consuming anything.
    ///
    /// `Ok(())` here means a following `read` will not block, which includes
    /// the end-of-stream cases: a caller polling for readability wants to be
    /// told that the answer is "the peer is gone", not to keep polling.
    pub(crate) fn wait_readable(&self, timeout: Option<Duration>) -> WaitOutcome {
        let deadline = timeout.map(|budget| Instant::now() + budget);
        let mut state = self.lock();
        loop {
            if state.interrupted {
                return WaitOutcome::Interrupted;
            }
            if state.buffered > 0 || state.end_of_data || state.ended {
                return WaitOutcome::Ready;
            }
            match deadline {
                None => state = self.readable.wait(state).expect("inbound state lock"),
                Some(at) => {
                    let now = Instant::now();
                    if now >= at {
                        return WaitOutcome::TimedOut;
                    }
                    let (next, _) = self
                        .readable
                        .wait_timeout(state, at - now)
                        .expect("inbound state lock");
                    state = next;
                }
            }
        }
    }

    /// Proves that one whole validly bounded length-delimited payload is in
    /// the process-local buffer without consuming any of it.
    pub(crate) fn complete_payload_is_buffered(
        &self,
        maximum_payload_bytes: usize,
    ) -> Result<bool, ()> {
        let state = self.lock();
        if state.interrupted {
            return Err(());
        }
        let Some(prefix) = state.buffered_prefix() else {
            return Ok(false);
        };
        let declared = usize::try_from(u32::from_be_bytes(prefix))
            .expect("u32 always fits usize on supported hosts");
        Ok(declared > 0
            && declared <= maximum_payload_bytes
            && state.buffered >= 4_usize.saturating_add(declared))
    }

    pub(crate) fn is_interrupted(&self) -> bool {
        self.lock().interrupted
    }

    /// Marks a deliberate detach and wakes the reader, whatever it is doing.
    pub(crate) fn interrupt(&self) {
        // The flag is set before the notify, so a reader that wakes for any
        // other reason still observes the interrupt on its next pass.
        self.lock().interrupted = true;
        self.readable.notify_all();
        self.drained.notify_one();
    }

    pub(crate) fn push_data(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let mut state = self.lock();
        state.buffered += bytes.len();
        state.chunks.push_back(bytes);
        drop(state);
        self.readable.notify_all();
    }

    /// Records remote stderr, sanitized.
    ///
    /// The bytes are remote-controlled and end up in a user-visible message,
    /// which is exactly the shape this design rejects for pre-handshake stream
    /// 0 data. Stream 2 is admitted for a reason that does not generalize:
    /// sshd authenticated the principal before the command ran, so this is
    /// output from a program running as our own account on a host we chose.
    /// It is still narrowed to printable ASCII and capped, because "trusted
    /// enough to explain a failure" is not "trusted enough to emit control
    /// sequences into someone's terminal".
    pub(crate) fn push_diagnostic(&self, bytes: &[u8]) {
        let mut state = self.lock();
        for byte in bytes {
            if state.diagnostic.len() >= DIAGNOSTIC_LIMIT {
                break;
            }
            let character = char::from(*byte);
            if character.is_ascii_graphic() || *byte == b' ' {
                state.diagnostic.push(character);
            } else if !state.diagnostic.ends_with(' ') && !state.diagnostic.is_empty() {
                state.diagnostic.push(' ');
            }
        }
        while state.diagnostic.ends_with(' ') {
            state.diagnostic.pop();
        }
    }

    pub(crate) fn set_exit_status(&self, status: u32) {
        self.lock().exit_status = Some(status);
    }

    /// The remote closed its write half: no more frames, but what is already
    /// buffered is still delivered.
    pub(crate) fn mark_end_of_data(&self) {
        self.lock().end_of_data = true;
        self.readable.notify_all();
    }

    pub(crate) fn mark_ended(&self) {
        let mut state = self.lock();
        state.ended = true;
        state.end_of_data = true;
        drop(state);
        self.readable.notify_all();
    }

    pub(crate) fn is_over_high_water(&self) -> bool {
        self.lock().buffered > INBOUND_HIGH_WATER
    }

    /// Async side of the backpressure handshake.
    pub(crate) async fn wait_for_capacity(&self) {
        self.drained.notified().await;
    }
}

/// What a readability poll found.
pub(crate) enum WaitOutcome {
    Ready,
    TimedOut,
    Interrupted,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::within;
    use std::sync::Arc;
    use std::thread;

    const PATIENCE: Duration = Duration::from_secs(10);

    /// The reader wake path, isolated from everything that could stand in for
    /// it.
    ///
    /// Every other wake test in this crate goes through the pump, which calls
    /// `mark_ended` on its way out and notifies the same condvar there. So
    /// deleting the `readable.notify_all()` from [`Inbound::interrupt`] -- the
    /// one wake this crate exists to provide, the thing a Unix socket gets free
    /// from `shutdown(Shutdown::Both)` -- left the entire suite green, and the
    /// crate's central invariant was unprotected. Nothing here touches the
    /// pump: if `interrupt` stops waking the condvar, this blocks forever and
    /// the deadline turns that into an assertion.
    #[test]
    fn an_interrupt_is_the_only_thing_that_has_to_wake_a_blocked_reader() {
        let inbound = Arc::new(Inbound::default());

        let blocked = Arc::clone(&inbound);
        let reader = thread::spawn(move || {
            let mut buffer = [0_u8; 16];
            blocked.read(&mut buffer, None)
        });
        // Let the reader reach the condvar, so the wake is what releases it
        // rather than the flag having been set before the wait began -- which
        // is a different property, and one that is already covered.
        thread::sleep(Duration::from_millis(50));
        inbound.interrupt();

        let error = within(PATIENCE, move || reader.join().expect("reader thread"))
            .expect_err("an interrupted read is not a successful one");
        assert_eq!(error.kind(), io::ErrorKind::ConnectionAborted);
    }

    /// The same, for the other place a caller can be parked. `hmux-cli` polls
    /// readability on its interactive attach, so this is the wait a detach
    /// finds it in whenever the session is quiet.
    #[test]
    fn an_interrupt_is_the_only_thing_that_has_to_wake_a_blocked_readability_poll() {
        let inbound = Arc::new(Inbound::default());

        let blocked = Arc::clone(&inbound);
        let poll = thread::spawn(move || blocked.wait_readable(None));
        thread::sleep(Duration::from_millis(50));
        inbound.interrupt();

        assert!(matches!(
            within(PATIENCE, move || poll.join().expect("poll thread")),
            WaitOutcome::Interrupted
        ));
    }

    /// Remote stderr is the only thing that explains a failed gateway, and it
    /// is also attacker-adjacent text on its way into a user-visible message.
    /// It gets in, narrowed: printable ASCII, one line, bounded.
    #[test]
    fn a_diagnostic_keeps_the_message_and_drops_the_control_bytes() {
        let inbound = Inbound::default();

        inbound.push_diagnostic(b"bash: line 1: hmux: command not found\n");
        inbound.push_diagnostic(b"\x1b[2J\x07");

        let detail = inbound
            .lock()
            .completion()
            .failure_detail()
            .expect("stderr is reported");
        assert!(
            detail.contains("hmux: command not found"),
            "unexpected detail {detail}"
        );
        assert!(!detail.contains('\x1b'), "escape survived: {detail:?}");
        assert!(!detail.contains('\x07'), "bell survived: {detail:?}");
        assert!(!detail.contains('\n'), "newline survived: {detail:?}");
    }

    /// A gateway that says a great deal must not be able to say it into
    /// someone's error dialog.
    #[test]
    fn a_diagnostic_is_bounded() {
        let inbound = Inbound::default();

        inbound.push_diagnostic(&vec![b'x'; DIAGNOSTIC_LIMIT * 4]);

        let detail = inbound
            .lock()
            .completion()
            .failure_detail()
            .expect("stderr is reported");
        assert!(
            detail.len() <= DIAGNOSTIC_LIMIT * 2,
            "unbounded: {}",
            detail.len()
        );
    }

    /// A polite detach exits zero and says nothing, and has to stay
    /// indistinguishable from an ordinary end of stream.
    #[test]
    fn a_clean_exit_reports_nothing() {
        let inbound = Inbound::default();

        inbound.set_exit_status(0);

        assert!(inbound.lock().completion().failure_detail().is_none());
    }

    #[test]
    fn a_non_zero_exit_reports_its_status() {
        let inbound = Inbound::default();

        inbound.set_exit_status(127);

        assert!(
            inbound
                .lock()
                .completion()
                .failure_detail()
                .expect("a failure is reported")
                .contains("127")
        );
    }
}
