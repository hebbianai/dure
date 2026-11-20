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

/// Validate the program through its resolved target, but return the stable
/// location that was named or found on PATH. Package managers (Homebrew casks,
/// native installers, version managers) point a PATH symlink at a versioned
/// directory and delete that directory on upgrade, so the canonical target must
/// never be recorded in a launch or rehost recipe that outlives this call.
fn inspect(path: &Path) -> Result<PathBuf, Unavailable> {
    let canonical = fs::canonicalize(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => Unavailable::NotFound,
        _ => Unavailable::LookupFailed,
    })?;
    let metadata = fs::metadata(&canonical).map_err(|_| Unavailable::LookupFailed)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(Unavailable::NotExecutable);
    }
    // A relative PATH entry has no stable absolute spelling of its own.
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical
    })
}

/// Whether a recorded absolute program is proven gone or unusable now, by the
/// same checks a new launch applies. A failed lookup proves nothing.
pub(crate) fn recorded_program_unavailable(program: &Path) -> bool {
    matches!(
        inspect(program),
        Err(Unavailable::NotFound | Unavailable::NotExecutable)
    )
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

/// A bounded metadata probe through the shared process owner. This never starts
/// a conversation and never receives an account's credential environment.
pub(super) async fn require_version_range(
    executable: &str,
    minimum: [u64; 3],
    maximum_exclusive: [u64; 3],
) -> Result<(), String> {
    use hebbian_bounded_process::{CommandSpec, OutputLimitAction, run_async};
    let executable = resolve_provider_executable(executable).map_err(|error| error.code)?;
    let mut command = CommandSpec::new(executable);
    command
        .arg("--version")
        .clear_env()
        .on_output_limit(OutputLimitAction::TerminateProcessTree);
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    let output = run_async(
        &command,
        std::time::Duration::from_secs(3),
        4096,
        tokio::time::sleep,
    )
    .await
    .map_err(|_| "agent_project_move_provider_version_unavailable")?;
    if !output.status.success() || !version_in_range(&output.stdout, minimum, maximum_exclusive) {
        return Err("agent_project_move_provider_version_unsupported".into());
    }
    Ok(())
}

fn version_in_range(output: &[u8], minimum: [u64; 3], maximum_exclusive: [u64; 3]) -> bool {
    let Some(version) = std::str::from_utf8(output)
        .ok()
        .and_then(|output| output.split_whitespace().next())
    else {
        return false;
    };
    let parts = version
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(parts) = parts else {
        return false;
    };
    let Ok(version) = <[u64; 3]>::try_from(parts) else {
        return false;
    };
    version >= minimum && version < maximum_exclusive
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_move_version_requires_known_supported_cross_project_resume() {
        for version in ["2.1.223 (Claude Code)", "2.1.284 (Claude Code)"] {
            assert!(version_in_range(
                version.as_bytes(),
                [2, 1, 223],
                [2, 1, 285]
            ));
        }
        for version in [
            "2.1.222 (Claude Code)",
            "2.1.285 (Claude Code)",
            "2.1.296 (Claude Code)",
            "3.0.0",
            "1.9.999",
            "unknown",
            "2.1",
            "2.1.223-dev",
            "999999999999999999999.0.0",
        ] {
            assert!(!version_in_range(
                version.as_bytes(),
                [2, 1, 223],
                [2, 1, 285]
            ));
        }
    }

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
        assert_eq!(resolve_on_path("provider", Some(path)).unwrap(), executable);
        assert_eq!(
            resolve_on_path(executable.to_str().unwrap(), None).unwrap(),
            executable
        );
    }

    #[test]
    fn a_symlinked_install_resolves_to_its_stable_path_entry_across_upgrades() {
        // Homebrew casks and the native installers put a stable PATH symlink in
        // front of a versioned directory and remove that directory on upgrade.
        // A launch recipe recorded from the resolved path must survive that.
        let root = tempfile::tempdir().unwrap();
        let install = |version: &str| {
            let directory = root.path().join("versions").join(version);
            fs::create_dir_all(&directory).unwrap();
            let executable = directory.join("provider");
            fs::write(&executable, "not executed").unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            executable
        };
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let stable = bin.join("provider");
        std::os::unix::fs::symlink(install("1.0.0"), &stable).unwrap();

        let recorded = resolve_on_path("provider", Some(bin.as_os_str())).unwrap();
        assert_eq!(recorded, stable);
        assert_eq!(
            resolve_on_path(stable.to_str().unwrap(), None).unwrap(),
            stable
        );

        let upgraded = install("1.0.1");
        fs::remove_dir_all(root.path().join("versions/1.0.0")).unwrap();
        fs::remove_file(&stable).unwrap();
        std::os::unix::fs::symlink(&upgraded, &stable).unwrap();
        assert_eq!(
            resolve_on_path(recorded.to_str().unwrap(), None).unwrap(),
            stable,
            "the recorded program must still resolve after the upgrade"
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
            ready.join("provider")
        );
        assert_eq!(
            resolve_on_path("relative/provider", Some(&path))
                .unwrap_err()
                .code,
            "workflow_provider_plan_invalid"
        );
    }
}
