use super::*;
use std::io::Write;

#[test]
fn metadata_and_identity_match_the_private_open_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("private-file");
    let mut file = open_new_file(&path).unwrap();
    file.write_all(b"private metadata").unwrap();

    let snapshot = file_metadata(&path).unwrap();
    assert_eq!(snapshot.identity, open_file_identity(&path, &file).unwrap());
    assert_eq!(snapshot.identity, file_identity(&path).unwrap());
    assert_eq!(snapshot.metadata.len(), 16);
    assert_eq!(
        snapshot.metadata.modified().unwrap(),
        file.metadata().unwrap().modified().unwrap()
    );
}

#[test]
fn metadata_refuses_a_directory_or_missing_file() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("private-directory");
    create_directory(&directory).unwrap();
    assert!(file_metadata(&directory).is_err());
    assert!(file_metadata(&temp.path().join("missing")).is_err());
}

#[cfg(unix)]
#[test]
fn metadata_refuses_symlinks_and_nonprivate_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("private-file");
    let alias = temp.path().join("alias");
    open_new_file(&path).unwrap();
    symlink(&path, &alias).unwrap();
    assert!(file_metadata(&alias).is_err());

    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(file_metadata(&path).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(file_metadata(&path).is_ok());
}
