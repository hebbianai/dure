//! Frames travelling from a blocking writer to the exec channel.
//!
//! This queue holds **whole frames**, never a flat byte buffer, and that is the
//! entire reason it exists. `FrameWriter::write_frame` promises all-or-nothing:
//! an error means either nothing reached the wire or the transport is already
//! unusable. Bridging a frame stream through anything that forgets where frames
//! begin silently voids that promise — the write succeeds into the buffer, the
//! channel dies half a frame later, and the peer reads the tail of one frame as
//! the length prefix of the next. Permanent desynchronization, from a write the
//! caller was told had succeeded.
//!
//! So the pump takes one frame at a time and counts the bytes the channel
//! actually accepted. Failing at offset zero leaves the peer's stream still
//! frame-aligned and is reported as an ordinary closed transport. Failing after
//! any byte is misalignment, and the writer refuses everything afterwards.

use hmux_session_protocol::transport::TransportError;
use std::collections::VecDeque;
use std::io;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Above this many queued bytes a writer waits instead of buffering more.
///
/// Four maximal frames (`FrameLimits::max_frame_bytes` is 1 MiB). Admission is
/// per whole frame and an empty queue always accepts one, so a single frame can
/// never wedge against the limit however large it is.
const OUTBOUND_HIGH_WATER: usize = 4 * 1024 * 1024;

const WRITE_OPERATION: &str = "write Hmux frame over SSH";

#[derive(Debug)]
enum WireState {
    Open,
    /// Stopped on a frame boundary. Whatever the peer received is still a
    /// whole number of frames, so this is an ordinary disconnect.
    Closed(String),
    /// Stopped part-way through a frame. The peer cannot find the next length
    /// prefix, and no later write can fix that.
    Misaligned(String),
}

#[derive(Debug)]
struct OutboundState {
    queue: VecDeque<Vec<u8>>,
    queued: usize,
    finishing: bool,
    wire: WireState,
}

impl Default for OutboundState {
    fn default() -> Self {
        Self {
            queue: VecDeque::new(),
            queued: 0,
            finishing: false,
            wire: WireState::Open,
        }
    }
}

/// What the pump should do next.
pub(crate) enum OutboundWork {
    /// Commit this whole frame, then come back.
    Frame(Vec<u8>),
    /// The queue is drained and the writer asked to close.
    Finish,
    /// Nothing to do; wait to be woken.
    Idle,
    /// The write half is finished for good.
    Stop,
}

#[derive(Debug, Default)]
pub(crate) struct Outbound {
    state: Mutex<OutboundState>,
    /// Wakes a writer thread waiting for queue space or for a status change.
    admitted: Condvar,
    /// Wakes the pump when there is a frame to send, or a reason to stop.
    work: Notify,
}

