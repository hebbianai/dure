use std::collections::BTreeMap;
use std::sync::{Arc, Weak};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{Mutex, broadcast, oneshot, watch};

use crate::claude_sdk_host_supervisor::ClaudeSdkHostLease;

const FRAME_MAGIC: &[u8; 4] = b"DCH1";
const FRAME_HEADER_BYTES: usize = 8;
const MAX_FRAME_BYTES: usize = 256 * 1024;
const MAX_PENDING_REQUESTS: usize = 128;
const EVENT_CAPACITY: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeDch1Error {
    boundary: ClaudeDch1FailureBoundary,
    remote_failure: Option<ClaudeDch1RemoteFailure>,
    reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeDch1FailureBoundary {
    LocalOrTransport,
    RemoteResponse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeDch1RemoteFailure {
    ExactQueryInactive,
    QueryBusy,
    Other,
}

impl ClaudeDch1Error {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            boundary: ClaudeDch1FailureBoundary::LocalOrTransport,
            remote_failure: None,
            reason: reason.into(),
        }
    }

    fn remote(reason: &str) -> Self {
        Self {
            boundary: ClaudeDch1FailureBoundary::RemoteResponse,
            remote_failure: Some(match reason {
                "query_exited" | "stale_runtime_generation" => {
                    ClaudeDch1RemoteFailure::ExactQueryInactive
                }
                "query_busy" => ClaudeDch1RemoteFailure::QueryBusy,
                _ => ClaudeDch1RemoteFailure::Other,
            }),
            reason: format!("remote_{reason}"),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn is_remote_response(&self) -> bool {
        self.boundary == ClaudeDch1FailureBoundary::RemoteResponse
    }

    pub fn is_query_busy(&self) -> bool {
        self.remote_failure == Some(ClaudeDch1RemoteFailure::QueryBusy)
    }

    pub fn has_exact_retirement_candidate(&self) -> bool {
        self.remote_failure == Some(ClaudeDch1RemoteFailure::ExactQueryInactive)
    }
}

impl std::fmt::Display for ClaudeDch1Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "dure_claude_dch1_{}", self.reason)
    }
}

