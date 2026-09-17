use super::*;

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "workspace-absent".into(),
        session_id: "session-absent".into(),
        runner_principal: "runner".into(),
        runner_instance: "runner-1".into(),
        channel_epoch: 4,
        host_instance_id: "host-absent".into(),
        terminal_epoch: "terminal-absent".into(),
    }
}

#[test]
fn exact_absence_check_does_not_create_a_discovery_registration() {
    let temp = TempDir::new().unwrap();
    let root_path = temp.path().join("hmux");
    let root = DiscoveryRoot::create(&root_path).unwrap();
    drop(root.acquire_maintenance_exclusive().unwrap());
    let entries_before = std::fs::read_dir(&root_path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<BTreeSet<_>>();
    let capacity_before = root.registration_capacity().unwrap();
    let fence = fence();
    assert!(
        LocalSessionCatalog::new(&root_path)
            .exact_session_absence_is_quiescent(&fence)
            .unwrap()
    );
    let entries_after = std::fs::read_dir(&root_path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<BTreeSet<_>>();
    assert_eq!(entries_after, entries_before);
    assert_eq!(root.registration_capacity().unwrap(), capacity_before);
    let key = DiscoveryKey::new(
        &fence.workspace_id,
        &fence.session_id,
        &fence.runner_instance,
        fence.channel_epoch,
    )
    .unwrap();
    assert!(root.open_session_if_present(key).unwrap().is_none());
}

#[test]
fn an_existing_compatibility_root_can_prove_absence_without_creating_a_primary() {
    let temp = TempDir::new().unwrap();
    let primary = temp.path().join("absent-primary");
    let compatibility = temp.path().join("compatibility");
    let catalog =
        LocalSessionCatalog::with_read_only_discovery_roots(&primary, vec![compatibility.clone()])
            .unwrap();
    assert!(
        !catalog
            .exact_session_absence_is_quiescent(&fence())
            .unwrap()
    );
    assert!(!compatibility.exists());
    let root = DiscoveryRoot::create(&compatibility).unwrap();
    let creator = root.acquire_maintenance_shared().unwrap();
    assert!(
        !catalog
            .exact_session_absence_is_quiescent(&fence())
            .unwrap()
    );
    drop(creator);
    assert!(
        catalog
            .exact_session_absence_is_quiescent(&fence())
            .unwrap()
    );
    assert!(!primary.exists());
}
