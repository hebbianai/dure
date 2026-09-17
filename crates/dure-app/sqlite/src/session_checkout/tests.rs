use std::time::Duration;

use dure_app::{DomainStore, DomainStoreErrorV1, ProjectIdV1, ProjectRecordV1};
use sqlx::sqlite::SqlitePoolOptions;

use super::*;

mod close_recovery;
mod recovery;
mod recovery_candidates;
mod transfer;
mod unbound_close;

fn binding() -> SessionCheckoutBindingV1 {
    SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            runtime_namespace: "/runtime/one".into(),
            owner: dure_app::SessionCheckoutOwnerV1::Managed {
                workspace_id: "workspace".into(),
                session_id: "shell".into(),
                idempotency_key: "create-shell".into(),
            },
        },
        "/working/directory".into(),
        Some(dure_app::GitCheckoutRegistrationV1 {
            repository_path: "/project".into(),
            instance: dure_app::GitCheckoutInstanceV1 {
                schema_version: dure_app::GIT_CHECKOUT_SCHEMA_VERSION_V1,
                canonical_path: "/working/directory".into(),
                git_common_dir: "/project/.git".into(),
                git_dir: "/project/.git/worktrees/checkout".into(),
                instance_token: format!("dwt1_{}", "1".repeat(32)),
            },
        }),
    )
}

async fn second_writer(store: &SqliteDomainStore) -> SqliteDomainStore {
    // Zero busy timeout makes a held SQLite write lock observable as Busy,
    // rather than inferring exclusion from a sleep or scheduling delay.
    let options = store
        .pool
        .connect_options()
        .as_ref()
        .clone()
        .busy_timeout(Duration::ZERO);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    SqliteDomainStore {
        pool,
        ..store.clone()
    }
}

#[tokio::test]
async fn registration_lookup_resolves_only_its_binding_and_isolates_an_invalid_neighbor() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let binding = binding();
    let mut other = binding.clone();
    other.identity.owner = dure_app::SessionCheckoutOwnerV1::Managed {
        workspace_id: "workspace".into(),
        session_id: "other-shell".into(),
        idempotency_key: "create-other-shell".into(),
    };
    other.claim_id = other.identity.owner_id();
    let original = store.prepare_session_checkout(&binding).await.unwrap();
    let neighbor = store.prepare_session_checkout(&other).await.unwrap();
    assert_eq!(
        store
            .session_checkout_registration(&binding.claim_id)
            .await
            .unwrap(),
        Some(original),
    );
    assert_eq!(
        store
            .session_checkout_registration(&OperationIdV1::new("unknown-producer").unwrap())
            .await
            .unwrap(),
        None,
    );
    sqlx::query(
        "UPDATE session_checkout_bindings SET binding_json = ?2 WHERE registration_id = ?1",
    )
    .bind(binding.claim_id.as_str())
    .bind(serde_json::to_string(&other).unwrap())
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(matches!(
        store.session_checkout_registration(&binding.claim_id).await,
        Err(DomainStoreErrorV1::Storage {
            code: "session_checkout_identity_changed",
            ..
        })
    ));
    assert_eq!(
        store
            .session_checkout_registration(&other.claim_id)
            .await
            .unwrap(),
        Some(neighbor),
    );
    store.close().await;
}

