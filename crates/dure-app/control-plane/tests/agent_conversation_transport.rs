#![cfg(unix)]

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionRequestIdV1, AgentInteractionSessionIdV1,
    AgentInterruptTurnRequestV1, AgentPendingAnswerIntentV1, AgentPendingRequestDraftV1,
    AgentPendingRequestKindV1, AgentPendingSnapshotV1, AgentProviderRuntimeFenceV1, AgentRecordV1,
    AgentStartTurnIntentV1, AgentTimelineEpochV1, AgentTimelineStore, AgentTurnIdV1, DomainStore,
    ProjectIdV1, ProjectRecordV1, ProviderIdV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_control_plane::agent_conversation::{AgentProviderCommandFuture, AgentProviderCommands};
use dure_control_plane::agent_conversation_api::AgentConversationRuntimeRegistry;
use dure_control_plane::{
    ControlPlaneEndpoint, ServeOptions, prepare_with_agent_conversation_runtimes,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;

const FORMER_DESCRIPTOR_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Default)]
struct FakeProviderCommands {
    answers: AtomicUsize,
    interrupts: AtomicUsize,
    starts: AtomicUsize,
}

impl AgentProviderCommands for FakeProviderCommands {
    fn start_turn<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.starts.fetch_add(1, Ordering::SeqCst);
            Ok(json!({ "clientMessageId": intent.client_message_id }))
        })
    }

    fn answer_pending<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentPendingAnswerIntentV1,
        _request: &'a dure_app::AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.answers.fetch_add(1, Ordering::SeqCst);
            Ok(json!({ "idempotencyKey": intent.idempotency_key }))
        })
    }

    fn interrupt_turn<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
        request: &'a AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.interrupts.fetch_add(1, Ordering::SeqCst);
            Ok(json!({ "interruptRequestId": request.interrupt_request_id }))
        })
    }
}

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

fn binding() -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-transport").unwrap(),
        agent_id: AgentIdV1::new("agent-transport").unwrap(),
        provider_id: ProviderIdV1::new("provider.fake").unwrap(),
        execution_profile: AgentExecutionProfileV1::CredentialReference {
            reference_id: "credential-fixture-a".into(),
            credential_generation: Some("credential-generation-1".into()),
        },
        provider_conversation_ref: Some("provider-conversation-1".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-transport-1".into(),
            provider_epoch: "provider-epoch-1".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-transport-1").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 4,
        updated_at_ms: 4,
    }
}

fn backend_request(
    descriptor: &ControlPlaneEndpoint,
    request_id: &str,
    operation: &str,
    body: Value,
) -> Value {
    let mut stream = UnixStream::connect(&descriptor.socket_path).unwrap();
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": "dure.backend-transport/v1",
        "kind": "dure.backend.request",
        "requestId": request_id,
        "operation": operation,
        "expected": {
            "backendId": descriptor.backend_id,
            "generation": descriptor.generation,
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "requiredCapabilities": []
        },
        "body": body
    });
    stream.write_all(format!("{request}\n").as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    serde_json::from_str(&response).unwrap()
}

fn backend_subscription(
    descriptor: &ControlPlaneEndpoint,
    request_id: &str,
    body: Value,
) -> (BufReader<UnixStream>, Value) {
    let mut connection = BufReader::new(UnixStream::connect(&descriptor.socket_path).unwrap());
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": "dure.backend-transport/v1",
        "kind": "dure.backend.request",
        "requestId": request_id,
        "operation": "agent_conversation.subscribe",
        "expected": {
            "backendId": descriptor.backend_id,
            "generation": descriptor.generation,
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "requiredCapabilities": ["backend.connection.persistent"]
        },
        "body": body,
        "connection": { "mode": "persistent_v1" }
    });
    connection
        .get_mut()
        .write_all(format!("{request}\n").as_bytes())
        .unwrap();
    let mut response = String::new();
    connection.read_line(&mut response).unwrap();
    (connection, serde_json::from_str(&response).unwrap())
}

