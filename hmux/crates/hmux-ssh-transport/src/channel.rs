//! The narrow slice of an SSH exec channel the frame pump actually needs.
//!
//! The pump is written against this trait pair rather than against `russh`
//! directly, for one reason: the contracts that are hard to get right — a
//! write that is all-or-nothing, a reader that can be woken while blocked,
//! backpressure that does not deadlock — are contracts about *bookkeeping*,
//! not about SSH. A scripted channel can fail after committing five bytes of a
//! frame on demand; a real server cannot be asked to do that reliably, so a
//! test written against a real server would be asserting something weaker than
//! the invariant it claims to protect.

use std::future::Future;
use std::io;

/// Something the far end of the exec channel produced.
///
/// Stream 0 and stream 2 are deliberately different variants rather than one
/// tagged blob. Mixing them is the classic way a diagnostic line ends up
/// parsed as a length prefix.
#[derive(Debug)]
pub enum ChannelEvent {
    /// Stream 0: Hmux frame bytes.
    Data(Vec<u8>),
    /// Stream 2: whatever the remote command wrote to stderr. This is where
    /// `hmux: command not found` shows up, and it is the only thing that
    /// distinguishes "the gateway is not installed" from "the session
    /// detached" — both of which otherwise look like a closed channel.
    Diagnostic(Vec<u8>),
    /// The remote command's exit status.
    Exited(u32),
    /// The remote closed its write half. No further [`Self::Data`] is coming,
    /// but the channel may still report an exit status.
    EndOfData,
    /// The channel itself is finished.
    Ended,
}

/// The read half of an exec channel.
pub trait ExecChannelReader {
    /// Yields the next event, waiting if none has arrived.
    ///
    /// **Must be cancel-safe.** The pump races this against a shutdown
    /// signal, so the returned future is dropped whenever a detach happens
    /// while the channel is idle. An implementation that buffers an event
    /// inside the future rather than in the channel would lose it.
    fn next_event(&mut self) -> impl Future<Output = ChannelEvent>;
}

/// The write half of an exec channel.
pub trait ExecChannelWriter {
    /// Commits some prefix of `bytes` to the channel and reports how much.
    ///
    /// The count is the whole point, and it is why this is not
    /// `write_all`-shaped. The frame writer's all-or-nothing guarantee is
    /// about what the *peer* can still parse, so on failure the pump has to
    /// know whether the failure landed inside a frame or on a boundary. A
    /// call that returns only `Result<(), _>` collapses "nothing went out" and
    /// "half a length prefix went out" into the same value, and the second one
    /// is a protocol-confusion primitive.
    ///
    /// May be dropped before completion — the pump races it against shutdown.
    /// An implementation must not commit bytes it never returned a count for.
    /// After a dropped call the pump never writes again, because a cancelled
    /// write can leave a partially-formed packet queued inside the transport.
    fn write(&mut self, bytes: &[u8]) -> impl Future<Output = io::Result<usize>>;

    /// Signals end-of-write to the peer (channel EOF). The read half stays
    /// open, so replies still in flight are still delivered.
    fn finish(&mut self) -> impl Future<Output = io::Result<()>>;

    /// Closes the channel once the pump is done with it. On a connection
    /// shared with other channels this is what ends the remote command; a
    /// channel that owns its whole connection needs nothing here.
    fn close(&mut self) -> impl Future<Output = ()> {
        async {}
    }
}
