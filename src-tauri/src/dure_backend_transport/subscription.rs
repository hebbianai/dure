use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{Manager, State, WebviewWindow};
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::{
    required_capabilities, request_id, route_authority, serialize_request, validate_wire_backend,
    DureBackendRouteV1, DureBackendTransportError, DureBackendTransportResult,
    DureBackendTransportState, PersistentConnection, SelectedProfile, WireBackend,
    BACKEND_PROTOCOL_API, SUBSCRIBE_CAPABILITY,
};

const SUBSCRIBE_OPERATION: &str = "agent_conversation.subscribe";
const MAX_SUBSCRIPTIONS: usize = 64;

pub(super) struct ActiveSubscription {
    owner_window: String,
    generation: String,
    cancel: oneshot::Sender<()>,
}

#[derive(Default)]
pub(super) struct ActiveSubscriptions {
    entries: StdMutex<BTreeMap<String, ActiveSubscription>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSubscriptionEvent {
    schema_version: u16,
    api_version: String,
    kind: String,
    backend: WireBackend,
    event: Value,
}

fn remove_if_current(
    subscriptions: &ActiveSubscriptions,
    subscription_id: &str,
    generation: &str,
) {
    if let Ok(mut subscriptions) = subscriptions.entries.lock() {
        if subscriptions
            .get(subscription_id)
            .is_some_and(|active| active.generation == generation)
        {
            subscriptions.remove(subscription_id);
        }
    }
}

fn reserve(
    subscriptions: &ActiveSubscriptions,
    subscription_id: &str,
    owner_window: &str,
    generation: &str,
) -> Result<oneshot::Receiver<()>, DureBackendTransportError> {
    let mut subscriptions = subscriptions.entries.lock().map_err(|_| {
        DureBackendTransportError::new(
            "backend_subscription_state_unavailable",
            "the backend subscription state is unavailable",
        )
    })?;
    if subscriptions.contains_key(subscription_id) {
        return Err(DureBackendTransportError::new(
            "backend_subscription_conflict",
            "the backend subscription identity is already active",
        ));
    }
    if subscriptions.len() >= MAX_SUBSCRIPTIONS {
        return Err(DureBackendTransportError::new(
            "backend_subscription_capacity",
            "the backend subscription capacity is exhausted",
        ));
    }
    let (cancel, receiver) = oneshot::channel();
    subscriptions.insert(
        subscription_id.into(),
        ActiveSubscription {
            owner_window: owner_window.into(),
            generation: generation.into(),
            cancel,
        },
    );
    Ok(receiver)
}

pub(super) fn cancel_window_subscriptions(
    subscriptions: &ActiveSubscriptions,
    owner_window: &str,
) -> usize {
    let canceled = {
        let mut entries = match subscriptions.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        let subscription_ids = entries
            .iter()
            .filter(|(_, active)| active.owner_window == owner_window)
            .map(|(subscription_id, _)| subscription_id.clone())
            .collect::<Vec<_>>();
        subscription_ids
            .into_iter()
            .filter_map(|subscription_id| entries.remove(&subscription_id))
            .collect::<Vec<_>>()
    };
    let count = canceled.len();
    for active in canceled {
        let _ = active.cancel.send(());
    }
    count
}

pub(crate) fn configure_window_lifecycle(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    // Plugin page-load hooks compose with the Hmux observer's existing hook.
    builder
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("dure-backend-subscriptions")
                .on_page_load(|webview, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Started {
                        webview
                            .state::<DureBackendTransportState>()
                            .cancel_window_subscriptions(webview.label());
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<DureBackendTransportState>()
                    .cancel_window_subscriptions(window.label());
            }
        })
}

fn subscription_event(
    source: &[u8],
    selected: &SelectedProfile,
    required: &[&str],
    request_id: &str,
    subscription_id: &str,
) -> Result<Value, DureBackendTransportError> {
    let wire: WireSubscriptionEvent = serde_json::from_slice(source).map_err(|_| {
        DureBackendTransportError::new(
            "backend_subscription_malformed_event",
            "the backend subscription event is malformed",
        )
    })?;
    validate_wire_backend(&wire.backend, selected, required)?;
    let event = wire.event.as_object().ok_or_else(|| {
        DureBackendTransportError::new(
            "backend_subscription_malformed_event",
            "the backend subscription event is malformed",
        )
    })?;
    let topic = event.get("topic").and_then(Value::as_str);
    if wire.schema_version != 1
        || wire.api_version != BACKEND_PROTOCOL_API
        || wire.kind != "dure.backend.event"
        || event.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || event.get("subscriptionRequestId").and_then(Value::as_str) != Some(request_id)
        || !matches!(
            topic,
            Some("agent_conversation.changed" | "agent_conversation.reset_required")
        )
    {
        return Err(DureBackendTransportError::new(
            "backend_subscription_malformed_event",
            "the backend subscription event is malformed",
        ));
    }
    Ok(json!({
        "schemaVersion": 1,
        "kind": "event",
        "subscriptionId": subscription_id,
        "backendId": wire.backend.id,
        "backendGeneration": wire.backend.generation,
        "event": wire.event,
    }))
}

