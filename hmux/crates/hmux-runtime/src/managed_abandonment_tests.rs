use super::*;

fn absent_current_process_generation() -> ProcessDescriptor {
    let current = hmux_client::exact_local_process_generation(std::process::id()).unwrap();
    let mut old_marker = current
        .start_marker
        .split(':')
        .map(str::to_string)
        .collect::<Vec<_>>();
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        old_marker[1] = old_marker[1]
            .parse::<u64>()
            .unwrap()
            .wrapping_add(1)
            .to_string();
    }
    #[cfg(target_os = "linux")]
    {
        old_marker[2] = old_marker[2]
            .parse::<u64>()
            .unwrap()
            .wrapping_add(1)
            .to_string();
    }
    ProcessDescriptor {
        process_id: current.process_id,
        start_marker: old_marker.join(":"),
    }
}

#[test]
fn pid_reuse_proves_only_the_recorded_generation_absent() {
    let current = hmux_client::exact_local_process_generation(std::process::id()).unwrap();
    let reused_pid = absent_current_process_generation();

    require_absent_process("Host", &reused_pid).unwrap();
    assert_eq!(
        probe_local_process_generation(&current).unwrap(),
        LocalProcessGenerationStatus::Live,
        "proving the old generation absent must not affect the current numeric PID owner"
    );
}

#[test]
fn forced_retirement_waits_for_exact_lifetime_handoff() {
    assert_forced_retirement(RetirementCut::None);
}

#[test]
fn maintenance_resumes_its_reserved_stop_after_exited_publication() {
    assert_forced_retirement(RetirementCut::ReservedStop);
}

#[test]
fn exit_racing_ready_observation_does_not_authorize_a_fresh_stop() {
    assert_forced_retirement(RetirementCut::UnreservedExit);
}

#[test]
fn another_stop_intent_does_not_authorize_automatic_retirement() {
    assert_forced_retirement(RetirementCut::OtherStop);
}

#[derive(Clone, Copy, PartialEq)]
enum RetirementCut {
    None,
    ReservedStop,
    UnreservedExit,
    OtherStop,
}

fn assert_forced_retirement(cut: RetirementCut) {
    for exact in [false, true] {
        assert_forced_retirement_via(cut, exact);
    }
}

