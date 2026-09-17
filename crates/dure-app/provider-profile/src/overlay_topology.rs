//! Reviewed provider-profile overlay topology.

use super::{OverlayPolicy, require_canonical_entry, sync_parent_directory, typed_error};
use std::fs::{DirBuilder, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub(super) fn reserve_reviewed_sources(
    canonical: &Path,
    policy: &OverlayPolicy,
) -> Result<(), String> {
    for name in policy.shared_directories {
        reserve_directory(&canonical.join(name))?;
    }
    for name in policy.append_files {
        reserve_append_file(&canonical.join(name))?;
    }
    Ok(())
}

fn reserve_directory(path: &Path) -> Result<(), String> {
    let created = match std::fs::symlink_metadata(path) {
        Ok(_) => false,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match DirBuilder::new().mode(0o700).create(path) {
                Ok(()) => {
                    if let Err(error) =
                        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                    {
                        let _ = std::fs::remove_dir(path);
                        return Err(typed_error(
                            "credential_overlay_io",
                            format!("secure canonical shared directory: {error}"),
                        ));
                    }
                    true
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => false,
                Err(error) => {
                    return Err(typed_error(
                        "credential_overlay_io",
                        format!("reserve canonical shared directory: {error}"),
                    ));
                }
            }
        }
        Err(error) => {
            return Err(typed_error(
                "credential_overlay_io",
                format!("inspect canonical shared directory: {error}"),
            ));
        }
    };
    require_canonical_entry(path, true)?;
    if created {
        sync_parent_directory(path)?;
    }
    Ok(())
}

fn reserve_append_file(path: &Path) -> Result<(), String> {
    let created = match std::fs::symlink_metadata(path) {
        Ok(_) => false,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
            {
                Ok(file) => {
                    if let Err(error) =
                        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                    {
                        drop(file);
                        let _ = std::fs::remove_file(path);
                        return Err(typed_error(
                            "credential_overlay_io",
                            format!("secure canonical append file: {error}"),
                        ));
                    }
                    if let Err(error) = file.sync_all() {
                        drop(file);
                        let _ = std::fs::remove_file(path);
                        return Err(typed_error(
                            "credential_overlay_io",
                            format!("sync canonical append file: {error}"),
                        ));
                    }
                    true
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => false,
                Err(error) => {
                    return Err(typed_error(
                        "credential_overlay_io",
                        format!("reserve canonical append file: {error}"),
                    ));
                }
            }
        }
        Err(error) => {
            return Err(typed_error(
                "credential_overlay_io",
                format!("inspect canonical append file: {error}"),
            ));
        }
    };
    require_canonical_entry(path, false)?;
    if created {
        sync_parent_directory(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{
        CODEX_APPEND_FILES, CODEX_SHARED_DIRECTORIES, prepare_codex_overlay_for_test,
    };
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[test]
    fn empty_canonical_profile_reserves_exact_topology_before_provider_launch() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();

        prepare_codex_overlay_for_test(&home, &account, None).unwrap();

        let canonical = std::fs::canonicalize(canonical).unwrap();
        for name in CODEX_SHARED_DIRECTORIES {
            let source = canonical.join(name);
            let source_metadata = std::fs::symlink_metadata(&source).unwrap();
            assert!(source_metadata.is_dir());
            assert!(!source_metadata.file_type().is_symlink());
            assert_eq!(source_metadata.permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::read_link(account.join(name)).unwrap(), source);
        }
        for name in CODEX_APPEND_FILES {
            let source = std::fs::metadata(canonical.join(name)).unwrap();
            let overlay = std::fs::metadata(account.join(name)).unwrap();
            assert_eq!((source.dev(), source.ino()), (overlay.dev(), overlay.ino()));
            assert_eq!(source.permissions().mode() & 0o777, 0o600);
        }

        std::fs::write(account.join("sessions/provider-created"), b"shared").unwrap();
        assert_eq!(
            std::fs::read(canonical.join("sessions/provider-created")).unwrap(),
            b"shared"
        );
    }

    #[test]
    fn existing_codex_profile_converges_onto_canonical_standalone_tooling() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("auth.json"), b"canonical auth").unwrap();
        std::fs::write(account.join("auth.json"), b"work auth").unwrap();

        prepare_codex_overlay_for_test(&home, &account, None).unwrap();
        assert!(!account.join("packages").exists());

        let standalone = canonical.join("packages/standalone");
        std::fs::create_dir_all(standalone.join("current")).unwrap();
        std::fs::write(standalone.join("current/codex"), b"provider binary").unwrap();

        let interrupted = prepare_codex_overlay_for_test(&home, &account, Some(2)).unwrap_err();
        assert!(interrupted.starts_with("credential_overlay_fault_injected:"));
        assert!(!account.join("packages").exists());

        prepare_codex_overlay_for_test(&home, &account, None).unwrap();

        assert_eq!(
            std::fs::read_link(account.join("packages/standalone")).unwrap(),
            std::fs::canonicalize(standalone).unwrap()
        );
        assert_eq!(
            std::fs::read(account.join("packages/standalone/current/codex")).unwrap(),
            b"provider binary"
        );
        assert_eq!(
            std::fs::read(account.join("auth.json")).unwrap(),
            b"work auth"
        );
        assert_eq!(
            std::fs::read(canonical.join("auth.json")).unwrap(),
            b"canonical auth"
        );

        let second_account = home.join(".dure/accounts/codex-personal");
        std::fs::create_dir(&second_account).unwrap();
        prepare_codex_overlay_for_test(&home, &second_account, None).unwrap();
        assert_eq!(
            std::fs::read_link(second_account.join("packages/standalone")).unwrap(),
            std::fs::canonicalize(canonical.join("packages/standalone")).unwrap()
        );
    }

    #[test]
    fn canonical_tooling_rejects_a_symlinked_parent_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        let external_packages = tmp.path().join("external-packages");
        std::fs::create_dir(&external_packages).unwrap();
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::os::unix::fs::symlink(&external_packages, canonical.join("packages")).unwrap();

        let error = prepare_codex_overlay_for_test(&home, &account, None).unwrap_err();

        assert!(error.starts_with("credential_overlay_source_untrusted:"));
        assert!(!account.join("packages").exists());
    }

    #[test]
    fn private_entry_cannot_claim_an_absent_canonical_shared_path() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(account.join("sessions")).unwrap();
        std::fs::write(account.join("sessions/private"), b"preserve").unwrap();

        let error = prepare_codex_overlay_for_test(&home, &account, None).unwrap_err();

        assert!(error.starts_with("credential_overlay_wrong_type:"));
        assert_eq!(
            std::fs::read(account.join("sessions/private")).unwrap(),
            b"preserve"
        );
        assert!(canonical.join("sessions").is_dir());
    }
}