#[tokio::test]
async fn failed_runtime_reservation_does_not_publish_a_binding() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let binding = binding();
    let result = store
        .prepare_session_checkout_with(&binding, || async {
            Err(DomainStoreErrorV1::Storage {
                code: "fixture_reservation_failed",
                detail: "injected".into(),
            })
        })
        .await;
    assert!(matches!(
        result,
        Err(DomainStoreErrorV1::Storage {
            code: "fixture_reservation_failed",
            ..
        })
    ));
    assert_eq!(
        store.session_checkout(&binding.identity).await.unwrap(),
        None
    );
    store.prepare_session_checkout(&binding).await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn pending_runtime_reservation_is_not_visible_to_an_independent_closer() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let binding = binding();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let producer = store.clone();
    let selected = binding.clone();
    let preparation = tokio::spawn(async move {
        producer
            .prepare_session_checkout_with(&selected, || async {
                entered.send(()).unwrap();
                released.await.unwrap();
                Ok::<(), DomainStoreErrorV1>(())
            })
            .await
    });
    observed.await.unwrap();
    assert_eq!(
        other.session_checkout(&binding.identity).await.unwrap(),
        None
    );
    assert!(matches!(
        other.begin_session_checkout_close(&binding.identity).await,
        Err(DomainStoreErrorV1::Busy { .. })
    ));
    release.send(()).unwrap();
    preparation.await.unwrap().unwrap();
    assert_eq!(
        other
            .begin_session_checkout_close(&binding.identity)
            .await
            .unwrap()
            .unwrap()
            .admission,
        SessionCheckoutAdmissionV1::Closing
    );
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn claim_first_excludes_cleanup_and_close_first_excludes_a_late_claim() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let binding = binding();
    store.prepare_session_checkout(&binding).await.unwrap();
    let admitted = store
        .admit_session_checkout(&binding.identity)
        .await
        .unwrap();

    // A different connection sees the durable binding even while admission is
    // held, but cannot close this producer around an in-flight Git claim.
    assert_eq!(
        other
            .session_checkout(&binding.identity)
            .await
            .unwrap()
            .unwrap()
            .binding,
        binding
    );
    assert!(matches!(
        other.begin_session_checkout_close(&binding.identity).await,
        Err(DomainStoreErrorV1::Busy { .. })
    ));
    admitted.finish().await.unwrap();
    let closed = other
        .begin_session_checkout_close(&binding.identity)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closed.admission, SessionCheckoutAdmissionV1::Closing);
    assert!(matches!(
        store.admit_session_checkout(&binding.identity).await,
        Err(DomainStoreErrorV1::Storage {
            code: "session_checkout_closing",
            ..
        })
    ));
    assert_eq!(
        store.prepare_session_checkout(&binding).await.unwrap(),
        closed
    );
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn cancelled_claim_keeps_the_prepared_binding_and_releases_its_transaction() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let binding = binding();
    store.prepare_session_checkout(&binding).await.unwrap();
    let admitted = store
        .admit_session_checkout(&binding.identity)
        .await
        .unwrap();
    assert_eq!(admitted.binding(), &binding);
    drop(admitted);

    // Reacquiring through the original pool also covers SQLx rollback before
    // the cancelled transaction's connection returns to callers.
    let closed = store
        .begin_session_checkout_close(&binding.identity)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closed.binding, binding);
    assert_eq!(closed.admission, SessionCheckoutAdmissionV1::Closing);
    store.close().await;
}

#[tokio::test]
async fn close_reopens_as_pending_cleanup_without_reopening_claim_admission() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let binding = binding();
    store.prepare_session_checkout(&binding).await.unwrap();
    store
        .begin_session_checkout_close(&binding.identity)
        .await
        .unwrap();
    store.close().await;

    let resumed = SqliteDomainStore::open(&path).await.unwrap();
    let record = resumed
        .session_checkout(&binding.identity)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.binding, binding);
    assert_eq!(record.admission, SessionCheckoutAdmissionV1::Closing);
    assert!(
        resumed
            .admit_session_checkout(&binding.identity)
            .await
            .is_err()
    );
    let complete = resumed
        .finish_session_checkout_close(&binding.identity)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(complete.admission, SessionCheckoutAdmissionV1::Closed);
    assert_eq!(
        resumed
            .begin_session_checkout_close(&binding.identity)
            .await
            .unwrap(),
        Some(complete.clone())
    );
    resumed.close().await;

    let replay = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        replay.prepare_session_checkout(&binding).await.unwrap(),
        complete
    );
    assert!(
        replay
            .admit_session_checkout(&binding.identity)
            .await
            .is_err()
    );
    replay.close().await;
}

