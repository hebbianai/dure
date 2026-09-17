//! The three `hmux-host` transport traits, implemented over an SSH exec
//! channel.

use crate::inbound::{ChannelCompletion, WaitOutcome};
use crate::shared::SessionLifetime;
use hmux_session_protocol::FrameCodec;
use hmux_session_protocol::transport::{
    FrameProgress, FrameReader, FrameWriter, PayloadOutcome, TransportError, TransportInterrupt,
    drive_read_payload,
};
use std::io::{self, Read};
use std::sync::Arc;
use std::time::{Duration, Instant};

const READ_OPERATION: &str = "read Hmux frame over SSH";

mod completion;

/// Reads whole frames out of the buffer the pump fills.
pub struct SshFrameReader {
    session: Arc<SessionLifetime>,
    first_byte_timeout: Option<Duration>,
    completion_timeout: Option<Duration>,
    absolute_deadline: Option<Instant>,
    frame_started: Option<Instant>,
}

impl SshFrameReader {
    pub(crate) fn new(session: Arc<SessionLifetime>) -> Self {
        Self {
            session,
            first_byte_timeout: None,
            completion_timeout: None,
            absolute_deadline: None,
            frame_started: None,
        }
    }

    pub fn set_first_byte_timeout(&mut self, timeout: Option<Duration>) {
        self.first_byte_timeout = timeout;
    }

    pub(crate) fn set_absolute_deadline(&mut self, deadline: Option<Instant>) {
        self.absolute_deadline = deadline;
    }

    /// The budget for the next underlying read: time-to-first-byte before a
    /// frame has started, whatever is left of the completion budget after.
    fn budget(&self) -> Option<Duration> {
        let phase = match self.frame_started {
            Some(started) => self
                .completion_timeout
                .map(|total| total.saturating_sub(started.elapsed())),
            None => self.first_byte_timeout,
        };
        let absolute = self
            .absolute_deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()));
        match (phase, absolute) {
            (Some(phase), Some(absolute)) => Some(phase.min(absolute)),
            (phase, absolute) => phase.or(absolute),
        }
    }
}

impl Read for SshFrameReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.session.shared().inbound.read(buffer, self.budget())?;
        if read > 0 && self.frame_started.is_none() {
            self.frame_started = Some(Instant::now());
        }
        Ok(read)
    }
}

impl FrameReader for SshFrameReader {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        match self.session.shared().inbound.wait_readable(timeout) {
            WaitOutcome::Ready => Ok(()),
            WaitOutcome::TimedOut => Err(TransportError::FirstByteTimeout),
            WaitOutcome::Interrupted => Err(TransportError::Interrupted),
        }
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.completion_timeout = timeout;
    }

    fn try_read_complete_payload(
        &mut self,
        codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        match self
            .session
            .shared()
            .inbound
            .complete_payload_is_buffered(codec.limits().max_frame_bytes)
        {
            Err(()) => Err(TransportError::Interrupted),
            Ok(false) => Ok(None),
            Ok(true) => self.read_payload(codec),
        }
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.frame_started = None;
        let mut progress = FrameProgress::new();
        let result = drive_read_payload(self, &mut progress, codec);
        let result = match result {
            Ok(None) => self
                .wait_for_completion()
                .map_err(|source| TransportError::Io {
                    operation: READ_OPERATION,
                    source,
                })
                .and_then(|completion| match completion.failure_detail() {
                    None => Ok(None),
                    Some(detail) => Err(TransportError::Io {
                        operation: READ_OPERATION,
                        source: io::Error::new(io::ErrorKind::BrokenPipe, detail),
                    }),
                }),
            // A close *inside* a frame keeps its truncation classification.
            // The detail is dropped there on purpose: truncation already says
            // something specific about frame alignment that callers act on,
            // and a "why" is worth less than that.
            other => other,
        };
        self.frame_started = None;
        if self.session.shared().inbound.is_interrupted() {
            Err(TransportError::Interrupted)
        } else {
            result
        }
    }
}

