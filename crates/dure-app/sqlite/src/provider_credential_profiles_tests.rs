use dure_app::{
    CURRENT_STORE_SCHEMA_VERSION, DomainStoreErrorV1,
    PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1, ProviderCredentialProfileDirectoryNameV1,
    ProviderCredentialProfileRegistrationV1, ProviderCredentialProfileStore,
    ProviderCredentialProfileV1, ProviderIdV1,
};
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;

use super::SqliteDomainStore;
use super::schema::{downgrade_workflow_launch_fixture_to_v31, writable_connect_options};

fn registration() -> ProviderCredentialProfileRegistrationV1 {
    ProviderCredentialProfileRegistrationV1 {
        profile: ProviderCredentialProfileV1 {
            schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
            provider_id: ProviderIdV1::new("claude").unwrap(),
            reference_id: "acc-profile-a".into(),
            credential_generation: "credential-v1-first".into(),
        },
        profile_directory_name: ProviderCredentialProfileDirectoryNameV1::new(
            &ProviderIdV1::new("claude").unwrap(),
            "claude-work",
        )
        .unwrap(),
        profile_device: 10,
        profile_inode: 20,
    }
}

#[tokio::test]
async fn credential_profile_survives_reopen_and_converges_on_replacement() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let original = registration();
    assert_eq!(
        store
            .register_provider_credential_profile(None, &original)
            .await
            .unwrap(),
        original
    );
    for launch_reference in ["acc-profile-a", "claude-work"] {
        assert_eq!(
            store
                .provider_credential_profile_for_launch_reference(
                    &ProviderIdV1::new("claude").unwrap(),
                    launch_reference,
                )
                .await
                .unwrap(),
            Some(original.clone())
        );
    }
    assert_eq!(
        store
            .register_provider_credential_profile(
                Some(original.profile.credential_generation.as_str()),
                &original,
            )
            .await
            .unwrap(),
        original
    );
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .provider_credential_profile(&ProviderIdV1::new("claude").unwrap(), "acc-profile-a",)
            .await
            .unwrap(),
        Some(original.clone())
    );

    let mut remounted = original.clone();
    remounted.profile_device = 11;
    assert_eq!(
        reopened
            .register_provider_credential_profile(
                Some(original.profile.credential_generation.as_str()),
                &remounted,
            )
            .await
            .unwrap(),
        remounted
    );

    let mut conflicting = remounted.clone();
    conflicting.profile.credential_generation = "credential-v1-conflicting".into();
    assert!(matches!(
        reopened
            .register_provider_credential_profile(
                Some(remounted.profile.credential_generation.as_str()),
                &conflicting,
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));

    let mut replacement = remounted.clone();
    replacement.profile.credential_generation = "credential-v1-replacement".into();
    replacement.profile_inode = 21;
    assert_eq!(
        reopened
            .register_provider_credential_profile(
                Some(remounted.profile.credential_generation.as_str()),
                &replacement,
            )
            .await
            .unwrap(),
        replacement
    );

    let mut stale_replacement = remounted.clone();
    stale_replacement.profile.credential_generation = "credential-v1-stale-writer".into();
    stale_replacement.profile_inode = 22;
    assert!(matches!(
        reopened
            .register_provider_credential_profile(
                Some(remounted.profile.credential_generation.as_str()),
                &stale_replacement,
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        reopened
            .provider_credential_profile(&ProviderIdV1::new("claude").unwrap(), "acc-profile-a",)
            .await
            .unwrap(),
        Some(replacement.clone())
    );

    let mut remapped = replacement.clone();
    remapped.profile_directory_name = ProviderCredentialProfileDirectoryNameV1::new(
        &remapped.profile.provider_id,
        "claude-personal",
    )
    .unwrap();
    assert!(matches!(
        reopened
            .register_provider_credential_profile(
                Some(replacement.profile.credential_generation.as_str()),
                &remapped,
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn credential_launch_reference_rejects_new_and_legacy_alias_collisions() {
    let temporary = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temporary.path().join("domain.sqlite"))
        .await
        .unwrap();
    let original = registration();
    store
        .register_provider_credential_profile(None, &original)
        .await
        .unwrap();
    let mut collision = original.clone();
    collision.profile.reference_id = "claude-work".into();
    collision.profile.credential_generation = "credential-v1-collision".into();
    collision.profile_directory_name = ProviderCredentialProfileDirectoryNameV1::new(
        &collision.profile.provider_id,
        "claude-collision",
    )
    .unwrap();
    collision.profile_inode = 21;
    assert!(matches!(
        store
            .register_provider_credential_profile(None, &collision)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    sqlx::query(
        r#"
        INSERT INTO provider_credential_profiles (
            schema_version, provider_id, reference_id, profile_directory_name,
            credential_generation, profile_device, profile_inode
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(i64::from(collision.profile.schema_version))
    .bind(collision.profile.provider_id.as_str())
    .bind(&collision.profile.reference_id)
    .bind(collision.profile_directory_name.as_str())
    .bind(&collision.profile.credential_generation)
    .bind(collision.profile_device.to_string())
    .bind(collision.profile_inode.to_string())
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(matches!(
        store
            .provider_credential_profile_for_launch_reference(
                &ProviderIdV1::new("claude").unwrap(),
                "claude-work",
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn schema_23_migrates_additively_to_credential_profiles() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    store.close().await;

    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    sqlx::query("DROP TABLE provider_credential_profiles")
        .execute(&mut connection)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&mut connection)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&mut connection).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 23, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info.schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    migrated
        .register_provider_credential_profile(None, &registration())
        .await
        .unwrap();
}
