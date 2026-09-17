#![cfg(unix)]

use hmux_client::{
    LocalSessionCatalog, SessionSelector, StandaloneCreateRequest, StandaloneSessionCreator,
};
use std::io::Write;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

fn hmux_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_hmux"))
}

fn runtime_executable() -> PathBuf {
    let runtime =
        hmux_executable().with_file_name(format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX));
    assert!(runtime.is_file(), "missing {}", runtime.display());
    runtime
}

struct LiveFixture {
    _state: tempfile::TempDir,
    discovery_root: PathBuf,
    session_id: String,
    workspace_id: String,
}

impl LiveFixture {
    fn new() -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let request = StandaloneCreateRequest::new(
            state.path().canonicalize().unwrap(),
            Some("broken-pipe-fixture".into()),
            vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
            24,
            80,
        )
        .unwrap();
        let created = StandaloneSessionCreator::new(runtime_executable())
            .with_discovery_root(&discovery_root)
            .create(request)
            .unwrap();
        let descriptor = created.session().descriptor();
        Self {
            _state: state,
            discovery_root,
            session_id: descriptor.session_id.clone(),
            workspace_id: descriptor.workspace_id.clone(),
        }
    }
}

impl Drop for LiveFixture {
    fn drop(&mut self) {
        let catalog = LocalSessionCatalog::new(&self.discovery_root);
        let selector =
            SessionSelector::new(self.session_id.clone(), Some(self.workspace_id.clone()));
        if let Ok(session) = catalog.open(&selector) {
            let _ = session.terminate_standalone(&catalog, Duration::from_secs(3));
        }
    }
}

fn run_with_closed_stdout(discovery_root: &Path, arguments: &[&str]) -> Output {
    let (reader, writer) = UnixStream::pair().unwrap();
    drop(reader);
    let writer: OwnedFd = writer.into();
    Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(discovery_root)
        .args(arguments)
        .stdout(Stdio::from(writer))
        .stderr(Stdio::piped())
        .output()
        .unwrap()
}

fn assert_pipe_close_is_success(discovery_root: &Path, arguments: &[&str]) {
    let output = run_with_closed_stdout(discovery_root, arguments);
    assert!(
        output.status.success(),
        "{arguments:?} failed with {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("panicked"), "unexpected panic: {stderr}");
    assert!(
        !stderr.contains("Broken pipe"),
        "unexpected EPIPE diagnostic: {stderr}"
    );
}

#[test]
fn text_and_json_commands_treat_a_closed_downstream_pipe_as_success() {
    let fixture = LiveFixture::new();
    assert_pipe_close_is_success(&fixture.discovery_root, &["--json", "ls", "--no-probe"]);
    assert_pipe_close_is_success(
        &fixture.discovery_root,
        &[
            "--json",
            "session",
            "show",
            &fixture.session_id,
            "--workspace",
            &fixture.workspace_id,
        ],
    );
    assert_pipe_close_is_success(
        &fixture.discovery_root,
        &[
            "--json",
            "session",
            "probe",
            &fixture.session_id,
            "--workspace",
            &fixture.workspace_id,
        ],
    );
    // `gc` is the current bounded doctor/diagnostic preview command.
    assert_pipe_close_is_success(&fixture.discovery_root, &["--json", "gc"]);
    assert_pipe_close_is_success(&fixture.discovery_root, &["ls", "--no-probe"]);
}

#[test]
fn non_broken_pipe_stdout_errors_remain_nonzero() {
    let state = tempfile::tempdir().unwrap();
    let (_reader, mut saturated_stdout) = UnixStream::pair().unwrap();
    saturated_stdout.set_nonblocking(true).unwrap();
    let fill = [0_u8; 8 * 1024];
    loop {
        match saturated_stdout.write(&fill) {
            Ok(0) => panic!("stdout fixture stopped before reaching its capacity"),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("stdout fixture failed before saturation: {error}"),
        }
    }
    let saturated_stdout: OwnedFd = saturated_stdout.into();
    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(state.path())
        .args(["--json", "ls", "--no-probe"])
        .stdout(Stdio::from(saturated_stdout))
        .stderr(Stdio::piped())
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("hmux: error:"),
        "missing CLI error: {stderr}"
    );
    assert!(!stderr.contains("panicked"), "unexpected panic: {stderr}");
}