/// Hands whole frames to the pump.
pub struct SshFrameWriter {
    session: Arc<SessionLifetime>,
}

impl SshFrameWriter {
    pub(crate) fn new(session: Arc<SessionLifetime>) -> Self {
        Self { session }
    }

    /// Why the channel stopped being frame-aligned, if it did.
    ///
    /// The error a caller sees for this has to be the one that makes it poison
    /// the connection, and that error carries no message, so the reason is only
    /// reachable here.
    #[must_use]
    pub fn misalignment_detail(&self) -> Option<String> {
        self.session.shared().outbound.misalignment_detail()
    }
}

impl FrameWriter for SshFrameWriter {
    /// Queues one encoded frame, whole.
    ///
    /// `Ok` means the frame was admitted intact, not that the far end has
    /// received it — the same thing a socket write into a kernel buffer means.
    /// What the contract needs is the converse, and it holds: an error means
    /// either that this frame was never admitted, or that the transport has
    /// already recorded the wire as unusable and will refuse everything after.
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        let shared = self.session.shared();
        shared
            .outbound
            .enqueue(encoded, shared.write_admission_timeout())
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        let shared = self.session.shared();
        let now = Instant::now();
        let configured = shared
            .write_admission_timeout()
            .map(|timeout| now + timeout);
        let deadline = match (configured, deadline) {
            (Some(configured), Some(requested)) => Some(configured.min(requested)),
            (configured, requested) => configured.or(requested),
        };
        shared.outbound.enqueue_before(encoded, deadline)
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.session.shared().outbound.request_finish()
    }
}

/// Wakes a reader that is already blocked, from another thread.
pub struct SshInterrupt {
    session: Arc<SessionLifetime>,
}

impl SshInterrupt {
    pub(crate) fn new(session: Arc<SessionLifetime>) -> Self {
        Self { session }
    }
}

