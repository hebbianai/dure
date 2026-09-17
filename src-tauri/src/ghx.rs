//! GitHub CLI(`gh`) 실행기.
//!
//! 인증을 우리가 만들지 않는다 — `gh`에 전부 위임한다. 토큰 보관·갱신·GHES를
//! gh가 이미 하고, 우리가 토큰을 들고 있으면 Keychain 사고 반경만 넓어진다
//! (소유자 결정 2026-08-02, 레퍼런스: Orca v1.4.98 `src/main/github/`도 자체
//! OAuth 없이 gh CLI에만 의존한다).
//!
//! 여기는 실행만 맡는다. 출력 파싱은 TS 순수 모듈(src/lib/github/)이 하고
//! vitest로 잠근다 — `gh auth status`는 자유 형식 텍스트라 파싱이 깨지기 쉽고,
//! Rust 안에 두면 테스트가 무거워진다.

#[cfg(unix)]
use crate::provider_preflight::{resolve_login_command_environment, LoginCommandEnvironmentError};
#[cfg(unix)]
use hmux_client::TerminalEnvironment;
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Serialize, Clone, Default)]
pub struct GhExecOut {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    /// 제한 시간 안에 끝나지 않아 강제 종료했다.
    pub timed_out: bool,
    /// `gh`를 아예 찾지 못했다 — 미인증과 구분해야 안내가 달라진다.
    pub missing: bool,
}

/// gh가 사람을 기다리지 않게 고정한다.
///
/// 대화형 프롬프트 하나가 뜨면 자식이 영원히 멈추고, 그걸 기다리는 UI도 같이
/// 멈춘다. 페이저도 같은 이유로 끈다 — gh는 TTY가 아니면 대개 끄지만 사용자
/// 설정(GH_PAGER, core.pager)이 살아 있을 수 있다.
/// One list for every `gh` the app runs (here and the issue-tracker host),
/// so a prompt-disabling variable cannot be forgotten by one caller. The
/// last entry keeps credential prompts from grabbing a terminal as well.
pub(crate) const NON_INTERACTIVE_ENVIRONMENT: [(&str, &str); 7] = [
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GH_PAGER", "cat"),
    ("PAGER", "cat"),
    ("NO_COLOR", "1"),
    ("CLICOLOR", "0"),
    ("GIT_TERMINAL_PROMPT", "0"),
];

fn non_interactive(command: &mut Command) {
    for (key, value) in NON_INTERACTIVE_ENVIRONMENT {
        command.env(key, value);
    }
}

