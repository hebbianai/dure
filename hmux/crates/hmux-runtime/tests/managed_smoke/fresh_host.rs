//! Confirmed fresh replacement must not depend on the old Host's transport.
use super::*;
use hmux_client::local_host_socket_owner_absent;

#[test]
fn fresh_start_replaces_a_live_provider_after_listener_loss() {
    fresh_start_after_listener_loss(false, false);
}

#[test]
fn fresh_start_reconciles_a_pending_operation_after_listener_loss() {
    fresh_start_after_listener_loss(true, false);
}

#[test]
fn guarded_fresh_switch_preserves_the_source_after_listener_loss() {
    fresh_start_after_listener_loss(false, true);
}

#[test]
fn refused_fresh_switch_keeps_source_available_for_a_new_operation() {
    let root = tempfile::tempdir().unwrap().keep();
    let discovery = root.join("discovery");
    let marker = root.join("launches");
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let created = ManagedSessionCreator::new(runtime)
        .with_discovery_root(&discovery)
        .create(
            ManagedCreateRequest::new(
                "refused-fresh-create",
                "refused-fresh-source",
                "refused-fresh-workspace",
                "codex",
                PermissionMode::Default,
                &root,
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let source = created.session().descriptor().clone();
    ManagedAgentStateReporter::new(runtime, &root)
        .with_discovery_root(&discovery)
        .report_agent_state(
            ManagedAttachRequest::new(&source.session_id, &source.workspace_id).unwrap(),
            AgentStateReport {
                identity_only: false,
                activity: hmux_client::AgentRuntimeActivity::Waiting,
                attention: hmux_client::AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
        )
        .unwrap();
    let observer = LocalSessionObserver::connect(
        &LocalSessionCatalog::new(&discovery),
        &SessionSelector::new(&source.session_id, Some(source.workspace_id.clone())),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let snapshot = &observer.attachment().initial_snapshot;
    let revision = snapshot
        .agent_runtime_state
        .as_ref()
        .unwrap()
        .revision
        .parse()
        .unwrap();
    let output: u64 = snapshot.sequence_through.parse().unwrap();
    observer.detach().unwrap();
    let request = |operation, sequence| {
        fresh_managed_rehost_request_from_wire(
            operation,
            &source,
            &root,
            &marker,
            &root.join("unexpected-resume"),
        )
        .with_fresh_source_quiescence(
            ManagedStopQuiescenceFence::new(&source.terminal_epoch, revision, sequence).unwrap(),
        )
        .unwrap()
    };
    let rehoster = ManagedSessionRehoster::new(runtime, &root).with_discovery_root(&discovery);
    let rejected = request("refused-fresh-attempt", output + 1);
    assert!(rehoster.rehost(rejected.clone()).is_err());
    let reconcile = ManagedRehostReconcileRequest::by_operation_identity(
        rejected.operation_id(),
        &source.session_id,
        &source.workspace_id,
    )
    .unwrap();
    assert!(rehoster.reconcile(reconcile.clone()).is_err());
    for process in [&source.host_process, &source.provider_process] {
        assert_eq!(
            probe_local_process_generation(process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
    }
    assert!(!marker.exists());
    let accepted = request("refused-fresh-next-attempt", output);
    let receipt = rehoster.rehost(accepted.clone()).expect(
        "a definitively refused stop must release its source for the next explicit operation",
    );
    assert!(receipt.conversation_id().is_none());
    wait_for_file_content(&marker, b"fresh\n");
    assert!(
        rehoster.reconcile(reconcile).is_err(),
        "the rejected operation must stay rejected"
    );
    assert!(rehoster.rehost(accepted).unwrap().replayed());
    assert_eq!(fs::read(&marker).unwrap(), b"fresh\n");
    stop_ready_managed_test_sessions(&discovery, &root);
}

fn fresh_start_after_listener_loss(reconcile_pending: bool, guarded: bool) {
    // Preserve failed fixtures for the runner's exact-process guardian.
    let root = tempfile::tempdir().unwrap().keep();
    let discovery = root.join("discovery");
    let home = root.join("home");
    let sockets = root.join("s");
    let fault = root.join("exit-listener");
    let runtime = root.join("runtime");
    let fresh_marker = root.join("fresh-launches");
    let resume_marker = root.join("unexpected-resume");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&sockets).unwrap();
    let quote =
        |path: &std::path::Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
    fs::write(&runtime, format!(
        "#!/bin/sh\nexport HOME={home} DURE_HOME={home} ZDOTDIR={home}\nexport HMUX_RUNTIME_ROOT={sockets} HMUX_RUNTIME_TEST_LISTENER_EXIT={fault}\nexec {runtime} \"$@\"\n",
        home = quote(&home), sockets = quote(&sockets), fault = quote(&fault),
        runtime = quote(std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"))),
    )).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let source_request = ManagedCreateRequest::new(
        "fresh-unreachable-create",
        "fresh-unreachable-source",
        "fresh-unreachable-workspace",
        "codex",
        PermissionMode::BypassApprovals,
        &home,
        vec!["/bin/sleep".into(), "30".into()],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    assert!(source_request.conversation_identity().is_none());
    let created = ManagedSessionCreator::new(&runtime)
        .with_discovery_root(&discovery)
        .create(source_request)
        .unwrap();
    let source = created.session().descriptor().clone();
    eprintln!("fresh-host fixture root={root:?} source={source:?}");
    let rehoster = ManagedSessionRehoster::new(&runtime, &home).with_discovery_root(&discovery);

    fs::write(&fault, "exit only this fixture listener").unwrap();
    drop(std::os::unix::net::UnixStream::connect(&source.endpoint.address).unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !local_host_socket_owner_absent(&source) {
        assert!(Instant::now() < deadline, "fixture listener did not exit");
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        std::os::unix::net::UnixStream::connect(&source.endpoint.address)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::ConnectionRefused,
    );
    let request = fresh_managed_rehost_request_from_wire(
        "fresh-unreachable-operation",
        &source,
        &home,
        &fresh_marker,
        &resume_marker,
    );
    assert!(request.expected_conversation_id().is_none());
    assert!(request.is_fresh_replacement());

    let mut unconfirmed = serde_json::to_value(&request).unwrap();
    unconfirmed["confirmed"] = false.into();
    assert_eq!(
        rehoster
            .rehost(serde_json::from_value(unconfirmed).unwrap())
            .unwrap_err()
            .code(),
        "hmux_managed_rehost_confirmation_required",
    );
    for process in [&source.host_process, &source.provider_process] {
        assert_eq!(
            probe_local_process_generation(process).unwrap(),
            LocalProcessGenerationStatus::Live,
        );
    }
    assert!(!fresh_marker.exists());

    let reconcile = ManagedRehostReconcileRequest::by_operation_identity(
        request.operation_id(),
        &source.session_id,
        &source.workspace_id,
    )
    .unwrap();
    if guarded {
        let request = request
            .with_fresh_source_quiescence(
                hmux_client::ManagedStopQuiescenceFence::new(&source.terminal_epoch, 1, 0).unwrap(),
            )
            .unwrap();
        assert!(rehoster.rehost(request).is_err());
        assert!(rehoster.reconcile(reconcile).is_err());
        for process in [&source.host_process, &source.provider_process] {
            assert_eq!(
                probe_local_process_generation(process).unwrap(),
                LocalProcessGenerationStatus::Live
            );
        }
        assert!(!fresh_marker.exists());
        terminate_owned_test_process(&source.provider_process);
        terminate_owned_test_process_if_live(&source.host_process);
        return;
    }
    let receipt = if reconcile_pending {
        // Simulate loss of the caller after its complete fresh launch was
        // journaled. Reconciliation must need neither a conversation ID nor
        // new replacement hints from a reopened pane.
        run_crashing_managed_rehost(&discovery, &home, &request, "after_payload_journaled");
        rehoster.reconcile(reconcile.clone())
    } else {
        rehoster.rehost(request)
    }
    .expect("confirmed fresh start must not require an answer from the old Host");

    assert!(receipt.conversation_id().is_none());
    wait_for_process_absent(&source.host_process);
    wait_for_process_absent(&source.provider_process);
    wait_for_file_content(&fresh_marker, b"fresh\n");
    assert!(!resume_marker.exists());
    let replay = rehoster.reconcile(reconcile).unwrap();
    assert!(replay.replayed());
    assert_eq!(receipt.replacement_receipt(), replay.replacement_receipt());
    assert_eq!(fs::read(&fresh_marker).unwrap(), b"fresh\n");
    stop_ready_managed_test_sessions(&discovery, &home);
}
