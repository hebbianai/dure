use super::advance::{advance, descriptor, receipt};
use super::recovery::store;
use super::*;
use dure_app::SessionCheckoutAdmissionV1;
use hmux_client::recovery_journal::managed_create_ledger::{
    reconcile_identity, ManagedCreateReconcileLedgerState,
};
use hmux_client::ManagedCreateReconcileRequest;

const STOP_CHECKPOINT: &str = "after_create_ledger_retirement_checkpoint";

fn identity(created: &crate::hmux::ManagedCreateSummary) -> ManagedCreateReconcileRequest {
    ManagedCreateReconcileRequest::new(
        &created.idempotency_key,
        &created.session.session_id,
        &created.session.workspace_id,
    )
    .unwrap()
}

fn state(created: &crate::hmux::ManagedCreateSummary) -> ManagedCreateReconcileLedgerState {
    reconcile_identity(
        product_catalog().unwrap().discovery_root(),
        &identity(created),
    )
    .unwrap()
}

fn reconcile(fixture: &Fixture) {
    let runtime = crate::hmux::runtime::resolve_runtime(fixture.app.handle()).unwrap();
    tauri::async_runtime::block_on(async {
        let store = store().await;
        dure_session_runtime::reconcile_catalog_checkout_users(
            store.clone(),
            move || Ok(runtime),
            product_catalog().unwrap(),
            fixture.registration.clone(),
        )
        .await
        .unwrap();
        store.close().await;
    });
}

