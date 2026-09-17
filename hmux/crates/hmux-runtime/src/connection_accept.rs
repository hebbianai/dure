//! The Host listener owns connection admission independently of each worker.

use std::io;
use std::net::Shutdown;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::{
    RuntimeDiagnosticEvent, RuntimeDiagnosticFields, ServerState, reject_overloaded_connection,
    runtime_log, serve_client,
};

pub(crate) fn accept_loop(
    listener: UnixListener,
    state: Arc<ServerState>,
    capability_token: String,
) {
    let mut retry_delay = Duration::ZERO;
    loop {
        if state.stopped.lock().is_ok_and(|stopped| *stopped) {
            break;
        }
        match accept_connection(&listener) {
            Ok((stream, _)) => {
                #[cfg(debug_assertions)]
                if std::env::var_os("HMUX_RUNTIME_TEST_LISTENER_EXIT")
                    .is_some_and(|marker| std::fs::remove_file(marker).is_ok())
                {
                    // Reproduce a legacy Host whose listener exited while its
                    // provider stayed alive. Only disposable test Hosts opt in.
                    drop(stream);
                    return;
                }
                if state.stopped.lock().map_or(true, |stopped| *stopped) {
                    let _ = stream.shutdown(Shutdown::Both);
                    break;
                }
                if !retry_delay.is_zero() {
                    state.diagnostics.record(
                        RuntimeDiagnosticEvent::ListenerRecovered,
                        RuntimeDiagnosticFields::transport("accepting"),
                    );
                    retry_delay = Duration::ZERO;
                }
                let permit = match state.resources.try_acquire_pending() {
                    Ok(permit) => permit,
                    Err(rejection) => {
                        reject_overloaded_connection(stream, &state, rejection);
                        continue;
                    }
                };
                let connection_state = Arc::clone(&state);
                let token = capability_token.clone();
                let worker = state.resources.connection_worker_started();
                if let Err(error) = spawn_connection_worker(move || {
                    let _worker = worker;
                    let diagnostics = connection_state.diagnostics.clone();
                    let resources = Arc::clone(&connection_state.resources);
                    diagnostics.record(
                        RuntimeDiagnosticEvent::ConnectionAccepted,
                        RuntimeDiagnosticFields::transport("accepted")
                            .with_resources(resources.snapshot()),
                    );
                    if let Err(error) = serve_client(stream, connection_state, &token, permit) {
                        diagnostics.record(
                            RuntimeDiagnosticEvent::AttachFailed,
                            RuntimeDiagnosticFields::attach_failed("transport_error")
                                .with_resources(resources.snapshot()),
                        );
                        runtime_log(&format!("client connection failed: {error}"));
                    }
                }) {
                    // The failed handoff drops this stream and its admission
                    // guards. It must not unwind the owner of the listener.
                    state.diagnostics.record(
                        RuntimeDiagnosticEvent::ConnectionRejected,
                        RuntimeDiagnosticFields::attach_failed("connection_worker_unavailable")
                            .with_resources(state.resources.snapshot()),
                    );
                    runtime_log(&format!("client worker could not start: {error}"));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                // An accept failure does not invalidate the owned listener or
                // the running PTY. Keep both through resource pressure and
                // aborted connections; only Host shutdown retires this owner.
                // Bound CPU and diagnostics during a prolonged failure episode.
                if retry_delay.is_zero() {
                    state.diagnostics.record(
                        RuntimeDiagnosticEvent::ListenerDegraded,
                        RuntimeDiagnosticFields::listener_accept_failed(&error)
                            .with_resources(state.resources.snapshot()),
                    );
                    runtime_log(&format!("listener accept failed; retaining Host: {error}"));
                }
                retry_delay =
                    (retry_delay * 2).clamp(Duration::from_millis(50), Duration::from_secs(1));
                thread::sleep(retry_delay);
            }
        }
    }
}

fn accept_connection(listener: &UnixListener) -> io::Result<(UnixStream, SocketAddr)> {
    let connection = listener.accept()?;
    #[cfg(debug_assertions)]
    if let Some(marker) = std::env::var_os("HMUX_RUNTIME_TEST_ACCEPT_FAILURE") {
        let marker = std::path::PathBuf::from(marker);
        if let Ok(remaining) = std::fs::read_to_string(&marker) {
            let remaining: usize = remaining.trim().parse().unwrap_or(1);
            if remaining > 1 {
                let _ = std::fs::write(&marker, (remaining - 1).to_string());
            } else {
                let _ = std::fs::remove_file(&marker);
            }
            // Inject the accept result in this disposable Host only. Do not
            // exhaust descriptors or change limits shared by its PTY workers.
            let error = io::Error::from_raw_os_error(libc::EMFILE);
            let _ = std::fs::write(
                marker.with_extension("observed"),
                format!("{remaining}: {error}"),
            );
            return Err(error);
        }
    }
    Ok(connection)
}

pub(crate) fn configure_accept_listener(listener: &UnixListener) -> io::Result<()> {
    listener.set_nonblocking(false)
}

fn spawn_connection_worker(work: impl FnOnce() + Send + 'static) -> io::Result<JoinHandle<()>> {
    let builder = thread::Builder::new();
    #[cfg(all(debug_assertions, target_pointer_width = "64"))]
    if let Some(marker) = std::env::var_os("HMUX_RUNTIME_TEST_CONNECTION_WORKER_PANIC") {
        // Consume the marker so exactly one worker panics in this disposable
        // Host. The panic exercises the Host's own panic evidence path.
        if std::fs::remove_file(marker).is_ok() {
            return builder
                .name("connection-worker-panic-fixture".into())
                .spawn(|| {
                    panic!("fault-injected Host connection worker panic");
                });
        }
    }
    #[cfg(all(debug_assertions, target_pointer_width = "64"))]
    if let Some(marker) = std::env::var_os("HMUX_RUNTIME_TEST_CONNECTION_WORKER_FAILURE") {
        let marker = std::path::PathBuf::from(marker);
        if std::fs::remove_file(&marker).is_ok() {
            // Ask the OS for an impossible address-space reservation in this
            // disposable Host only. This exercises a real spawn error without
            // exhausting machine resources or altering any process limit.
            let result = builder.stack_size(1 << 60).spawn(work);
            if let Err(error) = &result {
                let _ = std::fs::write(marker.with_extension("observed"), error.to_string());
            }
            return result;
        }
    }
    builder.spawn(work)
}
