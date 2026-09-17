#![cfg(test)]

#[path = "command_input_marker_probe.rs"]
mod marker_probe;
#[path = "key_input_smoke.rs"]
mod key_input_smoke;

// Real CLI-to-Host semantic input proof. Kept outside the production command
// adapter so test orchestration cannot grow its runtime surface.
use super::{HmuxManager, ManagedCreateLaunch};
use hmux_client::{
    LocalSession, LocalSessionCatalog, PermissionMode, ProviderStateEnvironment, SessionSelector,
    TerminalEnvironment,
};
use marker_probe::{observer_cpu_contention, wait_for_exact_markers};
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(unix)]
#[test]
#[ignore = "run through scripts/qa/hmux-managed-input-smoke.sh"]
fn native_managed_dure_command_preserves_semantic_submit() {
    let runtime = std::env::var_os("HMUX_RUNTIME")
        .filter(|value| !value.is_empty())
        .expect("HMUX_RUNTIME must point to the repository hmux-runtime");
    assert!(
        Path::new(&runtime).is_file(),
        "HMUX_RUNTIME is not a file: {}",
        Path::new(&runtime).display()
    );
    let hmux_cli = std::env::var_os("HMUX_CLI")
        .filter(|value| !value.is_empty())
        .expect("HMUX_CLI must point to the repository hmux CLI");
    let state = tempfile::tempdir().expect("create isolated command-input state");
    let discovery_root = state.path().join("discovery");
    let _discovery = ScopedEnvironment::set("HMUX_DISCOVERY_ROOT", &discovery_root);
    let app = tauri::test::mock_app();
    let manager = Arc::new(HmuxManager::default());
    let cwd = std::env::current_dir().expect("resolve current directory");
    let test_binary = std::env::current_exe().expect("resolve test binary");
    let ready_release = (std::env::var("DURE_QA_COMMAND_INPUT_CONTENTION").as_deref() == Ok("1"))
        .then(|| state.path().join("provider-ready-release"));
    let provider_prefix = ready_release.as_ref().map_or_else(String::new, |path| {
        format!("DURE_QA_MARKER_READY_FILE={} ", shell_quote_test_path(path))
    });
    let provider_command = format!(
        "{provider_prefix}{} --ignored --exact hmux::command_input_smoke::managed_command_input_fixture_provider --nocapture",
        shell_quote_test_path(&test_binary),
    );
    let created = manager
        .create_managed(
            app.handle(),
            ManagedCreateLaunch {
                replace_current: false,
                idempotency_key: "managed-command-input-create".to_string(),
                session_id: "managed-command-input-session".to_string(),
                workspace_id: "managed-command-input-workspace".to_string(),
                provider_id: "test-provider".to_string(),
                conversation_id: None,
                permission_mode: PermissionMode::Default,
                credential_id: None,
                credential_generation: None,
                provider_state_environment: ProviderStateEnvironment::default(),
                cwd: cwd.to_string_lossy().into_owned(),
                command: provider_command,
                initial_prompt: None,
                rows: 24,
                columns: 100,
                terminal_environment: TerminalEnvironment::default(),
                terminal_default_colors: hmux_client::TerminalDefaultColors::default(),
            },
        )
        .expect("create isolated managed command-input session");
    let selector = SessionSelector::new(
        created.session.session_id.clone(),
        Some(created.session.workspace_id.clone()),
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let cleanup_fence = created.session.stop_fence.clone();
    let mut generation = None;
    let exercise = (|| -> Result<Vec<u8>, String> {
        let session = catalog
            .open(&selector)
            .map_err(|error| format!("open isolated managed command-input session: {error}"))?;
        generation = Some(session.descriptor().clone());
        let mut release = ready_release.as_deref();
        wait_for_exact_markers(
            "provider_ready",
            ["COMMAND_INPUT_READY"],
            Duration::from_secs(3),
            || {
                let snapshot = read_screen(&session)?;
                if let Some(path) = release.take() {
                    std::fs::write(path, b"ready")
                        .map_err(|error| format!("release isolated provider: {error}"))?;
                    observer_cpu_contention(Duration::from_millis(3200));
                }
                Ok(snapshot)
            },
        )?;

        let stop_fence = cleanup_fence.as_ref().ok_or_else(|| {
            "managed command input requires a complete generation fence".to_string()
        })?;
        let registry = serde_json::json!({
            "version": 4,
            "agents": [{
                "id": "managed-command-input-agent",
                "name": "command-input",
                "project": "Dure",
                "provider": "test-provider",
                "sessionId": created.session.session_id,
                "runtimeBinding": {
                    "schemaVersion": 1,
                    "runtime": "hmux_managed_v1",
                    "source": "local",
                    "hostId": "local",
                    "sessionId": created.session.session_id,
                    "workspaceId": created.session.workspace_id,
                    "stopFence": {
                        "runnerPrincipal": stop_fence.runner_principal,
                        "runnerInstance": stop_fence.runner_instance,
                        "channelEpoch": stop_fence.channel_epoch,
                        "hostInstanceId": stop_fence.host_instance_id,
                        "terminalEpoch": stop_fence.terminal_epoch,
                    },
                },
            }],
        });
        let encoded_registry = serde_json::to_vec(&registry)
            .map_err(|error| format!("encode isolated Dure registry: {error}"))?;
        std::fs::write(state.path().join("agents.json"), encoded_registry)
            .map_err(|error| format!("write isolated Dure registry: {error}"))?;
        let dure_cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "src-tauri has no repository parent".to_string())?
            .join("cli/dure.mjs");
        let invoke_dure = |arguments: &[&str], stdin_file: Option<&Path>| {
            let stdin = match stdin_file {
                Some(path) => Stdio::from(
                    std::fs::File::open(path)
                        .map_err(|error| format!("open isolated CLI stdin: {error}"))?,
                ),
                None => Stdio::null(),
            };
            Command::new("node")
                .arg(&dure_cli)
                .args(arguments)
                .stdin(stdin)
                .env("DURE_APP_CHANNEL", "stable")
                .env("DURE_HMUX_BIN", &hmux_cli)
                .env("DURE_HOME", state.path())
                .env("HOME", state.path())
                .env("HMUX_DISCOVERY_ROOT", &discovery_root)
                .output()
                .map_err(|error| {
                    format!("run Dure CLI against isolated managed session: {error}")
                })
        };
        let run_dure = |arguments: &[&str], stdin_file: Option<&Path>| -> Result<(), String> {
            let output = invoke_dure(arguments, stdin_file)?;
            if !output.status.success() {
                return Err(format!(
                    "dure {arguments:?} failed: stdout={} stderr={}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr),
                ));
            }
            if arguments.contains(&"--json") {
                let receipt: serde_json::Value = serde_json::from_slice(&output.stdout)
                    .map_err(|error| format!("decode CLI delivery receipt: {error}"))?;
                if receipt["apiVersion"] != "dure.send/v1"
                    || receipt["target"]["sessionId"] != created.session.session_id
                    || receipt["receipt"]["text"]["state"] != "written_to_pty"
                {
                    return Err(format!("unexpected CLI delivery receipt: {receipt}"));
                }
            }
            Ok(())
        };

        run_dure(&["send", "command-input", "status"], None)?;
        run_dure(&["enter", "command-input"], None)?;
        run_dure(&["send", "command-input", "draft", "--no-enter"], None)?;
        run_dure(&["enter", "command-input"], None)?;
        let prompt_file = state.path().join("prompt.txt");
        std::fs::write(&prompt_file, "from-file\n한글\n")
            .map_err(|error| format!("write file input: {error}"))?;
        let prompt_path = prompt_file
            .to_str()
            .ok_or_else(|| "fixture input path is not UTF-8".to_string())?;
        run_dure(
            &["send", "command-input", "--file", prompt_path, "--json"],
            None,
        )?;
        std::fs::write(&prompt_file, "from-stdin\n한글\n")
            .map_err(|error| format!("write redirected input: {error}"))?;
        run_dure(
            &["send", "command-input", "--stdin", "--no-enter", "--json"],
            Some(&prompt_file),
        )?;
        run_dure(&["enter", "command-input"], None)?;
        let text_screen = wait_for_exact_markers(
            "file_and_stdin_submit",
            ["COMMAND_INPUT_SUBMITTED:5:from-stdin\\n한글\\n"],
            Duration::from_secs(10),
            || read_screen(&session),
        )?;
        key_input_smoke::exercise(
            &session, state.path(), &registry, |args| invoke_dure(args, None),
        )?;
        Ok(text_screen)
    })();

    let cleanup_result = cleanup_fence
        .ok_or_else(|| "managed command input has no cleanup fence".to_string())
        .and_then(|cleanup_fence| {
            manager.stop_managed_session(
                app.handle(),
                "managed-command-input-stop",
                &created.session.session_id,
                &created.session.workspace_id,
                cleanup_fence,
            )
        });
    let exit_deadline = Instant::now() + Duration::from_secs(10);
    let generation_exit_result = generation
        .as_ref()
        .ok_or_else(|| "command-input generation descriptor was not observed".to_string())
        .and_then(|generation| loop {
            if !super::process_generation_is_live(&generation.provider_process)
                && !super::process_generation_is_live(&generation.host_process)
            {
                break Ok(());
            }
            if Instant::now() >= exit_deadline {
                break Err("isolated command-input generation did not exit".to_string());
            }
            std::thread::sleep(Duration::from_millis(20));
        });

    if cleanup_result.is_err() || generation_exit_result.is_err() {
        let retained_state = state.keep();
        panic!(
            "isolated command-input cleanup failed: stop={cleanup_result:?} exit={generation_exit_result:?} exercise={:?} retained={}",
            exercise.as_ref().err(),
            retained_state.display(),
        );
    }
    let snapshot = exercise.unwrap_or_else(|error| panic!("{error}"));

    let screen = String::from_utf8_lossy(&snapshot);
    assert!(
        screen.contains("COMMAND_INPUT_SUBMITTED:1:status"),
        "text plus Enter was not one semantic submit: {screen}"
    );
    assert!(
        screen.contains("COMMAND_INPUT_SUBMITTED:2:"),
        "Enter-only did not submit the empty draft: {screen}"
    );
    assert!(
        screen.contains("COMMAND_INPUT_DRAFT:draft"),
        "--no-enter did not preserve the draft: {screen}"
    );
    assert!(
        screen.contains("COMMAND_INPUT_SUBMITTED:3:draft"),
        "a later semantic Enter did not submit the preserved draft: {screen}"
    );
    assert_eq!(
        screen.matches("COMMAND_INPUT_SUBMITTED:1:status").count(),
        1,
        "text plus Enter submitted more than once: {screen}"
    );
    for marker in [
        "COMMAND_INPUT_SUBMITTED:4:from-file\\n한글\\n",
        "COMMAND_INPUT_SUBMITTED:5:from-stdin\\n한글\\n",
    ] {
        assert_eq!(
            screen.matches(marker).count(),
            1,
            "file/stdin was not submitted exactly once with its trailing newline: {screen}"
        );
    }
}

