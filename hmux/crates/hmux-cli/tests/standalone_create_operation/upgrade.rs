use super::*;
use hmux_client::{SessionLifecycle, SessionProbeStatus, probe_local_session_exact};

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn a_capable_selected_build_freezes_its_operation_binding_before_launch() {
    let root = isolated_upgrade_root();
    let discovery = root.join("discovery");
    let original = StandaloneSessionCreator::new(replacement_runtime())
        .with_discovery_root(&discovery)
        .create(
            StandaloneCreateRequest::new(
                &root,
                Some("operation-bound-upgrade".into()),
                fixture_provider_command(),
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    await_marker(&fixture_provider_marker(&root));
    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&discovery)
        .args([
            "--json",
            "upgrade",
            "operation-bound-upgrade",
            "--confirm-restart",
            "--operation-id",
            "bound-upgrade",
            "--runtime",
        ])
        .arg(runtime_executable())
        .current_dir(&root)
        .output()
        .unwrap();
    if output.status.success() {
        await_marker_lines(&fixture_provider_marker(&root), 2);
    }
    let observation = recovery_journal::existing_operation::read(
        &discovery,
        "bound-upgrade",
        recovery_journal::standalone_upgrade::SELECTED_BUILD_ACTION,
    )
    .unwrap();
    let catalog = LocalSessionCatalog::new(&discovery);
    let active: Vec<_> = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.lifecycle == SessionLifecycle::Ready)
        .collect();
    let starts = fs::read_to_string(fixture_provider_marker(&root))
        .unwrap()
        .lines()
        .count();
    let original_gone =
        probe_local_process_generation(&original.session().descriptor().provider_process).unwrap();
    for descriptor in &active {
        terminate(&discovery, &descriptor.session_id, &descriptor.workspace_id);
    }
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(starts, 2);
    assert_eq!(active.len(), 1);
    assert_eq!(original_gone, LocalProcessGenerationStatus::Absent);
    let Some(recovery_journal::existing_operation::RecoveryOperationObservation::Completed {
        completion,
        ..
    }) = observation
    else {
        panic!("CLI must complete its exact upgrade");
    };
    let prepared = recovery_journal::standalone_upgrade::read_upgrade(
        &completion.action,
        completion.operation_checkpoint.as_ref().unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        prepared.replacement.unwrap().create.recovery_operation_id(),
        Some("bound-upgrade")
    );
}

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn cli_refuses_an_app_prepared_source_before_stopping_or_launching() {
    use hmux_client::{
        StandaloneReplacementSource,
        recovery_journal::{
            PreparedRecoveryIdentity, existing_operation, reserve_prepared, standalone_launch,
            standalone_upgrade::{
                CURRENT_BUILD_ACTION, PreparedStandaloneUpgrade, SELECTED_BUILD_ACTION,
                StandaloneUpgradeReplacement,
            },
        },
    };
    let replacement_runtime = replacement_runtime();
    let root = isolated_upgrade_root();
    let discovery = root.join("discovery");
    let request = Request::new(
        request_fingerprint(&["upgrade-admission-origin"]),
        "pending-app-upgrade",
        fixture_provider_command(),
        37,
        119,
    )
    .unwrap();
    let original = run(&discovery, &root, &request);
    let (session_id, workspace_id) = created_identity(&original);
    let catalog = LocalSessionCatalog::new(&discovery);
    let source = catalog
        .open(&SessionSelector::new(session_id, Some(workspace_id.into())))
        .unwrap();
    await_marker(&fixture_provider_marker(&root));
    let exact_source = StandaloneReplacementSource::from_session(&source).unwrap();
    let saved = standalone_launch::read_for_session(&catalog, &source, |_, _| Ok(None))
        .unwrap()
        .unwrap();
    let create = saved
        .without_recovery_identity()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new("standalone_app_upgrade", "app-upgrade-proof")
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
                .with_source_predecessor(exact_source.presentation_predecessor().unwrap())
                .unwrap(),
        )
        .unwrap();
    let prepared = PreparedStandaloneUpgrade {
        source: exact_source,
        source_build_id: source.descriptor().host_build_version.clone(),
        target_build_id: build_id(&replacement_runtime),
        replacement: Some(StandaloneUpgradeReplacement {
            discovery_root: None,
            create,
            context: serde_json::json!({"checkout": null}),
        }),
    };
    let state = reserve_prepared(
        &discovery,
        PreparedRecoveryIdentity {
            recovery_id: "app-upgrade-before-cli".into(),
            source_session_id: session_id.into(),
            source_workspace_id: workspace_id.into(),
            action: CURRENT_BUILD_ACTION,
            legacy_request_fingerprint: None,
        },
        Some(serde_json::to_string(&prepared).unwrap()),
    )
    .unwrap();
    // Lose the first caller's lock, not its durable prepared intent. The next
    // writer is the real CLI in another process, not a second test-only guard.
    drop(state);
    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&discovery)
        .args([
            "--json",
            "upgrade",
            session_id,
            "--confirm-restart",
            "--operation-id",
            "competing-cli-upgrade",
            "--runtime",
        ])
        .arg(&replacement_runtime)
        .current_dir(&root)
        .output()
        .unwrap();
    if output.status.success() {
        await_marker_lines(&fixture_provider_marker(&root), 2);
    }
    let provider = probe_local_process_generation(&source.descriptor().provider_process).unwrap();
    let host = probe_local_process_generation(&source.descriptor().host_process).unwrap();
    let launches = fs::read_to_string(fixture_provider_marker(&root))
        .unwrap()
        .lines()
        .count();
    let competing =
        existing_operation::read(&discovery, "competing-cli-upgrade", SELECTED_BUILD_ACTION)
            .unwrap();
    let active: Vec<_> = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.lifecycle == SessionLifecycle::Ready)
        .collect();
    // Assert only captured pre-cleanup observations. Even a failing admission
    // leaves every fixture process with exact retirement and guardian coverage.
    for descriptor in &active {
        catalog
            .open(&SessionSelector::new(
                &descriptor.session_id,
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .terminate_standalone(&catalog, Duration::from_secs(3))
            .unwrap();
    }
    assert!(
        !output.status.success(),
        "a rival CLI upgrade stopped the prepared source"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("hmux_recovery_source_busy:"),
        "unexpected refusal: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(provider, LocalProcessGenerationStatus::Live);
    assert_eq!(host, LocalProcessGenerationStatus::Live);
    assert_eq!(launches, 1);
    assert!(competing.is_none());
    assert_eq!(active.len(), 1);
    assert!(active[0].same_generation(source.descriptor()));
}

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn request_bound_source_upgrades_from_its_saved_launch_without_a_general_recipe() {
    let replacement_runtime = replacement_runtime();
    let target_build = build_id(&replacement_runtime);
    let root = isolated_upgrade_root();
    let discovery = root.join("discovery");
    let request = Request::new(
        request_fingerprint(&["upgrade-origin"]),
        "request-bound-upgrade",
        fixture_provider_command(),
        37,
        119,
    )
    .unwrap();
    let original = run(&discovery, &root, &request);
    let (session_id, workspace_id) = created_identity(&original);
    let catalog = LocalSessionCatalog::new(&discovery);
    let before = catalog
        .find(&SessionSelector::new(session_id, Some(workspace_id.into())))
        .unwrap();
    await_marker(&fixture_provider_marker(&root));
    assert_eq!(general_resurrection_recipe_count(&discovery), 0);

    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&discovery)
        .args([
            "--json",
            "upgrade",
            "request-bound-upgrade",
            "--confirm-restart",
        ])
        .arg("--runtime")
        .arg(&replacement_runtime)
        .current_dir(&root)
        .output()
        .unwrap();
    if output.status.success() {
        await_marker_lines(&fixture_provider_marker(&root), 2);
    }
    let replay = output.status.success().then(|| {
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        // The source is gone and this runtime hint is unusable. A completed
        // operation must reopen its target without another launch or lookup.
        Command::new(hmux_executable())
            .arg("--discovery-root")
            .arg(&discovery)
            .args(["--json", "upgrade", session_id, "--operation-id"])
            .arg(receipt["operationId"].as_str().unwrap())
            .arg("--runtime")
            .arg(root.join("not-an-installed-runtime"))
            .current_dir(&root)
            .output()
            .unwrap()
    });
    let after = catalog.list().unwrap();
    // Catalog discovery includes retained Exited records. Count runnable
    // generations separately; provider exit precedes the Host's final drain.
    let active: Vec<_> = after
        .iter()
        .filter(|session| session.lifecycle == SessionLifecycle::Ready)
        .collect();
    let target_probes: Vec<_> = active
        .iter()
        .map(|session| probe_local_session_exact(&catalog, session))
        .collect();
    let recipes = general_resurrection_recipe_count(&discovery);
    let launches = fs::read_to_string(fixture_provider_marker(&root)).unwrap();
    let source_preserved = after.iter().any(|session| session.same_generation(&before));
    let source_provider = probe_local_process_generation(&before.provider_process).unwrap();
    let host_drain_deadline = Instant::now() + Duration::from_secs(6);
    let source_host = loop {
        let state = probe_local_process_generation(&before.host_process).unwrap();
        if state == LocalProcessGenerationStatus::Absent || Instant::now() >= host_drain_deadline {
            break state;
        }
        // Observe natural connection drain without sending another stop or
        // archiving the source. Cleanup below must not manufacture this proof.
        thread::sleep(Duration::from_millis(25));
    };
    // Capture the transition before cleanup; the guardian remains the fallback
    // for a panic or an unresolved generation, never an unowned process kill.
    for descriptor in &active {
        catalog
            .open(&SessionSelector::new(
                &descriptor.session_id,
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .terminate_standalone(&catalog, Duration::from_secs(3))
            .unwrap();
    }

    assert!(
        output.status.success(),
        "upgrade failed: {}; source_preserved={source_preserved}, source_provider={source_provider:?}, launches={}",
        String::from_utf8_lossy(&output.stderr),
        launches.lines().count(),
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["outcome"], "rehosted");
    let replay = replay.unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let replay_receipt: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(
        replay_receipt, receipt,
        "completed replay must retain its exact target"
    );
    assert_eq!(
        active.len(),
        1,
        "catalog={:?}; source_provider={source_provider:?}; launches={}",
        after
            .iter()
            .map(|session| (
                &session.session_id,
                session.lifecycle,
                &session.host_build_version
            ))
            .collect::<Vec<_>>(),
        launches.lines().count(),
    );
    assert_eq!(target_probes, vec![SessionProbeStatus::Healthy]);
    assert_eq!(source_host, LocalProcessGenerationStatus::Absent);
    assert_eq!(source_provider, LocalProcessGenerationStatus::Absent);
    assert!(after.iter().all(|session| {
        session.lifecycle == SessionLifecycle::Ready
            || (session.same_generation(&before) && session.lifecycle == SessionLifecycle::Exited)
    }));
    assert_ne!(active[0].session_id, before.session_id);
    assert_eq!(active[0].session_id, receipt["replacementSessionId"]);
    assert_eq!(active[0].host_build_version, target_build);
    assert_eq!(
        recipes, 0,
        "a private launch must not become a general recipe"
    );
    assert_eq!(launches.lines().count(), 2);
}

pub(super) fn build_id(runtime: &Path) -> String {
    let output = Command::new(runtime)
        .args(["--no-autostart", "hmux-build-info"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let info: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    info["buildId"].as_str().unwrap().to_owned()
}

pub(super) fn isolated_upgrade_root() -> PathBuf {
    // Keep the root available to the outer process guardian after any failure.
    let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(&guardian) && root != guardian);
    root
}

pub(super) fn replacement_runtime() -> PathBuf {
    let runtime = PathBuf::from(
        std::env::var_os("DURE_QA_HMUX_REPLACEMENT_RUNTIME")
            .expect("the upgrade fixture needs its explicitly selected replacement runtime"),
    )
    .canonicalize()
    .unwrap();
    assert_ne!(build_id(&runtime_executable()), build_id(&runtime));
    runtime
}

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn caller_loss_reuses_a_started_target_without_its_launcher_or_new_input() {
    use hmux_client::{
        StandaloneReplacementSource,
        recovery_journal::{
            PreparedRecoveryIdentity, reserve_prepared, standalone_launch,
            standalone_upgrade::{
                PreparedStandaloneUpgrade, SELECTED_BUILD_ACTION, StandaloneUpgradeReplacement,
            },
        },
    };
    for legacy_checkpoint in [false, true] {
        let runtime = replacement_runtime();
        let root = isolated_upgrade_root();
        let discovery = root.join("discovery");
        let request = Request::new(
            request_fingerprint(&["lost-upgrade-origin"]),
            "lost-upgrade",
            fixture_provider_command(),
            37,
            119,
        )
        .unwrap();
        let original = run(&discovery, &root, &request);
        await_marker(&fixture_provider_marker(&root));
        let (session_id, workspace_id) = created_identity(&original);
        let catalog = LocalSessionCatalog::new(&discovery);
        let session = catalog
            .open(&SessionSelector::new(session_id, Some(workspace_id.into())))
            .unwrap();
        let source = StandaloneReplacementSource::from_session(&session).unwrap();
        let create = standalone_launch::read_for_session(&catalog, &session, |_, _| Ok(None))
            .unwrap()
            .unwrap()
            .without_recovery_identity()
            .with_recovery_identity(
                StandaloneRecoveryCreateIdentity::new(
                    "standalone_lost_upgrade",
                    "lost-upgrade-proof",
                )
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
                .with_source_predecessor(source.presentation_predecessor().unwrap())
                .unwrap(),
            )
            .unwrap();
        let prepared = PreparedStandaloneUpgrade {
            source: source.clone(),
            source_build_id: session.descriptor().host_build_version.clone(),
            target_build_id: build_id(&runtime),
            replacement: Some(StandaloneUpgradeReplacement {
                discovery_root: None,
                create: create.clone(),
                context: serde_json::json!({"runtime": root.join("launcher-no-longer-installed")}),
            }),
        };
        let RecoveryReservationState::Pending(mut operation) = reserve_prepared(
            &discovery,
            PreparedRecoveryIdentity {
                recovery_id: "lost-upgrade-operation".into(),
                source_session_id: session_id.into(),
                source_workspace_id: workspace_id.into(),
                action: SELECTED_BUILD_ACTION,
                legacy_request_fingerprint: None,
            },
            Some(serde_json::to_string(&prepared).unwrap()),
        )
        .unwrap() else {
            panic!("fresh upgrade must be pending")
        };
        source.stop(Duration::from_secs(3)).unwrap();
        let replacement = StandaloneSessionCreator::new(runtime)
            .with_discovery_root(&discovery)
            .create(create)
            .unwrap();
        if legacy_checkpoint {
            operation
                .checkpoint_replacement_receipt(
                    serde_json::to_string(replacement.receipt()).unwrap(),
                )
                .unwrap();
        }
        drop(operation);
        let output = Command::new(hmux_executable())
            .arg("--discovery-root")
            .arg(&discovery)
            .args([
                "--json",
                "upgrade",
                session_id,
                "--operation-id",
                "lost-upgrade-operation",
            ])
            .current_dir(&root)
            .output()
            .unwrap();
        await_marker_lines(&fixture_provider_marker(&root), 2);
        let starts = fs::read_to_string(fixture_provider_marker(&root))
            .unwrap()
            .lines()
            .count();
        let provider =
            probe_local_process_generation(&replacement.session().descriptor().provider_process)
                .unwrap();
        replacement
            .session()
            .terminate_standalone(&catalog, Duration::from_secs(3))
            .unwrap();
        assert!(
            output.status.success(),
            "legacy_checkpoint={legacy_checkpoint}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            receipt["replacementSessionId"],
            replacement.receipt().session_id()
        );
        assert_eq!(provider, LocalProcessGenerationStatus::Live);
        assert_eq!(
            starts, 2,
            "caller-loss recovery must not launch a third provider"
        );
    }
}

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn private_upgrade_launch_survives_compaction_until_exact_target_retirement() {
    use hmux_client::{
        CompletedStandaloneTargetLifecycle,
        recovery_journal::{RecoveryJournalGcPolicy, standalone_launch, standalone_upgrade},
    };
    let root = isolated_upgrade_root();
    let discovery = root.join("discovery");
    let request = Request::new(
        request_fingerprint(&["upgrade-compaction-origin"]),
        "private-upgrade-compaction",
        fixture_provider_command(),
        37,
        119,
    )
    .unwrap();
    let original = run(&discovery, &root, &request);
    let (session_id, workspace_id) = created_identity(&original);
    let catalog = LocalSessionCatalog::new(&discovery);
    let source = catalog
        .open(&SessionSelector::new(session_id, Some(workspace_id.into())))
        .unwrap();
    let source_generation =
        ExitedSessionRetirementGeneration::from_descriptor(source.descriptor()).unwrap();
    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&discovery)
        .args([
            "--json",
            "upgrade",
            session_id,
            "--confirm-restart",
            "--runtime",
        ])
        .arg(replacement_runtime())
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let target = catalog
        .open(&SessionSelector::new(
            receipt["replacementSessionId"].as_str().unwrap(),
            Some(receipt["replacementWorkspaceId"].as_str().unwrap().into()),
        ))
        .unwrap();
    let frozen = standalone_launch::read_for_session(&catalog, &target, |_, _| Ok(None))
        .unwrap()
        .unwrap();
    let report = recovery_journal::garbage_collect_completed(
        &discovery,
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
    let replay = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&discovery)
        .args(["--json", "upgrade", session_id, "--operation-id"])
        .arg(receipt["operationId"].as_str().unwrap())
        .arg("--runtime")
        .arg(root.join("not-an-installed-runtime"))
        .current_dir(&root)
        .output()
        .unwrap();
    assert_eq!(
        standalone_launch::read_for_session(&catalog, &target, |_, _| Ok(None)).unwrap(),
        Some(frozen),
    );
    assert_eq!(general_resurrection_recipe_count(&discovery), 0);
    await_marker_lines(&fixture_provider_marker(&root), 2);
    assert_eq!(
        fs::read_to_string(fixture_provider_marker(&root))
            .unwrap()
            .lines()
            .count(),
        2
    );

    let target_generation =
        ExitedSessionRetirementGeneration::from_descriptor(target.descriptor()).unwrap();
    assert_eq!(
        catalog.retire_completed_standalone_target(
            &target_generation,
            &target.descriptor().provider_process,
            Duration::from_secs(3),
        ),
        CompletedStandaloneTargetLifecycle::Retired
    );
    assert!(
        standalone_launch::read_for_session(&catalog, &target, |_, _| Ok(None))
            .unwrap()
            .is_none()
    );
    let Some(standalone_upgrade::StandaloneUpgradeProgress::Completed(saved)) =
        standalone_upgrade::read_successor(
            &catalog,
            &source_generation,
            &source.descriptor().provider_process,
        )
        .unwrap()
    else {
        panic!("late owners must still resolve the retired exact target")
    };
    assert_eq!(saved.target.generation(), &target_generation);
    // Observe replay before retirement, but assert after exact cleanup so a
    // regression cannot leave the replacement provider running.
    assert!(
        replay.status.success(),
        "completed operation replay after compaction failed: {}",
        String::from_utf8_lossy(&replay.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&replay.stdout).unwrap(),
        receipt
    );
}
