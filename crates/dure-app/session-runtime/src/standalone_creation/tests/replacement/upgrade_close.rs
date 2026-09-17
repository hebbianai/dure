use super::*;
use hmux_client::{
    LocalProcessGenerationStatus, LocalSession, StandaloneReplacementSource,
    probe_local_process_generation,
    recovery_journal::{
        self as journal, PreparedRecoveryIdentity, RecoveryCompletion, RecoveryJournalGcPolicy,
        RecoveryReservationState,
        standalone_upgrade::{
            PreparedStandaloneUpgrade, SELECTED_BUILD_ACTION, StandaloneUpgradeReplacement,
        },
    },
};

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn admitted_close_retires_a_later_upgrade_after_compaction_and_store_reopen() {
    assert_close_order(1, true).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn admitted_close_retires_two_successors_in_one_call() {
    assert_close_order(2, true).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn a_completed_upgrade_preserves_its_target_when_the_old_pane_closes() {
    assert_close_order(1, false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn delayed_owner_handoff_reaches_the_live_tip_in_one_call() {
    assert_close_order(2, false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn passive_removal_reconciliation_never_stops_a_closing_owners_live_successor() {
    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    let closing = fixture
        .runtime
        .store
        .begin_session_checkout_claim_close(&before.binding.identity, &before.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    let replacement = upgrade_without_product_handoff(&fixture, original.session(), 0);
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    let source = StandaloneReplacementSource::from_session(original.session()).unwrap();
    assert_eq!(
        catalog.retire_completed_standalone_target(
            source.generation(),
            source.provider_process(),
            Duration::from_secs(3)
        ),
        CompletedStandaloneTargetLifecycle::Retired,
    );
    let result = crate::reconcile_checkout_users(
        fixture.runtime.store.clone(),
        fixture
            .database
            .parent()
            .unwrap()
            .join("unavailable-launcher"),
        fixture.discovery.clone(),
        fixture.registration.clone(),
    )
    .await;
    let provider =
        probe_local_process_generation(&replacement.session().descriptor().provider_process)
            .unwrap();
    let after = fixture.record().await;
    let removal = fixture.removal("passive-after-upgrade");
    retention::close(&fixture.runtime.store, &fixture, &original).await;
    fixture.runtime.store.close().await;

    result.unwrap();
    assert_eq!(provider, LocalProcessGenerationStatus::Live);
    assert_eq!(after, closing);
    assert_eq!(removal, Err("checkout_use_in_use"));
    assert_eq!(
        fixture.claims(),
        0,
        "explicit close still completes the retained owner"
    );
}

async fn assert_close_order(hops: usize, close_first: bool) {
    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    if close_first {
        let closing = fixture
            .runtime
            .store
            .begin_session_checkout_claim_close(&before.binding.identity, &before.binding.claim_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closing.admission, SessionCheckoutAdmissionV1::Closing);
    }
    let mut source = original.session().clone();
    let mut replacements = Vec::new();
    for step in 0..hops {
        // Exercise a neutral runtime writer independently of the app's SQL
        // projection, as a CLI upgrade can do while its owning app is absent.
        let replacement = upgrade_without_product_handoff(&fixture, &source, step);
        source = replacement.session().clone();
        replacements.push(replacement);
    }
    let collected = journal::garbage_collect_completed(
        &fixture.discovery,
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(collected.removed_completed_records, hops);
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    let descriptor = original.session().descriptor();
    let result = crate::close_standalone_session(
        store.clone(),
        catalog.clone(),
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await;
    let provider = probe_local_process_generation(&source.descriptor().provider_process).unwrap();
    let claims = fixture.claims();
    let after = store
        .session_checkout_registration(&before.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    let removal = fixture.removal("after-close-upgrade-race");

    // Record every product observation before exact native cleanup. RED must
    // not leave a live fixture provider, and cleanup cannot manufacture GREEN.
    for created in replacements.iter().rev().chain(std::iter::once(&original)) {
        let target = CompletedStandaloneTarget::from_created(
            created.receipt().clone(),
            created.session().descriptor(),
        )
        .unwrap();
        assert_eq!(
            catalog.retire_completed_standalone_target(
                target.generation(),
                target.provider_process(),
                Duration::from_secs(3),
            ),
            CompletedStandaloneTargetLifecycle::Retired,
        );
    }
    for created in std::iter::once(&original).chain(replacements.iter()) {
        retention::close(&store, &fixture, created).await;
    }
    store.close().await;

    assert!(
        result.is_ok(),
        "close did not finish its admitted runtime chain: {result:?}"
    );
    assert_eq!(after.binding.claim_id, before.binding.claim_id);
    if close_first {
        assert_eq!(provider, LocalProcessGenerationStatus::Absent);
        assert_eq!(claims, 0);
        assert_eq!(after.admission, SessionCheckoutAdmissionV1::Closed);
        assert_eq!(
            after.binding, before.binding,
            "closing must never transfer or reopen ownership"
        );
        assert_eq!(removal, Ok(()));
    } else {
        assert_eq!(provider, LocalProcessGenerationStatus::Live);
        assert_eq!(claims, 1);
        assert_eq!(after.admission, SessionCheckoutAdmissionV1::Open);
        assert_eq!(
            after.binding.identity,
            crate::standalone::standalone_identity(
                &before.binding.identity.runtime_namespace,
                source.create_idempotency_key().unwrap(),
                &source.descriptor().session_id,
                &source.descriptor().workspace_id,
            )
        );
        assert_eq!(removal, Err("checkout_use_in_use"));
    }
}

fn upgrade_without_product_handoff(
    fixture: &Fixture,
    session: &LocalSession,
    step: usize,
) -> CreatedStandaloneSession {
    let (source, create, mut operation) = prepare_upgrade(fixture, session, step);
    let _source_lock = source.lock().unwrap();
    source.stop(Duration::from_secs(3)).unwrap();
    let created = fixture.runtime.standalone_creator.create(create).unwrap();
    complete_upgrade(&mut operation, &created);
    created
}

pub(super) fn prepare_upgrade(
    fixture: &Fixture,
    session: &LocalSession,
    step: usize,
) -> (
    StandaloneReplacementSource,
    StandaloneCreateRequest,
    journal::RecoveryReservation,
) {
    prepare_upgrade_variant(fixture, session, step, false, &fixture.discovery)
}

pub(super) fn prepare_bound_upgrade(
    fixture: &Fixture,
    session: &LocalSession,
    step: usize,
) -> (
    StandaloneReplacementSource,
    StandaloneCreateRequest,
    journal::RecoveryReservation,
) {
    prepare_bound_upgrade_at(fixture, session, step, &fixture.discovery)
}

pub(super) fn prepare_bound_upgrade_at(
    fixture: &Fixture,
    session: &LocalSession,
    step: usize,
    target_root: &Path,
) -> (
    StandaloneReplacementSource,
    StandaloneCreateRequest,
    journal::RecoveryReservation,
) {
    prepare_upgrade_variant(fixture, session, step, true, target_root)
}

fn prepare_upgrade_variant(
    fixture: &Fixture,
    session: &LocalSession,
    step: usize,
    operation_bound: bool,
    target_root: &Path,
) -> (
    StandaloneReplacementSource,
    StandaloneCreateRequest,
    journal::RecoveryReservation,
) {
    let source = StandaloneReplacementSource::from_session(session).unwrap();
    let _source_lock = source.lock().unwrap();
    let create = fixture
        .request()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new(
                format!("standalone_close_race_{step}"),
                format!("proof-{step}"),
            )
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
            .with_source_predecessor(source.presentation_predecessor().unwrap())
            .unwrap(),
        )
        .unwrap();
    let operation_id = format!("close-race-upgrade-{step}");
    let create = if operation_bound {
        if target_root == source.discovery_root() {
            create.with_recovery_operation_id(&operation_id).unwrap()
        } else {
            create
                .with_recovery_operation_at(&operation_id, source.discovery_root())
                .unwrap()
        }
    } else {
        create
    };
    let prepared = PreparedStandaloneUpgrade {
        source: source.clone(),
        source_build_id: session.descriptor().host_build_version.clone(),
        target_build_id: session.descriptor().host_build_version.clone(),
        replacement: Some(StandaloneUpgradeReplacement {
            discovery_root: None,
            create: create.clone(),
            context: std::collections::BTreeMap::from([(
                "runtime".to_string(),
                fixture.executable.clone(),
            )]),
        }),
    };
    let RecoveryReservationState::Pending(operation) = journal::reserve_prepared(
        target_root,
        PreparedRecoveryIdentity {
            recovery_id: operation_id,
            source_session_id: session.descriptor().session_id.clone(),
            source_workspace_id: session.descriptor().workspace_id.clone(),
            action: SELECTED_BUILD_ACTION,
            legacy_request_fingerprint: None,
        },
        Some(serde_json::to_string(&prepared).unwrap()),
    )
    .unwrap() else {
        panic!("fresh fixture upgrade must be pending")
    };
    (source, create, operation)
}

pub(super) fn complete_upgrade(
    operation: &mut journal::RecoveryReservation,
    created: &CreatedStandaloneSession,
) {
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    operation
        .checkpoint_replacement_receipt(serde_json::to_string(&target).unwrap())
        .unwrap();
    operation
        .complete(RecoveryCompletion {
            target_session_id: target.receipt().session_id().into(),
            target_workspace_id: target.receipt().workspace_id().into(),
            target_build_id: target.host_build_version().into(),
            action: SELECTED_BUILD_ACTION.into(),
            outcome: "rehosted".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
}
