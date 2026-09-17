#![cfg(unix)]

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
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
use serde::{Deserialize, Serialize};

#[path = "support/native_process_sample.rs"]
mod native_process_sample;

use native_process_sample::{ProcessDelta, ProcessSample, process_sample};

#[cfg(target_os = "macos")]
#[path = "support/process_cpu_contract.rs"]
mod cpu_contract;

const EXPECTED_NODE_VERSION: &str = "24.15.0";
const EXPECTED_SDK_VERSION: &str = "0.3.234";
const EXPECTED_CLAUDE_CODE_VERSION: &str = "2.1.234";
const IDLE_SAMPLE_WINDOW: Duration = Duration::from_secs(1);
const SETTLE_WINDOW: Duration = Duration::from_millis(500);
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DriverMode {
    Empty,
    SdkImport,
}

impl DriverMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::SdkImport => "sdk-import",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaScriptMemory {
    rss: u64,
    heap_total: u64,
    heap_used: u64,
    external: u64,
    array_buffers: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportMarker {
    role: String,
    pid: u32,
    parent_pid: u32,
    mode: String,
    node_version: String,
    ready_duration_ms: f64,
    memory_before: JavaScriptMemory,
    memory_after: JavaScriptMemory,
    sdk_imported: bool,
    sdk_version: Option<String>,
    claude_code_version: Option<String>,
    native_package: Option<String>,
    native_package_present: bool,
    query_export_present: bool,
    startup_export_present: bool,
    import_duration_ms: f64,
}

#[derive(Debug)]
struct ProcessRow {
    pid: u32,
    parent_pid: u32,
    rss_kib: u64,
    command: String,
}

struct ManagedGeneration {
    runtime: PathBuf,
    discovery_root: PathBuf,
    cwd: PathBuf,
    descriptor: SessionDescriptor,
    stopped: bool,
}

impl ManagedGeneration {
    fn stop(&mut self) {
        let receipt = ManagedSessionStopper::new(&self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(exact_stop_request(&self.descriptor))
            .expect("the exact Claude SDK-import driver generation must stop");
        assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
        self.stopped = true;
    }
}

impl Drop for ManagedGeneration {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = ManagedSessionStopper::new(&self.runtime, &self.cwd)
                .with_discovery_root(&self.discovery_root)
                .stop(exact_stop_request(&self.descriptor));
        }
    }
}

struct ManagedDriverFixture {
    index: usize,
    generation: ManagedGeneration,
    marker: ImportMarker,
    create_duration_ms: f64,
}

struct ManagedRelayFixture {
    index: usize,
    generation: ManagedGeneration,
    create_duration_ms: f64,
}

struct SharedSdkHost {
    child: Child,
    marker: Option<ImportMarker>,
    stopped: bool,
}

impl SharedSdkHost {
    fn marker(&self) -> &ImportMarker {
        self.marker
            .as_ref()
            .expect("shared SDK Host marker must be initialized")
    }

    fn stop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            self.child.kill().unwrap();
        }
        self.child.wait().unwrap();
        self.stopped = true;
    }
}

impl Drop for SharedSdkHost {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct HmuxHarness {
    _root: tempfile::TempDir,
    runtime: PathBuf,
    node: PathBuf,
    cwd: PathBuf,
    driver: PathBuf,
    discovery_root: PathBuf,
    state_root: PathBuf,
}

impl HmuxHarness {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let discovery_root = root.path().join("discovery");
        let state_root = root.path().join("driver-state");
        fs::create_dir(&state_root).unwrap();
        fs::set_permissions(&state_root, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            runtime: required_executable("DURE_HMUX_RUNTIME_BIN"),
            node: required_executable("DURE_NODE_BIN"),
            cwd: std::env::current_dir().unwrap().canonicalize().unwrap(),
            driver: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/claude-sdk-import-hmux-fixture.mjs")
                .canonicalize()
                .unwrap(),
            discovery_root,
            state_root,
            _root: root,
        }
    }

    fn create_scenario(
        &self,
        mode: DriverMode,
        count: usize,
        label: &str,
    ) -> (Duration, Vec<ManagedDriverFixture>) {
        let scenario_started = Instant::now();
        // RuntimeBroker captures its child's stderr. Serial broker launches
        // prevent an unrelated concurrent fork from inheriting another
        // launcher's pipe while still leaving every completed driver alive for
        // the simultaneous 1/5/20 sample.
        let drivers = (0..count)
            .map(|index| self.create_driver(mode, count, index, label))
            .collect();
        (scenario_started.elapsed(), drivers)
    }

