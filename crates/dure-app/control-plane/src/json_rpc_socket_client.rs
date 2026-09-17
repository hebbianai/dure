use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio::time::{Duration, timeout};
use tokio_tungstenite::client_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = MAX_MESSAGE_BYTES;
const COMMAND_CAPACITY: usize = 64;
const INCOMING_CAPACITY: usize = 256;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JsonRpcSocketClientError {
    pub code: String,
    pub detail: String,
}

impl JsonRpcSocketClientError {
    fn new(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for JsonRpcSocketClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for JsonRpcSocketClientError {}

#[derive(Clone, Debug)]
pub(crate) struct JsonRpcSocketIncomingV1 {
    pub method: String,
    pub id: Option<Value>,
    pub params: Value,
}

enum ClientCommand {
    Request {
        id: u64,
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value, JsonRpcSocketClientError>>,
    },
    Notification {
        method: String,
        params: Value,
        written: oneshot::Sender<Result<(), JsonRpcSocketClientError>>,
    },
    Response {
        id: Value,
        result: Result<Value, JsonRpcSocketClientError>,
        delivered: Option<watch::Sender<bool>>,
        written: oneshot::Sender<Result<(), JsonRpcSocketClientError>>,
    },
}

#[derive(Clone)]
pub(crate) struct JsonRpcSocketClient {
    commands: mpsc::Sender<ClientCommand>,
    close: watch::Sender<bool>,
    connected: Arc<AtomicBool>,
    next_request_id: Arc<AtomicU64>,
}

pub(crate) struct JsonRpcSocketIncoming {
    receiver: mpsc::Receiver<JsonRpcSocketIncomingV1>,
}

struct ConnectionGuard {
    close: watch::Sender<bool>,
    connected: Arc<AtomicBool>,
    armed: bool,
}

impl ConnectionGuard {
    fn new(close: &watch::Sender<bool>, connected: &Arc<AtomicBool>) -> Self {
        Self {
            close: close.clone(),
            connected: Arc::clone(connected),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if self.armed {
            self.connected.store(false, Ordering::SeqCst);
            self.close.send_replace(true);
        }
    }
}

impl JsonRpcSocketIncoming {
    pub(crate) async fn recv(&mut self) -> Option<JsonRpcSocketIncomingV1> {
        self.receiver.recv().await
    }
}

impl JsonRpcSocketClient {
    pub(crate) async fn connect(
        socket_path: &Path,
    ) -> Result<(Self, JsonRpcSocketIncoming), JsonRpcSocketClientError> {
        let stream = UnixStream::connect(socket_path)
            .await
            .map_err(|error| JsonRpcSocketClientError::new("connect_failed", error.to_string()))?;
        let request = "ws://localhost/".into_client_request().map_err(|error| {
            JsonRpcSocketClientError::new("handshake_invalid", error.to_string())
        })?;
        let configuration = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));
        let (socket, _) = client_async_with_config(request, stream, Some(configuration))
            .await
            .map_err(|error| {
                JsonRpcSocketClientError::new("handshake_failed", error.to_string())
            })?;
        let (commands, command_receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (incoming_sender, incoming_receiver) = mpsc::channel(INCOMING_CAPACITY);
        let (close, close_receiver) = watch::channel(false);
        let connected = Arc::new(AtomicBool::new(true));
        tokio::spawn(run_connection(
            socket,
            command_receiver,
            incoming_sender,
            Arc::clone(&connected),
            close_receiver,
        ));
        Ok((
            Self {
                commands,
                close,
                connected,
                next_request_id: Arc::new(AtomicU64::new(1)),
            },
            JsonRpcSocketIncoming {
                receiver: incoming_receiver,
            },
        ))
    }

    pub(crate) async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, JsonRpcSocketClientError> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
            .await
    }

    async fn request_with_timeout(
        &self,
        method: impl Into<String>,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, JsonRpcSocketClientError> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (reply, response) = oneshot::channel();
        let mut guard = ConnectionGuard::new(&self.close, &self.connected);
        let operation = async {
            self.commands
                .send(ClientCommand::Request {
                    id,
                    method: method.into(),
                    params,
                    reply,
                })
                .await
                .map_err(|_| {
                    JsonRpcSocketClientError::new("connection_closed", "app-server disconnected")
                })?;
            response.await.map_err(|_| {
                JsonRpcSocketClientError::new("connection_closed", "app-server disconnected")
            })?
        };
        match timeout(deadline, operation).await {
            Ok(result) => {
                guard.disarm();
                result
            }
            Err(_) => Err(JsonRpcSocketClientError::new(
                "request_timeout",
                "request timed out",
            )),
        }
    }

    pub(crate) async fn notify(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<(), JsonRpcSocketClientError> {
        let (written, receipt) = oneshot::channel();
        let mut guard = ConnectionGuard::new(&self.close, &self.connected);
        let operation = async {
            self.commands
                .send(ClientCommand::Notification {
                    method: method.into(),
                    params,
                    written,
                })
                .await
                .map_err(|_| {
                    JsonRpcSocketClientError::new("connection_closed", "app-server disconnected")
                })?;
            receipt.await.map_err(|_| {
                JsonRpcSocketClientError::new("connection_closed", "app-server disconnected")
            })?
        };
        match timeout(REQUEST_TIMEOUT, operation).await {
            Ok(result) => {
                guard.disarm();
                result
            }
            Err(_) => Err(JsonRpcSocketClientError::new(
                "notification_timeout",
                "notification write timed out",
            )),
        }
    }

    pub(crate) async fn respond(
        &self,
        id: Value,
        result: Result<Value, JsonRpcSocketClientError>,
    ) -> Result<(), JsonRpcSocketClientError> {
        self.respond_with_delivery(id, result, None).await
    }

    pub(crate) async fn respond_with_delivery(
        &self,
        id: Value,
        result: Result<Value, JsonRpcSocketClientError>,
        delivered: Option<watch::Sender<bool>>,
    ) -> Result<(), JsonRpcSocketClientError> {
        let (written, receipt) = oneshot::channel();
        let mut guard = ConnectionGuard::new(&self.close, &self.connected);
        let operation = async {
            self.commands
                .send(ClientCommand::Response {
                    id,
                    result,
                    delivered,
                    written,
                })
                .await
                .map_err(|_| {
                    JsonRpcSocketClientError::new("connection_closed", "app-server disconnected")
                })?;
            receipt.await.map_err(|_| {
                JsonRpcSocketClientError::new("connection_closed", "app-server disconnected")
            })?
        };
        match timeout(REQUEST_TIMEOUT, operation).await {
            Ok(result) => {
                guard.disarm();
                result
            }
            Err(_) => Err(JsonRpcSocketClientError::new(
                "response_timeout",
                "response write timed out",
            )),
        }
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub(crate) fn disconnect(&self) {
        self.connected.store(false, Ordering::SeqCst);
        self.close.send_replace(true);
    }
}

async fn run_connection(
    mut socket: tokio_tungstenite::WebSocketStream<UnixStream>,
    mut commands: mpsc::Receiver<ClientCommand>,
    incoming: mpsc::Sender<JsonRpcSocketIncomingV1>,
    connected: Arc<AtomicBool>,
    mut close: watch::Receiver<bool>,
) {
    let pending = Arc::new(Mutex::new(BTreeMap::<
        u64,
        oneshot::Sender<Result<Value, JsonRpcSocketClientError>>,
    >::new()));
    'connection: loop {
        tokio::select! {
            biased;
            _ = close.changed() => break,
            command = commands.recv() => {
                let Some(command) = command else { break };
                let (value, written) = match command {
                    ClientCommand::Request { id, method, params, reply } => {
                        pending.lock().await.insert(id, reply);
                        (json!({ "id": id, "method": method, "params": params }), None)
                    }
                    ClientCommand::Notification { method, params, written } => {
                        (
                            json!({ "method": method, "params": params }),
                            Some((None, written)),
                        )
                    }
                    ClientCommand::Response {
                        id,
                        result,
                        delivered,
                        written,
                    } => (
                        match result {
                            Ok(result) => json!({ "id": id, "result": result }),
                            Err(error) => json!({
                                "id": id,
                                "error": { "code": -32000, "message": error.detail },
                            }),
                        },
                        Some((delivered, written)),
                    ),
                };
                let send = tokio::select! {
                    biased;
                    _ = close.changed() => break 'connection,
                    send = socket.send(Message::Text(value.to_string().into())) => send,
                };
                match send {
                    Ok(()) => {
                        if let Some((delivered, written)) = written {
                            if let Some(delivered) = delivered {
                                delivered.send_replace(true);
                            }
                            let _ = written.send(Ok(()));
                        }
                    }
                    Err(error) => {
                        if let Some((_, written)) = written {
                            let _ = written.send(Err(JsonRpcSocketClientError::new(
                                "write_failed",
                                error.to_string(),
                            )));
                        }
                        break;
                    }
                }
            }
            message = socket.next() => {
                let Some(Ok(message)) = message else { break };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) if bytes.len() <= MAX_MESSAGE_BYTES => {
                        match String::from_utf8(bytes.to_vec()) {
                            Ok(text) => text,
                            Err(_) => break,
                        }
                    }
                    Message::Ping(payload) => {
                        let pong = tokio::select! {
                            biased;
                            _ = close.changed() => break 'connection,
                            pong = socket.send(Message::Pong(payload)) => pong,
                        };
                        if pong.is_err() { break; }
                        continue;
                    }
                    Message::Pong(_) => continue,
                    Message::Close(_) => break,
                    Message::Frame(_) | Message::Binary(_) => break,
                };
                if text.len() > MAX_MESSAGE_BYTES { break; }
                let Ok(value) = serde_json::from_str::<Value>(&text) else { break };
                if let Some(id) = value.get("id").and_then(Value::as_u64)
                    && (value.get("result").is_some() || value.get("error").is_some())
                {
                    if let Some(reply) = pending.lock().await.remove(&id) {
                        let result = rpc_result(&value);
                        let _ = reply.send(result);
                    }
                    continue;
                }
                let Some(method) = value.get("method").and_then(Value::as_str) else { continue };
                let event = JsonRpcSocketIncomingV1 {
                    method: method.to_owned(),
                    id: value.get("id").cloned(),
                    params: value.get("params").cloned().unwrap_or_else(|| json!({})),
                };
                let delivered = tokio::select! {
                    biased;
                    _ = close.changed() => break 'connection,
                    delivered = incoming.send(event) => delivered,
                };
                if delivered.is_err() { break; }
            }
        }
    }
    connected.store(false, Ordering::SeqCst);
    let error = JsonRpcSocketClientError::new("connection_closed", "app-server disconnected");
    for (_, reply) in std::mem::take(&mut *pending.lock().await) {
        let _ = reply.send(Err(error.clone()));
    }
}

