//! Hmux owns this process and Pi's RPC pipes across control-plane connections.
//! Pi owns session entries; disconnected notifications need no second journal.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{ChildStdin, Command};
use tokio::time::{Duration, timeout};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use tokio_tungstenite::{WebSocketStream, accept_async_with_config};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_REQUESTS: usize = 256;
type Socket = WebSocketStream<UnixStream>;
type Error = Box<dyn std::error::Error + Send + Sync>;

struct Route {
    connection: u64,
    id: Value,
    method: String,
    prompt_key: Option<String>,
}

#[derive(Default)]
struct State {
    serial: u64,
    connection: u64,
    routes: BTreeMap<String, Route>,
    prompts: BTreeMap<String, (String, Option<Value>)>,
    pending_ui: BTreeMap<String, Value>,
}

impl State {
    fn prompt_pending(&self) -> bool {
        self.prompts
            .values()
            .any(|(_, response)| response.is_none())
    }

    fn request_id(&mut self) -> Result<String, Error> {
        self.serial = self
            .serial
            .checked_add(1)
            .ok_or("Pi request ID exhausted")?;
        Ok(format!("dure-{}", self.serial))
    }
}

pub async fn run_from_arguments(
    mut arguments: impl Iterator<Item = OsString>,
) -> Result<(), Error> {
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--endpoint")) {
        return Err("Pi driver requires --endpoint".into());
    }
    let endpoint = PathBuf::from(arguments.next().ok_or("Pi endpoint missing")?);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
        return Err("Pi driver requires an executable delimiter".into());
    }
    let executable = PathBuf::from(arguments.next().ok_or("Pi executable missing")?);
    if !executable.is_absolute() {
        return Err("Pi executable must be absolute".into());
    }
    crate::private_driver_socket::validate_socket_target(&endpoint)?;
    let mut child = Command::new(executable)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().ok_or("Pi stdin missing")?;
    let mut output = child.stdout.take().ok_or("Pi stdout missing")?;
    let listener = crate::private_driver_socket::bind_endpoint(&endpoint)?;
    let mut socket: Option<Socket> = None;
    let mut state = State::default();
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    let result: Result<(), Error> = async {
        loop {
            tokio::select! {
                status = child.wait() => {
                    return if status?.success() { Ok(()) } else { Err("Pi exited unsuccessfully".into()) };
                }
                accepted = listener.accept(), if socket.is_none() => {
                    let stream = accepted?.0;
                    let config = WebSocketConfig::default().max_message_size(Some(MAX_BYTES)).max_frame_size(Some(MAX_BYTES));
                    if let Ok(Ok(connected)) = timeout(Duration::from_secs(5), accept_async_with_config(stream, Some(config))).await {
                        state.connection = state.connection.checked_add(1).ok_or("Pi connection ID exhausted")?;
                        socket = Some(connected);
                    }
                }
                message = async { socket.as_mut().expect("connected select branch").next().await }, if socket.is_some() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let request: Value = serde_json::from_str(&text)?;
                            handle_request(&mut state, &mut input, &mut socket, request).await?;
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            send(&mut socket, Message::Pong(payload)).await;
                        }
                        Some(Ok(Message::Pong(_))) => {}
                        _ => socket = None,
                    }
                }
                read = output.read(&mut chunk) => {
                    let count = read?;
                    if count == 0 { return Err("Pi RPC output closed".into()); }
                    buffer.extend_from_slice(&chunk[..count]);
                    while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                        if end > MAX_BYTES { return Err("Pi RPC record limit exceeded".into()); }
                        let message: Value = serde_json::from_slice(&buffer[..end])?;
                        buffer.drain(..=end);
                        handle_output(&mut state, &mut socket, message).await?;
                    }
                    if buffer.len() > MAX_BYTES { return Err("Pi RPC record limit exceeded".into()); }
                }
            }
        }
    }.await;
    crate::private_driver_socket::cleanup_socket(&endpoint);
    result
}

async fn write(input: &mut ChildStdin, value: &Value) -> Result<(), Error> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    timeout(Duration::from_secs(5), input.write_all(&bytes)).await??;
    Ok(())
}

async fn send(socket: &mut Option<Socket>, message: Message) {
    if let Some(connected) = socket.as_mut() {
        if !matches!(
            timeout(Duration::from_secs(2), connected.send(message)).await,
            Ok(Ok(()))
        ) {
            *socket = None;
        }
    }
}

async fn reply(socket: &mut Option<Socket>, value: Value) {
    send(socket, Message::Text(value.to_string().into())).await;
}

async fn refuse(socket: &mut Option<Socket>, id: Value, reason: &str) {
    reply(
        socket,
        json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32000,"message":reason}}),
    )
    .await;
}

