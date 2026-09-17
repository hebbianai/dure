use super::*;
use hmux_client::recovery_journal::{
    PreparedRecoveryIdentity, RecoveryReservation,
    standalone_broker_admission::StandaloneBrokerAdmission,
    standalone_launch,
    standalone_upgrade::{
        self, PreparedStandaloneUpgrade, SELECTED_BUILD_ACTION, StandaloneUpgradeOperation,
        StandaloneUpgradeProgress, StandaloneUpgradeReplacement,
    },
};
use hmux_client::{
    CompletedStandaloneTarget, CompletedStandaloneTargetLifecycle, StandaloneReplacementSource,
};

struct Fixture {
    root: PathBuf,
    source_root: PathBuf,
    target_root: PathBuf,
    source: StandaloneReplacementSource,
    request: StandaloneCreateRequest,
    operation: Option<RecoveryReservation>,
}

impl Fixture {
    fn new() -> Self {
        Self::with_destination("located", None)
    }

    fn with_destination(name: &str, destination: Option<&Path>) -> Self {
        let root = upgrade::isolated_upgrade_root();
        let source_root = root.join("source");
        let target_root = destination
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.join("target"));
        DiscoveryRoot::create(&target_root).unwrap();
        let original = run(
            &source_root,
            &root,
            &Request::new(
                request_fingerprint(&["located-source"]),
                name,
                fixture_provider_command(),
                24,
                80,
            )
            .unwrap(),
        );
        let (session, workspace) = created_identity(&original);
        let catalog = LocalSessionCatalog::new(&source_root);
        let original = catalog
            .open(&SessionSelector::new(session, Some(workspace.into())))
            .unwrap();
        await_marker(&fixture_provider_marker(&root));
        let source = StandaloneReplacementSource::from_session(&original).unwrap();
        let request = standalone_launch::read_for_session(&catalog, &original, |_, _| Ok(None))
            .unwrap()
            .unwrap()
            .without_recovery_identity()
            .with_recovery_identity(
                StandaloneRecoveryCreateIdentity::new(
                    format!("standalone_{name}"),
                    "located-proof",
                )
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
                .with_source_predecessor(source.presentation_predecessor().unwrap())
                .unwrap(),
            )
            .unwrap()
            .with_recovery_operation_at("located-upgrade", &source_root)
            .unwrap();
        let prepared = PreparedStandaloneUpgrade {
            source: source.clone(),
            source_build_id: original.descriptor().host_build_version.clone(),
            target_build_id: upgrade::build_id(&runtime_executable()),
            replacement: Some(StandaloneUpgradeReplacement {
                create: request.clone(),
                discovery_root: Some(target_root.clone()),
                context: serde_json::json!({"runtime": runtime_executable()}),
            }),
        };
        let _source_lock = source.lock().unwrap();
        let RecoveryReservationState::Pending(operation) = recovery_journal::reserve_prepared(
            &source_root,
            PreparedRecoveryIdentity {
                recovery_id: "located-upgrade".into(),
                source_session_id: session.into(),
                source_workspace_id: workspace.into(),
                action: SELECTED_BUILD_ACTION,
                legacy_request_fingerprint: None,
            },
            Some(serde_json::to_string(&prepared).unwrap()),
        )
        .unwrap() else {
            panic!("new fixture operation must be pending");
        };
        Self {
            root,
            source_root,
            target_root,
            source,
            request,
            operation: Some(operation),
        }
    }

    fn starts(&self) -> usize {
        fs::read_to_string(fixture_provider_marker(&self.root))
            .unwrap()
            .lines()
            .count()
    }

    fn collect(&self) {
        let report = recovery_journal::garbage_collect_completed(
            &self.source_root,
            recovery_journal::RecoveryJournalGcPolicy {
                minimum_completed_age: Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(report.removed_completed_records >= 1);
    }

    fn retire_source(&self) {
        assert_eq!(
            LocalSessionCatalog::new(&self.source_root).retire_completed_standalone_target(
                self.source.generation(),
                self.source.provider_process(),
                Duration::from_secs(3),
            ),
            CompletedStandaloneTargetLifecycle::Retired
        );
    }
}

#[test]
#[ignore = "requires the located-operation native runtime and isolated guardian"]
fn located_broker_uses_only_its_frozen_target_and_keeps_target_local_history() {
    let mut fixture = Fixture::new();
    let wrong_root = fixture.root.join("wrong-target");
    DiscoveryRoot::create(&wrong_root).unwrap();
    let wrong = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&wrong_root)
        .create(fixture.request.clone());
    let starts = fixture.starts();
    if let Ok(created) = &wrong {
        terminate(
            &wrong_root,
            created.receipt().session_id(),
            created.receipt().workspace_id(),
        );
    }
    assert_eq!(starts, 1);
    assert_eq!(
        wrong.err().unwrap().code(),
        "hmux_standalone_operation_input_conflict"
    );
    let source_lock = fixture.source.lock().unwrap();
    fixture.source.stop(Duration::from_secs(3)).unwrap();
    let target = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&fixture.target_root)
        .create(fixture.request.clone())
        .unwrap();
    await_marker_lines(&fixture_provider_marker(&fixture.root), 2);
    let saved = CompletedStandaloneTarget::from_created(
        target.receipt().clone(),
        target.session().descriptor(),
    )
    .unwrap();
    standalone_upgrade::complete_target(fixture.operation.as_mut().unwrap(), &saved).unwrap();
    drop(fixture.operation.take());
    drop(source_lock);
    let catalog = LocalSessionCatalog::new(&fixture.target_root);
    assert_eq!(
        standalone_launch::read_for_session(&catalog, target.session(), |_, _| Ok(None)).unwrap(),
        Some(fixture.request.clone())
    );
    assert_eq!(fixture.starts(), 2);
    assert_eq!(
        catalog.retire_completed_standalone_target(
            saved.generation(),
            saved.provider_process(),
            Duration::from_secs(3)
        ),
        CompletedStandaloneTargetLifecycle::Retired
    );
    fixture.collect();
    for root in [&fixture.target_root, &fixture.source_root] {
        assert!(
            standalone_launch::read_for_session(
                &LocalSessionCatalog::new(root),
                target.session(),
                |_, _| Ok(None)
            )
            .unwrap()
            .is_none()
        );
    }
    assert_eq!(
        standalone_upgrade::read_completed(&catalog, "located-upgrade", SELECTED_BUILD_ACTION)
            .unwrap()
            .unwrap()
            .successor
            .target,
        saved
    );
    fixture.retire_source();
}

