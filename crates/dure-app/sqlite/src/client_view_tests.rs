use std::path::Path;

use dure_app::{
    CLIENT_VIEW_STATE_SCHEMA_VERSION_V1, CURRENT_STORE_SCHEMA_VERSION, ClientIdV1,
    ClientInstanceIdV1, ClientViewFilterV1, ClientViewGenerationAdvanceRequestV1, ClientViewIdV1,
    ClientViewIdentityV1, ClientViewNamespaceV1, ClientViewPresentationV1,
    ClientViewSubscriptionTopicV1, ClientViewSubscriptionV1, ClientViewViewportV1,
    ClientViewWriteRequestV1, DomainStore, DomainStoreErrorV1, MAX_CLIENT_VIEWS_PER_CLIENT_V1,
    TenantIdV1, UserIdV1,
};
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;
use tokio::sync::Barrier;

use super::SqliteDomainStore;
use super::schema::{V10_SCHEMA_STATEMENTS, execute_statements, writable_connect_options};

fn namespace(client_id: &str) -> ClientViewNamespaceV1 {
    ClientViewNamespaceV1 {
        tenant_id: TenantIdV1::new("tenant-1").unwrap(),
        user_id: UserIdV1::new("user-1").unwrap(),
        client_id: ClientIdV1::new(client_id).unwrap(),
    }
}

fn initialize_request(client_id: &str, instance_id: &str) -> ClientViewGenerationAdvanceRequestV1 {
    ClientViewGenerationAdvanceRequestV1 {
        schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
        namespace: namespace(client_id),
        idempotency_key: format!("initialize-{client_id}"),
        expected_generation: 0,
        expected_instance_id: None,
        next_instance_id: ClientInstanceIdV1::new(instance_id).unwrap(),
    }
}

fn identity(
    client_id: &str,
    generation: i64,
    instance_id: &str,
    view_id: &str,
) -> ClientViewIdentityV1 {
    ClientViewIdentityV1 {
        namespace: namespace(client_id),
        client_generation: generation,
        client_instance_id: ClientInstanceIdV1::new(instance_id).unwrap(),
        view_id: ClientViewIdV1::new(view_id).unwrap(),
    }
}

fn presentation(session_id: &str, pane_id: &str, offset: i32) -> ClientViewPresentationV1 {
    ClientViewPresentationV1 {
        selected_session_id: Some(session_id.into()),
        selected_space_id: Some(format!("space-{session_id}")),
        selected_pane_id: Some(pane_id.into()),
        layout: Vec::new(),
        viewports: vec![ClientViewViewportV1 {
            pane_id: pane_id.into(),
            anchor_sequence: Some(42),
            scroll_offset_rows: offset,
        }],
        filters: vec![ClientViewFilterV1 {
            filter_id: format!("filter-{session_id}"),
            enabled: true,
        }],
        subscriptions: vec![ClientViewSubscriptionV1 {
            topic: ClientViewSubscriptionTopicV1::SessionOutput,
            resource_id: session_id.into(),
        }],
    }
}

fn write_request(
    identity: ClientViewIdentityV1,
    idempotency_key: &str,
    expected_revision: i64,
    presentation: ClientViewPresentationV1,
) -> ClientViewWriteRequestV1 {
    ClientViewWriteRequestV1 {
        schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
        identity,
        idempotency_key: idempotency_key.into(),
        expected_revision,
        presentation,
    }
}

#[tokio::test]
async fn two_clients_preserve_independent_views_across_restart() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let desktop = store
        .advance_client_view_generation(&initialize_request("desktop", "desktop-instance-1"))
        .await
        .unwrap();
    let laptop = store
        .advance_client_view_generation(&initialize_request("laptop", "laptop-instance-1"))
        .await
        .unwrap();
    let desktop_identity = identity("desktop", 1, "desktop-instance-1", "primary");
    let laptop_identity = identity("laptop", 1, "laptop-instance-1", "primary");
    let desktop_presentation = presentation("session-desktop", "pane-desktop", -7);
    let laptop_presentation = presentation("session-laptop", "pane-laptop", 19);

    store
        .write_client_view(&write_request(
            desktop_identity.clone(),
            "write-desktop-1",
            0,
            desktop_presentation.clone(),
        ))
        .await
        .unwrap();
    store
        .write_client_view(&write_request(
            laptop_identity.clone(),
            "write-laptop-1",
            0,
            laptop_presentation.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(desktop.authority.namespace, namespace("desktop"));
    assert_eq!(laptop.authority.namespace, namespace("laptop"));
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .client_view(&desktop_identity)
            .await
            .unwrap()
            .unwrap()
            .presentation,
        desktop_presentation
    );
    assert_eq!(
        reopened
            .client_view(&laptop_identity)
            .await
            .unwrap()
            .unwrap()
            .presentation,
        laptop_presentation
    );
}

