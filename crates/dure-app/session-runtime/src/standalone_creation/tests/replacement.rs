use super::*;
use hmux_client::PresentationCheckpointPredecessor;

mod conversion;
mod cross_root_upgrade;
mod pending_upgrade_close;
mod upgrade_close;

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn unbound_recovery_claim_blocks_removal_until_its_exact_retirement() {
    let fixture = Fixture::new().await;
    let request = legacy_recovery(&fixture).await;
    let replacement = fixture
        .runtime
        .create_standalone_replacement(None, request, None)
        .await
        .unwrap();
    let observation = (fixture.claims(), fixture.removal("remove-recovered"));
    // Retire only this fixture's actual target even on the RED path.
    retention::close(&fixture.runtime.store, &fixture, &replacement).await;
    fixture.runtime.store.close().await;
    assert_eq!(observation, (1, Err("checkout_use_in_use")));
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn unbound_recovery_respects_a_prior_removal_permit_before_provider_launch() {
    let fixture = Fixture::new().await;
    let request = legacy_recovery(&fixture).await;
    let permit = GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: fixture.registration.repository_path.clone(),
            instance: fixture.registration.instance.clone(),
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("prior-removal").unwrap(),
    )
    .unwrap()
    .admit()
    .unwrap();
    let result = fixture
        .runtime
        .create_standalone_replacement(None, request.clone(), None)
        .await;
    let started = fixture.checkout.parent().unwrap().join("provider-starts");
    if result.is_ok() {
        wait_for_starts(&started, 2).await;
    }
    let starts = std::fs::read_to_string(&started).unwrap().lines().count();
    let launched = result.is_ok();
    permit.abort().unwrap();
    if let Ok(created) = result {
        retention::close(&fixture.runtime.store, &fixture, &created).await;
    }
    assert_eq!((launched, starts), (false, 1));

    // Aborting the permit permits the same frozen intent, not a new identity.
    let replacement = fixture
        .runtime
        .create_standalone_replacement(None, request, None)
        .await
        .unwrap();
    assert_eq!(fixture.claims(), 1);
    wait_for_starts(&started, 2).await;
    assert_eq!(std::fs::read_to_string(started).unwrap().lines().count(), 2);
    retention::close(&fixture.runtime.store, &fixture, &replacement).await;
    fixture.runtime.store.close().await;
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn unbound_recovery_retains_its_claim_across_failed_launch_and_sql_reconnect() {
    let fixture = Fixture::new().await;
    let request = legacy_recovery(&fixture).await;
    let unavailable = CheckoutSessionRuntime::at_root(
        fixture.runtime.store.clone(),
        fixture.database.parent().unwrap().join("missing-runtime"),
        fixture.discovery.clone(),
    )
    .unwrap();
    let error = unavailable
        .create_standalone_replacement(None, request.clone(), None)
        .await
        .unwrap_err();
    assert!(matches!(error, SessionCheckoutError::Runtime(_)));
    let before = fixture.record().await;
    assert_eq!(
        fixture.removal("remove-before-retry"),
        Err("checkout_use_in_use")
    );
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let runtime = CheckoutSessionRuntime::at_root(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap();
    let created = runtime
        .create_standalone_replacement(None, request.clone(), None)
        .await
        .unwrap();
    let after = store
        .session_checkout_registration(&before.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.binding, before.binding);
    assert!(after.close_payload.is_some());
    let target = CompletedStandaloneTarget::from_recovery_checkpoint(
        &LocalSessionCatalog::new(&fixture.discovery),
        &request,
        &serde_json::to_string(created.receipt()).unwrap(),
    )
    .unwrap();
    let replayed = CreatedStandaloneSession::from_completed_target(&target).unwrap();
    assert_eq!(
        replayed.session().descriptor(),
        created.session().descriptor()
    );
    assert_eq!(fixture.claims(), 1);
    retention::close(&store, &fixture, &replayed).await;
    store.close().await;
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn upgrade_admission_preserves_its_live_source_when_removal_won_first() {
    use hmux_client::{LocalProcessGenerationStatus, probe_local_process_generation};
    let fixture = Fixture::new().await;
    let (original, request) = legacy_replacement(&fixture).await;
    let retirement = crate::StandaloneReplacementSource::from_session(original.session()).unwrap();
    let permit = GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: fixture.registration.repository_path.clone(),
            instance: fixture.registration.instance.clone(),
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("remove-before-upgrade").unwrap(),
    )
    .unwrap()
    .admit()
    .unwrap();
    let result = fixture
        .runtime
        .create_standalone_replacement(None, request.clone(), Some(retirement.clone()))
        .await;
    let source = original.session().descriptor();
    let observation = (
        result.is_ok(),
        probe_local_process_generation(&source.host_process).unwrap(),
        probe_local_process_generation(&source.provider_process).unwrap(),
    );
    let expected = (
        false,
        LocalProcessGenerationStatus::Live,
        LocalProcessGenerationStatus::Live,
    );
    permit.abort().unwrap();
    if observation != expected {
        retention::close(&fixture.runtime.store, &fixture, &original).await;
        if let Ok(created) = result {
            retention::close(&fixture.runtime.store, &fixture, &created).await;
        }
    }
    assert_eq!(observation, expected);

    let created = fixture
        .runtime
        .create_standalone_replacement(None, request, Some(retirement))
        .await
        .unwrap();
    assert_eq!(
        probe_local_process_generation(&source.provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    assert_eq!(fixture.claims(), 1);
    retention::close(&fixture.runtime.store, &fixture, &created).await;
    fixture.runtime.store.close().await;
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn upgrade_replays_its_prepared_source_after_stop_and_sql_reconnect() {
    use hmux_client::recovery_journal::{
        PreparedRecoveryIdentity, RecoveryCompletion, RecoveryReservationState, reserve_prepared,
        standalone_upgrade::{
            CURRENT_BUILD_ACTION, ObservedStandaloneUpgrade, PreparedStandaloneUpgrade,
            StandaloneUpgradeReplacement,
        },
    };
    use hmux_client::{LocalProcessGenerationStatus, probe_local_process_generation};

    let fixture = Fixture::new().await;
    let (original, request) = legacy_replacement(&fixture).await;
    let source = crate::StandaloneReplacementSource::from_session(original.session()).unwrap();
    let identity = PreparedRecoveryIdentity {
        recovery_id: "upgrade-with-launcher-loss".into(),
        source_session_id: original.session().descriptor().session_id.clone(),
        source_workspace_id: original.session().descriptor().workspace_id.clone(),
        action: CURRENT_BUILD_ACTION,
        legacy_request_fingerprint: None,
    };
    let prepared = PreparedStandaloneUpgrade {
        source: source.clone(),
        source_build_id: original.session().descriptor().host_build_version.clone(),
        target_build_id: original.session().descriptor().host_build_version.clone(),
        replacement: Some(StandaloneUpgradeReplacement {
            discovery_root: None,
            create: request.clone(),
            context: std::collections::BTreeMap::from([(
                "checkout".to_string(),
                serde_json::Value::Null,
            )]),
        }),
    };
    let RecoveryReservationState::Pending(reservation) = reserve_prepared(
        &fixture.discovery,
        identity.clone(),
        Some(serde_json::to_string(&prepared).unwrap()),
    )
    .unwrap() else {
        panic!("new upgrade must be pending");
    };
    let unavailable = CheckoutSessionRuntime::at_root(
        fixture.runtime.store.clone(),
        fixture.database.parent().unwrap().join("missing-runtime"),
        fixture.discovery.clone(),
    )
    .unwrap();
    let error = unavailable
        .create_standalone_replacement(None, request, Some(source))
        .await
        .unwrap_err();
    assert!(matches!(error, SessionCheckoutError::Runtime(_)));
    assert_eq!(
        probe_local_process_generation(&original.session().descriptor().provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    let before = fixture.record().await;
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture.removal("remove-stopped-upgrade"),
        Err("checkout_use_in_use")
    );
    drop(reservation);
    fixture.runtime.store.close().await;

    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let runtime = CheckoutSessionRuntime::at_root(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap();
    let RecoveryReservationState::Pending(mut reservation) =
        reserve_prepared(&fixture.discovery, identity, None).unwrap()
    else {
        panic!("lost launcher result must leave the same pending upgrade");
    };
    let prepared =
        ObservedStandaloneUpgrade::read(reservation.operation_checkpoint().unwrap()).unwrap();
    let replacement = runtime
        .create_standalone_replacement(
            None,
            prepared.replacement.unwrap().create,
            Some(prepared.source),
        )
        .await
        .unwrap();
    let after = store
        .session_checkout_registration(&before.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.binding, before.binding);
    assert_eq!(fixture.claims(), 1);
    let target = replacement.session().descriptor();
    let completed =
        CompletedStandaloneTarget::from_created(replacement.receipt().clone(), target).unwrap();
    reservation
        .checkpoint_replacement_receipt(serde_json::to_string(&completed).unwrap())
        .unwrap();
    reservation
        .complete(RecoveryCompletion {
            target_session_id: target.session_id.clone(),
            target_workspace_id: target.workspace_id.clone(),
            target_build_id: target.host_build_version.clone(),
            action: CURRENT_BUILD_ACTION.into(),
            outcome: "rehosted".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    let started = fixture.checkout.parent().unwrap().join("provider-starts");
    wait_for_starts(&started, 2).await;
    assert_eq!(std::fs::read_to_string(started).unwrap().lines().count(), 2);
    retention::close(&store, &fixture, &original).await;
    retention::close(&store, &fixture, &replacement).await;
    store.close().await;
    assert_eq!(fixture.claims(), 0);
}

async fn legacy_recovery(fixture: &Fixture) -> StandaloneCreateRequest {
    let (original, request) = legacy_replacement(fixture).await;
    retention::close(&fixture.runtime.store, fixture, &original).await;
    assert_eq!(fixture.claims(), 0);
    request
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn bound_upgrade_preserves_one_claim_after_delayed_source_close_and_reconnect() {
    use hmux_client::{LocalProcessGenerationStatus, probe_local_process_generation};

    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    let binding = fixture
        .runtime
        .checkout_for_session(original.session().clone())
        .await
        .unwrap()
        .unwrap();
    let source = original.session().descriptor();
    let predecessor = PresentationCheckpointPredecessor::new(
        &source.session_id,
        &source.runner_principal,
        &source.runner_instance,
        source.channel_epoch.parse().unwrap(),
        &source.host_instance_id,
        &source.terminal_epoch,
    )
    .unwrap();
    let request = fixture
        .request()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new("standalone_bound_upgrade", "bound-proof")
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
                .with_source_predecessor(predecessor)
                .unwrap(),
        )
        .unwrap();
    let replacement = fixture
        .runtime
        .create_standalone_replacement(
            Some(binding),
            request,
            Some(crate::StandaloneReplacementSource::from_session(original.session()).unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(
        probe_local_process_generation(&source.provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent,
    );
    let after = fixture.record().await;
    assert_eq!(after.binding.claim_id, before.binding.claim_id);
    assert_ne!(after.binding.identity, before.binding.identity);
    assert_eq!(fixture.claims(), 1);

    // This is the normal public close path using the old pane's exact source,
    // not a direct SQL cleanup call. It must not release the transferred claim.
    retention::close(&fixture.runtime.store, &fixture, &original).await;
    assert_eq!(fixture.record().await, after);
    assert_eq!(
        fixture.removal("remove-after-old-pane-close"),
        Err("checkout_use_in_use")
    );
    assert_eq!(
        probe_local_process_generation(&replacement.session().descriptor().provider_process)
            .unwrap(),
        LocalProcessGenerationStatus::Live,
    );
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    retention::close(&store, &fixture, &replacement).await;
    store.close().await;
    assert_eq!(fixture.claims(), 0);
    assert_eq!(fixture.removal("remove-after-upgrade-close"), Ok(()));
}

async fn legacy_replacement(
    fixture: &Fixture,
) -> (CreatedStandaloneSession, StandaloneCreateRequest) {
    let started = fixture.checkout.parent().unwrap().join("provider-starts");
    let request = StandaloneCreateRequest::new(
        &fixture.checkout,
        Some("legacy-recovery".into()),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'started\\n' >> \"$1\"; while IFS= read -r line; do :; done".into(),
            "legacy-provider".into(),
            started.to_str().unwrap().into(),
        ],
        24,
        80,
    )
    .unwrap();
    let original = fixture
        .runtime
        .standalone_creator
        .create(request.clone())
        .unwrap();
    wait_for_starts(&started, 1).await;
    assert!(
        fixture
            .runtime
            .checkout_for_session(original.session().clone())
            .await
            .unwrap()
            .is_none()
    );
    let source = original.session().descriptor();
    let predecessor = PresentationCheckpointPredecessor::new(
        &source.session_id,
        &source.runner_principal,
        &source.runner_instance,
        source.channel_epoch.parse().unwrap(),
        &source.host_instance_id,
        &source.terminal_epoch,
    )
    .unwrap();
    let replacement = request
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new("standalone_recovered", "recovery-proof")
                .unwrap()
                .with_source_predecessor(predecessor)
                .unwrap(),
        )
        .unwrap();
    (original, replacement)
}

async fn wait_for_starts(path: &Path, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if std::fs::read_to_string(path).is_ok_and(|text| text.lines().count() == expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "provider did not publish its start"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
