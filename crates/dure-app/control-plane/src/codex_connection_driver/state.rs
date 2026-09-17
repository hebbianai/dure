use std::collections::{BTreeMap, VecDeque};

use serde_json::{Value, json};

use super::CodexConnectionDriverError;

const MAX_RETAINED_BYTES: usize = 8 * 1024 * 1024;
const MAX_RETAINED_MESSAGES: usize = 256;

#[derive(Clone)]
pub(super) struct ClientRequestRoute {
    pub(super) connection_id: u64,
    pub(super) downstream_id: Value,
    pub(super) kind: ClientRequestKind,
}

#[derive(Clone, Eq, PartialEq)]
pub(super) struct ThreadAttachIntent {
    pub(super) method: String,
    pub(super) params: Value,
}

#[derive(Clone)]
pub(super) enum ClientRequestKind {
    Passthrough,
    ThreadLaunch(ThreadAttachIntent),
    ThreadRefresh { base_result: Value },
    TurnStart { thread_id: String },
}

pub(super) struct AttachedThread {
    pub(super) launch: ThreadAttachIntent,
    pub(super) thread_id: String,
    pub(super) result: Value,
    pub(super) materialized: bool,
}

pub(super) struct PendingServerRequest {
    pub(super) message: Value,
    encoded_bytes: usize,
    pub(super) delivered_to: Option<u64>,
    pub(super) queued: bool,
}

pub(super) enum RetainedDelivery {
    Notification {
        message: Value,
        encoded_bytes: usize,
    },
    ServerRequest(String),
}

#[derive(Default)]
pub(super) struct RetainedUpstream {
    pub(super) deliveries: VecDeque<RetainedDelivery>,
    pub(super) server_requests: BTreeMap<String, PendingServerRequest>,
    pub(super) encoded_bytes: usize,
}

impl RetainedUpstream {
    pub(super) fn can_read_upstream(&self) -> bool {
        self.deliveries.len() < MAX_RETAINED_MESSAGES
            && self.server_requests.len() < MAX_RETAINED_MESSAGES
            && self.encoded_bytes < MAX_RETAINED_BYTES
    }

    pub(super) fn retain_notification(
        &mut self,
        message: Value,
    ) -> Result<(), CodexConnectionDriverError> {
        let encoded_bytes = encoded_len(&message)?;
        if self.deliveries.len() >= MAX_RETAINED_MESSAGES {
            return Err(CodexConnectionDriverError::new(
                "retained_capacity_exceeded",
            ));
        }
        self.encoded_bytes = retained_bytes_after(self.encoded_bytes, encoded_bytes)?;
        self.deliveries.push_back(RetainedDelivery::Notification {
            message,
            encoded_bytes,
        });
        Ok(())
    }

    pub(super) fn retain_server_request(
        &mut self,
        message: Value,
        queued: bool,
    ) -> Result<String, CodexConnectionDriverError> {
        let key = request_key(
            message
                .get("id")
                .ok_or_else(|| CodexConnectionDriverError::new("upstream_message_invalid"))?,
        )?;
        if let Some(existing) = self.server_requests.get_mut(&key) {
            if existing.message != message {
                return Err(CodexConnectionDriverError::new("server_request_conflict"));
            }
            if queued && !existing.queued {
                ensure_delivery_capacity(self.deliveries.len(), 1)?;
                existing.queued = true;
                self.deliveries
                    .push_back(RetainedDelivery::ServerRequest(key.clone()));
            }
            return Ok(key);
        }
        let encoded_bytes = encoded_len(&message)?;
        if self.server_requests.len() >= MAX_RETAINED_MESSAGES
            || queued && self.deliveries.len() >= MAX_RETAINED_MESSAGES
        {
            return Err(CodexConnectionDriverError::new(
                "retained_capacity_exceeded",
            ));
        }
        self.encoded_bytes = retained_bytes_after(self.encoded_bytes, encoded_bytes)?;
        self.server_requests.insert(
            key.clone(),
            PendingServerRequest {
                message,
                encoded_bytes,
                delivered_to: None,
                queued,
            },
        );
        if queued {
            self.deliveries
                .push_back(RetainedDelivery::ServerRequest(key.clone()));
        }
        Ok(key)
    }

