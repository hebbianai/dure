#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use dure_control_plane::claude_sdk_host_client::ClaudeDch1Client;
use dure_control_plane::claude_sdk_host_supervisor::{
    ClaudeSdkHostSupervisor, ClaudeSdkHostSupervisorConfiguration,
};
use serde::Deserialize;
use serde_json::json;

const OWNER_FIXTURE_MARKER: &str = "DURE_CLAUDE_OWNER_FIXTURE_MARKER";
const OWNER_FIXTURE_NODE: &str = "DURE_CLAUDE_OWNER_FIXTURE_NODE";
const OWNER_FIXTURE_ROOT: &str = "DURE_CLAUDE_OWNER_FIXTURE_ROOT";
const OWNER_FIXTURE_TEST: &str = "shared_host_owner_process_fixture";
const WAIT_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::test]
async fn replacement_controller_reuses_the_live_host_and_query() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let configuration = |generation: &str| {
        ClaudeSdkHostSupervisorConfiguration::new(
            test_node_executable(),
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/claude-query-retirement-fixture.mjs")
                .canonicalize()
                .unwrap(),
            root.path(),
            root.path(),
            generation,
            vec![],
        )
        .unwrap()
    };
    let identity = json!({
        "runtimeGeneration": "surviving-runtime",
        "queryEpoch": "surviving-query",
        "relayId": "surviving-relay",
    });
    let mut original = ClaudeSdkHostSupervisor::new(configuration("controller-one"));
    let lease = original.ensure_started().unwrap();
    let attached = ClaudeDch1Client::connect(&lease, "controller-one", BTreeMap::new())
        .await
        .unwrap();
    attached
        .client
        .request(
            "bind",
            json!({ "binding": {
                "identity": identity,
                "cwd": root.path(),
                "env": {},
            }}),
        )
        .await
        .unwrap();
    drop(attached);
    drop(original);
    // This is a replacement controller, not another launch in the old owner.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut replacement = ClaudeSdkHostSupervisor::new(configuration("controller-two"));
    let adopted = replacement.ensure_started().unwrap();
    if adopted.process_id() != lease.process_id() {
        replacement
            .abort_generation(adopted.host_generation())
            .unwrap();
    }
    assert_eq!(
        adopted.process_id(),
        lease.process_id(),
        "controller exit killed the Host"
    );
    assert_eq!(adopted.capability(), lease.capability());
    assert_eq!(adopted.host_generation(), lease.host_generation());
    assert_eq!(replacement.launch_count(), 0);
    let attached = ClaudeDch1Client::connect(&adopted, "controller-two", BTreeMap::new())
        .await
        .unwrap();
    assert_eq!(attached.snapshot["queries"][0]["identity"], identity);
    attached
        .client
        .request("begin_drain", json!({}))
        .await
        .unwrap();
    attached
        .client
        .request("close_query", json!({ "identity": identity }))
        .await
        .unwrap();
    let replay = attached
        .client
        .request(
            "replay",
            json!({
                "identity": identity, "afterSequence": 0,
            }),
        )
        .await
        .unwrap();
    attached
        .client
        .request(
            "ack",
            json!({
                "identity": identity, "sequence": replay["latestSequence"],
            }),
        )
        .await
        .unwrap();
    attached
        .client
        .request("shutdown", json!({}))
        .await
        .unwrap();
    drop(attached);
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while !replacement.observe_exit().unwrap() {
        assert!(Instant::now() < deadline, "drained Host did not exit");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerProcessMarker {
    host_process_id: u32,
    runtime_directory: PathBuf,
}

struct OwnerProcessFixture {
    child: Child,
    host_process_id: Option<u32>,
    runtime_directory: PathBuf,
}

impl OwnerProcessFixture {
    fn crash(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            assert_eq!(
                unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGKILL) },
                0
            );
        }
        self.child.wait().unwrap();
    }

    fn host_process_id(&self) -> u32 {
        self.host_process_id.unwrap()
    }

    fn confirm_host_exit(&mut self) {
        wait_for_process_exit(self.host_process_id());
        self.host_process_id = None;
    }
}

impl Drop for OwnerProcessFixture {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGKILL) };
            let _ = self.child.wait();
        }
        if let Some(process_id) = self.host_process_id {
            let _ = unsafe { libc::kill(process_id as libc::pid_t, libc::SIGKILL) };
        }
    }
}

#[test]
fn shared_host_exits_after_owner_crash_before_one_replacement_starts() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let node = test_node_executable();

    let mut first = spawn_owner_process(root.path(), &node, "owner-host-generation-1");
    let first_host_process_id = first.host_process_id();
    assert!(process_is_live(first_host_process_id));
    first.crash();
    first.confirm_host_exit();
    wait_for_path_absence(&first.runtime_directory);

    let mut replacement = spawn_owner_process(root.path(), &node, "owner-host-generation-2");
    assert_ne!(replacement.host_process_id(), first_host_process_id);
    assert_eq!(host_runtime_directory_count(root.path()), 1);
    replacement.crash();
    replacement.confirm_host_exit();
    wait_for_path_absence(&replacement.runtime_directory);
    assert_eq!(host_runtime_directory_count(root.path()), 0);
}

