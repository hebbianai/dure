//! End-to-end proof for `hmux attach` after a reboot-style Host loss.
//!
//! The fixture deliberately leaves a durable Ready manifest and resurrection
//! recipe while removing both processes and the temporary Unix socket. That is
//! the exact state that previously leaked `No such file or directory`.
#![cfg(unix)]

use hmux_client::{
    LocalSessionCatalog, SessionClass, SessionLifecycle, SessionProbeStatus,
    SessionRetirementPolicy, SessionSelector, StandaloneCreateRequest, StandaloneSessionCreator,
    TerminalDefaultColors, probe_local_session_exact,
};
use hmux_host::local_discovery::{DiscoveryRoot, LifetimeLock};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const ATTACH_TIMEOUT: Duration = Duration::from_secs(15);

#[path = "attach_recovery/launch_inputs.rs"]
mod launch_inputs;

fn hmux_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_hmux"))
}

fn runtime_executable() -> PathBuf {
    let runtime =
        hmux_executable().with_file_name(format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX));
    assert!(
        runtime.is_file(),
        "hmux-runtime is missing at {}",
        runtime.display()
    );
    runtime
}

struct StaleFixture {
    _state: tempfile::TempDir,
    discovery_root: PathBuf,
    source_session_id: String,
    source_workspace_id: String,
}

impl StaleFixture {
    fn safe_shell(name: &str) -> Self {
        Self::create(name, Vec::new(), None, None, None)
    }

    fn safe_shell_with_retirement_policy(
        name: &str,
        retirement_policy: SessionRetirementPolicy,
        colors: TerminalDefaultColors,
    ) -> Self {
        Self::create(
            name,
            Vec::new(),
            None,
            Some(retirement_policy),
            Some(colors),
        )
    }

    fn explicit_command(name: &str, marker: &Path) -> Self {
        Self::create(
            name,
            vec![
                "/bin/sh".into(),
                "-c".into(),
                format!("printf x >> '{}'; sleep 60", marker.display()),
            ],
            Some(marker),
            None,
            None,
        )
    }

    fn create(
        name: &str,
        command: Vec<String>,
        ready_file: Option<&Path>,
        retirement_policy: Option<SessionRetirementPolicy>,
        colors: Option<TerminalDefaultColors>,
    ) -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let request = StandaloneCreateRequest::new(
            state.path().canonicalize().unwrap(),
            Some(name.to_string()),
            command,
            24,
            80,
        )
        .unwrap()
        .with_retirement_policy_option(retirement_policy)
        .unwrap()
        .with_terminal_default_colors_option(colors)
        .unwrap();
        let created = StandaloneSessionCreator::new(runtime_executable())
            .with_discovery_root(&discovery_root)
            .create(request)
            .unwrap();
        let descriptor = created.session().descriptor().clone();
        if let Some(path) = ready_file {
            wait_for_file(path);
        }

        kill_process(descriptor.host_process.process_id);
        kill_process(descriptor.provider_process.process_id);
        wait_for_process_exit(descriptor.host_process.process_id);
        wait_for_process_exit(descriptor.provider_process.process_id);
        if let Err(error) = fs::remove_file(&descriptor.endpoint.address) {
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::NotFound,
                "remove stale endpoint"
            );
        }

        Self {
            _state: state,
            discovery_root,
            source_session_id: descriptor.session_id,
            source_workspace_id: descriptor.workspace_id,
        }
    }

    fn catalog(&self) -> LocalSessionCatalog {
        LocalSessionCatalog::new(&self.discovery_root)
    }

    fn rewrite_host_as_reused_current_pid(&self) {
        let manifest = find_manifest(
            &self.discovery_root,
            &self.source_workspace_id,
            &self.source_session_id,
        );
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        let host = &mut value["manifest"]["common"]["host_process"];
        host["process_id"] = Value::from(std::process::id());
        host["start_marker"] = Value::from(format!("{}-1", std::process::id()));
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn remove_source_manifest(&self) {
        fs::remove_file(find_manifest(
            &self.discovery_root,
            &self.source_workspace_id,
            &self.source_session_id,
        ))
        .unwrap();
    }

    fn hold_source_lifetime_lock(&self) -> LifetimeLock {
        let root = DiscoveryRoot::open(&self.discovery_root).unwrap();
        let discovered = root
            .find_manifest_by_session(&self.source_workspace_id, &self.source_session_id)
            .unwrap();
        root.open_session(discovered.key)
            .unwrap()
            .acquire_lifetime_lock()
            .unwrap()
    }

    fn age_source_state(&self, age: Duration) {
        let session = find_manifest(
            &self.discovery_root,
            &self.source_workspace_id,
            &self.source_session_id,
        )
        .parent()
        .unwrap()
        .to_path_buf();
        set_tree_modified(&session, SystemTime::now() - age);
    }
}

