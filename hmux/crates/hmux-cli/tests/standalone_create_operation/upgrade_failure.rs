use super::*;
use std::os::unix::fs::PermissionsExt;

#[test]
#[ignore = "requires a second real runtime build and the isolated process guardian"]
fn failed_upgrade_reports_its_saved_operation_and_retries_the_same_launch() {
    let root = upgrade::isolated_upgrade_root();
    let discovery = root.join("discovery");
    let original = run(
        &discovery,
        &root,
        &Request::new(
            request_fingerprint(&["upgrade-failure-source"]),
            "upgrade-failure",
            fixture_provider_command(),
            24,
            80,
        )
        .unwrap(),
    );
    let (session_id, workspace_id) = created_identity(&original);
    let catalog = LocalSessionCatalog::new(&discovery);
    let source = catalog
        .open(&SessionSelector::new(session_id, Some(workspace_id.into())))
        .unwrap();
    await_marker(&fixture_provider_marker(&root));
    let runtime = upgrade::replacement_runtime();
    let launcher = root.join("selected-runtime");
    let quoted_runtime = format!("'{}'", runtime.to_str().unwrap().replace('\'', "'\\''"));
    fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nif [ \"$2\" = hmux-build-info ]; then exec {quoted_runtime} \"$@\"; fi\ncat >/dev/null\nexit 73\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
    let operation_id = "reported-upgrade-failure";
    let failed = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&discovery)
        .args([
            "--json",
            "upgrade",
            session_id,
            "--confirm-restart",
            "--operation-id",
        ])
        .arg(operation_id)
        .arg("--runtime")
        .arg(&launcher)
        .current_dir(&root)
        .output()
        .unwrap();
    let failure_receipt = serde_json::from_slice::<serde_json::Value>(&failed.stdout);
    let source_after_failure =
        probe_local_process_generation(&source.descriptor().provider_process).unwrap();
    let starts_after_failure = fs::read_to_string(fixture_provider_marker(&root))
        .unwrap()
        .lines()
        .count();

    // Restore this fixture's exact selected build. Retry uses the saved launch,
    // without the original source, new runtime hints or another confirmation.
    fs::write(
        &launcher,
        format!("#!/bin/sh\nexec {quoted_runtime} \"$@\"\n"),
    )
    .unwrap();
    let replay = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&discovery)
        .args([
            "--json",
            "upgrade",
            "source-no-longer-required",
            "--operation-id",
        ])
        .arg(operation_id)
        .current_dir(&root)
        .output()
        .unwrap();
    if replay.status.success() {
        await_marker_lines(&fixture_provider_marker(&root), 2);
    }
    let starts = fs::read_to_string(fixture_provider_marker(&root))
        .unwrap()
        .lines()
        .count();
    for descriptor in catalog.list().unwrap() {
        if descriptor.lifecycle == hmux_client::SessionLifecycle::Ready {
            terminate(&discovery, &descriptor.session_id, &descriptor.workspace_id);
        }
    }

    assert!(!failed.status.success());
    assert_eq!(source_after_failure, LocalProcessGenerationStatus::Absent);
    assert_eq!(starts_after_failure, 1);
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    assert_eq!(starts, 2);
    let receipt = failure_receipt.expect("--json must retain its structured post-stop failure");
    assert_eq!(receipt["ok"], false);
    assert_eq!(receipt["outcome"], "source_terminated_replacement_failed");
    assert_eq!(receipt["sourceSessionId"], session_id);
    assert_eq!(receipt["sourceWorkspaceId"], workspace_id);
    assert_eq!(receipt["operationId"], operation_id);
    assert_eq!(receipt["reason"], "hmux_standalone_runtime_failed");
    assert_eq!(receipt["targetBuildId"], upgrade::build_id(&runtime));
}
