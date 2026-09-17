use super::*;

#[test]
fn chain_stop_closes_the_root_before_a_late_advance_and_replays_its_receipt() {
    let state = tempfile::tempdir().unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "chain-stop-root-create",
        "chain-stop-root-session",
        "chain-stop-root-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            FIXTURE_STATE_DIR_ENV.into(),
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    creator.create(request.clone()).unwrap();
    let root = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let stopper = ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
        .with_discovery_root(&discovery_root);

    let stopped = stopper.stop_create_chain(root.clone()).unwrap();
    assert_eq!(stopped.root(), &root);
    assert_eq!(stopped.effective(), &root);
    let first_stop = stopped.stop_receipt().cloned().unwrap();
    let replayed = stopper.stop_create_chain(root.clone()).unwrap();
    assert_eq!(replayed.stop_receipt(), Some(&first_stop));

    let late = creator
        .create_or_reconcile_and_advance(request)
        .expect("a closed chain returns typed authority without allocating");
    assert!(matches!(
        late,
        ManagedCreateAdvanceResolution::AuthorityUnavailable(_)
    ));
    let records = successor_edges(&discovery_root);
    assert_eq!(records.len(), 1);
    assert!(records[0].get("successor").is_none());
    assert!(records[0]["cleanupClosedUnixMs"].as_u64().is_some());
}

#[test]
fn prelaunch_reservation_shares_the_runtime_create_and_stop_authority() {
    for launch in [false, true] {
        let state = tempfile::tempdir().unwrap();
        fs::write(state.path().join("hold-open"), b"1").unwrap();
        let discovery_root = state.path().join("discovery");
        DiscoveryRoot::create(&discovery_root).unwrap();
        let request = ManagedCreateRequest::new(
            "prepared-root-create",
            "prepared-root-session",
            "prepared-root-workspace",
            "fixture",
            PermissionMode::Default,
            state.path().canonicalize().unwrap(),
            fixture_provider_command(),
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                state.path().to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            managed_create_ledger::reserve_request(
                &discovery_root,
                &request,
                managed_create_ledger::ManagedCreateLineageAdmission::Root,
            )
            .unwrap(),
            ManagedCreateLedgerState::Prepared(_)
        ));
        assert!(!state.path().join("provider-spawns").exists());

        let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
        let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
        let generation = if launch {
            let created = creator.create(request.clone()).unwrap();
            Some(created.session().descriptor().provider_process.clone())
        } else {
            None
        };
        let identity = ManagedCreateReconcileRequest::new(
            request.idempotency_key(),
            request.session_id(),
            request.workspace_id(),
        )
        .unwrap();
        let stopper = ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
            .with_discovery_root(&discovery_root);
        let closed = stopper.stop_create_chain_v2(identity.clone()).unwrap();
        assert_eq!(closed.chain(), std::slice::from_ref(&identity));
        assert_eq!(closed.stop_receipt().is_some(), launch);
        assert_eq!(stopper.stop_create_chain_v2(identity).unwrap(), closed);
        assert_eq!(
            creator.create(request).unwrap_err().code(),
            hmux_runtime_contract::MANAGED_CREATE_RETIRED_EXACT_CODE,
            "late delivery cannot reopen a cancelled prelaunch reservation",
        );
        if let Some(generation) = generation {
            assert_eq!(
                probe_local_process_generation(&generation).unwrap(),
                LocalProcessGenerationStatus::Absent,
            );
        } else {
            assert!(!state.path().join("provider-spawns").exists());
        }
    }
}
