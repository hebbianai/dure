use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{WebSocketStream, accept_async_with_config, client_async_with_config};

use crate::codex_connection_driver_protocol::{THREAD_ATTACH_METHOD, advertise_thread_attach};

pub mod native;
mod state;
#[cfg(test)]
mod tests;

use state::*;

const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// A first app-server start can index the whole rollout history under Codex's
/// 15-minute backfill lease before it listens. Stopping it earlier leaves the
/// lease held and every Codex session sharing that home fails until it lapses.
/// A server that exits is still reported as soon as it exits.
const UPSTREAM_READY_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const UPSTREAM_READY_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub struct CodexConnectionDriverError {
    reason: &'static str,
}

impl CodexConnectionDriverError {
    fn new(reason: &'static str) -> Self {
        Self { reason }
    }
}

impl std::fmt::Display for CodexConnectionDriverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "dure_codex_connection_driver_{}", self.reason)
    }
}

impl std::error::Error for CodexConnectionDriverError {}

struct DriverOptions {
    endpoint: PathBuf,
    upstream: PathBuf,
    executable: PathBuf,
    arguments: Vec<OsString>,
}

impl DriverOptions {
    fn parse(
        arguments: impl Iterator<Item = OsString>,
    ) -> Result<Self, CodexConnectionDriverError> {
        let mut endpoint = None;
        let mut upstream = None;
        let mut arguments = arguments;
        loop {
            let argument = arguments
                .next()
                .ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?;
            if argument == "--" {
                break;
            }
            let value = arguments
                .next()
                .ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?;
            match argument.to_str() {
                Some("--endpoint") if endpoint.is_none() => endpoint = Some(PathBuf::from(value)),
                Some("--upstream") if upstream.is_none() => upstream = Some(PathBuf::from(value)),
                _ => return Err(CodexConnectionDriverError::new("arguments_invalid")),
            }
        }
        let executable = arguments
            .next()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?;
        let arguments = arguments.collect::<Vec<_>>();
        if arguments.is_empty() {
            return Err(CodexConnectionDriverError::new("arguments_invalid"));
        }
        let endpoint =
            endpoint.ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?;
        let upstream =
            upstream.ok_or_else(|| CodexConnectionDriverError::new("arguments_invalid"))?;
        if endpoint == upstream || endpoint.parent() != upstream.parent() {
            return Err(CodexConnectionDriverError::new("arguments_invalid"));
        }
        Ok(Self {
            endpoint,
            upstream,
            executable,
            arguments,
        })
    }
}

type Socket = WebSocketStream<UnixStream>;

pub async fn run_from_arguments(
    arguments: impl Iterator<Item = OsString>,
) -> Result<(), CodexConnectionDriverError> {
    let options = DriverOptions::parse(arguments)?;
    validate_socket_target(&options.endpoint)?;
    validate_socket_target(&options.upstream)?;
    let mut child = Command::new(&options.executable)
        .args(&options.arguments)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| CodexConnectionDriverError::new("upstream_launch_failed"))?;
    let result = run_driver(&options, &mut child).await;
    cleanup_socket(&options.endpoint);
    cleanup_socket(&options.upstream);
    result
}

async fn run_driver(
    options: &DriverOptions,
    child: &mut Child,
) -> Result<(), CodexConnectionDriverError> {
    let mut upstream = connect_upstream(&options.upstream, child).await?;
    let mut initialize_result = initialize_upstream(&mut upstream).await?;
    if !advertise_thread_attach(&mut initialize_result) {
        return Err(CodexConnectionDriverError::new(
            "upstream_initialize_invalid",
        ));
    }
    let listener = bind_endpoint(&options.endpoint)?;
    let mut state = DriverState::new(initialize_result);
    loop {
        let accepted = if state.retained.can_read_upstream() {
            tokio::select! {
                status = child.wait() => return child_exited(status),
                accepted = listener.accept() => accepted
                    .map_err(|_| CodexConnectionDriverError::new("endpoint_accept_failed"))?,
                message = upstream.next() => {
                    let message = message.ok_or_else(|| CodexConnectionDriverError::new("upstream_closed"))?
                        .map_err(|_| CodexConnectionDriverError::new("upstream_read_failed"))?;
                    capture_upstream_message(&mut upstream, &mut state, message).await?;
                    continue;
                }
            }
        } else {
            tokio::select! {
                status = child.wait() => return child_exited(status),
                accepted = listener.accept() => accepted
                    .map_err(|_| CodexConnectionDriverError::new("endpoint_accept_failed"))?,
            }
        };
        let Ok(downstream) =
            accept_async_with_config(accepted.0, Some(websocket_configuration())).await
        else {
            // An uninitialized client owns no provider work. Reject only this
            // connection, including queued peers that closed while the UI ran.
            continue;
        };
        serve_downstream(&mut upstream, downstream, child, &mut state).await?;
    }
}