fn send_terminal_error(
    channel: &Channel<Value>,
    subscription_id: &str,
    error: &DureBackendTransportError,
) {
    let _ = channel.send(json!({
        "schemaVersion": 1,
        "kind": "error",
        "subscriptionId": subscription_id,
        "error": error,
    }));
}

fn subscription_reset_required(
    seed: &DureBackendTransportResult,
    request_id: &str,
    subscription_id: &str,
    interaction_session_id: &str,
) -> Value {
    json!({
        "schemaVersion": 1,
        "kind": "event",
        "subscriptionId": subscription_id,
        "backendId": seed.backend_id,
        "backendGeneration": seed.backend_generation,
        "event": {
            "schemaVersion": 1,
            "topic": "agent_conversation.reset_required",
            "subscriptionRequestId": request_id,
            "interactionSessionId": interaction_session_id,
        },
    })
}

struct SubscriptionAuthority {
    selected: SelectedProfile,
    request: Vec<u8>,
    required: Vec<&'static str>,
}

fn resolve_subscription_authority(
    root: &Path,
    config: &super::RuntimeConfig,
    route: &DureBackendRouteV1,
    request_id: &str,
    body: &Value,
) -> Result<SubscriptionAuthority, DureBackendTransportError> {
    let selected = route_authority::select(root, config, route)?;
    let required = required_capabilities(&selected, SUBSCRIBE_CAPABILITY)?;
    let request = serialize_request(&selected, request_id, SUBSCRIBE_OPERATION, body, &required)?;
    Ok(SubscriptionAuthority {
        selected,
        request,
        required,
    })
}

fn resolve_following_subscription_authority(
    root: &Path,
    config: &super::RuntimeConfig,
    route: &DureBackendRouteV1,
    request_id: &str,
    body: &Value,
    previous: &SelectedProfile,
) -> Result<SubscriptionAuthority, DureBackendTransportError> {
    let authority = resolve_subscription_authority(root, config, route, request_id, body)?;
    if authority.selected.same_observation_target(previous) {
        Ok(authority)
    } else {
        Err(DureBackendTransportError::new(
            "backend_transport_target_changed",
            "the selected backend target changed while reconnecting",
        ))
    }
}

async fn connect_subscription(
    authority: &SubscriptionAuthority,
    config: &super::RuntimeConfig,
    request_id: &str,
) -> Result<(PersistentConnection, DureBackendTransportResult), DureBackendTransportError> {
    let deadline = Instant::now() + authority.selected.profile.deadline();
    let mut connection =
        PersistentConnection::connect(&authority.selected, config, deadline).await?;
    let response = match connection.exchange(&authority.request, deadline).await {
        Ok(response) => response,
        Err(error) => {
            connection.close().await;
            return Err(error);
        }
    };
    match super::parse_response(
        &response,
        request_id,
        &authority.selected,
        &authority.required,
    ) {
        Ok(initial) => {
            connection.release_startup_materials();
            Ok((connection, initial))
        }
        Err(error) => {
            connection.close().await;
            Err(error)
        }
    }
}

struct SubscriptionWorker {
    connection: PersistentConnection,
    authority: SubscriptionAuthority,
    reconnect_on_start: bool,
    root: PathBuf,
    route: DureBackendRouteV1,
    body: Value,
    config: super::RuntimeConfig,
    request_id: String,
    subscription_id: String,
    interaction_session_id: String,
    channel: Channel<Value>,
    cancel: oneshot::Receiver<()>,
    subscriptions: Weak<ActiveSubscriptions>,
    recovery: crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle,
}

