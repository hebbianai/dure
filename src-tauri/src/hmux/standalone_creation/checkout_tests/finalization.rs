use super::*;
use dure_app::{SessionCheckoutAdmissionV1, SessionCheckoutRecordV1};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::LocalSessionCatalog;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};

fn database() -> PathBuf {
    environment_path("DURE_HOME").join("backend/application-state.sqlite3")
}

fn record(claim: &OperationIdV1) -> SessionCheckoutRecordV1 {
    tauri::async_runtime::block_on(async {
        let store = SqliteDomainStore::open(database()).await.unwrap();
        let record = store
            .session_checkout_registration(claim)
            .await
            .unwrap()
            .unwrap();
        store.close().await;
        record
    })
}

fn interrupt_final_checkpoint<T>(operation: impl FnOnce() -> T) -> T {
    let mut connection = tauri::async_runtime::block_on(async {
        let mut connection =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(database()))
                .await
                .unwrap();
        sqlx::query(
            "CREATE TRIGGER interrupt_checkout_finalization BEFORE UPDATE OF admission \
             ON session_checkout_bindings WHEN NEW.admission = 'closed' \
             BEGIN SELECT RAISE(ABORT, 'injected_checkout_finalization'); END",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    });
    // Only this disposable database's final checkpoint fails. Runtime stop and
    // Git release still execute through the real product close path.
    let result = operation();
    tauri::async_runtime::block_on(async {
        sqlx::query("DROP TRIGGER interrupt_checkout_finalization")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
    });
    result
}

fn reconcile(fixture: &Fixture, catalog: LocalSessionCatalog) {
    tauri::async_runtime::block_on(async {
        let store = SqliteDomainStore::open(database()).await.unwrap();
        dure_session_runtime::reconcile_catalog_checkout_users(
            store.clone(),
            || panic!("finalized runtime retirement needs no executable activation"),
            catalog,
            fixture.registration.clone(),
        )
        .await
        .unwrap();
        store.close().await;
    });
}

fn interrupted_finalization(managed: bool) {
    let fixture = Fixture::new();
    let managed = managed.then(|| {
        fixture
            .manager
            .create_managed_shell(
                fixture.app.handle(),
                "finalization-managed".into(),
                "finalization-managed".into(),
                "finalization-workspace".into(),
                fixture.checkout.to_str().unwrap().into(),
                24,
                80,
                Default::default(),
                Default::default(),
            )
            .unwrap()
    });
    let session = managed
        .as_ref()
        .map(|created| created.session.clone())
        .unwrap_or_else(|| fixture.create().unwrap());
    let original = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(original.len(), 1);
    let claim = &original[0].claim_id;
    let catalog = product_catalog().unwrap();
    let target = catalog
        .find(&SessionSelector::new(
            &session.session_id,
            Some(session.workspace_id.clone()),
        ))
        .unwrap();
    let neighbor = fixture.create().unwrap();
    let neighbor_descriptor = catalog
        .find(&SessionSelector::new(
            &neighbor.session_id,
            Some(neighbor.workspace_id.clone()),
        ))
        .unwrap();
    let close = || match &managed {
        Some(created) => fixture
            .manager
            .stop_managed_create_chain_v2(
                fixture.app.handle(),
                &created.idempotency_key,
                &session.session_id,
                &session.workspace_id,
            )
            .map(|_| ()),
        None => fixture
            .manager
            .terminate_standalone_session(
                &session.session_id,
                &session.workspace_id,
                Duration::from_secs(3),
            )
            .map(|_| ()),
    };
    let interrupted = interrupt_final_checkpoint(close);
    let at_cut = record(claim);
    let claims_at_cut = read_git_checkout_claims(&fixture.registration).unwrap();
    let stopped = hmux_client::probe_local_process_generation(&target.provider_process).unwrap();
    let launches = std::fs::read_to_string(&fixture.marker).unwrap();

    // A fresh caller knows only the selected checkout, not the missing Git
    // claim or session id. An unrelated namespace cannot finish this close.
    reconcile(
        &fixture,
        LocalSessionCatalog::new(
            fixture
                .checkout
                .parent()
                .unwrap()
                .join("unconfigured-runtime"),
        ),
    );
    let outside_scope = record(claim);
    reconcile(&fixture, product_catalog().unwrap());
    reconcile(&fixture, product_catalog().unwrap());
    let recovered = record(claim);
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    let health = probe_local_session_exact(&catalog, &neighbor_descriptor);
    let after_launches = std::fs::read_to_string(&fixture.marker).unwrap();

    // Explicit close also preserves the RED fixture's cleanup before assertions.
    close().unwrap();
    fixture.close(&neighbor);
    assert!(
        interrupted
            .as_ref()
            .is_err_and(|error| error.contains("injected_checkout_finalization")),
        "the final database checkpoint did not fail: {interrupted:?}"
    );
    assert_eq!(at_cut.admission, SessionCheckoutAdmissionV1::Closing);
    assert_eq!(outside_scope, at_cut);
    assert_eq!(stopped, hmux_client::LocalProcessGenerationStatus::Absent);
    assert_eq!(claims_at_cut.len(), 1);
    assert_ne!(claims_at_cut[0].claim_id, *claim);
    assert_eq!(remaining, claims_at_cut);
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert_eq!(after_launches, launches);
    assert_eq!(
        recovered.admission,
        SessionCheckoutAdmissionV1::Closed,
        "Git release hid the unfinished SQL close: {recovered:?}"
    );
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_standalone_finalization_is_recovered_after_git_release() {
    interrupted_finalization(false);
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_managed_finalization_is_recovered_after_git_release() {
    interrupted_finalization(true);
}