    fn create_driver(
        &self,
        mode: DriverMode,
        count: usize,
        index: usize,
        label: &str,
    ) -> ManagedDriverFixture {
        let identity = format!("claude-sdk-footprint-{label}-{count}-{index}");
        let state_directory = self.state_root.join(&identity);
        fs::create_dir(&state_directory).unwrap();
        fs::set_permissions(&state_directory, fs::Permissions::from_mode(0o700)).unwrap();
        let create_started = Instant::now();
        let created = ManagedSessionCreator::new(&self.runtime)
            .with_discovery_root(&self.discovery_root)
            .create(
                ManagedCreateRequest::new(
                    format!("{identity}-create"),
                    &identity,
                    format!("claude-sdk-footprint-{label}-{count}-workspace"),
                    "claude",
                    PermissionMode::Default,
                    &self.cwd,
                    vec![
                        self.node.to_string_lossy().into_owned(),
                        self.driver.to_string_lossy().into_owned(),
                        "--state-dir".into(),
                        state_directory.to_string_lossy().into_owned(),
                        "--mode".into(),
                        mode.as_str().into(),
                    ],
                    24,
                    80,
                )
                .unwrap()
                .with_required_managed_stop_request_version(
                    MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
                )
                .unwrap(),
            )
            .expect("the Hmux-managed Claude SDK footprint driver must reach Ready");
        let generation = ManagedGeneration {
            runtime: self.runtime.clone(),
            discovery_root: self.discovery_root.clone(),
            cwd: self.cwd.clone(),
            descriptor: created.session().descriptor().clone(),
            stopped: false,
        };
        let marker = wait_for_marker(&state_directory.join("driver.json"));
        validate_marker(&marker, mode, &generation.descriptor);
        ManagedDriverFixture {
            index,
            generation,
            marker,
            create_duration_ms: duration_millis(create_started.elapsed()),
        }
    }

    fn start_shared_sdk_host(&self) -> SharedSdkHost {
        let state_directory = self.state_root.join("shared-sdk-host");
        fs::create_dir(&state_directory).unwrap();
        fs::set_permissions(&state_directory, fs::Permissions::from_mode(0o700)).unwrap();
        let child = Command::new(&self.node)
            .args([
                self.driver.as_os_str(),
                "--state-dir".as_ref(),
                state_directory.as_os_str(),
                "--mode".as_ref(),
                "sdk-import".as_ref(),
            ])
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the shared Claude SDK Host must start");
        let mut host = SharedSdkHost {
            child,
            marker: None,
            stopped: false,
        };
        let marker = wait_for_marker(&state_directory.join("driver.json"));
        validate_shared_sdk_host_marker(&marker, host.child.id());
        host.marker = Some(marker);
        host
    }

    fn create_relay_scenario(&self, count: usize) -> (Duration, Vec<ManagedRelayFixture>) {
        let scenario_started = Instant::now();
        let relays = (0..count)
            .map(|index| self.create_relay(count, index))
            .collect();
        (scenario_started.elapsed(), relays)
    }

    fn create_relay(&self, count: usize, index: usize) -> ManagedRelayFixture {
        let identity = format!("claude-sdk-native-relay-{count}-{index}");
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let create_started = Instant::now();
        let created = ManagedSessionCreator::new(&self.runtime)
            .with_discovery_root(&self.discovery_root)
            .create(
                ManagedCreateRequest::new(
                    format!("{identity}-create"),
                    &identity,
                    format!("claude-sdk-native-relay-{count}-workspace"),
                    "claude",
                    PermissionMode::Default,
                    &self.cwd,
                    vec![
                        executable.to_string_lossy().into_owned(),
                        "--ignored".into(),
                        "--exact".into(),
                        "claude_sdk_native_relay_fixture".into(),
                        "--nocapture".into(),
                    ],
                    24,
                    80,
                )
                .unwrap()
                .with_required_managed_stop_request_version(
                    MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
                )
                .unwrap(),
            )
            .expect("the Hmux-managed native Claude relay must reach Ready");
        ManagedRelayFixture {
            index,
            generation: ManagedGeneration {
                runtime: self.runtime.clone(),
                discovery_root: self.discovery_root.clone(),
                cwd: self.cwd.clone(),
                descriptor: created.session().descriptor().clone(),
                stopped: false,
            },
            create_duration_ms: duration_millis(create_started.elapsed()),
        }
    }
}