/// `gh`를 실행하고 stdout/stderr/exit code를 그대로 돌려준다.
///
/// 0이 아닌 종료를 에러로 올리지 않는다 — "미인증", "스코프 부족", "레포 아님"이
/// 전부 정상적인 결과이고 호출부가 stderr를 보고 안내를 정해야 한다.
///
/// `timeout_ms`는 선택이 아니다. 멈춘 gh 자식 하나가 다이얼로그 전체를 잠그면
/// 사용자는 원인을 못 찾는다 — 반드시 눈에 보이게 실패시킨다.
pub fn exec(repo: Option<&str>, args: &[String], timeout_ms: u64) -> GhExecOut {
    let cwd = match repo
        .map(std::path::PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)
    {
        Ok(cwd) => cwd,
        Err(error) => {
            return GhExecOut {
                stderr: format!("gh working directory: {error}"),
                code: -1,
                ..Default::default()
            };
        }
    };
    // Unix GUI launches have a minimal PATH. Resolve once using the same login
    // environment owner as the issue tracker, including PATH for gh's git child.
    #[cfg(unix)]
    let mut command = {
        let resolved = match resolve_login_command_environment("gh", &cwd, TerminalEnvironment::default()) {
            Ok(resolved) => resolved,
            Err(error) => {
                return GhExecOut {
                    missing: matches!(&error, LoginCommandEnvironmentError::Unavailable(_)),
                    stderr: String::from(error),
                    code: -1,
                    ..Default::default()
                };
            }
        };
        let mut command = Command::new(&resolved.executable);
        command.env_clear().envs(&resolved.environment);
        command
    };
    // Windows resolves installed CLI executables without requiring a Unix shell.
    #[cfg(not(unix))]
    let mut command = Command::new("gh");
    command
        .current_dir(&cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    non_interactive(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return GhExecOut {
                stderr: format!("gh: {error}"),
                code: -1,
                missing: cfg!(not(unix))
                    && error.kind() == std::io::ErrorKind::NotFound
                    && cwd.is_dir(),
                ..Default::default()
            };
        }
    };

    // 파이프를 먼저 떼어 스레드로 넘긴다. 부모가 wait만 하고 파이프를 안 읽으면
    // 출력이 큰 명령(gh issue list)에서 자식이 버퍼가 차 멈춘다.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (tx, rx) = mpsc::channel::<(String, String)>();
    std::thread::spawn(move || {
        let mut out = String::new();
        let mut err = String::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut out);
        }
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut err);
        }
        let _ = tx.send((out, err));
    });

    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok((stdout, stderr)) => {
            let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            GhExecOut {
                stdout,
                stderr,
                code,
                timed_out: false,
                missing: false,
            }
        }
        Err(_) => {
            // 제한 시간 초과 — 자식을 정리하지 않으면 좀비가 남는다.
            let _ = child.kill();
            let _ = child.wait();
            GhExecOut {
                stderr: format!("gh: stopped after exceeding the {timeout_ms}ms timeout"),
                code: -1,
                timed_out: true,
                ..Default::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn packaged_path_uses_login_environment() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let tools = fixture.path().join("tools");
        let workspace = fixture.path().join("workspace");
        std::fs::create_dir(&tools).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let shell = fixture.path().join("shell");
        std::fs::write(
            &shell,
            format!(
                "#!/bin/sh\nprintf 'PATH={}:/usr/bin:/bin\\0GHX_LOGIN_MARKER=login\\0'\n",
                tools.display()
            ),
        ).unwrap();
        let gh = tools.join("gh");
        std::fs::write(&gh, "#!/bin/sh\n[ \"$GHX_LOGIN_MARKER\" = login ] || exit 21\n[ \"$GH_PROMPT_DISABLED\" = 1 ] || exit 22\nprintf '%s\\n' \"$PWD\" \"$@\"\n").unwrap();
        for executable in [&shell, &gh] {
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut probe = Command::new(std::env::current_exe().unwrap());
        probe
            .args(["--exact", "ghx::tests::login_path_child_probe", "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("SHELL", &shell)
            .env("HOME", fixture.path())
            .env("HMUX_DISCOVERY_ROOT", fixture.path().join("discovery"))
            .env("GHX_FIXTURE_ROOT", &workspace);
        for missing in [false, true] {
            if missing {
                // The empty captured PATH proves absence independently of host installs.
                std::fs::write(&shell, "#!/bin/sh\nprintf 'PATH=\\0'\n").unwrap();
            }
            let output = probe.env("GHX_FIXTURE_MISSING", missing.to_string()).output().unwrap();
            assert!(
                output.status.success(), "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn login_path_child_probe() {
        let Some(root) = std::env::var_os("GHX_FIXTURE_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let argument = "literal $(printf injected); with spaces";
        let output = exec(root.to_str(), &[argument.into()], 1000);
        if std::env::var("GHX_FIXTURE_MISSING").as_deref() == Ok("true") {
            assert_eq!(output.code, -1);
            assert!(output.missing, "{}", output.stderr);
            return;
        }
        assert_eq!(output.code, 0, "{}", output.stderr);
        assert!(!output.missing);
        assert_eq!(
            output.stdout,
            format!("{}\n{argument}\n", root.canonicalize().unwrap().display())
        );
    }

    #[test]
    fn missing_repository_is_not_a_missing_cli() {
        let fixture = tempfile::tempdir().unwrap();
        let missing = fixture.path().join("removed-checkout");
        let output = exec(missing.to_str(), &["--version".into()], 1000);
        assert_ne!(output.code, 0);
        assert!(
            !output.missing,
            "missing cwd must remain a repository/environment error: {}", output.stderr
        );
    }

    #[test]
    fn missing_binary_is_reported_separately_from_failure() {
        // 없는 실행 파일은 missing으로 구분돼야 한다 — 미인증 안내와 다르다.
        let mut command = Command::new("gh-definitely-not-installed-xyz");
        command.stdin(Stdio::null());
        let error = command.spawn().unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn timeout_kills_the_child_and_reports_it() {
        // gh 대신 sleep으로 계약만 확인한다(테스트 머신에 gh가 없을 수 있다).
        let mut command = Command::new("sleep");
        command
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("sleep");
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(30));
            let _ = tx.send(());
        });
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(child.kill().is_ok());
        assert!(child.wait().is_ok());
    }
}