async fn serve_downstream(
    upstream: &mut Socket,
    mut downstream: Socket,
    child: &mut Child,
    state: &mut DriverState,
) -> Result<(), CodexConnectionDriverError> {
    let connection_id = state.next_connection()?;
    let mut initialize_replied = false;
    let mut ready = false;
    loop {
        let can_read_upstream = state.retained.can_read_upstream();
        tokio::select! {
            status = child.wait() => return child_exited(status),
            message = downstream.next() => {
                let Some(message) = message else {
                    state.detach(connection_id)?;
                    return Ok(());
                };
                let message = match message {
                    Ok(message) => message,
                    Err(_) => {
                        state.detach(connection_id)?;
                        return Ok(());
                    }
                };
                match message {
                    Message::Ping(payload) => {
                        if downstream.send(Message::Pong(payload)).await.is_err() {
                            state.detach(connection_id)?;
                            return Ok(());
                        }
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => {
                        state.detach(connection_id)?;
                        return Ok(());
                    }
                    Message::Text(_) | Message::Binary(_) => {
                        let message = message_json(message)?;
                        let outcome = handle_downstream_message(
                            upstream,
                            &mut downstream,
                            state,
                            connection_id,
                            &mut initialize_replied,
                            &mut ready,
                            message,
                        ).await?;
                        if !outcome {
                            state.detach(connection_id)?;
                            return Ok(());
                        }
                    }
                    Message::Frame(_) => {
                        return Err(CodexConnectionDriverError::new("downstream_message_invalid"));
                    }
                }
            }
            message = upstream.next(), if can_read_upstream => {
                let message = message.ok_or_else(|| CodexConnectionDriverError::new("upstream_closed"))?
                    .map_err(|_| CodexConnectionDriverError::new("upstream_read_failed"))?;
                if !handle_upstream_for_downstream(
                    upstream,
                    &mut downstream,
                    state,
                    connection_id,
                    ready,
                    message,
                ).await? {
                    state.detach(connection_id)?;
                    return Ok(());
                }
            }
        }
    }
}

async fn handle_downstream_message(
    upstream: &mut Socket,
    downstream: &mut Socket,
    state: &mut DriverState,
    connection_id: u64,
    initialize_replied: &mut bool,
    ready: &mut bool,
    mut message: Value,
) -> Result<bool, CodexConnectionDriverError> {
    let method = message.get("method").and_then(Value::as_str);
    if !*ready {
        if method == Some("initialize") && !*initialize_replied {
            let id = message
                .get("id")
                .cloned()
                .ok_or_else(|| CodexConnectionDriverError::new("downstream_initialize_invalid"))?;
            *initialize_replied = true;
            return send_json(
                downstream,
                &json!({ "id": id, "result": state.initialize_result }),
            )
            .await;
        }
        if method == Some("initialized") && *initialize_replied && message.get("id").is_none() {
            *ready = true;
            return replay_retained(downstream, &mut state.retained, connection_id).await;
        }
        return Err(CodexConnectionDriverError::new(
            "downstream_initialize_invalid",
        ));
    }
    if matches!(method, Some("initialize" | "initialized")) {
        return Err(CodexConnectionDriverError::new(
            "downstream_initialize_invalid",
        ));
    }
    if method == Some(THREAD_ATTACH_METHOD) {
        return handle_thread_attach(upstream, downstream, state, connection_id, message).await;
    }
    if method.is_some() {
        if message.get("id").is_some() {
            let kind = if method == Some("turn/start") {
                message
                    .pointer("/params/threadId")
                    .and_then(Value::as_str)
                    .filter(|thread_id| {
                        state
                            .attached_thread
                            .as_ref()
                            .is_some_and(|attached| attached.thread_id.as_str() == *thread_id)
                    })
                    .map(|thread_id| ClientRequestKind::TurnStart {
                        thread_id: thread_id.into(),
                    })
                    .unwrap_or(ClientRequestKind::Passthrough)
            } else {
                ClientRequestKind::Passthrough
            };
            state.route_client_request(connection_id, &mut message, kind)?;
        }
        send_upstream(upstream, &message).await?;
        Ok(true)
    } else if message.get("id").is_some()
        && (message.get("result").is_some() || message.get("error").is_some())
    {
        let id = message
            .get("id")
            .ok_or_else(|| CodexConnectionDriverError::new("downstream_message_invalid"))?;
        if !state.retained.remove_server_request(id)? {
            return Err(CodexConnectionDriverError::new("server_response_stale"));
        }
        send_upstream(upstream, &message).await?;
        Ok(true)
    } else {
        Err(CodexConnectionDriverError::new(
            "downstream_message_invalid",
        ))
    }
}

async fn handle_thread_attach(
    upstream: &mut Socket,
    downstream: &mut Socket,
    state: &mut DriverState,
    connection_id: u64,
    mut message: Value,
) -> Result<bool, CodexConnectionDriverError> {
    let downstream_id = message
        .get("id")
        .cloned()
        .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?;
    let attach = message
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?;
    let method = attach
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| matches!(*method, "thread/start" | "thread/resume"))
        .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?;
    let params = attach
        .get("params")
        .filter(|params| params.is_object())
        .cloned()
        .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?;
    let intent = ThreadAttachIntent {
        method: method.into(),
        params,
    };

    if let Some(attached) = state.attached_thread.as_ref() {
        let matches_attached = if intent.method == "thread/start" {
            intent == attached.launch
        } else {
            intent.params.get("threadId").and_then(Value::as_str)
                == Some(attached.thread_id.as_str())
        };
        if !matches_attached {
            return Err(CodexConnectionDriverError::new("thread_attach_conflict"));
        }
        if !attached.materialized {
            return send_json(
                downstream,
                &json!({ "id": downstream_id, "result": attached.result }),
            )
            .await;
        }
        let thread_id = attached.thread_id.clone();
        let base_result = attached.result.clone();
        let request = message
            .as_object_mut()
            .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?;
        request.insert("method".into(), Value::String("thread/read".into()));
        request.insert(
            "params".into(),
            json!({ "threadId": thread_id, "includeTurns": true }),
        );
        state.route_client_request(
            connection_id,
            &mut message,
            ClientRequestKind::ThreadRefresh { base_result },
        )?;
        send_upstream(upstream, &message).await?;
        return Ok(true);
    }

    let mut pending_conflict = false;
    for route in state.client_requests.values_mut() {
        let ClientRequestKind::ThreadLaunch(pending) = &route.kind else {
            continue;
        };
        if pending == &intent {
            route.connection_id = connection_id;
            route.downstream_id = downstream_id;
            return Ok(true);
        }
        pending_conflict = true;
    }
    if pending_conflict {
        return Err(CodexConnectionDriverError::new("thread_attach_conflict"));
    }

    let request = message
        .as_object_mut()
        .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?;
    request.insert("method".into(), Value::String(intent.method.clone()));
    request.insert("params".into(), intent.params.clone());
    state.route_client_request(
        connection_id,
        &mut message,
        ClientRequestKind::ThreadLaunch(intent),
    )?;
    send_upstream(upstream, &message).await?;
    Ok(true)
}

