use super::*;

#[test]
fn refused_creation_survives_gc_then_acknowledges_without_reviving_its_operation() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let root = cwd.join("discovery");
    let name = "refused-creation-gc";
    let blocker = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&root)
        .create(
            StandaloneCreateRequest::new(
                &cwd,
                Some(name.into()),
                fixture_provider_command(),
                24,
                80,
            )
            .unwrap()
            .with_recovery_identity(
                StandaloneRecoveryCreateIdentity::new("standalone_blocker", "blocker-proof")
                    .unwrap()
                    .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
            )
            .unwrap(),
        )
        .unwrap();
    let marker = fixture_provider_marker(&cwd);
    await_marker(&marker);
    let request = Request::new("a".repeat(64), name, fixture_provider_command(), 24, 80).unwrap();
    let refused = run(&root, &cwd, &request);
    assert!(matches!(
        refused,
        Response::Refused { ref error_code, .. }
            if error_code == "hmux_standalone_recovery_name_conflict"
    ));
    terminate(
        &root,
        blocker.receipt().session_id(),
        blocker.receipt().workspace_id(),
    );
    let gc = recovery_journal::garbage_collect_completed(
        &root,
        recovery_journal::RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..recovery_journal::RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(gc.removed_completed_records, 0);
    assert_eq!(run(&root, &cwd, &request), refused);
    assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);

    let acknowledgement = acknowledge_retired_target(&request);
    assert!(matches!(
        run(&root, &cwd, &acknowledgement),
        Response::Acknowledged { .. }
    ));
    assert!(matches!(
        run(&root, &cwd, &acknowledgement),
        Response::Acknowledged { .. }
    ));
    assert_eq!(
        recovery_journal::inspect_existing(&root)
            .unwrap()
            .operation_records,
        0
    );
    assert!(matches!(
        run(&root, &cwd, &request),
        Response::Refused { ref error_code, .. }
            if error_code == recovery_journal::RECOVERY_COMPLETION_ACKNOWLEDGED_CODE
    ));
    assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);
    let successor = Request::new("b".repeat(64), name, fixture_provider_command(), 24, 80).unwrap();
    let created = run(&root, &cwd, &successor);
    let (session, workspace) = created_identity(&created);
    await_marker_lines(&marker, 2);
    assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 2);
    terminate(&root, session, workspace);
}