#[test]
#[ignore = "requires the located-operation native runtime and isolated guardian"]
fn located_cancellation_holds_the_target_broker_and_refuses_delayed_launch_after_collection() {
    let mut fixture = Fixture::new();
    let catalog = LocalSessionCatalog::new(&fixture.source_root);
    let Some(StandaloneUpgradeOperation::Pending(pending)) =
        standalone_upgrade::read_operation(&catalog, "located-upgrade", SELECTED_BUILD_ACTION)
            .unwrap()
    else {
        panic!("fixture must be pending");
    };
    drop(fixture.operation.take());
    let target_broker = StandaloneBrokerAdmission::acquire(&fixture.target_root).unwrap();
    assert!(matches!(
        pending.settle_for_close(&catalog).unwrap(),
        StandaloneUpgradeProgress::Pending(_)
    ));
    drop(target_broker);
    let source_broker = StandaloneBrokerAdmission::acquire(&fixture.source_root).unwrap();
    assert!(matches!(
        pending.settle_for_close(&catalog).unwrap(),
        StandaloneUpgradeProgress::Cancelled
    ));
    drop(source_broker);
    let creator = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&fixture.target_root);
    let before = creator.create(fixture.request.clone());
    assert_eq!(
        before.err().unwrap().code(),
        "hmux_standalone_operation_not_pending"
    );
    fixture.collect();
    let after = creator.create(fixture.request.clone());
    assert_eq!(
        after.err().unwrap().code(),
        "hmux_standalone_operation_not_pending"
    );
    let provider = probe_local_process_generation(fixture.source.provider_process()).unwrap();
    let starts = fixture.starts();
    fixture.retire_source();
    assert_eq!(provider, LocalProcessGenerationStatus::Live);
    assert_eq!(starts, 1);
}

#[test]
#[ignore = "requires the located-operation native runtime and isolated guardian"]
fn cancelling_a_local_operation_never_cancels_or_retires_an_imported_same_id_target() {
    let mut local = Fixture::new();
    let mut peer = Fixture::with_destination("peer", Some(&local.source_root));
    let peer_lock = peer.source.lock().unwrap();
    peer.source.stop(Duration::from_secs(3)).unwrap();
    let created = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&peer.target_root)
        .create(peer.request.clone())
        .unwrap();
    await_marker_lines(&fixture_provider_marker(&peer.root), 2);
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    standalone_upgrade::complete_target(peer.operation.as_mut().unwrap(), &target).unwrap();
    drop(peer.operation.take());
    drop(peer_lock);

    let catalog = LocalSessionCatalog::new(&local.source_root);
    let Some(StandaloneUpgradeOperation::Pending(pending)) =
        standalone_upgrade::read_operation(&catalog, "located-upgrade", SELECTED_BUILD_ACTION)
            .unwrap()
    else {
        panic!("target history shadowed a different local operation");
    };
    assert_eq!(pending.operation_root(), local.source_root);
    drop(local.operation.take());
    assert!(matches!(
        pending.settle_for_close(&catalog).unwrap(),
        StandaloneUpgradeProgress::Cancelled
    ));
    let delayed =
        StandaloneSessionCreator::new(runtime_executable()).with_discovery_root(&local.target_root);
    assert_eq!(
        delayed.create(local.request.clone()).unwrap_err().code(),
        "hmux_standalone_operation_not_pending"
    );
    local.collect();
    peer.collect();
    let after_gc = delayed.create(local.request.clone());
    let source_state = probe_local_process_generation(local.source.provider_process()).unwrap();
    let target_state = probe_local_process_generation(target.provider_process()).unwrap();
    let starts = (local.starts(), peer.starts());
    let launch = standalone_launch::read_for_session(&catalog, created.session(), |_, _| Ok(None));
    assert_eq!(
        catalog.retire_completed_standalone_target(
            target.generation(),
            target.provider_process(),
            Duration::from_secs(3)
        ),
        CompletedStandaloneTargetLifecycle::Retired
    );
    local.retire_source();
    peer.retire_source();

    assert_eq!(
        after_gc.unwrap_err().code(),
        "hmux_standalone_operation_not_pending"
    );
    assert_eq!(source_state, LocalProcessGenerationStatus::Live);
    assert_eq!(target_state, LocalProcessGenerationStatus::Live);
    assert_eq!(starts, (1, 2));
    assert_eq!(launch.unwrap(), Some(peer.request));
}
