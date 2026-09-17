//! Keep the native TUI and its auxiliary clients on one official app-server.
//! Hmux still owns the provider process tree, terminal and admitted runtime state.

mod descendants;
mod diagnostics;
mod lifecycle;
#[cfg(test)]
mod tests;

use super::*;
use hmux_client::{
    AgentStateReportOutcome, ManagedAgentStateReporter, ManagedAttachRequest, SessionFence,
};
use lifecycle::Lifecycle;
use std::sync::Arc;
use tokio::{sync::Mutex, task::JoinSet};

struct Options {
    runtime: PathBuf,
    executable: OsString,
    arguments: Vec<OsString>,
}

struct ManagedLifecycle {
    reporter: ManagedAgentStateReporter,
    request: ManagedAttachRequest,
    fence: SessionFence,
    diagnostics: Option<diagnostics::Diagnostics>,
    projection: Lifecycle,
    recovery: Option<Recovery>,
    recovery_changed: Arc<tokio::sync::Notify>,
}

struct Recovery {
    after: Instant,
    delay: Duration,
}

impl Options {
    fn parse(mut args: impl Iterator<Item = OsString>) -> Result<Self, CodexConnectionDriverError> {
        if args.next().as_deref() != Some(std::ffi::OsStr::new("--runtime")) {
            return Err(CodexConnectionDriverError::new("arguments_invalid"));
        }
        let runtime = args
            .next()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?;
        if args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
            return Err(CodexConnectionDriverError::new("arguments_invalid"));
        }
        let executable = args
            .next()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?;
        Ok(Self {
            runtime,
            executable,
            arguments: args.collect(),
        })
    }

    fn server_arguments(&self) -> Result<Vec<OsString>, CodexConnectionDriverError> {
        let mut result = Vec::new();
        let mut args = self.arguments.iter();
        while let Some(argument) = args.next() {
            match argument.to_str() {
                Some("-c" | "--config" | "--enable" | "--disable") => {
                    result.push(argument.clone());
                    result.push(
                        args.next()
                            .cloned()
                            .ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?,
                    );
                }
                Some(value)
                    if value.starts_with("--config=")
                        || value.starts_with("-c=")
                        || value.starts_with("--enable=")
                        || value.starts_with("--disable=") =>
                {
                    result.push(argument.clone());
                }
                Some("--remote" | "--remote-auth-token-env") => {
                    return Err(CodexConnectionDriverError::new("native_endpoint_owned"));
                }
                Some(value)
                    if value.starts_with("--remote=")
                        || value.starts_with("--remote-auth-token-env=") =>
                {
                    return Err(CodexConnectionDriverError::new("native_endpoint_owned"));
                }
                Some("--") => break,
                _ => {}
            }
        }
        Ok(result)
    }
}

fn fence() -> Result<SessionFence, CodexConnectionDriverError> {
    let read = |key: &str| {
        std::env::var(key).map_err(|_| CodexConnectionDriverError::new("native_fence_missing"))
    };
    Ok(SessionFence {
        session_id: read("HMUX_SESSION_ID")?,
        workspace_id: read("HMUX_WORKSPACE_ID")?,
        runner_principal: read("HMUX_RUNNER_PRINCIPAL")?,
        runner_instance: read("HMUX_RUNNER_INSTANCE")?,
        channel_epoch: read("HMUX_CHANNEL_EPOCH")?
            .parse()
            .map_err(|_| CodexConnectionDriverError::new("native_fence_invalid"))?,
        host_instance_id: read("HMUX_HOST_INSTANCE_ID")?,
        terminal_epoch: read("HMUX_TERMINAL_EPOCH")?,
    })
}

