use super::*;
use hmux_client::{
    SessionLifecycle, StandaloneReplacementSource,
    recovery_journal::{
        PreparedRecoveryIdentity, existing_operation, reserve_prepared, standalone_launch,
        standalone_upgrade::{
            CURRENT_BUILD_ACTION, PreparedStandaloneUpgrade, SELECTED_BUILD_ACTION,
            StandaloneUpgradeReplacement,
        },
    },
};

#[test]
#[ignore = "requires a second real runtime build and the isolated process guardian"]
fn cli_preserves_an_app_owned_source_after_caller_loss_in_another_namespace() {
    assert_cross_namespace_owner(CURRENT_BUILD_ACTION, true);
}

#[test]
#[ignore = "requires a second real runtime build and the isolated process guardian"]
fn cli_preserves_a_cli_owned_source_after_caller_loss_in_another_namespace() {
    assert_cross_namespace_owner(SELECTED_BUILD_ACTION, true);
}

#[test]
#[ignore = "requires a second real runtime build and the isolated process guardian"]
fn cli_replays_its_compatibility_operation_without_reinterpreting_its_namespace() {
    assert_cross_namespace_owner(SELECTED_BUILD_ACTION, false);
}

fn assert_cross_namespace_owner(first_action: &'static str, competing_caller: bool) {
    let root = upgrade::isolated_upgrade_root();
    let source_home = root.join("source-home");
    let source_root = source_home.join("state/hebbian-agent/hmux-hosts");
    let first_root = if competing_caller {
        root.join("first-caller")
    } else {
        source_root.clone()
    };
    let second_home = root.join("second-caller");
    let second_root = second_home.join("state/hmux-hosts");
    DiscoveryRoot::create(&first_root).unwrap();
    DiscoveryRoot::create(&second_root).unwrap();
    let request = Request::new(
        request_fingerprint(&["cross-namespace-owner-source"]),
        "cross-namespace-owner",
        fixture_provider_command(),
        37,
        119,
    )
    .unwrap();
    let original = run(&source_root, &root, &request);
    let (session_id, workspace_id) = created_identity(&original);
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        &first_root,
        vec![source_root.clone(), second_root.clone()],
    )
    .unwrap();
    let source = catalog
        .open(&SessionSelector::new(session_id, Some(workspace_id.into())))
        .unwrap();
    await_marker(&fixture_provider_marker(&root));
    let exact_source = StandaloneReplacementSource::from_session(&source).unwrap();
    let saved = standalone_launch::read_for_session(&catalog, &source, |_, _| Ok(None))
        .unwrap()
        .unwrap();
    let replacement_runtime = upgrade::replacement_runtime();
    let create = saved
        .without_recovery_identity()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new("standalone_first_owner", "first-owner-proof")
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
                .with_source_predecessor(exact_source.presentation_predecessor().unwrap())
                .unwrap(),
        )
        .unwrap();
    let source_lock = exact_source.lock().unwrap();
    let prepared = PreparedStandaloneUpgrade {
        source: exact_source,
        source_build_id: source.descriptor().host_build_version.clone(),
        target_build_id: upgrade::build_id(&replacement_runtime),
        replacement: Some(StandaloneUpgradeReplacement {
            discovery_root: None,
            create,
            context: if first_action == CURRENT_BUILD_ACTION {
                serde_json::json!({"checkout": null})
            } else {
                serde_json::json!({"runtime": replacement_runtime})
            },
        }),
    };
    let first = reserve_prepared(
        &first_root,
        PreparedRecoveryIdentity {
            recovery_id: "first-owner".into(),
            source_session_id: session_id.into(),
            source_workspace_id: workspace_id.into(),
            action: first_action,
            legacy_request_fingerprint: None,
        },
        Some(serde_json::to_string(&prepared).unwrap()),
    )
    .unwrap();
    // The first caller exits after publishing intent but before source stop.
    // C knows the source namespace B, not the other caller's primary A.
    drop(first);
    drop(source_lock);
    let execute = || {
        Command::new(hmux_executable())
            .args([
                "--json",
                "upgrade",
                if competing_caller {
                    session_id
                } else {
                    "source-is-no-longer-an-input"
                },
                "--confirm-restart",
                "--operation-id",
                if competing_caller {
                    "second-owner"
                } else {
                    "first-owner"
                },
                "--runtime",
            ])
            .arg(&replacement_runtime)
            .env_remove("HMUX_DISCOVERY_ROOT")
            .env("DURE_HOME", &second_home)
            .env("HEBBIAN_HOME", &source_home)
            .env("HOME", root.join("home"))
            .env("XDG_STATE_HOME", root.join("xdg-state"))
            .env("XDG_DATA_HOME", root.join("xdg-data"))
            .env("HMUX_INSTALL_ROOT", root.join("install"))
            .current_dir(&root)
            .output()
            .unwrap()
    };
    let output = execute();
    if output.status.success() {
        await_marker_lines(&fixture_provider_marker(&root), 2);
    }
    let replays = if output.status.success() && !competing_caller {
        let completed = execute();
        let gc = recovery_journal::garbage_collect_completed(
            &first_root,
            recovery_journal::RecoveryJournalGcPolicy {
                minimum_completed_age: Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                ..recovery_journal::RecoveryJournalGcPolicy::default()
            },
        )
        .unwrap();
        assert!(gc.removed_completed_records >= 1);
        Some((completed, execute()))
    } else {
        None
    };
    let provider = probe_local_process_generation(&source.descriptor().provider_process).unwrap();
    let launches = fs::read_to_string(fixture_provider_marker(&root))
        .unwrap()
        .lines()
        .count();
    let competing =
        existing_operation::read(&second_root, "second-owner", SELECTED_BUILD_ACTION).unwrap();
    let active: Vec<_> = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.lifecycle == SessionLifecycle::Ready)
        .collect();
    // Behavior is captured before exact retirement of this fixture only.
    let mut active_namespaces = Vec::new();
    for descriptor in &active {
        let session = catalog
            .open(&SessionSelector::new(
                &descriptor.session_id,
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap();
        active_namespaces.push(session.discovery_root().unwrap().to_path_buf());
        terminate(
            session.discovery_root().unwrap(),
            &descriptor.session_id,
            &descriptor.workspace_id,
        );
    }
    if !competing_caller {
        assert!(
            output.status.success(),
            "pending operation did not resume: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let (completed, compacted) = replays.unwrap();
        assert!(
            completed.status.success(),
            "completed replay: {}",
            String::from_utf8_lossy(&completed.stderr)
        );
        assert!(
            compacted.status.success(),
            "compacted replay: {}",
            String::from_utf8_lossy(&compacted.stderr)
        );
        assert_eq!(provider, LocalProcessGenerationStatus::Absent);
        assert_eq!(launches, 2);
        assert!(competing.is_none());
        assert_eq!(active.len(), 1);
        assert_eq!(active_namespaces, vec![first_root]);
        return;
    }
    assert!(
        !output.status.success(),
        "the second namespace replaced a source still owned by {first_action}; provider={provider:?}, starts={launches}"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("hmux_recovery_source_busy:"),
        "unexpected refusal: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(provider, LocalProcessGenerationStatus::Live);
    assert_eq!(launches, 1);
    assert!(competing.is_none());
    assert_eq!(active.len(), 1);
    assert!(active[0].same_generation(source.descriptor()));
}
