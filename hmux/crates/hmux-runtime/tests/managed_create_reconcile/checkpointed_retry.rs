use super::*;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Child;

pub(super) struct CheckpointedRetryFixture {
    _state: tempfile::TempDir,
    pub(super) discovery_root: PathBuf,
    pub(super) provider_pids: PathBuf,
    pub(super) cwd: PathBuf,
    pub(super) request: ManagedCreateRequest,
    pub(super) generation: ManagedStartingGeneration,
    broker: Child,
}

impl CheckpointedRetryFixture {
    pub(super) fn new(suffix: &str) -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let provider_pids = state.path().join("retry-provider-pids");
        let cut_marker = state.path().join("provider-spawned-cut");
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let request = ManagedCreateRequest::new(
            format!("{suffix}-create"),
            format!("{suffix}-session"),
            format!("{suffix}-workspace"),
            "fixture",
            PermissionMode::Default,
            &cwd,
            vec![
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                "--ignored".into(),
                "--exact".into(),
                "checkpointed_retry::provider".into(),
                "--nocapture".into(),
            ],
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                state.path().to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
        let mut broker = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .arg("--no-autostart")
            .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
            .current_dir(&cwd)
            .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
            .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE", "provider_spawned")
            .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER", &cut_marker)
            .stdin(Stdio::piped())
            .stdout(fs::File::create(state.path().join("broker-response")).unwrap())
            .spawn()
            .unwrap();
        write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
        drop(broker.stdin.take());

        let deadline = Instant::now() + Duration::from_secs(5);
        while !cut_marker.exists() || !provider_started(&provider_pids) {
            assert!(
                Instant::now() < deadline,
                "the checkpointed provider did not cross its fixture boundary: {}",
                startup_observation(state.path(), &request, &mut broker),
            );
            assert!(
                broker.try_wait().unwrap().is_none(),
                "managed create broker exited before the checkpointed cut: {}",
                startup_observation(state.path(), &request, &mut broker),
            );
            thread::sleep(Duration::from_millis(10));
        }
        let generation = managed_create_ledger::starting_generation(
            &discovery_root,
            request.workspace_id(),
            request.session_id(),
        )
        .unwrap()
        .expect("the provider-spawned cut must follow the exact Starting checkpoint");
        terminate_exact_process(generation.host_process(), "checkpointed Host");
        assert_eq!(
            probe_local_process_generation(generation.provider_process()).unwrap(),
            LocalProcessGenerationStatus::Live,
            "the provider fixture must survive Host loss to exercise exact retirement"
        );
        Self {
            _state: state,
            discovery_root,
            provider_pids,
            cwd,
            request,
            generation,
            broker,
        }
    }

    pub(super) fn stop_broker(&mut self) {
        if self.broker.try_wait().unwrap().is_none() {
            self.broker.kill().unwrap();
        }
        self.broker.wait().unwrap();
    }
}

fn provider_started(pid_file: &Path) -> bool {
    fs::read_to_string(pid_file).is_ok_and(|pids| pids.ends_with('\n'))
}

#[test]
#[ignore = "launched as the native provider by checkpointed-retry tests"]
fn provider() {
    let state = std::env::var_os(FIXTURE_STATE_DIR_ENV)
        .expect("checkpointed provider requires its isolated state directory");
    // SAFETY: this exact fixture process must survive its Host's PTY closure.
    // The parent tests retain its process generation and retire it explicitly.
    assert_ne!(
        unsafe { libc::signal(libc::SIGHUP, libc::SIG_IGN) },
        libc::SIG_ERR
    );
    let mut pid_file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(Path::new(&state).join("retry-provider-pids"))
        .unwrap();
    let mut previous = String::new();
    pid_file.read_to_string(&mut previous).unwrap();
    pid_file
        .write_all(format!("{}\n", std::process::id()).as_bytes())
        .unwrap();
    drop(pid_file);
    thread::sleep(Duration::from_secs(if previous.is_empty() {
        30
    } else {
        2
    }));
}

#[test]
fn provider_readiness_waits_for_the_complete_pid_record() {
    let state = tempfile::tempdir().unwrap();
    let pid_file = state.path().join("retry-provider-pids");
    assert!(!provider_started(&pid_file));
    fs::write(&pid_file, b"").unwrap();
    assert!(!provider_started(&pid_file));
    fs::write(&pid_file, b"123").unwrap();
    assert!(!provider_started(&pid_file));
    fs::write(&pid_file, b"123\n").unwrap();
    assert!(provider_started(&pid_file));
}

fn startup_observation(state: &Path, request: &ManagedCreateRequest, broker: &mut Child) -> String {
    // Read only this fixture's existing artifacts on failure. A regular-file
    // snapshot cannot wait on the still-running broker's response pipe.
    let response = fs::read(state.join("broker-response"))
        .map(|bytes| read_json_frame::<ManagedCreateBrokerResponse>(&mut bytes.as_slice()));
    // The ledger reader takes an admission lock. Failure diagnostics must not
    // join a potentially stalled create; inspect the published Host instead.
    let generation = DiscoveryRoot::open(state.join("discovery"))
        .and_then(|root| {
            root.find_current_manifest_by_session(request.workspace_id(), request.session_id())
        })
        .map(|session| session.manifest.generation());
    format!(
        "cut_marker={:?}; provider_pids={:?}; broker_status={:?}; broker_response={response:?}; published_host_generation={generation:?}",
        fs::read_to_string(state.join("provider-spawned-cut")),
        fs::read_to_string(state.join("retry-provider-pids")),
        broker.try_wait(),
    )
}