impl TransportInterrupt for SshInterrupt {
    fn interrupt(&self) {
        self.session.shared().interrupt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::ChannelEvent;
    use crate::harness::{Harness, WriteStep, codec, encoded, reason_of};
    use hmux_session_protocol::{FrameBody, Input, PROTOCOL_V1, WireFrame};
    use std::thread;

    const PATIENCE: Duration = Duration::from_secs(10);

    /// Blocks until the pump has taken what the writer queued.
    fn settle(harness: &Harness, expected: usize) {
        for _ in 0..400 {
            if harness.committed.lock().expect("committed lock").len() >= expected {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("the pump never committed {expected} bytes");
    }

    /// Keeps writing until the transport refuses. A failure that happens on
    /// the pump's thread reaches a caller on its next send, never as a late
    /// error on the send that queued the doomed frame.
    fn write_until_refused(harness: &mut Harness) -> TransportError {
        let codec = codec();
        for _ in 0..400 {
            match harness.writer.write_frame(&encoded(&codec, "probe")) {
                Err(error) => return error,
                Ok(()) => thread::sleep(Duration::from_millis(5)),
            }
        }
        panic!("the writer never reported the channel failure");
    }

    fn input_frame(codec: &FrameCodec, bytes: usize) -> Vec<u8> {
        codec
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 7,
                body: FrameBody::Input(Input {
                    request_id: "backpressure".to_string(),
                    controller_generation: 1,
                    bytes: vec![b'x'; bytes],
                }),
            })
            .expect("input frame encodes")
    }

    #[test]
    fn frames_round_trip_over_the_channel() {
        let codec = codec();
        let mut harness = Harness::new(vec![]);

        harness.send(&encoded(&codec, "hello"));
        assert_eq!(
            reason_of(
                harness
                    .with_reader(|reader| reader.read_frame(&codec))
                    .unwrap()
            ),
            "hello"
        );

        let outbound = encoded(&codec, "outbound");
        harness.writer.write_frame(&outbound).unwrap();
        settle(&harness, outbound.len());
        assert_eq!(*harness.committed.lock().unwrap(), outbound);
    }

    /// An SSH channel chops the stream wherever its window and packet size
    /// fall, which a socket does not. Framing has to be indifferent to that.
    #[test]
    fn a_frame_split_across_many_channel_packets_still_decodes() {
        let codec = codec();
        let harness = Harness::new(vec![]);

        for chunk in encoded(&codec, "split-across-packets").chunks(3) {
            harness.send(chunk);
        }

        assert_eq!(
            reason_of(
                harness
                    .with_reader(|reader| reader.read_frame(&codec))
                    .unwrap()
            ),
            "split-across-packets"
        );
    }

    #[test]
    fn buffered_payload_probe_leaves_a_partial_ssh_frame_untouched() {
        let codec = codec();
        let harness = Harness::new(vec![]);
        let frame = encoded(&codec, "split-buffered-probe");
        let cut = 4 + (frame.len() - 4) / 2;
        harness.send(&frame[..cut]);
        harness.with_reader(|reader| {
            reader.wait_readable(Some(Duration::from_secs(1))).unwrap();
            assert!(reader.try_read_complete_payload(&codec).unwrap().is_none());
        });

        harness.send(&frame[cut..]);
        let reader_codec = codec.clone();
        let payload = harness.with_reader_within(PATIENCE, move |reader| {
            loop {
                if let Some(payload) = reader.try_read_complete_payload(&reader_codec).unwrap() {
                    break payload;
                }
                thread::sleep(Duration::from_millis(1));
            }
        });
        let decoded = codec
            .decode_payload_for_dispatch(&payload)
            .unwrap()
            .into_valid()
            .unwrap();
        assert!(matches!(
            decoded.body,
            FrameBody::Detach(hmux_session_protocol::Detach { reason: Some(reason) })
                if reason == "split-buffered-probe"
        ));
    }

    /// The all-or-nothing contract in the direction that is easy to get wrong:
    /// a channel that dies on a frame boundary left the peer's stream
    /// perfectly parseable, so this is a disconnect and **not** damage.
    ///
    /// An implementation that poisoned on any write failure -- the obvious one
    /// -- reports misalignment here and makes the caller abandon a connection
    /// that a reattach would have recovered.
    #[test]
    fn a_channel_that_dies_on_a_frame_boundary_is_not_misalignment() {
        let codec = codec();
        let first = encoded(&codec, "committed-whole");
        let mut harness = Harness::new(vec![WriteStep::TakeAll, WriteStep::Fail]);

        harness.writer.write_frame(&first).unwrap();
        settle(&harness, first.len());

        let error = write_until_refused(&mut harness);
        assert!(
            !error.desynchronizes_stream(),
            "a boundary failure must not poison the connection, got {error:?}"
        );
        assert!(harness.writer.misalignment_detail().is_none());
        // Whole frames, and only whole frames, reached the channel.
        assert_eq!(*harness.committed.lock().unwrap(), first);
    }

    /// The same contract in the other direction: a channel that dies after
    /// committing part of a frame leaves the peer reading the rest of that
    /// frame as the next frame's length prefix. Nothing later can fix it, so
    /// the writer must refuse everything from here on.
    ///
    /// An implementation that queued bytes and forgot where frames began would
    /// report this exactly like the boundary case above, and let the caller
    /// carry on writing into a stream the peer can no longer parse.
    #[test]
    fn a_channel_that_dies_part_way_through_a_frame_desynchronizes_it() {
        let codec = codec();
        let frame = encoded(&codec, "half-committed");
        let mut harness = Harness::new(vec![WriteStep::Take(5), WriteStep::Fail]);

        harness.writer.write_frame(&frame).unwrap();
        settle(&harness, 5);

        let error = write_until_refused(&mut harness);
        assert!(
            error.desynchronizes_stream(),
            "a mid-frame failure must poison the connection, got {error:?}"
        );
        // The count is evidence rather than inference: five bytes of one frame
        // are on the wire and the rest never will be.
        assert_eq!(*harness.committed.lock().unwrap(), frame[..5]);
        let detail = harness
            .writer
            .misalignment_detail()
            .expect("misalignment records why");
        assert!(detail.contains("5 bytes"), "unexpected detail {detail}");
    }

    /// The property production depends on. A connection is handed to a
    /// dedicated reader thread that is later `join()`ed, so a wake that never
    /// arrives is not a missed event -- it is an app that will not quit.
    ///
    /// There is no `shutdown` to borrow here, which is the whole reason this
    /// transport carries its own wake path.
    #[test]
    fn an_interrupt_wakes_a_reader_that_is_already_blocked() {
        let harness = Harness::new(vec![]);
        let interrupt = Arc::clone(&harness.interrupt);

        let waker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            interrupt.interrupt();
        });

