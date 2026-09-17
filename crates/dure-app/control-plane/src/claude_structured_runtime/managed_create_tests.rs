use super::*;
use dure_app::AgentIdV1;
use hmux_client::{
    EndpointDescriptor, EndpointKind, MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest, ProcessDescriptor,
    ProtocolVersion, SessionClass, SessionLifecycle, VersionRange,
};
use serde::Serialize;

fn write_frame<T: Serialize>(path: &Path, response: &T) {
    let payload = serde_json::to_vec(response).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    fs::write(path, frame).unwrap();
}

fn decode_frames<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
    let bytes = fs::read(path).unwrap();
    let mut remaining = bytes.as_slice();
    let mut decoded = Vec::new();
    while !remaining.is_empty() {
        let length = u32::from_be_bytes(remaining[..4].try_into().unwrap()) as usize;
        decoded.push(serde_json::from_slice(&remaining[4..4 + length]).unwrap());
        remaining = &remaining[4 + length..];
    }
    decoded
}

fn managed_create_binding() -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-create-test")
            .unwrap(),
        agent_id: AgentIdV1::new("agent-create-test").unwrap(),
        provider_id: ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-create-test".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-create-test".into(),
            provider_epoch: "query-create-test".into(),
        },
        timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-create-test").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn managed_create_files(root: &Path) -> ClaudeRuntimeFiles {
    ClaudeRuntimeFiles {
        capability_file: root.join("relay-capability"),
        create_idempotency_key: "claude-chat-create-test".into(),
        endpoint: root.join("relay.sock"),
        relay_id: "relay-create-test".into(),
        relay_session_id: "claude-chat-create-test".into(),
        runtime_directory: root.to_path_buf(),
    }
}

fn managed_create_descriptor() -> SessionDescriptor {
    SessionDescriptor {
        schema_version: 1,
        session_id: "claude-chat-create-test".into(),
        session_name: None,
        workspace_id: "workspace-create-test".into(),
        session_class: SessionClass::Managed,
        lifecycle: SessionLifecycle::Ready,
        provider_id: CLAUDE_PROVIDER_ID.into(),
        runtime_host: None,
        worktree_alias: None,
        branch: None,
        launch_program: None,
        runner_principal: "principal-create-test".into(),
        runner_instance: "runner-create-test".into(),
        channel_epoch: "1".into(),
        host_instance_id: "host-create-test".into(),
        terminal_epoch: "terminal-create-test".into(),
        output_seq: "0".into(),
        host_build_version: "build-create-test".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: Vec::new(),
        retirement_policy: None,
        host_process: ProcessDescriptor {
            process_id: 1,
            start_marker: "host-process-create-test".into(),
        },
        provider_process: ProcessDescriptor {
            process_id: 2,
            start_marker: "provider-process-create-test".into(),
        },
        endpoint: EndpointDescriptor {
            kind: EndpointKind::UnixSocket,
            address: "unused.sock".into(),
        },
        created_unix_ms: "1".into(),
        lifecycle_changed_unix_ms: "1".into(),
        exit: None,
        failure: None,
    }
}

#[tokio::test]
async fn managed_create_pending_is_not_collapsed_into_a_terminal_rejection() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("fake-hmux-runtime");
    fs::write(
        &runtime,
        format!(
            "#!/bin/sh\ncat >> \"$0.requests\"\nprintf '%s\\n' \"$2\" >> \"$0.calls\"\ncase \"$2\" in\n  {MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}) exec cat \"$0.advance\" ;;\n  *) exit 64 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    write_frame(
        &runtime.with_extension("advance"),
        &ManagedCreateAdvanceBrokerResponse::Pending,
    );
    let configuration = ClaudeStructuredRuntimeConfiguration {
        backend_generation: "backend-create-test".into(),
        hmux_runtime: runtime.clone(),
        discovery_root: root.path().join("discovery"),
        relay_executable: runtime.clone(),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
        environment: BTreeMap::new(),
    };
    let files = managed_create_files(root.path());
    let journal = ClaudeRuntimeLaunchJournalV1::prepared(
        &managed_create_binding(),
        "workspace-create-test",
        root.path(),
        &files.relay_id,
        &files.relay_session_id,
        None,
    );

    let outcome = create_managed_relay(
        &configuration,
        &managed_create_binding(),
        "workspace-create-test",
        root.path(),
        &files,
        &journal,
    )
    .await
    .unwrap();

    assert!(matches!(
        outcome,
        ManagedRelayCreateOutcome::RecoveryPending
    ));

    let mut effective = journal.clone();
    let mut effective_descriptor = managed_create_descriptor();
    effective_descriptor.session_id = "claude-chat-successor".into();
    effective.relay_ready_with_managed_identity(
        effective_descriptor,
        ClaudeManagedCreateIdentityV1::new(
            &files.relay_session_id,
            &files.create_idempotency_key,
            "claude-chat-successor",
            "claude-create-successor",
        )
        .unwrap(),
    );
    assert!(matches!(
        create_managed_relay(
            &configuration,
            &managed_create_binding(),
            "workspace-create-test",
            root.path(),
            &files,
            &effective,
        )
        .await
        .unwrap(),
        ManagedRelayCreateOutcome::RecoveryPending,
    ));
    let requests: Vec<ManagedCreateAdvanceRequest> =
        decode_frames(&runtime.with_extension("requests"));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].request().session_id(), files.relay_session_id);
    assert_eq!(
        requests[0].request().idempotency_key(),
        files.create_idempotency_key
    );
    assert_eq!(requests[1].request().session_id(), "claude-chat-successor");
    assert_eq!(
        requests[1].request().idempotency_key(),
        "claude-create-successor"
    );
    assert_eq!(
        fs::read_to_string(runtime.with_extension("calls")).unwrap(),
        format!(
            "{MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}\n{MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}\n"
        )
    );
}

#[tokio::test]
async fn prepared_stop_lookup_never_invokes_the_runtime() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("fake-hmux-runtime");
    fs::write(
        &runtime,
        "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$2\" >> \"$0.calls\"\nexec cat \"$0.reconcile\"\n",
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let configuration = ClaudeStructuredRuntimeConfiguration {
        backend_generation: "backend-stop-test".into(),
        hmux_runtime: runtime.clone(),
        discovery_root: root.path().join("discovery"),
        relay_executable: runtime.clone(),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
        environment: BTreeMap::new(),
    };
    let files = managed_create_files(root.path());
    let journal = ClaudeRuntimeLaunchJournalV1::prepared(
        &managed_create_binding(),
        "workspace-create-test",
        root.path(),
        &files.relay_id,
        &files.relay_session_id,
        None,
    );

    assert!(matches!(
        resolve_managed_relay_for_stop(&configuration, "workspace-create-test", &files, &journal,)
            .await,
        ManagedRelayIdentityOutcome::NotFound
    ));
    assert!(
        !runtime.with_extension("calls").exists(),
        "read-only stop resolution must not spawn the Hmux runtime",
    );
}
