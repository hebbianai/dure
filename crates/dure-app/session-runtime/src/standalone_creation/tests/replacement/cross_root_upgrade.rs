use super::upgrade_close::{complete_upgrade, prepare_bound_upgrade_at};
use super::*;
use hmux_client::{
    LocalProcessGenerationStatus, StandaloneSessionCreator, probe_local_process_generation,
    recovery_journal::{self as journal, RecoveryJournalGcPolicy},
};
use hmux_host::local_discovery::DiscoveryRoot;

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn old_compatibility_pane_close_transfers_its_claim_to_the_live_primary_target() {
    assert_cross_root_close(false, false, 1).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn admitted_compatibility_close_retires_its_replacement_in_the_primary_root() {
    assert_cross_root_close(true, false, 1).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn passive_compatibility_handoff_preserves_the_live_primary_target() {
    assert_cross_root_close(false, true, 1).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn passive_compatibility_handoff_never_stops_a_closing_owners_primary_target() {
    assert_cross_root_close(true, true, 1).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn old_pane_close_follows_two_successors_outside_its_configured_namespaces() {
    assert_cross_root_close(false, false, 2).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn admitted_close_retires_two_successors_outside_its_configured_namespaces() {
    assert_cross_root_close(true, false, 2).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn passive_handoff_follows_two_successors_outside_its_configured_namespaces() {
    assert_cross_root_close(false, true, 2).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn passive_handoff_keeps_a_closing_owners_unknown_tip_alive() {
    assert_cross_root_close(true, true, 2).await;
}

async fn assert_cross_root_close(close_first: bool, observe_only: bool, hops: usize) {
    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    let primary = fixture.database.parent().unwrap().join("primary-discovery");
    DiscoveryRoot::create(&primary).unwrap();
    let observer_root = if hops == 1 {
        primary.clone()
    } else {
        let root = fixture
            .database
            .parent()
            .unwrap()
            .join("observer-discovery");
        DiscoveryRoot::create(&root).unwrap();
        root
    };
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        &observer_root,
        vec![fixture.discovery.clone()],
    )
    .unwrap();
    if close_first {
        fixture
            .runtime
            .store
            .begin_session_checkout_claim_close(&before.binding.identity, &before.binding.claim_id)
            .await
            .unwrap()
            .unwrap();
    }
    let mut replacements = Vec::new();
    let mut source_session = original.session().clone();
    for step in 0..hops {
        let target_root = if step == 0 {
            primary.clone()
        } else {
            let root = fixture
                .database
                .parent()
                .unwrap()
                .join(format!("target-{step}"));
            DiscoveryRoot::create(&root).unwrap();
            root
        };
        let (source, request, mut operation) =
            prepare_bound_upgrade_at(&fixture, &source_session, step, &target_root);
        let source_lock = source.lock().unwrap();
        source.stop(Duration::from_secs(3)).unwrap();
        let replacement = StandaloneSessionCreator::new(&fixture.executable)
            .with_discovery_root(&target_root)
            .create(request)
            .unwrap();
        complete_upgrade(&mut operation, &replacement);
        drop(operation);
        drop(source_lock);
        assert_eq!(replacement.receipt().discovery_root(), target_root);
        // Only the source owns a mutable upgrade operation. The destination
        // retains immutable launch history for its own later upgrade.
        let collected = journal::garbage_collect_completed(
            source.discovery_root(),
            RecoveryJournalGcPolicy {
                minimum_completed_age: Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                ..RecoveryJournalGcPolicy::default()
            },
        )
        .unwrap();
        assert_eq!(collected.removed_completed_records, 1);
        if observe_only {
            // A stop acknowledgement can precede Host drain. Passive handoff is
            // tested after exact source retirement, not against an assumed exit.
            assert_eq!(
                LocalSessionCatalog::new(source.discovery_root())
                    .retire_completed_standalone_target(
                        source.generation(),
                        source.provider_process(),
                        Duration::from_secs(3),
                    ),
                CompletedStandaloneTargetLifecycle::Retired
            );
        }
        source_session = replacement.session().clone();
        replacements.push(replacement);
    }
    let replacement = replacements.last().unwrap();
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let current = store
        .session_checkout_registration(&before.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    let result = if observe_only {
        crate::standalone_close::resume_standalone_checkout_close(&store, &catalog, current.clone())
            .await
    } else {
        close(&store, &catalog, &original).await.map(|_| ())
    };
    let provider =
        probe_local_process_generation(&replacement.session().descriptor().provider_process)
            .unwrap();
    let claims = fixture.claims();
    let after = store
        .session_checkout_registration(&before.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    let removal = fixture.removal("after-cross-root-close");
    // Capture every behavioral observation before exact fixture cleanup. The
    // stale-pane RED may incorrectly retire the replacement and its claim.
    for created in replacements.iter().rev().chain(std::iter::once(&original)) {
        let target = CompletedStandaloneTarget::from_created(
            created.receipt().clone(),
            created.session().descriptor(),
        )
        .unwrap();
        assert_eq!(
            LocalSessionCatalog::new(created.receipt().discovery_root())
                .retire_completed_standalone_target(
                    target.generation(),
                    target.provider_process(),
                    Duration::from_secs(3),
                ),
            CompletedStandaloneTargetLifecycle::Retired
        );
    }
    for created in std::iter::once(&original).chain(replacements.iter()) {
        close(
            &store,
            &LocalSessionCatalog::new(created.receipt().discovery_root()),
            created,
        )
        .await
        .unwrap();
    }
    store.close().await;

    assert!(
        result.is_ok(),
        "cross-root close did not converge: {result:?}"
    );
    assert_eq!(after.binding.claim_id, before.binding.claim_id);
    if close_first && observe_only {
        assert_eq!(provider, LocalProcessGenerationStatus::Live);
        assert_eq!(claims, 1);
        assert_eq!(after, current);
        assert_eq!(after.admission, SessionCheckoutAdmissionV1::Closing);
        assert_eq!(removal, Err("checkout_use_in_use"));
    } else if close_first {
        assert_eq!(provider, LocalProcessGenerationStatus::Absent);
        assert_eq!(claims, 0);
        assert_eq!(after.admission, SessionCheckoutAdmissionV1::Closed);
        assert_eq!(after.binding, before.binding);
        assert_eq!(removal, Ok(()));
    } else {
        assert_eq!(provider, LocalProcessGenerationStatus::Live);
        assert_eq!(claims, 1);
        assert_eq!(after.admission, SessionCheckoutAdmissionV1::Open);
        assert_eq!(
            after.binding.identity,
            crate::standalone::standalone_identity(
                &crate::namespace::runtime_namespace(replacement.receipt().discovery_root())
                    .unwrap(),
                replacement.session().create_idempotency_key().unwrap(),
                &replacement.session().descriptor().session_id,
                &replacement.session().descriptor().workspace_id,
            )
        );
        assert_eq!(removal, Err("checkout_use_in_use"));
    }
    assert_eq!(fixture.claims(), 0);
}

async fn close(
    store: &SqliteDomainStore,
    catalog: &LocalSessionCatalog,
    created: &CreatedStandaloneSession,
) -> Result<crate::StandaloneCloseOutcome, SessionCheckoutError> {
    let descriptor = created.session().descriptor();
    crate::close_standalone_session(
        store.clone(),
        catalog.clone(),
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await
}