fn assert_forced_retirement_via(cut: RetirementCut, exact: bool) {
    let temp = tempfile::tempdir().unwrap();
    let discovery_root = temp.path().join("hmux");
    let root = DiscoveryRoot::create(&discovery_root).unwrap();
    let maintain = || {
        if exact {
            let existing = root
                .find_manifest_by_session("workspace", "session")
                .unwrap();
            maintain_completed_create_lifecycle(root.path(), &existing.manifest);
        } else {
            maintain_completed_create_lifecycles(root.path()).unwrap();
        }
    };
    let discovery = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let absent = absent_current_process_generation();
    let common = ManifestCommon {
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        },
        capabilities: vec![],
        lifetime: HostLifetimeIdentity {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 4,
        },
        host_instance_id: "host-1".into(),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: Some("action-1".into()),
        },
        host_process: ProcessProof {
            process_id: absent.process_id,
            start_marker: absent.start_marker.clone(),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Managed,
        session_name: None,
        retirement_policy: None,
        launch_program: None,
    };
    let ready = ReadyManifest {
        common: common.clone(),
        provider_process: ProcessProof {
            process_id: absent.process_id,
            start_marker: absent.start_marker.clone(),
        },
        terminal_epoch: "terminal-1".into(),
        ready_output_seq: 0,
        endpoint: LocalEndpoint {
            kind: LocalEndpointKind::UnixSocket,
            address: "host.sock".into(),
        },
        capability_token: "token".into(),
        ready_unix_ms: 2,
    };
    let lifetime_lock = discovery.acquire_lifetime_lock().unwrap();
    discovery
        .publish_starting(
            &lifetime_lock,
            StartingManifest {
                common,
                starting_unix_ms: 1,
            },
        )
        .unwrap();
    discovery
        .publish_ready(&lifetime_lock, ready.clone())
        .unwrap();
    let request = ManagedStopRequest::new("stop-1", "session", "workspace")
        .and_then(|request| {
            request.with_expected_fence("runner", "runner-1", 4, "host-1", "terminal-1")
        })
        .unwrap();

    assert!(matches!(
        acquire(&discovery_root, &request, &ready).unwrap(),
        AbandonedReadyAcquisition::HostLifetimeOwned
    ));
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        drop(lifetime_lock);
    });
    let acquired = acquire_until(
        &discovery_root,
        &request,
        &ready,
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let AbandonedReadyAcquisition::Acquired(acquired) = acquired else {
        panic!("exact lifetime handoff did not converge to mutation authority");
    };
    drop(acquired);
    release.join().unwrap();

    let managed_create_ledger::ManagedCreateLedgerState::Prepared(mut reservation) =
        managed_create_ledger::reserve(
            root.path(),
            "workspace",
            "session",
            "action-1",
            &hmux_client::recovery_journal::request_fingerprint(&["action-1"]),
        )
        .unwrap()
    else {
        panic!("fixture create must be prepared");
    };
    reservation.checkpoint_pre_spawn_absence().unwrap();
    reservation
        .mark_spawn_reserved(ProcessDescriptor {
            process_id: absent.process_id,
            start_marker: absent.start_marker,
        })
        .unwrap();
    reservation.release_with_barrier_proof().unwrap();
    let receipt = ManagedCreateReceipt::new(
        "action-1",
        "session",
        "workspace",
        "fixture",
        hmux_runtime_contract::PermissionMode::Default,
        root.path(),
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new("runner", "runner-1", 4, "host-1", "terminal-1").unwrap(),
    )
    .unwrap();
    reservation
        .complete(serde_json::to_string(&receipt).unwrap())
        .unwrap();
    assert!(
        !managed_create_ledger::pending_session_paths(root.path())
            .unwrap()
            .is_empty()
    );

    let live_authority = discovery.acquire_lifetime_lock().unwrap();
    maintain();
    assert!(matches!(
        root.find_manifest_by_session("workspace", "session")
            .unwrap()
            .manifest,
        DiscoveryManifest::Ready(_)
    ));
    assert!(
        !managed_create_ledger::pending_session_paths(root.path())
            .unwrap()
            .is_empty()
    );
    drop(live_authority);

    crate::prepare_host_admission_capacity(root.path());
    assert!(
        matches!(
            root.find_manifest_by_session("workspace", "session")
                .unwrap()
                .manifest,
            DiscoveryManifest::Ready(_)
        ),
        "admission with headroom must defer unrelated abandoned-generation maintenance"
    );

    if cut != RetirementCut::None {
        if cut == RetirementCut::OtherStop {
            reserve_stop_intent(root.path(), &request).unwrap();
        }
        let request = automatic_stop_request(&DiscoveryManifest::Ready(ready.clone())).unwrap();
        if cut == RetirementCut::ReservedStop {
            reserve_stop_intent(root.path(), &request).unwrap();
        }
        let AbandonedReadyAcquisition::Acquired(abandoned) =
            acquire(root.path(), &request, &ready).unwrap()
        else {
            panic!("the exact abandoned generation must be acquired");
        };
        (*abandoned).publish_exited().unwrap();
        assert!(
            !managed_create_ledger::pending_session_paths(root.path())
                .unwrap()
                .is_empty(),
            "the simulated interruption must precede create-ledger retirement",
        );
        if matches!(
            cut,
            RetirementCut::UnreservedExit | RetirementCut::OtherStop
        ) {
            let stale_observation = acquire(root.path(), &request, &ready).unwrap();
            assert!(matches!(
                stale_observation,
                AbandonedReadyAcquisition::AlreadyExited
            ));
            assert!(!finish_abandoned_retirement(
                root.path(),
                &request,
                stale_observation
            ));
            maintain();
            assert!(
                !managed_create_ledger::pending_session_paths(root.path())
                    .unwrap()
                    .is_empty(),
                "neither an observed exit nor its reason creates retirement authority",
            );
            let reconciliation = ManagedStopReconcileRequest::from_stop_request(&request).unwrap();
            assert!(
                !managed_stop_intent::reconciliation_exists(root.path(), &reconciliation).unwrap()
            );
            return;
        }
    }

    maintain();

    assert!(matches!(
        root.find_manifest_by_session("workspace", "session")
            .unwrap()
            .manifest,
        DiscoveryManifest::Exited(_)
    ));
    assert!(
        managed_create_ledger::pending_session_paths(root.path())
            .unwrap()
            .is_empty()
    );
    maintain();
    assert!(matches!(
        root.find_manifest_by_session("workspace", "session")
            .unwrap()
            .manifest,
        DiscoveryManifest::Exited(_)
    ));
}