pub async fn run_from_arguments(
    args: impl Iterator<Item = OsString>,
) -> Result<(), CodexConnectionDriverError> {
    let options = Options::parse(args)?;
    let fence = fence()?;
    let request = ManagedAttachRequest::new(&fence.session_id, &fence.workspace_id)
        .map_err(|_| CodexConnectionDriverError::new("native_fence_invalid"))?;
    let cwd = std::env::current_dir()
        .map_err(|_| CodexConnectionDriverError::new("native_cwd_unavailable"))?;
    let mut reporter = ManagedAgentStateReporter::new(&options.runtime, &cwd);
    if let Some(root) = std::env::var_os("HMUX_DISCOVERY_ROOT") {
        reporter = reporter.with_discovery_root(root);
    }
    let directory = tempfile::Builder::new()
        .prefix("dure-codex-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .map_err(|_| CodexConnectionDriverError::new("native_socket_directory_failed"))?;
    let endpoint = directory.path().join("client.sock");
    let upstream_path = directory.path().join("server.sock");
    validate_socket_target(&endpoint)?;
    validate_socket_target(&upstream_path)?;
    let listener = bind_endpoint(&endpoint)?;
    let diagnostics = diagnostics::Diagnostics::open(directory.path()).ok();
    let mut server = Command::new(&options.executable)
        .arg("app-server")
        .args(options.server_arguments()?)
        .arg("--listen")
        .arg(format!("unix://{}", upstream_path.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| CodexConnectionDriverError::new("upstream_launch_failed"))?;
    let result = async {
        let upstream = connect_upstream(&upstream_path, &mut server).await?;
        let mut tui = Command::new(&options.executable)
            .arg("--remote")
            .arg(format!("unix://{}", endpoint.display()))
            .args(&options.arguments)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| CodexConnectionDriverError::new("native_tui_launch_failed"))?;
        let result = serve(
            listener,
            upstream_path,
            upstream,
            &mut server,
            &mut tui,
            ManagedLifecycle {
                reporter,
                request,
                fence,
                diagnostics,
                projection: Lifecycle::default(),
                recovery: None,
                recovery_changed: Arc::default(),
            },
        )
        .await;
        if tui.try_wait().ok().flatten().is_none() {
            let _ = tui.kill().await;
        }
        let _ = tui.wait().await;
        result
    }
    .await;
    if server.try_wait().ok().flatten().is_none() {
        let _ = server.kill().await;
    }
    let _ = server.wait().await;
    result
}

async fn serve(
    listener: UnixListener,
    upstream_path: PathBuf,
    upstream: Socket,
    server: &mut Child,
    tui: &mut Child,
    lifecycle: ManagedLifecycle,
) -> Result<(), CodexConnectionDriverError> {
    let lifecycle = Arc::new(Mutex::new(lifecycle));
    let mut connections = JoinSet::new();
    let mut first_upstream = Some(upstream);
    let mut connection = 0;
    let result = async {
        loop {
            tokio::select! {
                status = server.wait() => return child_exited(status),
                status = tui.wait() => return tui_exited(status),
                accepted = listener.accept() => {
                    let (stream, _) = accepted
                        .map_err(|_| CodexConnectionDriverError::new("endpoint_accept_failed"))?;
                    connection += 1;
                    let connection = connection;
                    let upstream = first_upstream.take();
                    let upstream_path = upstream_path.clone();
                    let lifecycle = Arc::clone(&lifecycle);
                    connections.spawn(async move {
                        // A picker handshake must not block the existing TUI.
                        let Ok(downstream) = accept_async_with_config(stream, Some(websocket_configuration())).await else {
                            return Ok(());
                        };
                        let upstream = match upstream {
                            Some(upstream) => upstream,
                            None => open_upstream(&upstream_path).await?,
                        };
                        let result = relay(upstream, downstream, connection, &lifecycle).await;
                        lifecycle.lock().await.projection.disconnected(connection);
                        result
                    });
                }
                finished = connections.join_next(), if !connections.is_empty() => {
                    finished.expect("a connection is present")
                        .map_err(|_| CodexConnectionDriverError::new("native_connection_worker_failed"))??;
                }
            }
        }
    }.await;
    // The provider processes own the lifetime, not a temporary picker socket.
    connections.shutdown().await;
    result
}

async fn relay(
    mut upstream: Socket,
    mut downstream: Socket,
    connection: u64,
    lifecycle: &Mutex<ManagedLifecycle>,
) -> Result<(), CodexConnectionDriverError> {
    let mut downstream_open = true;
    let recovery_changed = Arc::clone(&lifecycle.lock().await.recovery_changed);
    loop {
        // Register before reading the shared deadline so an auxiliary client's
        // report failure cannot leave the selected stream asleep indefinitely.
        let changed = recovery_changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let recover_at = {
            let lifecycle = lifecycle.lock().await;
            lifecycle
                .projection
                .is_selected_connection(connection)
                .then(|| lifecycle.recovery.as_ref().map(|recovery| recovery.after))
                .flatten()
        };
        tokio::select! {
            () = &mut changed => {}
            message = downstream.next(), if downstream_open => {
                let message = match message {
                    Some(Ok(message)) if !message.is_close() => message,
                    _ => {
                        if !lifecycle.lock().await.projection.has_pending_tools(connection) {
                            return Ok(());
                        }
                        // The app-server owns the running call, not its helper
                        // socket. Keep the response stream until work settles.
                        downstream_open = false;
                        continue;
                    }
                };
                if matches!(message, Message::Text(_) | Message::Binary(_)) {
                    let payload = message_json(message.clone())?;
                    if payload.get("method").is_some() && Lifecycle::owns_request_id(&payload) {
                        return Err(CodexConnectionDriverError::new("native_request_id_reserved"));
                    }
                    if !matches!(lifecycle.lock().await.client(connection, &payload).await, Ok(true)) {
                        // A full pending-request budget or one helper's bad
                        // request must not terminate other clients' live work.
                        let rejection = json!({"id": payload["id"], "error": {
                            "code": -32000, "message": "Dure could not admit this request; it was not forwarded"
                        }});
                        if downstream.send(Message::Text(rejection.to_string().into())).await.is_err() {
                            return Ok(());
                        }
                        continue;
                    }
                }
                if upstream.send(message).await.is_err() { return Ok(()) }
            }
            message = upstream.next() => {
                let Some(Ok(message)) = message else { return Ok(()) };
                if message.is_close() { return Ok(()) }
                if matches!(message, Message::Text(_) | Message::Binary(_)) {
                    let payload = message_json(message.clone())?;
                    let private = payload.get("method").is_none() && Lifecycle::owns_request_id(&payload);
                    lifecycle.lock().await.provider(connection, &payload).await?;
                    if private { continue; }
                }
                if downstream_open && downstream.send(message).await.is_err() {
                    downstream_open = false;
                }
                if !downstream_open && !lifecycle.lock().await.projection.has_pending_tools(connection) {
                    return Ok(());
                }
            }
            _ = async {
                match recover_at {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            } => {
                let request = {
                    let mut lifecycle = lifecycle.lock().await;
                    if lifecycle.projection.is_selected_connection(connection) {
                        if let Some(recovery) = &mut lifecycle.recovery {
                            recovery.delay = (recovery.delay * 2).min(Duration::from_secs(5));
                            recovery.after = Instant::now() + recovery.delay;
                        }
                        lifecycle.projection.reconciliation_request(connection)
                    } else { None }
                };
                if let Some(request) = request
                    && upstream.send(Message::Text(request.to_string().into())).await.is_err() {
                    return Ok(());
                }
            }
        }
    }
}

fn tui_exited(
    status: std::io::Result<std::process::ExitStatus>,
) -> Result<(), CodexConnectionDriverError> {
    let status = status.map_err(|_| CodexConnectionDriverError::new("native_tui_wait_failed"))?;
    if status.success() {
        Ok(())
    } else {
        Err(CodexConnectionDriverError::new("native_tui_failed"))
    }
}

impl ManagedLifecycle {
    async fn client(
        &mut self,
        connection: u64,
        payload: &Value,
    ) -> Result<bool, CodexConnectionDriverError> {
        self.projection.client(connection, payload)?;
        let Some(report) = self
            .projection
            .tool_call_report(connection, payload, &self.fence)
        else {
            return Ok(true);
        };
        // Publish pending work before forwarding it. Failure to publish must
        // not start a tool which the Host still considers idle.
        let admitted = self.publish(payload, report).await.unwrap_or(false);
        if !admitted {
            self.projection.reject_unforwarded_tool(connection, payload);
        }
        Ok(admitted)
    }

    async fn provider(
        &mut self,
        connection: u64,
        payload: &Value,
    ) -> Result<(), CodexConnectionDriverError> {
        let report = self.projection.provider(connection, payload, &self.fence)?;
        let recovery_event;
        let evidence = if payload.get("method").is_none() && Lifecycle::owns_request_id(payload) {
            recovery_event = json!({"method": "thread/reconciled", "params": {
                "threadId": payload.pointer("/result/thread/id").and_then(lifecycle::identifier),
                "threadStatus": payload.pointer("/result/thread/status/type").and_then(Value::as_str),
                "requestErrorCode": payload.pointer("/error/code").and_then(Value::as_i64)
            }});
            &recovery_event
        } else {
            payload
        };
        let Some(report) = report else {
            if let Some(diagnostics) = &mut self.diagnostics {
                let _ = diagnostics.record(evidence, None, &self.fence, "ignored");
            }
            return Ok(());
        };
        self.publish(evidence, report).await.map(|_| ())
    }

    async fn publish(
        &mut self,
        evidence: &Value,
        report: hmux_client::AgentStateReport,
    ) -> Result<bool, CodexConnectionDriverError> {
        let reporter = self.reporter.clone();
        let request = self.request.clone();
        let fence = self.fence.clone();
        let admitted = report.clone();
        // Ordered admission cannot let a delayed old turn overwrite a newer
        // event. No backend request or second app-server participates.
        let (available, outcome) = match tokio::task::spawn_blocking(move || {
            reporter.report_agent_state_for_fence(request, admitted, fence)
        })
        .await
        {
            Ok(Ok(outcome)) => (
                matches!(
                    outcome,
                    AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
                ),
                format!("{outcome:?}"),
            ),
            Ok(Err(error)) => {
                if self.recovery.is_none() {
                    eprintln!(
                        "[codex native lifecycle] report unavailable: {}",
                        error.code()
                    );
                }
                (false, error.code().to_owned())
            }
            Err(_) => (false, "report_worker_unavailable".into()),
        };
        if let Some(diagnostics) = &mut self.diagnostics {
            let _ = diagnostics.record(evidence, Some(&report), &self.fence, &outcome);
        }
        if available {
            self.projection.admitted(&report);
            // A successful identity-only report did not repair runtime state.
            if !report.identity_only && self.recovery.take().is_some() {
                self.recovery_changed.notify_waiters();
            }
        } else if report.conversation_identity.is_none() {
            // Do not forward fresh-server readiness when Host input tracking
            // could not be established. No native turn has been submitted yet.
            return Err(CodexConnectionDriverError::new(
                "native_readiness_unavailable",
            ));
        } else if self.recovery.is_none() {
            let delay = Duration::from_secs(1);
            self.recovery = Some(Recovery {
                after: Instant::now() + delay,
                delay,
            });
            self.recovery_changed.notify_waiters();
        }
        Ok(available)
    }
}
