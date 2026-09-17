use super::*;
use hmux_client::{SessionLifecycle, SessionProbeStatus, probe_local_session_exact};

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn cli_upgrades_a_compatibility_launch_into_the_primary_without_a_name_recipe() {
    assert_cross_root_upgrade(false);
}

#[test]
#[ignore = "requires a second real runtime build via DURE_QA_HMUX_REPLACEMENT_RUNTIME"]
fn cli_upgrades_a_compacted_compatibility_launch_into_the_primary() {
    assert_cross_root_upgrade(true);
}

fn assert_cross_root_upgrade(compacted_source: bool) {
    let root = upgrade::isolated_upgrade_root();
    let primary_home = root.join("primary-app");
    let compatibility_home = root.join("legacy-app");
    let primary = primary_home.join("state/hmux-hosts");
    let compatibility = compatibility_home.join("state/hebbian-agent/hmux-hosts");
    DiscoveryRoot::create(&primary).unwrap();
    let request = Request::new(
        request_fingerprint(&["cross-root-original"]),
        "cross-root-upgrade",
        fixture_provider_command(),
        37,
        119,
    )
    .unwrap();
    let created = run(&compatibility, &root, &request);
    let (session_id, workspace_id) = created_identity(&created);
    let catalog =
        LocalSessionCatalog::with_read_only_discovery_roots(&primary, vec![compatibility.clone()])
            .unwrap();
    let mut original = catalog
        .open(&SessionSelector::new(session_id, Some(workspace_id.into())))
        .unwrap();
    await_marker(&fixture_provider_marker(&root));
    if compacted_source {
        original = upgrade_and_collect(&root, &compatibility, &original);
    }
    let session_id = original.descriptor().session_id.as_str();
    let expected_starts = if compacted_source { 3 } else { 2 };
    assert_eq!(general_resurrection_recipe_count(&compatibility), 0);
    let output = Command::new(hmux_executable())
        .args([
            "--json",
            "upgrade",
            session_id,
            "--confirm-restart",
            "--operation-id",
            "cross-root-upgrade",
            "--runtime",
        ])
        .arg(if compacted_source {
            runtime_executable()
        } else {
            upgrade::replacement_runtime()
        })
        .env_remove("HMUX_DISCOVERY_ROOT")
        .env("DURE_HOME", &primary_home)
        .env("HEBBIAN_HOME", &compatibility_home)
        .env("HOME", root.join("home"))
        .env("XDG_STATE_HOME", root.join("xdg-state"))
        .env("XDG_DATA_HOME", root.join("xdg-data"))
        .env("HMUX_INSTALL_ROOT", root.join("install"))
        .current_dir(&root)
        .output()
        .unwrap();
    if output.status.success() {
        await_marker_lines(&fixture_provider_marker(&root), expected_starts);
    }
    let source_provider =
        probe_local_process_generation(&original.descriptor().provider_process).unwrap();
    let starts = fs::read_to_string(fixture_provider_marker(&root))
        .unwrap()
        .lines()
        .count();
    let targets: Vec<_> = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.lifecycle == SessionLifecycle::Ready)
        .map(|descriptor| {
            catalog
                .open(&SessionSelector::new(
                    descriptor.session_id,
                    Some(descriptor.workspace_id),
                ))
                .unwrap()
        })
        .collect();
    let observations: Vec<_> = targets
        .iter()
        .map(|session| {
            (
                session.discovery_root().unwrap().to_path_buf(),
                probe_local_session_exact(&catalog, session.descriptor()),
            )
        })
        .collect();
    let source_operation = recovery_journal::existing_operation::read(
        &compatibility,
        "cross-root-upgrade",
        recovery_journal::standalone_upgrade::SELECTED_BUILD_ACTION,
    )
    .unwrap();
    let completed = recovery_journal::standalone_upgrade::read_completed(
        &catalog,
        "cross-root-upgrade",
        recovery_journal::standalone_upgrade::SELECTED_BUILD_ACTION,
    )
    .unwrap();
    // Snapshot success, process and namespace observations before cleanup of
    // only the exact fixture sessions, including the original on RED.
    for target in targets {
        terminate(
            target.discovery_root().unwrap(),
            &target.descriptor().session_id,
            &target.descriptor().workspace_id,
        );
    }
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(source_provider, LocalProcessGenerationStatus::Absent);
    assert_eq!(starts, expected_starts);
    assert_eq!(
        observations,
        vec![(primary.clone(), SessionProbeStatus::Healthy)]
    );
    assert!(
        matches!(
            source_operation,
            Some(
                recovery_journal::existing_operation::RecoveryOperationObservation::Completed { .. }
            )
        ),
        "the original source namespace must own the completed operation"
    );
    assert!(
        recovery_journal::existing_operation::read(
            &primary,
            "cross-root-upgrade",
            recovery_journal::standalone_upgrade::SELECTED_BUILD_ACTION,
        )
        .unwrap()
        .is_none(),
        "the target contains immutable launch history, not a second operation"
    );
    assert_eq!(
        completed
            .unwrap()
            .successor
            .target
            .receipt()
            .discovery_root(),
        primary
    );
}

fn upgrade_and_collect(
    root: &Path,
    discovery: &Path,
    source: &hmux_client::LocalSession,
) -> hmux_client::LocalSession {
    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(discovery)
        .args([
            "--json",
            "upgrade",
            &source.descriptor().session_id,
            "--confirm-restart",
            "--operation-id",
            "source-upgrade",
            "--runtime",
        ])
        .arg(upgrade::replacement_runtime())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    await_marker_lines(&fixture_provider_marker(root), 2);
    let catalog = LocalSessionCatalog::new(discovery);
    let completed = recovery_journal::standalone_upgrade::read_completed(
        &catalog,
        "source-upgrade",
        recovery_journal::standalone_upgrade::SELECTED_BUILD_ACTION,
    )
    .unwrap()
    .unwrap();
    let report = recovery_journal::garbage_collect_completed(
        discovery,
        recovery_journal::RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..recovery_journal::RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert!(report.removed_completed_records >= 1);
    assert!(
        recovery_journal::existing_operation::read(
            discovery,
            "source-upgrade",
            recovery_journal::standalone_upgrade::SELECTED_BUILD_ACTION
        )
        .unwrap()
        .is_none()
    );
    catalog
        .open_completed_standalone_target(
            completed.successor.target.generation(),
            completed.successor.target.provider_process(),
        )
        .unwrap()
}
