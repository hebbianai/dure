//! An in-memory transport, so protocol behaviour can be tested without a
//! socket, a process, or a PTY.
//!
//! Two things this buys that a socket cannot. It runs on every target,
//! including the ones a mobile client would build for, where a discovery path
//! and a same-kernel pid mean nothing. And it can chop the byte stream at
//! arbitrary, reproducible boundaries — which is how the claim that framing
//! survives a relay stops being an assumption.
//!
//! It never produces a colocation attestation. A memory duplex proves nothing
//! about a peer, and offering callers a way to attach one would hand back the
//! forgery the attestation types exist to prevent.

#[cfg(test)]
use super::FrameOutcome;
use super::{FrameProgress, FrameReader, FrameWriter, PayloadOutcome, TransportError};
use crate::FrameCodec;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How the reader chops the stream it is handed.
#[derive(Clone, Copy, Debug)]
pub enum ChunkPlan {
    /// Hand over everything available in one read.
    Whole,
    /// Hand over pseudo-random slices derived from a seed. Deterministic, so a
    /// failure reproduces from the seed alone.
    Seeded(u64),
}

impl ChunkPlan {
    fn next_len(&mut self, available: usize) -> usize {
        match self {
            Self::Whole => available,
            Self::Seeded(state) => {
                // xorshift64*, inlined to avoid a dependency for one test knob.
                let mut value = if *state == 0 {
                    0x9E37_79B9_7F4A_7C15
                } else {
                    *state
                };
                value ^= value << 13;
                value ^= value >> 7;
                value ^= value << 17;
                *state = value;
                1 + usize::try_from(value % 7)
                    .unwrap_or(0)
                    .min(available.saturating_sub(1))
            }
        }
    }
}

#[derive(Debug, Default)]
struct Pipe {
    bytes: VecDeque<u8>,
    write_closed: bool,
}

/// One end of an in-memory byte pipe.
#[derive(Debug)]
pub struct MemoryEndpoint {
    inbound: Arc<Mutex<Pipe>>,
    outbound: Arc<Mutex<Pipe>>,
    chunk: ChunkPlan,
}

impl MemoryEndpoint {
    /// A connected pair that hands over whole reads.
    #[must_use]
    pub fn pair() -> (Self, Self) {
        Self::with_plan(ChunkPlan::Whole, ChunkPlan::Whole)
    }

    /// A connected pair whose reader chops the stream by `seed`.
    #[must_use]
    pub fn chunked(seed: u64) -> (Self, Self) {
        Self::with_plan(ChunkPlan::Seeded(seed), ChunkPlan::Seeded(seed ^ 0xFFFF))
    }

    fn with_plan(left_plan: ChunkPlan, right_plan: ChunkPlan) -> (Self, Self) {
        let left_to_right = Arc::new(Mutex::new(Pipe::default()));
        let right_to_left = Arc::new(Mutex::new(Pipe::default()));
        (
            Self {
                inbound: Arc::clone(&right_to_left),
                outbound: Arc::clone(&left_to_right),
                chunk: left_plan,
            },
            Self {
                inbound: left_to_right,
                outbound: right_to_left,
                chunk: right_plan,
            },
        )
    }

    /// Drops the remaining inbound bytes, modelling a peer that vanished
    /// mid-frame rather than closing cleanly.
    pub fn truncate_inbound_after(&mut self, keep: usize) {
        let mut pipe = self.inbound.lock().expect("memory pipe lock");
        pipe.bytes.truncate(keep);
        pipe.write_closed = true;
    }
}

impl Read for MemoryEndpoint {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut pipe = self.inbound.lock().expect("memory pipe lock");
        if pipe.bytes.is_empty() {
            if pipe.write_closed {
                return Ok(0);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "memory transport has no buffered bytes",
            ));
        }
        let available = pipe.bytes.len().min(buffer.len());
        let take = self.chunk.next_len(available).min(available).max(1);
        for slot in buffer.iter_mut().take(take) {
            *slot = pipe.bytes.pop_front().expect("length was checked");
        }
        Ok(take)
    }
}

impl Write for MemoryEndpoint {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut pipe = self.outbound.lock().expect("memory pipe lock");
        if pipe.write_closed {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "memory transport write half is closed",
            ));
        }
        pipe.bytes.extend(buffer.iter().copied());
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl FrameReader for MemoryEndpoint {
    fn wait_readable(&mut self, _timeout: Option<Duration>) -> Result<(), TransportError> {
        let pipe = self.inbound.lock().expect("memory pipe lock");
        if pipe.bytes.is_empty() && !pipe.write_closed {
            return Err(TransportError::FirstByteTimeout);
        }
        Ok(())
    }

    fn set_completion_timeout(&mut self, _timeout: Option<Duration>) {
        // A memory pipe hands over whatever is buffered immediately, so an
        // absent byte is already reported as a stall. There is no clock to
        // arm against.
    }

    fn try_read_complete_payload(
        &mut self,
        codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        let complete = {
            let pipe = self.inbound.lock().expect("memory pipe lock");
            complete_payload_is_buffered(pipe.bytes.iter().copied(), pipe.bytes.len(), codec)
        };
        if !complete {
            return Ok(None);
        }
        self.read_payload(codec)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        let mut progress = FrameProgress::new();
        super::drive_read_payload(self, &mut progress, codec)
    }
}

