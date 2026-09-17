use super::*;
use hmux_host::local_discovery::{
    ClaimLinkage, HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind, ManifestCommon,
    SessionClass, StartingManifest,
};
use hmux_host::local_protocol::{ProtocolVersion, RuntimeContext, VersionRange};
use hmux_runtime_contract::{ManagedCreateGenerationFence, ManagedCreateReceipt};

/// Reproduce a pre-checkpoint Host: its exact Exited tombstone was archived,
/// but the create ledger still owns the conversation. No fixture PID is live.
fn archived_writer(root: &std::path::Path, terminal_epoch: &str) -> ManagedCreateRequest {
    let request = ManagedCreateRequest::new(
        "archived-writer-create",
        "archived-writer-session",
        "archived-writer-workspace",
        "fixture",
        PermissionMode::Default,
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "archived-conversation").unwrap(),
    )
    .unwrap();
    let ManagedCreateLedgerState::Prepared(mut reservation) =
        reserve_with_rehost_recipe_and_conversation(
            root,
            request.workspace_id(),
            request.session_id(),
            request.idempotency_key(),
            &"ab".repeat(32),
            None,
            request.conversation_identity(),
        )
        .unwrap()
    else {
        panic!("the legacy writer must be reserved")
    };
    reservation.checkpoint_pre_spawn_absence().unwrap();
    reservation
        .mark_spawn_reserved(ProcessDescriptor {
            process_id: 100,
            start_marker: "fixture-not-a-live-process".into(),
        })
        .unwrap();
    reservation.release_with_barrier_proof().unwrap();
    let receipt = ManagedCreateReceipt::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
        request.provider_id(),
        PermissionMode::Default,
        root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new("principal", "runner", 1, "host", "terminal").unwrap(),
    )
    .unwrap();
    reservation
        .complete(serde_json::to_string(&receipt).unwrap())
        .unwrap();
    drop(reservation);

    let discovery = DiscoveryRoot::open(root).unwrap();
    let session = discovery
        .session(
            DiscoveryKey::new(request.workspace_id(), request.session_id(), "runner", 1).unwrap(),
        )
        .unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    let common = ManifestCommon {
        schema_version: 1,
        host_build_version: "fixture-legacy".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: vec!["screen_snapshot".into()],
        lifetime: HostLifetimeIdentity {
            workspace_id: request.workspace_id().into(),
            session_id: request.session_id().into(),
            runner_principal: "principal".into(),
            runner_instance: "runner".into(),
            channel_epoch: 1,
        },
        host_instance_id: "host".into(),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: Some(request.idempotency_key().into()),
        },
        host_process: ProcessProof {
            process_id: 100,
            start_marker: "fixture-not-a-live-process".into(),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Managed,
        session_name: None,
        retirement_policy: None,
        launch_program: None,
    };
    session
        .publish_starting(
            &lock,
            StartingManifest {
                common: common.clone(),
                starting_unix_ms: 2,
            },
        )
        .unwrap();
    let exited = ExitedManifest {
        common,
        tombstone: Box::new(ExitTombstone {
            fence: SessionFence {
                workspace_id: request.workspace_id().into(),
                session_id: request.session_id().into(),
                runner_principal: "principal".into(),
                runner_instance: "runner".into(),
                channel_epoch: 1,
                host_instance_id: "host".into(),
                terminal_epoch: terminal_epoch.into(),
            },
            provider_process: ProcessProof {
                process_id: 101,
                start_marker: "fixture-provider".into(),
            },
            exit: Exit {
                final_output_seq: 1,
                exit_code: Some(0),
                platform_status: None,
                reason: "provider exited normally".into(),
            },
            exit_kind: ProviderExitKind::Normal,
            created_unix_ms: 3,
            failure: None,
        }),
        endpoint: LocalEndpoint {
            kind: LocalEndpointKind::UnixSocket,
            address: "fixture.sock".into(),
        },
        capability_token: "fixture-capability".into(),
        exited_unix_ms: 3,
    };
    session.publish_exited(&lock, exited.clone()).unwrap();
    session
        .retire_exited_current(&lock, &DiscoveryManifest::Exited(exited).generation())
        .unwrap();
    assert!(!session.manifest_path().exists());
    request
}

