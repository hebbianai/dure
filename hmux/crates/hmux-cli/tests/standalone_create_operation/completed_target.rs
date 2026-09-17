use super::*;
use hmux_client::{
    CompletedStandaloneTarget, CompletedStandaloneTargetLifecycle, CreatedStandaloneSession,
    standalone_create_idempotency_key,
};

#[test]
fn saved_target_reopens_one_generation_and_retires_without_recreating_it() {
    // Retain this fixture until the outer guardian has reconciled its processes,
    // including when an assertion fails before explicit retirement.
    let cwd = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(cwd.starts_with(&guardian) && cwd != guardian);
    let discovery = cwd.join("discovery");
    let identity =
        StandaloneRecoveryCreateIdentity::new("standalone_saved_target", "saved-target-proof")
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound);
    let key = standalone_create_idempotency_key(&identity);
    let request = StandaloneCreateRequest::new(
        cwd.clone(),
        Some("saved-target".into()),
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_recovery_identity(identity)
    .unwrap();
    let created = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&discovery)
        .create(request.clone())
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    assert_eq!(
        created.session().create_idempotency_key(),
        Some(key.as_str())
    );
    await_marker(&fixture_provider_marker(&cwd));
    let saved =
        CompletedStandaloneTarget::from_created(created.receipt().clone(), &descriptor).unwrap();
    let saved: CompletedStandaloneTarget =
        serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap();
    drop(created);

    let reopened = CreatedStandaloneSession::from_completed_target(&saved).unwrap();
    let current = reopened.session().descriptor();
    assert!(current.same_generation(&descriptor));
    assert_eq!(current.host_process, descriptor.host_process);
    assert_eq!(current.provider_process, descriptor.provider_process);
    assert_eq!(reopened.receipt(), saved.receipt());
    let catalog = LocalSessionCatalog::new(&discovery);
    for checkpoint in [
        serde_json::to_string(&saved).unwrap(),
        serde_json::to_string(saved.receipt()).unwrap(),
    ] {
        let decoded =
            CompletedStandaloneTarget::from_recovery_checkpoint(&catalog, &request, &checkpoint)
                .unwrap();
        assert_eq!(decoded, saved);
        assert_eq!(
            CreatedStandaloneSession::from_completed_target(&decoded)
                .unwrap()
                .session()
                .descriptor(),
            &descriptor
        );
    }
    let other_identity =
        StandaloneRecoveryCreateIdentity::new("standalone_saved_target", "different-proof")
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound);
    let wrong_request = request
        .clone()
        .with_recovery_identity(other_identity)
        .unwrap();
    let mut wrong_receipt = serde_json::to_value(saved.receipt()).unwrap();
    wrong_receipt["launchOwnerProof"] = "different-proof".into();
    let wrong_receipt = serde_json::to_string(&wrong_receipt).unwrap();
    assert!(
        CompletedStandaloneTarget::from_recovery_checkpoint(
            &catalog,
            &wrong_request,
            &wrong_receipt,
        )
        .is_err()
    );
    let mut wrong = serde_json::to_value(&saved).unwrap();
    wrong["generation"]["fence"]["terminalEpoch"] = "different-terminal".into();
    let wrong: CompletedStandaloneTarget = serde_json::from_value(wrong).unwrap();
    assert!(CreatedStandaloneSession::from_completed_target(&wrong).is_err());
    assert_eq!(
        catalog.retire_completed_standalone_target(
            wrong.generation(),
            wrong.provider_process(),
            Duration::from_secs(3),
        ),
        CompletedStandaloneTargetLifecycle::Unresolved
    );
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    drop(reopened);

    let identity = recovery_journal::PreparedRecoveryIdentity {
        recovery_id: "saved-source-stop".into(),
        source_session_id: descriptor.session_id.clone(),
        source_workspace_id: descriptor.workspace_id.clone(),
        action: "stop_fixture_source",
        legacy_request_fingerprint: None,
    };
    let RecoveryReservationState::Pending(mut reservation) = recovery_journal::reserve_prepared(
        &discovery,
        identity,
        Some(serde_json::to_string(&saved).unwrap()),
    )
    .unwrap() else {
        panic!("source-stop fixture must prepare its own journal");
    };
    let source_lock =
        recovery_journal::lock_source(&discovery, &descriptor.workspace_id, &descriptor.session_id)
            .unwrap();
    assert!(
        catalog
            .stop_completed_standalone_target(
                wrong.generation(),
                wrong.provider_process(),
                Duration::from_secs(3),
            )
            .is_err()
    );
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
    );
    catalog
        .stop_completed_standalone_target(
            saved.generation(),
            saved.provider_process(),
            Duration::from_secs(3),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while probe_local_process_generation(&descriptor.host_process).unwrap()
        == LocalProcessGenerationStatus::Live
    {
        assert!(Instant::now() < deadline, "exact source Host did not drain");
        thread::sleep(Duration::from_millis(20));
    }
    // Reopen only the persisted input. The Host may have removed its pointer;
    // the pending source lock and journal must not prevent stop replay.
    let source: CompletedStandaloneTarget = serde_json::from_str(
        &reservation
            .operation_checkpoint()
            .unwrap()
            .canonical_payload,
    )
    .unwrap();
    LocalSessionCatalog::new(&discovery)
        .stop_completed_standalone_target(
            source.generation(),
            source.provider_process(),
            Duration::from_secs(3),
        )
        .unwrap();
    assert!(
        recovery_journal::inspect(&discovery)
            .unwrap()
            .pending_sources
            .iter()
            .any(|source| {
                source.workspace_id == descriptor.workspace_id
                    && source.session_id == descriptor.session_id
            })
    );
    drop(source_lock);
    reservation
        .complete(recovery_journal::RecoveryCompletion {
            target_session_id: descriptor.session_id.clone(),
            target_workspace_id: descriptor.workspace_id.clone(),
            target_build_id: descriptor.host_build_version.clone(),
            action: "stop_fixture_source".into(),
            outcome: "stopped".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();

    for _ in 0..2 {
        assert_eq!(
            catalog.retire_completed_standalone_target(
                saved.generation(),
                saved.provider_process(),
                Duration::from_secs(3),
            ),
            CompletedStandaloneTargetLifecycle::Retired
        );
    }
    for process in [&descriptor.host_process, &descriptor.provider_process] {
        assert_eq!(
            probe_local_process_generation(process).unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }
    assert!(CreatedStandaloneSession::from_completed_target(&saved).is_err());
    assert_eq!(
        fs::read_to_string(fixture_provider_marker(&cwd))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