    pub(super) fn remove_server_request(
        &mut self,
        id: &Value,
    ) -> Result<bool, CodexConnectionDriverError> {
        let key = request_key(id)?;
        let Some(request) = self.server_requests.remove(&key) else {
            return Ok(false);
        };
        self.encoded_bytes = self.encoded_bytes.saturating_sub(request.encoded_bytes);
        Ok(true)
    }

    pub(super) fn resolve_from_notification(&mut self, message: &Value) {
        if message.get("method").and_then(Value::as_str) != Some("serverRequest/resolved") {
            return;
        }
        let Some(id) = message.pointer("/params/requestId") else {
            return;
        };
        let _ = self.remove_server_request(id);
    }

    pub(super) fn queue_server_request(
        &mut self,
        key: &str,
    ) -> Result<(), CodexConnectionDriverError> {
        let Some(request) = self.server_requests.get_mut(key) else {
            return Ok(());
        };
        if request.queued {
            return Ok(());
        }
        ensure_delivery_capacity(self.deliveries.len(), 1)?;
        request.queued = true;
        self.deliveries
            .push_back(RetainedDelivery::ServerRequest(key.into()));
        Ok(())
    }

    pub(super) fn record_server_request_delivery(
        &mut self,
        key: &str,
        connection_id: u64,
        delivered: bool,
    ) -> Result<(), CodexConnectionDriverError> {
        if !delivered {
            self.queue_server_request(key)?;
        }
        if let Some(request) = self.server_requests.get_mut(key) {
            request.delivered_to = delivered.then_some(connection_id);
        }
        Ok(())
    }

    fn detach(&mut self, connection_id: u64) -> Result<(), CodexConnectionDriverError> {
        let replay_count = self
            .server_requests
            .values()
            .filter(|request| request.delivered_to == Some(connection_id) && !request.queued)
            .count();
        ensure_delivery_capacity(self.deliveries.len(), replay_count)?;
        for (key, request) in &mut self.server_requests {
            if request.delivered_to != Some(connection_id) {
                continue;
            }
            request.delivered_to = None;
            if !request.queued {
                request.queued = true;
                self.deliveries
                    .push_back(RetainedDelivery::ServerRequest(key.clone()));
            }
        }
        Ok(())
    }
}

pub(super) struct DriverState {
    pub(super) initialize_result: Value,
    pub(super) attached_thread: Option<AttachedThread>,
    next_connection_id: u64,
    next_upstream_request_id: u64,
    pub(super) client_requests: BTreeMap<u64, ClientRequestRoute>,
    pub(super) retained: RetainedUpstream,
}

impl DriverState {
    pub(super) fn new(initialize_result: Value) -> Self {
        Self {
            initialize_result,
            attached_thread: None,
            next_connection_id: 1,
            next_upstream_request_id: 2,
            client_requests: BTreeMap::new(),
            retained: RetainedUpstream::default(),
        }
    }

    pub(super) fn next_connection(&mut self) -> Result<u64, CodexConnectionDriverError> {
        let connection_id = self.next_connection_id;
        self.next_connection_id = connection_id
            .checked_add(1)
            .ok_or_else(|| CodexConnectionDriverError::new("connection_sequence_exhausted"))?;
        Ok(connection_id)
    }

    pub(super) fn route_client_request(
        &mut self,
        connection_id: u64,
        message: &mut Value,
        kind: ClientRequestKind,
    ) -> Result<(), CodexConnectionDriverError> {
        let downstream_id = message
            .get("id")
            .cloned()
            .ok_or_else(|| CodexConnectionDriverError::new("downstream_message_invalid"))?;
        let upstream_id = self.next_upstream_request_id;
        self.next_upstream_request_id = upstream_id
            .checked_add(1)
            .ok_or_else(|| CodexConnectionDriverError::new("request_sequence_exhausted"))?;
        message
            .as_object_mut()
            .ok_or_else(|| CodexConnectionDriverError::new("downstream_message_invalid"))?
            .insert("id".into(), json!(upstream_id));
        self.client_requests.insert(
            upstream_id,
            ClientRequestRoute {
                connection_id,
                downstream_id,
                kind,
            },
        );
        Ok(())
    }

    pub(super) fn detach(&mut self, connection_id: u64) -> Result<(), CodexConnectionDriverError> {
        self.retained.detach(connection_id)
    }
}

