#![cfg(unix)]

use hebbian_process_sampler::process_start_time;
use hmux_client::{
    LocalProcessGenerationStatus, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopRequest, PermissionMode, ProcessDescriptor,
    probe_local_process_generation,
};
use hmux_runtime_contract::ProviderStateEnvironment;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use uuid::Uuid;

const FIXTURE_ROLE_ENV: &str = "ROOT_LIFETIME_FIXTURE_ROLE";
const FIXTURE_STATE_DIR_ENV: &str = "ROOT_LIFETIME_STATE_DIR";

#[test]
fn deleting_one_discovery_root_reaps_only_its_owned_process_session() {
    let state = tempfile::tempdir().unwrap();
    let mut retired = ManagedHostFixture::start(state.path().join("retired"));
    let mut sibling = ManagedHostFixture::start(state.path().join("sibling"));

    let removed_discovery_root = retired
        .discovery_root
        .with_file_name("discovery-removed-by-fixture");
    fs::rename(&retired.discovery_root, &removed_discovery_root).unwrap();

    assert!(
        wait_for_process_shutdown(&retired.host_process, Duration::from_secs(12)),
        "Host survived deletion of its discovery-root generation"
    );
    assert!(
        wait_for_process_shutdown(&retired.provider_process, Duration::from_secs(3)),
        "provider survived deletion of its discovery-root generation"
    );
    assert!(
        wait_for_process_generation_shutdown(&retired.child_process, Duration::from_secs(3)),
        "provider descendant survived deletion of its discovery-root generation"
    );
    assert!(
        retired.endpoint.try_exists().is_ok_and(|exists| !exists),
        "retired Host endpoint was not removed"
    );
    retired.stopped = true;
    fs::remove_dir_all(removed_discovery_root).unwrap();

    assert_eq!(
        probe_local_process_generation(&sibling.host_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "Host in another discovery root was changed"
    );
    assert_eq!(
        probe_local_process_generation(&sibling.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "provider in another discovery root was changed"
    );
    assert!(
        process_generation_is_running(&sibling.child_process),
        "provider descendant in another discovery root was changed"
    );

    sibling.stop();
}

#[test]
#[ignore = "launched as the deterministic provider process by the lifetime test"]
fn discovery_root_lifetime_fixture_provider() {
    let Some(state_dir) = std::env::var_os(FIXTURE_STATE_DIR_ENV) else {
        return;
    };
    if std::env::var(FIXTURE_ROLE_ENV).as_deref() != Ok("child") {
        let child_pid_file = PathBuf::from(state_dir).join("child.pid");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "discovery_root_lifetime_fixture_provider",
                "--nocapture",
            ])
            .env(FIXTURE_ROLE_ENV, "child")
            .spawn()
            .unwrap();
        fs::write(child_pid_file, child.id().to_string()).unwrap();
        std::mem::forget(child);
    }
    loop {
        std::thread::park();
    }
}

struct ManagedHostFixture {
    discovery_root: PathBuf,
    cwd: PathBuf,
    stop_request: ManagedStopRequest,
    host_process: ProcessDescriptor,
    provider_process: ProcessDescriptor,
    endpoint: PathBuf,
    child_process: ChildProcessGeneration,
    stopped: bool,
}

impl ManagedHostFixture {
    fn start(root: PathBuf) -> Self {
        fs::create_dir_all(&root).unwrap();
        let discovery_root = root.join("discovery");
        let child_pid_file = root.join("child.pid");
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let provider = std::env::current_exe().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let session_id = format!("root-lifetime-{}", &suffix[..12]);
        let workspace_id = format!("root-lifetime-workspace-{suffix}");
        let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    format!("root-lifetime-create-{}", &suffix[..12]),
                    &session_id,
                    &workspace_id,
                    "fixture-provider",
                    PermissionMode::Default,
                    &cwd,
                    vec![
                        provider.to_string_lossy().into_owned(),
                        "--ignored".into(),
                        "--exact".into(),
                        "discovery_root_lifetime_fixture_provider".into(),
                        "--nocapture".into(),
                    ],
                    24,
                    80,
                )
                .unwrap()
                .with_provider_state_environment(
                    ProviderStateEnvironment::new(BTreeMap::from([(
                        FIXTURE_STATE_DIR_ENV.to_string(),
                        root.to_string_lossy().into_owned(),
                    )]))
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        let descriptor = created.session().descriptor();
        let stop_request = ManagedStopRequest::new(
            format!("root-lifetime-stop-{session_id}"),
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
        .unwrap();
        let child_process = wait_for_child_process(&child_pid_file, Duration::from_secs(5));
        Self {
            discovery_root,
            cwd,
            stop_request,
            host_process: descriptor.host_process.clone(),
            provider_process: descriptor.provider_process.clone(),
            endpoint: PathBuf::from(&descriptor.endpoint.address),
            child_process,
            stopped: false,
        }
    }

    fn stop(&mut self) {
        ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(self.stop_request.clone())
            .unwrap();
        assert!(
            wait_for_process_shutdown(&self.host_process, Duration::from_secs(7)),
            "fixture Host survived managed stop"
        );
        assert!(
            wait_for_process_shutdown(&self.provider_process, Duration::from_secs(3)),
            "fixture provider survived managed stop"
        );
        assert!(
            wait_for_process_generation_shutdown(&self.child_process, Duration::from_secs(3)),
            "fixture provider descendant survived managed stop"
        );
        self.stopped = true;
    }
}

impl Drop for ManagedHostFixture {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        if self.discovery_root.is_dir() {
            let _ = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &self.cwd)
                .with_discovery_root(&self.discovery_root)
                .stop(self.stop_request.clone());
        }
        terminate_process_generation(&self.child_process);
        terminate_exact_generation(&self.provider_process);
        terminate_exact_generation(&self.host_process);
        let _ = fs::remove_file(&self.endpoint);
    }
}

#[derive(Clone, Copy)]
struct ChildProcessGeneration {
    pid: u32,
    start_time: u64,
}

fn wait_for_child_process(path: &Path, timeout: Duration) -> ChildProcessGeneration {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(value) = fs::read_to_string(path) {
            if let Ok(pid) = value.parse() {
                if let Some(start_time) = process_start_time(pid) {
                    return ChildProcessGeneration { pid, start_time };
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "fixture child did not become ready"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_process_shutdown(process: &ProcessDescriptor, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if matches!(
            probe_local_process_generation(process),
            Ok(LocalProcessGenerationStatus::Absent)
        ) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_process_generation_shutdown(
    process: &ChildProcessGeneration,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_generation_is_running(process) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_generation_is_running(process: &ChildProcessGeneration) -> bool {
    process_start_time(process.pid) == Some(process.start_time)
}

fn terminate_exact_generation(process: &ProcessDescriptor) {
    if matches!(
        probe_local_process_generation(process),
        Ok(LocalProcessGenerationStatus::Live)
    ) {
        terminate_pid(process.process_id);
    }
}

fn terminate_process_generation(process: &ChildProcessGeneration) {
    if process_generation_is_running(process) {
        terminate_pid(process.pid);
        let _ = wait_for_process_generation_shutdown(process, Duration::from_secs(2));
    }
}

fn terminate_pid(pid: u32) {
    if pid > 1 {
        // SAFETY: callers verify the recorded process generation immediately
        // before reaching this fixture-only fallback.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}