#[test]
fn persistent_transport_fences_actions_and_streams_durable_invalidations() {
    let temporary = tempfile::Builder::new()
        .prefix("dure-agent-conversation-actions-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path().to_path_buf();
    let backend_root = root.join("backend");
    let discovery_root = root.join("hmux-discovery");
    let accounts_root = root.join("accounts");
    let claude_profile = accounts_root.join("claude-work");
    fs::create_dir(&backend_root).unwrap();
    fs::create_dir(&discovery_root).unwrap();
    fs::create_dir(&accounts_root).unwrap();
    fs::create_dir(&claude_profile).unwrap();
    fs::set_permissions(&backend_root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&discovery_root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&accounts_root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&claude_profile, fs::Permissions::from_mode(0o700)).unwrap();
    let hmux = root.join("unused-hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    let database = backend_root.join("application-state.sqlite3");

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let store = SqliteDomainStore::open(&database).await.unwrap();
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: ProjectIdV1::new("project-transport").unwrap(),
                root_path: root.to_string_lossy().into_owned(),
                display_name: "Transport fixture".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: WorkspaceIdV1::new("workspace-transport").unwrap(),
                project_id: ProjectIdV1::new("project-transport").unwrap(),
                root_path: root.to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 2,
                updated_at_ms: 2,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: AgentIdV1::new("agent-transport").unwrap(),
                workspace_id: WorkspaceIdV1::new("workspace-transport").unwrap(),
                provider_id: ProviderIdV1::new("provider.fake").unwrap(),
                display_name: "Transport agent".into(),
                created_at_ms: 3,
                updated_at_ms: 3,
            })
            .await
            .unwrap();
        store.close().await;
    });
    fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();

    let commands = Arc::new(FakeProviderCommands::default());
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let provider_commands: Arc<dyn AgentProviderCommands> = commands.clone();
    registry.register(binding(), provider_commands).unwrap();
    let serve_root = root.clone();
    let serve_hmux = hmux.clone();
    let serve_discovery = discovery_root.clone();
    let (ready_tx, ready_rx) = oneshot::channel();
    let (prepared_tx, prepared_rx) = mpsc::sync_channel(1);
    let (preparation_release_tx, preparation_release_rx) = mpsc::sync_channel(0);
    let (server_error_tx, server_error_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let prepared = match runtime.block_on(prepare_with_agent_conversation_runtimes(
            ServeOptions {
                home: serve_root,
                hmux_bin: serve_hmux.clone(),
                hmux_runtime_bin: serve_hmux,
                hmux_discovery_root: serve_discovery,
                claude_structured_runtime: None,
                launch_executable: None,
                expected_generation: None,
                activation_source_generation: None,
                staged: false,
            },
            registry,
        )) {
            Ok(prepared) => prepared,
            Err(error) => {
                let detail = error.to_string();
                prepared_tx.send(Err(detail.clone())).unwrap();
                let _ = server_error_tx.send(detail);
                return Err(error);
            }
        };
        prepared_tx.send(Ok(())).unwrap();
        preparation_release_rx
            .recv()
            .expect("fixture preparation release was dropped");
        let result = runtime.block_on(prepared.serve_with_publication(ready_tx));
        if let Err(error) = &result {
            eprintln!("agent conversation fixture server failed: {error}");
            let _ = server_error_tx.send(error.to_string());
        }
        result
    });
    prepared_rx
        .recv()
        .expect("control-plane preparation exited without a lifecycle result")
        .expect("control-plane preparation failed");
    assert!(
        !root.join("backend/control-plane.json").exists(),
        "control-plane descriptor was published before runtime preparation completed"
    );
    thread::sleep(FORMER_DESCRIPTOR_DEADLINE + Duration::from_millis(100));
    assert!(
        !root.join("backend/control-plane.json").exists(),
        "prepared control plane published itself behind the former readiness deadline"
    );
    preparation_release_tx.send(()).unwrap();
    let descriptor = match ready_rx.blocking_recv() {
        Ok(descriptor) => descriptor,
        Err(_) => panic!(
            "control-plane preparation failed: {}",
            server_error_rx
                .recv()
                .unwrap_or_else(|_| "server exited without an error".into())
        ),
    };
    assert!(root.join("backend/control-plane.json").is_file());

    let credential_profile = backend_request(
        &descriptor,
        "credential-profile-register-1",
        "provider_credential_profile.register",
        json!({
            "schemaVersion": 1,
            "providerId": "claude",
            "referenceId": "acc-profile-a",
            "profileDirectoryName": "claude-work"
        }),
    );
    assert_eq!(credential_profile["kind"], "dure.backend.response");
    assert_eq!(
        credential_profile["result"]["profile"]["referenceId"],
        "acc-profile-a"
    );
    assert_eq!(
        credential_profile["result"]["profile"]["providerId"],
        "claude"
    );
    assert!(
        credential_profile["result"]["profile"]["credentialGeneration"]
            .as_str()
            .is_some_and(|generation| generation.starts_with("credential-v2-"))
    );
    assert!(!credential_profile.to_string().contains("claude-work"));

    let unavailable_claude_runtime = backend_request(
        &descriptor,
        "claude-conversation-launch-unavailable",
        "claude_conversation.launch",
        json!({ "schemaVersion": 1 }),
    );
    assert_eq!(unavailable_claude_runtime["kind"], "dure.backend.error");
    assert_eq!(
        unavailable_claude_runtime["error"]["code"],
        "claude_conversation_runtime_unavailable"
    );

    let unavailable_claude_open = backend_request(
        &descriptor,
        "claude-conversation-open-unavailable",
        "claude_conversation.open",
        json!({
            "schemaVersion": 1,
            "agentId": "agent-transport",
            "executionProfile": { "kind": "provider_default" },
            "providerConversationRef": null
        }),
    );
    assert_eq!(unavailable_claude_open["kind"], "dure.backend.error");
    assert_eq!(
        unavailable_claude_open["error"]["code"],
        "claude_conversation_runtime_unavailable"
    );

    let mut changed_credential = binding();
    changed_credential.execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: "credential-fixture-a".into(),
        credential_generation: Some("credential-generation-2".into()),
    };
    let rejected_credential = backend_request(
        &descriptor,
        "conversation-create-stale-credential",
        "agent_conversation.create",
        json!({ "schemaVersion": 1, "binding": changed_credential }),
    );
    assert_eq!(rejected_credential["kind"], "dure.backend.error");
    assert_eq!(
        rejected_credential["error"]["code"],
        "agent_conversation_conflict"
    );
    assert_eq!(commands.starts.load(Ordering::SeqCst), 0);

    let created = backend_request(
        &descriptor,
        "conversation-create-1",
        "agent_conversation.create",
        json!({ "schemaVersion": 1, "binding": binding() }),
    );
    assert_eq!(created["kind"], "dure.backend.response");

    let inspected = backend_request(
        &descriptor,
        "conversation-inspect-1",
        "agent_conversation.inspect",
        json!({ "schemaVersion": 1, "agentId": "agent-transport" }),
    );
    assert_eq!(inspected["kind"], "dure.backend.response");
    assert_eq!(
        inspected["result"]["binding"]["interactionSessionId"],
        "interaction-transport"
    );

    let read_body = json!({
        "schemaVersion": 1,
        "interactionSessionId": "interaction-transport",
        "direction": "tail",
        "cursor": null,
        "limit": 32
    });
    let (mut subscription, initial) =
        backend_subscription(&descriptor, "conversation-subscribe-1", read_body.clone());
    assert_eq!(initial["kind"], "dure.backend.response");

    let turn = AgentStartTurnIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-transport").unwrap(),
        runtime: binding().runtime,
        turn_id: AgentTurnIdV1::new("turn-transport-1").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("message-transport-1").unwrap(),
        input: "Persist before effect".into(),
        requested_at_ms: 10,
    };
    let observed = backend_request(
        &descriptor,
        "continuation-observe",
        "agent_conversation.read",
        read_body.clone(),
    );
    let continuation = json!({
        "intent": turn,
        "expectedCursor": observed["result"]["read"]["page"]["finalCursor"],
    });
    let mut stale_continuation = continuation.clone();
    stale_continuation["expectedCursor"]["epoch"] = json!("prior-epoch");
    let not_started = backend_request(
        &descriptor,
        "continuation-obsolete",
        "agent_conversation.continue_turn",
        stale_continuation,
    );
    assert_eq!(not_started["kind"], "dure.backend.response");
    assert!(not_started["result"]["receipt"].is_null());
    assert_eq!(commands.starts.load(Ordering::SeqCst), 0);

    let started = backend_request(
        &descriptor,
        "conversation-start-1",
        "agent_conversation.continue_turn",
        continuation.clone(),
    );
    assert_eq!(started["kind"], "dure.backend.response");
    assert_eq!(commands.starts.load(Ordering::SeqCst), 1);

    let mut changed = String::new();
    subscription.read_line(&mut changed).unwrap();
    let changed: Value = serde_json::from_str(&changed).unwrap();
    assert_eq!(changed["kind"], "dure.backend.event");
    assert_eq!(changed["event"]["topic"], "agent_conversation.changed");
    assert_eq!(
        changed["event"]["notification"]["interactionSessionId"],
        "interaction-transport"
    );
    drop(subscription);

    let continued_replay = backend_request(
        &descriptor,
        "continuation-replay",
        "agent_conversation.continue_turn",
        continuation,
    );
    assert_eq!(continued_replay["kind"], "dure.backend.response");
    assert_eq!(continued_replay["result"]["receipt"]["state"], "accepted");
    assert_eq!(
        continued_replay["result"]["receipt"]["newlyPrepared"],
        false
    );
    assert_eq!(commands.starts.load(Ordering::SeqCst), 1);

    let replayed = backend_request(
        &descriptor,
        "conversation-start-retry",
        "agent_conversation.start_turn",
        serde_json::to_value(&turn).unwrap(),
    );
    assert_eq!(replayed["kind"], "dure.backend.response");
    assert_eq!(replayed["result"]["receipt"]["newlyPrepared"], false);
    assert_eq!(commands.starts.load(Ordering::SeqCst), 1);

    let mut stale_turn = turn.clone();
    stale_turn.runtime.runtime_generation = "runtime-transport-stale".into();
    stale_turn.turn_id = AgentTurnIdV1::new("turn-transport-stale").unwrap();
    stale_turn.client_message_id = AgentClientMessageIdV1::new("message-transport-stale").unwrap();
    let stale = backend_request(
        &descriptor,
        "conversation-start-stale",
        "agent_conversation.start_turn",
        serde_json::to_value(stale_turn).unwrap(),
    );
    assert_eq!(stale["kind"], "dure.backend.error");
    assert_eq!(stale["error"]["code"], "agent_conversation_conflict");
    assert_eq!(commands.starts.load(Ordering::SeqCst), 1);

    runtime.block_on(async {
        let store = SqliteDomainStore::open(&database).await.unwrap();
        store
            .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: AgentInteractionSessionIdV1::new("interaction-transport")
                    .unwrap(),
                runtime: binding().runtime,
                observed_through_sequence: 0,
                requests: vec![AgentPendingRequestDraftV1 {
                    request_id: AgentInteractionRequestIdV1::new("request-transport-1").unwrap(),
                    kind: AgentPendingRequestKindV1::Question,
                    turn_id: Some(AgentTurnIdV1::new("turn-transport-1").unwrap()),
                    client_message_id: AgentClientMessageIdV1::new("message-transport-1").unwrap(),
                    payload: json!({ "question": "Continue?" }),
                    created_at_ms: 11,
                }],
                observed_at_ms: 12,
            })
            .await
            .unwrap();
        store.close().await;
    });
    let answer = AgentPendingAnswerIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-transport").unwrap(),
        runtime: binding().runtime,
        request_id: AgentInteractionRequestIdV1::new("request-transport-1").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("message-transport-1").unwrap(),
        idempotency_key: "answer-transport-1".into(),
        answer: json!({ "answers": { "Continue?": "Yes" } }),
        requested_at_ms: 13,
    };
    let answered = backend_request(
        &descriptor,
        "conversation-answer-1",
        "agent_conversation.answer_pending",
        serde_json::to_value(answer).unwrap(),
    );
    assert_eq!(answered["kind"], "dure.backend.response");
    assert_eq!(commands.answers.load(Ordering::SeqCst), 1);

    let interrupted = backend_request(
        &descriptor,
        "conversation-interrupt-1",
        "agent_conversation.interrupt_turn",
        serde_json::to_value(AgentInterruptTurnRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-transport")
                .unwrap(),
            runtime: binding().runtime,
            turn_id: AgentTurnIdV1::new("turn-transport-1").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("message-transport-1").unwrap(),
            interrupt_request_id: "interrupt-transport-1".into(),
            requested_at_ms: 14,
        })
        .unwrap(),
    );
    assert_eq!(interrupted["kind"], "dure.backend.response");
    assert_eq!(commands.interrupts.load(Ordering::SeqCst), 1);

    let reopened = backend_request(
        &descriptor,
        "conversation-read-reopened",
        "agent_conversation.read",
        json!({
            "schemaVersion": 1,
            "interactionSessionId": "interaction-transport",
            "direction": "tail",
            "cursor": null,
            "limit": 32
        }),
    );
    assert_eq!(reopened["kind"], "dure.backend.response");
    assert_eq!(
        reopened["result"]["read"]["page"]["binding"]["executionProfile"],
        serde_json::to_value(binding().execution_profile).unwrap()
    );

    let saturated_subscriptions = (0..64)
        .map(|index| {
            let (connection, initial) = backend_subscription(
                &descriptor,
                &format!("conversation-capacity-{index}"),
                read_body.clone(),
            );
            assert_eq!(initial["kind"], "dure.backend.response");
            connection
        })
        .collect::<Vec<_>>();
    let (_rejected_connection, rejected) =
        backend_subscription(&descriptor, "conversation-capacity-rejected", read_body);
    assert_eq!(rejected["kind"], "dure.backend.error");
    assert_eq!(rejected["error"]["code"], "backend_subscription_capacity");

    let stopped = backend_request(
        &descriptor,
        "conversation-fixture-stop",
        "backend.shutdown",
        json!({ "schemaVersion": 2, "mode": "stop" }),
    );
    assert_eq!(stopped["kind"], "dure.backend.response");
    server.join().unwrap().unwrap();
    drop(saturated_subscriptions);
}
