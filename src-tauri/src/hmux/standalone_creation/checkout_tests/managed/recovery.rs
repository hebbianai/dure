use super::advance::{advance, descriptor, receipt};
use super::*;
use dure_app::SessionCheckoutAdmissionV1;
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{ManagedCreateReconcileRequest, ManagedSessionStopper};

pub(super) async fn store() -> SqliteDomainStore {
    SqliteDomainStore::open(environment_path("DURE_HOME").join("backend/application-state.sqlite3"))
        .await
        .unwrap()
}

fn reconcile(fixture: &Fixture) {
    tauri::async_runtime::block_on(async {
        let store = store().await;
        dure_session_runtime::reconcile_catalog_checkout_users(
            store.clone(),
            || panic!("finalized checkout cleanup must not launch or stop a provider"),
            product_catalog().unwrap(),
            fixture.registration.clone(),
        )
        .await
        .unwrap();
        store.close().await;
    });
}

enum CloseCheckpoint {
    RuntimeClosed,
    SqlClosing,
    SuccessorClosed,
}

fn interrupted_close(checkpoint: CloseCheckpoint) {
    let fixture = Fixture::new();
    let id = match checkpoint {
        CloseCheckpoint::RuntimeClosed => "recover-runtime-closed",
        CloseCheckpoint::SqlClosing => "recover-sql-closing",
        CloseCheckpoint::SuccessorClosed => "recover-successor-closed",
    };
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, id))
        .unwrap();
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(claims.len(), 1);
    let source_identity = tauri::async_runtime::block_on(async {
        let store = store().await;
        let identity = store
            .session_checkout_registration(&claims[0].claim_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .identity;
        if matches!(checkpoint, CloseCheckpoint::SqlClosing) {
            store.begin_session_checkout_close(&identity).await.unwrap();
        }
        store.close().await;
        identity
    });
    let successor = if matches!(checkpoint, CloseCheckpoint::SuccessorClosed) {
        fixture
            .manager
            .stop_managed_session(
                fixture.app.handle(),
                "retire-before-interrupted-successor-close",
                &source.session.session_id,
                &source.session.workspace_id,
                source.session.stop_fence.clone().unwrap(),
            )
            .unwrap();
        Some(advance(&fixture, id, false))
    } else {
        None
    };
    let target = successor
        .as_ref()
        .map(|result| receipt(result).expect("retired source must advance"))
        .unwrap_or(&source);
    let target_descriptor = descriptor(target);

    // An independent live root must retain its own claim throughout recovery.
    let neighbor = fixture
        .manager
        .create_managed(
            fixture.app.handle(),
            launch(&fixture, &format!("neighbor-{id}")),
        )
        .unwrap();
    let neighbor_descriptor = descriptor(&neighbor);
    let catalog = product_catalog().unwrap();
    let runtime = crate::hmux::runtime::resolve_runtime(fixture.app.handle()).unwrap();
    ManagedSessionStopper::new(runtime, &fixture.checkout)
        .with_discovery_root(catalog.discovery_root())
        .stop_create_chain_v2(
            ManagedCreateReconcileRequest::new(
                &target.idempotency_key,
                &target.session.session_id,
                &target.session.workspace_id,
            )
            .unwrap(),
        )
        .unwrap();

    // Stop at the durable runtime/SQL boundary, before the product's Git
    // cleanup. No runtime or SQL file is edited to manufacture this state.
    let before = read_git_checkout_claims(&fixture.registration).unwrap();
    let exited =
        hmux_client::probe_local_process_generation(&target_descriptor.provider_process).unwrap();
    reconcile(&fixture);
    reconcile(&fixture);
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    let neighbor_health = probe_local_session_exact(&catalog, &neighbor_descriptor);
    let admission = tauri::async_runtime::block_on(async {
        let store = store().await;
        let admission = store
            .session_checkout(&source_identity)
            .await
            .unwrap()
            .unwrap()
            .admission;
        store.close().await;
        admission
    });
    close(&fixture, target);
    close(&fixture, &neighbor);
    assert_eq!(before.len(), 2);
    assert_eq!(exited, hmux_client::LocalProcessGenerationStatus::Absent);
    assert_eq!(neighbor_health, SessionProbeStatus::Healthy);
    assert_eq!(
        remaining.len(),
        1,
        "finalized source claim survived recovery: {remaining:?}"
    );
    assert_ne!(remaining[0].claim_id, claims[0].claim_id);
    assert_eq!(admission, SessionCheckoutAdmissionV1::Closed);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_recovery_finishes_logical_close_before_sql_close() {
    interrupted_close(CloseCheckpoint::RuntimeClosed);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_recovery_finishes_logical_close_after_sql_close() {
    interrupted_close(CloseCheckpoint::SqlClosing);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_recovery_finishes_closed_successor_without_client_target_hints() {
    interrupted_close(CloseCheckpoint::SuccessorClosed);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_recovery_keeps_a_generation_stop_available_for_advance() {
    let fixture = Fixture::new();
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "retired-not-closed"))
        .unwrap();
    let before = read_git_checkout_claims(&fixture.registration).unwrap();
    fixture
        .manager
        .stop_managed_session(
            fixture.app.handle(),
            "generation-only-stop",
            &source.session.session_id,
            &source.session.workspace_id,
            source.session.stop_fence.clone().unwrap(),
        )
        .unwrap();
    reconcile(&fixture);
    let retained = read_git_checkout_claims(&fixture.registration).unwrap();
    let advanced = advance(&fixture, "retired-not-closed", false);
    let target = receipt(&advanced).expect("generation retirement must remain resumable");
    let health = probe_local_session_exact(&product_catalog().unwrap(), &descriptor(target));
    close(&fixture, target);
    assert_eq!(before.len(), 1);
    assert_eq!(retained, before);
    assert_ne!(target.session.session_id, source.session.session_id);
    assert_eq!(health, SessionProbeStatus::Healthy);
}