impl Drop for StaleFixture {
    fn drop(&mut self) {
        let catalog = self.catalog();
        for descriptor in catalog.list().unwrap_or_default() {
            if descriptor.session_class != SessionClass::Standalone
                || descriptor.lifecycle != SessionLifecycle::Ready
            {
                continue;
            }
            if let Ok(session) = catalog.open(&SessionSelector::new(
                descriptor.session_id,
                Some(descriptor.workspace_id),
            )) {
                let _ = session.terminate_standalone(&catalog, Duration::from_secs(3));
            }
        }
    }
}

fn idle_retirement_policy() -> SessionRetirementPolicy {
    SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: 1_000,
    }
}

#[test]
fn list_and_probe_report_a_ready_manifest_with_a_dead_transport_as_stale() {
    let fixture = StaleFixture::safe_shell("stale-inspection");
    let list = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args(["--json", "ls"])
        .output()
        .unwrap();
    assert!(
        list.status.success(),
        "list failed: {}",
        String::from_utf8_lossy(&list.stderr)
    );
    let sessions: Value = serde_json::from_slice(&list.stdout).unwrap();
    let session = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["session_id"] == fixture.source_session_id)
        .unwrap();
    assert_eq!(session["lifecycle"], "ready");
    assert_eq!(session["manifestLifecycle"], "ready");
    assert_eq!(session["effectiveLifecycle"], "stale");
    assert_eq!(session["health"], "stale_transport");

    let probe = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args([
            "--json",
            "session",
            "probe",
            &fixture.source_session_id,
            "--workspace",
            &fixture.source_workspace_id,
        ])
        .output()
        .unwrap();
    assert!(
        !probe.status.success(),
        "an unhealthy probe must be non-zero"
    );
    let receipt: Value = serde_json::from_slice(&probe.stdout).unwrap();
    assert_eq!(receipt["ok"], false);
    assert_eq!(receipt["status"], "stale_transport");
}

#[test]
fn doctor_and_gc_retire_a_generation_proven_dead_after_a_stale_handshake() {
    let fixture = StaleFixture::safe_shell("stale-doctor-gc");
    fixture.rewrite_host_as_reused_current_pid();
    fixture.age_source_state(Duration::from_secs(48 * 60 * 60));

    let doctor = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args(["--json", "doctor", "--probe-budget-ms", "1000"])
        .output()
        .unwrap();
    assert!(
        doctor.status.success(),
        "doctor failed: {}",
        String::from_utf8_lossy(&doctor.stderr)
    );
    let before: Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert_eq!(before["sessionCandidates"]["total"], 1);
    assert_eq!(before["sessionCandidates"]["healthy"], 0);
    assert_eq!(before["sessionCandidates"]["stale"], 1);
    assert_eq!(before["sessionCandidates"]["probeComplete"], true);
    assert_eq!(before["stateGc"]["discovery"]["eligibleSessions"], 1);
    assert_eq!(before["stateGc"]["discovery"]["plannedSessions"], 1);

    let gc = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args(["--json", "gc", "--apply", "--all-eligible"])
        .output()
        .unwrap();
    assert!(
        gc.status.success(),
        "gc failed: {}",
        String::from_utf8_lossy(&gc.stderr)
    );
    let applied: Value = serde_json::from_slice(&gc.stdout).unwrap();
    assert_eq!(applied["discovery"]["removedSessions"], 1);

    let after = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args(["--json", "doctor", "--probe-budget-ms", "1000"])
        .output()
        .unwrap();
    assert!(
        after.status.success(),
        "doctor after gc failed: {}",
        String::from_utf8_lossy(&after.stderr)
    );
    let after: Value = serde_json::from_slice(&after.stdout).unwrap();
    assert_eq!(after["sessionCandidates"]["total"], 0);
    assert_eq!(after["sessionCandidates"]["stale"], 0);
    assert_eq!(after["sessionCandidates"]["probeComplete"], true);
}