impl Outbound {
    fn lock(&self) -> std::sync::MutexGuard<'_, OutboundState> {
        self.state.lock().expect("outbound state lock")
    }

    /// Queues one encoded frame, blocking while the queue is full.
    ///
    /// The wait can be bounded without breaking the all-or-nothing guarantee,
    /// which is the opposite of how `SO_SNDTIMEO` behaves on a socket: there
    /// the deadline fires *while bytes are on the wire*, so expiry and
    /// desynchronization are the same event. Here a frame is admitted whole or
    /// not at all, so a deadline that expires while waiting for space has
    /// provably emitted nothing and leaves the connection usable.
    pub(crate) fn enqueue(
        &self,
        encoded: &[u8],
        admission_timeout: Option<Duration>,
    ) -> Result<(), TransportError> {
        let deadline = admission_timeout.map(|budget| Instant::now() + budget);
        self.enqueue_before(encoded, deadline)
    }

    pub(crate) fn enqueue_before(
        &self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        let mut state = self.lock();
        loop {
            match &state.wire {
                // The only variant `TransportError::desynchronizes_stream`
                // reports true for, which is what makes the caller poison the
                // connection instead of retrying onto a stream the peer can no
                // longer parse. `FdFrameWriter` reports a poisoned socket the
                // same way.
                WireState::Misaligned(_) => return Err(TransportError::CompletionTimeout),
                WireState::Closed(detail) => {
                    return Err(TransportError::Io {
                        operation: WRITE_OPERATION,
                        source: io::Error::new(io::ErrorKind::BrokenPipe, detail.clone()),
                    });
                }
                WireState::Open => {}
            }
            if state.finishing {
                return Err(TransportError::Io {
                    operation: WRITE_OPERATION,
                    source: io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "the Hmux SSH write half is already closed",
                    ),
                });
            }
            if deadline.is_some_and(|at| Instant::now() >= at) {
                return Err(TransportError::WriteNotStarted);
            }
            if state.queued == 0 || state.queued + encoded.len() <= OUTBOUND_HIGH_WATER {
                break;
            }
            match deadline {
                None => state = self.admitted.wait(state).expect("outbound state lock"),
                Some(at) => {
                    let now = Instant::now();
                    if now >= at {
                        return Err(TransportError::WriteNotStarted);
                    }
                    let (next, _) = self
                        .admitted
                        .wait_timeout(state, at - now)
                        .expect("outbound state lock");
                    state = next;
                }
            }
        }
        if deadline.is_some_and(|at| Instant::now() >= at) {
            return Err(TransportError::WriteNotStarted);
        }
        state.queued += encoded.len();
        state.queue.push_back(encoded.to_vec());
        drop(state);
        self.work.notify_one();
        Ok(())
    }

    /// Asks the pump to send channel EOF once the queue has drained.
    pub(crate) fn request_finish(&self) -> Result<(), TransportError> {
        let mut state = self.lock();
        if let WireState::Misaligned(_) = state.wire {
            return Err(TransportError::CompletionTimeout);
        }
        state.finishing = true;
        drop(state);
        self.work.notify_one();
        Ok(())
    }

    pub(crate) fn next_work(&self) -> OutboundWork {
        let mut state = self.lock();
        if !matches!(state.wire, WireState::Open) {
            return OutboundWork::Stop;
        }
        if let Some(frame) = state.queue.pop_front() {
            state.queued -= frame.len();
            drop(state);
            // A frame in flight no longer occupies the queue, so a writer
            // blocked on space is released as soon as the pump picks it up
            // rather than when the channel finally accepts it.
            self.admitted.notify_all();
            return OutboundWork::Frame(frame);
        }
        if state.finishing {
            return OutboundWork::Finish;
        }
        OutboundWork::Idle
    }

    pub(crate) async fn wait_for_work(&self) {
        self.work.notified().await;
    }

    /// Records how a frame's transmission ended.
    ///
    /// `committed` is the count the channel actually accepted, which is the
    /// whole reason the pump writes one frame at a time.
    pub(crate) fn record_frame_failure(&self, committed: usize, detail: String) {
        let mut state = self.lock();
        if committed == 0 {
            state.demote(WireState::Closed(detail));
        } else {
            state.demote(WireState::Misaligned(format!(
                "{detail} after {committed} bytes of a frame"
            )));
        }
        drop(state);
        self.admitted.notify_all();
        self.work.notify_one();
    }

    /// Ends the write half cleanly, on a frame boundary.
    pub(crate) fn mark_closed(&self, detail: &str) {
        self.lock().demote(WireState::Closed(detail.to_string()));
        self.admitted.notify_all();
        self.work.notify_one();
    }

    /// Ends the write half because of a detach.
    ///
    /// If a frame was mid-flight the pump reports that separately; this only
    /// ever downgrades an open wire, never an already-diagnosed one.
    pub(crate) fn abandon(&self) {
        self.mark_closed("the Hmux SSH transport was interrupted");
    }

    /// Why the wire stopped being frame-aligned, if it did.
    ///
    /// `TransportError` has nowhere to carry this: misalignment has to map to
    /// the one variant `desynchronizes_stream` reports true for, and that
    /// variant has no message. Without an accessor the detail would be a
    /// stored field nobody can read, which is how a diagnosis becomes
    /// decoration.
    pub(crate) fn misalignment_detail(&self) -> Option<String> {
        match &self.lock().wire {
            WireState::Misaligned(detail) => Some(detail.clone()),
            _ => None,
        }
    }
}