#[test]
#[ignore = "requires a built Hmux runtime and the channel-pinned Claude driver dependencies"]
fn claude_sdk_import_attests_the_pinned_tuple_without_starting_claude_or_codex() {
    let harness = HmuxHarness::new();
    let (_, mut drivers) = harness.create_scenario(DriverMode::SdkImport, 1, "tuple");
    let owned_pids = assert_scenario_process_trees(&drivers);
    let sample = process_sample(drivers[0].marker.pid).expect("driver metrics must be observable");
    if let Some(socket_count) = sample.socket_count {
        assert_eq!(socket_count, 0, "SDK import must not open a network socket");
    }
    stop_and_prove_absence(&mut drivers, &owned_pids);
}

#[test]
#[ignore = "launched as the native per-agent relay process by the footprint comparison"]
fn claude_sdk_native_relay_fixture() {
    let mut input = std::io::stdin().lock();
    let mut buffer = [0_u8; 1024];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => panic!("native relay stdin failed: {error}"),
        }
    }
}

#[test]
#[ignore = "resource benchmark; requires Hmux runtime and installed Claude driver dependencies"]
fn shared_claude_sdk_host_with_hmux_native_relays_measures_1_5_20() {
    let harness = HmuxHarness::new();
    let mut shared_host = harness.start_shared_sdk_host();
    let shared_pid = shared_host.child.id();
    assert_shared_sdk_host_process_tree(shared_pid);
    let mut scenarios = Vec::new();

    for count in [1, 5, 20] {
        let (create_wall, mut relays) = harness.create_relay_scenario(count);
        let owned_pids = assert_relay_process_trees(&relays);
        thread::sleep(SETTLE_WINDOW);
        let shared_before = process_sample(shared_pid).expect("shared SDK Host must be observable");
        let relay_before = relays.iter().map(sample_relay).collect::<Vec<_>>();
        thread::sleep(IDLE_SAMPLE_WINDOW);
        let shared_after = process_sample(shared_pid).expect("shared SDK Host must be observable");
        let relay_after = relays.iter().map(sample_relay).collect::<Vec<_>>();

        if let Some(socket_count) = shared_after.socket_count {
            assert_eq!(socket_count, 0, "SDK import must not open a socket");
        }
        let measurements = relays
            .iter()
            .zip(relay_before.iter().zip(&relay_after))
            .map(|(relay, (before, after))| {
                if let Some(socket_count) = after.relay.socket_count {
                    assert_eq!(socket_count, 0, "native relay must not open a socket yet");
                }
                RelayMeasurement::new(relay, before, after)
            })
            .collect::<Vec<_>>();
        scenarios.push(SharedRelayScenario::new(
            count,
            create_wall,
            &shared_before,
            shared_after,
            measurements,
        ));
        stop_relays_and_prove_absence(&mut relays, &owned_pids);
    }

    let marker = shared_host.marker();
    let report = SharedRelayReport {
        schema_version: 1,
        node_version: EXPECTED_NODE_VERSION,
        sdk_version: EXPECTED_SDK_VERSION,
        claude_code_version: EXPECTED_CLAUDE_CODE_VERSION,
        hardware: hardware_context(),
        method: MeasurementMethod {
            process_memory: process_memory_method(),
            idle_window_ms: IDLE_SAMPLE_WINDOW.as_millis() as u64,
            settle_window_ms: SETTLE_WINDOW.as_millis() as u64,
            creation_policy: "one persistent SDK Host; serial RuntimeBroker launches; all relays remain live for each simultaneous sample",
            native_runtime_policy: "workspace ignores bundled native packages; runtime rejects the current platform native package",
            provider_start_policy: "one SDK module import only; relay is a native stdin process-shape fixture; Query/startup and credentials are not invoked",
        },
        shared_sdk_import_duration_ms: marker.import_duration_ms,
        shared_javascript_memory_before: marker.memory_before.clone(),
        shared_javascript_memory_after: marker.memory_after.clone(),
        scenarios,
    };
    shared_host.stop();
    wait_for_numeric_process_absence(&BTreeSet::from([shared_pid]));
    println!(
        "claude_sdk_relay_footprint={}",
        serde_json::to_string(&report).unwrap()
    );
}