#[test]
fn exact_batch_reports_each_target_without_catalog_derived_false_deaths() {
    let fixture = StaleFixture::safe_shell("batch-inspection");
    let targets = serde_json::json!([
        {
            "sessionId": fixture.source_session_id,
            "workspaceId": fixture.source_workspace_id,
        },
        {
            "sessionId": "missing-session",
            "workspaceId": fixture.source_workspace_id,
        },
    ]);
    let output = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args([
            "--json",
            "session",
            "probe-batch",
            "--targets-json",
            &targets.to_string(),
            "--probe-budget-ms",
            "1000",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "batch probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["schemaVersion"], 1);
    assert_eq!(receipt["complete"], true);
    assert_eq!(receipt["results"][0]["liveness"], "dead");
    assert_eq!(receipt["results"][0]["status"], "stale_transport");
    assert_eq!(
        receipt["results"][0]["hostInstanceId"],
        fixture.catalog().list().unwrap()[0].host_instance_id
    );
    assert_eq!(receipt["results"][1]["liveness"], "dead");
    assert_eq!(receipt["results"][1]["status"], "not_found");

    let zero_budget = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args([
            "--json",
            "session",
            "probe-batch",
            "--targets-json",
            &serde_json::json!([{
                "sessionId": fixture.source_session_id,
                "workspaceId": fixture.source_workspace_id,
            }])
            .to_string(),
            "--probe-budget-ms",
            "0",
        ])
        .output()
        .unwrap();
    assert!(zero_budget.status.success());
    let receipt: Value = serde_json::from_slice(&zero_budget.stdout).unwrap();
    assert_eq!(receipt["complete"], false);
    assert_eq!(receipt["results"][0]["liveness"], "unknown");
    assert_eq!(receipt["results"][0]["status"], "unprobed");

    let duplicate_target = serde_json::json!({
        "sessionId": fixture.source_session_id,
        "workspaceId": fixture.source_workspace_id,
    });
    let duplicate = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args([
            "--json",
            "session",
            "probe-batch",
            "--targets-json",
            &serde_json::json!([duplicate_target.clone(), duplicate_target]).to_string(),
        ])
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(duplicate.stdout.is_empty());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("specified more than once"));
}

#[test]
fn attach_auto_restores_a_reboot_stale_safe_shell_and_retires_the_source() {
    let fixture = StaleFixture::safe_shell("dev");
    fixture.rewrite_host_as_reused_current_pid();

    let output = run_attach(&fixture.discovery_root, "dev");
    assert!(
        output.status.success(),
        "attach failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("No such file or directory"), "{stderr}");

    let named = fixture
        .catalog()
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.session_name.as_deref() == Some("dev"))
        .collect::<Vec<_>>();
    assert_eq!(named.len(), 1, "source and replacement must not coexist");
    assert_ne!(named[0].session_id, fixture.source_session_id);
    assert_eq!(named[0].lifecycle, SessionLifecycle::Ready);
    let recovery_record = fs::read_dir(fixture.discovery_root.join(".recovery"))
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("operation_")
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
        })
        .map(|entry| serde_json::from_slice::<Value>(&fs::read(entry.path()).unwrap()).unwrap())
        .expect("recovery journal did not retain its completed operation");
    assert_eq!(recovery_record["state"], "completed");
    let canonical_request: Value = serde_json::from_str(
        recovery_record["operation_checkpoint"]["canonicalPayload"]
            .as_str()
            .expect("prepared create request is missing"),
    )
    .unwrap();
    assert_eq!(
        canonical_request["recoveryIdentity"]["targetSessionId"],
        named[0].session_id
    );
    assert!(
        recovery_record["operation_checkpoint"]["replacementReceipt"]
            .as_str()
            .is_some(),
        "completed recovery must retain its exact replacement receipt"
    );
    assert_eq!(
        unsafe { libc::kill(std::process::id().try_into().unwrap(), 0) },
        0,
        "PID reuse simulation must never signal the unrelated process"
    );
}

