use std::ffi::OsStr;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::{BackendDispatchError, BackendFailureDispositionV1};

#[derive(Clone, Copy)]
enum Unavailable {
    NotFound,
    NotExecutable,
    LookupFailed,
    PathMissing,
}

impl Unavailable {
    fn error(self) -> BackendDispatchError {
        let (reason, message) = match self {
            Self::NotFound => (
                "provider_executable_not_found",
                "Provider executable not found on the execution host. Install the selected provider there or fix PATH, then retry this request.",
            ),
            Self::NotExecutable => (
                "provider_executable_not_executable",
                "The provider executable cannot run. Check its path and execute permissions on the execution host, then retry this request.",
            ),
            Self::LookupFailed => (
                "provider_executable_lookup_failed",
                "Dure could not inspect the provider executable on the execution host. Check path and access permissions, then retry this request.",
            ),
            Self::PathMissing => (
                "provider_executable_path_missing",
                "PATH is unavailable on the execution host. Restore PATH, then retry this request.",
            ),
        };
        BackendDispatchError {
            code: "workflow_provider_unavailable".into(),
            message: message.into(),
            details: Some(json!({"reasonCode": reason})),
            disposition: BackendFailureDispositionV1::Terminal,
        }
    }
}

fn inspect(path: &Path) -> Result<PathBuf, Unavailable> {
    let canonical = fs::canonicalize(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => Unavailable::NotFound,
        _ => Unavailable::LookupFailed,
    })?;
    let metadata = fs::metadata(&canonical).map_err(|_| Unavailable::LookupFailed)?;
    if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 {
        Ok(canonical)
    } else {
        Err(Unavailable::NotExecutable)
    }
}

pub(super) fn resolve_provider_executable(
    executable: &str,
) -> Result<PathBuf, BackendDispatchError> {
    resolve_on_path(executable, std::env::var_os("PATH").as_deref())
}

fn resolve_on_path(
    executable: &str,
    path: Option<&OsStr>,
) -> Result<PathBuf, BackendDispatchError> {
    let executable_path = Path::new(executable);
    if executable_path.is_absolute() {
        return inspect(executable_path).map_err(Unavailable::error);
    }
    if executable_path.components().count() != 1 || executable_path.file_name().is_none() {
        return Err("workflow_provider_plan_invalid".into());
    }
    let path = path.ok_or_else(|| Unavailable::PathMissing.error())?;
    let mut reason = Unavailable::NotFound;
    for directory in std::env::split_paths(path) {
        match inspect(&directory.join(executable)) {
            Ok(canonical) => return Ok(canonical),
            Err(Unavailable::NotFound) => {}
            Err(failure) => {
                // A failed lookup is unknown, even if another PATH entry is absent
                // or unusable. Continue searching: a later executable still wins.
                if !matches!(reason, Unavailable::LookupFailed) {
                    reason = failure;
                }
            }
        }
    }
    Err(reason.error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_distinguishes_absent_unusable_and_unobserved_without_running_commands() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().as_os_str();
        let missing = resolve_on_path("provider", Some(path)).unwrap_err();
        assert_eq!(
            missing.details.unwrap()["reasonCode"],
            "provider_executable_not_found"
        );
        let unset = resolve_on_path("provider", None).unwrap_err();
        assert_eq!(
            unset.details.unwrap()["reasonCode"],
            "provider_executable_path_missing"
        );
        let executable = root.path().join("provider");
        fs::write(&executable, "not executed").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o600)).unwrap();
        let unusable = resolve_on_path("provider", Some(path)).unwrap_err();
        assert_eq!(
            unusable.details.unwrap()["reasonCode"],
            "provider_executable_not_executable"
        );
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            resolve_on_path("provider", Some(path)).unwrap(),
            executable.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_on_path(executable.to_str().unwrap(), None).unwrap(),
            executable.canonicalize().unwrap()
        );
    }

    #[test]
    fn a_later_executable_wins_but_failed_lookup_is_never_reported_as_missing() {
        let root = tempfile::tempdir().unwrap();
        let unknown = root.path().join("unknown");
        fs::create_dir(&unknown).unwrap();
        std::os::unix::fs::symlink("provider", unknown.join("provider")).unwrap();
        let ready = root.path().join("ready");
        fs::create_dir(&ready).unwrap();
        let path = std::env::join_paths([&unknown, &ready]).unwrap();
        let failure = resolve_on_path("provider", Some(&path)).unwrap_err();
        assert_eq!(
            failure.details.unwrap()["reasonCode"],
            "provider_executable_lookup_failed"
        );
        fs::write(ready.join("provider"), "not executed").unwrap();
        fs::set_permissions(ready.join("provider"), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            resolve_on_path("provider", Some(&path)).unwrap(),
            ready.join("provider").canonicalize().unwrap()
        );
        assert_eq!(
            resolve_on_path("relative/provider", Some(&path))
                .unwrap_err()
                .code,
            "workflow_provider_plan_invalid"
        );
    }
}