#[test]
#[ignore = "resource benchmark; requires Hmux runtime and installed Claude driver dependencies"]
fn claude_sdk_driver_footprint_matrix_1_5_20_preserves_exact_hmux_ownership() {
    let harness = HmuxHarness::new();
    let mut scenarios = Vec::new();

    for count in [1, 5, 20] {
        for mode in [DriverMode::Empty, DriverMode::SdkImport] {
            let label = mode.as_str();
            let (create_wall, mut drivers) = harness.create_scenario(mode, count, label);
            let owned_pids = assert_scenario_process_trees(&drivers);

            thread::sleep(SETTLE_WINDOW);
            let before = drivers
                .iter()
                .map(sample_driver)
                .collect::<Vec<DriverProcessSamples>>();
            thread::sleep(IDLE_SAMPLE_WINDOW);
            let after = drivers
                .iter()
                .map(sample_driver)
                .collect::<Vec<DriverProcessSamples>>();

            let measurements = drivers
                .iter()
                .zip(before.iter().zip(&after))
                .map(|(driver, (before, after))| {
                    if let Some(socket_count) = after.driver.socket_count {
                        assert_eq!(
                            socket_count, 0,
                            "SDK import without Query must not open a network socket"
                        );
                    }
                    DriverMeasurement::new(driver, before, after)
                })
                .collect::<Vec<_>>();
            let scenario = ScenarioMeasurement::new(mode, count, create_wall, measurements);

            stop_and_prove_absence(&mut drivers, &owned_pids);
            scenarios.push(scenario);
        }
    }

    let report = FootprintReport {
        schema_version: 1,
        node_version: EXPECTED_NODE_VERSION,
        sdk_version: EXPECTED_SDK_VERSION,
        claude_code_version: EXPECTED_CLAUDE_CODE_VERSION,
        hardware: hardware_context(),
        method: MeasurementMethod {
            process_memory: process_memory_method(),
            idle_window_ms: IDLE_SAMPLE_WINDOW.as_millis() as u64,
            settle_window_ms: SETTLE_WINDOW.as_millis() as u64,
            creation_policy: "serial RuntimeBroker launches; all completed generations remain live for each simultaneous sample",
            native_runtime_policy: "workspace ignores bundled native packages; runtime rejects the current platform native package",
            provider_start_policy: "SDK module import only; Query/startup and credentials are not invoked",
        },
        scenarios,
    };
    println!(
        "claude_sdk_footprint_matrix={}",
        serde_json::to_string(&report).unwrap()
    );
}

fn validate_marker(marker: &ImportMarker, mode: DriverMode, descriptor: &SessionDescriptor) {
    assert_eq!(marker.role, "dure-claude-driver");
    assert_eq!(marker.mode, mode.as_str());
    assert_eq!(marker.pid, descriptor.provider_process.process_id);
    assert_eq!(marker.parent_pid, descriptor.host_process.process_id);
    assert_eq!(marker.node_version, EXPECTED_NODE_VERSION);
    assert!(marker.ready_duration_ms >= marker.import_duration_ms);
    match mode {
        DriverMode::Empty => {
            assert!(!marker.sdk_imported);
            assert_eq!(marker.sdk_version, None);
            assert_eq!(marker.claude_code_version, None);
            assert_eq!(marker.native_package, None);
            assert!(!marker.query_export_present);
            assert!(!marker.startup_export_present);
        }
        DriverMode::SdkImport => {
            assert!(
                marker.sdk_imported,
                "the driver did not import the pinned SDK"
            );
            assert_eq!(marker.sdk_version.as_deref(), Some(EXPECTED_SDK_VERSION));
            assert_eq!(
                marker.claude_code_version.as_deref(),
                Some(EXPECTED_CLAUDE_CODE_VERSION)
            );
            assert!(marker.native_package.is_some());
            assert!(marker.query_export_present);
            assert!(marker.startup_export_present);
            assert!(marker.import_duration_ms > 0.0);
        }
    }
    assert!(!marker.native_package_present);
}