#[test]
fn attach_recovery_preserves_retirement_policy_in_prepared_request_and_replacement() {
    launch_inputs::assert_recovery_preserves_launch_inputs();
}

#[test]
fn attach_never_auto_replays_an_explicit_command_recipe() {
    let state = tempfile::tempdir().unwrap();
    let marker = state.path().join("explicit-command-runs");
    let fixture = StaleFixture::explicit_command("manual-dev", &marker);
    let before = fs::read(&marker).unwrap();

    let output = run_attach(&fixture.discovery_root, "manual-dev");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("automatic replay was refused"), "{stderr}");
    assert!(stderr.contains("hmux restore manual-dev --run --foreground"));
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fs::read(&marker).unwrap(), before);
}

#[test]
fn concurrent_attach_attempts_publish_only_one_replacement() {
    let fixture = StaleFixture::safe_shell("concurrent-dev");
    let first = spawn_attach(&fixture.discovery_root, "concurrent-dev");
    let second = spawn_attach(&fixture.discovery_root, "concurrent-dev");
    let first = wait_for_output(first, ATTACH_TIMEOUT);
    let second = wait_for_output(second, ATTACH_TIMEOUT);

    for output in [&first, &second] {
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!stderr.contains("No such file or directory"), "{stderr}");
    }
    assert!(
        first.status.success() || second.status.success(),
        "both attach attempts failed: first={}, second={}",
        String::from_utf8_lossy(&first.stderr),
        String::from_utf8_lossy(&second.stderr)
    );
    let named = fixture
        .catalog()
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.session_name.as_deref() == Some("concurrent-dev"))
        .collect::<Vec<_>>();
    assert_eq!(named.len(), 1, "concurrent recovery spawned duplicates");
    assert_ne!(named[0].session_id, fixture.source_session_id);
}

#[test]
fn attach_retries_from_the_durable_recipe_after_the_source_was_retired() {
    let fixture = StaleFixture::safe_shell("retired-dev");
    fixture.remove_source_manifest();

    let output = run_attach(&fixture.discovery_root, "retired-dev");
    assert!(
        output.status.success(),
        "attach failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let named = fixture
        .catalog()
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.session_name.as_deref() == Some("retired-dev"))
        .collect::<Vec<_>>();
    assert_eq!(named.len(), 1);
    assert_ne!(named[0].session_id, fixture.source_session_id);
}