#[test]
fn exact_resume_releases_an_archived_legacy_conversation_writer() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("discovery");
    DiscoveryRoot::create(&root).unwrap();
    let request = archived_writer(&root, "terminal");
    let creator =
        ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime")).with_discovery_root(&root);
    let resolution = creator
        .replace_current_and_advance(request.clone())
        .unwrap();
    let ManagedCreateAdvanceResolution::Advanced(target) = resolution else {
        panic!("an exact archived exit must allow Resume to launch: {resolution:?}")
    };
    assert_ne!(target.receipt().session_id(), request.session_id());
    assert_eq!(
        target.session().descriptor().lifecycle,
        SessionLifecycle::Ready
    );
    assert!(
        managed_create_ledger::release_exited_conversation_writer(
            &root,
            request.workspace_id(),
            request.session_id()
        )
        .is_ok_and(|changed| !changed),
        "admission must checkpoint release once"
    );
}

#[test]
fn archived_writer_release_is_checkpointed_and_idempotent() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("discovery");
    DiscoveryRoot::create(&root).unwrap();
    let request = archived_writer(&root, "terminal");
    for changed in [true, false] {
        assert_eq!(
            managed_create_ledger::release_exited_conversation_writer(
                &root,
                request.workspace_id(),
                request.session_id()
            )
            .unwrap(),
            changed
        );
    }
}

#[test]
fn another_archived_epoch_cannot_release_the_conversation_writer() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("discovery");
    DiscoveryRoot::create(&root).unwrap();
    let request = archived_writer(&root, "another-terminal");
    assert!(
        !managed_create_ledger::release_exited_conversation_writer(
            &root,
            request.workspace_id(),
            request.session_id()
        )
        .unwrap()
    );
    assert!(matches!(
        reserve_with_rehost_recipe_and_conversation(
            &root,
            "other-workspace",
            "other-session",
            "other-create",
            &"cd".repeat(32),
            None,
            request.conversation_identity(),
        ),
        Err(ManagedCreateAdmissionError::ConversationWriterConflict { .. })
    ));
}

#[test]
fn an_archived_writer_without_terminal_evidence_stays_reserved() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("discovery");
    DiscoveryRoot::create(&root).unwrap();
    let request = archived_writer(&root, "terminal");
    let archive = root
        .join(
            SessionLookupKey::new(request.workspace_id(), request.session_id())
                .unwrap()
                .relative_path(),
        )
        .join("retired");
    for entry in fs::read_dir(archive).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    assert!(
        !managed_create_ledger::release_exited_conversation_writer(
            &root,
            request.workspace_id(),
            request.session_id()
        )
        .unwrap()
    );
}

#[test]
fn archived_writer_release_rejects_changed_provider_or_create_linkage() {
    for field in ["provider_id", "kickoff_action_id"] {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().join("discovery");
        DiscoveryRoot::create(&root).unwrap();
        let request = archived_writer(&root, "terminal");
        let archive = root
            .join(
                SessionLookupKey::new(request.workspace_id(), request.session_id())
                    .unwrap()
                    .relative_path(),
            )
            .join("retired");
        let path = fs::read_dir(archive)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let common = &mut manifest["manifest"]["common"];
        if field == "provider_id" {
            common[field] = "another-provider".into();
        } else {
            common["claim_linkage"][field] = "another-create".into();
        }
        fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let error = managed_create_ledger::release_exited_conversation_writer(
            &root,
            request.workspace_id(),
            request.session_id(),
        )
        .unwrap_err();
        assert!(
            error.contains("exited conversation writer generation changed"),
            "{error}"
        );
    }
}