impl OutboundState {
    /// Keeps the first diagnosis. A misaligned wire never becomes merely
    /// closed, and the first failure is the one that explains the rest.
    fn demote(&mut self, next: WireState) {
        match (&self.wire, &next) {
            (WireState::Open, _) | (WireState::Closed(_), WireState::Misaligned(_)) => {
                self.wire = next;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::within;
    use std::sync::Arc;
    use std::thread;

    const PATIENCE: Duration = Duration::from_secs(10);
    const MIB: usize = 1024 * 1024;

    fn filler(bytes: usize) -> Vec<u8> {
        vec![7_u8; bytes]
    }

    fn queued_frames(outbound: &Outbound) -> usize {
        outbound.lock().queue.len()
    }

    /// An empty queue accepts any frame, however large. Without this a frame
    /// bigger than the limit would wait for space that can never appear, and
    /// the connection would stop rather than slow down.
    #[test]
    fn an_empty_queue_admits_a_frame_of_any_size() {
        let outbound = Outbound::default();

        outbound
            .enqueue(&filler(OUTBOUND_HIGH_WATER * 2), None)
            .unwrap();

        assert_eq!(queued_frames(&outbound), 1);
    }

    /// Backpressure rather than unbounded buffering, and the release comes as
    /// soon as the pump *takes* a frame rather than when the channel finally
    /// accepts it — a frame in flight is no longer occupying the queue.
    #[test]
    fn a_writer_waiting_for_space_is_released_when_the_pump_takes_a_frame() {
        let outbound = Arc::new(Outbound::default());
        outbound.enqueue(&filler(3 * MIB), None).unwrap();

        let waiting = Arc::clone(&outbound);
        let writer = thread::spawn(move || waiting.enqueue(&filler(3 * MIB), None));
        // Let the writer reach the wait before the space appears, so this
        // exercises the wake rather than a lucky ordering.
        thread::sleep(Duration::from_millis(50));
        assert!(matches!(outbound.next_work(), OutboundWork::Frame(_)));

        within(PATIENCE, move || writer.join().expect("writer thread")).unwrap();
        assert_eq!(queued_frames(&outbound), 1);
    }

    /// A bounded write is safe here in a way `SO_SNDTIMEO` is not. On a socket
    /// the deadline fires while bytes are already on the wire, so expiry and
    /// desynchronization are the same event; here it can only fire before the
    /// frame is admitted, so nothing was emitted and the connection is intact.
    #[test]
    fn an_admission_deadline_expires_without_emitting_anything() {
        let outbound = Outbound::default();
        outbound.enqueue(&filler(3 * MIB), None).unwrap();

        let error = outbound
            .enqueue(&filler(3 * MIB), Some(Duration::from_millis(50)))
            .unwrap_err();

        assert!(
            matches!(&error, TransportError::WriteNotStarted),
            "unexpected error {error:?}"
        );
        assert!(error.is_retry_safe());
        assert!(!error.desynchronizes_stream());
        // The refused frame was never queued, which is what makes the deadline
        // compatible with the all-or-nothing contract.
        assert_eq!(queued_frames(&outbound), 1);
    }

    /// The interrupt has to reach a writer too. `TransportInterrupt` promises
    /// only to wake a reader, but a writer parked on a stalled SSH window is
    /// just as capable of turning app shutdown into a hang, and nothing else
    /// can reach it.
    #[test]
    fn a_detach_releases_a_writer_that_is_waiting_for_space() {
        let outbound = Arc::new(Outbound::default());
        outbound.enqueue(&filler(3 * MIB), None).unwrap();

        let waiting = Arc::clone(&outbound);
        let writer = thread::spawn(move || waiting.enqueue(&filler(3 * MIB), None));
        thread::sleep(Duration::from_millis(50));
        outbound.abandon();

        let error = within(PATIENCE, move || writer.join().expect("writer thread")).unwrap_err();
        assert!(
            matches!(
                &error,
                TransportError::Io { source, .. } if source.kind() == io::ErrorKind::BrokenPipe
            ),
            "unexpected error {error:?}"
        );
        // A detach is not stream damage.
        assert!(!error.desynchronizes_stream());
    }

    /// Once the wire is misaligned it stays that way. A later clean shutdown
    /// must not overwrite the diagnosis with a gentler one, or a caller that
    /// checks after teardown concludes the stream was fine.
    #[test]
    fn a_misaligned_wire_is_never_downgraded_to_a_clean_close() {
        let outbound = Outbound::default();

        outbound.record_frame_failure(12, "scripted".to_string());
        outbound.mark_closed("teardown");

        assert!(outbound.misalignment_detail().is_some());
        assert!(
            outbound
                .enqueue(&filler(8), None)
                .unwrap_err()
                .desynchronizes_stream()
        );
    }
}