        // Nothing is buffered and no deadline is armed, so without the wake
        // path this blocks forever.
        let error =
            harness.with_reader_within(PATIENCE, |reader| reader.read_frame(&codec()).unwrap_err());
        waker.join().unwrap();

        assert!(matches!(error, TransportError::Interrupted));
        // A deliberate detach is not stream damage. If this poisoned, every
        // ordinary disconnect would be reported as a broken protocol.
        assert!(!error.desynchronizes_stream());
    }

    /// An interrupt raised before the read begins must still be seen. The wake
    /// here is a flag rather than a byte left in a pipe, and a flag that is
    /// only checked on the way into a wait is a flag that gets missed.
    #[test]
    fn an_interrupt_raised_before_the_read_is_still_observed() {
        let harness = Harness::new(vec![]);
        harness.interrupt.interrupt();

        assert!(matches!(
            harness
                .with_reader_within(PATIENCE, |reader| reader.read_frame(&codec()))
                .unwrap_err(),
            TransportError::Interrupted
        ));
    }

    /// A detach must beat buffered data. Otherwise a reader starts one more
    /// frame nobody intends to consume, and observes the interrupt a frame
    /// later -- which on a slow link is a visible hang.
    #[test]
    fn an_interrupt_wins_over_bytes_that_are_already_buffered() {
        let codec = codec();
        let harness = Harness::new(vec![]);

        harness.send(&encoded(&codec, "would-have-decoded"));
        harness.interrupt.interrupt();

        assert!(matches!(
            harness
                .with_reader_within(PATIENCE, move |reader| reader.read_frame(&codec))
                .unwrap_err(),
            TransportError::Interrupted
        ));
    }

    #[test]
    fn an_interrupt_wins_over_a_complete_buffered_payload_probe() {
        let codec = codec();
        let harness = Harness::new(vec![]);

        harness.send(&encoded(&codec, "would-have-been-coalesced"));
        harness.with_reader(|reader| {
            reader.wait_readable(Some(Duration::from_secs(1))).unwrap();
        });
        harness.interrupt.interrupt();

        assert!(matches!(
            harness
                .with_reader(|reader| reader.try_read_complete_payload(&codec))
                .unwrap_err(),
            TransportError::Interrupted
        ));
    }

    /// Both directions can stall at once: a 700 KiB snapshot arriving while a
    /// large paste is still going out. A bridge that serves one direction at a
    /// time deadlocks there, and the app then wedges in the `join()` that stops
    /// its reader thread.
    ///
    /// The outbound write here never completes at all -- the channel models a
    /// window that has closed -- and the inbound stream is several times the
    /// buffer's high-water mark, so this also drives the backpressure
    /// handshake through many rounds of pausing and resuming.
    #[test]
    fn inbound_frames_keep_arriving_while_the_outbound_channel_is_stalled() {
        let codec = codec();
        let mut harness = Harness::new(vec![WriteStep::Stall]);

        harness
            .writer
            .write_frame(&encoded(&codec, "never-lands"))
            .unwrap();

        let rounds = 48;
        let payload = input_frame(&codec, 60 * 1024);
        for _ in 0..rounds {
            harness.send(&payload);
        }

        // The reader is the only thing that can release the pump's
        // backpressure wait, so a lost wake-up surfaces here as a hang.
        let received = harness.with_reader_within(PATIENCE, move |reader| {
            let mut total = 0;
            for _ in 0..rounds {
                match reader.read_frame(&codec).unwrap() {
                    Some(frame) => match &frame.frame().body {
                        FrameBody::Input(input) => total += input.bytes.len(),
                        other => panic!("unexpected body {other:?}"),
                    },
                    None => panic!("the stream ended early"),
                }
            }
            total
        });
        assert_eq!(received, rounds * 60 * 1024);
    }

    /// A remote command that failed says so on stderr and then closes, which
    /// is byte-for-byte what a polite detach looks like. Reporting the first as
    /// the second is what makes `hmux: command not found` present as a working
    /// session that instantly went away.
    #[test]
    fn a_failed_remote_command_is_reported_instead_of_a_clean_close() {
        let harness = Harness::new(vec![]);

        harness
            .events
            .send(ChannelEvent::Diagnostic(
                b"hmux: command not found\n".to_vec(),
            ))
            .unwrap();
        harness.events.send(ChannelEvent::Exited(127)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();

        let error = harness
            .with_reader_within(PATIENCE, |reader| reader.read_frame(&codec()))
            .unwrap_err();
        match error {
            TransportError::Io { source, .. } => {
                let message = source.to_string();
                assert!(message.contains("127"), "unexpected message {message}");
                assert!(
                    message.contains("command not found"),
                    "unexpected message {message}"
                );
            }
            other => panic!("expected an I/O error carrying the reason, got {other:?}"),
        }
    }

    /// A gateway that exits cleanly is an ordinary end of stream and must not
    /// be dressed up as a failure.
    #[test]
    fn a_clean_remote_exit_is_a_clean_close() {
        let harness = Harness::new(vec![]);

        harness.events.send(ChannelEvent::Exited(0)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();

        let outcome = harness
            .with_reader_within(PATIENCE, |reader| reader.read_frame(&codec()))
            .unwrap();
        assert!(outcome.is_none());
    }

    /// `hmux-cli`'s interactive attach polls with a short budget and treats a
    /// timeout as "no frame yet". That contract has to survive the transport
    /// swap, or a quiet moment becomes a fatal error.
    #[test]
    fn a_first_byte_timeout_is_retry_safe_and_leaves_the_stream_usable() {
        let codec = codec();
        let harness = Harness::new(vec![]);

        let error = harness
            .with_reader(|reader| reader.wait_readable(Some(Duration::from_millis(20))))
            .unwrap_err();
        assert!(matches!(error, TransportError::FirstByteTimeout));
        assert!(error.is_retry_safe());
        assert!(!error.desynchronizes_stream());

        harness.send(&encoded(&codec, "later"));
        harness
            .with_reader_within(PATIENCE, |reader| reader.wait_readable(None))
            .unwrap();
        assert_eq!(
            reason_of(
                harness
                    .with_reader(|reader| reader.read_frame(&codec))
                    .unwrap()
            ),
            "later"
        );
    }

    /// A stall that begins after the length prefix has been consumed cannot be
    /// retried, because the consumed bytes cannot be pushed back.
    #[test]
    fn a_stall_after_the_prefix_is_a_completion_timeout() {
        let codec = codec();
        let harness = Harness::new(vec![]);

        harness.send(&encoded(&codec, "half")[..4]);

        let error = harness
            .with_reader_within(PATIENCE, move |reader| {
                reader.set_first_byte_timeout(Some(Duration::from_secs(5)));
                reader.set_completion_timeout(Some(Duration::from_millis(50)));
                reader.read_frame(&codec)
            })
            .unwrap_err();
        assert!(
            matches!(error, TransportError::CompletionTimeout),
            "expected a completion timeout, got {error:?}"
        );
        assert!(error.desynchronizes_stream());
    }
}