impl SubscriptionWorker {
    async fn run(mut self) {
        if self.reconnect_on_start {
            let mut next_authority = match resolve_following_subscription_authority(
                &self.root,
                &self.config,
                &self.route,
                &self.request_id,
                &self.body,
                &self.authority.selected,
            ) {
                Ok(authority) => authority,
                Err(error) => {
                    send_terminal_error(&self.channel, &self.subscription_id, &error);
                    self.finish().await;
                    return;
                }
            };
            let connected =
                match connect_subscription(&next_authority, &self.config, &self.request_id).await {
                    Err(error)
                        if super::local_liveness_failure(&next_authority.selected, &error) =>
                    {
                        let Some(ticket) = self
                            .recovery
                            .begin_recovery(&next_authority.selected.profile)
                        else {
                            send_terminal_error(&self.channel, &self.subscription_id, &error);
                            self.finish().await;
                            return;
                        };
                        let recovered = tokio::select! {
                            _ = &mut self.cancel => None,
                            recovered = self.recovery.wait_for_recovery(&ticket) => Some(recovered),
                        };
                        let Some(recovered) = recovered else {
                            self.finish().await;
                            return;
                        };
                        if let Err(error) = recovered {
                            send_terminal_error(
                                &self.channel,
                                &self.subscription_id,
                                &super::coordinator_error(error),
                            );
                            self.finish().await;
                            return;
                        }
                        next_authority = match resolve_following_subscription_authority(
                            &self.root,
                            &self.config,
                            &self.route,
                            &self.request_id,
                            &self.body,
                            &self.authority.selected,
                        ) {
                            Ok(authority) => authority,
                            Err(error) => {
                                send_terminal_error(&self.channel, &self.subscription_id, &error);
                                self.finish().await;
                                return;
                            }
                        };
                        connect_subscription(&next_authority, &self.config, &self.request_id).await
                    }
                    result => result,
                };
            match connected {
                Ok((connection, seed)) => {
                    let stale = std::mem::replace(&mut self.connection, connection);
                    self.authority = next_authority;
                    let sent = self.channel.send(subscription_reset_required(
                        &seed,
                        &self.request_id,
                        &self.subscription_id,
                        &self.interaction_session_id,
                    ));
                    stale.close().await;
                    if sent.is_err() {
                        self.finish().await;
                        return;
                    }
                }
                Err(error) => {
                    send_terminal_error(&self.channel, &self.subscription_id, &error);
                    self.finish().await;
                    return;
                }
            }
        }
        'events: loop {
            let frame = tokio::select! {
                _ = &mut self.cancel => break,
                frame = self.connection.read_frame() => frame,
            };
            let message = match frame.and_then(|source| {
                subscription_event(
                    &source,
                    &self.authority.selected,
                    &self.authority.required,
                    &self.request_id,
                    &self.subscription_id,
                )
            }) {
                Ok(message) => message,
                Err(mut error) => loop {
                    if !super::local_liveness_failure(&self.authority.selected, &error) {
                        send_terminal_error(&self.channel, &self.subscription_id, &error);
                        break 'events;
                    }
                    let Some(ticket) = self
                        .recovery
                        .begin_recovery(&self.authority.selected.profile)
                    else {
                        send_terminal_error(&self.channel, &self.subscription_id, &error);
                        break 'events;
                    };
                    let recovered = tokio::select! {
                        _ = &mut self.cancel => break 'events,
                        recovered = self.recovery.wait_for_recovery(&ticket) => recovered,
                    };
                    if let Err(recovery_error) = recovered {
                        error = super::coordinator_error(recovery_error);
                        send_terminal_error(&self.channel, &self.subscription_id, &error);
                        break 'events;
                    }
                    let next_authority = match resolve_following_subscription_authority(
                        &self.root,
                        &self.config,
                        &self.route,
                        &self.request_id,
                        &self.body,
                        &self.authority.selected,
                    ) {
                        Ok(authority) => authority,
                        Err(next) => {
                            send_terminal_error(&self.channel, &self.subscription_id, &next);
                            break 'events;
                        }
                    };
                    self.authority = next_authority;
                    match connect_subscription(&self.authority, &self.config, &self.request_id)
                        .await
                    {
                        Ok((connection, seed)) => {
                            let stale = std::mem::replace(&mut self.connection, connection);
                            let reset = self.channel.send(subscription_reset_required(
                                &seed,
                                &self.request_id,
                                &self.subscription_id,
                                &self.interaction_session_id,
                            ));
                            stale.close().await;
                            if reset.is_err() {
                                break 'events;
                            }
                            continue 'events;
                        }
                        Err(next) => error = next,
                    }
                }
            };
            if self.channel.send(message).is_err() {
                break;
            }
        }
        self.finish().await;
    }

    async fn finish(self) {
        self.connection.close().await;
        if let Some(subscriptions) = self.subscriptions.upgrade() {
            remove_if_current(&subscriptions, &self.subscription_id, &self.request_id);
        }
    }
}

