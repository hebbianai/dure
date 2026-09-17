use super::*;
use hmux_client::{
    CompletedStandaloneTarget, CompletedStandaloneTargetLifecycle, CreatedStandaloneSession,
    SessionLifecycle, SessionRetirementReceiptState, standalone_create_idempotency_key,
};

#[test]
fn lost_create_response_reuses_live_target_but_never_restarts_its_archived_generation() {
    let cwd = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(cwd.starts_with(&guardian) && cwd != guardian);
    let discovery = cwd.join("discovery");
    let catalog = LocalSessionCatalog::new(&discovery);
    let creator =
        StandaloneSessionCreator::new(runtime_executable()).with_discovery_root(&discovery);
    let request_for = |proof: &str| {
        StandaloneCreateRequest::new(
            cwd.clone(),
            Some("lost-response".into()),
            fixture_provider_command(),
            24,
            80,
        )
        .unwrap()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new("standalone_lost_response", proof)
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
        )
        .unwrap()
    };
    let request = request_for("original-create-proof");
    let key = standalone_create_idempotency_key(request.recovery_identity().unwrap());
    let created = creator.create(request.clone()).unwrap();
    await_marker(&fixture_provider_marker(&cwd));
    let original = created.session().descriptor().clone();
    let selector = SessionSelector::new(&original.session_id, Some(original.workspace_id.clone()));
    // The caller retained only the submitted request, not the creation result.
    let replayed = creator.create(request.clone()).unwrap();
    assert_eq!(replayed.receipt(), created.receipt());
    assert_eq!(replayed.session().descriptor(), &original);
    assert_eq!(
        catalog
            .find_creation(&original.workspace_id, &original.session_id, &key)
            .unwrap()
            .unwrap()
            .descriptor(),
        &original
    );
    drop(replayed);
    retire_unpresented(&catalog, &created);
    assert!(catalog.open(&selector).unwrap_err().is_session_absent());
    let retry = creator.create(request.clone()).unwrap_err();
    assert_eq!(retry.code(), "hmux_standalone_recovery_target_exited");
    assert_eq!(
        fs::read_to_string(fixture_provider_marker(&cwd))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let archived = catalog
        .find_creation(&original.workspace_id, &original.session_id, &key)
        .unwrap()
        .unwrap();
    assert_eq!(archived.descriptor().lifecycle, SessionLifecycle::Exited);
    assert!(archived.descriptor().same_generation(&original));

    // A genuinely new request is permitted; the old key must not adopt it.
    let successor = creator
        .create(request_for("successor-create-proof"))
        .unwrap();
    await_marker_lines(&fixture_provider_marker(&cwd), 2);
    assert!(!successor.session().descriptor().same_generation(&original));
    assert_eq!(
        catalog
            .find_creation(&original.workspace_id, &original.session_id, &key)
            .unwrap()
            .unwrap()
            .descriptor(),
        archived.descriptor()
    );
    assert_eq!(
        catalog.open(&selector).unwrap().descriptor(),
        successor.session().descriptor()
    );
    assert_eq!(
        creator.create(request).unwrap_err().code(),
        "hmux_standalone_recovery_identity_conflict"
    );
    assert_eq!(
        probe_local_process_generation(&successor.session().descriptor().provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    retire_unpresented(&catalog, &successor);
    assert_eq!(
        fs::read_to_string(fixture_provider_marker(&cwd))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

fn retire_unpresented(catalog: &LocalSessionCatalog, created: &CreatedStandaloneSession) {
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let lifecycle = catalog
            .resolve_completed_standalone_target(target.generation(), target.provider_process());
        if lifecycle == CompletedStandaloneTargetLifecycle::Retired {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "target did not retire: {lifecycle:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
