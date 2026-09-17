#![cfg(unix)]

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use hmux_client::{
    LocalProcessGenerationStatus, MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper, ManagedStopOutcome,
    ManagedStopRequest, PermissionMode, ProcessDescriptor, SessionDescriptor,
    probe_local_process_generation,
};
use serde::Deserialize;

const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const RUNTIME_GENERATION: &str = "relay-runtime-test-1";
const QUERY_EPOCH: &str = "relay-query-test-1";
const RELAY_ID: &str = "relay-process-test-1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMarker {
    role: String,
    pid: u32,
    parent_pid: u32,
}

#[derive(Debug)]
struct ProcessRow {
    pid: u32,
    parent_pid: u32,
    command: String,
}

struct ManagedRelayFixture {
    runtime: PathBuf,
    discovery_root: PathBuf,
    cwd: PathBuf,
    descriptor: SessionDescriptor,
    stopped: bool,
}

impl ManagedRelayFixture {
    fn stop(&mut self) {
        let receipt = ManagedSessionStopper::new(&self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(exact_stop_request(&self.descriptor))
            .expect("the exact Claude relay generation must stop");
        assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
        self.stopped = true;
    }
}

impl Drop for ManagedRelayFixture {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = ManagedSessionStopper::new(&self.runtime, &self.cwd)
                .with_discovery_root(&self.discovery_root)
                .stop(exact_stop_request(&self.descriptor));
        }
    }
}

struct SdkHostFixture {
    child: Child,
}