async fn capture_upstream_message(
    upstream: &mut Socket,
    state: &mut DriverState,
    message: Message,
) -> Result<(), CodexConnectionDriverError> {
    match message {
        Message::Ping(payload) => upstream
            .send(Message::Pong(payload))
            .await
            .map_err(|_| CodexConnectionDriverError::new("upstream_write_failed")),
        Message::Pong(_) => Ok(()),
        Message::Close(_) => Err(CodexConnectionDriverError::new("upstream_closed")),
        Message::Text(_) | Message::Binary(_) => {
            let message = message_json(message)?;
            observe_thread_materialized(state, &message);
            if complete_client_request(state, &message)?.is_some() {
                return Ok(());
            }
            retain_upstream_event(&mut state.retained, message)
        }
        Message::Frame(_) => Err(CodexConnectionDriverError::new("upstream_message_invalid")),
    }
}

async fn handle_upstream_for_downstream(
    upstream: &mut Socket,
    downstream: &mut Socket,
    state: &mut DriverState,
    connection_id: u64,
    ready: bool,
    message: Message,
) -> Result<bool, CodexConnectionDriverError> {
    let message = match message {
        Message::Ping(payload) => {
            upstream
                .send(Message::Pong(payload))
                .await
                .map_err(|_| CodexConnectionDriverError::new("upstream_write_failed"))?;
            return Ok(true);
        }
        Message::Pong(_) => return Ok(true),
        Message::Close(_) => return Err(CodexConnectionDriverError::new("upstream_closed")),
        Message::Text(_) | Message::Binary(_) => message_json(message)?,
        Message::Frame(_) => {
            return Err(CodexConnectionDriverError::new("upstream_message_invalid"));
        }
    };
    observe_thread_materialized(state, &message);
    if let Some((route, mut response)) = complete_client_request(state, &message)? {
        if route.connection_id != connection_id || !ready {
            return Ok(true);
        }
        response
            .as_object_mut()
            .ok_or_else(|| CodexConnectionDriverError::new("upstream_message_invalid"))?
            .insert("id".into(), route.downstream_id);
        return send_json(downstream, &response).await;
    }
    let method = message.get("method").and_then(Value::as_str);
    let Some(_) = method else {
        return Err(CodexConnectionDriverError::new("upstream_message_invalid"));
    };
    if message.get("id").is_some() {
        let key = state
            .retained
            .retain_server_request(message.clone(), false)?;
        if !ready {
            state.retained.queue_server_request(&key)?;
            return Ok(true);
        }
        let delivered = send_json(downstream, &message).await?;
        state
            .retained
            .record_server_request_delivery(&key, connection_id, delivered)?;
        return Ok(delivered);
    }
    state.retained.resolve_from_notification(&message);
    if !ready {
        state.retained.retain_notification(message)?;
        return Ok(true);
    }
    match send_json(downstream, &message).await? {
        true => Ok(true),
        false => {
            state.retained.retain_notification(message)?;
            Ok(false)
        }
    }
}

