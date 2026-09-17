use super::*;
use std::path::PathBuf;

#[cfg(unix)]
mod native;

async fn fixture() -> (tempfile::TempDir, PathBuf, SqliteDomainStore) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let store = SqliteDomainStore::open(root.join("application-state.sqlite3"))
        .await
        .unwrap();
    (temporary, root, store)
}

async fn close_absent(store: SqliteDomainStore, root: PathBuf) -> StandaloneCloseOutcome {
    close_standalone_session(
        store,
        LocalSessionCatalog::new(root),
        "workspace-1".into(),
        "standalone_absent".into(),
        Some("terminal-1".into()),
        Duration::from_millis(1),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn absent_standalone_close_replays_with_an_explicit_reopened_store() {
    let (_temporary, root, store) = fixture().await;
    let mut directory = tempfile::Builder::new();
    directory.prefix("discovery-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        directory.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let discovery = directory.tempdir_in(&root).unwrap();
    let path = discovery.path().to_path_buf();
    assert_eq!(
        close_absent(store, path.clone()).await,
        StandaloneCloseOutcome::AlreadyExited
    );
    let reopened = SqliteDomainStore::open(root.join("application-state.sqlite3"))
        .await
        .unwrap();
    assert_eq!(
        close_absent(reopened.clone(), path.clone()).await,
        StandaloneCloseOutcome::AlreadyExited
    );
    assert!(
        reopened
            .session_checkout_close_targets(
                path.to_str().unwrap(),
                "workspace-1",
                "standalone_absent"
            )
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn absent_standalone_close_does_not_require_or_create_a_discovery_directory() {
    let (_temporary, root, store) = fixture().await;
    let discovery = root.join("never-created-discovery");
    assert!(!discovery.exists());
    assert_eq!(
        close_absent(store, discovery.clone()).await,
        StandaloneCloseOutcome::AlreadyExited
    );
    assert!(!discovery.exists());
}

#[tokio::test]
async fn a_file_in_place_of_discovery_is_not_an_absent_session() {
    let (_temporary, root, store) = fixture().await;
    let discovery = root.join("invalid-discovery");
    std::fs::write(&discovery, b"not a discovery directory").unwrap();
    let result = close_standalone_session(
        store,
        LocalSessionCatalog::new(&discovery),
        "workspace-1".into(),
        "standalone_absent".into(),
        None,
        Duration::from_millis(1),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(
        std::fs::read(&discovery).unwrap(),
        b"not a discovery directory"
    );
}