#[test]
fn concurrent_attach_after_source_retirement_publishes_only_one_replacement() {
    let fixture = StaleFixture::safe_shell("retired-concurrent-dev");
    fixture.remove_source_manifest();

    let first = spawn_attach(&fixture.discovery_root, "retired-concurrent-dev");
    let second = spawn_attach(&fixture.discovery_root, "retired-concurrent-dev");
    let first = wait_for_output(first, ATTACH_TIMEOUT);
    let second = wait_for_output(second, ATTACH_TIMEOUT);

    for output in [&first, &second] {
        assert!(
            output.status.success(),
            "attach failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let named = fixture
        .catalog()
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.session_name.as_deref() == Some("retired-concurrent-dev"))
        .collect::<Vec<_>>();
    assert_eq!(named.len(), 1, "missing-source recovery spawned duplicates");
    assert_ne!(named[0].session_id, fixture.source_session_id);
}

#[test]
fn completed_replay_uses_a_live_target_before_requiring_its_saved_build() {
    let fixture = StaleFixture::safe_shell("completed-build-missing");
    let source_manifest = find_manifest(
        &fixture.discovery_root,
        &fixture.source_workspace_id,
        &fixture.source_session_id,
    );
    let source_directory = source_manifest.parent().unwrap().to_path_buf();
    let source_backup = fixture._state.path().join("source-session-backup");
    copy_directory(&source_directory, &source_backup);
    let first = run_attach(&fixture.discovery_root, "completed-build-missing");
    assert!(
        first.status.success(),
        "initial recovery failed: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    let target = fixture
        .catalog()
        .list()
        .unwrap()
        .into_iter()
        .find(|session| {
            session.session_name.as_deref() == Some("completed-build-missing")
                && session.session_id != fixture.source_session_id
        })
        .expect("completed recovery target is missing");
    copy_directory(&source_backup, &source_directory);
    let paused_target = pause_process_group(target.host_process.process_id);
    let transient = run_attach(&fixture.discovery_root, &fixture.source_session_id);
    assert!(!transient.status.success());
    assert!(
        String::from_utf8_lossy(&transient.stderr).contains("temporarily unavailable"),
        "{}",
        String::from_utf8_lossy(&transient.stderr)
    );
    let record_path = recovery_record_path(&fixture.discovery_root);
    let transient_record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(transient_record["outcome"], "restored");
    let retained_target = fixture
        .catalog()
        .find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .unwrap();
    assert!(
        retained_target.same_generation(&target),
        "a transient completed-target failure must retain its generation"
    );
    drop(paused_target);
    let probe_deadline = Instant::now() + Duration::from_secs(3);
    while probe_local_session_exact(&fixture.catalog(), &retained_target)
        != SessionProbeStatus::Healthy
    {
        assert!(
            Instant::now() < probe_deadline,
            "resumed completed target did not become healthy"
        );
        thread::sleep(Duration::from_millis(20));
    }

    let unavailable_runtime = fixture._state.path().join("unavailable-hmux-runtime");
    fs::write(
        &unavailable_runtime,
        format!(
            "#!/bin/sh\ncase \"$*\" in\n  *hmux-build-info*) printf '%s\\n' '{{\"buildId\":\"different-build\"}}' ;;\n  *) exec '{}' \"$@\" ;;\nesac\n",
            runtime_executable().display()
        ),
    )
    .unwrap();
    fs::set_permissions(&unavailable_runtime, fs::Permissions::from_mode(0o700)).unwrap();

    let healthy_replay = run_attach_with_runtime(
        &fixture.discovery_root,
        &fixture.source_session_id,
        &unavailable_runtime,
    );
    assert!(
        healthy_replay.status.success(),
        "a healthy exact target must replay without its saved build: {}",
        String::from_utf8_lossy(&healthy_replay.stderr)
    );

    copy_directory(&source_backup, &source_directory);
    kill_process(target.host_process.process_id);
    kill_process(target.provider_process.process_id);
    wait_for_process_exit(target.host_process.process_id);
    wait_for_process_exit(target.provider_process.process_id);
    let _ = fs::remove_file(&target.endpoint.address);
    fs::remove_file(find_manifest(
        &fixture.discovery_root,
        &target.workspace_id,
        &target.session_id,
    ))
    .unwrap();

    let failed = run_attach_with_runtime(
        &fixture.discovery_root,
        &fixture.source_session_id,
        &unavailable_runtime,
    );
    assert!(!failed.status.success());
    let failed_stderr = String::from_utf8_lossy(&failed.stderr);
    assert!(
        failed_stderr.contains("not currently installed"),
        "{failed_stderr}"
    );
    let record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(record["outcome"], "restored");

    let replayed = run_attach(&fixture.discovery_root, &fixture.source_session_id);
    assert!(
        replayed.status.success(),
        "installing the saved build must make replay recoverable: {}",
        String::from_utf8_lossy(&replayed.stderr)
    );
    let replayed_record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(replayed_record["outcome"], "restored");
    assert!(
        fixture
            .catalog()
            .find(&SessionSelector::new(
                &target.session_id,
                Some(target.workspace_id),
            ))
            .is_ok(),
        "retry with the saved build must recreate the exact target identity"
    );
}

#[test]
fn an_unreachable_endpoint_with_an_owned_lifetime_lock_never_spawns_a_replacement() {
    let fixture = StaleFixture::safe_shell("lock-owned-dev");
    let _simulated_live_host = fixture.hold_source_lifetime_lock();

    let output = run_attach(&fixture.discovery_root, "lock-owned-dev");
    assert!(!output.status.success());
    let named = fixture
        .catalog()
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.session_name.as_deref() == Some("lock-owned-dev"))
        .collect::<Vec<_>>();
    assert_eq!(named.len(), 1, "lifetime-lock refusal must not spawn");
    assert_eq!(named[0].session_id, fixture.source_session_id);
}

fn run_attach(discovery_root: &Path, name: &str) -> Output {
    run_attach_with_runtime(discovery_root, name, &runtime_executable())
}

fn run_attach_with_runtime(discovery_root: &Path, name: &str, runtime: &Path) -> Output {
    wait_for_output(
        spawn_attach_with_runtime(discovery_root, name, runtime),
        ATTACH_TIMEOUT,
    )
}

fn spawn_attach(discovery_root: &Path, name: &str) -> Child {
    spawn_attach_with_runtime(discovery_root, name, &runtime_executable())
}

fn spawn_attach_with_runtime(discovery_root: &Path, name: &str, runtime: &Path) -> Child {
    let mut child = Command::new(hmux_executable())
        .arg("--discovery-root")
        .arg(discovery_root)
        .args(["attach", "--target", name])
        .env("HMUX_RUNTIME", runtime)
        .env_remove("HMUX")
        .env_remove("HMUX_SESSION_ID")
        .env_remove("HMUX_WORKSPACE_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&[0x1c, b'd']);
    }
    child
}

fn recovery_record_path(discovery_root: &Path) -> PathBuf {
    fs::read_dir(discovery_root.join(".recovery"))
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("operation_")
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
        })
        .map(|entry| entry.path())
        .expect("recovery record is missing")
}