fn rpc_result(value: &Value) -> Result<Value, JsonRpcSocketClientError> {
    if let Some(result) = value.get("result") {
        return Ok(result.clone());
    }
    let error = value.get("error").and_then(Value::as_object);
    let code = error
        .and_then(|error| error.get("code"))
        .map(Value::to_string)
        .unwrap_or_else(|| "unknown".into());
    let detail = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("app-server request failed");
    Err(JsonRpcSocketClientError::new(
        format!("request_failed_{code}"),
        detail,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;
    use tokio_tungstenite::accept_async;

    #[tokio::test]
    async fn correlates_responses_and_delivers_server_requests() {
        let root = tempfile::tempdir().expect("tempdir");
        let socket_path = root.path().join("app.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind fixture");
        let fixture = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = accept_async(stream).await.expect("websocket");
            let request = socket.next().await.expect("request").expect("frame");
            let request: Value =
                serde_json::from_str(request.to_text().expect("text")).expect("request json");
            socket
                .send(Message::Text(
                    json!({ "id": request["id"], "result": { "ok": true } })
                        .to_string()
                        .into(),
                ))
                .await
                .expect("response");
            socket
                .send(Message::Text(
                    json!({
                        "id": "approval-1",
                        "method": "item/commandExecution/requestApproval",
                        "params": { "threadId": "thread-1" },
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("server request");
        });

        let (client, mut incoming) = JsonRpcSocketClient::connect(&socket_path)
            .await
            .expect("connect");
        assert_eq!(
            client
                .request("fixture/read", json!({}))
                .await
                .expect("response"),
            json!({ "ok": true })
        );
        let request = incoming.recv().await.expect("incoming request");
        assert_eq!(request.id, Some(json!("approval-1")));
        assert_eq!(request.method, "item/commandExecution/requestApproval");
        fixture.await.expect("fixture task");
        assert!(incoming.recv().await.is_none());
    }

    #[tokio::test]
    async fn accepts_a_large_single_frame_thread_snapshot() {
        let root = tempfile::tempdir().expect("tempdir");
        let socket_path = root.path().join("app.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind fixture");
        let fixture = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = accept_async(stream).await.expect("websocket");
            let request = socket.next().await.expect("request").expect("frame");
            let request: Value =
                serde_json::from_str(request.to_text().expect("text")).expect("request json");
            socket
                .send(Message::Text(
                    json!({
                        "id": request["id"],
                        "result": { "snapshot": "x".repeat(5 * 1024 * 1024) },
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("large response");
        });

        let (client, _incoming) = JsonRpcSocketClient::connect(&socket_path)
            .await
            .expect("connect");
        let response = client
            .request("thread/resume", json!({ "threadId": "thread-1" }))
            .await
            .expect("large snapshot");
        assert_eq!(
            response
                .get("snapshot")
                .and_then(Value::as_str)
                .map(str::len),
            Some(5 * 1024 * 1024)
        );
        fixture.await.expect("fixture task");
    }

    #[tokio::test]
    async fn a_request_timeout_retires_the_connection_instead_of_reusing_a_hung_socket() {
        let root = tempfile::tempdir().expect("tempdir");
        let socket_path = root.path().join("app.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind fixture");
        let fixture = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = accept_async(stream).await.expect("websocket");
            let _request = socket.next().await.expect("request").expect("frame");
            socket.next().await
        });

        let (client, mut incoming) = JsonRpcSocketClient::connect(&socket_path)
            .await
            .expect("connect");
        let error = client
            .request_with_timeout("fixture/hang", json!({}), Duration::from_millis(20))
            .await
            .expect_err("request must time out");
        assert_eq!(error.code, "request_timeout");
        assert!(!client.is_connected());
        assert!(incoming.recv().await.is_none());
        fixture.await.expect("fixture task");
    }

    #[tokio::test]
    async fn responding_to_a_server_request_waits_for_the_socket_write() {
        let root = tempfile::tempdir().expect("tempdir");
        let socket_path = root.path().join("app.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind fixture");
        let fixture = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = accept_async(stream).await.expect("websocket");
            socket
                .send(Message::Text(
                    json!({
                        "id": "approval-1",
                        "method": "item/commandExecution/requestApproval",
                        "params": { "threadId": "thread-1" },
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("server request");
            let response = socket.next().await.expect("response").expect("frame");
            serde_json::from_str::<Value>(response.to_text().expect("text")).expect("response json")
        });

        let (client, mut incoming) = JsonRpcSocketClient::connect(&socket_path)
            .await
            .expect("connect");
        let request = incoming.recv().await.expect("incoming request");
        client
            .respond(
                request.id.expect("request id"),
                Ok(json!({ "decision": "accept" })),
            )
            .await
            .expect("written response");
        let response = fixture.await.expect("fixture task");
        assert_eq!(response["id"], "approval-1");
        assert_eq!(response["result"]["decision"], "accept");
    }
}