async fn open_subscription(
    root: &Path,
    state: &DureBackendTransportState,
    route: &DureBackendRouteV1,
    subscription_id: &str,
    owner_window: &str,
    body: Value,
    channel: Channel<Value>,
) -> Result<DureBackendTransportResult, DureBackendTransportError> {
    let interaction_session_id = body
        .get("interactionSessionId")
        .and_then(Value::as_str)
        .filter(|value| super::valid_token(value, 160))
        .map(str::to_owned);
    if !super::valid_token(subscription_id, 160) {
        return Err(DureBackendTransportError::new(
            "backend_subscription_invalid_request",
            "the backend subscription request is invalid",
        ));
    }
    let Some(interaction_session_id) = interaction_session_id else {
        return Err(DureBackendTransportError::new(
            "backend_subscription_invalid_request",
            "the backend subscription request is invalid",
        ));
    };
    let request_id = request_id()?;
    let mut authority =
        resolve_subscription_authority(root, &state.config, route, &request_id, &body)?;
    let cancel = reserve(
        &state.subscriptions,
        subscription_id,
        owner_window,
        &request_id,
    )?;
    let opened = async {
        authority = resolve_subscription_authority(root, &state.config, route, &request_id, &body)?;
        match connect_subscription(&authority, &state.config, &request_id).await {
            Ok(opened) => Ok(opened),
            Err(error) if super::local_liveness_failure(&authority.selected, &error) => {
                let Some(ticket) = state.recovery.begin_recovery(&authority.selected.profile)
                else {
                    return Err(error);
                };
                state
                    .recovery
                    .wait_for_recovery(&ticket)
                    .await
                    .map_err(super::coordinator_error)?;
                authority =
                    resolve_subscription_authority(root, &state.config, route, &request_id, &body)?;
                connect_subscription(&authority, &state.config, &request_id).await
            }
            Err(error) => Err(error),
        }
    }
    .await;
    let (connection, initial) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            remove_if_current(&state.subscriptions, subscription_id, &request_id);
            return Err(error);
        }
    };
    let current = match super::selected_profile(root, &state.config, route.profile_id()) {
        Ok(current) => current,
        Err(error) => {
            connection.close().await;
            remove_if_current(&state.subscriptions, subscription_id, &request_id);
            return Err(error);
        }
    };
    let follows_selected_generation = matches!(route, DureBackendRouteV1::Selected { .. });
    if follows_selected_generation && !current.same_observation_target(&authority.selected) {
        connection.close().await;
        remove_if_current(&state.subscriptions, subscription_id, &request_id);
        return Err(DureBackendTransportError::new(
            "backend_transport_target_changed",
            "the selected backend target changed while the subscription was opening",
        ));
    }
    if !follows_selected_generation && !current.same_connection_identity(&authority.selected) {
        connection.close().await;
        remove_if_current(&state.subscriptions, subscription_id, &request_id);
        return Err(DureBackendTransportError::new(
            "backend_transport_generation_changed",
            "the selected backend changed while the subscription was opening",
        ));
    }
    let reconnect_on_start =
        follows_selected_generation && !current.same_connection_identity(&authority.selected);
    let subscriptions = Arc::downgrade(&state.subscriptions);
    let subscription_id = subscription_id.to_owned();
    tauri::async_runtime::spawn(SubscriptionWorker {
        connection,
        authority,
        reconnect_on_start,
        root: root.to_path_buf(),
        route: route.clone(),
        body,
        config: state.config.clone(),
        request_id,
        subscription_id,
        interaction_session_id,
        channel,
        cancel,
        subscriptions,
        recovery: state.recovery.clone(),
    }
    .run());
    Ok(initial)
}

#[tauri::command]
pub(crate) async fn dure_backend_subscribe(
    window: WebviewWindow,
    state: State<'_, DureBackendTransportState>,
    route: DureBackendRouteV1,
    subscription_id: String,
    body: Value,
    channel: Channel<Value>,
) -> Result<DureBackendTransportResult, DureBackendTransportError> {
    let (root, _) = crate::app_home::app_root_resolution().map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_profile_unavailable",
            "the Dure application root is unavailable",
        )
    })?;
    open_subscription(
        &root,
        &state,
        &route,
        &subscription_id,
        window.label(),
        body,
        channel,
    )
    .await
}

