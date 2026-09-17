//! What the blocking transport halves and the async pump both hold.
//!
//! One `Arc<SessionLifetime>` is shared by the reader, the writer and the
//! interrupt handle. When the last of them drops, the SSH session is torn down
//! and the owning I/O thread is joined — which is why the pump itself holds
//! only the inner [`SessionShared`]. If the pump held the lifetime, the
//! refcount could never reach zero, and the only thing that ends the pump is
//! that drop.

use crate::inbound::Inbound;
use crate::outbound::Outbound;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Debug, Default)]
pub(crate) struct SessionShared {
    pub(crate) inbound: Inbound,
    pub(crate) outbound: Outbound,
    shutdown: AtomicBool,
    shutdown_read: Notify,
    shutdown_write: Notify,
    write_admission_timeout: Option<Duration>,
}

impl SessionShared {
    pub(crate) fn new(write_admission_timeout: Option<Duration>) -> Self {
        Self {
            write_admission_timeout,
            ..Self::default()
        }
    }

    pub(crate) fn write_admission_timeout(&self) -> Option<Duration> {
        self.write_admission_timeout
    }

    /// Detach: wake everyone, then stop the pump.
    ///
    /// The writer is woken as well as the reader, even though the trait only
    /// promises to wake a reader. A writer parked on a stalled SSH window is
    /// just as capable of turning a `join()` into a hang, and the caller has no
    /// second handle to reach it with.
    ///
    /// These three steps are not atomic, and nothing downstream may assume they
    /// are. `inbound.interrupt()` notifies before the shutdown flag exists, so
    /// anything waiting on one of these notifications can observe it while the
    /// flag still reads false — that had already stranded the pump's
    /// backpressure wait once. The fix lives at the waits, which race capacity
    /// against `await_read_shutdown` (see `pump::inbound_loop`), rather than
    /// here. Do not "simplify" that by reordering these calls: it makes a
    /// wait's liveness depend on the order of three lines it cannot see, and a
    /// later edit re-inverts it with every test still green.
    pub(crate) fn interrupt(&self) {
        self.inbound.interrupt();
        self.outbound.abandon();
        self.request_shutdown();
    }

    pub(crate) fn request_shutdown(&self) {
        // Ordered before the notifications so that a loop which re-checks the
        // flag on wake can never park again on a stale reading.
        self.shutdown.store(true, Ordering::Release);
        self.shutdown_read.notify_one();
        self.shutdown_write.notify_one();
    }

    pub(crate) fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Acquire)
    }

    /// Resolves once a shutdown has been requested.
    ///
    /// The flag is re-checked around the wait rather than trusted once. A
    /// notification delivered before anyone was waiting is kept as a permit by
    /// `Notify`, and the flag check covers the reverse order, so no sequencing
    /// of the two can leave a loop parked forever.
    pub(crate) async fn await_read_shutdown(&self) {
        while !self.is_shutdown() {
            self.shutdown_read.notified().await;
        }
    }

    pub(crate) async fn await_write_shutdown(&self) {
        while !self.is_shutdown() {
            self.shutdown_write.notified().await;
        }
    }
}

/// Who is running the pump, and so what ending it means.
#[derive(Debug)]
pub(crate) enum PumpOwner {
    /// A thread that owns the runtime and the whole scripted session, as the
    /// unit harness drives it. Joining it ends everything on that thread.
    #[cfg(test)]
    Thread(JoinHandle<()>),
    /// A task on a connection shared with other channels. The receiver's
    /// sender lives in that task; its drop is the pump's end. The connection
    /// stays up for whoever else is on it.
    Task(std::sync::mpsc::Receiver<()>),
}

/// Owns the exec channel for as long as any transport half is alive.
#[derive(Debug)]
pub(crate) struct SessionLifetime {
    shared: Arc<SessionShared>,
    pump: Mutex<Option<PumpOwner>>,
}

impl SessionLifetime {
    #[cfg(test)]
    pub(crate) fn new(shared: Arc<SessionShared>, pump: JoinHandle<()>) -> Arc<Self> {
        Self::owned_by(shared, PumpOwner::Thread(pump))
    }

    pub(crate) fn owned_by(shared: Arc<SessionShared>, pump: PumpOwner) -> Arc<Self> {
        Arc::new(Self {
            shared,
            pump: Mutex::new(Some(pump)),
        })
    }

    pub(crate) fn shared(&self) -> &SessionShared {
        &self.shared
    }
}

impl Drop for SessionLifetime {
    fn drop(&mut self) {
        self.shared.interrupt();
        let owner = self.pump.lock().expect("pump handle lock").take();
        match owner {
            // The pump only ever parks on waits this interrupt has already
            // released, so the join is bounded.
            #[cfg(test)]
            Some(PumpOwner::Thread(handle)) => {
                let _ = handle.join();
            }
            // The pump task ends for the same reason and drops its sender;
            // a connection that went away first dropped it already.
            Some(PumpOwner::Task(finished)) => {
                let _ = finished.recv();
            }
            None => {}
        }
    }
}
