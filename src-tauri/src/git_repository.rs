//! A bounded repository probe, independent of working-tree status/index health.
use hebbian_bounded_process::{CommandSpec, OutputLimitAction};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RepositoryStatus {
    Repository,
    NotRepository,
    Unknown { detail: String },
}

fn observation(code: i32, stdout: &str, stderr: &str) -> RepositoryStatus {
    if code == 0 && stdout.trim() == "true" {
        RepositoryStatus::Repository
    } else if (code == 0 && stdout.trim() == "false")
        || (code == 128
            && stderr
                .trim_start()
                .starts_with("fatal: not a git repository"))
    {
        RepositoryStatus::NotRepository
    } else {
        RepositoryStatus::Unknown {
            detail: format!("Git repository check exited with {code}: {}", stderr.trim()),
        }
    }
}

fn command(path: &str) -> CommandSpec {
    let mut command = CommandSpec::new("git");
    command.args(["-C", path, "rev-parse", "--is-inside-work-tree"]);
    // Match local Git's repository-routing isolation, while retaining the
    // platform's PATH/toolchain environment. Stable diagnostics classify only
    // Git's explicit non-repository result; all other failures stay unknown.
    command.clear_env();
    for (key, value) in std::env::vars_os() {
        if !key.to_string_lossy().starts_with("GIT_") {
            command.env(key, value);
        }
    }
    command.env("LC_ALL", "C").env("LANGUAGE", "C");
    command
        .capture_stderr(true)
        .on_output_limit(OutputLimitAction::TerminateProcessTree);
    command
}

fn observe(command: &CommandSpec, timeout: Duration) -> RepositoryStatus {
    match hebbian_bounded_process::run(command, timeout, 8 * 1024) {
        Ok(output) => observation(
            output.status.code().unwrap_or(-1),
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(error) => RepositoryStatus::Unknown {
            detail: format!("Git repository check failed: {}", error.stage()),
        },
    }
}

#[tauri::command(async)]
pub fn local_repository_status(path: String) -> RepositoryStatus {
    observe(&command(&path), Duration::from_secs(3))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn a_folder_can_become_a_repository_without_restart_and_with_a_bad_index() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_str().unwrap().to_owned();
        assert_eq!(
            local_repository_status(path.clone()),
            RepositoryStatus::NotRepository
        );
        assert!(Command::new("git")
            .args(["init", "--quiet", &path])
            .status()
            .unwrap()
            .success());
        std::fs::write(root.path().join(".git/index"), b"invalid index").unwrap();
        assert_eq!(local_repository_status(path), RepositoryStatus::Repository);
    }

    #[test]
    fn missing_paths_and_unrecognized_failures_are_not_non_repositories() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            local_repository_status(root.path().join("missing").to_string_lossy().into_owned()),
            RepositoryStatus::Unknown { .. }
        ));
        for (code, stdout, stderr) in [
            (128, "", "fatal: detected dubious ownership in repository"),
            (128, "", "fatal: bad config line"),
            (0, "unexpected", ""),
            (127, "", "git missing"),
        ] {
            assert!(matches!(
                observation(code, stdout, stderr),
                RepositoryStatus::Unknown { .. }
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn timeouts_remain_unknown() {
        let mut command = CommandSpec::new("/bin/sh");
        command.args(["-c", "while :; do :; done"]);
        assert!(matches!(
            observe(&command, Duration::from_millis(30)),
            RepositoryStatus::Unknown { .. }
        ));
    }
}