impl SdkHostFixture {
    fn wait_for_exit(&mut self) {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "SDK Host fixture failed: {status}");
                return;
            }
            assert!(
                Instant::now() < deadline,
                "SDK Host fixture survived relay stop"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for SdkHostFixture {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[test]
#[ignore = "requires a built Hmux runtime and the channel-pinned Node executable"]
fn native_claude_relay_stays_inside_one_exact_hmux_generation() {
    let runtime = required_executable("DURE_HMUX_RUNTIME_BIN");
    let node = required_executable("DURE_NODE_BIN");
    let relay = PathBuf::from(env!("CARGO_BIN_EXE_dure-claude-process-relay"))
        .canonicalize()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let discovery_root = root.path().join("discovery");
    let state_directory = root.path().join("state");
    fs::create_dir(&state_directory).unwrap();
    fs::set_permissions(&state_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let endpoint = state_directory.join("relay.sock");
    let relay_capability = state_directory.join("relay-capability");
    let host_capability = state_directory.join("host-capability");
    let capability = "hmux-relay-capability-test-0123456789";
    write_owner_only(&relay_capability, capability);
    write_owner_only(&host_capability, capability);
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();

    let created = ManagedSessionCreator::new(&runtime)
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "claude-process-relay-hmux-create",
                "claude-process-relay-hmux",
                "claude-process-relay-workspace",
                "claude",
                PermissionMode::Default,
                &cwd,
                relay_arguments(&relay, &endpoint, &relay_capability),
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
            .unwrap(),
        )
        .expect("the Hmux-owned Claude relay must reach Ready");
    let mut managed = ManagedRelayFixture {
        runtime,
        discovery_root,
        cwd: cwd.clone(),
        descriptor: created.session().descriptor().clone(),
        stopped: false,
    };
    wait_for_path(&endpoint);
    assert!(
        relay_capability.exists(),
        "a waiting relay must leave its one-shot capability available for control-plane recovery"
    );

    let host_fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-process-relay-host-fixture.mjs")
        .canonicalize()
        .unwrap();
    let mut sdk_host = SdkHostFixture {
        child: Command::new(node)
            .args([
                host_fixture.as_os_str(),
                "--endpoint".as_ref(),
                endpoint.as_os_str(),
                "--capability-file".as_ref(),
                host_capability.as_os_str(),
                "--state-dir".as_ref(),
                state_directory.as_os_str(),
                "--runtime-generation".as_ref(),
                RUNTIME_GENERATION.as_ref(),
                "--query-epoch".as_ref(),
                QUERY_EPOCH.as_ref(),
                "--relay-id".as_ref(),
                RELAY_ID.as_ref(),
            ])
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the detached SDK Host fixture must start"),
    };

    let host_marker = wait_for_marker(&state_directory.join("host.json"));
    let child_marker = wait_for_marker(&state_directory.join("child.json"));
    assert!(
        !relay_capability.exists(),
        "the relay must consume its capability after admitting the exact host"
    );
    assert_eq!(host_marker.role, "claude-sdk-host-fixture");
    assert_eq!(host_marker.pid, sdk_host.child.id());
    assert_eq!(host_marker.parent_pid, std::process::id());
    assert_eq!(child_marker.role, "fake-claude-relay-child");
    assert_eq!(
        child_marker.parent_pid,
        managed.descriptor.provider_process.process_id
    );

    let tree = process_descendants(managed.descriptor.host_process.process_id);
    assert_eq!(
        tree.len(),
        2,
        "Hmux must own only relay plus fake Claude: {tree:?}"
    );
    assert!(tree.iter().any(|row| {
        row.pid == managed.descriptor.provider_process.process_id
            && row.parent_pid == managed.descriptor.host_process.process_id
    }));
    assert!(tree.iter().any(|row| {
        row.pid == child_marker.pid
            && row.parent_pid == managed.descriptor.provider_process.process_id
    }));
    for row in &tree {
        assert!(!row.command.contains("codex"));
        assert!(!row.command.contains("app-server"));
        assert_ne!(
            row.pid, host_marker.pid,
            "shared Node Host entered Hmux tree"
        );
    }

    thread::sleep(Duration::from_millis(300));
    assert_process_live(&managed.descriptor.host_process);
    assert_process_live(&managed.descriptor.provider_process);
    assert!(process_rows().iter().any(|row| row.pid == child_marker.pid));

    managed.stop();
    wait_for_process_absence(&managed.descriptor.host_process);
    wait_for_process_absence(&managed.descriptor.provider_process);
    wait_for_numeric_process_absence(child_marker.pid);
    sdk_host.wait_for_exit();
    assert!(!endpoint.exists());
}

fn relay_arguments(relay: &Path, endpoint: &Path, capability: &Path) -> Vec<String> {
    [
        relay.as_os_str(),
        "--endpoint".as_ref(),
        endpoint.as_os_str(),
        "--capability-file".as_ref(),
        capability.as_os_str(),
        "--runtime-generation".as_ref(),
        RUNTIME_GENERATION.as_ref(),
        "--query-epoch".as_ref(),
        QUERY_EPOCH.as_ref(),
        "--relay-id".as_ref(),
        RELAY_ID.as_ref(),
    ]
    .into_iter()
    .map(|value| value.to_string_lossy().into_owned())
    .collect()
}

fn write_owner_only(path: &Path, value: &str) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    use std::io::Write;
    file.write_all(value.as_bytes()).unwrap();
}

fn required_executable(name: &str) -> PathBuf {
    let path =
        PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    let path = path.canonicalize().unwrap();
    assert!(path.is_file(), "{name} is not a file");
    path
}

fn wait_for_path(path: &Path) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "path never appeared: {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_marker(path: &Path) -> ProcessMarker {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if let Ok(source) = fs::read(path) {
            return serde_json::from_slice(&source).unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "marker never appeared: {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn exact_stop_request(descriptor: &SessionDescriptor) -> ManagedStopRequest {
    ManagedStopRequest::new(
        "claude-process-relay-hmux-stop",
        &descriptor.session_id,
        &descriptor.workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &descriptor.runner_principal,
            &descriptor.runner_instance,
            descriptor.channel_epoch.parse().unwrap(),
            &descriptor.host_instance_id,
            &descriptor.terminal_epoch,
        )
    })
    .unwrap()
}

fn process_rows() -> Vec<ProcessRow> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 3 {
                return None;
            }
            Some(ProcessRow {
                pid: fields[0].parse().ok()?,
                parent_pid: fields[1].parse().ok()?,
                command: fields[2..].join(" "),
            })
        })
        .collect()
}

fn process_descendants(root: u32) -> Vec<ProcessRow> {
    let rows = process_rows();
    let mut tree = BTreeSet::from([root]);
    loop {
        let previous = tree.len();
        for row in &rows {
            if tree.contains(&row.parent_pid) {
                tree.insert(row.pid);
            }
        }
        if tree.len() == previous {
            break;
        }
    }
    rows.into_iter()
        .filter(|row| row.pid != root && tree.contains(&row.pid))
        .collect()
}

fn assert_process_live(process: &ProcessDescriptor) {
    assert!(matches!(
        probe_local_process_generation(process),
        Ok(LocalProcessGenerationStatus::Live)
    ));
}

fn wait_for_process_absence(process: &ProcessDescriptor) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if matches!(
            probe_local_process_generation(process),
            Ok(LocalProcessGenerationStatus::Absent)
        ) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "process generation survived exact stop"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_numeric_process_absence(process_id: u32) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if process_rows().iter().all(|row| row.pid != process_id) {
            return;
        }
        assert!(Instant::now() < deadline, "fake Claude survived exact stop");
        thread::sleep(Duration::from_millis(20));
    }
}