fn validate_shared_sdk_host_marker(marker: &ImportMarker, process_id: u32) {
    assert_eq!(marker.role, "dure-claude-driver");
    assert_eq!(marker.mode, DriverMode::SdkImport.as_str());
    assert_eq!(marker.pid, process_id);
    assert_eq!(marker.parent_pid, std::process::id());
    assert_eq!(marker.node_version, EXPECTED_NODE_VERSION);
    assert_eq!(marker.sdk_version.as_deref(), Some(EXPECTED_SDK_VERSION));
    assert_eq!(
        marker.claude_code_version.as_deref(),
        Some(EXPECTED_CLAUDE_CODE_VERSION)
    );
    assert!(marker.sdk_imported);
    assert!(marker.query_export_present);
    assert!(marker.startup_export_present);
    assert!(marker.import_duration_ms > 0.0);
    assert!(marker.ready_duration_ms >= marker.import_duration_ms);
    assert!(marker.native_package.is_some());
    assert!(!marker.native_package_present);
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
        format!("claude-sdk-import-stop-{}", descriptor.session_id),
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

fn wait_for_marker(path: &Path) -> ImportMarker {
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

fn process_descendants(rows: &[ProcessRow], root: u32) -> Vec<&ProcessRow> {
    let mut tree = BTreeSet::from([root]);
    loop {
        let previous_len = tree.len();
        for row in rows {
            if tree.contains(&row.parent_pid) {
                tree.insert(row.pid);
            }
        }
        if tree.len() == previous_len {
            break;
        }
    }
    rows.iter()
        .filter(|row| row.pid != root && tree.contains(&row.pid))
        .collect()
}

fn assert_scenario_process_trees(drivers: &[ManagedDriverFixture]) -> BTreeSet<u32> {
    let rows = process_rows();
    let mut owned_pids = BTreeSet::new();
    for driver in drivers {
        let descriptor = &driver.generation.descriptor;
        let descendants = process_descendants(&rows, descriptor.host_process.process_id);
        assert_eq!(
            descendants.len(),
            1,
            "SDK import must not start Claude, Codex app-server, or any other child: {descendants:?}"
        );
        let provider = descendants[0];
        assert_eq!(provider.pid, driver.marker.pid);
        assert_eq!(provider.parent_pid, descriptor.host_process.process_id);
        assert!(provider.rss_kib > 0, "provider RSS must be observable");
        assert!(!provider.command.contains("codex"));
        assert!(!provider.command.contains("app-server"));
        owned_pids.insert(descriptor.host_process.process_id);
        owned_pids.insert(provider.pid);
    }
    owned_pids
}

fn assert_shared_sdk_host_process_tree(process_id: u32) {
    let rows = process_rows();
    let host = rows
        .iter()
        .find(|row| row.pid == process_id)
        .expect("shared SDK Host process must exist");
    assert!(host.rss_kib > 0);
    assert!(!host.command.contains("codex"));
    assert!(!host.command.contains("app-server"));
    assert!(
        process_descendants(&rows, process_id).is_empty(),
        "SDK import must not start Claude or any other child"
    );
}

fn assert_relay_process_trees(relays: &[ManagedRelayFixture]) -> BTreeSet<u32> {
    let rows = process_rows();
    let mut owned_pids = BTreeSet::new();
    for relay in relays {
        let descriptor = &relay.generation.descriptor;
        let descendants = process_descendants(&rows, descriptor.host_process.process_id);
        assert_eq!(descendants.len(), 1, "relay Host must own one native root");
        let provider = descendants[0];
        assert_eq!(provider.pid, descriptor.provider_process.process_id);
        assert_eq!(provider.parent_pid, descriptor.host_process.process_id);
        assert!(provider.rss_kib > 0);
        assert!(provider.command.contains("claude_sdk_native_relay_fixture"));
        assert!(!provider.command.contains("codex"));
        assert!(!provider.command.contains("app-server"));
        owned_pids.insert(descriptor.host_process.process_id);
        owned_pids.insert(provider.pid);
    }
    owned_pids
}

fn stop_and_prove_absence(drivers: &mut [ManagedDriverFixture], owned_pids: &BTreeSet<u32>) {
    for driver in drivers.iter_mut() {
        driver.generation.stop();
    }
    for driver in drivers.iter() {
        wait_for_process_absence(&driver.generation.descriptor.host_process);
        wait_for_process_absence(&driver.generation.descriptor.provider_process);
    }
    wait_for_numeric_process_absence(owned_pids);
}

fn stop_relays_and_prove_absence(relays: &mut [ManagedRelayFixture], owned_pids: &BTreeSet<u32>) {
    for relay in relays.iter_mut() {
        relay.generation.stop();
    }
    for relay in relays.iter() {
        wait_for_process_absence(&relay.generation.descriptor.host_process);
        wait_for_process_absence(&relay.generation.descriptor.provider_process);
    }
    wait_for_numeric_process_absence(owned_pids);
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

fn wait_for_numeric_process_absence(processes: &BTreeSet<u32>) {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        let rows = process_rows();
        if rows.iter().all(|row| !processes.contains(&row.pid)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "an Hmux-owned process survived exact stop"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

struct DriverProcessSamples {
    host: ProcessSample,
    driver: ProcessSample,
}

struct RelayProcessSamples {
    host: ProcessSample,
    relay: ProcessSample,
}

fn sample_driver(driver: &ManagedDriverFixture) -> DriverProcessSamples {
    DriverProcessSamples {
        host: process_sample(driver.generation.descriptor.host_process.process_id)
            .expect("Hmux Host metrics must be observable"),
        driver: process_sample(driver.marker.pid).expect("driver metrics must be observable"),
    }
}

fn sample_relay(relay: &ManagedRelayFixture) -> RelayProcessSamples {
    RelayProcessSamples {
        host: process_sample(relay.generation.descriptor.host_process.process_id)
            .expect("relay Hmux Host metrics must be observable"),
        relay: process_sample(relay.generation.descriptor.provider_process.process_id)
            .expect("native relay metrics must be observable"),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverMeasurement {
    index: usize,
    create_duration_ms: f64,
    ready_duration_ms: f64,
    import_duration_ms: f64,
    native_package: Option<String>,
    javascript_memory_before: JavaScriptMemory,
    javascript_memory_after: JavaScriptMemory,
    host: ProcessSample,
    driver: ProcessSample,
    host_idle_delta: ProcessDelta,
    driver_idle_delta: ProcessDelta,
}

impl DriverMeasurement {
    fn new(
        fixture: &ManagedDriverFixture,
        before: &DriverProcessSamples,
        after: &DriverProcessSamples,
    ) -> Self {
        Self {
            index: fixture.index,
            create_duration_ms: fixture.create_duration_ms,
            ready_duration_ms: fixture.marker.ready_duration_ms,
            import_duration_ms: fixture.marker.import_duration_ms,
            native_package: fixture.marker.native_package.clone(),
            javascript_memory_before: fixture.marker.memory_before.clone(),
            javascript_memory_after: fixture.marker.memory_after.clone(),
            host: after.host.clone(),
            driver: after.driver.clone(),
            host_idle_delta: ProcessDelta::between(&before.host, &after.host),
            driver_idle_delta: ProcessDelta::between(&before.driver, &after.driver),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioTotals {
    host_rss_kib: u64,
    driver_rss_kib: u64,
    host_physical_footprint_kib: Option<u64>,
    driver_physical_footprint_kib: Option<u64>,
    driver_fd_count: Option<u64>,
    driver_socket_count: Option<u64>,
    host_idle_cpu_nanos: Option<u64>,
    driver_idle_cpu_nanos: Option<u64>,
    driver_idle_interrupt_wakeups: Option<u64>,
    driver_idle_package_wakeups: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioMeasurement {
    mode: &'static str,
    count: usize,
    create_wall_ms: f64,
    ready_p50_ms: f64,
    ready_p95_ms: f64,
    import_p50_ms: f64,
    import_p95_ms: f64,
    totals: ScenarioTotals,
    drivers: Vec<DriverMeasurement>,
}

impl ScenarioMeasurement {
    fn new(
        mode: DriverMode,
        count: usize,
        create_wall: Duration,
        drivers: Vec<DriverMeasurement>,
    ) -> Self {
        let ready = drivers
            .iter()
            .map(|driver| driver.ready_duration_ms)
            .collect::<Vec<_>>();
        let import = drivers
            .iter()
            .map(|driver| driver.import_duration_ms)
            .collect::<Vec<_>>();
        let totals = ScenarioTotals {
            host_rss_kib: drivers.iter().map(|driver| driver.host.rss_kib).sum(),
            driver_rss_kib: drivers.iter().map(|driver| driver.driver.rss_kib).sum(),
            host_physical_footprint_kib: sum_optional(
                drivers
                    .iter()
                    .map(|driver| driver.host.physical_footprint_kib),
            ),
            driver_physical_footprint_kib: sum_optional(
                drivers
                    .iter()
                    .map(|driver| driver.driver.physical_footprint_kib),
            ),
            driver_fd_count: sum_optional(drivers.iter().map(|driver| driver.driver.fd_count)),
            driver_socket_count: sum_optional(
                drivers.iter().map(|driver| driver.driver.socket_count),
            ),
            host_idle_cpu_nanos: sum_optional(
                drivers
                    .iter()
                    .map(|driver| driver.host_idle_delta.total_cpu_nanos()),
            ),
            driver_idle_cpu_nanos: sum_optional(
                drivers
                    .iter()
                    .map(|driver| driver.driver_idle_delta.total_cpu_nanos()),
            ),
            driver_idle_interrupt_wakeups: sum_optional(
                drivers
                    .iter()
                    .map(|driver| driver.driver_idle_delta.interrupt_wakeups),
            ),
            driver_idle_package_wakeups: sum_optional(
                drivers
                    .iter()
                    .map(|driver| driver.driver_idle_delta.package_idle_wakeups),
            ),
        };
        Self {
            mode: mode.as_str(),
            count,
            create_wall_ms: duration_millis(create_wall),
            ready_p50_ms: percentile(&ready, 0.50),
            ready_p95_ms: percentile(&ready, 0.95),
            import_p50_ms: percentile(&import, 0.50),
            import_p95_ms: percentile(&import, 0.95),
            totals,
            drivers,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayMeasurement {
    index: usize,
    create_duration_ms: f64,
    host: ProcessSample,
    relay: ProcessSample,
    host_idle_delta: ProcessDelta,
    relay_idle_delta: ProcessDelta,
}

impl RelayMeasurement {
    fn new(
        fixture: &ManagedRelayFixture,
        before: &RelayProcessSamples,
        after: &RelayProcessSamples,
    ) -> Self {
        Self {
            index: fixture.index,
            create_duration_ms: fixture.create_duration_ms,
            host: after.host.clone(),
            relay: after.relay.clone(),
            host_idle_delta: ProcessDelta::between(&before.host, &after.host),
            relay_idle_delta: ProcessDelta::between(&before.relay, &after.relay),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedRelayTotals {
    shared_sdk_rss_kib: u64,
    relay_rss_kib: u64,
    hmux_host_rss_kib: u64,
    shared_sdk_physical_footprint_kib: Option<u64>,
    relay_physical_footprint_kib: Option<u64>,
    hmux_host_physical_footprint_kib: Option<u64>,
    combined_physical_footprint_kib: Option<u64>,
    relay_fd_count: Option<u64>,
    relay_socket_count: Option<u64>,
    shared_sdk_idle_cpu_nanos: Option<u64>,
    relay_idle_cpu_nanos: Option<u64>,
    relay_idle_interrupt_wakeups: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedRelayScenario {
    count: usize,
    create_wall_ms: f64,
    relay_create_p50_ms: f64,
    relay_create_p95_ms: f64,
    totals: SharedRelayTotals,
    shared_sdk_host: ProcessSample,
    shared_sdk_idle_delta: ProcessDelta,
    relays: Vec<RelayMeasurement>,
}

impl SharedRelayScenario {
    fn new(
        count: usize,
        create_wall: Duration,
        shared_before: &ProcessSample,
        shared_after: ProcessSample,
        relays: Vec<RelayMeasurement>,
    ) -> Self {
        let create_durations = relays
            .iter()
            .map(|relay| relay.create_duration_ms)
            .collect::<Vec<_>>();
        let relay_physical_footprint_kib = sum_optional(
            relays
                .iter()
                .map(|relay| relay.relay.physical_footprint_kib),
        );
        let hmux_host_physical_footprint_kib =
            sum_optional(relays.iter().map(|relay| relay.host.physical_footprint_kib));
        let combined_physical_footprint_kib = match (
            shared_after.physical_footprint_kib,
            relay_physical_footprint_kib,
            hmux_host_physical_footprint_kib,
        ) {
            (Some(shared), Some(relay), Some(host)) => {
                Some(shared.saturating_add(relay).saturating_add(host))
            }
            _ => None,
        };
        let shared_sdk_idle_delta = ProcessDelta::between(shared_before, &shared_after);
        let totals = SharedRelayTotals {
            shared_sdk_rss_kib: shared_after.rss_kib,
            relay_rss_kib: relays.iter().map(|relay| relay.relay.rss_kib).sum(),
            hmux_host_rss_kib: relays.iter().map(|relay| relay.host.rss_kib).sum(),
            shared_sdk_physical_footprint_kib: shared_after.physical_footprint_kib,
            relay_physical_footprint_kib,
            hmux_host_physical_footprint_kib,
            combined_physical_footprint_kib,
            relay_fd_count: sum_optional(relays.iter().map(|relay| relay.relay.fd_count)),
            relay_socket_count: sum_optional(relays.iter().map(|relay| relay.relay.socket_count)),
            shared_sdk_idle_cpu_nanos: shared_sdk_idle_delta.total_cpu_nanos(),
            relay_idle_cpu_nanos: sum_optional(
                relays
                    .iter()
                    .map(|relay| relay.relay_idle_delta.total_cpu_nanos()),
            ),
            relay_idle_interrupt_wakeups: sum_optional(
                relays
                    .iter()
                    .map(|relay| relay.relay_idle_delta.interrupt_wakeups),
            ),
        };
        Self {
            count,
            create_wall_ms: duration_millis(create_wall),
            relay_create_p50_ms: percentile(&create_durations, 0.50),
            relay_create_p95_ms: percentile(&create_durations, 0.95),
            totals,
            shared_sdk_host: shared_after,
            shared_sdk_idle_delta,
            relays,
        }
    }
}

fn sum_optional(mut values: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    values.try_fold(0_u64, |total, value| Some(total.saturating_add(value?)))
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    assert!(!values.is_empty());
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() - 1) as f64 * quantile).ceil() as usize;
    sorted[index]
}

fn duration_millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareContext {
    operating_system: &'static str,
    architecture: &'static str,
    os_version: Option<String>,
    model: Option<String>,
    cpu: Option<String>,
    memory_bytes: Option<u64>,
}

fn hardware_context() -> HardwareContext {
    #[cfg(target_os = "macos")]
    let context = HardwareContext {
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        os_version: command_value("sw_vers", &["-productVersion"]),
        model: command_value("sysctl", &["-n", "hw.model"]),
        cpu: command_value("sysctl", &["-n", "machdep.cpu.brand_string"]),
        memory_bytes: command_value("sysctl", &["-n", "hw.memsize"])
            .and_then(|value| value.parse().ok()),
    };
    #[cfg(not(target_os = "macos"))]
    let context = HardwareContext {
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        os_version: command_value("uname", &["-sr"]),
        model: None,
        cpu: None,
        memory_bytes: None,
    };
    context
}

fn command_value(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasurementMethod {
    process_memory: &'static str,
    idle_window_ms: u64,
    settle_window_ms: u64,
    creation_policy: &'static str,
    native_runtime_policy: &'static str,
    provider_start_policy: &'static str,
}

#[cfg(target_os = "macos")]
fn process_memory_method() -> &'static str {
    "proc_pid_rusage RUSAGE_INFO_V4 attributed physical footprint + resident bytes; proc_pidinfo PROC_PIDLISTFDS"
}

#[cfg(target_os = "linux")]
fn process_memory_method() -> &'static str {
    "/proc status/stat/fd; physical footprint unavailable"
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_memory_method() -> &'static str {
    "ps RSS fallback; physical footprint, CPU wakeups, and descriptors unavailable"
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FootprintReport {
    schema_version: u32,
    node_version: &'static str,
    sdk_version: &'static str,
    claude_code_version: &'static str,
    hardware: HardwareContext,
    method: MeasurementMethod,
    scenarios: Vec<ScenarioMeasurement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedRelayReport {
    schema_version: u32,
    node_version: &'static str,
    sdk_version: &'static str,
    claude_code_version: &'static str,
    hardware: HardwareContext,
    method: MeasurementMethod,
    shared_sdk_import_duration_ms: f64,
    shared_javascript_memory_before: JavaScriptMemory,
    shared_javascript_memory_after: JavaScriptMemory,
    scenarios: Vec<SharedRelayScenario>,
}
