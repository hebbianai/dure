use super::*;

fn identity() -> SessionCatalogIdentity {
    SessionCatalogIdentity::new("workspace", "target").unwrap()
}

#[test]
fn unrelated_competing_generations_are_not_part_of_exact_create_admission() {
    let temp = TempDir::new().unwrap();
    let first = DiscoveryRoot::create(temp.path().join("first")).unwrap();
    let second = DiscoveryRoot::create(temp.path().join("second")).unwrap();
    // Both components matter: neither a matching workspace nor session alone
    // makes a legacy identity relevant to this create request.
    for (workspace, session) in [("workspace", "other"), ("other", "target")] {
        publish_ready(&first, workspace, session, "first-token");
        publish_ready(&second, workspace, session, "second-token");
    }
    let canonical = temp.path().join("canonical");
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        &canonical,
        vec![first.path().into(), second.path().into()],
    )
    .unwrap();
    assert!(matches!(
        catalog.list(),
        Err(ClientError::AmbiguousDiscoveryGeneration { .. })
    ));
    assert!(
        !catalog
            .has_read_only_migration_session(&identity())
            .unwrap()
    );
    assert!(!canonical.exists());
    publish_ready(&second, "workspace", "target", "target-token");
    assert!(
        catalog
            .has_read_only_migration_session(&identity())
            .unwrap()
    );
}

#[test]
fn exact_ready_and_exited_legacy_identities_remain_reserved() {
    let temp = TempDir::new().unwrap();
    for exited in [false, true] {
        let legacy = DiscoveryRoot::create(temp.path().join(exited.to_string())).unwrap();
        if exited {
            publish_exited_for(&legacy, "workspace", "target", "token");
        } else {
            publish_ready(&legacy, "workspace", "target", "token");
        }
        let manifest = legacy
            .session_base_path(&SessionLookupKey::new("workspace", "target").unwrap())
            .join("manifest.json");
        let before = std::fs::read(&manifest).unwrap();
        let canonical = temp.path().join("canonical");
        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            &canonical,
            vec![legacy.path().into()],
        )
        .unwrap();
        assert!(
            catalog
                .has_read_only_migration_session(&identity())
                .unwrap()
        );
        assert_eq!(std::fs::read(&manifest).unwrap(), before);
        assert!(!canonical.exists());
    }
}

#[test]
fn absent_roots_are_not_created_and_canonical_identity_is_not_legacy() {
    let temp = TempDir::new().unwrap();
    let canonical = temp.path().join("canonical");
    let legacy = temp.path().join("legacy");
    let catalog =
        LocalSessionCatalog::with_read_only_discovery_roots(&canonical, vec![legacy.clone()])
            .unwrap();
    assert!(
        !catalog
            .has_read_only_migration_session(&identity())
            .unwrap()
    );
    assert!(!canonical.exists());
    assert!(!legacy.exists());
    publish_ready(
        &DiscoveryRoot::create(&canonical).unwrap(),
        "workspace",
        "target",
        "token",
    );
    assert!(
        !catalog
            .has_read_only_migration_session(&identity())
            .unwrap()
    );
    assert!(!legacy.exists());
}

#[test]
fn malformed_exact_manifest_cannot_authorize_another_create() {
    let temp = TempDir::new().unwrap();
    let legacy = DiscoveryRoot::create(temp.path().join("legacy")).unwrap();
    publish_ready(&legacy, "workspace", "target", "token");
    let manifest = legacy
        .session_base_path(&SessionLookupKey::new("workspace", "target").unwrap())
        .join("manifest.json");
    std::fs::write(&manifest, b"not a manifest").unwrap();
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        temp.path().join("canonical"),
        vec![legacy.path().into()],
    )
    .unwrap();
    assert!(
        catalog
            .has_read_only_migration_session(&identity())
            .is_err()
    );
    assert_eq!(std::fs::read(&manifest).unwrap(), b"not a manifest");
}

#[cfg(unix)]
#[test]
fn unsafe_root_or_exact_path_cannot_prove_absence() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let legacy = DiscoveryRoot::create(temp.path().join("legacy")).unwrap();
    publish_ready(&legacy, "workspace", "other", "token");
    let linked_root = temp.path().join("linked");
    symlink(legacy.path(), &linked_root).unwrap();
    let invalid_root = temp.path().join("file");
    std::fs::write(&invalid_root, b"not a root").unwrap();
    for path in [linked_root, invalid_root] {
        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            temp.path().join("canonical"),
            vec![path],
        )
        .unwrap();
        assert!(matches!(
            catalog.has_read_only_migration_session(&identity()),
            Err(ClientError::Discovery(DiscoveryError::Security { .. }))
        ));
    }
    let target = legacy.session_base_path(&SessionLookupKey::new("workspace", "target").unwrap());
    symlink(
        legacy.session_base_path(&SessionLookupKey::new("workspace", "other").unwrap()),
        &target,
    )
    .unwrap();
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        temp.path().join("canonical"),
        vec![legacy.path().into()],
    )
    .unwrap();
    assert!(
        catalog
            .has_read_only_migration_session(&identity())
            .is_err()
    );
    assert!(
        std::fs::symlink_metadata(target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
