use super::upgrade_close::{complete_upgrade, prepare_bound_upgrade, prepare_upgrade};
use super::*;
use hmux_client::recovery_journal::{
    self as journal, RecoveryReservationState, existing_operation,
};
use hmux_client::{LocalProcessGenerationStatus, probe_local_process_generation};

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn close_cancels_an_unborn_bound_upgrade_even_after_journal_collection() {
    assert_unborn_close(true, false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn close_cancels_before_source_stop_and_retires_the_original_provider() {
    assert_unborn_close(false, false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn close_cancels_an_existing_upgrade_in_a_compatibility_root() {
    assert_unborn_close(false, true).await;
}

async fn assert_unborn_close(stop_source_first: bool, compatibility_root: bool) {
    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    let (source, request, operation) = prepare_bound_upgrade(&fixture, original.session(), 0);
    let recovery_id = operation.recovery_id().to_string();
    if stop_source_first {
        source.stop(Duration::from_secs(3)).unwrap();
    }
    drop(operation);
    let primary = fixture.database.parent().unwrap().join("unused-primary");
    let catalog = if compatibility_root {
        LocalSessionCatalog::with_read_only_discovery_roots(
            &primary,
            vec![fixture.discovery.clone()],
        )
        .unwrap()
    } else {
        LocalSessionCatalog::new(&fixture.discovery)
    };
    let descriptor = original.session().descriptor();
    let closed = crate::close_standalone_session(
        fixture.runtime.store.clone(),
        catalog,
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await;
    let primary_created = primary.exists();
    let after = fixture.record_optional(&before.binding.claim_id).await;
    let claims = fixture.claims();
    let original_provider =
        probe_local_process_generation(&original.session().descriptor().provider_process).unwrap();
    let completion = existing_operation::read(
        &fixture.discovery,
        &recovery_id,
        journal::standalone_upgrade::SELECTED_BUILD_ACTION,
    )
    .unwrap();
    if closed.is_err() {
        let outcome = match &completion {
            Some(existing_operation::RecoveryOperationObservation::Completed {
                completion,
                ..
            }) => completion.outcome.as_str(),
            Some(existing_operation::RecoveryOperationObservation::Pending { .. }) => "pending",
            None => "missing",
        };
        eprintln!(
            "close observation: result={closed:?}, operation={outcome}, provider={original_provider:?}, claims={claims}, primary_created={primary_created}"
        );
    }
    let collected = if closed.is_ok() {
        Some(
            journal::garbage_collect_completed(
                &fixture.discovery,
                journal::RecoveryJournalGcPolicy {
                    minimum_completed_age: Duration::ZERO,
                    maximum_completed_records: 0,
                    maximum_completed_bytes: 0,
                    ..journal::RecoveryJournalGcPolicy::default()
                },
            )
            .unwrap(),
        )
    } else {
        None
    };
    let delayed = fixture.runtime.standalone_creator.create(request);
    // On RED, reconcile only the exact late creation for cleanup. Preserve the
    // already captured close, SQL, claim and journal observations for assertions.
    if let Ok(target) = &delayed {
        if let Some(existing_operation::RecoveryOperationObservation::Pending {
            identity, ..
        }) = &completion
        {
            if let Some(RecoveryReservationState::Pending(mut operation)) =
                existing_operation::reopen(&fixture.discovery, identity).unwrap()
            {
                complete_upgrade(&mut operation, target);
            }
        }
        cleanup(&fixture, &[&original, target]).await;
    } else {
        cleanup(&fixture, &[&original]).await;
    }
    assert!(
        closed.is_ok(),
        "an unborn bound upgrade stranded close: {closed:?}"
    );
    assert_eq!(after.unwrap().admission, SessionCheckoutAdmissionV1::Closed);
    assert_eq!(claims, 0);
    assert!(
        !primary_created,
        "closing cannot create a new primary namespace"
    );
    assert_eq!(original_provider, LocalProcessGenerationStatus::Absent);
    let Some(existing_operation::RecoveryOperationObservation::Completed { completion, .. }) =
        completion
    else {
        panic!("close must durably finish the original operation");
    };
    assert_eq!(completion.outcome, "cancelled");
    assert!(collected.unwrap().removed_completed_records >= 1);
    assert_eq!(
        delayed.err().unwrap().code(),
        "hmux_standalone_operation_not_pending"
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn close_intent_survives_a_busy_upgrade_and_retires_its_later_target() {
    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    let (source, request, mut operation) = prepare_upgrade(&fixture, original.session(), 0);
    let first = close(&fixture, &original, Duration::from_millis(100)).await;
    let admitted = fixture.record().await;
    let claims = fixture.claims();
    source.stop(Duration::from_secs(3)).unwrap();
    let replacement = fixture.runtime.standalone_creator.create(request).unwrap();
    complete_upgrade(&mut operation, &replacement);
    drop(operation);
    let second = close(&fixture, &original, Duration::from_secs(3)).await;
    let after = fixture.record_optional(&before.binding.claim_id).await;
    let provider =
        probe_local_process_generation(&replacement.session().descriptor().provider_process)
            .unwrap();
    let released = fixture.claims();
    cleanup(&fixture, &[&original, &replacement]).await;

    assert!(matches!(first, Err(SessionCheckoutError::ClosePending)));
    assert_eq!(admitted.admission, SessionCheckoutAdmissionV1::Closing);
    assert_eq!(admitted.binding, before.binding);
    assert_eq!(claims, 1);
    assert!(second.is_ok(), "persisted close did not resume: {second:?}");
    assert_eq!(after.unwrap().admission, SessionCheckoutAdmissionV1::Closed);
    assert_eq!(provider, LocalProcessGenerationStatus::Absent);
    assert_eq!(released, 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn close_recovers_a_started_upgrade_after_loss_before_result_checkpoint() {
    assert_started_upgrade_close(false, false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn close_reconciles_a_started_bound_target_instead_of_cancelling_it() {
    assert_started_upgrade_close(true, false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn close_reconciles_a_started_target_in_a_compatibility_root() {
    assert_started_upgrade_close(true, true).await;
}

async fn assert_started_upgrade_close(operation_bound: bool, compatibility_root: bool) {
    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    let (source, request, operation) = if operation_bound {
        prepare_bound_upgrade(&fixture, original.session(), 0)
    } else {
        prepare_upgrade(&fixture, original.session(), 0)
    };
    let recovery_id = operation.recovery_id().to_string();
    source.stop(Duration::from_secs(3)).unwrap();
    let replacement = fixture.runtime.standalone_creator.create(request).unwrap();
    assert!(
        operation
            .operation_checkpoint()
            .unwrap()
            .replacement_receipt
            .is_none()
    );
    drop(operation);

    let primary = fixture.database.parent().unwrap().join("unused-primary");
    let catalog = if compatibility_root {
        LocalSessionCatalog::with_read_only_discovery_roots(
            &primary,
            vec![fixture.discovery.clone()],
        )
        .unwrap()
    } else {
        LocalSessionCatalog::new(&fixture.discovery)
    };
    let descriptor = original.session().descriptor();
    let closed = crate::close_standalone_session(
        fixture.runtime.store.clone(),
        catalog,
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await;
    let primary_created = primary.exists();
    let provider =
        probe_local_process_generation(&replacement.session().descriptor().provider_process)
            .unwrap();
    let claims = fixture.claims();
    let after = fixture.record_optional(&before.binding.claim_id).await;
    // Complete only for cleanup if RED left the original intent pending. This
    // cannot alter the close result, provider state, SQL or claims captured above.
    if let Some(existing_operation::RecoveryOperationObservation::Pending { identity, .. }) =
        existing_operation::read(
            &fixture.discovery,
            &recovery_id,
            journal::standalone_upgrade::SELECTED_BUILD_ACTION,
        )
        .unwrap()
    {
        if let Some(RecoveryReservationState::Pending(mut operation)) =
            existing_operation::reopen(&fixture.discovery, &identity).unwrap()
        {
            complete_upgrade(&mut operation, &replacement);
        }
    }
    cleanup(&fixture, &[&original, &replacement]).await;
    assert!(
        closed.is_ok(),
        "lost upgrade caller stranded close: {closed:?}"
    );
    assert_eq!(provider, LocalProcessGenerationStatus::Absent);
    assert!(
        !primary_created,
        "closing cannot create a new primary namespace"
    );
    assert_eq!(claims, 0);
    assert_eq!(after.unwrap().admission, SessionCheckoutAdmissionV1::Closed);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn an_old_pane_close_does_not_cancel_its_successors_pending_upgrade() {
    let fixture = Fixture::new().await;
    let original = fixture.create().await;
    let before = fixture.record().await;
    let (source, request, mut operation) = prepare_upgrade(&fixture, original.session(), 0);
    source.stop(Duration::from_secs(3)).unwrap();
    let replacement = fixture.runtime.standalone_creator.create(request).unwrap();
    complete_upgrade(&mut operation, &replacement);
    drop(operation);
    let (source, request, mut operation) = prepare_upgrade(&fixture, replacement.session(), 1);
    let result = close(&fixture, &original, Duration::from_secs(3)).await;
    let observed = fixture.record().await;
    let provider =
        probe_local_process_generation(&replacement.session().descriptor().provider_process)
            .unwrap();
    let claims = fixture.claims();

    source.stop(Duration::from_secs(3)).unwrap();
    let final_target = fixture.runtime.standalone_creator.create(request).unwrap();
    complete_upgrade(&mut operation, &final_target);
    drop(operation);
    cleanup(&fixture, &[&original, &replacement, &final_target]).await;

    assert!(matches!(result, Err(SessionCheckoutError::ClosePending)));
    assert_eq!(
        observed, before,
        "an already replaced source cannot close its successor's owner"
    );
    assert_eq!(provider, LocalProcessGenerationStatus::Live);
    assert_eq!(claims, 1);
}

async fn close(
    fixture: &Fixture,
    created: &CreatedStandaloneSession,
    timeout: Duration,
) -> Result<crate::StandaloneCloseOutcome, SessionCheckoutError> {
    let descriptor = created.session().descriptor();
    crate::close_standalone_session(
        fixture.runtime.store.clone(),
        LocalSessionCatalog::new(&fixture.discovery),
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        timeout,
    )
    .await
}

async fn cleanup(fixture: &Fixture, created: &[&CreatedStandaloneSession]) {
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    for created in created.iter().rev() {
        let target = CompletedStandaloneTarget::from_created(
            created.receipt().clone(),
            created.session().descriptor(),
        )
        .unwrap();
        assert_eq!(
            catalog.retire_completed_standalone_target(
                target.generation(),
                target.provider_process(),
                Duration::from_secs(3)
            ),
            CompletedStandaloneTargetLifecycle::Retired
        );
    }
    for created in created {
        retention::close(&fixture.runtime.store, fixture, created).await;
    }
    fixture.runtime.store.close().await;
}

impl Fixture {
    async fn record_optional(&self, claim_id: &OperationIdV1) -> Option<SessionCheckoutRecordV1> {
        self.runtime
            .store
            .session_checkout_registration(claim_id)
            .await
            .unwrap()
    }
}