fn interrupted_close(successor: bool) {
    let fixture = Fixture::new();
    let id = if successor {
        "retiring-successor"
    } else {
        "retiring-root"
    };
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, id))
        .unwrap();
    let original = read_git_checkout_claims(&fixture.registration).unwrap();
    let advanced = if successor {
        fixture
            .manager
            .stop_managed_session(
                fixture.app.handle(),
                "generation-before-retiring-successor",
                &source.session.session_id,
                &source.session.workspace_id,
                source.session.stop_fence.clone().unwrap(),
            )
            .unwrap();
        Some(advance(&fixture, id, false))
    } else {
        None
    };
    let target = advanced
        .as_ref()
        .map(|advanced| receipt(advanced).expect("source must advance"))
        .unwrap_or(&source);
    let target_descriptor = descriptor(target);
    let neighbor = fixture
        .manager
        .create_managed(
            fixture.app.handle(),
            launch(&fixture, &format!("neighbor-{id}")),
        )
        .unwrap();
    let neighbor_descriptor = descriptor(&neighbor);
    let cut = with_stop_fault(STOP_CHECKPOINT, || {
        fixture.manager.stop_managed_create_chain_v2(
            fixture.app.handle(),
            &target.idempotency_key,
            &target.session.session_id,
            &target.session.workspace_id,
        )
    });
    let retiring = matches!(
        state(target),
        ManagedCreateReconcileLedgerState::Retiring(_)
    );
    let at_cut = read_git_checkout_claims(&fixture.registration).unwrap();
    reconcile(&fixture);
    reconcile(&fixture);
    let finalized = matches!(state(target), ManagedCreateReconcileLedgerState::Retired);
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    let neighbor_health =
        probe_local_session_exact(&product_catalog().unwrap(), &neighbor_descriptor);
    let stopped =
        hmux_client::probe_local_process_generation(&target_descriptor.provider_process).unwrap();
    let admission = tauri::async_runtime::block_on(async {
        let store = store().await;
        let record = store
            .session_checkout_registration(&original[0].claim_id)
            .await
            .unwrap()
            .unwrap();
        store.close().await;
        record.admission
    });
    close(&fixture, target);
    close(&fixture, &neighbor);
    assert!(cut.is_err(), "fault did not interrupt close: {cut:?}");
    assert!(retiring, "fault must precede final retirement");
    assert_eq!(at_cut.len(), 2);
    assert_eq!(stopped, hmux_client::LocalProcessGenerationStatus::Absent);
    assert_eq!(neighbor_health, SessionProbeStatus::Healthy);
    assert!(finalized, "passive recovery left the exact stop unfinished");
    assert_eq!(
        remaining.len(),
        1,
        "closed resource survived: {remaining:?}"
    );
    assert_ne!(remaining[0].claim_id, original[0].claim_id);
    assert_eq!(admission, SessionCheckoutAdmissionV1::Closed);
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_passive_recovery_finishes_retiring_logical_close() {
    interrupted_close(false);
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_passive_recovery_finishes_retiring_successor_from_root_claim() {
    interrupted_close(true);
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_passive_recovery_finalizes_generation_stop_without_closing_advance() {
    let fixture = Fixture::new();
    let id = "retiring-generation-only";
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, id))
        .unwrap();
    let original = read_git_checkout_claims(&fixture.registration).unwrap();
    let cut = with_stop_fault(STOP_CHECKPOINT, || {
        fixture.manager.stop_managed_session(
            fixture.app.handle(),
            "interrupted-generation-only",
            &source.session.session_id,
            &source.session.workspace_id,
            source.session.stop_fence.clone().unwrap(),
        )
    });
    let retiring = matches!(
        state(&source),
        ManagedCreateReconcileLedgerState::Retiring(_)
    );
    let starts = std::fs::read_to_string(&fixture.marker).unwrap();
    reconcile(&fixture);
    let finalized = matches!(state(&source), ManagedCreateReconcileLedgerState::Retired);
    let after = read_git_checkout_claims(&fixture.registration).unwrap();
    let recovered_starts = std::fs::read_to_string(&fixture.marker).unwrap();
    let advanced = advance(&fixture, id, false);
    let target = receipt(&advanced).expect("generation stop must remain resumable");
    let health = probe_local_session_exact(&product_catalog().unwrap(), &descriptor(target));
    close(&fixture, target);
    assert!(cut.is_err());
    assert!(retiring);
    assert!(
        finalized,
        "passive recovery did not finish the approved generation stop"
    );
    assert_eq!(after, original);
    assert_eq!(recovered_starts, starts);
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_passive_recovery_preserves_pending_replacement_without_launching_it() {
    let mut fixture = Fixture::new();
    let id = "retiring-replacement";
    let mut request = launch(&fixture, id);
    request.conversation_id = Some("retiring-replacement-conversation".into());
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), request)
        .unwrap();
    let original = read_git_checkout_claims(&fixture.registration).unwrap();
    let mut request = launch(&fixture, id);
    request.conversation_id = Some("retiring-replacement-conversation".into());
    request.replace_current = true;
    let cut = with_stop_fault(STOP_CHECKPOINT, || {
        fixture
            .manager
            .advance_managed_create(fixture.app.handle(), request)
    });
    let retiring = matches!(
        state(&source),
        ManagedCreateReconcileLedgerState::Retiring(_)
    );
    let at_cut = read_git_checkout_claims(&fixture.registration).unwrap();
    let starts = std::fs::read_to_string(&fixture.marker).unwrap();
    drop(std::mem::take(&mut fixture.manager));
    reconcile(&fixture);
    reconcile(&fixture);
    let finalized = matches!(state(&source), ManagedCreateReconcileLedgerState::Retired);
    let after = read_git_checkout_claims(&fixture.registration).unwrap();
    let recovered_starts = std::fs::read_to_string(&fixture.marker).unwrap();
    // Only an explicit retry resumes the saved replacement, without client hints.
    let retried = advance(&fixture, id, true);
    let target = receipt(&retried).expect("pending replacement must remain resumable");
    let health = probe_local_session_exact(&product_catalog().unwrap(), &descriptor(target));
    close(&fixture, target);
    close(&fixture, &source);
    assert!(
        receipt(&cut).is_none(),
        "fault did not interrupt replacement: {cut:?}"
    );
    assert!(retiring);
    assert_eq!(at_cut.len(), 2);
    assert!(
        finalized,
        "passive recovery left the replacement source Retiring"
    );
    assert_eq!(
        after.len(),
        1,
        "source cleanup changed target ownership: {after:?}"
    );
    assert_ne!(after[0].claim_id, original[0].claim_id);
    assert_eq!(starts, "started");
    assert_eq!(
        recovered_starts, starts,
        "passive cleanup launched a replacement"
    );
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}
