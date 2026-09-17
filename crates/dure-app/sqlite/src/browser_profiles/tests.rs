use super::*;
use dure_app::{
    BrowserProfileScopeV1, BrowserProfileUserAgentModeV1, DomainStore, ProjectIdV1, ProjectRecordV1,
};

fn profile(id: &str, scope: BrowserProfileScopeV1) -> BrowserProfileSpecV1 {
    BrowserProfileSpecV1::new(
        BrowserProfileIdV1::new(id).unwrap(),
        "개인 작업".into(),
        scope,
        BrowserProfileUserAgentModeV1::Native,
    )
    .unwrap()
}

#[tokio::test]
async fn browser_profile_metadata_and_retirement_survive_reopen_without_resurrection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let isolated = profile("isolated-1", BrowserProfileScopeV1::Isolated);
    let imported = profile("imported-1", BrowserProfileScopeV1::Imported);
    store.create_browser_profile(&isolated).await.unwrap();
    store.create_browser_profile(&imported).await.unwrap();
    assert!(
        store
            .complete_browser_profile_retirement(isolated.profile_id())
            .await
            .is_err()
    );
    let default = BrowserProfileIdV1::new("default").unwrap();
    assert!(
        store
            .begin_browser_profile_retirement(&default)
            .await
            .is_err()
    );
    assert!(
        store
            .complete_browser_profile_retirement(&default)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .begin_browser_profile_retirement(isolated.profile_id())
            .await
            .unwrap()
            .state,
        BrowserProfileStateV1::Retiring
    );
    store.close().await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let entries = store.browser_profiles().await.unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].profile.profile_id(), &default);
    assert_eq!(entries[0].profile.scope(), BrowserProfileScopeV1::Default);
    assert_eq!(
        store
            .browser_profile(imported.profile_id())
            .await
            .unwrap()
            .unwrap()
            .profile,
        imported
    );
    assert_eq!(
        store.create_browser_profile(&isolated).await.unwrap().state,
        BrowserProfileStateV1::Retiring
    );
    store
        .complete_browser_profile_retirement(isolated.profile_id())
        .await
        .unwrap();
    assert_eq!(
        store.create_browser_profile(&isolated).await.unwrap().state,
        BrowserProfileStateV1::Deleted
    );
    assert_eq!(store.browser_profiles().await.unwrap().len(), 2);
    let conflict = BrowserProfileSpecV1::new(
        isolated.profile_id().clone(),
        "Reused identity".into(),
        BrowserProfileScopeV1::Isolated,
        BrowserProfileUserAgentModeV1::Clean,
    )
    .unwrap();
    assert!(store.create_browser_profile(&conflict).await.is_err());
    store.close().await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .browser_profile(isolated.profile_id())
            .await
            .unwrap()
            .unwrap()
            .state,
        BrowserProfileStateV1::Deleted
    );
    assert_eq!(
        store
            .complete_browser_profile_retirement(isolated.profile_id())
            .await
            .unwrap()
            .state,
        BrowserProfileStateV1::Deleted
    );
    store.close().await;
}

#[tokio::test]
async fn concurrent_browser_profile_creation_keeps_one_immutable_identity() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(directory.path().join("domain.sqlite"))
        .await
        .unwrap();
    let spec = profile("concurrent", BrowserProfileScopeV1::Imported);
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let store = store.clone();
        let spec = spec.clone();
        tasks.push(tokio::spawn(async move {
            store.create_browser_profile(&spec).await
        }));
    }
    for task in tasks {
        let record = task.await.unwrap().unwrap();
        assert_eq!(record.profile, spec);
        assert_eq!(record.state, BrowserProfileStateV1::Active);
    }
    assert_eq!(store.browser_profiles().await.unwrap().len(), 2);
    store.close().await;
}

#[tokio::test]
async fn browser_profile_migration_preserves_v42_domain_records_and_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let project = ProjectRecordV1 {
        project_id: ProjectIdV1::new("existing-project").unwrap(),
        root_path: directory.path().to_str().unwrap().into(),
        display_name: "Existing project".into(),
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    store.upsert_project(&project).await.unwrap();
    // This disposable database retains the complete v42 schema and its real
    // domain record; remove only the new additive profile table for migration.
    assert_eq!(store.database_path().parent(), Some(directory.path()));
    sqlx::query("DROP TABLE browser_profiles")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 42")
        .execute(&store.pool)
        .await
        .unwrap();
    store.close().await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.project(&project.project_id).await.unwrap(),
        Some(project)
    );
    assert_eq!(store.browser_profiles().await.unwrap().len(), 1);
    assert_eq!(
        store.schema_info.schema_version,
        dure_app::CURRENT_STORE_SCHEMA_VERSION
    );
    let backups = std::fs::read_dir(directory.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains("schema-42-to-43")
        })
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    let backup = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(backups[0].path())
            .read_only(true),
    )
    .await
    .unwrap();
    let version: i64 = sqlx::query_scalar("SELECT schema_version FROM store_metadata")
        .fetch_one(&backup)
        .await
        .unwrap();
    assert_eq!(version, 42);
    let tables: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'browser_profiles'")
            .fetch_one(&backup)
            .await
            .unwrap();
    assert_eq!(tables, 0);
    backup.close().await;
    store.close().await;
}
