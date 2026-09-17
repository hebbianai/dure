use hmux_host::local_discovery::{DiscoveryError, SecurityViolation, private_storage as legacy};
use hmux_local_platform::private_storage::{self as storage, StorageError};
use std::io::{Read, Write};

#[test]
fn replacement_preserves_open_readers_and_refuses_the_previous_file_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("state");
    storage::create_directory(&directory).unwrap();
    let path = directory.join("record");
    let replacement = directory.join("replacement");
    let mut original = storage::open_new_file(&path).unwrap();
    original.write_all(b"prepared").unwrap();
    original.sync_all().unwrap();
    drop(original);
    let mut previous = legacy::open_existing_file(&path).unwrap();
    let previous_identity = legacy::file_identity(&path).unwrap();
    let mut next = legacy::open_new_file(&replacement).unwrap();
    next.write_all(b"completed").unwrap();
    next.sync_all().unwrap();
    drop(next);
    let expected: legacy::PrivateFileIdentity = storage::file_identity(&replacement).unwrap();

    storage::replace_file(&replacement, &path).unwrap();
    storage::sync_directory(&directory).unwrap();

    assert_eq!(legacy::file_identity(&path).unwrap(), expected);
    assert_ne!(previous_identity, expected);
    let mut contents = String::new();
    previous.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "prepared");
    contents.clear();
    legacy::open_existing_file(&path)
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    assert_eq!(contents, "completed");
    assert!(matches!(
        storage::open_file_identity(&path, &previous),
        Err(StorageError::Security {
            violation: SecurityViolation::ReplacedDuringOpen,
            ..
        })
    ));
    assert!(matches!(
        legacy::open_file_identity(&path, &previous),
        Err(DiscoveryError::Security {
            violation: SecurityViolation::ReplacedDuringOpen,
            ..
        })
    ));
}

#[test]
fn missing_file_keeps_the_original_io_cause_and_path() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("absent");
    let error = storage::open_existing_file(&path).unwrap_err();
    let StorageError::Io {
        operation, source, ..
    } = &error
    else {
        panic!("missing is an IO observation, not a security decision");
    };
    let expected_operation = *operation;
    let expected_os_error = source.raw_os_error();
    let DiscoveryError::Io {
        operation,
        path: actual,
        source,
    } = DiscoveryError::from(error)
    else {
        panic!("the compatibility boundary must preserve the IO cause");
    };
    assert_eq!(operation, expected_operation);
    assert_eq!(actual, path);
    assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(source.raw_os_error(), expected_os_error);
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn both_consumers_refuse_insecure_paths_without_repairing_them() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("private");
    let link = temporary.path().join("link");
    legacy::create_directory(&target).unwrap();
    symlink(&target, &link).unwrap();
    assert!(matches!(
        storage::validate_directory(&link),
        Err(StorageError::Security {
            violation: SecurityViolation::Symlink,
            ..
        })
    ));
    assert!(matches!(
        legacy::validate_directory(&link),
        Err(DiscoveryError::Security {
            violation: SecurityViolation::Symlink,
            ..
        })
    ));
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        storage::create_directory(&target),
        Err(StorageError::Security {
            violation: SecurityViolation::WrongMode {
                expected: 0o700,
                actual: 0o755
            },
            ..
        })
    ));
    assert!(matches!(
        legacy::create_directory(&target),
        Err(DiscoveryError::Security {
            violation: SecurityViolation::WrongMode {
                expected: 0o700,
                actual: 0o755
            },
            ..
        })
    ));
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o755
    );
}
