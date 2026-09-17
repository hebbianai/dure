//! Fresh-process proof that a blocked local census is killed and reaped.
#![cfg(unix)]

use hmux_client::{
    LocalProcessGenerationStatus, ProcessDescriptor, probe_local_process_generation,
};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, HostLifetimeIdentity,
    LocalEndpoint, LocalEndpointKind, ManifestCommon, ManifestLimits, ReadyManifest, SessionClass,
    StartingManifest,
};
use hmux_host::local_protocol::{ProcessProof, ProtocolVersion, RuntimeContext, VersionRange};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

fn hmux_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_hmux"))
}

fn exact_process_generation_is_absent(process: &ProcessDescriptor) -> bool {
    matches!(
        probe_local_process_generation(process),
        Ok(LocalProcessGenerationStatus::Absent)
    )
}

fn publish_ready(root: &DiscoveryRoot) -> DiscoveryKey {
    let key = DiscoveryKey::new("workspace", "standalone-kill", "runner-1", 4).unwrap();
    let session = root.session(key.clone()).unwrap();
    let common = ManifestCommon {
        launch_program: None,
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: Vec::new(),
        lifetime: HostLifetimeIdentity {
            workspace_id: "workspace".into(),
            session_id: "standalone-kill".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 4,
        },
        host_instance_id: "host-kill".into(),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: None,
        },
        // Stay positive as a pid_t while remaining far outside the macOS PID
        // range, so even a resolver regression cannot signal another process.
        host_process: ProcessProof {
            process_id: 2_000_000_000,
            start_marker: "host-start-kill".into(),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Standalone,
        session_name: Some("fixture-kill".into()),
        retirement_policy: None,
    };
    let lock = session.acquire_lifetime_lock().unwrap();
    session
        .publish_starting(
            &lock,
            StartingManifest {
                common: common.clone(),
                starting_unix_ms: 2,
            },
        )
        .unwrap();
    session
        .publish_ready(
            &lock,
            ReadyManifest {
                common,
                provider_process: ProcessProof {
                    process_id: 2_000_000_001,
                    start_marker: "provider-start-kill".into(),
                },
                terminal_epoch: "terminal-kill".into(),
                ready_output_seq: 8,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: "host.sock".into(),
                },
                capability_token: "token-kill".into(),
                ready_unix_ms: 3,
            },
        )
        .unwrap();
    key
}

fn assert_helper_generation_exited(generation_path: &std::path::Path) {
    let process: ProcessDescriptor = serde_json::from_slice(
        &std::fs::read(generation_path)
            .expect("the delayed helper must publish its exact process generation before sleeping"),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    while !exact_process_generation_is_absent(&process) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        exact_process_generation_is_absent(&process),
        "census helper generation {process:?} leaked or could not be observed safely"
    );
}

#[test]
fn delayed_census_returns_typed_timeout_and_reaps_the_helper() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    DiscoveryRoot::create(&discovery_root).unwrap();
    let generation_path = fixture.path().join("worker-generation.json");
    let started = Instant::now();

    let output = Command::new(hmux_executable())
        .args([
            "--discovery-root",
            discovery_root.to_str().unwrap(),
            "--json",
            "ls",
            "--probe-budget-ms",
            "250",
        ])
        .env("HMUX_TEST_DISCOVERY_CENSUS_DELAY_MS", "5000")
        .env(
            "HMUX_TEST_DISCOVERY_CENSUS_GENERATION_PATH",
            &generation_path,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(started.elapsed() < Duration::from_secs(2));
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(document["complete"], false);
    assert_eq!(document["sessions"], serde_json::json!([]));
    assert_eq!(document["error"]["code"], "hmux_discovery_census_timeout");
    assert!(String::from_utf8_lossy(&output.stderr).contains("hmux_discovery_census_timeout"));

    assert_helper_generation_exited(&generation_path);
}

#[test]
fn screen_read_reports_its_discovery_deadline_and_reaps_the_helper() {
    assert_screen_read_discovery_deadline(None);
    assert_screen_read_discovery_deadline(Some("250"));
}

fn assert_screen_read_discovery_deadline(deadline_ms: Option<&str>) {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    DiscoveryRoot::create(&discovery_root).unwrap();
    let generation_path = fixture.path().join("read-worker-generation.json");
    let started = Instant::now();
    let mut command = Command::new(hmux_executable());
    command.args([
        "--discovery-root",
        discovery_root.to_str().unwrap(),
        "read",
        "missing-session",
    ]);
    if let Some(deadline_ms) = deadline_ms {
        command.args(["--deadline-ms", deadline_ms]);
    }
    let output = command
        .env("HMUX_TEST_DISCOVERY_CENSUS_DELAY_MS", "5000")
        .env(
            "HMUX_TEST_DISCOVERY_CENSUS_GENERATION_PATH",
            &generation_path,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());
    let expected_budget = deadline_ms.unwrap_or("2500").parse::<u64>().unwrap();
    assert!(started.elapsed() < Duration::from_millis(expected_budget + 1000));
    assert_helper_generation_exited(&generation_path);
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("hmux_read_deadline_exceeded"), "{error}");
    assert!(error.contains("stage=discovery"), "{error}");
    assert!(
        error.contains(&format!("deadlineMs={expected_budget}")),
        "{error}"
    );
}

#[test]
fn delayed_name_resolution_times_out_before_kill_mutates_the_session() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    let root = DiscoveryRoot::create(&discovery_root).unwrap();
    let key = publish_ready(&root);
    let generation_path = fixture.path().join("resolve-worker-generation.json");
    let started = Instant::now();

    let output = Command::new(hmux_executable())
        .args([
            "--discovery-root",
            discovery_root.to_str().unwrap(),
            "--json",
            "kill",
            "fixture-kill",
            "--timeout-ms",
            "100",
        ])
        .env("HMUX_TEST_DISCOVERY_CENSUS_DELAY_MS", "5000")
        .env(
            "HMUX_TEST_DISCOVERY_CENSUS_GENERATION_PATH",
            &generation_path,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(String::from_utf8_lossy(&output.stderr).contains("hmux_discovery_census_timeout"));
    assert!(matches!(
        root.open_session(key).unwrap().read_manifest().unwrap(),
        DiscoveryManifest::Ready(_)
    ));
    assert_helper_generation_exited(&generation_path);
}

#[test]
fn complete_json_listing_keeps_the_legacy_array_shape() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    DiscoveryRoot::create(&discovery_root).unwrap();

    let output = Command::new(hmux_executable())
        .args([
            "--discovery-root",
            discovery_root.to_str().unwrap(),
            "--json",
            "ls",
            "--no-probe",
            "--probe-budget-ms",
            "1000",
        ])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        serde_json::json!([])
    );
}

#[test]
fn exact_session_show_bypasses_unrelated_session_scan_overflow() {
    let fixture = tempfile::tempdir().unwrap();
    let discovery_root = fixture.path().join("discovery");
    let root = DiscoveryRoot::create(&discovery_root).unwrap();
    let key = publish_ready(&root);
    let workspace = root
        .path()
        .join(key.relative_path())
        .parent()
        .unwrap()
        .to_path_buf();
    for index in 0..ManifestLimits::default().max_session_census_scan_entries {
        std::fs::write(workspace.join(format!("s_unrelated-{index}")), []).unwrap();
    }

    let output = Command::new(hmux_executable())
        .args([
            "--discovery-root",
            discovery_root.to_str().unwrap(),
            "--json",
            "session",
            "show",
            "standalone-kill",
        ])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(document["session_id"], "standalone-kill");
    assert_eq!(document["workspace_id"], "workspace");
}
