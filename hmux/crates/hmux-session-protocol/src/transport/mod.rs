//! The seam between the Hmux frame protocol and whatever carries its bytes.
//!
//! The protocol itself needs nothing from a Unix socket. Frames are a 4-byte
//! big-endian length prefix followed by that many payload bytes, read with
//! `read_exact`, which loops over short reads — so a pipe or an SSH exec
//! channel that chunks arbitrarily produces byte-identical results to a
//! `SOCK_STREAM` socket. `chunk_split_equivalence_holds_for_every_seed` proves
//! that rather than assuming it.
//!
//! What a socket does provide, and what these traits therefore have to make
//! explicit, is three things a byte stream does not:
//!
//! - **Cancellation.** `shutdown(Shutdown::Both)` wakes a reader blocked in
//!   `read()` from another thread with no shared state. Pipes have no
//!   equivalent, so [`TransportInterrupt`] is a capability each transport
//!   implements rather than a behaviour callers inherit.
//! - **A bounded read.** `SO_RCVTIMEO` bounds one `read`, not one frame. See
//!   [`FrameReader`] for why that distinction needs two separate knobs.
//! - **All-or-nothing writes.** A partially written length-prefixed frame is a
//!   protocol-confusion primitive, not a degraded connection. See
//!   [`FrameWriter::write_frame`].

pub mod memory;

use crate::{DecodedFrame, FrameCodec, FrameCodecError};
use std::fmt;
use std::io;
use std::time::{Duration, Instant};

/// What a completed read produced: a frame, or `None` for a peer that closed
/// cleanly **at a frame boundary**.
///
/// A peer that disappears mid-frame is [`TransportError::Truncated`] instead,
/// because the two mean different things: one is a goodbye, the other leaves
/// the stream unusable. An `Option` rather than a two-variant enum keeps the
/// frame unboxed — the payload is already the largest thing on this path, and
/// boxing it would add an allocation per frame to the hot output loop.
pub type FrameOutcome = Option<DecodedFrame>;

/// What a completed transport read produced before a protocol decoder chooses
/// the document shape.
///
/// The outer transport framing is shared by JSON control frames and negotiated
/// binary terminal-state records. Keeping the payload opaque here prevents the
/// carrier from acquiring either protocol's semantics.
pub type PayloadOutcome = Option<Vec<u8>>;

#[derive(Debug)]
pub enum TransportError {
    /// A deadline expired before the first byte of a frame arrived.
    ///
    /// **Retry-safe**: nothing was consumed, so the caller may poll again.
    /// `hmux-cli`'s interactive attach depends on exactly this — it polls with
    /// a 40ms budget and treats the timeout as "no frame yet".
    FirstByteTimeout,
    /// A bounded write was refused before any byte was admitted.
    ///
    /// **Retry-safe**: the carrier is still frame-aligned and the peer cannot
    /// have observed even a prefix of this frame. This is deliberately
    /// distinct from an arbitrary timed-out [`Self::Io`] error; only a writer
    /// that can prove zero-byte admission may construct it.
    WriteNotStarted,
    /// A deadline expired part-way through a frame.
    ///
    /// **Not** retry-safe. Consumed bytes cannot be pushed back, so the next
    /// read would interpret payload as a length prefix.
    CompletionTimeout,
    /// The peer closed part-way through a frame.
    Truncated,
    /// A local [`TransportInterrupt`] fired. Deliberate, and must never be
    /// treated as stream damage — every detach goes through here.
    Interrupted,
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Codec(FrameCodecError),
}

impl TransportError {
    /// Whether the byte stream can still be trusted to be frame-aligned.
    ///
    /// Callers poison the connection when this is true, which is permanent, so
    /// the bar is "we know bytes were consumed and cannot be pushed back" —
    /// not "an error happened". [`FrameProgress`] decides **by position**
    /// whether a read failure landed inside a frame or at a boundary.
    ///
    /// Only [`Self::CompletionTimeout`] qualifies, and the exclusions are the
    /// interesting part — each was established empirically.
    ///
    /// `Truncated` does **not** qualify, which contradicts the obvious
    /// intuition that a half-read frame is the definition of misalignment. The
    /// difference is who stopped. A completion timeout is *us* giving up with
    /// bytes consumed while the socket is still open, so reading again really
    /// would take payload for a length prefix. A truncation is the *peer*
    /// closing: the stream is gone, there is nothing left to misinterpret, and
    /// the next read fails on its own. Marking it permanently misaligned adds
    /// nothing and breaks callers that expect an ordinary disconnect.
    ///
    /// That is not a theoretical distinction. `test:hmux-scrollback` tears
    /// webviews down and reattaches, which truncates frames as a matter of
    /// course; poisoning on truncation failed it three times running, and a
    /// bisect against the same suite is what narrowed it to this predicate.
    ///
    /// Raw codec I/O errors are excluded for the same reason — `ConnectionReset`
    /// and `BrokenPipe` are what teardown looks like — as is `Interrupted`,
    /// because a detach is not damage.
    #[must_use]
    pub fn desynchronizes_stream(&self) -> bool {
        matches!(self, Self::CompletionTimeout)
    }

