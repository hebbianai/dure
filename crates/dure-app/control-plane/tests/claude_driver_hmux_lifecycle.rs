#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use hmux_client::{
    LocalProcessGenerationStatus, MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper, ManagedStopOutcome,
    ManagedStopRequest, PermissionMode, ProcessDescriptor, SessionDescriptor,
    probe_local_process_generation,
};
use serde::Deserialize;
use serde_json::json;

const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

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
    rss_kib: u64,
    command: String,
}

struct ManagedDriverFixture {
    runtime: PathBuf,
    discovery_root: PathBuf,
    cwd: PathBuf,
    descriptor: SessionDescriptor,
    stopped: bool,
}

impl ManagedDriverFixture {
    fn stop(&mut self) {
        let receipt = ManagedSessionStopper::new(&self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(exact_stop_request(&self.descriptor))
            .expect("the exact Claude driver generation must stop");
        assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
        self.stopped = true;
    }
}

impl Drop for ManagedDriverFixture {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = ManagedSessionStopper::new(&self.runtime, &self.cwd)
                .with_discovery_root(&self.discovery_root)
                .stop(exact_stop_request(&self.descriptor));
        }
    }
}

#[test]
#[ignore = "requires a built Hmux runtime and the channel-pinned Node executable"]
fn claude_driver_is_one_detached_hmux_root_with_no_codex_app_server() {
    let runtime = required_executable("DURE_HMUX_RUNTIME_BIN");
    let node = required_executable("DURE_NODE_BIN");
    let fixture_root = tempfile::tempdir().unwrap();
    let discovery_root = fixture_root.path().join("discovery");
    let driver_state = fixture_root.path().join("driver-state");
    fs::create_dir(&driver_state).unwrap();
    fs::set_permissions(&driver_state, fs::Permissions::from_mode(0o700)).unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let driver = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-driver-hmux-fixture.mjs")
        .canonicalize()
        .unwrap();

    let created = ManagedSessionCreator::new(&runtime)
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "claude-driver-slice-zero-create",
                "claude-driver-slice-zero",
                "claude-driver-slice-zero-workspace",
                "claude",
                PermissionMode::Default,
                &cwd,
                vec![
                    node.to_string_lossy().into_owned(),
                    driver.to_string_lossy().into_owned(),
                    "--state-dir".into(),
                    driver_state.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
            .unwrap(),
        )
        .expect("the Hmux-managed Claude driver must reach Ready");
    let descriptor = created.session().descriptor().clone();
    let mut fixture = ManagedDriverFixture {
        runtime,
        discovery_root,
        cwd,
        descriptor,
        stopped: false,
    };

    let driver_marker = wait_for_marker(&driver_state.join("driver.json"));
    let claude_marker = wait_for_marker(&driver_state.join("claude.json"));
    let mcp_marker = wait_for_marker(&driver_state.join("mcp.json"));
    assert_eq!(driver_marker.role, "dure-claude-driver");
    assert_eq!(claude_marker.role, "fake-claude");
    assert_eq!(mcp_marker.role, "fake-mcp");
    assert_eq!(
        fixture.descriptor.provider_process.process_id,
        driver_marker.pid
    );
    assert_eq!(claude_marker.parent_pid, driver_marker.pid);
    assert_eq!(mcp_marker.parent_pid, claude_marker.pid);

    let provider_tree = process_descendants(fixture.descriptor.host_process.process_id);
    let expected = BTreeMap::from([
        (driver_marker.pid, "driver"),
        (claude_marker.pid, "claude"),
        (mcp_marker.pid, "mcp"),
    ]);
    assert_eq!(provider_tree.len(), expected.len());
    for row in &provider_tree {
        assert!(
            expected.contains_key(&row.pid),
            "unexpected provider process: {row:?}"
        );
        assert!(!row.command.contains("codex"));
        assert!(!row.command.contains("app-server"));
    }
    assert_eq!(
        provider_tree
            .iter()
            .find(|row| row.pid == claude_marker.pid)
            .unwrap()
            .parent_pid,
        driver_marker.pid
    );
    let driver_rss_kib = provider_tree
        .iter()
        .find(|row| row.pid == driver_marker.pid)
        .unwrap()
        .rss_kib;
    let fake_tree_rss_kib = provider_tree.iter().map(|row| row.rss_kib).sum::<u64>();
    println!(
        "claude_driver_slice0_metrics={}",
        json!({
            "emptyDriverRssKiB": driver_rss_kib,
            "fakeTreeRssKiB": fake_tree_rss_kib,
            "processCount": provider_tree.len(),
            "claim": "harness-only; excludes Agent SDK and real Claude retained state"
        })
    );

    // Managed creation closes its broker connection before returning. The exact
    // generation must remain live with no UI, Tauri, or terminal attachment.
    thread::sleep(Duration::from_millis(300));
    assert_process_live(&fixture.descriptor.host_process);
    assert_process_live(&fixture.descriptor.provider_process);
    assert_eq!(
        process_descendants(fixture.descriptor.host_process.process_id).len(),
        expected.len()
    );

    fixture.stop();
    wait_for_process_absence(&fixture.descriptor.host_process);
    wait_for_process_absence(&fixture.descriptor.provider_process);
    wait_for_empty_process_tree(driver_marker.pid);
    let remaining = process_rows();
    for pid in expected.keys() {
        assert!(remaining.iter().all(|row| row.pid != *pid));
    }
}

fn required_executable(name: &str) -> PathBuf {
    let path =
        PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    let path = path.canonicalize().unwrap();
    assert!(path.is_file(), "{name} is not a file");
    path
}

fn exact_stop_request(descriptor: &SessionDescriptor) -> ManagedStopRequest {
    ManagedStopRequest::new(
        "claude-driver-slice-zero-stop",
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

fn process_rows() -> Vec<ProcessRow> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,command="])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 4 {
                return None;
            }
            Some(ProcessRow {
                pid: fields[0].parse().ok()?,
                parent_pid: fields[1].parse().ok()?,
                rss_kib: fields[2].parse().ok()?,
                command: fields[3..].join(" "),
            })
        })
        .collect()
}

fn process_descendants(root: u32) -> Vec<ProcessRow> {
    let rows = process_rows();
    let mut tree = BTreeSet::from([root]);
    loop {
        let previous_len = tree.len();
        for row in &rows {
            if tree.contains(&row.parent_pid) {
                tree.insert(row.pid);
            }
        }
        if tree.len() == previous_len {
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

fn wait_for_empty_process_tree(root: u32) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    let mut empty_observations = 0;
    loop {
        if process_descendants(root).is_empty() {
            empty_observations += 1;
            if empty_observations == 2 {
                return;
            }
        } else {
            empty_observations = 0;
        }
        assert!(
            Instant::now() < deadline,
            "provider process tree survived exact stop"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