#[tokio::test]
async fn supervisor_reaps_crashed_host_before_starting_one_successor() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let node = test_node_executable();
    let entrypoint = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-query-retirement-fixture.mjs")
        .canonicalize()
        .unwrap();
    let generation = "same-owner-host-generation";
    let configuration = ClaudeSdkHostSupervisorConfiguration::new(
        node,
        entrypoint,
        root.path(),
        root.path(),
        generation,
        std::env::var("PATH")
            .ok()
            .map(|value| vec![("PATH".into(), value)])
            .unwrap_or_default(),
    )
    .unwrap();
    let mut supervisor = ClaudeSdkHostSupervisor::new(configuration);

    let first = supervisor.ensure_started().unwrap();
    let first_runtime_directory = first.endpoint().parent().unwrap().to_path_buf();
    let first_attached = ClaudeDch1Client::connect(&first, "crash-client-1", BTreeMap::new())
        .await
        .unwrap();
    let first_host_instance = first_attached.snapshot["hostInstanceId"]
        .as_str()
        .unwrap()
        .to_owned();
    drop(first_attached);
    assert_eq!(
        unsafe { libc::kill(first.process_id() as libc::pid_t, libc::SIGKILL) },
        0,
        "failed to crash the exact shared SDK Host generation"
    );
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while !supervisor.observe_exit().unwrap() {
        assert!(Instant::now() < deadline, "crashed SDK Host was not reaped");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!process_is_live(first.process_id()));
    assert!(!first_runtime_directory.exists());

    let replacement = supervisor.ensure_started().unwrap();
    assert_eq!(supervisor.launch_count(), 2);
    assert_ne!(replacement.process_id(), first.process_id());
    assert_ne!(replacement.capability(), first.capability());
    assert_ne!(replacement.endpoint(), first.endpoint());
    assert_eq!(replacement.host_generation(), first.host_generation());
    let replacement_attached =
        ClaudeDch1Client::connect(&replacement, "crash-client-2", BTreeMap::new())
            .await
            .unwrap();
    assert_ne!(
        replacement_attached.snapshot["hostInstanceId"],
        first_host_instance
    );
    assert_eq!(host_runtime_directory_count(root.path()), 1);
    supervisor.abort_generation(generation).unwrap();
    assert_eq!(host_runtime_directory_count(root.path()), 0);
}

#[test]
fn unexpected_host_state_survives_owner_loss_cleanup() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let node = test_node_executable();
    let mut owner = spawn_owner_process(root.path(), &node, "owner-host-sentinel");
    let sentinel = owner.runtime_directory.join("unrelated-owner-state");
    fs::write(&sentinel, b"preserve me").unwrap();

    owner.crash();
    owner.confirm_host_exit();

    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve me");
    fs::remove_file(sentinel).unwrap();
    fs::remove_dir(&owner.runtime_directory).unwrap();
}

#[test]
#[ignore = "spawned as an exact supervisor owner fixture"]
fn shared_host_owner_process_fixture() {
    let root = PathBuf::from(std::env::var_os(OWNER_FIXTURE_ROOT).unwrap());
    let marker = PathBuf::from(std::env::var_os(OWNER_FIXTURE_MARKER).unwrap());
    let node = PathBuf::from(std::env::var_os(OWNER_FIXTURE_NODE).unwrap());
    let generation = marker.file_stem().unwrap().to_string_lossy().into_owned();
    let entrypoint = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-query-retirement-fixture.mjs")
        .canonicalize()
        .unwrap();
    let environment = std::env::var("PATH")
        .ok()
        .map(|value| vec![("PATH".into(), value)])
        .unwrap_or_default();
    let configuration = ClaudeSdkHostSupervisorConfiguration::new(
        node,
        entrypoint,
        &root,
        &root,
        generation,
        environment,
    )
    .unwrap();
    let mut supervisor = ClaudeSdkHostSupervisor::new(configuration);
    let lease = supervisor.ensure_started().unwrap();
    write_marker(
        &marker,
        &json!({
            "hostProcessId": lease.process_id(),
            "runtimeDirectory": lease.endpoint().parent().unwrap(),
        }),
    );
    loop {
        thread::park();
    }
}

fn test_node_executable() -> PathBuf {
    if let Some(node) = std::env::var_os("DURE_NODE_BIN") {
        return PathBuf::from(node).canonicalize().unwrap();
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("node"))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("Node executable is required"))
        .canonicalize()
        .unwrap()
}

fn spawn_owner_process(root: &Path, node: &Path, generation: &str) -> OwnerProcessFixture {
    let marker_path = root.join(format!("{generation}.json"));
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", OWNER_FIXTURE_TEST, "--nocapture"])
        .env(OWNER_FIXTURE_ROOT, root)
        .env(OWNER_FIXTURE_MARKER, &marker_path)
        .env(OWNER_FIXTURE_NODE, node)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if let Ok(source) = fs::read(&marker_path)
            && let Ok(marker) = serde_json::from_slice::<OwnerProcessMarker>(&source)
        {
            return OwnerProcessFixture {
                child,
                host_process_id: Some(marker.host_process_id),
                runtime_directory: marker.runtime_directory,
            };
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "supervisor owner fixture exited before readiness"
        );
        assert!(
            Instant::now() < deadline,
            "supervisor owner fixture timed out"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn write_marker(path: &Path, value: &serde_json::Value) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(&serde_json::to_vec(value).unwrap()).unwrap();
    file.sync_all().unwrap();
}

fn process_is_live(process_id: u32) -> bool {
    (unsafe { libc::kill(process_id as libc::pid_t, 0) }) == 0
}

fn wait_for_process_exit(process_id: u32) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while process_is_live(process_id) {
        assert!(
            Instant::now() < deadline,
            "shared SDK Host remained orphaned"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_path_absence(path: &Path) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while path.exists() {
        assert!(
            Instant::now() < deadline,
            "shared SDK Host state remained orphaned"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn host_runtime_directory_count(root: &Path) -> usize {
    fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("ch."))
        .count()
}
