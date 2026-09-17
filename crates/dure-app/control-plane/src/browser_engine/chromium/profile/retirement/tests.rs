use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

fn selected() -> BrowserProfileIdV1 {
    BrowserProfileIdV1::new("retire:stored-profile").unwrap()
}

fn payload(root: &Path) -> PathBuf {
    let directory = root.join("profile/Default/nested");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("stored-data");
    fs::write(&path, "보존할 데이터").unwrap();
    path
}

#[test]
fn native_claim_blocks_deletion_until_exact_owner_confirms_exit() {
    let directory = tempfile::tempdir().unwrap();
    let id = selected();
    let instance = BrowserInstanceId::new("owner").unwrap();
    let mut native = ProfileClaim::acquire(directory.path(), &id, &instance).unwrap();
    native.started();
    let root = storage_root(directory.path(), &id).unwrap();
    let data = payload(&root);
    let original = fs::read(&native.path).unwrap();
    assert_eq!(
        retire_storage(directory.path(), &id).unwrap_err().code,
        "browser_profile_exit_unconfirmed"
    );
    assert_eq!(fs::read_to_string(&data).unwrap(), "보존할 데이터");
    assert_eq!(fs::read(&native.path).unwrap(), original);
    native.release_after_exit().unwrap();
    retire_storage(directory.path(), &id).unwrap();
    assert!(!data.exists());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(
        ProfileClaim::acquire(directory.path(), &id, &instance)
            .err()
            .unwrap()
            .code,
        "browser_profile_exit_unconfirmed"
    );
    // A repeated old owner's completion cannot unlink the permanent tombstone.
    native.release_after_exit().unwrap();
    assert!(root.join("native-claim.json").is_file());
}

#[test]
fn unknown_malformed_or_foreign_claims_preserve_stored_data() {
    let directory = tempfile::tempdir().unwrap();
    let id = selected();
    let root = storage_root(directory.path(), &id).unwrap();
    let data = payload(&root);
    let path = root.join("native-claim.json");
    for bytes in [
        Vec::new(),
        b"partial json".to_vec(),
        vec![b'x'; 4097],
        br#"{"schemaVersion":1,"kind":"storage_retirement","profileId":"foreign"}"#.to_vec(),
        serde_json::to_vec(&json!({"schemaVersion":2,"kind":"storage_retirement","profileId":id}))
            .unwrap(),
        serde_json::to_vec(
            &json!({"schemaVersion":1,"kind":"storage_retirement","profileId":id,"extra":true}),
        )
        .unwrap(),
    ] {
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            retire_storage(directory.path(), &id).unwrap_err().code,
            "browser_profile_exit_unconfirmed"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read_to_string(&data).unwrap(), "보존할 데이터");
    }
}

#[test]
fn interrupted_partial_retirement_resumes_after_lock_owner_exits() {
    let directory = tempfile::tempdir().unwrap();
    let id = selected();
    let root = storage_root(directory.path(), &id).unwrap();
    let data = payload(&root);
    let other = root.join("already-removed");
    fs::write(&other, b"partial").unwrap();
    let retained = claim(&root, &id).unwrap();
    fs::remove_file(&other).unwrap();
    let marker = fs::read(root.join("native-claim.json")).unwrap();
    assert_eq!(
        retire_storage(directory.path(), &id).unwrap_err().code,
        "browser_profile_deletion_in_progress"
    );
    assert_eq!(fs::read_to_string(&data).unwrap(), "보존할 데이터");
    // Drop simulates the original retirement process ending after a partial pass.
    drop(retained);
    retire_storage(directory.path(), &id).unwrap();
    retire_storage(directory.path(), &id).unwrap();
    assert!(!data.exists());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(fs::read(root.join("native-claim.json")).unwrap(), marker);
}

#[test]
fn storage_removal_unlinks_nested_symlinks_without_following_them() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let id = selected();
    let root = storage_root(directory.path(), &id).unwrap();
    let data = payload(&root);
    let preserved = outside.path().join("preserved");
    fs::write(&preserved, "다른 프로필").unwrap();
    symlink(outside.path(), root.join("external-directory")).unwrap();
    symlink(
        outside.path(),
        data.parent().unwrap().join("external-directory"),
    )
    .unwrap();
    symlink(&preserved, root.join("external-file")).unwrap();
    retire_storage(directory.path(), &id).unwrap();
    assert_eq!(fs::read_to_string(&preserved).unwrap(), "다른 프로필");
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn retirement_rejects_symlinked_claim_and_storage_root() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let id = selected();
    let root = storage_root(directory.path(), &id).unwrap();
    let data = payload(&root);
    let foreign = outside.path().join("claim");
    fs::write(&foreign, b"untouched").unwrap();
    symlink(&foreign, root.join("native-claim.json")).unwrap();
    assert_eq!(
        retire_storage(directory.path(), &id).unwrap_err().code,
        "browser_profile_storage_unavailable"
    );
    assert_eq!(fs::read_to_string(&data).unwrap(), "보존할 데이터");
    assert_eq!(fs::read(&foreign).unwrap(), b"untouched");
    let retained = root.with_extension("fixture-retained");
    fs::rename(&root, &retained).unwrap();
    symlink(outside.path(), &root).unwrap();
    assert_eq!(
        retire_storage(directory.path(), &id).unwrap_err().code,
        "browser_profile_storage_unavailable"
    );
    assert_eq!(
        fs::read_to_string(retained.join("profile/Default/nested/stored-data")).unwrap(),
        "보존할 데이터"
    );
    assert_eq!(fs::read(&foreign).unwrap(), b"untouched");
}