async fn handle_request(
    state: &mut State,
    input: &mut ChildStdin,
    socket: &mut Option<Socket>,
    request: Value,
) -> Result<(), Error> {
    let id = request.get("id").cloned().ok_or("Pi request ID missing")?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or("Pi method missing")?;
    let mut params = request
        .get("params")
        .and_then(Value::as_object)
        .cloned()
        .ok_or("Pi parameters missing")?;
    if method == "prompt_status" {
        let key = params
            .get("clientMessageId")
            .and_then(Value::as_str)
            .ok_or("Pi client message ID missing")?;
        let status = match state.prompts.get(key) {
            None => "missing",
            Some((_, None)) => "pending",
            Some((_, Some(response))) if response.get("error").is_some() => "rejected",
            Some((_, Some(_))) => "accepted",
        };
        reply(
            socket,
            json!({"jsonrpc":"2.0","id":id,"result":{"status":status}}),
        )
        .await;
        return Ok(());
    }
    if method == "extension_ui_response" {
        let key = params
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Pi question ID missing")?
            .to_owned();
        if !state.pending_ui.contains_key(&key) {
            refuse(socket, id, "Pi question is no longer pending").await;
            return Ok(());
        }
        params.insert("type".into(), json!(method));
        write(input, &Value::Object(params)).await?;
        state.pending_ui.remove(&key);
        reply(socket, json!({"jsonrpc":"2.0","id":id,"result":{}})).await;
        return Ok(());
    }
    if !matches!(
        method,
        "get_state"
            | "get_entries"
            | "get_available_models"
            | "get_available_thinking_levels"
            | "prompt"
            | "abort"
    ) {
        refuse(
            socket,
            id,
            "Pi operation is outside this managed session contract",
        )
        .await;
        return Ok(());
    }
    let prompt_key = if method == "prompt" {
        let key = params
            .remove("clientMessageId")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or("Pi client message ID missing")?;
        let payload = format!("{:x}", Sha256::digest(serde_json::to_vec(&params)?));
        if let Some((previous, result)) = state.prompts.get(&key) {
            if previous != &payload {
                refuse(socket, id, "Pi prompt identity conflict").await;
            } else if let Some(result) = result {
                let mut result = result.clone();
                result["id"] = id;
                reply(socket, result).await;
            } else {
                refuse(socket, id, "Pi prompt acceptance is still pending").await;
            }
            return Ok(());
        }
        if state.prompt_pending() || state.prompts.len() >= 16384 {
            refuse(socket, id, "Pi prompt admission unavailable").await;
            return Ok(());
        }
        state.prompts.insert(key.clone(), (payload, None));
        Some(key)
    } else {
        None
    };
    if state.routes.len() >= MAX_REQUESTS {
        return Err("Pi request capacity exceeded".into());
    }
    let upstream_id = state.request_id()?;
    params.insert("id".into(), json!(upstream_id));
    params.insert("type".into(), json!(method));
    state.routes.insert(
        upstream_id,
        Route {
            connection: state.connection,
            id,
            method: method.into(),
            prompt_key,
        },
    );
    write(input, &Value::Object(params)).await
}

async fn handle_output(
    state: &mut State,
    socket: &mut Option<Socket>,
    message: Value,
) -> Result<(), Error> {
    match message.get("type").and_then(Value::as_str) {
        Some("response") => {
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Pi response ID missing")?;
            let route = state
                .routes
                .remove(id)
                .ok_or("Pi response has no request")?;
            if message.get("command").and_then(Value::as_str) != Some(&route.method) {
                return Err("Pi response command mismatch".into());
            }
            let mut result = if message.get("success") == Some(&Value::Bool(true)) {
                json!({"jsonrpc":"2.0","id":route.id,"result":message.get("data").cloned().unwrap_or(json!({}))})
            } else {
                json!({"jsonrpc":"2.0","id":route.id,"error":{"code":-32000,"message":message.get("error").and_then(Value::as_str).unwrap_or("Pi command failed")}})
            };
            if route.method == "get_state" && result.get("result").is_some() {
                result["result"]["pendingPrompt"] = json!(state.prompt_pending());
                result["result"]["pendingUi"] =
                    json!(state.pending_ui.values().collect::<Vec<_>>());
            }
            if let Some(key) = route.prompt_key {
                state
                    .prompts
                    .get_mut(&key)
                    .ok_or("Pi prompt receipt missing")?
                    .1 = Some(result.clone());
            }
            if route.connection == state.connection {
                reply(socket, result).await;
            }
        }
        Some("extension_ui_request") => {
            if matches!(
                message.get("method").and_then(Value::as_str),
                Some("select" | "confirm" | "input" | "editor")
            ) {
                if state.pending_ui.len() >= MAX_REQUESTS {
                    return Err("Pi question capacity exceeded".into());
                }
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("Pi question ID missing")?;
                state.pending_ui.insert(id.into(), message.clone());
            }
            reply(
                socket,
                json!({"jsonrpc":"2.0","method":"pi/changed","params":message}),
            )
            .await;
        }
        Some(
            "message_end"
            | "agent_settled"
            | "agent_start"
            | "tool_execution_start"
            | "tool_execution_end",
        ) => {
            if message.get("type").and_then(Value::as_str) == Some("agent_settled") {
                state.pending_ui.clear();
            }
            reply(
                socket,
                json!({"jsonrpc":"2.0","method":"pi/changed","params":message}),
            )
            .await;
        }
        Some(_) => {}
        None => return Err("Pi event type missing".into()),
    }
    Ok(())
}
