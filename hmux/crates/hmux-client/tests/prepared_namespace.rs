use hmux_client::recovery_journal::{
    PreparedRecoveryIdentity, RecoveryReservationState, prepared_operation_exists, reserve_prepared,
};

fn identity() -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: "prepared-writer".into(),
        source_session_id: "source-session".into(),
        source_workspace_id: "source-workspace".into(),
        legacy_request_fingerprint: None,
        action: "fixture_prepared_operation",
    }
}

#[test]
fn prepared_writer_initializes_its_namespace_and_replays_the_saved_payload() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("new/state/discovery");
    let identity = identity();
    assert!(!prepared_operation_exists(&root, &identity).unwrap());
    assert!(!root.exists());
    let payload = r#"{"command":"frozen"}"#;
    let RecoveryReservationState::Pending(created) =
        reserve_prepared(&root, identity.clone(), Some(payload.into())).unwrap()
    else {
        panic!("new prepared intent must be pending");
    };
    assert_eq!(
        created.operation_checkpoint().unwrap().canonical_payload,
        payload
    );
    drop(created);
    let RecoveryReservationState::Pending(replayed) =
        reserve_prepared(&root, identity, None).unwrap()
    else {
        panic!("the same intent must reopen without new input");
    };
    assert!(replayed.was_existing());
    assert_eq!(
        replayed.operation_checkpoint().unwrap().canonical_payload,
        payload
    );
}

#[test]
fn missing_intent_without_a_payload_does_not_initialize_a_namespace() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("missing");
    assert!(reserve_prepared(&root, identity(), None).is_err());
    assert!(!root.exists());
}

#[cfg(unix)]
#[test]
fn prepared_writer_does_not_follow_a_namespace_symlink() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("target");
    hmux_host::local_discovery::DiscoveryRoot::create(&target).unwrap();
    let alias = directory.path().join("alias");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    assert!(reserve_prepared(&alias, identity(), Some("{}".into())).is_err());
    assert!(!target.join(".recovery").exists());
}