pub(super) fn retain_upstream_event(
    retained: &mut RetainedUpstream,
    message: Value,
) -> Result<(), CodexConnectionDriverError> {
    let method = message.get("method").and_then(Value::as_str);
    if method.is_none() {
        return Err(CodexConnectionDriverError::new("upstream_message_invalid"));
    }
    if message.get("id").is_some() {
        retained.retain_server_request(message, true)?;
    } else {
        retained.resolve_from_notification(&message);
        retained.retain_notification(message)?;
    }
    Ok(())
}

pub(super) fn complete_client_request(
    state: &mut DriverState,
    message: &Value,
) -> Result<Option<(ClientRequestRoute, Value)>, CodexConnectionDriverError> {
    if message.get("result").is_none() && message.get("error").is_none() {
        return Ok(None);
    }
    let Some(upstream_id) = message.get("id").and_then(Value::as_u64) else {
        return Ok(None);
    };
    let Some(route) = state.client_requests.remove(&upstream_id) else {
        return Ok(None);
    };
    let mut response = message.clone();
    if let Some(result) = message.get("result") {
        match route.kind.clone() {
            ClientRequestKind::Passthrough => {}
            ClientRequestKind::ThreadLaunch(launch) => {
                let thread_id = result
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .filter(|thread_id| !thread_id.is_empty())
                    .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?
                    .to_owned();
                state.attached_thread = Some(AttachedThread {
                    materialized: launch.method == "thread/resume"
                        || result
                            .pointer("/thread/turns")
                            .and_then(Value::as_array)
                            .is_some_and(|turns| !turns.is_empty()),
                    launch,
                    thread_id,
                    result: result.clone(),
                });
            }
            ClientRequestKind::ThreadRefresh { mut base_result } => {
                let thread = result
                    .get("thread")
                    .cloned()
                    .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?;
                base_result
                    .as_object_mut()
                    .ok_or_else(|| CodexConnectionDriverError::new("thread_attach_invalid"))?
                    .insert("thread".into(), thread);
                response
                    .as_object_mut()
                    .ok_or_else(|| CodexConnectionDriverError::new("upstream_message_invalid"))?
                    .insert("result".into(), base_result.clone());
                if let Some(attached) = state.attached_thread.as_mut() {
                    attached.result = base_result;
                }
            }
            ClientRequestKind::TurnStart { thread_id } => {
                if let Some(attached) = state
                    .attached_thread
                    .as_mut()
                    .filter(|attached| attached.thread_id == thread_id)
                {
                    attached.materialized = true;
                }
            }
        }
    }
    Ok(Some((route, response)))
}

pub(super) fn observe_thread_materialized(state: &mut DriverState, message: &Value) {
    if message.get("method").and_then(Value::as_str) != Some("turn/started") {
        return;
    }
    let Some(thread_id) = message.pointer("/params/threadId").and_then(Value::as_str) else {
        return;
    };
    if let Some(attached) = state
        .attached_thread
        .as_mut()
        .filter(|attached| attached.thread_id == thread_id)
    {
        attached.materialized = true;
    }
}

fn encoded_len(value: &Value) -> Result<usize, CodexConnectionDriverError> {
    serde_json::to_vec(value)
        .map(|value| value.len())
        .map_err(|_| CodexConnectionDriverError::new("message_json_invalid"))
}

fn retained_bytes_after(
    current: usize,
    additional: usize,
) -> Result<usize, CodexConnectionDriverError> {
    current
        .checked_add(additional)
        .filter(|total| *total <= MAX_RETAINED_BYTES)
        .ok_or_else(|| CodexConnectionDriverError::new("retained_capacity_exceeded"))
}

fn ensure_delivery_capacity(
    current: usize,
    additional: usize,
) -> Result<(), CodexConnectionDriverError> {
    current
        .checked_add(additional)
        .filter(|total| *total <= MAX_RETAINED_MESSAGES)
        .map(|_| ())
        .ok_or_else(|| CodexConnectionDriverError::new("retained_capacity_exceeded"))
}