#[tokio::test]
async fn frozen_selection_cannot_move_but_other_runtime_namespaces_remain_independent() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let binding = binding();
    let original = store.prepare_session_checkout(&binding).await.unwrap();
    let mut changed = binding.clone();
    changed.working_directory = "/another/checkout".into();
    assert!(matches!(
        store.prepare_session_checkout(&changed).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    changed = binding.clone();
    changed
        .registration
        .as_mut()
        .unwrap()
        .instance
        .instance_token = format!("dwt1_{}", "2".repeat(32));
    assert!(matches!(
        store.prepare_session_checkout(&changed).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    changed = binding.clone();
    changed.identity.runtime_namespace = "/runtime/two".into();
    changed.claim_id = changed.identity.owner_id();
    let independent = store.prepare_session_checkout(&changed).await.unwrap();
    assert_ne!(binding.claim_id, changed.claim_id);
    store
        .begin_session_checkout_close(&binding.identity)
        .await
        .unwrap();
    assert_eq!(
        store.session_checkout(&changed.identity).await.unwrap(),
        Some(independent)
    );
    assert_eq!(
        store
            .session_checkout(&binding.identity)
            .await
            .unwrap()
            .unwrap()
            .binding,
        original.binding
    );
    store.close().await;
}

#[tokio::test]
async fn non_checkout_selection_does_not_discover_a_new_resource_on_retry() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let linked = binding();
    let mut plain = linked.clone();
    plain.registration = None;
    let original = store.prepare_session_checkout(&plain).await.unwrap();
    assert!(matches!(
        store.prepare_session_checkout(&linked).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        store.session_checkout(&plain.identity).await.unwrap(),
        Some(original)
    );
    store.close().await;
}

#[tokio::test]
async fn missing_claim_compensation_does_not_close_an_owner_or_finalize_open_admission() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let binding = binding();
    assert_eq!(
        store
            .begin_session_checkout_claim_close(&binding.identity, &binding.claim_id)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .finish_session_checkout_close(&binding.identity)
            .await
            .unwrap(),
        None
    );
    assert!(
        store
            .admit_session_checkout(&binding.identity)
            .await
            .is_err()
    );
    // Missing-claim compensation owns no logical close. Unlike an explicit
    // unbound close, it cannot prevent this owner's first resource selection.
    store.prepare_session_checkout(&binding).await.unwrap();
    assert!(matches!(
        store.finish_session_checkout_close(&binding.identity).await,
        Err(DomainStoreErrorV1::Storage {
            code: "session_checkout_admission_open",
            ..
        })
    ));
    assert_eq!(
        store
            .session_checkout(&binding.identity)
            .await
            .unwrap()
            .unwrap()
            .admission,
        SessionCheckoutAdmissionV1::Open
    );
    store.close().await;
}

#[tokio::test]
async fn v41_migration_adds_binding_storage_and_preserves_existing_project_records() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let project = ProjectRecordV1 {
        project_id: ProjectIdV1::new("kept-project").unwrap(),
        root_path: "/project".into(),
        display_name: "Existing project".into(),
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    store.upsert_project(&project).await.unwrap();
    // The only schema addition in v42 is this table. Removing it produces the
    // real v41 shape without hand-writing another copy of the application schema.
    sqlx::query("DROP TABLE session_checkout_bindings")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 41, min_reader_version = 41, min_writer_version = 41")
        .execute(&store.pool).await.unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        dure_app::CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        migrated.project(&project.project_id).await.unwrap(),
        Some(project)
    );
    let binding = binding();
    assert_eq!(
        migrated
            .prepare_session_checkout(&binding)
            .await
            .unwrap()
            .binding,
        binding
    );
    migrated.close().await;
}