    /// Whether the caller may simply try again because no frame bytes moved.
    #[must_use]
    pub fn is_retry_safe(&self) -> bool {
        matches!(self, Self::FirstByteTimeout | Self::WriteNotStarted)
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FirstByteTimeout => {
                write!(formatter, "no Hmux frame arrived before the deadline")
            }
            Self::WriteNotStarted => {
                write!(
                    formatter,
                    "the Hmux frame write was refused before admission"
                )
            }
            Self::CompletionTimeout => write!(
                formatter,
                "an Hmux frame stalled part-way through; the stream is no longer frame-aligned"
            ),
            Self::Truncated => write!(formatter, "the peer closed part-way through an Hmux frame"),
            Self::Interrupted => write!(formatter, "the Hmux transport read was interrupted"),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Codec(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for TransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Codec(error) => Some(error),
            _ => None,
        }
    }
}

/// Reads whole frames off a byte stream.
///
/// The two timeouts are separate on purpose, and the separation is forced by a
/// real call site rather than taste. `wait_readable` bounds time-to-first-byte
/// and is retry-safe. A frame-completion deadline is a different contract: it
/// can only fire once bytes are consumed, so firing it desynchronizes the
/// stream. Collapsing them into one deadline armed on the socket would let
/// `hmux-cli`'s 40ms poll interval fire mid-frame and permanently break a
/// working connection.
pub trait FrameReader: Send {
    /// Blocks until a frame could begin, or `timeout` elapses.
    ///
    /// `None` waits indefinitely. Returns [`TransportError::FirstByteTimeout`]
    /// on expiry, having consumed nothing.
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError>;

    /// Takes one payload only when its complete length-delimited bytes are
    /// already buffered by the carrier. `Ok(None)` consumes nothing.
    ///
    /// This is deliberately stronger than `wait_readable(Duration::ZERO)`,
    /// which proves only that a frame's first byte is ready. A caller using
    /// this method for opportunistic coalescing must never get parked behind a
    /// partial next frame while it is already holding a complete current one.
    /// Carriers that cannot prove complete buffered availability keep the
    /// default and simply decline the optimization.
    fn try_read_complete_payload(
        &mut self,
        _codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        Ok(None)
    }

    /// Reads exactly one length-delimited payload without decoding it.
    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError>;

    /// Reads exactly one JSON control frame.
    ///
    /// Returns a typed outcome rather than an `io::Error` plus a side-channel
    /// "why did we stop" field. That shape had four write sites for one
    /// invariant, and the `WouldBlock` branch was the one that forgot to set
    /// it, turning an ordinary short read into a permanent poison.
    fn read_frame(&mut self, codec: &FrameCodec) -> Result<FrameOutcome, TransportError> {
        self.read_payload(codec)?
            .map(|payload| {
                codec
                    .decode_payload_for_dispatch(&payload)
                    .map_err(TransportError::Codec)
            })
            .transpose()
    }

    /// Bounds a whole frame once its first byte has arrived.
    ///
    /// Separate from `wait_readable` because the two have opposite recovery
    /// semantics. A first-byte timeout consumed nothing and may be retried; a
    /// completion timeout consumed bytes that cannot be pushed back, so the
    /// caller must poison the connection rather than read again. Arming this
    /// without being able to poison is worse than leaving it unbounded.
    fn set_completion_timeout(&mut self, timeout: Option<Duration>);
}

/// Writes whole frames to a byte stream.
pub trait FrameWriter: Send {
    /// Writes one already-encoded frame, **all or nothing**.
    ///
    /// Every implementor must guarantee that a returned `Err` means either
    /// zero bytes reached the wire, or the transport has already marked itself
    /// unusable. A caller that sees an error must be able to conclude the
    /// stream is still frame-aligned, or that it is definitively not — never
    /// "some prefix of a frame is out there".
    ///
    /// Encoding happens outside this call. A frame that fails validation
    /// (an oversized paste, say) emits no bytes and must leave the connection
    /// perfectly usable, so it must not be reachable through the same error
    /// path as a half-written frame.
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError>;