async fn replay_retained(
    downstream: &mut Socket,
    retained: &mut RetainedUpstream,
    connection_id: u64,
) -> Result<bool, CodexConnectionDriverError> {
    while let Some(delivery) = retained.deliveries.pop_front() {
        match delivery {
            RetainedDelivery::Notification {
                message,
                encoded_bytes,
            } => {
                retained.encoded_bytes = retained.encoded_bytes.saturating_sub(encoded_bytes);
                if !send_json(downstream, &message).await? {
                    retained.encoded_bytes = retained.encoded_bytes.saturating_add(encoded_bytes);
                    retained
                        .deliveries
                        .push_front(RetainedDelivery::Notification {
                            message,
                            encoded_bytes,
                        });
                    return Ok(false);
                }
            }
            RetainedDelivery::ServerRequest(key) => {
                let Some(message) = retained.server_requests.get_mut(&key).map(|request| {
                    request.queued = false;
                    request.message.clone()
                }) else {
                    continue;
                };
                if !send_json(downstream, &message).await? {
                    retained.queue_server_request(&key)?;
                    return Ok(false);
                }
                retained.record_server_request_delivery(&key, connection_id, true)?;
            }
        }
    }
    let replay = retained
        .server_requests
        .iter()
        .filter(|(_, request)| request.delivered_to != Some(connection_id))
        .map(|(key, request)| (key.clone(), request.message.clone()))
        .collect::<Vec<_>>();
    for (key, message) in replay {
        if !send_json(downstream, &message).await? {
            retained.queue_server_request(&key)?;
            return Ok(false);
        }
        retained.record_server_request_delivery(&key, connection_id, true)?;
    }
    Ok(true)
}