#[tauri::command]
pub(crate) fn dure_backend_unsubscribe(
    window: WebviewWindow,
    state: State<'_, DureBackendTransportState>,
    subscription_id: String,
) -> Result<bool, DureBackendTransportError> {
    if !super::valid_token(&subscription_id, 160) {
        return Err(DureBackendTransportError::new(
            "backend_subscription_invalid_request",
            "the backend subscription request is invalid",
        ));
    }
    let active = {
        let mut subscriptions = state.subscriptions.entries.lock().map_err(|_| {
            DureBackendTransportError::new(
                "backend_subscription_state_unavailable",
                "the backend subscription state is unavailable",
            )
        })?;
        if subscriptions
            .get(&subscription_id)
            .is_some_and(|active| active.owner_window != window.label())
        {
            return Err(DureBackendTransportError::new(
                "backend_subscription_owner_mismatch",
                "the backend subscription belongs to another window",
            ));
        }
        subscriptions.remove(&subscription_id)
    };
    if let Some(active) = active {
        let _ = active.cancel.send(());
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dure_backend_transport::{
        BackendProfile, ExpectedBackend, ProfileAuth, ProfileEndpoint, ProfileTransport,
        ProfileTrust, ProtocolRange, ProtocolVersion, RuntimeConfig,
    };
    use std::fs::OpenOptions;
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    use tauri::ipc::InvokeResponseBody;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::time::Duration;

    fn write_owner_file(path: &Path, source: &[u8], executable: bool) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(if executable { 0o700 } else { 0o600 })
            .open(path)
            .unwrap();
        file.write_all(source).unwrap();
        file.sync_all().unwrap();
    }

    fn selected() -> SelectedProfile {
        SelectedProfile {
            profile: BackendProfile {
                id: "local".into(),
                default: true,
                transport: ProfileTransport::Local {
                    endpoint: ProfileEndpoint::UnixSocket {
                        path: "/tmp/backend.sock".into(),
                    },
                },
                auth: ProfileAuth::Peer,
                trust: ProfileTrust::LocalPeer,
                expected: ExpectedBackend {
                    backend_id: "backend-1".into(),
                    generation: "generation-1".into(),
                    protocol: ProtocolRange {
                        minimum: ProtocolVersion { major: 1, minor: 0 },
                        maximum: ProtocolVersion { major: 1, minor: 0 },
                    },
                    capabilities: vec![
                        "agent_conversation.subscribe.v6".into(),
                        "backend.connection.persistent".into(),
                    ],
                },
                deadline_ms: 10_000,
            },
            ssh_references: None,
            catalog_profile_ids: ["local".into()].into_iter().collect(),
        }
    }

    fn event(request_id: &str, generation: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "apiVersion": "dure.backend-transport/v1",
            "kind": "dure.backend.event",
            "backend": {
                "id": "backend-1",
                "generation": generation,
                "protocol": { "major": 1, "minor": 0 },
                "capabilities": [
                    "agent_conversation.subscribe.v6",
                    "backend.connection.persistent"
                ],
                "observedAtMs": super::super::now_ms().unwrap()
            },
            "event": {
                "schemaVersion": 1,
                "topic": "agent_conversation.changed",
                "subscriptionRequestId": request_id,
                "notification": {
                    "interactionSessionId": "interaction-1",
                    "timelineCursor": { "epoch": "timeline-1", "sequence": 2 },
                    "kinds": ["timeline"]
                }
            }
        }))
        .unwrap()
    }

    fn initial_response(request_id: &str, generation: &str) -> Vec<u8> {
        let mut source = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "apiVersion": "dure.backend-transport/v1",
            "kind": "dure.backend.response",
            "requestId": request_id,
            "backend": {
                "id": "backend-1",
                "generation": generation,
                "protocol": { "major": 1, "minor": 0 },
                "capabilities": [
                    "agent_conversation.subscribe.v6",
                    "backend.connection.persistent"
                ],
                "observedAtMs": super::super::now_ms().unwrap()
            },
            "result": { "schemaVersion": 1 }
        }))
        .unwrap();
        source.push(b'\n');
        source
    }

    fn local_catalog(socket_path: &Path, generation: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "kind": "dure.backend_profiles",
            "profiles": [{
                "id": "local",
                "default": true,
                "transport": {
                    "kind": "local",
                    "endpoint": {
                        "kind": "unix_socket",
                        "path": socket_path
                    }
                },
                "auth": { "kind": "peer" },
                "trust": { "kind": "local_peer" },
                "expected": {
                    "backendId": "backend-1",
                    "generation": generation,
                    "protocol": {
                        "minimum": { "major": 1, "minor": 0 },
                        "maximum": { "major": 1, "minor": 0 }
                    },
                    "capabilities": [
                        "agent_conversation.subscribe.v6",
                        "backend.connection.persistent"
                    ]
                },
                "deadlineMs": 10_000
            }]
        })
    }

    #[test]
    fn subscription_events_keep_the_exact_request_and_backend_generation_fence() {
        let selected = selected();
        let required = [SUBSCRIBE_CAPABILITY, super::super::PERSISTENT_CAPABILITY];
        let parsed = subscription_event(
            &event("request-1", "generation-1"),
            &selected,
            &required,
            "request-1",
            "subscription-1",
        )
        .unwrap();
        assert_eq!(parsed["kind"], "event");
        assert_eq!(parsed["subscriptionId"], "subscription-1");
        assert!(
            subscription_event(
                &event("request-stale", "generation-1"),
                &selected,
                &required,
                "request-1",
                "subscription-1",
            )
            .is_err()
        );
        assert!(
            subscription_event(
                &event("request-1", "generation-stale"),
                &selected,
                &required,
                "request-1",
                "subscription-1",
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn dropping_transport_state_cancels_quiet_subscriptions() {
        let state = DureBackendTransportState::default();
        let subscriptions = Arc::downgrade(&state.subscriptions);
        let canceled = reserve(
            &state.subscriptions,
            "subscription-quiet",
            "window-quiet",
            "generation-quiet",
        )
        .unwrap();

        drop(state);

        tokio::time::timeout(Duration::from_millis(100), canceled)
            .await
            .expect("state shutdown must cancel a quiet subscription")
            .expect_err("state shutdown must drop the cancellation sender");
        assert!(subscriptions.upgrade().is_none());
    }

    #[tokio::test]
    async fn canceling_a_window_releases_its_capacity_and_preserves_other_windows() {
        let state = DureBackendTransportState::default();
        let mut canceled = reserve(
            &state.subscriptions,
            "subscription-canceled",
            "window-canceled",
            "generation-canceled",
        )
        .unwrap();
        let mut retained = reserve(
            &state.subscriptions,
            "subscription-retained",
            "window-retained",
            "generation-retained",
        )
        .unwrap();

        assert_eq!(state.cancel_window_subscriptions("window-canceled"), 1);
        (&mut canceled)
            .await
            .expect("window retirement must signal its subscription worker");
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut retained)
                .await
                .is_err()
        );
        let replacement = reserve(
            &state.subscriptions,
            "subscription-replacement",
            "window-canceled",
            "generation-replacement",
        );
        assert!(replacement.is_ok());
        assert_eq!(state.cancel_window_subscriptions("window-canceled"), 1);
        assert_eq!(state.cancel_window_subscriptions("window-retained"), 1);
    }

    #[tokio::test]
    async fn canceling_a_window_releases_the_full_subscription_capacity() {
        let state = DureBackendTransportState::default();
        let mut cancellations = Vec::new();
        for index in 0..MAX_SUBSCRIPTIONS {
            cancellations.push(
                reserve(
                    &state.subscriptions,
                    &format!("subscription-{index}"),
                    "window-full",
                    &format!("generation-{index}"),
                )
                .unwrap(),
            );
        }
        assert!(
            reserve(
                &state.subscriptions,
                "subscription-over-capacity",
                "window-full",
                "generation-over-capacity",
            )
            .is_err()
        );

        assert_eq!(
            state.cancel_window_subscriptions("window-full"),
            MAX_SUBSCRIPTIONS
        );
        for cancellation in cancellations {
            cancellation
                .await
                .expect("window retirement must signal every subscription worker");
        }
        assert!(
            reserve(
                &state.subscriptions,
                "subscription-after-retirement",
                "window-next",
                "generation-next",
            )
            .is_ok()
        );
    }

    #[tokio::test]
    async fn canceling_a_quiet_local_subscription_closes_its_connection() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-subscription-window-retirement-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        let catalog = json!({
            "schemaVersion": 1,
            "kind": "dure.backend_profiles",
            "profiles": [{
                "id": "local",
                "default": true,
                "transport": {
                    "kind": "local",
                    "endpoint": { "kind": "unix_socket", "path": socket_path }
                },
                "auth": { "kind": "peer" },
                "trust": { "kind": "local_peer" },
                "expected": {
                    "backendId": "backend-1",
                    "generation": "generation-1",
                    "protocol": {
                        "minimum": { "major": 1, "minor": 0 },
                        "maximum": { "major": 1, "minor": 0 }
                    },
                    "capabilities": [
                        "agent_conversation.subscribe.v6",
                        "backend.connection.persistent"
                    ]
                },
                "deadlineMs": 10_000
            }]
        });
        write_owner_file(
            &root.join("backend-profiles.json"),
            format!("{catalog}\n").as_bytes(),
            false,
        );
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            stream.read_line(&mut request).await.unwrap();
            let request: Value = serde_json::from_str(&request).unwrap();
            let request_id = request["requestId"].as_str().unwrap();
            stream
                .get_mut()
                .write_all(&initial_response(request_id, "generation-1"))
                .await
                .unwrap();
            let mut trailing = String::new();
            stream.read_line(&mut trailing).await.unwrap()
        });
        let state = DureBackendTransportState::default();
        let route = DureBackendRouteV1::Selected {
            profile_id: Some("local".into()),
        };

        open_subscription(
            root,
            &state,
            &route,
            "subscription-quiet",
            "window-quiet",
            json!({
                "schemaVersion": 1,
                "interactionSessionId": "interaction-1"
            }),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();

        assert_eq!(state.cancel_window_subscriptions("window-quiet"), 1);
        assert!(state.subscriptions.entries.lock().unwrap().is_empty());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), server)
                .await
                .expect("window retirement must close the quiet local connection")
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn local_eof_keeps_the_channel_and_resumes_future_events_after_one_recovery() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-subscription-recovery-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        let catalog = local_catalog(&socket_path, "generation-1");
        write_owner_file(
            &root.join("backend-profiles.json"),
            format!("{catalog}\n").as_bytes(),
            false,
        );
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let mut request_ids = Vec::new();
            for attempt in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                let request_id = request["requestId"].as_str().unwrap().to_string();
                request_ids.push(request_id.clone());
                stream
                    .get_mut()
                    .write_all(&initial_response(&request_id, "generation-1"))
                    .await
                    .unwrap();
                if attempt == 1 {
                    let mut notification = event(&request_id, "generation-1");
                    notification.push(b'\n');
                    stream.get_mut().write_all(&notification).await.unwrap();
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
            request_ids
        });
        let route = DureBackendRouteV1::Selected {
            profile_id: Some("local".into()),
        };
        let selected = route_authority::select(root, &RuntimeConfig::default(), &route).unwrap();
        let (recovery, mut incidents) =
            crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle::ready_for_test(
                selected.profile.clone(),
            );
        let state = DureBackendTransportState {
            recovery: recovery.clone(),
            ..DureBackendTransportState::default()
        };
        let (event_sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        let initial = open_subscription(
            root,
            &state,
            &route,
            "subscription-1",
            "window-1",
            json!({
                "schemaVersion": 1,
                "interactionSessionId": "interaction-1"
            }),
            Channel::new(move |body| {
                if let InvokeResponseBody::Json(source) = body {
                    let _ = event_sender.send(serde_json::from_str::<Value>(&source)?);
                }
                Ok(())
            }),
        )
        .await
        .unwrap();
        assert_eq!(initial.backend_generation, "generation-1");
        let ticket = tokio::time::timeout(Duration::from_secs(1), incidents.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovery.begin_recovery(&selected.profile).unwrap(), ticket);
        recovery.complete_for_test(&ticket, selected.profile.clone());
        let reset = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reset["event"]["topic"],
            "agent_conversation.reset_required"
        );
        let resumed = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resumed["kind"], "event");
        assert_eq!(resumed["subscriptionId"], "subscription-1");
        assert_eq!(state.cancel_window_subscriptions("window-1"), 1);
        let request_ids = server.await.unwrap();
        assert_eq!(request_ids.len(), 2);
        assert_eq!(request_ids[0], request_ids[1]);
    }

    #[tokio::test]
    async fn selected_subscription_follows_a_new_generation_without_waiting_for_old_eof() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-subscription-selected-generation-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let first_socket = root.join("backend-1.sock");
        let second_socket = root.join("backend-2.sock");
        write_owner_file(
            &root.join("backend-profiles.json"),
            format!("{}\n", local_catalog(&first_socket, "generation-1")).as_bytes(),
            false,
        );
        let first_listener = tokio::net::UnixListener::bind(&first_socket).unwrap();
        let root_for_server = root.to_path_buf();
        let second_socket_for_catalog = second_socket.clone();
        let first_server = tokio::spawn(async move {
            let (stream, _) = first_listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let request_id = request["requestId"].as_str().unwrap().to_owned();
            let next_catalog = root_for_server.join("backend-profiles.next.json");
            write_owner_file(
                &next_catalog,
                format!(
                    "{}\n",
                    local_catalog(&second_socket_for_catalog, "generation-2")
                )
                .as_bytes(),
                false,
            );
            std::fs::rename(next_catalog, root_for_server.join("backend-profiles.json")).unwrap();
            stream
                .get_mut()
                .write_all(&initial_response(&request_id, "generation-1"))
                .await
                .unwrap();
            let mut trailing = String::new();
            stream.read_line(&mut trailing).await.unwrap();
            request_id
        });
        let route = DureBackendRouteV1::Selected {
            profile_id: Some("local".into()),
        };
        let selected = route_authority::select(root, &RuntimeConfig::default(), &route).unwrap();
        let (recovery, mut incidents) =
            crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle::ready_for_test(
                selected.profile.clone(),
            );
        let state = DureBackendTransportState {
            recovery: recovery.clone(),
            ..DureBackendTransportState::default()
        };
        let (event_sender, mut events) = tokio::sync::mpsc::unbounded_channel();

        let initial = open_subscription(
            root,
            &state,
            &route,
            "subscription-1",
            "window-1",
            json!({
                "schemaVersion": 1,
                "interactionSessionId": "interaction-1"
            }),
            Channel::new(move |body| {
                if let InvokeResponseBody::Json(source) = body {
                    let _ = event_sender.send(serde_json::from_str::<Value>(&source)?);
                }
                Ok(())
            }),
        )
        .await
        .unwrap();
        assert_eq!(initial.backend_generation, "generation-1");

        let ticket = tokio::time::timeout(Duration::from_secs(1), incidents.recv())
            .await
            .unwrap()
            .unwrap();
        let second_listener = tokio::net::UnixListener::bind(&second_socket).unwrap();
        let second_server = tokio::spawn(async move {
            let (stream, _) = second_listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let request_id = request["requestId"].as_str().unwrap().to_owned();
            stream
                .get_mut()
                .write_all(&initial_response(&request_id, "generation-2"))
                .await
                .unwrap();
            let mut trailing = String::new();
            stream.read_line(&mut trailing).await.unwrap();
            request_id
        });
        let next = route_authority::select(root, &RuntimeConfig::default(), &route).unwrap();
        recovery.complete_for_test(&ticket, next.profile);

        let reset = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reset["event"]["topic"], "agent_conversation.reset_required");
        assert_eq!(reset["backendGeneration"], "generation-2");

        assert_eq!(state.cancel_window_subscriptions("window-1"), 1);
        let first_request_id = tokio::time::timeout(Duration::from_secs(1), first_server)
            .await
            .unwrap()
            .unwrap();
        let second_request_id = tokio::time::timeout(Duration::from_secs(1), second_server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first_request_id, second_request_id);
    }

    #[tokio::test]
    async fn exact_local_generation_recovery_ends_the_stale_subscription() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-subscription-generation-recovery-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let first_socket = root.join("backend-1.sock");
        let second_socket = root.join("backend-2.sock");
        write_owner_file(
            &root.join("backend-profiles.json"),
            format!("{}\n", local_catalog(&first_socket, "generation-1")).as_bytes(),
            false,
        );
        let first_listener = tokio::net::UnixListener::bind(&first_socket).unwrap();
        let first_server = tokio::spawn(async move {
            let (stream, _) = first_listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let request_id = request["requestId"].as_str().unwrap();
            stream
                .get_mut()
                .write_all(&initial_response(request_id, "generation-1"))
                .await
                .unwrap();
        });
        let selected_route = DureBackendRouteV1::Selected {
            profile_id: Some("local".into()),
        };
        let selected =
            route_authority::select(root, &RuntimeConfig::default(), &selected_route).unwrap();
        let route = DureBackendRouteV1::Exact {
            authority: route_authority::authority_for(&selected),
        };
        let (recovery, mut incidents) =
            crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle::ready_for_test(
                selected.profile.clone(),
            );
        let state = DureBackendTransportState {
            recovery: recovery.clone(),
            ..DureBackendTransportState::default()
        };
        let (event_sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        let initial = open_subscription(
            root,
            &state,
            &route,
            "subscription-1",
            "window-1",
            json!({
                "schemaVersion": 1,
                "interactionSessionId": "interaction-1"
            }),
            Channel::new(move |body| {
                if let InvokeResponseBody::Json(source) = body {
                    let _ = event_sender.send(serde_json::from_str::<Value>(&source)?);
                }
                Ok(())
            }),
        )
        .await
        .unwrap();
        assert_eq!(initial.backend_generation, "generation-1");
        first_server.await.unwrap();
        let ticket = tokio::time::timeout(Duration::from_secs(1), incidents.recv())
            .await
            .unwrap()
            .unwrap();
        let next_catalog = root.join("backend-profiles.next.json");
        write_owner_file(
            &next_catalog,
            format!("{}\n", local_catalog(&second_socket, "generation-2")).as_bytes(),
            false,
        );
        std::fs::rename(next_catalog, root.join("backend-profiles.json")).unwrap();
        let next =
            route_authority::select(root, &RuntimeConfig::default(), &selected_route).unwrap();
        recovery.complete_for_test(&ticket, next.profile);

        let error = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(error["kind"], "error");
        assert_eq!(error["error"]["code"], "backend_transport_authority_changed");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), incidents.recv())
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while !state.subscriptions.entries.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn ssh_subscription_releases_material_and_reaps_child_when_its_window_closes() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-subscription-ssh-material-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let known_hosts = root.join("known-hosts");
        write_owner_file(&known_hosts, b"fixture-host key\n", false);
        let material_log = root.join("material.log");
        let pid_log = root.join("pid.log");
        let fake_ssh = root.join("ssh-fixture");
        write_owner_file(
            &fake_ssh,
            format!(
                r#"#!/bin/sh
known_hosts_file=''
for argument in "$@"; do
  case "$argument" in
    UserKnownHostsFile=*) known_hosts_file=${{argument#UserKnownHostsFile=}} ;;
  esac
done
printf '%s\n' "$known_hosts_file" > '{}'
printf '%s\n' "$$" > '{}'
while IFS= read -r line; do
  request_id=$(printf '%s\n' "$line" | sed -E 's/.*"requestId":"([^"]+)".*/\1/')
  observed_at_ms=$(($(date +%s) * 1000))
  printf '{{"schemaVersion":1,"apiVersion":"dure.backend-transport/v1","kind":"dure.backend.response","requestId":"%s","backend":{{"id":"remote-backend","generation":"remote-v1","protocol":{{"major":1,"minor":0}},"capabilities":["agent_conversation.subscribe.v6","backend.connection.persistent"],"observedAtMs":%s}},"result":{{"schemaVersion":1}}}}\n' "$request_id" "$observed_at_ms"
done
"#,
                material_log.display(),
                pid_log.display(),
            )
            .as_bytes(),
            true,
        );
        write_owner_file(
            &root.join("backend-profiles.json"),
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "kind": "dure.backend_profiles",
                    "profiles": [{
                        "id": "remote",
                        "default": true,
                        "transport": {
                            "kind": "ssh",
                            "host": "build.example.test",
                            "port": 22,
                            "user": "dure_runner",
                            "endpoint": { "kind": "tcp", "host": "127.0.0.1", "port": 4681 }
                        },
                        "auth": { "kind": "ssh_agent" },
                        "trust": {
                            "kind": "known_hosts",
                            "reference": "known-hosts-profile:remote"
                        },
                        "expected": {
                            "backendId": "remote-backend",
                            "generation": "remote-v1",
                            "protocol": {
                                "minimum": { "major": 1, "minor": 0 },
                                "maximum": { "major": 1, "minor": 0 }
                            },
                            "capabilities": [
                                "agent_conversation.subscribe.v6",
                                "backend.connection.persistent"
                            ]
                        }
                    }]
                })
            )
            .as_bytes(),
            false,
        );
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                ssh_command: fake_ssh,
                profile_selector_override: Some("remote".into()),
                ssh_reference_profile_override: Some("remote".into()),
                known_hosts_override: Some(known_hosts),
                identity_override: None,
            },
            ..DureBackendTransportState::default()
        };
        let route = DureBackendRouteV1::Selected {
            profile_id: Some("remote".into()),
        };
        let initial = open_subscription(
            root,
            &state,
            &route,
            "subscription-1",
            "window-1",
            json!({
                "schemaVersion": 1,
                "interactionSessionId": "interaction-1"
            }),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        assert_eq!(initial.backend_id, "remote-backend");
        let pinned_known_hosts = std::path::PathBuf::from(
            std::fs::read_to_string(&material_log).unwrap().trim(),
        );
        let material_owner = pinned_known_hosts.parent().unwrap();
        let pid = std::fs::read_to_string(&pid_log)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let material_was_released = !material_owner.exists();
        let child_was_alive = unsafe { libc::kill(pid, 0) } == 0;

        assert_eq!(state.cancel_window_subscriptions("window-1"), 1);
        let deadline = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(material_was_released);
        assert!(child_was_alive);
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "window retirement must reap the exact SSH subscription child"
        );
    }
}
