use super::*;
use dure_app::OperationIdV1;
use std::path::PathBuf;
use std::time::Duration;

struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    root: PathBuf,
    catalog: LocalSessionCatalog,
    source: CreatedStandaloneSession,
    request: StandaloneUpgradeRequest,
}

impl Fixture {
    fn new(cross_namespace: bool) -> Self {
        let path = |key| {
            PathBuf::from(std::env::var_os(key).unwrap())
                .canonicalize()
                .unwrap()
        };
        let guardian = path("DURE_HMUX_TEST_STATE_ROOT");
        let home = path("HOME");
        assert!(home.starts_with(&guardian) && home != guardian);
        assert!(path("DURE_HOME").starts_with(&home));
        assert!(path("HMUX_DISCOVERY_ROOT").starts_with(&home));
        let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
        assert!(root.starts_with(&guardian));
        let source_root = root.join("source");
        let source = crate::session_checkout::create_standalone(
            path("DURE_QA_SOURCE_HMUX_RUNTIME"),
            Some(source_root.clone()),
            OperationIdV1::new(format!(
                "upgrade-source-{}",
                root.file_name().unwrap().to_str().unwrap()
            ))
            .unwrap(),
            StandaloneCreateRequest::new(
                &root,
                Some("upgrade-fixture".into()),
                vec!["/bin/sh".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
        let app = tauri::test::mock_app();
        let current = runtime::ensure_current_build(app.handle()).unwrap();
        assert!(current.runtime.starts_with(path("HMUX_INSTALL_ROOT")));
        assert_ne!(
            source.session().descriptor().host_build_version,
            current.build_id
        );
        let catalog = if cross_namespace {
            let target = root.join("target");
            hmux_host::local_discovery::DiscoveryRoot::create(&target).unwrap();
            LocalSessionCatalog::with_read_only_discovery_roots(target, vec![source_root]).unwrap()
        } else {
            LocalSessionCatalog::new(source_root)
        };
        let request = StandaloneUpgradeRequest {
            upgrade_id: "adapter-upgrade".into(),
            session_id: source.receipt().session_id().into(),
            workspace_id: source.receipt().workspace_id().into(),
            session_name: "upgrade-fixture".into(),
            confirmed: true,
        };
        Self {
            app,
            root,
            catalog,
            source,
            request,
        }
    }

    fn close(created: &CreatedStandaloneSession) {
        crate::session_checkout::close_standalone(
            LocalSessionCatalog::new(created.receipt().discovery_root()),
            created.receipt().session_id(),
            created.receipt().workspace_id(),
            Some(&created.session().descriptor().terminal_epoch),
            Duration::from_secs(3),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "requires isolated native app roots and paired staged/source Hmux binaries"]
fn native_preparation_binds_the_actual_selected_runtime_before_source_stop() {
    for cross_namespace in [false, true] {
        let fixture = Fixture::new(cross_namespace);
        let Preparation::Prepared(prepared, lock) = prepare::prepare(
            fixture.app.handle(),
            &fixture.catalog,
            &fixture.request,
            None,
        )
        .unwrap() else {
            panic!("fixture upgrade must be prepared");
        };
        let replacement = prepared.replacement.as_ref().unwrap();
        let operation = replacement
            .create
            .recovery_operation_id()
            .map(str::to_owned);
        let operation_root = replacement
            .create
            .recovery_operation_root()
            .map(std::path::Path::to_path_buf);
        let health =
            probe_local_session_exact(&fixture.catalog, fixture.source.session().descriptor());
        drop(lock);
        Fixture::close(&fixture.source);
        assert_eq!(health, SessionProbeStatus::Healthy);
        assert_eq!(
            operation.as_deref(),
            Some(fixture.request.upgrade_id.as_str())
        );
        assert_eq!(
            operation_root,
            cross_namespace.then(|| fixture.source.receipt().discovery_root().to_path_buf())
        );
    }
}

#[test]
#[ignore = "requires isolated native app roots and paired staged/source Hmux binaries"]
fn native_completed_replay_uses_the_saved_target_namespace_without_caller_discovery() {
    let fixture = Fixture::new(true);
    let Preparation::Prepared(prepared, source_lock) = prepare::prepare(
        fixture.app.handle(),
        &fixture.catalog,
        &fixture.request,
        None,
    )
    .unwrap() else {
        panic!("fixture upgrade must be prepared");
    };
    let identity = recovery::PreparedRecoveryIdentity {
        recovery_id: fixture.request.upgrade_id.clone(),
        source_session_id: fixture.request.session_id.clone(),
        source_workspace_id: fixture.request.workspace_id.clone(),
        action: ACTION,
        legacy_request_fingerprint: None,
    };
    let recovery::RecoveryReservationState::Pending(mut operation) = recovery::reserve_prepared(
        fixture.catalog.discovery_root(),
        identity.clone(),
        Some(serde_json::to_string(&prepared).unwrap()),
    )
    .unwrap() else {
        panic!("new operation must be pending");
    };
    drop(source_lock);
    let prepared = PreparedUpgrade::read(operation.operation_checkpoint().unwrap()).unwrap();
    let replacement = prepared.replacement.as_ref().unwrap();
    let current = runtime::ensure_current_build(fixture.app.handle()).unwrap();
    let target = crate::session_checkout::create_standalone_replacement(
        current.runtime,
        replacement
            .discovery_root(fixture.source.receipt().discovery_root())
            .to_path_buf(),
        replacement.context.checkout.clone(),
        replacement.create.clone(),
        Some(prepared.source),
    )
    .unwrap();
    let saved = CompletedStandaloneTarget::from_created(
        target.receipt().clone(),
        target.session().descriptor(),
    )
    .unwrap();
    standalone_upgrade::complete_target(&mut operation, &saved).unwrap();
    drop(operation);
    let recovery::RecoveryReservationState::Completed(completion) =
        recovery::reserve_prepared(fixture.source.receipt().discovery_root(), identity, None)
            .unwrap()
    else {
        panic!("operation must be completed");
    };
    let caller_root = fixture.root.join("unconfigured-caller");
    let replayed = replay(
        &LocalSessionCatalog::new(&caller_root),
        &fixture.request,
        completion,
    );
    let target_health = probe_local_session_exact(
        &LocalSessionCatalog::new(target.receipt().discovery_root()),
        target.session().descriptor(),
    );
    Fixture::close(&target);
    Fixture::close(&fixture.source);
    assert_eq!(target_health, SessionProbeStatus::Healthy);
    assert!(
        !caller_root.exists(),
        "receipt replay must not create the caller namespace"
    );
    let replayed = replayed.unwrap();
    assert_eq!(replayed.outcome, "rehosted");
    assert!(replayed.replayed);
    assert_eq!(
        replayed.replacement_session.unwrap().session_id,
        target.receipt().session_id()
    );
}

#[test]
#[ignore = "requires isolated native app roots and paired staged/source Hmux binaries"]
fn native_execution_preserves_fresh_and_legacy_operation_namespaces() {
    for legacy in [false, true] {
        let fixture = Fixture::new(true);
        let source_root = fixture.source.receipt().discovery_root();
        let target_root = fixture.catalog.discovery_root();
        let caller_root = fixture.root.join("later-caller");
        let caller = if legacy {
            // This preexisting journal has not frozen any launch inputs yet.
            // A later caller must prepare it at its original location, not move it.
            drop(
                recovery::reserve(
                    target_root,
                    recovery::RecoveryIdentity {
                        recovery_id: fixture.request.upgrade_id.clone(),
                        source_session_id: fixture.request.session_id.clone(),
                        source_workspace_id: fixture.request.workspace_id.clone(),
                        request_fingerprint: recovery::request_fingerprint(&[
                            &serde_json::to_string(&fixture.request).unwrap(),
                        ]),
                        action: ACTION,
                    },
                )
                .unwrap(),
            );
            LocalSessionCatalog::with_read_only_discovery_roots(
                &caller_root,
                vec![target_root.to_path_buf(), source_root.to_path_buf()],
            )
            .unwrap()
        } else {
            fixture.catalog.clone()
        };
        let manager = HmuxManager::default();
        let receipt = execute(
            &manager,
            fixture.app.handle(),
            &caller,
            fixture.request.clone(),
        )
        .unwrap();
        let operation_root = if legacy { target_root } else { source_root };
        let observation = hmux_client::recovery_journal::existing_operation::read(
            operation_root,
            &fixture.request.upgrade_id,
            ACTION,
        )
        .unwrap()
        .unwrap();
        let hmux_client::recovery_journal::existing_operation::RecoveryOperationObservation::Completed {
            completion, ..
        } = observation else { panic!("adapter must finish its original operation"); };
        let prepared =
            PreparedUpgrade::read(completion.operation_checkpoint.as_ref().unwrap()).unwrap();
        let replacement = prepared.replacement.unwrap();
        let completed = standalone_upgrade::read_completed(
            &LocalSessionCatalog::new(operation_root),
            &fixture.request.upgrade_id,
            ACTION,
        )
        .unwrap()
        .unwrap();
        let target =
            CreatedStandaloneSession::from_completed_target(&completed.successor.target).unwrap();
        let source_process = hmux_client::probe_local_process_generation(
            &fixture.source.session().descriptor().provider_process,
        )
        .unwrap();
        let replayed = execute(
            &manager,
            fixture.app.handle(),
            &caller,
            fixture.request.clone(),
        )
        .unwrap();
        Fixture::close(&target);
        Fixture::close(&fixture.source);
        assert_eq!(receipt.outcome, "rehosted");
        assert_eq!(receipt.replayed, legacy);
        assert_eq!(
            source_process,
            hmux_client::LocalProcessGenerationStatus::Absent
        );
        assert_eq!(target.receipt().discovery_root(), target_root);
        assert_eq!(replacement.discovery_root.as_deref(), Some(target_root));
        assert_eq!(
            replacement.create.recovery_operation_id(),
            Some(fixture.request.upgrade_id.as_str())
        );
        assert_eq!(
            replacement.create.recovery_operation_root(),
            (!legacy).then_some(source_root)
        );
        assert_eq!(receipt.replacement_session, replayed.replacement_session);
        assert!(replayed.replayed);
        assert!(!caller_root.exists());
    }
}