#[tokio::test]
async fn concurrent_revision_cas_has_one_winner_and_idempotent_replay() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    store
        .advance_client_view_generation(&initialize_request("desktop", "instance-1"))
        .await
        .unwrap();
    let view_identity = identity("desktop", 1, "instance-1", "primary");
    store
        .write_client_view(&write_request(
            view_identity.clone(),
            "write-initial",
            0,
            presentation("session-initial", "pane-initial", 0),
        ))
        .await
        .unwrap();

    let barrier = std::sync::Arc::new(Barrier::new(3));
    let mut tasks = Vec::new();
    for suffix in ["a", "b"] {
        let store = store.clone();
        let barrier = barrier.clone();
        let request = write_request(
            view_identity.clone(),
            &format!("write-{suffix}"),
            1,
            presentation(&format!("session-{suffix}"), &format!("pane-{suffix}"), 1),
        );
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            store.write_client_view(&request).await
        }));
    }
    barrier.wait().await;
    let first = tasks.remove(0).await.unwrap();
    let second = tasks.remove(0).await.unwrap();
    let winner = match (first, second) {
        (Ok(receipt), Err(DomainStoreErrorV1::ClientViewRevisionConflict { .. }))
        | (Err(DomainStoreErrorV1::ClientViewRevisionConflict { .. }), Ok(receipt)) => receipt,
        outcomes => panic!("unexpected CAS outcomes: {outcomes:?}"),
    };
    assert_eq!(winner.record.revision, 2);

    let replay_request = write_request(
        view_identity,
        &winner.idempotency_key,
        1,
        winner.record.presentation.clone(),
    );
    assert_eq!(
        store.write_client_view(&replay_request).await.unwrap(),
        winner
    );
}

#[tokio::test]
async fn generation_fence_retires_views_and_rejects_late_writes() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    store
        .advance_client_view_generation(&initialize_request("desktop", "instance-1"))
        .await
        .unwrap();
    let stale_identity = identity("desktop", 1, "instance-1", "primary");
    store
        .write_client_view(&write_request(
            stale_identity.clone(),
            "write-generation-1",
            0,
            presentation("session-old", "pane-old", 0),
        ))
        .await
        .unwrap();

    let advance = ClientViewGenerationAdvanceRequestV1 {
        schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
        namespace: namespace("desktop"),
        idempotency_key: "advance-generation-2".into(),
        expected_generation: 1,
        expected_instance_id: Some(ClientInstanceIdV1::new("instance-1").unwrap()),
        next_instance_id: ClientInstanceIdV1::new("instance-2").unwrap(),
    };
    let receipt = store
        .advance_client_view_generation(&advance)
        .await
        .unwrap();
    assert_eq!(receipt.authority.client_generation, 2);
    assert_eq!(
        store
            .advance_client_view_generation(&advance)
            .await
            .unwrap(),
        receipt
    );

    let late_write = store
        .write_client_view(&write_request(
            stale_identity.clone(),
            "late-generation-1",
            1,
            presentation("session-late", "pane-late", 5),
        ))
        .await;
    assert!(matches!(
        late_write,
        Err(DomainStoreErrorV1::ClientViewGenerationConflict {
            expected_generation: 1,
            actual_generation: Some(2),
            ..
        })
    ));
    assert!(matches!(
        store.client_view(&stale_identity).await,
        Err(DomainStoreErrorV1::ClientViewGenerationConflict { .. })
    ));
    assert!(
        store
            .client_view(&identity("desktop", 2, "instance-2", "primary"))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn idempotency_keys_fail_closed_when_reused_for_different_inputs() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let initialize = initialize_request("desktop", "instance-1");
    store
        .advance_client_view_generation(&initialize)
        .await
        .unwrap();
    let mut conflicting_initialize = initialize;
    conflicting_initialize.next_instance_id = ClientInstanceIdV1::new("instance-other").unwrap();
    assert!(matches!(
        store
            .advance_client_view_generation(&conflicting_initialize)
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));

    let view_identity = identity("desktop", 1, "instance-1", "primary");
    let request = write_request(
        view_identity.clone(),
        "write-stable",
        0,
        presentation("session-1", "pane-1", 0),
    );
    store.write_client_view(&request).await.unwrap();
    let conflicting_write = write_request(
        view_identity,
        "write-stable",
        0,
        presentation("session-2", "pane-2", 0),
    );
    assert!(matches!(
        store.write_client_view(&conflicting_write).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
}

#[tokio::test]
async fn a_client_cannot_grow_an_unbounded_number_of_views() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    store
        .advance_client_view_generation(&initialize_request("desktop", "instance-1"))
        .await
        .unwrap();
    for index in 0..MAX_CLIENT_VIEWS_PER_CLIENT_V1 {
        store
            .write_client_view(&write_request(
                identity("desktop", 1, "instance-1", &format!("view-{index}")),
                &format!("write-view-{index}"),
                0,
                ClientViewPresentationV1::default(),
            ))
            .await
            .unwrap();
    }
    let overflow = store
        .write_client_view(&write_request(
            identity("desktop", 1, "instance-1", "view-overflow"),
            "write-view-overflow",
            0,
            ClientViewPresentationV1::default(),
        ))
        .await;
    assert!(matches!(
        overflow,
        Err(DomainStoreErrorV1::InvalidRecord {
            field: "viewId",
            ..
        })
    ));
}

#[tokio::test]
async fn schema_ten_migrates_additively_to_client_view_state() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    create_v10_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let receipt = store
        .advance_client_view_generation(&initialize_request("desktop", "instance-1"))
        .await
        .unwrap();
    assert_eq!(receipt.authority.client_generation, 1);
}

async fn create_v10_fixture(path: &Path) {
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(path))
        .await
        .unwrap();
    execute_statements(&mut connection, V10_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 10, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
}