fn request_key(id: &Value) -> Result<String, CodexConnectionDriverError> {
    if !id.is_string() && !id.is_number() {
        return Err(CodexConnectionDriverError::new("request_id_invalid"));
    }
    serde_json::to_string(id).map_err(|_| CodexConnectionDriverError::new("request_id_invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_thread_state_survives_connection_replacement_and_refreshes_history() {
        let mut state = DriverState::new(json!({}));
        let launch = ThreadAttachIntent {
            method: "thread/start".into(),
            params: json!({ "cwd": "/workspace" }),
        };
        let mut request = json!({ "id": 41, "method": "thread/start", "params": launch.params });
        state
            .route_client_request(1, &mut request, ClientRequestKind::ThreadLaunch(launch))
            .unwrap();
        assert_eq!(request["id"], 2);

        let (route, _) = complete_client_request(
            &mut state,
            &json!({
                "id": 2,
                "result": {
                    "cwd": "/workspace",
                    "thread": { "id": "thread-1", "turns": [] },
                },
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(route.connection_id, 1);
        assert!(!state.attached_thread.as_ref().unwrap().materialized);

        observe_thread_materialized(
            &mut state,
            &json!({ "method": "turn/started", "params": { "threadId": "thread-1" } }),
        );
        let base_result = state.attached_thread.as_ref().unwrap().result.clone();
        let mut read = json!({ "id": 42, "method": "thread/read", "params": {} });
        state
            .route_client_request(
                2,
                &mut read,
                ClientRequestKind::ThreadRefresh { base_result },
            )
            .unwrap();
        let (_, response) = complete_client_request(
            &mut state,
            &json!({
                "id": 3,
                "result": { "thread": { "id": "thread-1", "turns": [{ "id": "turn-1" }] } },
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(response["result"]["cwd"], "/workspace");
        assert_eq!(response["result"]["thread"]["turns"][0]["id"], "turn-1");
    }

    #[test]
    fn server_requests_become_replayable_when_the_client_detaches() {
        let mut retained = RetainedUpstream::default();
        let request =
            json!({ "id": "approval-1", "method": "item/commandExecution/requestApproval" });
        let key = retained.retain_server_request(request, false).unwrap();
        retained.server_requests.get_mut(&key).unwrap().delivered_to = Some(7);

        retained.detach(7).unwrap();

        assert_eq!(retained.server_requests[&key].delivered_to, None);
        assert!(matches!(
            retained.deliveries.front(),
            Some(RetainedDelivery::ServerRequest(replay)) if replay == &key
        ));
        assert!(
            retained
                .remove_server_request(&json!("approval-1"))
                .unwrap()
        );
        assert!(retained.server_requests.is_empty());
        assert_eq!(retained.encoded_bytes, 0);
    }

    #[test]
    fn one_oversized_notification_cannot_cross_the_retained_replay_byte_limit() {
        let mut retained = RetainedUpstream::default();
        let message = json!({
            "method": "item/completed",
            "params": { "payload": "x".repeat(MAX_RETAINED_BYTES) },
        });

        let error = retained.retain_notification(message).unwrap_err();

        assert_eq!(error.reason, "retained_capacity_exceeded");
        assert_eq!(retained.encoded_bytes, 0);
        assert!(retained.deliveries.is_empty());
    }

    #[test]
    fn one_oversized_server_request_cannot_cross_the_retained_replay_byte_limit() {
        let mut retained = RetainedUpstream::default();
        let message = json!({
            "id": "approval-oversized",
            "method": "item/commandExecution/requestApproval",
            "params": { "payload": "x".repeat(MAX_RETAINED_BYTES) },
        });

        let error = retained.retain_server_request(message, true).unwrap_err();

        assert_eq!(error.reason, "retained_capacity_exceeded");
        assert_eq!(retained.encoded_bytes, 0);
        assert!(retained.deliveries.is_empty());
        assert!(retained.server_requests.is_empty());
    }

    #[test]
    fn detach_cannot_requeue_past_the_retained_delivery_limit() {
        let mut retained = RetainedUpstream::default();
        for index in 0..MAX_RETAINED_MESSAGES {
            retained
                .retain_notification(
                    json!({ "method": "item/completed", "params": { "index": index } }),
                )
                .unwrap();
        }
        let key = retained
            .retain_server_request(
                json!({ "id": "approval-at-cap", "method": "item/commandExecution/requestApproval" }),
                false,
            )
            .unwrap();
        retained.server_requests.get_mut(&key).unwrap().delivered_to = Some(7);

        let error = retained.detach(7).unwrap_err();

        assert_eq!(error.reason, "retained_capacity_exceeded");
        assert_eq!(retained.deliveries.len(), MAX_RETAINED_MESSAGES);
        assert_eq!(retained.server_requests[&key].delivered_to, Some(7));
        assert!(!retained.server_requests[&key].queued);
    }
}
