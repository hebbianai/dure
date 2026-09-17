use super::*;

fn retire_creation(root: &DiscoveryRoot, index: u64, create_key: &str) -> ManifestGeneration {
    let session = session_for_generation(root, index);
    let lock = session.acquire_lifetime_lock().unwrap();
    let (mut starting, mut exited) = replacement_generation(index);
    starting.common.claim_linkage.kickoff_action_id = Some(create_key.into());
    exited.common = starting.common.clone();
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited).unwrap();
    assert!(session.retire_exited_current(&lock, &generation).unwrap());
    generation
}

#[test]
fn retired_creation_lookup_recovers_only_its_exact_key_without_restoring_discovery() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let generation = retire_creation(&root, 1, "create-1");
    let found = root
        .find_retired_creation("workspace", "session", "create-1")
        .unwrap()
        .unwrap();
    assert_eq!(found.manifest.generation(), generation);
    assert_eq!(found.key, session_for_generation(&root, 1).key);
    assert!(
        session_for_generation(&root, 1)
            .try_read_manifest()
            .unwrap()
            .is_none()
    );
    for (workspace, session, key) in [
        ("workspace", "session", "different-create"),
        ("other-workspace", "session", "create-1"),
        ("workspace", "other-session", "create-1"),
    ] {
        assert!(
            root.find_retired_creation(workspace, session, key)
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn retired_creation_lookup_leaves_a_different_current_generation_unchanged() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let retired = retire_creation(&root, 1, "create-1");
    retire_creation(&root, 2, "create-2");
    let current = publish_ready_session(&root, "runner-current", 3, "host-current");
    let before = current.read_manifest().unwrap();
    assert_eq!(
        root.find_retired_creation("workspace", "session", "create-1")
            .unwrap()
            .unwrap()
            .manifest
            .generation(),
        retired
    );
    assert_eq!(current.read_manifest().unwrap(), before);
}

#[test]
fn starting_admission_preserves_retirement_without_blocking_new_or_unkeyed_creates() {
    for class in [SessionClass::Managed, SessionClass::Standalone] {
        for create_key in [None, Some("original-create")] {
            let temp = TempDir::new().unwrap();
            let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
            let prepare = |index| {
                let (mut starting, mut exited) = replacement_generation(index);
                starting.common.session_class = class;
                starting.common.session_name =
                    (class == SessionClass::Standalone).then(|| "standalone".into());
                starting.common.claim_linkage.kickoff_action_id = create_key.map(str::to_owned);
                exited.common = starting.common.clone();
                (starting, exited)
            };
            let source = session_for_generation(&root, 1);
            let lock = source.acquire_lifetime_lock().unwrap();
            let (starting, exited) = prepare(1);
            let retired = DiscoveryManifest::Exited(exited.clone()).generation();
            source.publish_starting(&lock, starting).unwrap();
            source.publish_exited(&lock, exited).unwrap();
            assert!(source.retire_exited_current(&lock, &retired).unwrap());
            drop(lock);

            let delayed = session_for_generation(&root, 2);
            let lock = delayed.acquire_lifetime_lock().unwrap();
            let result = delayed.publish_starting(&lock, prepare(2).0);
            if class == SessionClass::Standalone && create_key.is_some() {
                assert!(matches!(
                    result,
                    Err(DiscoveryError::InvalidManifestTransition {
                        from: "retired",
                        to: "starting",
                    })
                ));
                assert!(delayed.try_read_manifest().unwrap().is_none());
                drop(lock);
                let fresh = session_for_generation(&root, 3);
                let lock = fresh.acquire_lifetime_lock().unwrap();
                let (mut starting, _) = prepare(3);
                starting.common.claim_linkage.kickoff_action_id = Some("new-create".into());
                fresh.publish_starting(&lock, starting.clone()).unwrap();
                fresh.publish_starting(&lock, starting).unwrap();
                assert_eq!(
                    root.find_retired_creation("workspace", "session", "original-create")
                        .unwrap()
                        .unwrap()
                        .manifest
                        .generation(),
                    retired
                );
            } else {
                // Managed creation retains its own ledger semantics. Legacy
                // unkeyed standalone resurrection still permits a new lifetime.
                result.unwrap();
            }
        }
    }
}

#[test]
fn retired_creation_lookup_refuses_ambiguous_generations_for_one_create() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    retire_creation(&root, 1, "same-create");
    retire_creation(&root, 2, "same-create");
    assert!(matches!(
        root.find_retired_creation("workspace", "session", "same-create"),
        Err(DiscoveryError::GenerationMismatch)
    ));
}

#[test]
fn retired_creation_lookup_uses_retirement_capacity_not_live_session_capacity() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create_with_limits(
        temp.path().join("hmux"),
        ManifestLimits {
            max_session_lookup_entries: 1,
            max_retired_manifest_entries: 4,
            ..ManifestLimits::default()
        },
    )
    .unwrap();
    let expected = retire_creation(&root, 1, "create-1");
    retire_creation(&root, 2, "create-2");
    assert_eq!(
        root.find_retired_creation("workspace", "session", "create-1")
            .unwrap()
            .unwrap()
            .manifest
            .generation(),
        expected
    );
}

#[test]
fn retired_creation_lookup_does_not_treat_corrupt_history_as_absence() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    retire_creation(&root, 1, "create-1");
    create_retired_corruption(&session_for_generation(&root, 1), "corrupt.json");
    assert!(
        root.find_retired_creation("workspace", "session", "create-1")
            .is_err()
    );
    assert!(
        root.find_retired_creation("workspace", "session", "missing-create")
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn retired_creation_lookup_does_not_follow_a_symlinked_history_entry() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    retire_creation(&root, 1, "create-1");
    let history = session_for_generation(&root, 1)
        .path()
        .join(RETIRED_DIRECTORY_NAME);
    let manifest = fs::read_dir(&history)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::os::unix::fs::symlink(&manifest, history.join("alias.json")).unwrap();
    assert!(matches!(
        root.find_retired_creation("workspace", "session", "create-1"),
        Err(DiscoveryError::Security { .. })
    ));
}
