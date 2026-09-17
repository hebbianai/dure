//! Optional Git capability on the host that will execute repository commands.
use hebbian_bounded_process::{CommandSpec, OutputLimitAction};
use serde::Serialize;
use std::time::Duration;

const MISSING: &str = "dure_git_missing";
const POSIX_PROBE: &str = "if command -v git >/dev/null 2>&1; then git --version; else printf '%s\\n' dure_git_missing; fi";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum GitAvailability {
    Available,
    Missing,
    Unknown { detail: String },
}

fn observation(code: i32, stdout: &str, stderr: &str) -> GitAvailability {
    if code == 0 && stdout.trim() == MISSING {
        GitAvailability::Missing
    } else if code == 0 && stdout.trim().starts_with("git version ") {
        GitAvailability::Available
    } else {
        GitAvailability::Unknown {
            detail: format!("git --version exited with {code}: {}", stderr.trim()),
        }
    }
}

fn local_command() -> CommandSpec {
    #[cfg(not(windows))]
    let mut command = {
        // No login shell: use exactly the PATH inherited by local Git operations.
        let mut command = CommandSpec::new("/bin/sh");
        command.args(["-c", POSIX_PROBE]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = CommandSpec::new("cmd.exe");
        command.args(["/D", "/C", "git --version"]);
        command
    };
    command.capture_stderr(true).on_output_limit(OutputLimitAction::TerminateProcessTree);
    command
}

fn observe_local(command: &CommandSpec, timeout: Duration) -> GitAvailability {
    match hebbian_bounded_process::run(command, timeout, 8 * 1024) {
        Ok(output) => {
            let code = output.status.code().unwrap_or(-1);
            // cmd.exe reserves 9009 for a command it could not find.
            #[cfg(windows)]
            if code == 9009 {
                return GitAvailability::Missing;
            }
            observation(code, &String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr))
        }
        Err(error) => GitAvailability::Unknown {
            detail: format!("Git availability check failed: {}", error.stage()),
        },
    }
}

#[tauri::command(async)]
pub fn git_availability(opts: Option<crate::ssh::SshOptions>) -> GitAvailability {
    match opts {
        Some(opts) => match crate::ssh::exec_once(&opts, POSIX_PROBE) {
            Ok(output) => observation(output.code, &output.stdout, &output.stderr),
            Err(detail) => GitAvailability::Unknown { detail },
        },
        None => observe_local(&local_command(), PROBE_TIMEOUT),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> (tempfile::TempDir, CommandSpec) {
        let root = tempfile::tempdir().unwrap();
        let mut command = local_command();
        command.clear_env().env("PATH", root.path()).env("HOME", root.path());
        (root, command)
    }

    fn install(root: &std::path::Path, body: &str) {
        let git = root.join("git");
        std::fs::write(&git, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn missing_git_recovers_after_installation_without_a_cached_result() {
        let (root, command) = fixture();
        assert_eq!(observe_local(&command, PROBE_TIMEOUT), GitAvailability::Missing);
        install(root.path(), "printf '%s\\n' 'git version fixture'");
        assert_eq!(observe_local(&command, PROBE_TIMEOUT), GitAvailability::Available);
    }

    #[test]
    fn a_failed_or_timed_out_executable_is_not_reported_as_missing() {
        let (root, command) = fixture();
        install(root.path(), "printf '%s\\n' 'toolchain unavailable' >&2; exit 1");
        assert!(matches!(observe_local(&command, PROBE_TIMEOUT), GitAvailability::Unknown { detail } if detail.contains("toolchain unavailable")));
        install(root.path(), "while :; do :; done");
        assert!(matches!(observe_local(&command, Duration::from_millis(30)), GitAvailability::Unknown { .. }));
    }

    #[test]
    fn remote_failure_and_unrecognized_output_are_not_missing_git() {
        assert_eq!(observation(0, "dure_git_missing\n", ""), GitAvailability::Missing);
        assert_eq!(observation(0, "git version 2.40.0\n", ""), GitAvailability::Available);
        assert!(matches!(observation(255, "", "connection failed"), GitAvailability::Unknown { .. }));
        assert!(matches!(observation(0, "unexpected", ""), GitAvailability::Unknown { .. }));
    }

    #[test]
    fn selected_ssh_transport_failure_stays_unknown_without_local_fallback() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.write_all(b"not an SSH server\r\n");
        });
        let result = git_availability(Some(crate::ssh::SshOptions {
            host: "127.0.0.1".into(), port: Some(port), user: "fixture".into(),
            auth: Some("key".into()), key_path: Some("/no-fixture-key".into()),
            secret_id: None, password: None, passphrase: None, host_key_fingerprints: vec![],
        }));
        server.join().unwrap();
        assert!(matches!(result, GitAvailability::Unknown { .. }));
    }
}