    /// Writes one frame before an absolute deadline.
    ///
    /// Implementations must either enforce `deadline` for the whole admission
    /// or reject the operation before writing any bytes. A timeout after a
    /// prefix reached the carrier must return [`TransportError::CompletionTimeout`].
    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        if deadline.is_none() {
            return self.write_frame(encoded);
        }
        Err(TransportError::WriteNotStarted)
    }

    /// Signals end-of-write to the peer, where the transport has a notion of
    /// one. Readers may still drain what is in flight.
    fn close_write(&mut self) -> Result<(), TransportError>;
}

/// Wakes a reader blocked in [`FrameReader::read_frame`] from another thread.
///
/// On a socket this is `shutdown(Shutdown::Both)`, which needs no shared state
/// because the kernel owns it. Everything else — pipes, SSH channels — has to
/// carry its own wake path, which is the single largest cost of not being able
/// to use a socket for relayed transports.
pub trait TransportInterrupt: Send + Sync {
    fn interrupt(&self);
}

/// Tracks whether the frame currently being read has consumed any bytes.
///
/// This is what makes the first-byte/completion distinction observable.
/// `FrameCodec::read_for_dispatch` performs two `read_exact` calls internally,
/// so a transport cannot tell from the outside whether a failure happened
/// before or after the length prefix landed. Wrapping the underlying reader
/// and recording the first non-empty read answers it.
#[derive(Debug, Default)]
pub struct FrameProgress {
    consumed: bool,
}

impl FrameProgress {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Call at the start of every frame.
    pub fn begin_frame(&mut self) {
        self.consumed = false;
    }

    /// Call with the result of each underlying read.
    pub fn record_read(&mut self, bytes: usize) {
        if bytes > 0 {
            self.consumed = true;
        }
    }

    #[must_use]
    pub fn consumed_current_frame(&self) -> bool {
        self.consumed
    }

    /// Classifies an end-of-stream according to where it happened.
    pub fn classify_eof<T>(&self) -> Result<Option<T>, TransportError> {
        if self.consumed {
            Err(TransportError::Truncated)
        } else {
            Ok(None)
        }
    }

    /// Classifies a deadline expiry according to where it happened. This is
    /// the branch whose omission poisoned healthy connections.
    #[must_use]
    pub fn classify_timeout(&self) -> TransportError {
        if self.consumed {
            TransportError::CompletionTimeout
        } else {
            TransportError::FirstByteTimeout
        }
    }
}

/// Counts bytes on their way through, so the driver can classify a failure by
/// where in the frame it happened without every transport reimplementing it.
struct Tracked<'a, R: ?Sized> {
    inner: &'a mut R,
    progress: &'a mut FrameProgress,
}

impl<R: io::Read + ?Sized> io::Read for Tracked<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.progress.record_read(read);
        Ok(read)
    }
}

/// Shared frame-reading driver.
///
/// Every transport reads frames the same way once it can supply a `Read`; only
/// readiness and cancellation differ. Keeping the classification here — rather
/// than letting each transport reimplement it — is deliberate: the failure
/// this replaces was one branch out of four forgetting to record where it
/// stopped, which turned an ordinary short read into a permanently poisoned
/// connection.
pub fn drive_read_frame<R: io::Read + ?Sized>(
    reader: &mut R,
    progress: &mut FrameProgress,
    codec: &FrameCodec,
) -> Result<FrameOutcome, TransportError> {
    drive_read_payload(reader, progress, codec)?
        .map(|payload| {
            codec
                .decode_payload_for_dispatch(&payload)
                .map_err(TransportError::Codec)
        })
        .transpose()
}

/// Shared payload-reading driver for negotiated non-JSON records.
pub fn drive_read_payload<R: io::Read + ?Sized>(
    reader: &mut R,
    progress: &mut FrameProgress,
    codec: &FrameCodec,
) -> Result<PayloadOutcome, TransportError> {
    progress.begin_frame();
    let result = {
        let mut tracked = Tracked {
            inner: reader,
            progress,
        };
        codec.read_payload(&mut tracked)
    };
    match result {
        Ok(payload) => Ok(Some(payload)),
        Err(FrameCodecError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
            progress.classify_eof()
        }
        Err(FrameCodecError::Io(error)) if error.kind() == io::ErrorKind::TimedOut => {
            Err(progress.classify_timeout())
        }
        Err(error) => Err(TransportError::Codec(error)),
    }
}
