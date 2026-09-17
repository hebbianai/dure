use super::*;

#[test]
fn a_missing_suffix_keeps_the_same_namespace_without_creating_directories() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing/nested");
    let expected = root.path().canonicalize().unwrap().join("missing/nested");
    assert_eq!(
        runtime_namespace(&missing).unwrap(),
        expected.to_str().unwrap()
    );
    assert!(!missing.parent().unwrap().exists());
    std::fs::create_dir_all(&missing).unwrap();
    assert_eq!(
        runtime_namespace(&missing).unwrap(),
        expected.to_str().unwrap()
    );
}

#[test]
fn invalid_path_components_are_not_reinterpreted_as_an_absent_namespace() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("file");
    std::fs::write(&file, b"fixture").unwrap();
    assert!(runtime_namespace(&file.join("discovery")).is_err());
    assert!(runtime_namespace(&root.path().join("missing/../discovery")).is_err());
}

#[cfg(unix)]
#[test]
fn an_existing_parent_alias_resolves_but_a_dangling_alias_does_not() {
    let root = tempfile::tempdir().unwrap();
    let actual = root.path().join("actual");
    std::fs::create_dir(&actual).unwrap();
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&actual, &alias).unwrap();
    assert_eq!(
        runtime_namespace(&alias.join("missing")).unwrap(),
        runtime_namespace(&actual.join("missing")).unwrap()
    );
    std::fs::remove_dir(&actual).unwrap();
    assert!(runtime_namespace(&alias).is_err());
    assert!(runtime_namespace(&alias.join("missing")).is_err());
}

#[cfg(unix)]
#[test]
fn a_non_utf8_namespace_cannot_become_a_different_database_key() {
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir().unwrap();
    let missing = root
        .path()
        .join(std::ffi::OsStr::from_bytes(b"discovery-\xff"));
    assert_eq!(
        runtime_namespace(&missing).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(!missing.exists());
}
