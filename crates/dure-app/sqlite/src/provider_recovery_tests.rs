use dure_app::{
    DomainStore, DomainStoreErrorV1, ProviderCredentialProfileV1, ProviderIdV1,
    ProviderRecoveryAccountV1, ProviderRecoveryPolicyPutV1, ProviderRecoveryStore,
};
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;

use crate::SqliteDomainStore;
use crate::schema::writable_connect_options;

fn policy() -> ProviderRecoveryPolicyPutV1 {
    let provider_id = ProviderIdV1::new("codex").unwrap();
    ProviderRecoveryPolicyPutV1 {
        schema_version: 1,
        provider_id: provider_id.clone(),
        expected_revision: 0,
        idempotency_key: "enable-recovery".into(),
        enabled: true,
        accounts: ["team-a", "team-b"]
            .into_iter()
            .map(|reference| ProviderRecoveryAccountV1 {
                profile: ProviderCredentialProfileV1 {
                    schema_version: 1,
                    provider_id: provider_id.clone(),
                    reference_id: reference.into(),
                    credential_generation: format!("generation-{reference}"),
                },
                name: reference.into(),
            })
            .collect(),
    }
}

#[tokio::test]
async fn configured_pool_survives_reopen_without_becoming_another_backends_policy() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("owner.sqlite");
    let request = policy();
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert!(
        store
            .provider_recovery_policy(&request.provider_id)
            .await
            .unwrap()
            .is_none()
    );
    let expected = store
        .put_provider_recovery_policy(&request, 100)
        .await
        .unwrap();
    assert_eq!(expected.activated_at_ms, Some(100));
    assert_eq!(expected.accounts, request.accounts);
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .provider_recovery_policy(&request.provider_id)
            .await
            .unwrap(),
        Some(expected)
    );
    let other = SqliteDomainStore::open(&root.path().join("participant.sqlite"))
        .await
        .unwrap();
    assert!(
        other
            .provider_recovery_policy(&request.provider_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn two_clients_cannot_overwrite_a_newer_pool_and_replay_does_not_reenable_it() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("shared.sqlite");
    let first = SqliteDomainStore::open(&path).await.unwrap();
    let second = SqliteDomainStore::open(&path).await.unwrap();
    let request = policy();
    let enabled = first
        .put_provider_recovery_policy(&request, 100)
        .await
        .unwrap();
    let mut disable = request.clone();
    disable.expected_revision = 1;
    disable.idempotency_key = "disable".into();
    disable.enabled = false;
    let mut reorder = disable.clone();
    reorder.idempotency_key = "reorder".into();
    reorder.enabled = true;
    reorder.accounts.reverse();
    let (left, right) = tokio::join!(
        first.put_provider_recovery_policy(&disable, 200),
        second.put_provider_recovery_policy(&reorder, 200)
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let winner = left.as_ref().ok().or(right.as_ref().ok()).unwrap();
    assert_eq!(winner.revision, 2);
    assert!(matches!(
        left.as_ref().err().or(right.as_ref().err()),
        Some(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    disable.expected_revision = 2;
    disable.idempotency_key = "disable-after-race".into();
    let disabled = first
        .put_provider_recovery_policy(&disable, 250)
        .await
        .unwrap();
    assert!(!disabled.enabled);
    assert_eq!(
        second
            .put_provider_recovery_policy(&request, 300)
            .await
            .unwrap(),
        enabled
    );
    assert_eq!(
        first
            .provider_recovery_policy(&request.provider_id)
            .await
            .unwrap(),
        Some(disabled)
    );
    let mut altered = request;
    altered.accounts.reverse();
    assert!(matches!(
        first.put_provider_recovery_policy(&altered, 400).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
}

#[tokio::test]
async fn editing_a_pool_preserves_activation_but_reenabling_starts_a_new_boundary() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(&root.path().join("activation.sqlite"))
        .await
        .unwrap();
    let mut request = policy();
    store
        .put_provider_recovery_policy(&request, 100)
        .await
        .unwrap();
    request.expected_revision = 1;
    request.idempotency_key = "rename".into();
    request.accounts[0].name = "Shared work".into();
    assert_eq!(
        store
            .put_provider_recovery_policy(&request, 200)
            .await
            .unwrap()
            .activated_at_ms,
        Some(100)
    );
    request.expected_revision = 2;
    request.idempotency_key = "disable".into();
    request.enabled = false;
    assert_eq!(
        store
            .put_provider_recovery_policy(&request, 300)
            .await
            .unwrap()
            .activated_at_ms,
        None
    );
    request.expected_revision = 3;
    request.idempotency_key = "enable-again".into();
    request.enabled = true;
    assert_eq!(
        store
            .put_provider_recovery_policy(&request, 400)
            .await
            .unwrap()
            .activated_at_ms,
        Some(400)
    );
}

#[tokio::test]
async fn foreign_and_duplicate_references_cannot_replace_the_configured_pool() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(&root.path().join("identity.sqlite"))
        .await
        .unwrap();
    let mut request = policy();
    let original = store
        .put_provider_recovery_policy(&request, 100)
        .await
        .unwrap();
    request.expected_revision = 1;
    request.idempotency_key = "foreign".into();
    request.accounts[0].profile.provider_id = ProviderIdV1::new("claude").unwrap();
    assert!(matches!(
        store.put_provider_recovery_policy(&request, 200).await,
        Err(DomainStoreErrorV1::InvalidRecord { .. })
    ));
    request.accounts[0] = request.accounts[1].clone();
    assert!(matches!(
        store.put_provider_recovery_policy(&request, 200).await,
        Err(DomainStoreErrorV1::InvalidRecord { .. })
    ));
    assert_eq!(
        store
            .provider_recovery_policy(&request.provider_id)
            .await
            .unwrap(),
        Some(original)
    );
}

#[tokio::test]
async fn schema_49_migration_adds_recovery_without_enabling_any_provider() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("migration.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    store.close().await;
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    for table in [
        "provider_recovery_policies",
        "provider_recovery_mutations",
        "provider_recovery_usage",
        "agent_recoveries",
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut connection)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE store_metadata SET schema_version = 49, min_reader_version = 49, min_writer_version = 49 WHERE singleton = 1")
        .execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        dure_app::CURRENT_STORE_SCHEMA_VERSION
    );
    assert!(
        migrated
            .provider_recovery_policy(&policy().provider_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        migrated
            .put_provider_recovery_policy(&policy(), 500)
            .await
            .unwrap()
            .revision,
        1
    );
}
