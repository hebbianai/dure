//! Drain existing connection lifetimes after Host or client admission closes.

use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use hmux_host::local_transport::TransportInterrupt;

use crate::{Result, ServerState, lock_attach_gate};

const CONNECTION_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) fn finish_host_connections(
    state: &ServerState,
    accept_thread: JoinHandle<()>,
    socket_path: &Path,
    terminated: bool,
) -> Result<()> {
    let _ = UnixStream::connect(socket_path);
    let _ = accept_thread.join();
    if terminated {
        let _attach = lock_attach_gate(&state.attach_gate);
        for (_, delivery) in state.subscribers.snapshot()? {
            // Final Exit is already queued. Draining the sealed queue interrupts
            // its reader and releases the existing connection worker guard.
            delivery.close();
        }
    }
    // Natural completion retains the existing bounded window for attached
    // clients to receive refused post-exit mutations. Explicit termination
    // closes those connections, but neither path sleeps after workers finish.
    state
        .resources
        .wait_for_connection_workers(CONNECTION_DRAIN_TIMEOUT);
    Ok(())
}

pub(crate) fn finish_subscriber_outbound(
    interrupt: &Arc<dyn TransportInterrupt>,
    outbound_done_rx: mpsc::Receiver<()>,
    outbound: JoinHandle<()>,
    drain_timeout: Duration,
) -> bool {
    let drained = outbound_done_rx.recv_timeout(drain_timeout).is_ok();
    if !drained {
        interrupt.interrupt();
    }
    let _ = outbound.join();
    drained
}