impl std::error::Error for ClaudeDch1Error {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeDch1QueryIdentity {
    pub runtime_generation: String,
    pub query_epoch: String,
    pub relay_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeDch1HostIdentity {
    pub host_generation: String,
    pub host_instance_id: String,
}

impl ClaudeDch1HostIdentity {
    pub fn validate(&self) -> Result<(), ClaudeDch1Error> {
        if !safe_token(&self.host_generation) || !safe_token(&self.host_instance_id) {
            return Err(ClaudeDch1Error::new("host_identity_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeDch1ProviderRetirementPhase {
    Retired,
    TargetBound,
    Released,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeDch1ProviderRetirementAuthority {
    pub source: ClaudeDch1QueryIdentity,
    pub allowed_target: Option<ClaudeDch1QueryIdentity>,
    pub source_host: ClaudeDch1HostIdentity,
    pub target_host: Option<ClaudeDch1HostIdentity>,
    pub phase: ClaudeDch1ProviderRetirementPhase,
}

impl ClaudeDch1ProviderRetirementAuthority {
    pub fn validate(&self) -> Result<(), ClaudeDch1Error> {
        self.source.validate()?;
        self.source_host.validate()?;
        if let Some(target) = self.allowed_target.as_ref() {
            target.validate()?;
            if target.runtime_generation == self.source.runtime_generation
                || target.query_epoch == self.source.query_epoch
                || target.relay_id == self.source.relay_id
            {
                return Err(ClaudeDch1Error::new("retirement_authority_invalid"));
            }
        }
        if let Some(target_host) = self.target_host.as_ref() {
            target_host.validate()?;
        }
        let valid_phase = match self.phase {
            ClaudeDch1ProviderRetirementPhase::Retired => self.target_host.is_none(),
            ClaudeDch1ProviderRetirementPhase::TargetBound => {
                self.allowed_target.is_some() && self.target_host.is_some()
            }
            ClaudeDch1ProviderRetirementPhase::Released => {
                self.allowed_target.is_some() || self.target_host.is_none()
            }
        };
        if !valid_phase {
            return Err(ClaudeDch1Error::new("retirement_authority_invalid"));
        }
        Ok(())
    }
}

impl ClaudeDch1QueryIdentity {
    pub fn validate(&self) -> Result<(), ClaudeDch1Error> {
        for value in [&self.runtime_generation, &self.query_epoch, &self.relay_id] {
            if !safe_token(value) {
                return Err(ClaudeDch1Error::new("identity_invalid"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeDch1ProviderEvent {
    pub sequence: i64,
    pub kind: String,
    pub payload: Value,
}

impl ClaudeDch1ProviderEvent {
    fn validate(&self) -> Result<(), ClaudeDch1Error> {
        if self.sequence < 1 || !safe_token(&self.kind) {
            return Err(ClaudeDch1Error::new("provider_event_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeDch1EventFrame {
    pub identity: ClaudeDch1QueryIdentity,
    pub event: ClaudeDch1ProviderEvent,
}

pub struct AttachedClaudeDch1Client {
    pub client: ClaudeDch1Client,
    pub snapshot: Value,
    pub events: broadcast::Receiver<ClaudeDch1EventFrame>,
    pub terminal: watch::Receiver<Option<ClaudeDch1Error>>,
}

#[derive(Clone)]
pub struct ClaudeDch1Client {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    events: broadcast::Sender<ClaudeDch1EventFrame>,
    host_generation: String,
    pending: Mutex<PendingRequests>,
    terminal: watch::Sender<Option<ClaudeDch1Error>>,
    writer: Mutex<WriterState>,
}

type PendingRequests = BTreeMap<u64, oneshot::Sender<Result<Value, ClaudeDch1Error>>>;

struct WriterState {
    request_sequence: u64,
    writer: OwnedWriteHalf,
}

impl ClaudeDch1Client {
    /// Opens the one shared control connection for a Claude SDK host. Clone the
    /// returned client for per-interaction bridges; do not attach once per pane.
    pub async fn connect(
        lease: &ClaudeSdkHostLease,
        client_generation: &str,
        cursors: BTreeMap<String, i64>,
    ) -> Result<AttachedClaudeDch1Client, ClaudeDch1Error> {
        if !safe_token(client_generation)
            || cursors
                .iter()
                .any(|(generation, sequence)| !safe_token(generation) || *sequence < 0)
        {
            return Err(ClaudeDch1Error::new("attach_configuration_invalid"));
        }
        let stream = UnixStream::connect(lease.endpoint())
            .await
            .map_err(|_| ClaudeDch1Error::new("connect_failed"))?;
        let (client, event_receiver, terminal_receiver) =
            Self::from_stream(stream, lease.host_generation());
        let mut fields = Map::new();
        fields.insert(
            "capability".into(),
            Value::String(lease.capability().into()),
        );
        fields.insert(
            "clientGeneration".into(),
            Value::String(client_generation.into()),
        );
        fields.insert(
            "cursors".into(),
            serde_json::to_value(cursors).map_err(|_| ClaudeDch1Error::new("cursors_invalid"))?,
        );
        let snapshot = client.send("attach", fields).await?;
        Ok(AttachedClaudeDch1Client {
            client,
            snapshot,
            events: event_receiver,
            terminal: terminal_receiver,
        })
    }

    fn from_stream(
        stream: UnixStream,
        host_generation: &str,
    ) -> (
        Self,
        broadcast::Receiver<ClaudeDch1EventFrame>,
        watch::Receiver<Option<ClaudeDch1Error>>,
    ) {
        let (reader, writer) = stream.into_split();
        let (events, event_receiver) = broadcast::channel(EVENT_CAPACITY);
        let (terminal, terminal_receiver) = watch::channel(None);
        let inner = Arc::new(ClientInner {
            events,
            host_generation: host_generation.into(),
            pending: Mutex::new(BTreeMap::new()),
            terminal,
            writer: Mutex::new(WriterState {
                request_sequence: 0,
                writer,
            }),
        });
        tokio::spawn(read_loop(reader, Arc::downgrade(&inner)));
        let client = Self { inner };
        (client, event_receiver, terminal_receiver)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ClaudeDch1EventFrame> {
        self.inner.events.subscribe()
    }

    pub fn terminal(&self) -> watch::Receiver<Option<ClaudeDch1Error>> {
        self.inner.terminal.subscribe()
    }

    pub async fn request(&self, action: &str, payload: Value) -> Result<Value, ClaudeDch1Error> {
        if !safe_token(action) || !payload.is_object() {
            return Err(ClaudeDch1Error::new("request_invalid"));
        }
        let mut fields = Map::new();
        fields.insert("action".into(), Value::String(action.into()));
        fields.insert("payload".into(), payload);
        self.send("request", fields).await
    }

    async fn send(
        &self,
        kind: &str,
        mut fields: Map<String, Value>,
    ) -> Result<Value, ClaudeDch1Error> {
        if self.inner.terminal.borrow().is_some() {
            return Err(ClaudeDch1Error::new("transport_closed"));
        }
        let (sender, receiver) = oneshot::channel();
        let mut writer = self.inner.writer.lock().await;
        if self.inner.pending.lock().await.len() >= MAX_PENDING_REQUESTS {
            return Err(ClaudeDch1Error::new("pending_request_capacity_exceeded"));
        }
        let request_sequence = writer
            .request_sequence
            .checked_add(1)
            .ok_or_else(|| ClaudeDch1Error::new("request_sequence_exhausted"))?;
        fields.insert("kind".into(), Value::String(kind.into()));
        fields.insert(
            "hostGeneration".into(),
            Value::String(self.inner.host_generation.clone()),
        );
        fields.insert("requestSequence".into(), Value::from(request_sequence));
        let frame = encode_frame(Value::Object(fields))?;
        writer.request_sequence = request_sequence;
        self.inner
            .pending
            .lock()
            .await
            .insert(request_sequence, sender);
        if writer.writer.write_all(&frame).await.is_err() {
            self.inner.pending.lock().await.remove(&request_sequence);
            return Err(ClaudeDch1Error::new("write_failed"));
        }
        drop(writer);
        receiver
            .await
            .map_err(|_| ClaudeDch1Error::new("transport_closed"))?
    }
}

async fn read_loop(mut reader: OwnedReadHalf, inner: Weak<ClientInner>) {
    let result = read_frames(&mut reader, &inner).await;
    let Some(inner) = inner.upgrade() else {
        return;
    };
    let error = result
        .err()
        .unwrap_or_else(|| ClaudeDch1Error::new("transport_closed"));
    inner.terminal.send_replace(Some(error.clone()));
    let pending = std::mem::take(&mut *inner.pending.lock().await);
    for sender in pending.into_values() {
        let _ = sender.send(Err(error.clone()));
    }
}

async fn read_frames(
    reader: &mut OwnedReadHalf,
    inner: &Weak<ClientInner>,
) -> Result<(), ClaudeDch1Error> {
    let mut expected_server_sequence = 0_u64;
    loop {
        let value = read_frame(reader).await?;
        let inner = inner
            .upgrade()
            .ok_or_else(|| ClaudeDch1Error::new("client_dropped"))?;
        let object = value
            .as_object()
            .ok_or_else(|| ClaudeDch1Error::new("server_frame_invalid"))?;
        if object.get("hostGeneration").and_then(Value::as_str)
            != Some(inner.host_generation.as_str())
        {
            return Err(ClaudeDch1Error::new("stale_host_generation"));
        }
        let server_sequence = object
            .get("serverSequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| ClaudeDch1Error::new("server_sequence_invalid"))?;
        expected_server_sequence = expected_server_sequence
            .checked_add(1)
            .ok_or_else(|| ClaudeDch1Error::new("server_sequence_exhausted"))?;
        if server_sequence != expected_server_sequence {
            return Err(ClaudeDch1Error::new("server_sequence_unordered"));
        }
        match object.get("kind").and_then(Value::as_str) {
            Some("event") => {
                let identity: ClaudeDch1QueryIdentity = serde_json::from_value(
                    object
                        .get("identity")
                        .cloned()
                        .ok_or_else(|| ClaudeDch1Error::new("event_identity_invalid"))?,
                )
                .map_err(|_| ClaudeDch1Error::new("event_identity_invalid"))?;
                identity.validate()?;
                let event: ClaudeDch1ProviderEvent = serde_json::from_value(
                    object
                        .get("event")
                        .cloned()
                        .ok_or_else(|| ClaudeDch1Error::new("provider_event_invalid"))?,
                )
                .map_err(|_| ClaudeDch1Error::new("provider_event_invalid"))?;
                event.validate()?;
                let _ = inner.events.send(ClaudeDch1EventFrame { identity, event });
            }
            Some("response") => {
                let request_sequence = object
                    .get("requestSequence")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| ClaudeDch1Error::new("response_invalid"))?;
                let sender = inner
                    .pending
                    .lock()
                    .await
                    .remove(&request_sequence)
                    .ok_or_else(|| ClaudeDch1Error::new("response_unmatched"))?;
                let response = match object.get("ok").and_then(Value::as_bool) {
                    Some(true) => Ok(object.get("result").cloned().unwrap_or(Value::Null)),
                    Some(false) => {
                        let reason = object
                            .get("error")
                            .and_then(Value::as_object)
                            .and_then(|error| error.get("reason"))
                            .and_then(Value::as_str)
                            .filter(|reason| safe_reason(reason))
                            .ok_or_else(|| ClaudeDch1Error::new("remote_error_invalid"))?;
                        Err(ClaudeDch1Error::remote(reason))
                    }
                    None => return Err(ClaudeDch1Error::new("response_invalid")),
                };
                let _ = sender.send(response);
            }
            _ => return Err(ClaudeDch1Error::new("server_frame_kind_invalid")),
        }
    }
}

async fn read_frame(reader: &mut OwnedReadHalf) -> Result<Value, ClaudeDch1Error> {
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|_| ClaudeDch1Error::new("read_failed"))?;
    if &header[..4] != FRAME_MAGIC {
        return Err(ClaudeDch1Error::new("frame_magic_invalid"));
    }
    let length = usize::try_from(u32::from_be_bytes(
        header[4..]
            .try_into()
            .map_err(|_| ClaudeDch1Error::new("frame_header_invalid"))?,
    ))
    .map_err(|_| ClaudeDch1Error::new("frame_size_invalid"))?;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(ClaudeDch1Error::new("frame_size_invalid"));
    }
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| ClaudeDch1Error::new("read_failed"))?;
    serde_json::from_slice(&body).map_err(|_| ClaudeDch1Error::new("frame_json_invalid"))
}

fn encode_frame(value: Value) -> Result<Vec<u8>, ClaudeDch1Error> {
    if !value.is_object() {
        return Err(ClaudeDch1Error::new("frame_invalid"));
    }
    let body =
        serde_json::to_vec(&value).map_err(|_| ClaudeDch1Error::new("frame_json_invalid"))?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(ClaudeDch1Error::new("frame_size_invalid"));
    }
    let body_length =
        u32::try_from(body.len()).map_err(|_| ClaudeDch1Error::new("frame_size_invalid"))?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + body.len());
    frame.extend_from_slice(FRAME_MAGIC);
    frame.extend_from_slice(&body_length.to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

fn safe_reason(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shared_client_demultiplexes_ordered_responses_and_push_events() {
        let (client_stream, server_stream) = UnixStream::pair().unwrap();
        let (client, mut events, mut terminal) =
            ClaudeDch1Client::from_stream(client_stream, "host-generation-1");
        let (mut server_reader, mut server_writer) = server_stream.into_split();
        let server = tokio::spawn(async move {
            let request = read_frame(&mut server_reader).await.unwrap();
            assert_eq!(request["action"], "snapshot");
            assert_eq!(request["requestSequence"], 1);
            server_writer
                .write_all(
                    &encode_frame(serde_json::json!({
                        "hostGeneration": "host-generation-1",
                        "kind": "response",
                        "ok": true,
                        "requestSequence": 1,
                        "result": { "state": "ready" },
                        "serverSequence": 1
                    }))
                    .unwrap(),
                )
                .await
                .unwrap();
            server_writer
                .write_all(
                    &encode_frame(serde_json::json!({
                        "hostGeneration": "host-generation-1",
                        "identity": {
                            "queryEpoch": "query-1",
                            "relayId": "relay-1",
                            "runtimeGeneration": "runtime-1"
                        },
                        "kind": "event",
                        "event": {
                            "kind": "initialized",
                            "payload": {},
                            "sequence": 1
                        },
                        "serverSequence": 2
                    }))
                    .unwrap(),
                )
                .await
                .unwrap();
        });
        let response = client
            .request("snapshot", serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(response["state"], "ready");
        let event = events.recv().await.unwrap();
        assert_eq!(event.identity.runtime_generation, "runtime-1");
        assert_eq!(event.event.sequence, 1);
        server.await.unwrap();
        if terminal.borrow().is_none() {
            terminal.changed().await.unwrap();
        }
        assert_eq!(terminal.borrow().as_ref().unwrap().reason(), "read_failed");
    }

    #[tokio::test]
    async fn rejected_local_frame_does_not_burn_the_wire_request_sequence() {
        let (client_stream, server_stream) = UnixStream::pair().unwrap();
        let (client, _events, _terminal) =
            ClaudeDch1Client::from_stream(client_stream, "host-generation-1");
        let oversized = client
            .request(
                "oversized",
                serde_json::json!({ "value": "x".repeat(MAX_FRAME_BYTES) }),
            )
            .await
            .unwrap_err();
        assert_eq!(oversized.reason(), "frame_size_invalid");

        let (mut server_reader, mut server_writer) = server_stream.into_split();
        let server = tokio::spawn(async move {
            let request = read_frame(&mut server_reader).await.unwrap();
            assert_eq!(request["requestSequence"], 1);
            server_writer
                .write_all(
                    &encode_frame(serde_json::json!({
                        "hostGeneration": "host-generation-1",
                        "kind": "response",
                        "ok": true,
                        "requestSequence": 1,
                        "result": null,
                        "serverSequence": 1
                    }))
                    .unwrap(),
                )
                .await
                .unwrap();
        });
        client
            .request("snapshot", serde_json::json!({}))
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn terminal_state_survives_when_the_initial_observer_detaches() {
        let (client_stream, server_stream) = UnixStream::pair().unwrap();
        let (client, events, terminal) =
            ClaudeDch1Client::from_stream(client_stream, "host-generation-1");
        drop(events);
        drop(terminal);
        drop(server_stream);

        let mut reattached = client.terminal();
        if reattached.borrow().is_none() {
            reattached.changed().await.unwrap();
        }
        assert_eq!(
            reattached.borrow().as_ref().unwrap().reason(),
            "read_failed"
        );
    }

    #[test]
    fn remote_query_busy_is_parsed_once_at_the_protocol_boundary() {
        let busy = ClaudeDch1Error::remote("query_busy");
        assert!(busy.is_remote_response());
        assert!(busy.is_query_busy());
        assert_eq!(busy.reason(), "remote_query_busy");

        let conflict = ClaudeDch1Error::remote("query_identity_conflict");
        assert!(conflict.is_remote_response());
        assert!(!conflict.is_query_busy());

        for reason in ["query_exited", "stale_runtime_generation"] {
            assert!(ClaudeDch1Error::remote(reason).has_exact_retirement_candidate());
        }
    }
}