#[cfg(unix)]
#[test]
#[ignore = "launched as the isolated managed command-input provider"]
fn managed_command_input_fixture_provider() {
    // Parse the same bracketed-paste framing requested by native TUIs. PTY
    // reads may split or coalesce tokens; only Enter outside paste submits.
    let mut terminal = std::mem::MaybeUninit::<libc::termios>::uninit();
    // SAFETY: stdin is the fixture's owned PTY and `terminal` is initialized
    // only after tcgetattr succeeds.
    assert_eq!(
        unsafe { libc::tcgetattr(libc::STDIN_FILENO, terminal.as_mut_ptr()) },
        0
    );
    let mut terminal = unsafe { terminal.assume_init() };
    // SAFETY: `terminal` is a valid termios value for this fixture PTY.
    unsafe { libc::cfmakeraw(&mut terminal) };
    assert_eq!(
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &terminal) },
        0,
    );
    if let Some(path) = std::env::var_os("DURE_QA_MARKER_READY_FILE") {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !Path::new(&path).is_file() {
            assert!(
                Instant::now() < deadline,
                "isolated observer never released readiness"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    print!("\x1b[?2004h\rCOMMAND_INPUT_READY\r\n");
    std::io::stdout().flush().unwrap();

    let mut draft = Vec::new();
    let mut submissions = 0_u8;
    let mut pending = Vec::new();
    loop {
        let mut buffer = [0_u8; 4096];
        let count = std::io::stdin().read(&mut buffer).unwrap();
        if count == 0 || buffer[..count] == [0x04] {
            break;
        }
        pending.extend_from_slice(&buffer[..count]);
        while !pending.is_empty() {
            if pending.starts_with(b"\x1b[200~") {
                let Some(end) = pending.windows(6).position(|part| part == b"\x1b[201~") else {
                    break;
                };
                draft.extend(
                    pending[6..end]
                        .iter()
                        .map(|byte| if *byte == b'\r' { b'\n' } else { *byte }),
                );
                pending.drain(..end + 6);
                print!(
                    "\rCOMMAND_INPUT_DRAFT:{}\r\n",
                    String::from_utf8_lossy(&draft).replace('\n', "\\n")
                );
            } else if b"\x1b[200~".starts_with(&pending) {
                break;
            } else {
                assert_eq!(pending[0], b'\r', "command body bypassed paste framing");
                pending.remove(0);
                submissions += 1;
                let submitted = String::from_utf8_lossy(&draft).replace('\n', "\\n");
                print!("\rCOMMAND_INPUT_SUBMITTED:{submissions}:{submitted}\r\n");
                if submitted == "draft" {
                    print!("\rCOMMAND_INPUT_DRAFT_SUBMITTED:draft\r\n");
                }
                draft.clear();
            }
        }
        std::io::stdout().flush().unwrap();
        if submissions == 5 {
            key_input_smoke::fixture();
            break;
        }
    }
}

#[cfg(unix)]
fn shell_quote_test_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn read_screen(session: &LocalSession) -> Result<Vec<u8>, String> {
    session
        .read_screen(None)
        .map(|snapshot| snapshot.repaint_bytes)
        .map_err(|error| format!("read Hmux screen: {error}"))
}

struct ScopedEnvironment {
    key: &'static str,
    previous: Option<OsString>,
}

impl ScopedEnvironment {
    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for ScopedEnvironment {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}
