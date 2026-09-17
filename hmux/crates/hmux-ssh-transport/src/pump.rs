//! The one task that owns the exec channel.
//!
//! Two loops, run concurrently by `join!` rather than raced by `select!`. That
//! is the whole answer to the deadlock a naive bridge has: a 700 KiB snapshot
//! arriving while a client is part-way through a large paste blocks both
//! directions at once if one loop has to finish before the other is served, and
//! the app then wedges in the `join()` that stops its reader thread. Here the
//! inbound loop keeps draining the channel while the outbound loop waits for
//! the SSH window to open, so neither direction can starve the other.
//!
//! Neither loop is ever cancelled mid-write. `select!` appears only around
//! shutdown, and only where a cancelled future is provably harmless — see
//! [`commit_frame`], which treats a cancelled write as a possibly-partial one.

use crate::channel::{ChannelEvent, ExecChannelReader, ExecChannelWriter};
use crate::outbound::OutboundWork;
use crate::shared::SessionShared;

pub(crate) async fn run<R, W>(reader: R, mut writer: W, shared: &SessionShared)
where
    R: ExecChannelReader,
    W: ExecChannelWriter,
{
    tokio::join!(
        inbound_loop(reader, shared),
        outbound_loop(&mut writer, shared)
    );
    // Whatever ended the pump, nothing will feed these again. A blocking
    // reader or writer that is still parked has to be released here, or the
    // owning thread's join never returns.
    shared.inbound.mark_ended();
    shared.outbound.mark_closed("the SSH channel is gone");
    // A detached pane must not leave its gateway running on a connection
    // that stays up for other channels.
    writer.close().await;
}

async fn inbound_loop<R: ExecChannelReader>(mut reader: R, shared: &SessionShared) {
    'events: loop {
        // Backpressure, not buffering: while the application is behind, stop
        // taking from the channel so the SSH window closes and the remote
        // gateway feels it. Nothing is dropped.
        //
        // The wait races shutdown rather than listening for capacity alone,
        // and that is load-bearing. `SessionShared::interrupt` reaches this
        // loop in two steps from another thread -- `inbound.interrupt()` fires
        // the capacity notification, `request_shutdown()` sets the flag -- so a
        // capacity-only wait can consume the notification, find the buffer
        // still full because the detaching reader will never drain it again,
        // and park on a `Notify` nobody will ever signal: the shutdown wake
        // lands on a different one. `SessionLifetime::drop` then blocks in
        // `join()` forever, which is an app that will not quit -- the exact
        // failure this crate's interrupt exists to prevent.
        //
        // Reordering `interrupt`'s two calls would also close it today, and
        // was rejected: it makes this loop's liveness a property of the order
        // of two lines in another module, invisible from here, and a later edit
        // can re-invert it with every test still green. `await_read_shutdown`
        // re-checks the flag inside the future, so no interleaving of the two
        // steps can strand this loop -- and no ordering discipline is required
        // to keep that true.
        while shared.inbound.is_over_high_water() {
            tokio::select! {
                () = shared.inbound.wait_for_capacity() => {}
                () = shared.await_read_shutdown() => break 'events,
            }
        }
        if shared.is_shutdown() {
            break;
        }
        let event = tokio::select! {
            event = reader.next_event() => event,
            () = shared.await_read_shutdown() => break,
        };
        if !apply_event(event, shared) {
            break;
        }
    }
    shared.inbound.mark_ended();
}

/// Applies one channel event. Returns whether the channel is still live.
///
/// Separate from the loop because the exec confirmation can consume events
/// before the pump starts, and an event dropped there is a frame the peer
/// believes it sent.
pub(crate) fn apply_event(event: ChannelEvent, shared: &SessionShared) -> bool {
    match event {
        ChannelEvent::Data(bytes) => shared.inbound.push_data(bytes),
        ChannelEvent::Diagnostic(bytes) => shared.inbound.push_diagnostic(&bytes),
        ChannelEvent::Exited(status) => shared.inbound.set_exit_status(status),
        // Deliberately not a reason to stop reading. The exit status and the
        // last of stderr usually arrive *after* the remote closes its write
        // half, and they are the only things that distinguish "the gateway is
        // not installed" from "the session detached".
        ChannelEvent::EndOfData => shared.inbound.mark_end_of_data(),
        ChannelEvent::Ended => return false,
    }
    true
}

async fn outbound_loop<W: ExecChannelWriter>(writer: &mut W, shared: &SessionShared) {
    loop {
        match shared.outbound.next_work() {
            OutboundWork::Stop => break,
            OutboundWork::Idle => {
                tokio::select! {
                    () = shared.outbound.wait_for_work() => {}
                    () = shared.await_write_shutdown() => break,
                }
            }
            OutboundWork::Finish => {
                match writer.finish().await {
                    Ok(()) => shared
                        .outbound
                        .mark_closed("the Hmux SSH write half was closed"),
                    Err(error) => shared
                        .outbound
                        .mark_closed(&format!("closing the SSH write half failed: {error}")),
                }
                break;
            }
            OutboundWork::Frame(frame) => {
                if !commit_frame(writer, &frame, shared).await {
                    break;
                }
            }
        }
    }
}