fn copy_directory(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap().filter_map(Result::ok) {
        let target_path = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_directory(&entry.path(), &target_path);
        } else {
            fs::copy(entry.path(), target_path).unwrap();
        }
    }
}

fn wait_for_output(mut child: Child, timeout: Duration) -> Output {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "attach did not exit before timeout: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(25));
    }
}

struct PausedProcessGroup(libc::pid_t);

impl Drop for PausedProcessGroup {
    fn drop(&mut self) {
        // SAFETY: pause_process_group proves this is a fixture-owned process
        // group and not the test runner's group.
        unsafe {
            libc::kill(-self.0, libc::SIGCONT);
        }
    }
}

fn pause_process_group(process_id: u32) -> PausedProcessGroup {
    let process_id = libc::pid_t::try_from(process_id).unwrap();
    // SAFETY: getpgid reads metadata for the fixture process only.
    let group = unsafe { libc::getpgid(process_id) };
    assert_eq!(group, process_id, "fixture Host is not its group leader");
    // SAFETY: getpgrp reads the test runner's group without changing it.
    assert_ne!(group, unsafe { libc::getpgrp() });
    // SAFETY: the exact fixture-owned process group was validated above.
    assert_eq!(unsafe { libc::kill(-group, libc::SIGSTOP) }, 0);
    PausedProcessGroup(group)
}

fn kill_process(process_id: u32) {
    let result = unsafe { libc::kill(process_id.try_into().unwrap(), libc::SIGKILL) };
    if result != 0 {
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "kill fixture process"
        );
    }
}

fn wait_for_process_exit(process_id: u32) {
    let deadline = Instant::now() + PROCESS_EXIT_TIMEOUT;
    while Instant::now() < deadline {
        if unsafe { libc::kill(process_id.try_into().unwrap(), 0) } != 0 {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if path.try_exists().unwrap_or(false) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("fixture command did not create {}", path.display());
}

fn set_tree_modified(path: &Path, modified: SystemTime) {
    if path.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            set_tree_modified(&entry.unwrap().path(), modified);
        }
    }
    fs::File::open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
}

fn find_manifest(discovery_root: &Path, workspace_id: &str, session_id: &str) -> PathBuf {
    for workspace in fs::read_dir(discovery_root).unwrap().filter_map(Result::ok) {
        if !workspace.file_type().unwrap().is_dir() {
            continue;
        }
        for session in fs::read_dir(workspace.path())
            .unwrap()
            .filter_map(Result::ok)
        {
            let manifest = session.path().join("manifest.json");
            let Ok(value) = fs::read(&manifest)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .ok_or(())
            else {
                continue;
            };
            if value["manifest"]["common"]["lifetime"]["workspace_id"] == workspace_id
                && value["manifest"]["common"]["lifetime"]["session_id"] == session_id
            {
                return manifest;
            }
        }
    }
    panic!("manifest for {workspace_id}/{session_id} was not found");
}
