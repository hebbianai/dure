#![cfg(unix)]

use hmux_client::{
    LocalSessionCatalog, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION, ManagedCreateBrokerResponse,
    ManagedCreateRequest, SessionSelector, StandaloneCreateRequest, StandaloneSessionCreator,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
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

struct SourceFixture {
    _state: tempfile::TempDir,
    discovery_root: PathBuf,
    session_id: String,
    workspace_id: String,
}

impl SourceFixture {
    fn start() -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let request = StandaloneCreateRequest::new(
            state.path().canonicalize().unwrap(),
            Some("command-bridge-source".into()),
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

impl Drop for SourceFixture {
    fn drop(&mut self) {
        let catalog = LocalSessionCatalog::new(&self.discovery_root);
        let selector =
            SessionSelector::new(self.session_id.clone(), Some(self.workspace_id.clone()));
        if let Ok(session) = catalog.open(&selector) {
            let _ = session.terminate_standalone(&catalog, Duration::from_secs(3));
        }
    }
}

fn executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn write_broker_frame(path: &Path, response: &ManagedCreateBrokerResponse) {
    let payload = serde_json::to_vec(response).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    fs::write(path, frame).unwrap();
}

fn read_create_request(path: &Path, stderr: &[u8]) -> ManagedCreateRequest {
    let frame = fs::read(path).unwrap();
    assert!(
        frame.len() >= 4,
        "broker received no request: {}",
        String::from_utf8_lossy(stderr)
    );
    let declared = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    assert_eq!(frame.len(), declared + 4);
    serde_json::from_slice(&frame[4..]).unwrap()
}

#[test]
fn adopted_command_bridge_sends_a_conversation_fenced_create_to_the_broker() {
    let source = SourceFixture::start();
    let bridge_root = source._state.path().join("bridge");
    let real_bin = source._state.path().join("real-bin");
    fs::create_dir_all(&bridge_root).unwrap();
    fs::create_dir_all(&real_bin).unwrap();
    executable(&real_bin.join("provider"), "#!/bin/sh\nexit 0\n");

    let fake_runtime = source._state.path().join("fake-hmux-runtime");
    executable(
        &fake_runtime,
        &format!(
            "#!/bin/sh\n[ \"$2\" = {MANAGED_CREATE_BROKER_SUBCOMMAND} ] || exit 64\ncat > \"$0.request\"\nexec cat \"$0.response\"\n"
        ),
    );
    write_broker_frame(
        &fake_runtime.with_extension("response"),
        &ManagedCreateBrokerResponse::refused("fixture_refused", "request captured"),
    );
    let path = std::env::join_paths([
        bridge_root.as_path(),
        real_bin.as_path(),
        Path::new("/usr/bin"),
        Path::new("/bin"),
    ])
    .unwrap();

    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&source.discovery_root)
        .args([
            "command-bridge",
            "--bridge-dir",
            bridge_root.to_str().unwrap(),
            "--bridge-nonce",
            "bridge-1",
            "--provider-id",
            "codex",
            "--executable",
            "provider",
        ])
        .current_dir(source._state.path())
        .env("DURE_HMUX_COMMAND_BRIDGE_NONCE", "bridge-1")
        .env("HMUX_SESSION_ID", &source.session_id)
        .env("HMUX_WORKSPACE_ID", &source.workspace_id)
        .env("HMUX_RUNTIME", &fake_runtime)
        .env("PATH", path)
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "the fixture broker refuses the create"
    );
    let request = read_create_request(&fake_runtime.with_extension("request"), &output.stderr);
    assert_eq!(
        request.required_managed_stop_request_version(),
        Some(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION),
        "the marker target becomes a Native Agent pane and must be stoppable by exact conversation"
    );
}