/// Puts one whole frame on the channel, counting what was accepted.
///
/// Returns whether the write half is still usable. The count is the reason this
/// is not a `write_all`: failing at offset zero leaves the peer's stream
/// frame-aligned and is an ordinary disconnect, while failing at any other
/// offset means the peer will read the rest of this frame as the next frame's
/// length prefix. Only the second one may poison a connection, and only by
/// distinguishing them can a dropped connection avoid being reported as
/// protocol damage.
async fn commit_frame<W: ExecChannelWriter>(
    writer: &mut W,
    frame: &[u8],
    shared: &SessionShared,
) -> bool {
    let mut committed = 0;
    while committed < frame.len() {
        let outcome = tokio::select! {
            result = writer.write(&frame[committed..]) => result,
            () = shared.await_write_shutdown() => {
                // A cancelled write may have left a partially formed packet
                // inside the transport, so this counts as mid-frame even
                // though nothing here observed a byte leaving. Conservative in
                // the only direction that is safe: over-reporting misalignment
                // costs a reattach, under-reporting corrupts the peer's stream.
                shared.outbound.record_frame_failure(
                    committed,
                    "the Hmux SSH transport was interrupted".to_string(),
                );
                return false;
            }
        };
        match outcome {
            Ok(0) => {
                shared.outbound.record_frame_failure(
                    committed,
                    "the SSH channel stopped accepting bytes".to_string(),
                );
                return false;
            }
            Ok(accepted) => committed += accepted,
            Err(error) => {
                shared
                    .outbound
                    .record_frame_failure(committed, format!("the SSH channel failed: {error}"));
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::within;
    use std::io;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    const PATIENCE: Duration = Duration::from_secs(10);

    /// Comfortably past `INBOUND_HIGH_WATER`, so a single event is enough to
    /// put the pump into the backpressure wait.
    const BURST_BYTES: usize = 3 * 1024 * 1024;

    /// One oversized burst, then silence -- a gateway that pushed a snapshot at
    /// a client which has stopped reading.
    struct OneBurst {
        burst: Option<Vec<u8>>,
    }

    impl ExecChannelReader for OneBurst {
        async fn next_event(&mut self) -> ChannelEvent {
            match self.burst.take() {
                Some(bytes) => ChannelEvent::Data(bytes),
                None => std::future::pending().await,
            }
        }
    }

    /// An SSH window that never opens again.
    struct NeverAccepts;

    impl ExecChannelWriter for NeverAccepts {
        async fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            std::future::pending().await
        }

        async fn finish(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Blocks until the burst is buffered and the pump has had time to park on
    /// it. The mark is crossed inside `push_data`, one statement before the
    /// pump reaches the wait, so observing it is not on its own proof that the
    /// pump is parked.
    fn settle_over_high_water(shared: &SessionShared) {
        for _ in 0..400 {
            if shared.inbound.is_over_high_water() {
                thread::sleep(Duration::from_millis(50));
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("the pump never took the burst");
    }

    /// A detach has to reach the pump even though it arrives in two steps.
    ///
    /// `SessionShared::interrupt` notifies capacity first and sets the shutdown
    /// flag second. Between the two the pump can consume the notification, find
    /// the buffer still over the mark -- nothing drains it, the reader is
    /// detaching -- and park again on a notification that will never come.
    /// `SessionLifetime::drop` then hangs in `join()`.
    ///
    /// The two steps are driven by hand, with a pause between them, because in
    /// production the window between them is nanoseconds wide. Waiting for the
    /// interleaving to occur on its own would be a test that passes for
    /// scheduling reasons rather than for the reason it claims, and the fix it
    /// is meant to hold in place would be free to regress.
    #[test]
    fn a_capacity_wake_before_the_shutdown_flag_does_not_strand_the_pump() {
        let shared = Arc::new(SessionShared::new(None));

        let pump_shared = Arc::clone(&shared);
        let pump = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("pump runtime");
            runtime.block_on(run(
                OneBurst {
                    burst: Some(vec![0_u8; BURST_BYTES]),
                },
                NeverAccepts,
                &pump_shared,
            ));
        });
        settle_over_high_water(&shared);

        // `SessionShared::interrupt`, step one: the capacity notification.
        shared.inbound.interrupt();
        // Long enough for the pump to have consumed it and decided what to do
        // next, which is the decision under test.
        thread::sleep(Duration::from_millis(100));
        // Step two: the flag, and the wake that goes with it.
        shared.request_shutdown();

        // The pump owns the SSH session and the runtime, so a pump that does
        // not end is a connection that is never closed and a thread that is
        // never joined.
        within(PATIENCE, move || pump.join().expect("pump thread"));
    }
}