async fn initialize_upstream(upstream: &mut Socket) -> Result<Value, CodexConnectionDriverError> {
    send_upstream(
        upstream,
        &json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "dure",
                    "title": "Dure",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": false,
                    "requestAttestation": false,
                },
            },
        }),
    )
    .await?;
    let result = loop {
        let message = upstream
            .next()
            .await
            .ok_or_else(|| CodexConnectionDriverError::new("upstream_closed"))?
            .map_err(|_| CodexConnectionDriverError::new("upstream_read_failed"))?;
        match message {
            Message::Ping(payload) => upstream
                .send(Message::Pong(payload))
                .await
                .map_err(|_| CodexConnectionDriverError::new("upstream_write_failed"))?,
            Message::Pong(_) => {}
            Message::Close(_) => return Err(CodexConnectionDriverError::new("upstream_closed")),
            Message::Text(_) | Message::Binary(_) => {
                let message = message_json(message)?;
                if message.get("id").and_then(Value::as_u64) != Some(1) {
                    return Err(CodexConnectionDriverError::new(
                        "upstream_initialize_invalid",
                    ));
                }
                if let Some(result) = message.get("result") {
                    break result.clone();
                }
                return Err(CodexConnectionDriverError::new(
                    "upstream_initialize_failed",
                ));
            }
            Message::Frame(_) => {
                return Err(CodexConnectionDriverError::new(
                    "upstream_initialize_invalid",
                ));
            }
        }
    };
    send_upstream(upstream, &json!({ "method": "initialized", "params": {} })).await?;
    Ok(result)
}

async fn connect_upstream(
    path: &Path,
    child: &mut Child,
) -> Result<Socket, CodexConnectionDriverError> {
    let deadline = Instant::now() + UPSTREAM_READY_TIMEOUT;
    loop {
        match fs::symlink_metadata(path) {
            Ok(metadata)
                if metadata.file_type().is_socket()
                    && metadata.uid() == unsafe { libc::geteuid() } =>
            {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                    .map_err(|_| CodexConnectionDriverError::new("upstream_socket_unsafe"))?;
                return open_upstream(path).await;
            }
            Ok(_) => return Err(CodexConnectionDriverError::new("upstream_socket_unsafe")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(CodexConnectionDriverError::new("upstream_socket_unsafe")),
        }
        if Instant::now() >= deadline {
            return Err(CodexConnectionDriverError::new("upstream_readiness_failed"));
        }
        tokio::select! {
            status = child.wait() => return child_exited(status),
            _ = tokio::time::sleep(UPSTREAM_READY_INTERVAL) => {}
        }
    }
}

async fn open_upstream(path: &Path) -> Result<Socket, CodexConnectionDriverError> {
    let stream = UnixStream::connect(path)
        .await
        .map_err(|_| CodexConnectionDriverError::new("upstream_connect_failed"))?;
    let request = "ws://localhost/"
        .into_client_request()
        .map_err(|_| CodexConnectionDriverError::new("upstream_handshake_failed"))?;
    client_async_with_config(request, stream, Some(websocket_configuration()))
        .await
        .map(|(socket, _)| socket)
        .map_err(|_| CodexConnectionDriverError::new("upstream_handshake_failed"))
}

fn validate_socket_target(path: &Path) -> Result<(), CodexConnectionDriverError> {
    crate::private_driver_socket::validate_socket_target(path)
        .map_err(CodexConnectionDriverError::new)
}

fn bind_endpoint(path: &Path) -> Result<UnixListener, CodexConnectionDriverError> {
    crate::private_driver_socket::bind_endpoint(path).map_err(CodexConnectionDriverError::new)
}

use crate::private_driver_socket::cleanup_socket;

fn websocket_configuration() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES))
}

fn message_json(message: Message) -> Result<Value, CodexConnectionDriverError> {
    let bytes = match message {
        Message::Text(source) => source.as_bytes().to_vec(),
        Message::Binary(source) => source.to_vec(),
        _ => return Err(CodexConnectionDriverError::new("message_type_invalid")),
    };
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(CodexConnectionDriverError::new("message_too_large"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| CodexConnectionDriverError::new("message_json_invalid"))
}

async fn send_json(socket: &mut Socket, value: &Value) -> Result<bool, CodexConnectionDriverError> {
    let source = serde_json::to_string(value)
        .map_err(|_| CodexConnectionDriverError::new("message_json_invalid"))?;
    Ok(socket.send(Message::Text(source.into())).await.is_ok())
}

async fn send_upstream(
    socket: &mut Socket,
    value: &Value,
) -> Result<(), CodexConnectionDriverError> {
    if send_json(socket, value).await? {
        Ok(())
    } else {
        Err(CodexConnectionDriverError::new("upstream_write_failed"))
    }
}

fn child_exited<T>(
    status: std::io::Result<std::process::ExitStatus>,
) -> Result<T, CodexConnectionDriverError> {
    let _ = status;
    Err(CodexConnectionDriverError::new("upstream_exited"))
}