fn complete_payload_is_buffered(
    mut bytes: impl Iterator<Item = u8>,
    buffered: usize,
    codec: &FrameCodec,
) -> bool {
    let mut prefix = [0_u8; 4];
    for slot in &mut prefix {
        let Some(byte) = bytes.next() else {
            return false;
        };
        *slot = byte;
    }
    let declared = usize::try_from(u32::from_be_bytes(prefix))
        .expect("u32 always fits usize on supported hosts");
    declared > 0
        && declared <= codec.limits().max_frame_bytes
        && buffered >= 4_usize.saturating_add(declared)
}

impl FrameWriter for MemoryEndpoint {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        // A memory pipe is unbounded, so a write either takes everything or
        // the peer is gone. The all-or-nothing contract holds trivially here;
        // transports with real backpressure have to work for it.
        let mut pipe = self.outbound.lock().expect("memory pipe lock");
        if pipe.write_closed {
            return Err(TransportError::Io {
                operation: "write Hmux frame to memory transport",
                source: io::Error::new(io::ErrorKind::BrokenPipe, "write half is closed"),
            });
        }
        pipe.bytes.extend(encoded.iter().copied());
        Ok(())
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(TransportError::WriteNotStarted);
        }
        self.write_frame(encoded)
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.outbound.lock().expect("memory pipe lock").write_closed = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FrameBody, FrameLimits, PROTOCOL_V1, WireFrame};

    fn codec() -> FrameCodec {
        FrameCodec::new(FrameLimits::default())
    }

    fn frame(reason: &str) -> WireFrame {
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::Detach(crate::Detach {
                reason: Some(reason.to_string()),
            }),
        }
    }

    fn decoded_reason(outcome: FrameOutcome) -> String {
        let Some(frame) = outcome else {
            panic!("expected a frame, got a clean close");
        };
        match &frame.frame().body {
            FrameBody::Detach(detach) => detach.reason.clone().unwrap_or_default(),
            other => panic!("unexpected body {other:?}"),
        }
    }

    #[test]
    fn opaque_binary_payload_and_following_json_frame_stay_aligned() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::chunked(17);
        let payload = b"TSPB\0\x02terminal-state";
        let mut encoded = Vec::with_capacity(4 + payload.len());
        encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        encoded.extend_from_slice(payload);
        writer.write_frame(&encoded).unwrap();
        writer
            .write_frame(&codec.encode(&frame("after-binary")).unwrap())
            .unwrap();

        assert_eq!(
            reader.read_payload(&codec).unwrap().as_deref(),
            Some(payload.as_slice())
        );
        assert_eq!(
            decoded_reason(reader.read_frame(&codec).unwrap()),
            "after-binary"
        );
    }

    #[test]
    fn buffered_payload_probe_leaves_a_partial_memory_frame_untouched() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::pair();
        let encoded = codec.encode(&frame("split-memory")).unwrap();
        let cut = 4 + (encoded.len() - 4) / 2;
        writer.write_all(&encoded[..cut]).unwrap();

        assert!(reader.try_read_complete_payload(&codec).unwrap().is_none());
        writer.write_all(&encoded[cut..]).unwrap();
        let payload = reader
            .try_read_complete_payload(&codec)
            .unwrap()
            .expect("the complete memory payload is ready");
        let decoded = codec
            .decode_payload_for_dispatch(&payload)
            .unwrap()
            .into_valid()
            .unwrap();
        assert!(matches!(
            decoded.body,
            FrameBody::Detach(crate::Detach { reason: Some(reason) })
                if reason == "split-memory"
        ));
    }

    /// The claim the relay rests on: the wire format survives arbitrary
    /// chunking, because a pipe and an SSH channel do not preserve the write
    /// boundaries a socket happens to.
    #[test]
    fn chunk_split_equivalence_holds_for_every_seed() {
        let codec = codec();
        for seed in 1..40_u64 {
            let (mut writer, mut reader) = MemoryEndpoint::chunked(seed);
            for index in 0..5 {
                let encoded = codec.encode(&frame(&format!("frame-{index}"))).unwrap();
                writer.write_frame(&encoded).unwrap();
            }
            for index in 0..5 {
                let outcome = reader.read_frame(&codec).unwrap();
                assert_eq!(
                    decoded_reason(outcome),
                    format!("frame-{index}"),
                    "seed {seed} lost frame alignment"
                );
            }
        }
    }

    #[test]
    fn a_clean_close_at_a_frame_boundary_is_not_damage() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::pair();
        let encoded = codec.encode(&frame("only")).unwrap();
        writer.write_frame(&encoded).unwrap();
        writer.close_write().unwrap();

        assert_eq!(decoded_reason(reader.read_frame(&codec).unwrap()), "only");
        assert!(reader.read_frame(&codec).unwrap().is_none());
    }

    /// A peer that vanishes mid-frame leaves the stream unusable, and must be
    /// reported differently from one that closed politely.
    #[test]
    fn a_close_part_way_through_a_frame_is_truncation() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::pair();
        let encoded = codec.encode(&frame("cut-short")).unwrap();
        writer.write_frame(&encoded).unwrap();
        reader.truncate_inbound_after(encoded.len() - 3);

        let error = reader.read_frame(&codec).unwrap_err();
        assert!(matches!(error, TransportError::Truncated));
        assert!(!error.is_retry_safe());
        // Reported distinctly from a clean close, but NOT as misalignment: the
        // peer is gone, so there is no stream left to misinterpret. See
        // `desynchronizes_stream`.
        assert!(!error.desynchronizes_stream());
    }

    /// Nothing consumed means the caller may poll again — the contract
    /// `hmux-cli`'s interactive attach loop depends on.
    #[test]
    fn a_stall_before_the_first_byte_is_retry_safe() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::pair();

        let error = reader.read_frame(&codec).unwrap_err();
        assert!(matches!(error, TransportError::FirstByteTimeout));
        assert!(error.is_retry_safe());
        assert!(!error.desynchronizes_stream());

        // ...and the connection is genuinely still usable afterwards.
        let encoded = codec.encode(&frame("after-poll")).unwrap();
        writer.write_frame(&encoded).unwrap();
        assert_eq!(
            decoded_reason(reader.read_frame(&codec).unwrap()),
            "after-poll"
        );
    }

    /// A stall *after* the length prefix landed cannot be retried, because the
    /// consumed bytes cannot be pushed back.
    #[test]
    fn a_stall_part_way_through_a_frame_is_not_retry_safe() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::pair();
        let encoded = codec.encode(&frame("half-sent")).unwrap();
        writer.write_frame(&encoded[..6]).unwrap();

        let error = reader.read_frame(&codec).unwrap_err();
        assert!(
            matches!(error, TransportError::CompletionTimeout),
            "expected a completion timeout, got {error:?}"
        );
        assert!(error.desynchronizes_stream());
        assert!(!error.is_retry_safe());
    }

    #[test]
    fn an_expired_write_deadline_refuses_the_frame_before_admission() {
        let (mut writer, mut reader) = MemoryEndpoint::pair();

        let error = writer
            .write_frame_before(b"refused", Some(Instant::now()))
            .unwrap_err();

        assert!(matches!(&error, TransportError::WriteNotStarted));
        assert!(error.is_retry_safe());
        assert!(matches!(
            reader.wait_readable(Some(Duration::ZERO)),
            Err(TransportError::FirstByteTimeout)
        ));
    }

    /// A frame that fails validation must emit nothing and leave the writer
    /// perfectly usable.
    ///
    /// The motivating case is ordinary: `max_input_bytes` is 64 KiB and the
    /// desktop sends a paste as one Input frame with no chunking, so pasting a
    /// large log produces a frame that `encode` rejects. If that shared an
    /// error path with a half-written frame, the pane would be dead until the
    /// user reattached — and the message would blame a partial write that
    /// never happened.
    #[test]
    fn a_frame_rejected_before_any_bytes_are_written_leaves_the_writer_usable() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::pair();

        let oversized = "x".repeat(100_000);
        assert!(
            codec.encode(&frame(&oversized)).is_err(),
            "expected a 100 KB payload to be refused by validation"
        );

        // Nothing reached the wire, so the very next frame must work.
        let encoded = codec.encode(&frame("still-fine")).unwrap();
        writer.write_frame(&encoded).unwrap();
        assert_eq!(
            decoded_reason(reader.read_frame(&codec).unwrap()),
            "still-fine"
        );
    }

    #[test]
    fn wait_readable_reports_an_empty_stream_without_consuming_it() {
        let codec = codec();
        let (mut writer, mut reader) = MemoryEndpoint::pair();

        assert!(matches!(
            reader.wait_readable(Some(Duration::from_millis(1))),
            Err(TransportError::FirstByteTimeout)
        ));

        let encoded = codec.encode(&frame("now-ready")).unwrap();
        writer.write_frame(&encoded).unwrap();
        reader.wait_readable(None).unwrap();
        assert_eq!(
            decoded_reason(reader.read_frame(&codec).unwrap()),
            "now-ready"
        );
    }
}
