use super::*;

#[test]
fn recovery_fences_other_recovery_and_acquire_and_never_removes_a_replacement() {
    let root = tempfile::tempdir().unwrap();
    let id = BrowserProfileIdV1::new("concurrent-recovery").unwrap();
    let instance = BrowserInstanceId::new("previous-instance").unwrap();
    let mut claim = ProfileClaim::acquire(root.path(), &id, &instance).unwrap();
    claim.prepare_launch().unwrap();
    let path = claim.path.clone();
    drop(claim);
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["boot"] = "00000000-0000-0000-0000-000000000000".into();
    fs::write(&path, record.to_string()).unwrap();
    let recovery = Recovery::inspect(root.path(), &id).unwrap().unwrap();
    assert_eq!(recovery.state, RecoveryState::Recoverable);
    assert_eq!(
        recover_storage(root.path(), &id).unwrap_err().code,
        "browser_profile_recovery_in_progress"
    );
    assert_eq!(
        ProfileClaim::acquire(root.path(), &id, &instance)
            .err()
            .unwrap()
            .code,
        "browser_profile_exit_unconfirmed"
    );
    fs::rename(&path, path.with_extension("old")).unwrap();
    fs::write(&path, b"replacement claim").unwrap();
    assert_eq!(
        recovery.recover().unwrap_err().code,
        "browser_profile_recovery_unconfirmed"
    );
    assert_eq!(fs::read(&path).unwrap(), b"replacement claim");
    assert!(path.with_file_name(evidence::LAUNCH).exists());
}

#[test]
fn symlink_and_invalid_boot_evidence_fail_closed() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let id = BrowserProfileIdV1::new("invalid-recovery").unwrap();
    let instance = BrowserInstanceId::new("instance").unwrap();
    let mut claim = ProfileClaim::acquire(root.path(), &id, &instance).unwrap();
    claim.prepare_launch().unwrap();
    let path = claim.path.clone();
    drop(claim);
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["boot"] = "invalid".into();
    fs::write(&path, record.to_string()).unwrap();
    assert_eq!(
        recovery_status(root.path(), &id),
        RecoveryState::Unconfirmed
    );
    let foreign = root.path().join("foreign");
    fs::rename(&path, &foreign).unwrap();
    symlink(&foreign, &path).unwrap();
    assert!(recover_storage(root.path(), &id).is_err());
    assert!(foreign.is_file());
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
}
