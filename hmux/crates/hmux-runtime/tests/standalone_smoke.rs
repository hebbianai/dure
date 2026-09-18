#![cfg(unix)]

use hebbian_process_sampler::SharedProcessSampler;
#[cfg(feature = "terminal-state-stream")]
use hmux_client::ConnectionRecord;
use hmux_client::{
    AgentStateReport, AgentStateReportObservationFence, AgentStateReportOutcome,
    CatalogCensusWorker, ConnectionOptions, ControllerEvent, ControllerReceiptState, HostErrorCode,
    LocalAttachRole, LocalConnection, LocalProcessGenerationStatus, LocalSession,
    LocalSessionCatalog, LocalSessionController, LocalSessionObserver, ObserverAttachOptions,
    ObserverEvent, PresentationCheckpointPredecessor, ProcessDescriptor,
    SESSION_RETIREMENT_ADMIN_CAPABILITY, SESSION_RETIREMENT_CAPABILITY, SessionDescriptor,
    SessionLifecycle, SessionProbeStatus, SessionRetirementPolicy, SessionRetirementReceipt,
    SessionRetirementReceiptReason, SessionRetirementReceiptState, SessionSelector,
    StandaloneCreateRequest, StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity,
    StandaloneResurrectionRecipe, StandaloneResurrectionReplayPolicy, StandaloneSessionCreator,
    TerminalEnvironment, WorkingDirectorySource, list_local_sessions_isolated,
    probe_local_process_generation, probe_local_session, probe_local_session_exact,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_client::{
    ClientError, RetryDirective, TerminalIntentReceipt, TerminalSurfaceAccess,
    TerminalSurfaceAttachment, TerminalSurfaceEvent, TerminalSurfaceFrame,
};
use hmux_host::local_discovery::{
    DiscoveryKey, DiscoveryManifest, DiscoveryRoot, PresentationCheckpoint,
    PresentationCheckpointSource,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::local_protocol::ResizeReceiptState;
use hmux_host::local_protocol::{FrameBody, InputReceiptState, ScreenSnapshot};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::terminal_replay::TerminalCheckpointEncoding;
use hmux_runtime_contract::{STANDALONE_CREATE_BROKER_SUBCOMMAND, write_json_frame};
use hmux_runtime_contract::{StandaloneCreateBrokerResponse, read_json_frame};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
#[cfg(feature = "terminal-state-stream")]
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};
#[cfg(feature = "terminal-state-stream")]
use terminal_state_protocol::{
    FocusInputIntent, InputIntent, PROTOCOL_MINOR, ResizeFailureReason, ResizeInputIntent,
    ResizeReceipt, ResizeRefusalReason, TerminalStateRecord, TextInputIntent, encode_record,
    encode_record_for_minor, input_intent, input_receipt, resize_receipt, terminal_state_record,
};

const SEMANTIC_AGENT_SESSION_NAME: &str = "semantic-state-canary";
const TERMINAL_TEXT_AUTHORITY_SESSION_NAME: &str = "terminal-text-authority-canary";
const OSC7_CWD_AUTHORITY_SESSION_NAME: &str = "osc7-cwd-authority-canary";
#[cfg(feature = "terminal-state-stream")]
const COALESCED_INPUT_FIRST: &str = "첫 번째 입력";
#[cfg(feature = "terminal-state-stream")]
const COALESCED_INPUT_SECOND: &str = "두 번째 입력";
const IDLE_RETIREMENT_GRACE_MS: u64 = 1_000;
static RESIZE_SIGNAL_RECEIVED: AtomicBool = AtomicBool::new(false);

extern "C" fn record_resize_signal(_: libc::c_int) {
    RESIZE_SIGNAL_RECEIVED.store(true, Ordering::Release);
}

fn process_generation_is_live(
    process: &ProcessDescriptor,
) -> Result<bool, hmux_client::ClientError> {
    Ok(matches!(
        probe_local_process_generation(process)?,
        LocalProcessGenerationStatus::Live
    ))
}

fn idle_retirement_policy() -> SessionRetirementPolicy {
    SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: IDLE_RETIREMENT_GRACE_MS,
    }
}

fn retry_transient_retirement_observation(
    mut request: impl FnMut() -> Result<SessionRetirementReceipt, hmux_client::ClientError>,
) -> SessionRetirementReceipt {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let receipt = request().unwrap();
        if receipt.reason != Some(SessionRetirementReceiptReason::ProcessObservationUnavailable) {
            return receipt;
        }
        assert!(
            Instant::now() < deadline,
            "retirement process observation stayed unavailable through the retry budget"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

struct IdleRetirementFixture {
    session: LocalSession,
    catalog: LocalSessionCatalog,
    descriptor: SessionDescriptor,
    tracked_process_groups: Vec<(u32, libc::pid_t)>,
    cleaned: bool,
}

impl IdleRetirementFixture {
    fn create(state: &tempfile::TempDir, name: &str, command: Vec<String>) -> Self {
        Self::create_with_runtime(
            state,
            name,
            command,
            std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime")),
        )
    }

    fn create_with_runtime(
        state: &tempfile::TempDir,
        name: &str,
        command: Vec<String>,
        runtime: &std::path::Path,
    ) -> Self {
        Self::create_with_runtime_and_policy(
            state,
            name,
            command,
            runtime,
            Some(idle_retirement_policy()),
        )
    }

    fn create_with_runtime_and_policy(
        state: &tempfile::TempDir,
        name: &str,
        command: Vec<String>,
        runtime: &std::path::Path,
        retirement_policy: Option<SessionRetirementPolicy>,
    ) -> Self {
        let discovery_root = state.path().join("discovery");
        Self::create_at_discovery_root(
            state,
            discovery_root,
            name,
            command,
            runtime,
            retirement_policy,
        )
    }

    fn create_at_discovery_root(
        state: &tempfile::TempDir,
        discovery_root: std::path::PathBuf,
        name: &str,
        command: Vec<String>,
        runtime: &std::path::Path,
        retirement_policy: Option<SessionRetirementPolicy>,
    ) -> Self {
        let creator = StandaloneSessionCreator::new(runtime).with_discovery_root(&discovery_root);
        let request = StandaloneCreateRequest::new(
            state.path().canonicalize().unwrap(),
            Some(name.into()),
            command,
            24,
            80,
        )
        .unwrap()
        .with_retirement_policy_option(retirement_policy)
        .unwrap();
        let created = creator.create(request).unwrap();
        let session = created.session().clone();
        let descriptor = session.descriptor().clone();
        assert_eq!(descriptor.retirement_policy, retirement_policy);
        Self {
            session,
            catalog: LocalSessionCatalog::new(discovery_root),
            descriptor,
            tracked_process_groups: Vec::new(),
            cleaned: false,
        }
    }

    fn create_idle_shell(state: &tempfile::TempDir, name: &str) -> Self {
        Self::create(state, name, vec!["/bin/sh".into()])
    }

    fn connect_for_retirement(&self) -> LocalConnection {
        self.session
            .connect_with_options(
                ConnectionOptions::new(LocalAttachRole::Observer, None)
                    .with_optional_capabilities(&[SESSION_RETIREMENT_CAPABILITY]),
            )
            .unwrap()
    }

    fn track_process_group(&mut self, process_id: u32) {
        self.tracked_process_groups
            .push((process_id, process_group(process_id)));
    }

    fn assert_preserved(&self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if probe_local_session_exact(&self.catalog, &self.descriptor)
                == SessionProbeStatus::Healthy
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "retirement smoke session did not remain healthy"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let current = self
            .catalog
            .find(&SessionSelector::new(
                &self.descriptor.session_id,
                Some(self.descriptor.workspace_id.clone()),
            ))
            .unwrap();
        assert!(current.same_generation(&self.descriptor));
        assert_eq!(current.retirement_policy, self.descriptor.retirement_policy);
        assert!(process_generation_is_live(&self.descriptor.host_process).unwrap());
        assert!(process_generation_is_live(&self.descriptor.provider_process).unwrap());
    }

    fn wait_for_retirement(&mut self) {
        self.wait_for_processes_and_manifest_to_disappear();
        self.cleaned = true;
    }

    fn terminate_and_verify(&mut self) {
        self.session
            .terminate_standalone(&self.catalog, Duration::from_secs(3))
            .unwrap();
        self.wait_for_processes_and_manifest_to_disappear();
        self.cleaned = true;
    }

    fn wait_for_processes_and_manifest_to_disappear(&self) {
        assert!(
            wait_for_process_generation_exit_with_timeout(
                &self.descriptor.provider_process,
                Duration::from_secs(7)
            ),
            "retirement smoke provider generation remained live"
        );
        assert!(
            wait_for_process_generation_exit_with_timeout(
                &self.descriptor.host_process,
                Duration::from_secs(8)
            ),
            "retirement smoke Host generation remained live"
        );
        for (process_id, _) in &self.tracked_process_groups {
            assert!(
                wait_for_process_exit(*process_id, Duration::from_secs(2)),
                "retirement smoke descendant {process_id} remained live"
            );
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while self
            .catalog
            .find(&SessionSelector::new(
                &self.descriptor.session_id,
                Some(self.descriptor.workspace_id.clone()),
            ))
            .is_ok()
        {
            assert!(
                Instant::now() < deadline,
                "retirement smoke manifest remained discoverable after Host exit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn read_only_legacy_discovery_reattaches_the_exact_live_host_generation() {
    let state = tempfile::tempdir().unwrap();
    let legacy_home = state.path().join("legacy-home");
    let legacy_root = legacy_home.join("state/hebbian-agent/hmux-hosts");
    let dure_home = state.path().join("dure-home");
    let canonical_root = dure_home.join("state/hmux-hosts");
    fs::create_dir_all(legacy_root.parent().unwrap()).unwrap();
    fs::create_dir_all(canonical_root.parent().unwrap()).unwrap();
    let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let mut fixture = IdleRetirementFixture::create_at_discovery_root(
        &state,
        legacy_root.clone(),
        "legacy-root-live-host",
        vec!["/bin/sleep".into(), "30".into()],
        runtime,
        None,
    );
    let discovered = DiscoveryRoot::open(&legacy_root)
        .unwrap()
        .find_manifest_by_session(
            &fixture.descriptor.workspace_id,
            &fixture.descriptor.session_id,
        )
        .unwrap();
    let manifest_path = discovered.discovery_path.join("manifest.json");
    let manifest_before = fs::read(&manifest_path).unwrap();
    let migration_catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        &canonical_root,
        vec![legacy_root.clone()],
    )
    .unwrap();

    let migrated = migration_catalog
        .find(&SessionSelector::new(
            fixture.descriptor.session_id.clone(),
            Some(fixture.descriptor.workspace_id.clone()),
        ))
        .unwrap();
    assert!(migrated.same_generation(&fixture.descriptor));
    assert_eq!(
        probe_local_session_exact(&migration_catalog, &migrated),
        SessionProbeStatus::Healthy
    );

    let worker = CatalogCensusWorker::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let census =
        list_local_sessions_isolated(&migration_catalog, &worker, Duration::from_secs(3)).unwrap();
    assert_eq!(census.len(), 1);
    assert!(census[0].same_generation(&fixture.descriptor));
    assert!(!canonical_root.exists());

    let duplicate_request = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("legacy-root-live-host".into()),
        vec!["/bin/sleep".into(), "30".into()],
        24,
        80,
    )
    .unwrap();
    let mut duplicate = Command::new(runtime)
        .arg("--no-autostart")
        .arg(STANDALONE_CREATE_BROKER_SUBCOMMAND)
        .env_remove(hmux_client::DISCOVERY_ROOT_ENV)
        .env("HOME", state.path())
        .env("DURE_HOME", &dure_home)
        .env("HEBBIAN_HOME", &legacy_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut duplicate_input = duplicate.stdin.take().unwrap();
    write_json_frame(&mut duplicate_input, &duplicate_request).unwrap();
    drop(duplicate_input);
    let mut duplicate_output = duplicate.stdout.take().unwrap();
    let duplicate_response =
        read_json_frame::<StandaloneCreateBrokerResponse>(&mut duplicate_output).unwrap();
    assert!(duplicate.wait().unwrap().success());
    assert!(matches!(
        duplicate_response,
        StandaloneCreateBrokerResponse::Refused(ref failure)
            if failure.code == "hmux_standalone_read_only_name_conflict"
    ));
    assert!(
        LocalSessionCatalog::new(&canonical_root)
            .list()
            .unwrap()
            .is_empty()
    );

    let migrated_session = migration_catalog
        .open(&SessionSelector::new(
            fixture.descriptor.session_id.clone(),
            Some(fixture.descriptor.workspace_id.clone()),
        ))
        .unwrap();
    assert!(matches!(
        migration_catalog.cleanup_stale_exact(&migrated_session),
        Err(hmux_client::ClientError::ReadOnlyDiscoveryRoot { .. })
    ));
    assert_eq!(fs::read(&manifest_path).unwrap(), manifest_before);

    fixture.terminate_and_verify();
}

impl Drop for IdleRetirementFixture {
    fn drop(&mut self) {
        if self.cleaned {
            return;
        }
        let _ = self
            .session
            .terminate_standalone(&self.catalog, Duration::from_secs(3));
        let _ = wait_for_process_generation_exit_with_timeout(
            &self.descriptor.host_process,
            Duration::from_secs(4),
        );
        let _ = wait_for_process_generation_exit_with_timeout(
            &self.descriptor.provider_process,
            Duration::from_secs(2),
        );
        best_effort_kill_exact_test_group(&self.descriptor.host_process);
        best_effort_kill_exact_test_group(&self.descriptor.provider_process);
        for (process_id, expected_group) in &self.tracked_process_groups {
            best_effort_kill_tracked_process_group(*process_id, *expected_group);
        }
    }
}

#[test]
fn standalone_create_recovers_collectable_discovery_capacity_before_recovery_locks() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let root = DiscoveryRoot::create(&discovery_root).unwrap();
    for index in 0..1_024 {
        let session_id = format!("standalone-capacity-debris-{index:04}");
        drop(
            root.session(
                DiscoveryKey::new("standalone-capacity-workspace", &session_id, "runner", 1)
                    .unwrap(),
            )
            .unwrap(),
        );
    }
    assert_eq!(root.registration_capacity().unwrap().remaining, 0);

    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("standalone-capacity-recovery".into()),
        vec!["/bin/sleep".into(), "30".into()],
        24,
        80,
    )
    .unwrap();
    let created = creator
        .create(request)
        .expect("collectable discovery state must not block a standalone provider");
    assert!(
        root.registration_capacity().unwrap().used <= 512,
        "automatic maintenance must keep the newly admitted session within the 50% ceiling"
    );

    created
        .session()
        .terminate_standalone(
            &LocalSessionCatalog::new(&discovery_root),
            Duration::from_secs(3),
        )
        .unwrap();
}

#[test]
fn natural_standalone_provider_exit_retains_exact_tombstone_for_reconnect() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("natural-provider-exit".into()),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'command-complete\\n'; sleep 0.2".into(),
        ],
        24,
        80,
    )
    .unwrap();
    let created = creator.create(request).unwrap();
    let descriptor = created.session().descriptor().clone();

    assert!(wait_for_process_generation_exit_with_timeout(
        &descriptor.provider_process,
        Duration::from_secs(4),
    ));
    assert!(wait_for_process_generation_exit_with_timeout(
        &descriptor.host_process,
        Duration::from_secs(5),
    ));

    let root = DiscoveryRoot::open(&discovery_root).unwrap();
    let found = root
        .find_manifest_by_session(&descriptor.workspace_id, &descriptor.session_id)
        .expect("natural provider exit must remain exactly inspectable");
    assert!(matches!(found.manifest, DiscoveryManifest::Exited(_)));
    assert!(found.discovery_path.join("presentation.json").is_file());
}

#[test]
fn repository_runtime_creates_accepts_external_input_and_replays_output() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        Some("runtime-smoke".into()),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'environment:HMUX=%s\\n' \"$HMUX\"; printf 'environment:session=%s\\n' \"$HMUX_SESSION_ID\"; printf 'environment:name=%s\\n' \"$HMUX_SESSION_NAME\"; printf 'environment:workspace=%s\\n' \"$HMUX_WORKSPACE_ID\"; printf 'environment:TERM=%s\\n' \"$TERM\"; printf 'environment:NO_COLOR=%s\\n' \"$NO_COLOR\"; printf 'environment:COLORTERM=%s\\n' \"${COLORTERM-unset}\"; IFS= read -r first; printf 'controller:%s\\n' \"$first\"; IFS= read -r second; printf 'external:%s\\n' \"$second\"; IFS= read -r third; printf 'controller-retained:%s\\n' \"$third\"; sleep 0.2".into(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_terminal_environment(
        TerminalEnvironment::new(BTreeMap::from([
            ("TERM".to_string(), Some("screen-256color".to_string())),
            ("NO_COLOR".to_string(), Some("session-explicit".to_string())),
            ("COLORTERM".to_string(), None),
        ]))
        .unwrap(),
    )
    .unwrap();
    let mut created = creator.create(request).unwrap();
    let session = created.session().clone();
    let expected_environment = [
        "environment:HMUX=1".to_string(),
        format!("environment:session={}", session.descriptor().session_id),
        format!(
            "environment:name={}",
            session.descriptor().session_name.as_deref().unwrap()
        ),
        format!(
            "environment:workspace={}",
            session.descriptor().workspace_id
        ),
        "environment:TERM=screen-256color".to_string(),
        "environment:NO_COLOR=session-explicit".to_string(),
        "environment:COLORTERM=unset".to_string(),
    ];
    let recipe_path = std::fs::read_dir(discovery_root.join(".resurrection"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let recipe: StandaloneResurrectionRecipe =
        serde_json::from_slice(&std::fs::read(recipe_path).unwrap()).unwrap();
    assert_eq!(recipe.session_name(), "runtime-smoke");
    assert_eq!(
        recipe.command().first().map(String::as_str),
        Some("/bin/sh")
    );
    assert_eq!(
        recipe.terminal_environment().values().get("NO_COLOR"),
        Some(&Some("session-explicit".to_string()))
    );

    let mut controller = created.connect_controller().unwrap();
    let request_id = controller
        .mutation_handle()
        .send_input(b"from-controller\n".to_vec())
        .unwrap();
    loop {
        match controller.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt))
                if receipt.request_id == request_id
                    && receipt.state == ControllerReceiptState::WrittenToPty =>
            {
                break;
            }
            Some(_) => {}
            None => panic!("controller disconnected before its input receipt"),
        }
    }
    let mut observer_one = session.connect(LocalAttachRole::Observer, None).unwrap();
    let mut observer_two = session.connect(LocalAttachRole::Observer, None).unwrap();
    observer_one
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    observer_two
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let shared_receipt = session.send_input(b"from-external\n".to_vec()).unwrap();
    assert_eq!(
        shared_receipt.state,
        InputReceiptState::WrittenToPty,
        "the focus-independent one-shot writer must reach the PTY"
    );
    let retained_request_id = controller
        .mutation_handle()
        .send_input(b"after-shared-writer\n".to_vec())
        .unwrap();
    loop {
        match controller.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt))
                if receipt.request_id == retained_request_id
                    && receipt.state == ControllerReceiptState::WrittenToPty =>
            {
                break;
            }
            Some(_) => {}
            None => panic!("UI controller was replaced by the one-shot shared writer"),
        }
    }
    let expected_observer_output: &[&[u8]] = &[
        b"external:from-external",
        b"controller-retained:after-shared-writer",
    ];
    assert_observer_receives(&mut observer_one, expected_observer_output);
    assert_observer_receives(&mut observer_two, expected_observer_output);
    controller.detach().unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let snapshot = session.read_screen(None).unwrap();
        let has_controller = snapshot
            .repaint_bytes
            .windows(b"controller:from-controller".len())
            .any(|window| window == b"controller:from-controller");
        let has_external = snapshot
            .repaint_bytes
            .windows(b"external:from-external".len())
            .any(|window| window == b"external:from-external");
        let has_retained_controller = snapshot
            .repaint_bytes
            .windows(b"controller-retained:after-shared-writer".len())
            .any(|window| window == b"controller-retained:after-shared-writer");
        let has_environment = expected_environment.iter().all(|expected| {
            snapshot
                .repaint_bytes
                .windows(expected.len())
                .any(|window| window == expected.as_bytes())
        });
        if has_controller && has_external && has_retained_controller && has_environment {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "standalone Host did not replay externally-triggered output"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn standalone_shared_resize_delivers_sigwinch_to_the_provider() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-resize-winch",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "standalone_resize_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"READY");

    let mut observer_one = LocalSessionObserver::connect(
        &fixture.catalog,
        &SessionSelector::new(
            fixture.descriptor.session_id.clone(),
            Some(fixture.descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let mut observer_two = LocalSessionObserver::connect(
        &fixture.catalog,
        &SessionSelector::new(
            fixture.descriptor.session_id.clone(),
            Some(fixture.descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();

    let receipt = fixture.session.send_resize(42, 100).unwrap();
    assert_eq!(receipt.rows, Some(42));
    assert_eq!(receipt.columns, Some(100));
    for (name, observer) in [("first", &mut observer_one), ("second", &mut observer_two)] {
        loop {
            match observer.read_event().unwrap() {
                Some(ObserverEvent::Output(delta))
                    if delta
                        .bytes
                        .windows(b"WINCH:42 100".len())
                        .any(|window| window == b"WINCH:42 100") =>
                {
                    assert_eq!(
                        (delta.rows, delta.columns),
                        (Some(42), Some(100)),
                        "{name} observer missed canonical resize geometry"
                    );
                    break;
                }
                Some(_) => {}
                None => panic!("{name} observer detached before resize redraw"),
            }
        }
    }
    let snapshot = wait_for_replay_snapshot(&fixture.session, b"WINCH:42 100");
    assert_eq!((snapshot.rows, snapshot.columns), (42, 100));

    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_shared_writer_accepts_semantic_input_without_a_controller_lease() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-structured-semantic-input",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "IFS= read -r line; printf 'STRUCTURED_INPUT:%s\\n' \"$line\"; sleep 10".into(),
        ],
    );
    let connection = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let initial = connection.initial_terminal_state().unwrap();
    let record = terminal_state_protocol::TerminalStateRecord {
        schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
        terminal_epoch: initial.terminal_epoch().to_string(),
        through_output_seq: initial.through_output_seq(),
        state_revision: initial.state_revision(),
        body: Some(
            terminal_state_protocol::terminal_state_record::Body::InputIntent(
                terminal_state_protocol::InputIntent {
                    intent: Some(terminal_state_protocol::input_intent::Intent::Text(
                        terminal_state_protocol::TextInputIntent {
                            utf8: b"semantic-input\n".to_vec(),
                        },
                    )),
                },
            ),
        ),
    };
    connection
        .terminal_input_writer_capability()
        .unwrap()
        .send_input(1, &record)
        .unwrap();

    wait_for_replay_snapshot(&fixture.session, b"STRUCTURED_INPUT:semantic-input");
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_key_and_paste_encoding_follow_the_host_terminal_modes() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-structured-input-encoding",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "standalone_structured_input_encoding_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"STRUCTURED_INPUT_ENCODER_READY");
    let connection = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let initial = connection.initial_terminal_state().unwrap();
    let base = terminal_state_protocol::TerminalStateRecord {
        schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
        terminal_epoch: initial.terminal_epoch().to_string(),
        through_output_seq: initial.through_output_seq(),
        state_revision: initial.state_revision(),
        body: None,
    };
    let key = terminal_state_protocol::TerminalStateRecord {
        body: Some(
            terminal_state_protocol::terminal_state_record::Body::InputIntent(
                terminal_state_protocol::InputIntent {
                    intent: Some(terminal_state_protocol::input_intent::Intent::Key(
                        terminal_state_protocol::KeyInputIntent {
                            key: "ArrowUp".into(),
                            code: "ArrowUp".into(),
                            modifiers: 0,
                            repeat: false,
                        },
                    )),
                },
            ),
        ),
        ..base.clone()
    };
    let paste = terminal_state_protocol::TerminalStateRecord {
        body: Some(
            terminal_state_protocol::terminal_state_record::Body::InputIntent(
                terminal_state_protocol::InputIntent {
                    intent: Some(terminal_state_protocol::input_intent::Intent::Paste(
                        terminal_state_protocol::PasteInputIntent {
                            utf8: b"first\nsecond".to_vec(),
                        },
                    )),
                },
            ),
        ),
        ..base
    };
    let writer = connection.terminal_input_writer_capability().unwrap();
    writer.send_input(1, &key).unwrap();
    writer.send_input(2, &paste).unwrap();

    wait_for_replay_snapshot(&fixture.session, b"STRUCTURED_INPUT_ENCODER_OK");
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_surface_delivers_host_parsed_osc52_clipboard_writes() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-structured-osc52",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "standalone_structured_osc52_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"STRUCTURED_OSC52_READY");
    let mut connection = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();

    surface
        .send_text_confirmed("copy\n".into(), Duration::from_secs(2))
        .unwrap();
    let event = loop {
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Event(event) => break event,
            TerminalSurfaceEvent::Frame(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt after OSC 52 trigger: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("OSC 52 fixture ended before its clipboard event: {body:?}")
            }
        }
    };
    assert_eq!(event.event_id, 1);
    let Some(terminal_state_protocol::terminal_event::Event::ClipboardWriteRequest(request)) =
        event.event
    else {
        panic!("OSC 52 did not produce a clipboard-write terminal event")
    };
    assert_eq!(request.content, b"https://claude.ai");
    assert_eq!(
        request.format,
        terminal_state_protocol::ClipboardFormat::Utf8Text as i32
    );

    surface.detach().unwrap();
    let fresh = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    let fresh = TerminalSurfaceAttachment::from_connection(fresh).unwrap();
    assert_eq!(fresh.current_frame().viewport().through_event_id, 1);
    fresh.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_pointer_encoding_follows_host_mouse_mode_without_a_controller_lease() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-structured-pointer-encoding",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "standalone_structured_pointer_encoding_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"STRUCTURED_POINTER_ENCODER_READY");
    let connection = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let initial = connection.initial_terminal_state().unwrap();
    let pointer = terminal_state_protocol::TerminalStateRecord {
        schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
        terminal_epoch: initial.terminal_epoch().to_string(),
        through_output_seq: initial.through_output_seq(),
        state_revision: initial.state_revision(),
        body: Some(
            terminal_state_protocol::terminal_state_record::Body::InputIntent(
                terminal_state_protocol::InputIntent {
                    intent: Some(terminal_state_protocol::input_intent::Intent::Pointer(
                        terminal_state_protocol::PointerInputIntent {
                            kind: terminal_state_protocol::PointerKind::Down as i32,
                            column: 4,
                            row: 2,
                            button: 0,
                            modifiers: 0,
                            wheel_delta_x: 0,
                            wheel_delta_y: 0,
                            pixel_x: 45,
                            pixel_y: 45,
                            surface_width: 800,
                            surface_height: 600,
                            cell_width: 10,
                            cell_height: 20,
                            padding_top: 0,
                            padding_bottom: 0,
                            padding_right: 0,
                            padding_left: 0,
                            pressed_buttons: 1,
                        },
                    )),
                },
            ),
        ),
    };
    connection
        .terminal_input_writer_capability()
        .unwrap()
        .send_input(1, &pointer)
        .unwrap();

    wait_for_replay_snapshot(&fixture.session, b"STRUCTURED_POINTER_ENCODER_OK");
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_surfaces_wrap_at_the_narrowest_width_without_a_controller_lease() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-structured-surface-geometry",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!(
                "stty -echo; printf WIDTH_READY; read signal; printf '\\033[2J\\033[HPTY:%s\\r\\n' \"$(stty size)\"; printf '%s' '{}한글끝'; sleep 60",
                "x".repeat(100),
            ),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"WIDTH_READY");
    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let mut large = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut small = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();

    let large_request = large.writer().send_terminal_resize(40, 100).unwrap();
    assert_structured_resize_receipt(&mut large, &large_request, 40, 100);
    let small_request = small.writer().send_terminal_resize(30, 48).unwrap();
    assert_structured_resize_receipt(&mut small, &small_request, 40, 48);
    let snapshot = fixture.session.read_screen(None).unwrap();
    assert_eq!((snapshot.rows, snapshot.columns), (40, 48));

    fixture.session.send_input(b"go\n".to_vec()).unwrap();
    wait_for_replay_snapshot(&fixture.session, "한글끝".as_bytes());
    let observer = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    let observer = TerminalSurfaceAttachment::from_connection(observer).unwrap();
    let frame = observer.current_frame();
    assert_eq!(frame.viewport().canonical_columns, 48);
    assert!(frame.text().contains("PTY:40 48"), "{}", frame.text());
    assert!(frame.text().contains(&format!("{}한글끝", "x".repeat(100))));
    let wrapped_rows = frame
        .viewport()
        .rows
        .iter()
        .filter(|row| row.termination == terminal_state_protocol::RowTermination::SoftWrap as i32)
        .count();
    assert_eq!(wrapped_rows, 2);
    let cursor = frame.viewport().cursor.as_ref().unwrap();
    assert_eq!(cursor.column, 10);
    observer.detach().unwrap();

    let rotated_request = small.writer().send_terminal_resize(20, 72).unwrap();
    assert_structured_resize_receipt(&mut small, &rotated_request, 40, 72);
    let desktop_request = large.writer().send_terminal_resize(45, 120).unwrap();
    assert_structured_resize_receipt(&mut large, &desktop_request, 45, 72);

    small.detach("surface_closed").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = fixture.session.read_screen(None).unwrap();
        if (snapshot.rows, snapshot.columns) == (45, 120) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "remaining structured surface did not become canonical"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    large.detach("surface_closed").unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_attaches_scrolls_and_resizes_through_complete_frames() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-terminal-surface-roundtrip",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "i=0; while [ $i -lt 80 ]; do printf 'surface-%03d\\r\\n' \"$i\"; i=$((i+1)); done; printf 'SURFACE_READY'; sleep 60".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"SURFACE_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();

    assert_eq!(surface.current_frame().viewport().viewport_rows, 24);
    assert_eq!(surface.current_frame().viewport().canonical_columns, 80);
    assert!(surface.current_frame().text().contains("SURFACE_READY"));

    let resize_receipt = surface
        .send_resize_confirmed(100, 30, Duration::from_secs(3))
        .unwrap();
    assert!(matches!(
        resize_receipt.outcome,
        Some(resize_receipt::Outcome::AppliedToTerminal(_))
    ));
    let resize_deadline = Instant::now() + Duration::from_secs(3);
    while surface.current_frame().viewport().viewport_rows != 30 {
        assert!(
            Instant::now() < resize_deadline,
            "resize receipt arrived without its complete viewport frame"
        );
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Control(body) => {
                if matches!(*body, FrameBody::Exit(_) | FrameBody::Error(_)) {
                    panic!("terminal surface ended before its resized viewport frame: {body:?}");
                }
            }
            TerminalSurfaceEvent::Receipt(_) => {
                panic!("an unrelated receipt crossed the resized viewport frame")
            }
        }
    }
    assert_eq!(surface.current_frame().viewport().canonical_columns, 100);

    let scrolled = surface
        .scroll_rows_confirmed(5, Duration::from_secs(3))
        .unwrap();
    assert_eq!(scrolled.viewport().viewport_rows, 30);
    assert!(!scrolled.viewport().follow_tail);
    assert_eq!(scrolled.viewport().applied_intent_seq, 1);

    let returned = surface
        .scroll_rows_confirmed(-6, Duration::from_secs(3))
        .expect("overshooting the tail must preserve the existing surface connection");
    assert!(returned.viewport().follow_tail);
    assert!(returned.text().contains("SURFACE_READY"));
    assert_eq!(returned.viewport().applied_intent_seq, 2);

    for intent_seq in [3, 5, 7] {
        let above = surface
            .scroll_rows_confirmed(1, Duration::from_secs(3))
            .unwrap();
        assert!(!above.viewport().follow_tail);
        assert_eq!(above.viewport().applied_intent_seq, intent_seq);
        let tail = surface
            .scroll_rows_confirmed(-2, Duration::from_secs(3))
            .expect("a short scroll round trip must not reconnect");
        assert!(tail.viewport().follow_tail);
        assert_eq!(tail.viewport().applied_intent_seq, intent_seq + 1);
        assert_eq!(tail.viewport().viewport_rows, 30);
        assert!(tail.text().contains("SURFACE_READY"));
    }
    let input = surface
        .send_text_confirmed("still attached".into(), Duration::from_secs(3))
        .expect("input must remain admitted on the same connection after scrolling");
    assert!(matches!(
        input.outcome,
        Some(input_receipt::Outcome::WrittenToPty(_))
    ));

    surface.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_routes_touch_wheel_to_a_full_screen_pty() {
    use hmux_runtime_contract::TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION;
    use terminal_state_protocol::{
        PointerInputIntent, PointerKind, ViewportIntent, viewport_intent, wheel_receipt,
    };

    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-touch-wheel",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "stty raw -echo; printf '\\033[?1049h\\033[?1003h\\033[?1006hTOUCH_WHEEL_READY'; bytes=$(dd bs=1 count=30 2>/dev/null | od -An -tx1 | tr -d ' \\n'); printf '\\r\\nTOUCH_WHEEL:%s' \"$bytes\"; sleep 60".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"TOUCH_WHEEL_READY");
    let mut connection = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();

    // The old mobile route acknowledges history navigation without scrolling the TUI.
    let history = surface
        .scroll_rows_confirmed(4, Duration::from_secs(3))
        .unwrap();
    assert!(history.text().contains("TOUCH_WHEEL_READY"));
    assert!(history.viewport().follow_tail);

    let wheel_minor = TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION.envelope_minor;
    for (record_id, delta) in [(2, -2), (3, 1)] {
        let frame = surface.current_frame();
        let record = TerminalStateRecord {
            schema_minor: u32::from(wheel_minor),
            terminal_epoch: frame.terminal_epoch().into(),
            through_output_seq: frame.through_output_seq(),
            state_revision: frame.state_revision(),
            body: Some(terminal_state_record::Body::ViewportIntent(
                ViewportIntent {
                    observed_projection_revision: frame.viewport().projection_revision,
                    intent_seq: record_id,
                    intent: Some(viewport_intent::Intent::Wheel(PointerInputIntent {
                        kind: PointerKind::Wheel as i32,
                        column: 4,
                        row: 2,
                        wheel_delta_y: delta,
                        pixel_x: 45,
                        pixel_y: 45,
                        surface_width: 800,
                        surface_height: 480,
                        cell_width: 10,
                        cell_height: 20,
                        ..Default::default()
                    })),
                },
            )),
        };
        surface
            .upstream_handles()
            .send_envelope(&encode_record_for_minor(wheel_minor, record_id, &record).unwrap())
            .unwrap();
        loop {
            match surface.read_event().unwrap() {
                TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Wheel(receipt)) => {
                    assert_eq!(receipt.in_reply_to_record_id, record_id);
                    assert!(matches!(
                        receipt.outcome,
                        Some(wheel_receipt::Outcome::WrittenToPty(_))
                    ));
                    break;
                }
                TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
                other => panic!("unexpected event before the wheel receipt: {other:?}"),
            }
        }
    }
    // The provider receives exactly two upward SGR wheel presses and one downward press.
    wait_for_replay_snapshot(
        &fixture.session,
        b"TOUCH_WHEEL:1b5b3c36343b353b334d1b5b3c36343b353b334d1b5b3c36353b353b334d",
    );
    surface.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_attaches_to_a_complete_viewport_larger_than_one_envelope() {
    use terminal_state_protocol::{MAX_PAYLOAD_BYTES, ProtocolError};

    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-large-terminal-surface",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'SURFACE_READY'; IFS= read -r line; i=0; while [ $i -lt 512 ]; do printf 'x\\033[511b'; i=$((i+1)); done; printf '\\r\\nLARGE_VIEWPORT_READY'; sleep 60".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"SURFACE_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .expect("the Host must send a multipart viewport seed instead of retiring the surface");
    let mut surface = TerminalSurfaceAttachment::from_connection(connection)
        .expect("the client must install one complete reassembled viewport seed");
    let receipt = surface
        .send_resize_confirmed(512, 512, Duration::from_secs(3))
        .expect("the oversized viewport resize must receive a semantic receipt");
    assert!(
        matches!(
            receipt.outcome,
            Some(resize_receipt::Outcome::AppliedToTerminal(_))
        ),
        "the Host must atomically encode the complete oversized viewport before confirming resize"
    );
    let resize_deadline = Instant::now() + Duration::from_secs(5);
    while (
        surface.current_frame().viewport().canonical_columns,
        surface.current_frame().viewport().viewport_rows,
    ) != (512, 512)
    {
        assert!(
            Instant::now() < resize_deadline,
            "resize receipt arrived without the complete oversized viewport"
        );
        match surface.read_event().expect("read resized viewport event") {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Control(body) => {
                if matches!(*body, FrameBody::Exit(_) | FrameBody::Error(_)) {
                    panic!("terminal surface ended before its oversized viewport: {body:?}");
                }
            }
            TerminalSurfaceEvent::Receipt(_) => {
                panic!("an unrelated receipt crossed the oversized viewport")
            }
        }
    }
    surface
        .send_text_confirmed("go\n".into(), Duration::from_secs(3))
        .expect("the fill command must receive a semantic input receipt");
    let output_deadline = Instant::now() + Duration::from_secs(10);
    while !surface
        .current_frame()
        .text()
        .contains("LARGE_VIEWPORT_READY")
    {
        assert!(
            Instant::now() < output_deadline,
            "the complete oversized viewport never reached the client"
        );
        match surface.read_event().expect("read oversized viewport event") {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Control(body) => {
                if matches!(*body, FrameBody::Exit(_) | FrameBody::Error(_)) {
                    panic!("terminal surface ended before its oversized viewport: {body:?}");
                }
            }
            TerminalSurfaceEvent::Receipt(_) => {
                panic!("an unrelated receipt crossed the oversized viewport")
            }
        }
    }
    let frame = surface.current_frame();
    assert_eq!(
        (
            frame.viewport().canonical_columns,
            frame.viewport().viewport_rows
        ),
        (512, 512),
        "the client must install the latest complete resized viewport"
    );
    let record = TerminalStateRecord {
        schema_minor: u32::from(PROTOCOL_MINOR),
        terminal_epoch: frame.terminal_epoch().to_string(),
        through_output_seq: frame.through_output_seq(),
        state_revision: frame.state_revision(),
        body: Some(terminal_state_record::Body::ViewportFrame(
            frame.viewport().clone(),
        )),
    };
    assert!(
        matches!(
            encode_record(1, &record),
            Err(ProtocolError::FrameTooLarge { actual, maximum })
                if actual > MAX_PAYLOAD_BYTES && maximum == MAX_PAYLOAD_BYTES
        ),
        "the fixture must exercise a complete viewport larger than one envelope"
    );
    assert!(frame.text().contains("LARGE_VIEWPORT_READY"));

    surface.detach().unwrap();
    let connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .expect("a fresh attach must receive the oversized viewport as one multipart seed");
    let attached = TerminalSurfaceAttachment::from_connection(connection)
        .expect("a fresh client must install exactly one reassembled attach seed");
    assert_eq!(
        (
            attached.current_frame().viewport().canonical_columns,
            attached.current_frame().viewport().viewport_rows,
        ),
        (512, 512)
    );
    assert!(
        attached
            .current_frame()
            .text()
            .contains("LARGE_VIEWPORT_READY")
    );
    attached.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn old_terminal_surface_gets_typed_oversize_failure_without_losing_the_provider() {
    use hmux_host::local_discovery::DiscoveryManifest;
    use hmux_host::local_protocol::{
        AttachMode, ErrorCode, FrameCodec, FrameLimits, Hello, PROTOCOL_V1, SessionFence,
        VersionRange, WireFrame,
    };
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use terminal_state_protocol::{
        InputIntent, ResizeInputIntent, TextInputIntent, encode_record_for_minor,
    };

    fn send_terminal_record(stream: &mut UnixStream, encoded: &[u8]) {
        let length = u32::try_from(encoded.len()).expect("terminal record length fits u32");
        stream.write_all(&length.to_be_bytes()).unwrap();
        stream.write_all(encoded).unwrap();
    }

    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-old-large-terminal-surface",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'SURFACE_READY'; IFS= read -r line; i=0; while [ $i -lt 512 ]; do printf 'x\\033[511b'; i=$((i+1)); done; printf '\\r\\nLARGE_VIEWPORT_READY'; sleep 60".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"SURFACE_READY");

    let discovery = DiscoveryRoot::open(state.path().join("discovery")).unwrap();
    let discovered = discovery
        .find_manifest_by_session(
            &fixture.descriptor.workspace_id,
            &fixture.descriptor.session_id,
        )
        .unwrap();
    let DiscoveryManifest::Ready(ready) = discovered.manifest else {
        panic!("the compatibility fixture must still be Ready")
    };
    let fence = SessionFence {
        workspace_id: ready.common.lifetime.workspace_id.clone(),
        session_id: ready.common.lifetime.session_id.clone(),
        runner_principal: ready.common.lifetime.runner_principal.clone(),
        runner_instance: ready.common.lifetime.runner_instance.clone(),
        channel_epoch: ready.common.lifetime.channel_epoch,
        host_instance_id: ready.common.host_instance_id.clone(),
        terminal_epoch: ready.terminal_epoch.clone(),
    };
    let codec = FrameCodec::new(FrameLimits::default());
    let mut stream = UnixStream::connect(&ready.endpoint.address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    codec
        .write_to(
            &mut stream,
            &WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::Hello(Hello {
                    supported_versions: VersionRange {
                        minimum: PROTOCOL_V1,
                        maximum: PROTOCOL_V1,
                    },
                    requested_capabilities: vec![
                        "live_output".into(),
                        "screen_snapshot".into(),
                        TERMINAL_INPUT_INTENT_CAPABILITY.into(),
                        TERMINAL_STATE_BINARY_CAPABILITY.into(),
                        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.into(),
                    ],
                    expected_fence: fence.clone(),
                    requested_mode: AttachMode::Observer,
                    reconnect_cursor: None,
                    capability_token: ready.capability_token,
                    authorization_proof_reference: None,
                    initial_snapshot_profile: None,
                }),
            },
        )
        .unwrap();
    let ack = codec.read_from(&mut stream).unwrap();
    let FrameBody::HelloAck(ack) = ack.body else {
        panic!("the old terminal client did not receive HelloAck")
    };
    assert!(
        !ack.selected_capabilities
            .iter()
            .any(|value| value == TERMINAL_VIEWPORT_MULTIPART_CAPABILITY),
        "an old client must not be promoted to multipart"
    );

    let seed = codec.read_payload(&mut stream).unwrap();
    let seed = terminal_state_protocol::decode_record(&seed).unwrap();
    assert_eq!(seed.metadata.protocol_minor, 4);
    assert!(matches!(
        seed.record.body.as_ref(),
        Some(terminal_state_record::Body::ViewportFrame(_))
    ));

    let text_record_id = 2;
    let text = TerminalStateRecord {
        schema_minor: 4,
        terminal_epoch: fence.terminal_epoch.clone(),
        through_output_seq: seed.record.through_output_seq,
        state_revision: seed.record.state_revision,
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Text(TextInputIntent {
                utf8: b"go\n".to_vec(),
            })),
        })),
    };
    send_terminal_record(
        &mut stream,
        &encode_record_for_minor(4, text_record_id, &text).unwrap(),
    );

    let mut input_receipt_seen = false;
    while !input_receipt_seen {
        let payload = codec.read_payload(&mut stream).unwrap();
        assert!(payload.starts_with(&terminal_state_protocol::ENVELOPE_MAGIC));
        let decoded = terminal_state_protocol::decode_record(&payload).unwrap();
        assert_eq!(decoded.metadata.protocol_minor, 4);
        input_receipt_seen = matches!(
            decoded.record.body,
            Some(terminal_state_record::Body::InputReceipt(ref receipt))
                if receipt.in_reply_to_record_id == text_record_id
        );
    }

    let resize_record_id = 3;
    let resize = TerminalStateRecord {
        schema_minor: 4,
        terminal_epoch: fence.terminal_epoch.clone(),
        through_output_seq: seed.record.through_output_seq,
        state_revision: seed.record.state_revision,
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                columns: 512,
                rows: 512,
                geometry_generation: resize_record_id,
            })),
        })),
    };
    send_terminal_record(
        &mut stream,
        &encode_record_for_minor(4, resize_record_id, &resize).unwrap(),
    );

    loop {
        let payload = codec.read_payload(&mut stream).unwrap();
        if payload.starts_with(&terminal_state_protocol::ENVELOPE_MAGIC) {
            let decoded = terminal_state_protocol::decode_record(&payload).unwrap();
            assert_eq!(
                decoded.metadata.protocol_minor, 4,
                "a new Host must downstamp every legacy attachment record"
            );
            continue;
        }
        let frame = codec
            .decode_payload_for_dispatch(&payload)
            .unwrap()
            .into_valid()
            .unwrap();
        let FrameBody::Error(error) = frame.body else {
            panic!("legacy oversized viewport ended with an untyped frame")
        };
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
        assert_eq!(
            error.required_capability.as_deref(),
            Some(TERMINAL_VIEWPORT_MULTIPART_CAPABILITY)
        );
        break;
    }
    let _ = stream.shutdown(Shutdown::Both);
    assert!(process_generation_is_live(&fixture.descriptor.provider_process).unwrap());

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let current = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .expect("retiring an incompatible attachment must not retire the provider");
    let attached = TerminalSurfaceAttachment::from_connection(current)
        .expect("a multipart-capable client must still attach to the same provider");
    assert_eq!(
        (
            attached.current_frame().viewport().canonical_columns,
            attached.current_frame().viewport().viewport_rows,
        ),
        (512, 512)
    );
    attached.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_projection_fault_preserves_provider_generation_and_allows_fresh_attach() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, fault_marker) = runtime_fault_wrapper(
        &state,
        "viewport-projection-fault-hook",
        "HMUX_RUNTIME_TEST_VIEWPORT_PROJECTION_FAULT_MARKER",
        "fault",
        None,
    );
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "standalone-viewport-projection-fault",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "viewport_projection_fault_fixture_provider".into(),
            "--nocapture".into(),
        ],
        &runtime,
    );
    wait_for_replay_snapshot(&fixture.session, b"PROJECTION_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert!(surface.current_frame().text().contains("PROJECTION_READY"));

    fs::write(&fault_marker, b"fail-next-projection").unwrap();
    surface
        .send_text_confirmed("fault\n".into(), Duration::from_secs(3))
        .unwrap();
    let fault_deadline = Instant::now() + Duration::from_secs(3);
    while fault_marker.exists() {
        assert!(
            Instant::now() < fault_deadline,
            "viewport projector did not observe the injected fault"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // A retired viewport attachment must learn why it was retired. Closing the
    // socket without a reason leaves the peer holding only the transport
    // symptom ("closed transport while client expected terminal_viewport_frame"),
    // which is identical for every distinct Host-side cause and therefore
    // names none of them.
    let retirement = loop {
        match surface.read_event() {
            Ok(
                TerminalSurfaceEvent::Frame(_)
                | TerminalSurfaceEvent::Event(_)
                | TerminalSurfaceEvent::Receipt(_),
            ) => {}
            Ok(TerminalSurfaceEvent::Control(body)) => {
                panic!("unexpected control frame after projection fault: {body:?}")
            }
            Err(error) => break error,
        }
    };
    let ClientError::HostRefused {
        code,
        message,
        retry,
    } = &retirement
    else {
        panic!("a viewport projection fault retired the attachment without a reason: {retirement}");
    };
    assert_eq!(*code, HostErrorCode::TransportClosed);
    assert_eq!(*retry, RetryDirective::Reconnect);
    assert!(
        message.contains("terminal viewport"),
        "retirement reason must name the failing viewport projection: {message}"
    );

    let provider = fixture.descriptor.provider_process.clone();
    let preservation_deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < preservation_deadline {
        assert!(
            process_generation_is_live(&provider).unwrap(),
            "a viewport projection fault terminated the provider generation"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let current = fixture.catalog.find(&selector).unwrap();
    assert!(
        current.same_generation(&fixture.descriptor),
        "a presentation fault replaced the Host or terminal generation"
    );

    let fresh_connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut fresh = TerminalSurfaceAttachment::from_connection(fresh_connection).unwrap();
    fresh
        .send_text_confirmed("recovered\n".into(), Duration::from_secs(3))
        .unwrap();
    let frame_deadline = Instant::now() + Duration::from_secs(3);
    while !fresh
        .current_frame()
        .text()
        .contains("PROJECTION:recovered")
    {
        assert!(
            Instant::now() < frame_deadline,
            "fresh attachment did not recover from the failed projection"
        );
        match fresh.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt after recovered input: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("fresh attachment ended before recovery frame: {body:?}")
            }
        }
    }
    assert!(process_generation_is_live(&provider).unwrap());

    fresh.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn shorter_read_only_viewport_preserves_short_output_without_resizing_the_pty() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-short-observer-viewport",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'OBSERVER_OUTPUT_READY\\n'; exec /bin/cat".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"OBSERVER_OUTPUT_READY");
    let connection = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    let mut observer = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert!(
        observer
            .current_frame()
            .text()
            .contains("OBSERVER_OUTPUT_READY")
    );
    let frame = observer
        .set_viewport_rows_confirmed(8, Duration::from_secs(3))
        .unwrap();
    assert_eq!(frame.viewport().viewport_rows, 8);
    assert!(frame.text().contains("OBSERVER_OUTPUT_READY"));
    assert!(frame.viewport().cursor.is_some());
    assert!(!frame.viewport().has_more_after);

    let writer_connection = fixture
        .session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let writer = TerminalSurfaceAttachment::from_connection(writer_connection).unwrap();
    assert_eq!(writer.current_frame().viewport().viewport_rows, 24);
    assert_eq!(writer.current_frame().viewport().canonical_columns, 80);
    assert!(
        writer
            .current_frame()
            .text()
            .contains("OBSERVER_OUTPUT_READY")
    );
    writer.detach().unwrap();
    observer.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn written_input_publishes_its_next_viewport_without_the_continuous_output_delay() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-interactive-viewport-publication",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "viewport_projection_fault_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"PROJECTION_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();

    let prime_input_baseline = surface.current_frame().through_output_seq();
    let prime = surface
        .send_text_confirmed("prime\n".into(), Duration::from_secs(3))
        .unwrap();
    let prime_baseline_output_sequence = match prime.outcome {
        Some(input_receipt::Outcome::WrittenToPty(written)) => written
            .input_baseline_output_sequence
            .expect("the priming input must carry its pre-output Host high-water"),
        _ => panic!("the priming input was not written to the PTY"),
    };
    assert_eq!(prime_baseline_output_sequence, prime_input_baseline);
    while !surface.current_frame().text().contains("PROJECTION:prime") {
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt while waiting for the priming frame: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("terminal surface ended before the priming frame: {body:?}")
            }
        }
    }
    assert!(
        surface.current_frame().through_output_seq() > prime_baseline_output_sequence,
        "the provider's priming response must advance beyond the input's captured baseline"
    );

    let observer_connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    let mut observer = TerminalSurfaceAttachment::from_connection(observer_connection).unwrap();
    assert!(observer.current_frame().text().contains("PROJECTION:prime"));

    let focus_record_id = 10_000;
    let focus_frame = surface.current_frame();
    let focus_baseline_output_sequence = focus_frame.through_output_seq();
    let focus = TerminalStateRecord {
        schema_minor: 4,
        terminal_epoch: focus_frame.terminal_epoch().to_string(),
        through_output_seq: focus_frame.through_output_seq(),
        state_revision: focus_frame.state_revision(),
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Focus(FocusInputIntent {
                focused: true,
            })),
        })),
    };
    surface
        .upstream_handles()
        .send_envelope(&encode_record_for_minor(4, focus_record_id, &focus).unwrap())
        .unwrap();
    loop {
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Input(receipt))
                if receipt.in_reply_to_record_id == focus_record_id =>
            {
                let baseline = match receipt.outcome {
                    Some(input_receipt::Outcome::WrittenToPty(written)) => {
                        written.input_baseline_output_sequence
                    }
                    _ => panic!("the focus input was not written to the PTY"),
                };
                assert_eq!(
                    baseline,
                    Some(focus_baseline_output_sequence),
                    "a successful control-only input must carry the current output high-water"
                );
                break;
            }
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt after the focus input: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("terminal surface ended after the focus input: {body:?}")
            }
        }
    }
    assert_eq!(
        surface.current_frame().through_output_seq(),
        focus_baseline_output_sequence,
        "the control-only focus input must not require provider echo"
    );

    let input_baseline_output_sequence = surface.current_frame().through_output_seq();
    let interactive = surface
        .send_text_confirmed("interactive\n".into(), Duration::from_secs(3))
        .unwrap();
    let interactive_record_id = interactive.in_reply_to_record_id;
    let interactive_baseline = match interactive.outcome {
        Some(input_receipt::Outcome::WrittenToPty(written)) => {
            written.input_baseline_output_sequence
        }
        _ => panic!("the interactive input was not written to the PTY"),
    };
    assert_eq!(
        interactive_baseline,
        Some(input_baseline_output_sequence),
        "the interactive receipt must retain its immediately observed output high-water"
    );
    let receipt_at = Instant::now();
    while !surface
        .current_frame()
        .text()
        .contains("PROJECTION:interactive")
    {
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt after the interactive input: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("terminal surface ended before the interactive frame: {body:?}")
            }
        }
    }
    let receipt_to_viewport = receipt_at.elapsed();
    eprintln!("written_input_receipt_to_viewport={receipt_to_viewport:?}");
    let frame = surface.current_frame();
    let timing = frame
        .viewport()
        .input_output_timing
        .as_ref()
        .expect("the viewport must carry its content-free Host input/output timing");
    assert_eq!(
        timing.input_baseline_output_sequence,
        input_baseline_output_sequence
    );
    assert_eq!(timing.input_record_id, interactive_record_id);
    assert!(timing.first_output_sequence > input_baseline_output_sequence);
    assert!(timing.first_output_sequence <= frame.through_output_seq());
    while !observer
        .current_frame()
        .text()
        .contains("PROJECTION:interactive")
    {
        match observer.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt on the observing attachment: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("observing attachment ended before the interactive frame: {body:?}")
            }
        }
    }
    assert!(
        observer
            .current_frame()
            .viewport()
            .input_output_timing
            .is_none(),
        "input timing correlation leaked to another attachment"
    );
    eprintln!(
        "host_input_to_output={:?} host_output_to_projection_start={:?}",
        Duration::from_micros(timing.input_to_output_micros),
        Duration::from_micros(timing.output_to_projection_start_micros),
    );

    observer.detach().unwrap();
    surface.detach().unwrap();
    fixture.terminate_and_verify();

    assert!(
        receipt_to_viewport < Duration::from_millis(25),
        "the exact written-to-PTY input receipt waited {receipt_to_viewport:?} for its next viewport"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn coalesced_provider_output_preserves_each_written_input_baseline() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-coalesced-input-baseline",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "coalesced_input_baseline_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"COALESCED_INPUT_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert!(
        surface
            .current_frame()
            .text()
            .contains("COALESCED_INPUT_READY")
    );
    let pre_output_baseline = surface.current_frame().through_output_seq();
    let mut observer_connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    observer_connection
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut observer = TerminalSurfaceAttachment::from_connection(observer_connection).unwrap();
    assert_eq!(
        observer.current_frame().through_output_seq(),
        pre_output_baseline
    );

    let first_receipt = surface
        .send_text_confirmed(COALESCED_INPUT_FIRST.into(), Duration::from_secs(3))
        .unwrap();
    let first_baseline = match first_receipt.outcome {
        Some(input_receipt::Outcome::WrittenToPty(written)) => written
            .input_baseline_output_sequence
            .expect("the first written input must carry its Host output baseline"),
        _ => panic!("the first Korean input was not written to the PTY"),
    };
    assert_eq!(
        surface.current_frame().through_output_seq(),
        pre_output_baseline
    );

    let second_receipt = surface
        .send_text_confirmed(COALESCED_INPUT_SECOND.into(), Duration::from_secs(3))
        .unwrap();
    let second_baseline = match second_receipt.outcome {
        Some(input_receipt::Outcome::WrittenToPty(written)) => written
            .input_baseline_output_sequence
            .expect("the second written input must carry its Host output baseline"),
        _ => panic!("the second Korean input was not written to the PTY"),
    };
    assert_eq!(
        (first_baseline, second_baseline),
        (pre_output_baseline, pre_output_baseline),
        "separate PTY writes before one provider response must retain the same output high-water"
    );

    while observer.current_frame().through_output_seq() == pre_output_baseline {
        match observer.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!(
                    "observer received a receipt while waiting for coalesced output: {receipt:?}"
                )
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("observing surface ended before coalesced output: {body:?}")
            }
        }
    }
    let frame = observer.current_frame();
    assert_eq!(
        frame.through_output_seq(),
        pre_output_baseline.checked_add(1).unwrap(),
        "one provider stdout write must produce one canonical output sequence"
    );
    assert!(frame.text().contains(COALESCED_INPUT_FIRST));
    assert!(frame.text().contains(COALESCED_INPUT_SECOND));

    observer.detach().unwrap();
    surface.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the coalesced input baseline smoke"]
fn coalesced_input_baseline_fixture_provider() {
    configure_fixture_stdin_raw();
    print!("COALESCED_INPUT_READY");
    std::io::stdout().flush().unwrap();

    let expected = [
        COALESCED_INPUT_FIRST.as_bytes(),
        COALESCED_INPUT_SECOND.as_bytes(),
    ]
    .concat();
    let mut actual = vec![0_u8; expected.len()];
    std::io::stdin().read_exact(&mut actual).unwrap();
    assert_eq!(actual, expected);

    let output =
        format!("\r\nCOALESCED_INPUT:{COALESCED_INPUT_FIRST}|{COALESCED_INPUT_SECOND}\r\n");
    // SAFETY: stdout is the fixture's live PTY, and `output` remains valid for
    // the duration of this single synchronous write.
    let written = unsafe { libc::write(libc::STDOUT_FILENO, output.as_ptr().cast(), output.len()) };
    assert_eq!(written, output.len() as isize);
    loop {
        std::thread::park();
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_mutation_failure_keeps_draining_provider_output() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, fault_marker) = runtime_fault_wrapper(
        &state,
        "terminal-mutation-fault-hook",
        "HMUX_RUNTIME_TEST_TERMINAL_MUTATION_FAULT_MARKER",
        "fault",
        None,
    );
    let provider_done = fault_marker.with_extension("provider-done");
    let fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "standalone-terminal-mutation-drain",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "terminal_mutation_failure_drain_fixture_provider".into(),
            "--nocapture".into(),
        ],
        &runtime,
    );
    wait_for_replay_snapshot(&fixture.session, b"MUTATION_DRAIN_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let mut surface = TerminalSurfaceAttachment::from_connection(
        fixture
            .catalog
            .open(&selector)
            .unwrap()
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::ReadOnly,
                None,
            ))
            .unwrap(),
    )
    .unwrap();

    fs::write(&fault_marker, b"fail-next-mutation").unwrap();
    fixture.session.send_input(b"flood\n".to_vec()).unwrap();

    // The mutation authority cannot resume in this provider epoch
    // (main.rs sets terminal_mutation_available = false and keeps draining), so
    // the retirement must not tell the pane to reconnect: a successor attach
    // succeeds, seeds one frame, keeps accepting keystrokes, and then never
    // receives another frame for the life of the process.
    let retirement = loop {
        match surface.read_event() {
            Ok(
                TerminalSurfaceEvent::Frame(_)
                | TerminalSurfaceEvent::Event(_)
                | TerminalSurfaceEvent::Receipt(_),
            ) => {}
            Ok(TerminalSurfaceEvent::Control(body)) => {
                panic!("unexpected control frame after a mutation fault: {body:?}")
            }
            Err(error) => break error,
        }
    };
    let ClientError::HostRefused { code, retry, .. } = &retirement else {
        panic!("a terminal mutation fault retired the attachment without a reason: {retirement}");
    };
    assert_eq!(*code, HostErrorCode::TransportClosed);
    assert_eq!(
        *retry,
        RetryDirective::Never,
        "a mutation authority that cannot resume must not advertise reconnect"
    );

    wait_for_exact_file(&provider_done, b"provider-completed");
    assert!(wait_for_process_generation_exit_with_timeout(
        &fixture.descriptor.provider_process,
        Duration::from_secs(3),
    ));
    let diagnostics = fs::read_to_string(
        state
            .path()
            .join("discovery/.diagnostics/runtime-v1/runtime.jsonl"),
    )
    .unwrap();
    let mutation_failures = diagnostics
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|record| {
            record["event"] == "terminal_presentation_degraded"
                && record["failureCode"] == "terminal_mutation"
        })
        .count();
    assert_eq!(mutation_failures, 1);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the terminal mutation drain smoke"]
fn terminal_mutation_failure_drain_fixture_provider() {
    print!("MUTATION_DRAIN_READY");
    std::io::stdout().flush().unwrap();

    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    assert_eq!(line.trim_end_matches(['\r', '\n']), "flood");

    let chunk = vec![b'X'; 64 * 1024];
    let mut output = std::io::stdout().lock();
    for _ in 0..256 {
        output.write_all(&chunk).unwrap();
    }
    output.flush().unwrap();
    let marker = std::path::PathBuf::from(
        std::env::var_os("HMUX_RUNTIME_TEST_TERMINAL_MUTATION_FAULT_MARKER")
            .expect("runtime fault marker must reach the provider"),
    )
    .with_extension("provider-done");
    fs::write(marker, b"provider-completed").unwrap();
}

#[cfg(feature = "terminal-state-stream")]
struct ViewportProjectionPauseRelease(std::path::PathBuf);

#[cfg(feature = "terminal-state-stream")]
impl Drop for ViewportProjectionPauseRelease {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, b"release");
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_attach_commits_seed_before_async_projection_work() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, paused_marker) = runtime_fault_wrapper(
        &state,
        "viewport-attach-seed-hook",
        "HMUX_RUNTIME_TEST_VIEWPORT_PROJECTION_WORK_MARKER",
        "paused",
        None,
    );
    let arm_marker = paused_marker.with_extension("arm");
    let release_marker = paused_marker.with_extension("release");
    let release = ViewportProjectionPauseRelease(release_marker);
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "standalone-viewport-attach-seed",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "viewport_projection_completion_fixture_provider".into(),
            "--nocapture".into(),
        ],
        &runtime,
    );
    wait_for_replay_snapshot(&fixture.session, b"COMPLETION_READY");

    fs::write(&arm_marker, b"pause-first-async-projection").unwrap();
    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let catalog = fixture.catalog.clone();
    let (attached_tx, attached_rx) = std::sync::mpsc::sync_channel(1);
    let (finish_tx, finish_rx) = std::sync::mpsc::sync_channel(1);
    let attaching = std::thread::spawn(move || {
        let result = catalog
            .open(&selector)
            .and_then(|session| {
                session.connect_with_options(TerminalSurfaceAttachment::connection_options(
                    TerminalSurfaceAccess::ReadOnly,
                    None,
                ))
            })
            .and_then(TerminalSurfaceAttachment::from_connection);
        let _ = attached_tx.send(
            result
                .as_ref()
                .map(|surface| surface.current_frame().text().to_string())
                .map_err(ToString::to_string),
        );
        let _ = finish_rx.recv();
        if let Ok(surface) = result {
            surface.detach().unwrap();
        }
    });
    let attached = attached_rx
        .recv_timeout(Duration::from_millis(500))
        .expect("attach was declared ready before its viewport seed was committed")
        .expect("structured viewport attach failed");
    assert!(attached.contains("COMPLETION_READY"));
    assert!(
        !paused_marker.exists(),
        "a committed attach seed scheduled redundant asynchronous projection work"
    );

    drop(release);
    // Keep the seeded surface attached: provider exit must not wait for a
    // redundant asynchronous projection of the frame already delivered.
    let stopped = fixture
        .session
        .terminate_standalone(&fixture.catalog, Duration::from_secs(3));
    finish_tx.send(()).unwrap();
    attaching.join().unwrap();
    stopped.expect("provider exit waited for the already-committed attach seed");
    fixture.wait_for_retirement();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_projection_completion_waits_for_attachment_worker() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, paused_marker) = runtime_fault_wrapper(
        &state,
        "viewport-projection-work-hook",
        "HMUX_RUNTIME_TEST_VIEWPORT_PROJECTION_WORK_MARKER",
        "paused",
        None,
    );
    let arm_marker = paused_marker.with_extension("arm");
    let release_marker = paused_marker.with_extension("release");
    let release = ViewportProjectionPauseRelease(release_marker);
    let captures_marker = paused_marker.with_extension("captures");
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "standalone-viewport-projection-completion",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "viewport_projection_completion_fixture_provider".into(),
            "--nocapture".into(),
        ],
        &runtime,
    );
    wait_for_replay_snapshot(&fixture.session, b"COMPLETION_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert!(surface.current_frame().text().contains("COMPLETION_READY"));

    fs::write(&arm_marker, b"arm-one-projection").unwrap();
    surface
        .send_text_confirmed("burst\n".into(), Duration::from_secs(3))
        .unwrap();
    let pause_deadline = Instant::now() + Duration::from_secs(3);
    while !paused_marker.exists() {
        assert!(
            Instant::now() < pause_deadline,
            "attachment worker did not reach the isolated pause boundary"
        );
        std::thread::sleep(Duration::from_millis(5));
    }

    std::thread::sleep(Duration::from_millis(300));
    let captures_while_worker_paused = fs::read_to_string(&captures_marker)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();

    drop(release);
    surface.detach().unwrap();
    fixture.terminate_and_verify();

    assert_eq!(
        captures_while_worker_paused.len(),
        1,
        "Host-wide completion escaped the busy attachment worker and recaptured source for \
         generations {captures_while_worker_paused:?}"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the viewport projection fault smoke"]
fn viewport_projection_fault_fixture_provider() {
    print!("PROJECTION_READY");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    loop {
        line.clear();
        if std::io::stdin().read_line(&mut line).unwrap() == 0 {
            return;
        }
        print!("\r\nPROJECTION:{}", line.trim_end_matches(['\r', '\n']));
        std::io::stdout().flush().unwrap();
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the projection completion smoke"]
fn viewport_projection_completion_fixture_provider() {
    print!("COMPLETION_READY");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    loop {
        line.clear();
        if std::io::stdin().read_line(&mut line).unwrap() == 0 {
            return;
        }
        if line.trim_end_matches(['\r', '\n']) != "burst" {
            continue;
        }
        for index in 0..256 {
            print!("\r\nBURST:{index:03}");
            std::io::stdout().flush().unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_resize_encoded_before_output_is_admitted_after_output_advances() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-terminal-surface-queued-resize",
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'SURFACE_READY'; IFS= read -r line; printf 'OUTPUT_AFTER_RESIZE_QUEUE:%s' \"$line\"; sleep 60".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"SURFACE_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let mut connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let writer = connection.terminal_input_writer_capability().unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let initial_revision = surface.current_frame().state_revision();
    assert!(
        initial_revision > 0,
        "ready output must establish a revision fence"
    );
    let initial_output_sequence = surface.current_frame().through_output_seq();
    let queued_resize = encode_surface_resize(surface.current_frame(), initial_revision, 100, 30);

    let input_receipt = fixture.session.send_input(b"advance\n".to_vec()).unwrap();
    assert_eq!(input_receipt.state, InputReceiptState::WrittenToPty);
    let advanced = wait_for_replay_snapshot(&fixture.session, b"OUTPUT_AFTER_RESIZE_QUEUE:advance");
    assert!(
        advanced.sequence_through > initial_output_sequence,
        "the Host output fence must advance before admitting the queued resize"
    );

    assert_eq!(
        writer.send_input_envelope(&queued_resize).unwrap(),
        initial_revision
    );
    let receipt = wait_for_causally_ordered_surface_resize(&mut surface, initial_revision, 100, 30);
    assert!(matches!(
        receipt.outcome,
        Some(resize_receipt::Outcome::AppliedToTerminal(_))
    ));
    let resized = fixture.session.read_screen(None).unwrap();
    assert_eq!((resized.rows, resized.columns), (30, 100));

    surface.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn pty_read_is_ingested_before_resize_changes_canonical_geometry() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, arm_marker, paused_marker, release_marker) =
        pty_read_before_ingest_pause_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "standalone-pty-read-resize-order",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "pty_read_resize_order_fixture_provider".into(),
            "--nocapture".into(),
        ],
        &runtime,
    );
    wait_for_replay_snapshot(&fixture.session, b"PTY_READ_RESIZE_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let mut connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();

    fs::write(&arm_marker, b"armed").unwrap();
    fixture.session.send_input(b"PAINT".to_vec()).unwrap();
    wait_for_exact_file(&paused_marker, b"read_sampled");

    let resize_session = fixture.session.clone();
    let (resize_tx, resize_rx) = mpsc::sync_channel(1);
    let resize_thread = std::thread::spawn(move || {
        resize_tx.send(resize_session.send_resize(24, 100)).unwrap();
    });
    let receipt_before_release = resize_rx.recv_timeout(Duration::from_millis(250));
    fs::write(&release_marker, b"release").unwrap();
    let receipt = match receipt_before_release {
        Ok(receipt) => receipt,
        Err(mpsc::RecvTimeoutError::Timeout) => resize_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("resize must complete after the sampled PTY read is released"),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            panic!("resize worker disconnected before returning its receipt")
        }
    }
    .unwrap();
    resize_thread.join().unwrap();
    assert_eq!((receipt.rows, receipt.columns), (Some(24), Some(100)));

    let deadline = Instant::now() + Duration::from_secs(5);
    let marker_column = loop {
        let frame = surface.current_frame();
        if (
            frame.viewport().viewport_rows,
            frame.viewport().canonical_columns,
        ) == (24, 100)
            && frame.text().contains('X')
        {
            let tables = frame.viewport().tables.as_ref().unwrap();
            let mut found = None;
            for row in &frame.viewport().rows {
                let mut column = 0_u32;
                for cell in &row.cells {
                    let grapheme = &tables.graphemes[cell.grapheme_index as usize];
                    if grapheme.text == "X" {
                        found = Some(column);
                        break;
                    }
                    column += grapheme.display_width;
                }
                if found.is_some() {
                    break;
                }
            }
            break found.expect("the projected marker must have a canonical cell");
        }
        assert!(
            Instant::now() < deadline,
            "sampled PTY output did not reach the resized terminal surface"
        );
        surface.read_event().unwrap();
    };

    assert_eq!(
        marker_column, 79,
        "bytes sampled at 80 columns must be ingested before the Host changes to 100 columns"
    );

    surface.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_platform_resize_failure_is_request_local() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, arm_marker, observed_marker) = pty_resize_liveness_fault_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "standalone-platform-resize-failure-liveness",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "platform_resize_failure_liveness_fixture_provider".into(),
            "--nocapture".into(),
        ],
        &runtime,
    );
    wait_for_replay_snapshot(&fixture.session, b"RESIZE_FAILURE_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let mut connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let writer = connection.terminal_input_writer_capability().unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let retained = surface.current_frame().clone();
    assert!(retained.text().contains("RESIZE_FAILURE_READY"));

    fs::write(&arm_marker, b"armed").unwrap();
    let failed_resize = encode_surface_resize(&retained, 1, 100, 30);
    writer.send_input_envelope(&failed_resize).unwrap();
    let failed = wait_for_surface_resize_receipt(&mut surface, 1);
    let Some(resize_receipt::Outcome::Failed(failure)) = failed.outcome.as_ref() else {
        panic!("the injected platform resize did not return a failed receipt");
    };
    assert!(matches!(
        ResizeFailureReason::try_from(failure.reason),
        Ok(ResizeFailureReason::PlatformResizeFailed)
    ));
    wait_for_exact_file(&observed_marker, b"resize_lock_poisoned");
    assert_eq!(
        surface.current_frame().state_revision(),
        retained.state_revision(),
        "a failed resize must retain the previous complete frame"
    );
    assert!(
        surface
            .current_frame()
            .text()
            .contains("RESIZE_FAILURE_READY")
    );

    writer.send_input_envelope(&failed_resize).unwrap();
    let duplicate = wait_for_surface_resize_receipt(&mut surface, 1);
    let duplicate_is_stale = matches!(
        duplicate.outcome.as_ref(),
        Some(resize_receipt::Outcome::Refused(refused))
            if ResizeRefusalReason::try_from(refused.reason)
                == Ok(ResizeRefusalReason::StaleGeometryGeneration)
    );

    let distinct_resize = encode_surface_resize(surface.current_frame(), 2, 101, 31);
    writer.send_input_envelope(&distinct_resize).unwrap();
    let distinct = wait_for_surface_resize_receipt(&mut surface, 2);
    let distinct_applied = matches!(
        distinct.outcome.as_ref(),
        Some(resize_receipt::Outcome::AppliedToTerminal(applied))
            if (applied.columns, applied.rows) == (101, 31)
    );

    let input_record_id = 3;
    let input = TerminalStateRecord {
        schema_minor: u32::from(hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR),
        terminal_epoch: surface.current_frame().terminal_epoch().to_string(),
        through_output_seq: surface.current_frame().through_output_seq(),
        state_revision: surface.current_frame().state_revision(),
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Text(TextInputIntent {
                utf8: b"still-live\n".to_vec(),
            })),
        })),
    };
    let input_sent = writer.send_input(input_record_id, &input).is_ok();
    let mut input_acknowledged = false;
    let mut output_rendered = false;
    if input_sent {
        while let Ok(event) = surface.read_event() {
            match event {
                TerminalSurfaceEvent::Frame(frame) => {
                    output_rendered |= frame
                        .text()
                        .contains("OUTPUT_AFTER_RESIZE_FAILURE:still-live");
                }
                TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Input(receipt))
                    if receipt.in_reply_to_record_id == input_record_id =>
                {
                    input_acknowledged = matches!(
                        receipt.outcome,
                        Some(input_receipt::Outcome::WrittenToPty(_))
                    );
                }
                TerminalSurfaceEvent::Event(_) | TerminalSurfaceEvent::Receipt(_) => {}
                TerminalSurfaceEvent::Control(_) => break,
            }
            if input_acknowledged && output_rendered {
                break;
            }
        }
    }

    let current = fixture.catalog.find(&selector).unwrap();
    let same_generation = current.same_generation(&fixture.descriptor)
        && process_generation_is_live(&fixture.descriptor.host_process).unwrap()
        && process_generation_is_live(&fixture.descriptor.provider_process).unwrap();
    let diagnostics = fs::read_to_string(
        state
            .path()
            .join("discovery/.diagnostics/runtime-v1/runtime.jsonl"),
    )
    .unwrap();
    let resize_failure_diagnosed = diagnostics.lines().any(|line| {
        let record: serde_json::Value = serde_json::from_str(line).unwrap();
        record["event"] == "terminal_resize_failed"
            && record["failureStage"] == "pty_io_lock"
            && record["failureCode"] == "poisoned_lock"
    });
    let history_failure_diagnosed = diagnostics.lines().any(|line| {
        let record: serde_json::Value = serde_json::from_str(line).unwrap();
        record["event"] == "terminal_history_degraded"
            && record["failureCode"] == "history_capacity"
    });
    let _ = surface.detach();
    fixture.terminate_and_verify();

    assert!(
        duplicate_is_stale
            && distinct_applied
            && input_acknowledged
            && output_rendered
            && same_generation
            && resize_failure_diagnosed
            && history_failure_diagnosed,
        "platform resize failure latched the session: duplicate_is_stale={duplicate_is_stale}, distinct_applied={distinct_applied}, input_acknowledged={input_acknowledged}, output_rendered={output_rendered}, same_generation={same_generation}, resize_failure_diagnosed={resize_failure_diagnosed}, history_failure_diagnosed={history_failure_diagnosed}"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_keeps_one_attachment_through_an_undrained_resize_burst() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-terminal-surface-resize-burst",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "terminal_surface_resize_burst_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"RESIZE_BURST_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let mut connection = fixture
        .catalog
        .open(&selector)
        .unwrap()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let writer = connection.terminal_input_writer_capability().unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let initial = surface.current_frame().clone();
    fixture
        .session
        .send_input(b"START_BURST\n".to_vec())
        .unwrap();
    wait_for_replay_snapshot(&fixture.session, b"RESIZE_BURST_STREAMING");

    const RESIZE_COUNT: u64 = 64;
    let mut geometry_records = BTreeMap::new();
    for record_id in 1..=RESIZE_COUNT {
        let columns = 80 + u32::try_from(record_id % 19).unwrap();
        let rows = 24 + u32::try_from(record_id % 11).unwrap();
        geometry_records.insert((columns, rows), record_id);
        let encoded = encode_surface_resize(&initial, record_id, columns, rows);
        assert_eq!(writer.send_input_envelope(&encoded).unwrap(), record_id);
    }
    let input_record_id = RESIZE_COUNT + 1;
    let input = TerminalStateRecord {
        schema_minor: u32::from(hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR),
        terminal_epoch: initial.terminal_epoch().to_string(),
        through_output_seq: initial.through_output_seq(),
        state_revision: initial.state_revision(),
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Text(TextInputIntent {
                utf8: b"QBURST\n".to_vec(),
            })),
        })),
    };
    writer
        .send_input(input_record_id, &input)
        .expect("the queued resize burst must not revoke its typed writer handle");

    let mut resize_receipts = std::collections::BTreeSet::new();
    let mut input_receipt = false;
    let mut final_frame = false;
    let final_geometry = (
        80 + u32::try_from(RESIZE_COUNT % 19).unwrap(),
        24 + u32::try_from(RESIZE_COUNT % 11).unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while resize_receipts.len() < RESIZE_COUNT as usize || !input_receipt || !final_frame {
        assert!(
            Instant::now() < deadline,
            "resize burst did not preserve all receipts, input, and the latest complete frame: receipts={}, input_receipt={input_receipt}, final_frame={final_frame}, current_geometry={:?}",
            resize_receipts.len(),
            (
                surface.current_frame().viewport().canonical_columns,
                surface.current_frame().viewport().viewport_rows,
            )
        );
        let event = match surface.read_event() {
            Ok(event) => event,
            Err(error) => panic!(
                "resize burst attachment stayed live: {error:?}; receipts={}, input_receipt={input_receipt}, final_frame={final_frame}, current_geometry={:?}",
                resize_receipts.len(),
                (
                    surface.current_frame().viewport().canonical_columns,
                    surface.current_frame().viewport().viewport_rows,
                )
            ),
        };
        match event {
            TerminalSurfaceEvent::Frame(frame) => {
                let geometry = (
                    frame.viewport().canonical_columns,
                    frame.viewport().viewport_rows,
                );
                if let Some(record_id) = geometry_records.get(&geometry) {
                    assert!(
                        resize_receipts.contains(record_id),
                        "complete geometry {geometry:?} crossed resize receipt {record_id}"
                    );
                }
                final_frame |= geometry == final_geometry;
            }
            TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Resize(receipt)) => {
                assert!(matches!(
                    receipt.outcome,
                    Some(resize_receipt::Outcome::AppliedToTerminal(_))
                ));
                resize_receipts.insert(receipt.in_reply_to_record_id);
            }
            TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Input(receipt)) => {
                if receipt.in_reply_to_record_id == input_record_id {
                    assert!(matches!(
                        receipt.outcome,
                        Some(input_receipt::Outcome::WrittenToPty(_))
                    ));
                    input_receipt = true;
                }
            }
            TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected terminal receipt during resize burst: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("resize burst attachment ended unexpectedly: {body:?}")
            }
        }
    }
    assert_eq!(resize_receipts.len(), RESIZE_COUNT as usize);
    assert!(process_generation_is_live(&fixture.descriptor.provider_process).unwrap());

    surface.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn sixteen_terminal_surfaces_progress_while_one_attachment_is_undrained() {
    const SURFACE_COUNT: usize = 16;
    const ACTIVE_SURFACE_COUNT: usize = SURFACE_COUNT - 1;
    const RESIZES_PER_SURFACE: usize = 8;

    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-sixteen-terminal-surfaces",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "sixteen_terminal_surfaces_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    wait_for_replay_snapshot(&fixture.session, b"SIXTEEN_SURFACES_READY");

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let mut surfaces = Vec::with_capacity(SURFACE_COUNT);
    for _ in 0..SURFACE_COUNT {
        let mut connection = session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::Writer,
                None,
            ))
            .expect("all sixteen terminal surfaces must attach to one Host");
        connection
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        surfaces.push(
            TerminalSurfaceAttachment::from_connection(connection)
                .expect("every attachment must install one complete seed frame"),
        );
    }

    let parked = surfaces.remove(0);
    let parked_output_sequence = parked.current_frame().through_output_seq();
    let start = Instant::now();
    let start_barrier = Arc::new(Barrier::new(ACTIVE_SURFACE_COUNT + 1));
    let (result_tx, result_rx) = mpsc::channel();
    let mut workers = Vec::with_capacity(ACTIVE_SURFACE_COUNT);
    for (surface_index, mut surface) in surfaces.into_iter().enumerate() {
        let start_barrier = Arc::clone(&start_barrier);
        let result_tx = result_tx.clone();
        workers.push(std::thread::spawn(move || {
            let initial_output_sequence = surface.current_frame().through_output_seq();
            start_barrier.wait();

            let mut resize_receipts = 0_usize;
            for resize_index in 0..RESIZES_PER_SURFACE {
                let columns = 80 + u32::try_from((surface_index + resize_index) % 23).unwrap();
                let rows = 24 + u32::try_from((surface_index * 3 + resize_index) % 11).unwrap();
                let receipt = surface
                    .send_resize_confirmed(columns, rows, Duration::from_secs(10))
                    .expect("a live surface resize must receive a correlated receipt");
                assert!(
                    matches!(
                        receipt.outcome,
                        Some(resize_receipt::Outcome::AppliedToTerminal(_))
                    ),
                    "surface {surface_index} resize {resize_index} was refused"
                );
                resize_receipts += 1;
            }

            let input_receipt = surface
                .send_text_confirmed(
                    format!("SIXTEEN_SURFACE_INPUT_{surface_index:02}\n"),
                    Duration::from_secs(10),
                )
                .expect("a live surface input must receive a correlated receipt");
            assert!(
                matches!(
                    input_receipt.outcome,
                    Some(input_receipt::Outcome::WrittenToPty(_))
                ),
                "surface {surface_index} input was refused"
            );

            let anchored = surface
                .scroll_rows_confirmed(4, Duration::from_secs(10))
                .expect("each surface must establish its own Host-owned scroll anchor");
            assert!(
                !anchored.viewport().follow_tail,
                "surface {surface_index} did not leave follow-tail"
            );
            let anchored_output_sequence = anchored.through_output_seq();
            let later_output_sequence = loop {
                match surface
                    .read_event()
                    .expect("active surface must not starve behind an undrained sibling")
                {
                    TerminalSurfaceEvent::Frame(frame)
                        if frame.through_output_seq() > anchored_output_sequence =>
                    {
                        assert!(
                            !frame.viewport().follow_tail,
                            "surface {surface_index} lost its scroll anchor on later output"
                        );
                        break frame.through_output_seq();
                    }
                    TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
                    TerminalSurfaceEvent::Receipt(receipt) => {
                        panic!("surface {surface_index} received an unrelated receipt: {receipt:?}")
                    }
                    TerminalSurfaceEvent::Control(body) => panic!(
                        "surface {surface_index} ended while its sibling was undrained: {body:?}"
                    ),
                }
            };
            assert!(later_output_sequence > initial_output_sequence);
            surface.detach().unwrap();
            result_tx
                .send((
                    surface_index,
                    resize_receipts,
                    initial_output_sequence,
                    later_output_sequence,
                    start.elapsed(),
                ))
                .unwrap();
        }));
    }
    drop(result_tx);

    fixture
        .session
        .send_input(b"START_SIXTEEN_SURFACES\n".to_vec())
        .unwrap();
    wait_for_replay_snapshot(&fixture.session, b"SIXTEEN_SURFACES_OUTPUT_0100");
    start_barrier.wait();

    let results = result_rx
        .iter()
        .collect::<Vec<(usize, usize, u64, u64, Duration)>>();
    let panicked_workers = workers
        .into_iter()
        .map(|worker| usize::from(worker.join().is_err()))
        .sum::<usize>();
    if panicked_workers > 0 {
        drop(parked);
        std::thread::sleep(Duration::from_millis(100));
        let diagnostics_path = state
            .path()
            .join("discovery/.diagnostics/runtime-v1/runtime.jsonl");
        eprintln!(
            "SIXTEEN_SURFACES_RED_DIAGNOSTICS\n{}",
            fs::read_to_string(&diagnostics_path).unwrap_or_default()
        );
        fixture.terminate_and_verify();
        panic!("{panicked_workers} of {ACTIVE_SURFACE_COUNT} active surfaces lost transport");
    }
    assert_eq!(results.len(), ACTIVE_SURFACE_COUNT);
    assert_eq!(
        results
            .iter()
            .map(|(_, receipts, _, _, _)| receipts)
            .sum::<usize>(),
        ACTIVE_SURFACE_COUNT * RESIZES_PER_SURFACE
    );
    assert!(
        results
            .iter()
            .all(|(_, _, _, later, _)| *later > parked_output_sequence),
        "every active surface must observe output after the sibling stopped draining"
    );

    drop(parked);
    assert!(process_generation_is_live(&fixture.descriptor.provider_process).unwrap());
    let diagnostics_path = state
        .path()
        .join("discovery/.diagnostics/runtime-v1/runtime.jsonl");
    let diagnostics = fs::read_to_string(&diagnostics_path).unwrap();
    let records = diagnostics
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let maximum = |field: &str| {
        records
            .iter()
            .filter_map(|record| record[field].as_u64())
            .max()
            .unwrap_or(0)
    };
    let peak_active_connections = maximum("peakActiveConnections");
    let peak_queued_bytes = maximum("peakQueuedBytes");
    let rejected_queue_pushes = maximum("rejectedQueuePushes");
    assert!(peak_active_connections >= SURFACE_COUNT as u64);
    assert!(peak_queued_bytes <= 16 * 1024 * 1024);
    assert_eq!(rejected_queue_pushes, 0);
    assert!(process_generation_is_live(&fixture.descriptor.provider_process).unwrap());

    let maximum_elapsed_ms = results
        .iter()
        .map(|(_, _, _, _, elapsed)| elapsed.as_millis())
        .max()
        .unwrap();
    let minimum_later_output_sequence = results
        .iter()
        .map(|(_, _, _, later, _)| *later)
        .min()
        .unwrap();
    eprintln!(
        "{}",
        serde_json::json!({
            "schema": "hmux-sixteen-surface-projection-qa/v1",
            "activeSurfaces": ACTIVE_SURFACE_COUNT,
            "parkedSurfaces": 1,
            "totalSurfaces": SURFACE_COUNT,
            "resizeReceiptsApplied": ACTIVE_SURFACE_COUNT * RESIZES_PER_SURFACE,
            "inputReceiptsWrittenToPty": ACTIVE_SURFACE_COUNT,
            "independentScrollAnchorsAdvanced": ACTIVE_SURFACE_COUNT,
            "minimumLaterOutputSequence": minimum_later_output_sequence.to_string(),
            "peakActiveConnections": peak_active_connections,
            "peakQueuedBytes": peak_queued_bytes,
            "rejectedQueuePushes": rejected_queue_pushes,
            "maximumActiveSurfaceElapsedMs": maximum_elapsed_ms,
        })
    );

    fixture.terminate_and_verify();
    eprintln!(
        "{}",
        serde_json::json!({
            "schema": "hmux-sixteen-surface-cleanup-qa/v1",
            "hostGenerationExited": true,
            "providerGenerationExited": true,
            "remainingOwnedSessions": 0,
        })
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the resize burst smoke"]
fn terminal_surface_resize_burst_fixture_provider() {
    print!("RESIZE_BURST_READY");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    print!("\r\nRESIZE_BURST_STREAMING");
    std::io::stdout().flush().unwrap();
    let output = std::thread::spawn(|| {
        for index in 0..6_000 {
            print!("\r\nRESIZE_BURST_OUTPUT_{index:04}");
            std::io::stdout().flush().unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    line.clear();
    std::io::stdin().read_line(&mut line).unwrap();
    print!(
        "\r\nRESIZE_BURST_ECHO:{}",
        line.trim_end_matches(['\r', '\n'])
    );
    std::io::stdout().flush().unwrap();
    output.join().unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the PTY read/resize ordering smoke"]
fn pty_read_resize_order_fixture_provider() {
    configure_fixture_stdin_raw();
    print!("PTY_READ_RESIZE_READY");
    std::io::stdout().flush().unwrap();
    let mut command = [0_u8; 5];
    std::io::stdin().read_exact(&mut command).unwrap();
    assert_eq!(&command, b"PAINT");
    std::io::stdout()
        .write_all(b"\x1b[?1049h\x1b[2J\x1b[H\x1b[999CX")
        .unwrap();
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the resize failure liveness smoke"]
fn platform_resize_failure_liveness_fixture_provider() {
    print!("RESIZE_FAILURE_READY");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    print!(
        "\r\nOUTPUT_AFTER_RESIZE_FAILURE:{}",
        line.trim_end_matches(['\r', '\n'])
    );
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the sixteen-surface smoke"]
fn sixteen_terminal_surfaces_fixture_provider() {
    use std::io::BufRead;

    print!("SIXTEEN_SURFACES_READY");
    std::io::stdout().flush().unwrap();
    let mut stdin = std::io::stdin().lock();
    let mut line = String::new();
    stdin.read_line(&mut line).unwrap();
    assert_eq!(
        line.trim_end_matches(['\r', '\n']),
        "START_SIXTEEN_SURFACES"
    );
    print!("\r\nSIXTEEN_SURFACES_STREAMING");
    std::io::stdout().flush().unwrap();

    for index in 0..2_500 {
        print!("\r\nSIXTEEN_SURFACES_OUTPUT_{index:04}");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(Duration::from_millis(1));
    }
    print!("\r\nSIXTEEN_SURFACES_DONE");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_rejects_regressive_and_duplicate_resize_generations() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-terminal-surface-stale-resize-generation",
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
    );

    let selector = SessionSelector::new(
        fixture.descriptor.session_id.clone(),
        Some(fixture.descriptor.workspace_id.clone()),
    );
    let session = fixture.catalog.open(&selector).unwrap();
    let mut connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let writer = connection.terminal_input_writer_capability().unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();

    let higher = encode_surface_resize(surface.current_frame(), 20, 100, 30);
    writer.send_input_envelope(&higher).unwrap();
    let applied = wait_for_surface_resize_receipt(&mut surface, 20);
    assert!(matches!(
        applied.outcome,
        Some(resize_receipt::Outcome::AppliedToTerminal(_))
    ));
    assert_eq!(
        fixture
            .session
            .read_screen(None)
            .map(|screen| (screen.rows, screen.columns))
            .unwrap(),
        (30, 100)
    );

    for (generation, columns, rows) in [(19, 60, 12), (20, 120, 40)] {
        let stale = encode_surface_resize(surface.current_frame(), generation, columns, rows);
        writer.send_input_envelope(&stale).unwrap();
        let refused = wait_for_surface_resize_receipt(&mut surface, generation);
        let Some(resize_receipt::Outcome::Refused(refused)) = refused.outcome else {
            panic!("stale resize generation {generation} was not refused");
        };
        assert!(matches!(
            ResizeRefusalReason::try_from(refused.reason),
            Ok(ResizeRefusalReason::StaleGeometryGeneration)
        ));
        assert_eq!(
            fixture
                .session
                .read_screen(None)
                .map(|screen| (screen.rows, screen.columns))
                .unwrap(),
            (30, 100),
            "stale resize generation {generation} changed canonical geometry"
        );
    }

    surface.detach().unwrap();
    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
fn encode_surface_resize(
    frame: &TerminalSurfaceFrame,
    record_id: u64,
    columns: u32,
    rows: u32,
) -> Vec<u8> {
    encode_record_for_minor(
        hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR,
        record_id,
        &TerminalStateRecord {
            schema_minor: u32::from(hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            terminal_epoch: frame.terminal_epoch().to_string(),
            through_output_seq: frame.through_output_seq(),
            state_revision: frame.state_revision(),
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                    columns,
                    rows,
                    geometry_generation: record_id,
                })),
            })),
        },
    )
    .unwrap()
}

#[cfg(feature = "terminal-state-stream")]
fn wait_for_surface_resize_receipt(
    surface: &mut TerminalSurfaceAttachment,
    record_id: u64,
) -> ResizeReceipt {
    loop {
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Resize(receipt))
                if receipt.in_reply_to_record_id == record_id =>
            {
                return receipt;
            }
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!(
                    "unexpected terminal receipt while waiting for resize {record_id}: {receipt:?}"
                )
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("terminal surface ended while waiting for resize {record_id}: {body:?}")
            }
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
fn wait_for_causally_ordered_surface_resize(
    surface: &mut TerminalSurfaceAttachment,
    record_id: u64,
    columns: u32,
    rows: u32,
) -> ResizeReceipt {
    let receipt = loop {
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Resize(receipt))
                if receipt.in_reply_to_record_id == record_id =>
            {
                break receipt;
            }
            TerminalSurfaceEvent::Frame(frame) => assert_ne!(
                (
                    frame.viewport().canonical_columns,
                    frame.viewport().viewport_rows
                ),
                (columns, rows),
                "the resized complete frame crossed its causal receipt"
            ),
            TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!(
                    "unexpected terminal receipt while waiting for resize {record_id}: {receipt:?}"
                )
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("terminal surface ended while waiting for resize {record_id}: {body:?}")
            }
        }
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while (
        surface.current_frame().viewport().canonical_columns,
        surface.current_frame().viewport().viewport_rows,
    ) != (columns, rows)
    {
        assert!(
            Instant::now() < deadline,
            "the causal resize receipt was not followed by its complete frame"
        );
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("an unrelated receipt crossed resized frame {record_id}: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                panic!("terminal surface ended before resized frame {record_id}: {body:?}")
            }
        }
    }
    receipt
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn incomplete_structured_terminal_hellos_are_rejected_before_attach() {
    use hmux_host::local_discovery::DiscoveryManifest;
    use hmux_host::local_protocol::{
        AttachMode, ErrorCode, FrameCodec, FrameLimits, Hello, PROTOCOL_V1,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, SessionFence, VersionRange, WireFrame,
    };
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use std::os::unix::net::UnixStream;

    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-mismatched-structured-attach",
        vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
    );

    let discovery = DiscoveryRoot::open(state.path().join("discovery")).unwrap();
    let discovered = discovery
        .find_manifest_by_session(
            &fixture.descriptor.workspace_id,
            &fixture.descriptor.session_id,
        )
        .unwrap();
    let DiscoveryManifest::Ready(ready) = discovered.manifest else {
        panic!("the mismatch fixture must be ready")
    };
    let fence = SessionFence {
        workspace_id: ready.common.lifetime.workspace_id.clone(),
        session_id: ready.common.lifetime.session_id.clone(),
        runner_principal: ready.common.lifetime.runner_principal.clone(),
        runner_instance: ready.common.lifetime.runner_instance.clone(),
        channel_epoch: ready.common.lifetime.channel_epoch,
        host_instance_id: ready.common.host_instance_id.clone(),
        terminal_epoch: ready.terminal_epoch.clone(),
    };
    let codec = FrameCodec::new(FrameLimits::default());

    for requested_capabilities in [
        vec![TERMINAL_STATE_BINARY_CAPABILITY.to_string()],
        vec![TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string()],
        vec![TERMINAL_INPUT_INTENT_CAPABILITY.to_string()],
        vec![TERMINAL_VIEWPORT_WHEEL_CAPABILITY.to_string()],
        vec![TERMINAL_VIEWPORT_MULTIPART_CAPABILITY.to_string()],
    ] {
        let mut stream = UnixStream::connect(&ready.endpoint.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        codec
            .write_to(
                &mut stream,
                &WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 1,
                    body: FrameBody::Hello(Hello {
                        supported_versions: VersionRange {
                            minimum: PROTOCOL_V1,
                            maximum: PROTOCOL_V1,
                        },
                        requested_capabilities,
                        expected_fence: fence.clone(),
                        requested_mode: AttachMode::Observer,
                        reconnect_cursor: None,
                        capability_token: ready.capability_token.clone(),
                        authorization_proof_reference: None,
                        initial_snapshot_profile: None,
                    }),
                },
            )
            .unwrap();
        let error = match codec.read_from(&mut stream).unwrap().body {
            FrameBody::Error(error) => error,
            body => panic!("an incomplete structured terminal Hello reached attach: {body:?}"),
        };
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
    }

    for requested_capabilities in [
        vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
        ],
        vec![PROVIDER_CONVERSATION_IDENTITY_CAPABILITY.to_string()],
    ] {
        let mut stream = UnixStream::connect(&ready.endpoint.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        codec
            .write_to(
                &mut stream,
                &WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 1,
                    body: FrameBody::Hello(Hello {
                        supported_versions: VersionRange {
                            minimum: PROTOCOL_V1,
                            maximum: PROTOCOL_V1,
                        },
                        requested_capabilities: requested_capabilities.clone(),
                        expected_fence: fence.clone(),
                        requested_mode: AttachMode::Observer,
                        reconnect_cursor: None,
                        capability_token: ready.capability_token.clone(),
                        authorization_proof_reference: None,
                        initial_snapshot_profile: None,
                    }),
                },
            )
            .unwrap();
        let FrameBody::HelloAck(ack) = codec.read_from(&mut stream).unwrap().body else {
            panic!("a complete or independent profile was refused before attach")
        };
        assert_eq!(ack.selected_capabilities, requested_capabilities);
    }

    fixture.terminate_and_verify();
}

#[cfg(feature = "terminal-state-stream")]
fn assert_structured_resize_receipt(
    connection: &mut hmux_client::LocalConnection,
    request_id: &str,
    rows: u16,
    columns: u16,
) {
    loop {
        if let ConnectionRecord::Control(body) = connection.read_record().unwrap() {
            if let FrameBody::ResizeReceipt(receipt) = *body {
                if receipt.request_id == request_id {
                    assert_eq!(receipt.state, ResizeReceiptState::AppliedToTerminal);
                    assert_eq!((receipt.rows, receipt.columns), (Some(rows), Some(columns)));
                    return;
                }
            }
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn host_answers_terminal_queries_without_any_attached_client() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "standalone-host-terminal-query-replies",
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "standalone_terminal_query_fixture_provider".into(),
            "--nocapture".into(),
        ],
    );
    assert!(!fixture.descriptor.capabilities.iter().any(|capability| {
        capability == hmux_runtime_contract::TERMINAL_DEFAULT_COLORS_CAPABILITY
    }));

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = fixture.session.read_screen(None).unwrap();
        if snapshot
            .repaint_bytes
            .windows(b"TERMINAL_QUERY_REPLIES_OK".len())
            .any(|window| window == b"TERMINAL_QUERY_REPLIES_OK")
        {
            break;
        }
        assert!(
            !snapshot
                .repaint_bytes
                .windows(b"TERMINAL_QUERY_REPLIES_MISSING".len())
                .any(|window| window == b"TERMINAL_QUERY_REPLIES_MISSING"),
            "the provider received missing device/cursor replies or unexpected embedder colors"
        );
        assert!(
            Instant::now() < deadline,
            "the no-client provider did not observe terminal query replies"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    fixture.terminate_and_verify();
}

#[test]
#[ignore = "launched as the deterministic PTY provider by the terminal-query smoke"]
fn standalone_terminal_query_fixture_provider() {
    configure_fixture_stdin_raw();

    std::io::stdout()
        .write_all(b"\x1b[2J\x1b[H\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[c\x1b[5n\x1b[6n")
        .unwrap();
    std::io::stdout().flush().unwrap();

    let expected = b"\x1b[?62;22c\x1b[0n\x1b[1;1R";
    let mut actual = Vec::with_capacity(expected.len());
    let deadline = Instant::now() + Duration::from_secs(2);
    while actual.len() < expected.len() && Instant::now() < deadline {
        let remaining_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(i32::MAX as u128) as i32;
        let mut descriptor = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `descriptor` points to one initialized pollfd for the owned
        // fixture PTY, and the call does not outlive that value.
        let ready = unsafe { libc::poll(&mut descriptor, 1, remaining_ms) };
        assert!(ready >= 0, "poll fixture terminal replies");
        if ready == 0 {
            break;
        }
        let mut buffer = [0_u8; 64];
        let count = std::io::stdin().read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        actual.extend_from_slice(&buffer[..count]);
    }

    if actual == expected {
        std::io::stdout()
            .write_all(b"\r\nTERMINAL_QUERY_REPLIES_OK\r\n")
            .unwrap();
    } else {
        std::io::stdout()
            .write_all(b"\r\nTERMINAL_QUERY_REPLIES_MISSING\r\n")
            .unwrap();
    }
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
#[ignore = "launched as the deterministic PTY provider by the structured-input smoke"]
fn standalone_structured_input_encoding_fixture_provider() {
    configure_fixture_stdin_raw();
    std::io::stdout()
        .write_all(b"\x1b[?1h\x1b[?2004hSTRUCTURED_INPUT_ENCODER_READY\r\n")
        .unwrap();
    std::io::stdout().flush().unwrap();

    let expected = b"\x1bOA\x1b[200~first\nsecond\x1b[201~";
    let mut actual = Vec::with_capacity(expected.len());
    let deadline = Instant::now() + Duration::from_secs(2);
    while actual.len() < expected.len() && Instant::now() < deadline {
        let remaining_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(i32::MAX as u128) as i32;
        let mut descriptor = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: descriptor names this fixture's owned PTY for this call.
        let ready = unsafe { libc::poll(&mut descriptor, 1, remaining_ms) };
        assert!(ready >= 0, "poll structured input bytes");
        if ready == 0 {
            break;
        }
        let mut buffer = [0_u8; 128];
        let count = std::io::stdin().read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        actual.extend_from_slice(&buffer[..count]);
    }

    let marker = if actual == expected {
        b"\r\nSTRUCTURED_INPUT_ENCODER_OK\r\n".as_slice()
    } else {
        b"\r\nSTRUCTURED_INPUT_ENCODER_MISSING\r\n".as_slice()
    };
    std::io::stdout().write_all(marker).unwrap();
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the structured OSC 52 smoke"]
fn standalone_structured_osc52_fixture_provider() {
    use std::io::BufRead;

    println!("STRUCTURED_OSC52_READY");
    std::io::stdout().flush().unwrap();
    let mut trigger = String::new();
    std::io::stdin().lock().read_line(&mut trigger).unwrap();
    assert_eq!(trigger, "copy\n");

    let mut output = std::io::stdout().lock();
    output
        .write_all(b"\x1b]52;c;aHR0cHM6Ly9jbGF1ZGUuYWk=")
        .unwrap();
    output.flush().unwrap();
    std::thread::sleep(Duration::from_millis(10));
    output.write_all(b"\x1b\\").unwrap();
    output.flush().unwrap();
    std::thread::sleep(Duration::from_secs(1));
}

#[test]
#[ignore = "launched as the deterministic PTY provider by the structured-pointer smoke"]
fn standalone_structured_pointer_encoding_fixture_provider() {
    configure_fixture_stdin_raw();
    std::io::stdout()
        .write_all(b"\x1b[?1000h\x1b[?1006hSTRUCTURED_POINTER_ENCODER_READY\r\n")
        .unwrap();
    std::io::stdout().flush().unwrap();

    let expected = b"\x1b[<0;5;3M";
    let mut actual = Vec::with_capacity(expected.len());
    let deadline = Instant::now() + Duration::from_secs(2);
    while actual.len() < expected.len() && Instant::now() < deadline {
        let remaining_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(i32::MAX as u128) as i32;
        let mut descriptor = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: descriptor names this fixture's owned PTY for this call.
        let ready = unsafe { libc::poll(&mut descriptor, 1, remaining_ms) };
        assert!(ready >= 0, "poll structured pointer bytes");
        if ready == 0 {
            break;
        }
        let mut buffer = [0_u8; 64];
        let count = std::io::stdin().read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        actual.extend_from_slice(&buffer[..count]);
    }

    let marker = if actual == expected {
        b"\r\nSTRUCTURED_POINTER_ENCODER_OK\r\n".as_slice()
    } else {
        b"\r\nSTRUCTURED_POINTER_ENCODER_MISSING\r\n".as_slice()
    };
    std::io::stdout().write_all(marker).unwrap();
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

fn configure_fixture_stdin_raw() {
    let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
    // SAFETY: STDIN is the fixture's owned PTY slave and termios is writable.
    assert_eq!(
        unsafe { libc::tcgetattr(libc::STDIN_FILENO, termios.as_mut_ptr()) },
        0
    );
    // SAFETY: tcgetattr initialized the value after returning success.
    let mut termios = unsafe { termios.assume_init() };
    // SAFETY: cfmakeraw mutates only this initialized local termios value.
    unsafe { libc::cfmakeraw(&mut termios) };
    // SAFETY: STDIN is the live fixture PTY for the synchronous call.
    assert_eq!(
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &termios) },
        0
    );
}

#[test]
#[ignore = "launched as the deterministic PTY provider by the resize smoke"]
fn standalone_resize_fixture_provider() {
    RESIZE_SIGNAL_RECEIVED.store(false, Ordering::Release);
    let previous = unsafe {
        libc::signal(
            libc::SIGWINCH,
            record_resize_signal as *const () as libc::sighandler_t,
        )
    };
    assert_ne!(previous, libc::SIG_ERR);
    println!("READY");
    std::io::stdout().flush().unwrap();

    loop {
        if !RESIZE_SIGNAL_RECEIVED.swap(false, Ordering::AcqRel) {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let mut size = libc::winsize {
            ws_row: 0,
            ws_col: 0,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe { libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut size) };
        assert_eq!(result, 0, "read deterministic fixture PTY geometry");
        println!("WINCH:{} {}", size.ws_row, size.ws_col);
        std::io::stdout().flush().unwrap();
    }
}

#[test]
fn opted_in_idle_shell_retires_only_after_graceful_last_client_departure() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create_idle_shell(&state, "idle-retirement-last");
    let mut connection = fixture.connect_for_retirement();

    let receipt = connection.depart_gracefully().unwrap();

    assert_eq!(
        (receipt.state, receipt.reason),
        (SessionRetirementReceiptState::RetirementArmed, None)
    );
    assert_eq!(receipt.policy, Some(idle_retirement_policy()));
    drop(connection);
    fixture.wait_for_retirement();
}

#[test]
fn launch_owner_can_abandon_an_idle_creation_before_any_other_attach() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("unpresented-create-abandon".into()),
                vec!["/bin/sh".into()],
                24,
                80,
            )
            .unwrap()
            .with_retirement_policy(idle_retirement_policy())
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();

    // Launch-owner authority is intentionally one-shot: the first handshake
    // consumes its proof and attachment generation. Retrying this operation
    // would test an impossible contract rather than transient observation.
    let receipt = created.abandon_unpresented_creation().unwrap();

    assert_eq!(
        (receipt.state, receipt.reason),
        (SessionRetirementReceiptState::RetirementArmed, None)
    );
    assert!(wait_for_process_generation_exit_with_timeout(
        &descriptor.provider_process,
        Duration::from_secs(7),
    ));
    assert!(wait_for_process_generation_exit_with_timeout(
        &descriptor.host_process,
        Duration::from_secs(8),
    ));
}

#[test]
fn unpresented_creation_abandon_preserves_after_any_attach_history() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("unpresented-create-raced".into()),
                vec!["/bin/sh".into()],
                24,
                80,
            )
            .unwrap()
            .with_retirement_policy(idle_retirement_policy())
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let external = created
        .session()
        .connect(LocalAttachRole::Observer, None)
        .unwrap();
    external.shutdown();
    drop(external);

    let receipt = created.abandon_unpresented_creation().unwrap();

    assert_eq!(
        (receipt.state, receipt.reason),
        (
            SessionRetirementReceiptState::SessionPreserved,
            Some(SessionRetirementReceiptReason::OtherClientsAttached),
        )
    );
    assert_eq!(
        probe_local_session_exact(&catalog, &descriptor),
        SessionProbeStatus::Healthy
    );
    created
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn transparent_env_launcher_uses_the_execed_shell_as_idle_provider_identity() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "idle-retirement-env-launcher",
        vec![
            "/usr/bin/env".into(),
            "HMUX_TEST_WRAPPER=1".into(),
            "/bin/sh".into(),
        ],
    );
    let mut connection = fixture.connect_for_retirement();

    let receipt = connection.depart_gracefully().unwrap();

    assert_eq!(
        (receipt.state, receipt.reason),
        (SessionRetirementReceiptState::RetirementArmed, None)
    );
    drop(connection);
    fixture.wait_for_retirement();
}

#[test]
fn failed_initial_recipe_publication_rolls_back_the_exact_launched_session() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, sync_fault_marker) = recipe_sync_fault_runtime(&state);
    fs::write(&sync_fault_marker, b"2").unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    let error = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("recipe-publication-rollback".into()),
                vec!["/bin/sh".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap_err();

    assert_eq!(error.code(), "hmux_standalone_create_refused");
    assert!(
        LocalSessionCatalog::new(&discovery_root)
            .list()
            .unwrap()
            .is_empty(),
        "a refused create left a discoverable standalone Host: {error}"
    );
    assert!(
        !resurrection_recipe_path(&discovery_root, "recipe-publication-rollback").exists(),
        "a refused create left a reboot resurrection recipe: {error}"
    );
}

#[test]
fn retirement_admin_cannot_be_excluded_from_attachment_census_as_a_shared_writer() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture =
        IdleRetirementFixture::create_idle_shell(&state, "retirement-admin-shared-writer");
    let error = fixture
        .session
        .connect_with_options(
            ConnectionOptions::new(LocalAttachRole::SharedWriter, None).with_optional_capabilities(
                &[
                    SESSION_RETIREMENT_CAPABILITY,
                    SESSION_RETIREMENT_ADMIN_CAPABILITY,
                ],
            ),
        )
        .unwrap_err();

    assert!(matches!(
        error,
        hmux_client::ClientError::HostRefused {
            code: HostErrorCode::UnsupportedCapability,
            ..
        }
    ));
    let preview =
        retry_transient_retirement_observation(|| fixture.session.preview_retirement_sweep());
    assert_eq!(preview.state, SessionRetirementReceiptState::Eligible);
    fixture.assert_preserved();
    fixture.terminate_and_verify();
}

#[test]
fn failed_policy_update_rolls_back_the_reboot_recipe_and_a_retry_converges() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, sync_fault_marker) = recipe_sync_fault_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime_and_policy(
        &state,
        "retirement-policy-transaction",
        vec!["/bin/sh".into()],
        &runtime,
        None,
    );
    fs::write(&sync_fault_marker, b"2").unwrap();

    let refused = fixture
        .session
        .configure_retirement_policy(Some(idle_retirement_policy()))
        .unwrap();

    assert_eq!(
        (refused.state, refused.reason, refused.policy),
        (
            SessionRetirementReceiptState::Refused,
            Some(SessionRetirementReceiptReason::PersistenceUnavailable),
            None,
        )
    );
    let after_refusal = fixture
        .catalog
        .find(&SessionSelector::new(
            &fixture.descriptor.session_id,
            Some(fixture.descriptor.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(after_refusal.retirement_policy, None);
    let reboot_recipe = read_only_resurrection_recipe(
        fixture.catalog.discovery_root(),
        "retirement-policy-transaction",
    );
    assert_eq!(
        reboot_recipe.retirement_policy(),
        None,
        "a failure receipt must not leave reboot recovery opted in"
    );
    assert_eq!(
        request_from_recipe(&reboot_recipe).retirement_policy(),
        None,
        "the reboot loader must reconstruct the refused previous policy"
    );

    let retried = fixture
        .session
        .configure_retirement_policy(Some(idle_retirement_policy()))
        .unwrap();
    assert_eq!(
        (retried.state, retried.reason, retried.policy),
        (
            SessionRetirementReceiptState::PolicyUpdated,
            None,
            Some(idle_retirement_policy()),
        )
    );
    let after_retry = fixture
        .catalog
        .find(&SessionSelector::new(
            &fixture.descriptor.session_id,
            Some(fixture.descriptor.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(
        after_retry.retirement_policy,
        Some(idle_retirement_policy())
    );
    let recovered_recipe = read_only_resurrection_recipe(
        fixture.catalog.discovery_root(),
        "retirement-policy-transaction",
    );
    assert_eq!(
        recovered_recipe.retirement_policy(),
        Some(idle_retirement_policy())
    );
    fixture.terminate_and_verify();
}

#[test]
fn policy_update_crash_before_receipt_recovers_the_published_recipe_policy() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, recipe_published_marker) = retirement_policy_recipe_publish_pause_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime_and_policy(
        &state,
        "retirement-policy-pre-receipt-crash",
        vec!["/bin/sh".into()],
        &runtime,
        None,
    );
    let session = fixture.session.clone();
    let update = std::thread::spawn(move || {
        session.configure_retirement_policy(Some(idle_retirement_policy()))
    });

    wait_for_exact_file(&recipe_published_marker, b"recipe_published");
    let published = read_only_resurrection_recipe(
        fixture.catalog.discovery_root(),
        "retirement-policy-pre-receipt-crash",
    );
    assert_eq!(
        published.retirement_policy(),
        Some(idle_retirement_policy()),
        "the canonical reboot authority must be next before Ready changes"
    );
    let ready = fixture
        .catalog
        .find(&SessionSelector::new(
            &fixture.descriptor.session_id,
            Some(fixture.descriptor.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(
        ready.retirement_policy, None,
        "the fault boundary must remain between recipe and Ready publication"
    );

    abruptly_kill_test_session(&fixture.descriptor);
    assert!(
        update.join().unwrap().is_err(),
        "a Host crash before the receipt must leave the client outcome uncertain"
    );
    fixture.cleaned = true;

    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(fixture.catalog.discovery_root());
    let restored = creator.create(request_from_recipe(&published)).unwrap();
    assert_eq!(
        restored.session().descriptor().retirement_policy,
        Some(idle_retirement_policy()),
        "reboot recovery must republish Ready from the canonical recipe authority"
    );
    assert_no_pending_resurrection_recipe(fixture.catalog.discovery_root());
    restored
        .session()
        .terminate_standalone(&fixture.catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn policy_update_crash_after_receipt_recovers_the_acknowledged_policy() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create_with_runtime_and_policy(
        &state,
        "retirement-policy-post-receipt-crash",
        vec!["/bin/sh".into()],
        std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime")),
        None,
    );
    let receipt = fixture
        .session
        .configure_retirement_policy(Some(idle_retirement_policy()))
        .unwrap();
    assert_eq!(
        (receipt.state, receipt.policy),
        (
            SessionRetirementReceiptState::PolicyUpdated,
            Some(idle_retirement_policy()),
        )
    );

    abruptly_kill_test_session(&fixture.descriptor);
    fixture.cleaned = true;
    let acknowledged = read_only_resurrection_recipe(
        fixture.catalog.discovery_root(),
        "retirement-policy-post-receipt-crash",
    );
    assert_eq!(
        acknowledged.retirement_policy(),
        Some(idle_retirement_policy())
    );
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(fixture.catalog.discovery_root());
    let restored = creator.create(request_from_recipe(&acknowledged)).unwrap();
    assert_eq!(
        restored.session().descriptor().retirement_policy,
        Some(idle_retirement_policy())
    );
    assert_no_pending_resurrection_recipe(fixture.catalog.discovery_root());
    restored
        .session()
        .terminate_standalone(&fixture.catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn receipt_unsafe_policy_update_closes_transport_and_retry_converges() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, sync_fault_marker) = recipe_sync_fault_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime_and_policy(
        &state,
        "retirement-policy-receipt-unsafe",
        vec!["/bin/sh".into()],
        &runtime,
        None,
    );
    fs::write(&sync_fault_marker, b"6").unwrap();

    let uncertain = fixture
        .session
        .configure_retirement_policy(Some(idle_retirement_policy()));
    assert!(
        uncertain.is_err(),
        "an unprovable cross-file outcome must not return a refusal receipt"
    );
    let current = fixture
        .catalog
        .find(&SessionSelector::new(
            &fixture.descriptor.session_id,
            Some(fixture.descriptor.workspace_id.clone()),
        ))
        .unwrap();
    assert!(current.same_generation(&fixture.descriptor));
    assert!(process_generation_is_live(&fixture.descriptor.host_process).unwrap());
    assert!(process_generation_is_live(&fixture.descriptor.provider_process).unwrap());

    fs::write(&sync_fault_marker, b"0").unwrap();
    let retried = fixture
        .session
        .configure_retirement_policy(Some(idle_retirement_policy()))
        .unwrap();
    assert_eq!(
        (retried.state, retried.reason, retried.policy),
        (
            SessionRetirementReceiptState::PolicyUpdated,
            None,
            Some(idle_retirement_policy()),
        )
    );
    let durable = read_only_resurrection_recipe(
        fixture.catalog.discovery_root(),
        "retirement-policy-receipt-unsafe",
    );
    assert_eq!(durable.retirement_policy(), Some(idle_retirement_policy()));
    fixture.terminate_and_verify();
}

#[test]
fn transient_final_recipe_read_failure_does_not_split_durable_and_live_policy() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, read_fault_marker) = recipe_read_fault_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime_and_policy(
        &state,
        "retirement-policy-final-read",
        vec!["/bin/sh".into()],
        &runtime,
        None,
    );
    fs::write(&read_fault_marker, b"3").unwrap();

    let receipt = fixture
        .session
        .configure_retirement_policy(Some(idle_retirement_policy()))
        .unwrap();

    assert_eq!(
        (receipt.state, receipt.reason, receipt.policy),
        (
            SessionRetirementReceiptState::PolicyUpdated,
            None,
            Some(idle_retirement_policy()),
        )
    );
    let projected = fixture
        .catalog
        .find(&SessionSelector::new(
            &fixture.descriptor.session_id,
            Some(fixture.descriptor.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(projected.retirement_policy, Some(idle_retirement_policy()));
    assert_eq!(
        read_only_resurrection_recipe(
            fixture.catalog.discovery_root(),
            "retirement-policy-final-read",
        )
        .retirement_policy(),
        Some(idle_retirement_policy())
    );
    fixture.terminate_and_verify();
}

#[test]
fn guardian_resumes_the_exact_frozen_provider_when_the_host_group_is_killed() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, frozen_marker) = idle_retirement_freeze_hook_runtime(&state);
    let continued_marker = state.path().join("provider-continued");
    let provider_command = vec![
        "/bin/sh".into(),
        "-c".into(),
        "trap '' HUP TERM; \
         trap 'printf continued > \"$1\"' CONT; \
         while :; do :; done"
            .into(),
        "idle-retirement-provider".into(),
        continued_marker.to_string_lossy().into_owned(),
    ];
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "idle-retirement-guardian-host-crash",
        provider_command,
        &runtime,
    );
    let descriptor = fixture.descriptor.clone();
    let host_group = exact_owned_process_group(&descriptor.host_process, "Host");
    let provider_group = exact_owned_process_group(&descriptor.provider_process, "provider");
    let mut connection = fixture.connect_for_retirement();

    let receipt = connection.depart_gracefully().unwrap();
    assert_eq!(
        (receipt.state, receipt.reason),
        (SessionRetirementReceiptState::RetirementArmed, None)
    );
    drop(connection);

    let guardian_pid = wait_for_pid_file(&frozen_marker);
    assert!(
        process_generation_is_live(&descriptor.provider_process).unwrap(),
        "provider generation disappeared before Host fault injection"
    );
    assert!(
        process_is_stopped(descriptor.provider_process.process_id),
        "freeze marker was published before the exact provider group stopped"
    );
    let guardian_group = process_group(guardian_pid);
    let guardian_session = process_session(guardian_pid);
    assert_eq!(
        guardian_group,
        libc::pid_t::try_from(guardian_pid).unwrap(),
        "guardian did not lead its independent process group"
    );
    assert_eq!(
        guardian_session,
        libc::pid_t::try_from(guardian_pid).unwrap(),
        "guardian did not lead its independent POSIX session"
    );
    assert_ne!(
        guardian_group, host_group,
        "guardian still shared the Host process group"
    );
    assert_ne!(
        guardian_group, provider_group,
        "guardian unexpectedly shared the provider process group"
    );
    assert_ne!(
        guardian_session,
        process_session(descriptor.host_process.process_id),
        "guardian still shared the Host POSIX session"
    );
    assert_ne!(
        guardian_session,
        process_session(descriptor.provider_process.process_id),
        "guardian unexpectedly shared the provider POSIX session"
    );

    signal_exact_test_group(&descriptor.host_process, host_group, "Host");
    wait_for_process_generation_exit(&descriptor.host_process, "Host");

    let resume_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let provider_live =
            process_generation_is_live(&descriptor.provider_process).unwrap_or(false);
        if provider_live
            && continued_marker.is_file()
            && !process_is_stopped(descriptor.provider_process.process_id)
        {
            break;
        }
        assert!(
            Instant::now() < resume_deadline,
            "guardian did not SIGCONT the exact provider group after Host loss"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        process_group(descriptor.provider_process.process_id),
        provider_group,
        "resumed provider process-group identity changed"
    );

    signal_exact_test_group(&descriptor.provider_process, provider_group, "provider");
    wait_for_process_generation_exit(&descriptor.provider_process, "provider");
    fixture.cleaned = true;
}

#[test]
fn guardian_exit_before_readiness_preserves_an_unfrozen_provider() {
    assert_guardian_readiness_fault_preserves("exit");
}

#[test]
fn guardian_readiness_timeout_preserves_an_unfrozen_provider() {
    assert_guardian_readiness_fault_preserves("timeout");
}

fn assert_guardian_readiness_fault_preserves(fault: &str) {
    let state = tempfile::tempdir().unwrap();
    let (runtime, observed_marker) = guardian_readiness_fault_runtime(&state, fault);
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        &format!("idle-retirement-guardian-{fault}"),
        vec!["/bin/sh".into()],
        &runtime,
    );
    let mut connection = fixture.connect_for_retirement();

    let receipt = connection.depart_gracefully().unwrap();
    assert_eq!(
        (receipt.state, receipt.reason),
        (SessionRetirementReceiptState::RetirementArmed, None)
    );
    drop(connection);

    wait_for_exact_file(&observed_marker, fault.as_bytes());
    assert!(
        !process_is_stopped(fixture.descriptor.provider_process.process_id),
        "provider was frozen before guardian readiness"
    );
    std::thread::sleep(Duration::from_millis(2_500));
    fixture.assert_preserved();
    assert!(
        !process_is_stopped(fixture.descriptor.provider_process.process_id),
        "provider remained frozen after guardian readiness failure"
    );
    fixture.terminate_and_verify();
}

#[test]
fn graceful_departure_preserves_until_the_last_of_two_attachments_leaves() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create_idle_shell(&state, "idle-retirement-shared");
    let mut first = fixture.connect_for_retirement();
    let mut last = fixture.connect_for_retirement();

    let first_receipt = first.depart_gracefully().unwrap();
    assert_eq!(
        first_receipt.state,
        SessionRetirementReceiptState::SessionPreserved
    );
    assert_eq!(
        first_receipt.reason,
        Some(SessionRetirementReceiptReason::OtherClientsAttached)
    );
    // The receipt is the linearized preservation proof. A health probe here
    // would itself attach an observer; under scheduler pressure its transport
    // cleanup can still be in the attachment census when `last` departs.

    let last_receipt = last.depart_gracefully().unwrap();
    assert_eq!(
        last_receipt.state,
        SessionRetirementReceiptState::RetirementArmed
    );
    assert_eq!(last_receipt.reason, None);
    drop(first);
    drop(last);
    fixture.wait_for_retirement();
}

#[test]
fn graceful_departure_arms_the_policy_updated_before_its_transition() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, paused_marker, release_marker) =
        retirement_departure_before_transition_pause_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime_and_policy(
        &state,
        "idle-retirement-policy-transition",
        vec!["/bin/sh".into()],
        &runtime,
        Some(idle_retirement_policy()),
    );
    let mut connection = fixture.connect_for_retirement();
    let departure = std::thread::spawn(move || connection.depart_gracefully());

    wait_for_exact_file(&paused_marker, b"before_transition");
    let updated_policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: 5_000,
    };
    let update = fixture
        .session
        .configure_retirement_policy(Some(updated_policy))
        .unwrap();
    assert_eq!(update.policy, Some(updated_policy));
    fixture.descriptor.retirement_policy = Some(updated_policy);
    fs::write(&release_marker, b"release").unwrap();

    let departure = departure.join().unwrap().unwrap();
    assert_eq!(
        (departure.state, departure.reason, departure.policy,),
        (
            SessionRetirementReceiptState::RetirementArmed,
            None,
            Some(updated_policy),
        ),
        "the departure receipt and timer must use the policy serialized before them"
    );
    std::thread::sleep(Duration::from_millis(IDLE_RETIREMENT_GRACE_MS + 250));
    fixture.assert_preserved();
    fixture.terminate_and_verify();
}

#[test]
fn graceful_last_departure_preserves_a_shell_with_a_background_child() {
    let state = tempfile::tempdir().unwrap();
    let descendant_pid_path = state.path().join("retirement-descendant.pid");
    let command = format!(
        "set -m; (trap \"\" HUP TERM; sleep 30) & echo $! > '{}'; \
         trap \"\" HUP TERM; wait",
        descendant_pid_path.display()
    );
    let mut fixture = IdleRetirementFixture::create(
        &state,
        "idle-retirement-background",
        vec!["/bin/sh".into(), "-c".into(), command],
    );
    let descendant_pid = wait_for_pid_file(&descendant_pid_path);
    fixture.track_process_group(descendant_pid);
    wait_for_process_session_member(
        fixture.descriptor.provider_process.process_id,
        descendant_pid,
    );
    let mut connection = fixture.connect_for_retirement();

    let receipt = connection.depart_gracefully().unwrap();

    match receipt.state {
        SessionRetirementReceiptState::SessionPreserved => {
            assert_eq!(
                receipt.reason,
                Some(SessionRetirementReceiptReason::ProviderBusy)
            );
        }
        SessionRetirementReceiptState::RetirementArmed => {
            assert_eq!(receipt.reason, None);
        }
        state => panic!("background child returned unexpected retirement state {state:?}"),
    }
    drop(connection);
    std::thread::sleep(Duration::from_millis(IDLE_RETIREMENT_GRACE_MS + 250));
    fixture.assert_preserved();
    assert!(process_exists(descendant_pid));
    fixture.terminate_and_verify();
}

#[test]
fn legacy_detach_and_transport_eof_never_arm_idle_retirement() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create_idle_shell(&state, "idle-retirement-eof");
    let observer = LocalSessionObserver::connect(
        &fixture.catalog,
        &SessionSelector::new(
            &fixture.descriptor.session_id,
            Some(fixture.descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    observer.detach().unwrap();

    let connection = fixture
        .session
        .connect(LocalAttachRole::Observer, None)
        .unwrap();
    connection.shutdown();
    drop(connection);

    std::thread::sleep(Duration::from_millis(IDLE_RETIREMENT_GRACE_MS + 250));
    fixture.assert_preserved();
    fixture.terminate_and_verify();
}

#[test]
fn reattach_during_grace_cancels_armed_idle_retirement() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create_idle_shell(&state, "idle-retirement-reattach");
    let mut departing = fixture.connect_for_retirement();

    let receipt = departing.depart_gracefully().unwrap();
    assert_eq!(
        receipt.state,
        SessionRetirementReceiptState::RetirementArmed
    );
    drop(departing);
    let replacement = fixture.connect_for_retirement();

    std::thread::sleep(Duration::from_millis(IDLE_RETIREMENT_GRACE_MS + 250));
    fixture.assert_preserved();
    replacement.shutdown();
    drop(replacement);
    fixture.terminate_and_verify();
}

#[test]
fn dry_run_during_grace_does_not_cancel_armed_idle_retirement() {
    let state = tempfile::tempdir().unwrap();
    let mut fixture = IdleRetirementFixture::create_idle_shell(&state, "idle-retirement-dry-run");
    let mut departing = fixture.connect_for_retirement();

    let departure = departing.depart_gracefully().unwrap();
    assert_eq!(
        departure.state,
        SessionRetirementReceiptState::RetirementArmed
    );
    drop(departing);

    let preview =
        retry_transient_retirement_observation(|| fixture.session.preview_retirement_sweep());
    assert_eq!(preview.state, SessionRetirementReceiptState::Eligible);
    assert_eq!(preview.reason, None);
    fixture.wait_for_retirement();
}

#[test]
fn runtime_persists_redacted_structured_lifecycle_diagnostics() {
    use std::os::unix::fs::PermissionsExt;

    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("runtime-diagnostics-smoke".into()),
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            session.descriptor().session_id.clone(),
            Some(session.descriptor().workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    drop(observer);
    session
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();

    let directory = discovery_root.join(".diagnostics/runtime-v1");
    let file = fs::read_dir(&directory)
        .unwrap()
        .find(|entry| {
            entry
                .as_ref()
                .is_ok_and(|entry| entry.file_name() == "runtime.jsonl")
        })
        .unwrap()
        .unwrap()
        .path();
    let raw = fs::read_to_string(&file).unwrap();
    let records = raw
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let events = records
        .iter()
        .filter_map(|record| record["event"].as_str())
        .collect::<Vec<_>>();

    assert!(events.contains(&"host_ready"));
    assert!(events.contains(&"attach_ready"));
    assert!(events.contains(&"provider_exit"));
    assert!(records.iter().all(|record| {
        record["schemaVersion"] == 1
            && record["buildInfo"]["buildId"] == env!("HMUX_BUILD_ID")
            && record["buildInfo"]["source"] == "hmux_runtime"
            && record["session"]["workspaceId"] == session.descriptor().workspace_id
            && record["session"]["sessionId"] == session.descriptor().session_id
    }));
    assert!(!raw.contains("capabilityToken"));
    assert!(!raw.contains("launchOwnerProof"));
    assert!(!raw.contains("/bin/sleep"));
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn old_style_restore_uses_canonical_policy_across_spawn_failure_and_retry() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, spawn_fault_marker) = host_spawn_before_start_fault_runtime(&state);
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(&runtime).with_discovery_root(&discovery_root);
    let terminal_environment = TerminalEnvironment::new(BTreeMap::from([(
        "NO_COLOR".to_string(),
        Some("1".to_string()),
    )]))
    .unwrap();
    let source = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("old-style-stale-policy".into()),
                vec!["/bin/sh".into()],
                24,
                80,
            )
            .unwrap()
            .with_terminal_environment(terminal_environment.clone())
            .unwrap()
            .with_resurrection_replay_policy(
                StandaloneResurrectionReplayPolicy::SafeInteractiveShell,
            )
            .unwrap()
            .with_retirement_policy(idle_retirement_policy())
            .unwrap(),
        )
        .unwrap();
    let source_generation = source.session().descriptor().clone();
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let canonical = read_only_resurrection_recipe(&discovery_root, "old-style-stale-policy");
    assert_eq!(
        canonical.retirement_policy(),
        Some(idle_retirement_policy())
    );
    assert_eq!(canonical.terminal_environment(), &terminal_environment);
    assert_eq!(
        canonical.resurrection_replay_policy(),
        StandaloneResurrectionReplayPolicy::SafeInteractiveShell
    );
    abruptly_kill_test_session(&source_generation);
    fs::write(&spawn_fault_marker, b"fail").unwrap();
    let old_style_request = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("old-style-stale-policy".into()),
        vec!["/bin/sh".into()],
        24,
        80,
    )
    .unwrap();
    let refused = creator.create(old_style_request.clone()).unwrap_err();

    assert_eq!(refused.code(), "hmux_standalone_create_refused");
    assert_eq!(
        fs::read(&spawn_fault_marker).unwrap(),
        b"observed",
        "a compatibility request with an omitted policy must reach the exact Host spawn boundary"
    );
    assert_eq!(
        read_only_resurrection_recipe(&discovery_root, "old-style-stale-policy"),
        canonical,
        "a failed compatibility restore must not downgrade canonical recovery state"
    );

    fs::remove_file(&spawn_fault_marker).unwrap();
    let restored = creator.create(old_style_request).unwrap();
    assert_eq!(
        restored.session().descriptor().retirement_policy,
        Some(idle_retirement_policy()),
        "the Host must launch from the canonical recipe, not the omitted client hint"
    );
    restored
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn old_style_same_name_mismatch_refuses_before_spawn_and_preserves_recipe() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, spawn_fault_marker) = host_spawn_before_start_fault_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "old-style-recipe-conflict",
        vec!["/bin/sh".into()],
        &runtime,
    );
    let canonical = read_only_resurrection_recipe(
        fixture.catalog.discovery_root(),
        "old-style-recipe-conflict",
    );
    abruptly_kill_test_session(&fixture.descriptor);
    fixture.cleaned = true;
    fs::write(&spawn_fault_marker, b"fail").unwrap();
    let creator = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(fixture.catalog.discovery_root());
    let mismatched = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("old-style-recipe-conflict".into()),
        vec!["/bin/sh".into(), "-c".into(), "exit 0".into()],
        canonical.initial_rows(),
        canonical.initial_columns(),
    )
    .unwrap();

    let refused = creator.create(mismatched).unwrap_err();

    assert_eq!(refused.code(), "hmux_standalone_recipe_conflict");
    assert_eq!(
        fs::read(&spawn_fault_marker).unwrap(),
        b"fail",
        "a mismatched same-name request must be refused before Host spawn"
    );
    assert_eq!(
        read_only_resurrection_recipe(
            fixture.catalog.discovery_root(),
            "old-style-recipe-conflict",
        ),
        canonical
    );
}

#[test]
fn recovery_spawn_failure_preserves_the_canonical_recipe_and_retry_succeeds() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, spawn_fault_marker) = host_spawn_before_start_fault_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "recovery-spawn-failure",
        vec!["/bin/sh".into()],
        &runtime,
    );
    let canonical =
        read_only_resurrection_recipe(fixture.catalog.discovery_root(), "recovery-spawn-failure");
    let request = request_from_recipe(&canonical)
        .with_recovery_identity(recovery_identity_for_source(
            &fixture.descriptor,
            "standalone_recovery_spawn01",
            "recovery-spawn-owner-proof",
        ))
        .unwrap();
    abruptly_kill_test_session(&fixture.descriptor);
    fixture.cleaned = true;
    fs::write(&spawn_fault_marker, b"fail").unwrap();
    let creator = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(fixture.catalog.discovery_root());

    let refused = creator.create(request.clone()).unwrap_err();

    assert_eq!(
        refused.code(),
        "hmux_standalone_recovery_target_unavailable"
    );
    assert_eq!(fs::read(&spawn_fault_marker).unwrap(), b"observed");
    assert_eq!(
        read_only_resurrection_recipe(fixture.catalog.discovery_root(), "recovery-spawn-failure",),
        canonical
    );

    fs::remove_file(&spawn_fault_marker).unwrap();
    let restored = creator.create(request).unwrap();
    assert_eq!(
        restored.session().descriptor().session_id,
        "standalone_recovery_spawn01"
    );
    restored
        .session()
        .terminate_standalone(&fixture.catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn old_style_same_name_spawn_failure_preserves_the_prior_exact_recipe() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, spawn_fault_marker) = host_spawn_before_start_fault_runtime(&state);
    let mut fixture = IdleRetirementFixture::create_with_runtime(
        &state,
        "old-style-spawn-failure",
        vec!["/bin/sh".into()],
        &runtime,
    );
    let canonical =
        read_only_resurrection_recipe(fixture.catalog.discovery_root(), "old-style-spawn-failure");
    abruptly_kill_test_session(&fixture.descriptor);
    fixture.cleaned = true;
    fs::write(&spawn_fault_marker, b"fail").unwrap();
    let creator = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(fixture.catalog.discovery_root());

    let refused = creator.create(request_from_recipe(&canonical)).unwrap_err();

    assert_eq!(refused.code(), "hmux_standalone_create_refused");
    assert_eq!(fs::read(&spawn_fault_marker).unwrap(), b"observed");
    assert_eq!(
        read_only_resurrection_recipe(fixture.catalog.discovery_root(), "old-style-spawn-failure",),
        canonical,
        "a definite pre-Ready failure must not delete or rewrite prior recovery authority"
    );

    fs::remove_file(&spawn_fault_marker).unwrap();
    let restored = creator.create(request_from_recipe(&canonical)).unwrap();
    restored
        .session()
        .terminate_standalone(&fixture.catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn ready_probe_read_error_retries_and_reconciles_the_exact_host() {
    let state = tempfile::tempdir().unwrap();
    let (runtime, ready_fault_marker) = ready_probe_after_match_fault_runtime(&state);
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("ready-probe-retry".into()),
                vec!["/bin/sh".into()],
                24,
                80,
            )
            .unwrap()
            .with_retirement_policy(idle_retirement_policy())
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    let catalog = LocalSessionCatalog::new(&discovery_root);

    assert_eq!(fs::read(&ready_fault_marker).unwrap(), b"faulted");
    assert_eq!(
        probe_local_session_exact(&catalog, &descriptor),
        SessionProbeStatus::Healthy
    );
    let matching = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|candidate| {
            candidate.lifecycle == SessionLifecycle::Ready
                && candidate.session_name.as_deref() == Some("ready-probe-retry")
        })
        .collect::<Vec<_>>();
    assert_eq!(matching.len(), 1);
    assert!(matching[0].same_generation(&descriptor));
    assert_eq!(
        read_only_resurrection_recipe(&discovery_root, "ready-probe-retry").retirement_policy(),
        Some(idle_retirement_policy())
    );

    created
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn recovery_without_a_canonical_recipe_fails_closed() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("missing-recovery-recipe".into()),
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
        24,
        80,
    )
    .unwrap()
    .with_recovery_identity(
        StandaloneRecoveryCreateIdentity::new(
            "standalone_missingrecipe01",
            "missing-recipe-launch-owner-proof",
        )
        .unwrap(),
    )
    .unwrap();

    let refused = creator.create(request).unwrap_err();

    assert_eq!(
        refused.code(),
        "hmux_standalone_recovery_target_unavailable"
    );
    assert!(
        LocalSessionCatalog::new(&discovery_root)
            .list()
            .unwrap()
            .is_empty(),
        "a missing recovery recipe must not publish or launch a target"
    );
}

#[test]
fn recovery_create_reconciles_the_exact_target_after_the_broker_response_is_lost() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let source = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("response-loss-recovery".into()),
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let source_generation = source.session().descriptor().clone();
    let recipe = read_only_resurrection_recipe(&discovery_root, "response-loss-recovery");
    abruptly_kill_test_session(&source_generation);
    let request = request_from_recipe(&recipe)
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new(
                "standalone_response01",
                "response-loss-launch-owner-proof",
            )
            .unwrap()
            .with_source_predecessor(presentation_predecessor(&source_generation))
            .unwrap(),
        )
        .unwrap();

    let mut broker = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .args(["--no-autostart", STANDALONE_CREATE_BROKER_SUBCOMMAND])
        .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
        .current_dir(state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
    drop(broker.stdin.take());
    assert!(
        broker.wait().unwrap().success(),
        "the first broker must finish after its response is discarded"
    );

    let created = creator.create(request.clone()).unwrap();
    assert_eq!(
        created.session().descriptor().session_id,
        "standalone_response01"
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let ready = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| {
            session.lifecycle == SessionLifecycle::Ready
                && session.session_name.as_deref() == Some("response-loss-recovery")
        })
        .collect::<Vec<_>>();
    assert_eq!(ready.len(), 1, "retry must not launch a second Host");
    assert_eq!(ready[0].session_id, "standalone_response01");

    let first_generation = created.session().descriptor().clone();
    let paused_host = pause_exact_test_group(&first_generation.host_process, "Host");
    let unavailable = creator.create(request.clone()).unwrap_err();
    assert_eq!(
        unavailable.code(),
        "hmux_standalone_recovery_target_unavailable"
    );
    let retained = catalog
        .find(&SessionSelector::new(
            &first_generation.session_id,
            Some(first_generation.workspace_id.clone()),
        ))
        .unwrap();
    assert!(
        retained.same_generation(&first_generation),
        "a transient exact-target probe failure must not retire its generation"
    );
    drop(paused_host);
    let probe_deadline = Instant::now() + Duration::from_secs(3);
    while probe_local_session_exact(&catalog, &retained) != SessionProbeStatus::Healthy {
        assert!(
            Instant::now() < probe_deadline,
            "resumed exact recovery target did not become healthy"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let reused = creator.create(request.clone()).unwrap();
    assert!(
        reused
            .session()
            .descriptor()
            .same_generation(&first_generation),
        "retry after a transient failure must reuse the exact generation"
    );

    abruptly_kill_test_session(&first_generation);
    let recreated = creator.create(request.clone()).unwrap();
    assert_eq!(
        recreated.session().descriptor().session_id,
        first_generation.session_id
    );
    assert_ne!(
        recreated.session().descriptor().host_instance_id,
        first_generation.host_instance_id,
        "a deterministic retry after reboot must recreate the exact target as a new generation"
    );

    let conflicting = request
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new(
                "standalone_response02",
                "different-launch-owner-proof",
            )
            .unwrap(),
        )
        .unwrap();
    let conflict = creator.create(conflicting).unwrap_err();
    assert_eq!(conflict.code(), "hmux_standalone_recovery_name_conflict");
    assert_eq!(
        catalog
            .list()
            .unwrap()
            .into_iter()
            .filter(|session| {
                session.lifecycle == SessionLifecycle::Ready
                    && session.session_name.as_deref() == Some("response-loss-recovery")
            })
            .count(),
        1,
        "same-name state must never be adopted as a different recovery target"
    );

    recreated
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn recovery_refuses_unrelated_stale_same_name_without_retiring_it() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let unrelated = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("unrelated-stale-conflict".into()),
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let unrelated_generation = unrelated.session().descriptor().clone();
    abruptly_kill_test_session(&unrelated_generation);

    let request = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("unrelated-stale-conflict".into()),
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
        24,
        80,
    )
    .unwrap()
    .with_recovery_identity(
        StandaloneRecoveryCreateIdentity::new("standalone_unrelated02", "unrelated-conflict-proof")
            .unwrap(),
    )
    .unwrap();
    let error = creator.create(request).unwrap_err();
    assert_eq!(error.code(), "hmux_standalone_recovery_name_conflict");

    let catalog = LocalSessionCatalog::new(&discovery_root);
    let retained = catalog
        .find(&SessionSelector::new(
            &unrelated_generation.session_id,
            Some(unrelated_generation.workspace_id.clone()),
        ))
        .unwrap();
    assert!(
        retained.same_generation(&unrelated_generation),
        "conflict validation must happen before any stale-state retirement"
    );
    assert!(
        catalog
            .find(&SessionSelector::new(
                "standalone_unrelated02",
                Some(unrelated_generation.workspace_id),
            ))
            .is_err(),
        "a refused recovery must not publish its target"
    );

    let distinct = creator
        .create(
            StandaloneCreateRequest::new(
                state.path().canonicalize().unwrap(),
                Some("unrelated-stale-conflict-operation-b".into()),
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_recovery_identity(
                StandaloneRecoveryCreateIdentity::new(
                    "standalone_unrelated03",
                    "distinct-operation-proof",
                )
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::InitializeIfAbsent),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        distinct.session().descriptor().session_name.as_deref(),
        Some("unrelated-stale-conflict-operation-b"),
        "a fresh operation-scoped name must coexist with retained stale history"
    );
    distinct
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn repository_runtime_projects_detected_agent_state_without_terminal_history_replay() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let fake_agent = state.path().join("codex-semantic-canary");
    std::os::unix::fs::symlink(std::env::current_exe().unwrap(), &fake_agent).unwrap();
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        Some(SEMANTIC_AGENT_SESSION_NAME.into()),
        vec![
            fake_agent.to_string_lossy().into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "semantic_agent_fixture_provider".into(),
            "--nocapture".into(),
        ],
        24,
        80,
    )
    .unwrap();
    let created = creator.create(request).unwrap();
    let session = created.session().clone();
    let descriptor = session.descriptor().clone();
    let catalog = LocalSessionCatalog::new(discovery_root);
    let observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            descriptor.session_id.clone(),
            Some(descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();

    assert!(
        observer
            .attachment()
            .negotiation
            .agent_runtime_state_projection,
        "standalone Host did not negotiate semantic state projection"
    );
    let observer_interrupt = observer.interrupt_handle().unwrap();
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let observer_thread = std::thread::spawn(move || {
        let mut observer = observer;
        let observed_runtime =
            if let Some(initial) = &observer.attachment().initial_snapshot.agent_runtime_state {
                Ok(initial.clone())
            } else {
                loop {
                    match observer.read_event() {
                        Ok(Some(ObserverEvent::AgentRuntimeState(runtime))) => break Ok(runtime),
                        Ok(Some(ObserverEvent::Snapshot(snapshot))) => {
                            let Some(runtime) = snapshot.agent_runtime_state else {
                                continue;
                            };
                            break Ok(runtime);
                        }
                        Ok(Some(ObserverEvent::Exit(exit))) => {
                            break Err(format!(
                                "temporary provider exited before semantic state projection: {}",
                                exit.reason
                            ));
                        }
                        Ok(Some(_)) => {}
                        Ok(None) => {
                            break Err(
                                "temporary provider disconnected before semantic state projection"
                                    .to_string(),
                            );
                        }
                        Err(error) => {
                            break Err(format!(
                                "semantic state observer failed before projection: {error}"
                            ));
                        }
                    }
                }
            };
        let _ = result_tx.send(observed_runtime);
    });
    let observed_runtime = match result_rx.recv_timeout(Duration::from_secs(15)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            observer_interrupt.interrupt();
            Err("semantic state projection did not arrive before the bounded deadline".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("semantic state observer stopped without reporting an outcome".to_string())
        }
    };
    let observer_join = observer_thread.join();
    let termination = session
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .map(|_| ());
    observer_join.unwrap();
    let runtime = match observed_runtime {
        Ok(runtime) => runtime,
        Err(message) => {
            termination.unwrap();
            panic!("{message}");
        }
    };
    termination.unwrap();
    assert_process_lifecycle_runtime_state(&runtime);
}

#[test]
fn terminal_text_never_mutates_agent_runtime_state() {
    let state = tempfile::tempdir().unwrap();
    let fake_agent = state.path().join("codex-semantic-canary");
    std::os::unix::fs::symlink(std::env::current_exe().unwrap(), &fake_agent).unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                std::env::current_dir().unwrap().canonicalize().unwrap(),
                Some(TERMINAL_TEXT_AUTHORITY_SESSION_NAME.into()),
                vec![
                    fake_agent.to_string_lossy().into_owned(),
                    "--ignored".into(),
                    "--exact".into(),
                    "terminal_text_authority_fixture_provider".into(),
                    "--nocapture".into(),
                ],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    let descriptor = session.descriptor().clone();
    let mut fixture = IdleRetirementFixture {
        session,
        catalog: LocalSessionCatalog::new(discovery_root),
        descriptor,
        tracked_process_groups: Vec::new(),
        cleaned: false,
    };

    let deadline = Instant::now() + Duration::from_secs(3);
    let initial = loop {
        let observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new(
                fixture.descriptor.session_id.clone(),
                Some(fixture.descriptor.workspace_id.clone()),
            ),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let runtime = observer
            .attachment()
            .initial_snapshot
            .agent_runtime_state
            .clone();
        observer.detach().unwrap();
        if let Some(runtime) = runtime {
            if runtime.source == hmux_client::AgentRuntimeStateSource::ProcessLifecycle {
                break runtime;
            }
        }
        assert!(
            Instant::now() < deadline,
            "provider process lifecycle did not establish runtime state"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(
        initial.activity,
        hmux_client::AgentRuntimeActivity::Waiting,
        "provider process discovery proves a running lifecycle, not an active turn"
    );

    let receipt = fixture.session.send_input(b"emit\r".to_vec()).unwrap();
    assert_eq!(receipt.state, InputReceiptState::WrittenToPty);
    wait_for_replay_snapshot(&fixture.session, b"PTY_TEXT_COMPLETE");
    let observer = LocalSessionObserver::connect(
        &fixture.catalog,
        &SessionSelector::new(
            fixture.descriptor.session_id.clone(),
            Some(fixture.descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let after_output = observer
        .attachment()
        .initial_snapshot
        .agent_runtime_state
        .clone()
        .expect("controller submit keeps an agent runtime projection");
    observer.detach().unwrap();
    fixture.terminate_and_verify();

    assert_eq!(
        after_output.revision.parse::<u64>().unwrap(),
        initial.revision.parse::<u64>().unwrap() + 1,
        "PTY output must not create an AgentRuntimeState transition or broadcast"
    );
    assert_eq!(
        after_output.source,
        hmux_client::AgentRuntimeStateSource::ControllerInput
    );
    assert_eq!(
        after_output.activity,
        hmux_client::AgentRuntimeActivity::Working
    );
    assert_eq!(
        after_output.attention,
        hmux_client::AgentRuntimeAttention::None
    );
}

#[test]
fn terminal_output_never_mutates_host_working_directory() {
    let state = tempfile::tempdir().unwrap();
    let provider_cwd = state.path().join("actual-cwd");
    fs::create_dir(&provider_cwd).unwrap();
    let provider_cwd = provider_cwd.canonicalize().unwrap();
    let fake_agent = state.path().join("codex-osc7-canary");
    std::os::unix::fs::symlink(std::env::current_exe().unwrap(), &fake_agent).unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                provider_cwd.clone(),
                Some(OSC7_CWD_AUTHORITY_SESSION_NAME.into()),
                vec![
                    fake_agent.to_string_lossy().into_owned(),
                    "--ignored".into(),
                    "--exact".into(),
                    "osc7_cwd_authority_fixture_provider".into(),
                    "--nocapture".into(),
                ],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    let descriptor = session.descriptor().clone();
    let mut fixture = IdleRetirementFixture {
        session,
        catalog: LocalSessionCatalog::new(discovery_root),
        descriptor,
        tracked_process_groups: Vec::new(),
        cleaned: false,
    };
    let observer = LocalSessionObserver::connect(
        &fixture.catalog,
        &SessionSelector::new(
            fixture.descriptor.session_id.clone(),
            Some(fixture.descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let initial_cwd = observer
        .attachment()
        .initial_snapshot
        .working_directory
        .as_ref()
        .expect("the Host must seed an authoritative cwd before it becomes ready");
    assert_eq!(initial_cwd.path, provider_cwd.to_string_lossy());
    assert_ne!(initial_cwd.source, WorkingDirectorySource::Osc7);

    let observer_interrupt = observer.interrupt_handle().unwrap();
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let observer_thread = std::thread::spawn(move || {
        let mut observer = observer;
        let marker = b"OSC7_CWD_COMPLETE";
        let mut output = Vec::new();
        let mut cwd_updates = Vec::new();
        let result = loop {
            match observer.read_event() {
                Ok(Some(ObserverEvent::Output(delta))) => {
                    if let Some(cwd) = delta.working_directory {
                        cwd_updates.push(cwd);
                    }
                    output.extend_from_slice(&delta.bytes);
                    if output.windows(marker.len()).any(|window| window == marker) {
                        break Ok(cwd_updates);
                    }
                    if output.len() > 64 * 1024 {
                        break Err("cwd authority fixture output exceeded its bound".to_string());
                    }
                }
                Ok(Some(ObserverEvent::Exit(exit))) => {
                    break Err(format!(
                        "cwd authority fixture exited before marker: {}",
                        exit.reason
                    ));
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    break Err("cwd authority observer disconnected before marker".to_string());
                }
                Err(error) => break Err(format!("cwd authority observer failed: {error}")),
            }
        };
        let _ = observer.detach();
        let _ = result_tx.send(result);
    });

    let receipt = fixture.session.send_input(b"emit\r".to_vec()).unwrap();
    assert_eq!(receipt.state, InputReceiptState::WrittenToPty);
    let cwd_updates = match result_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            observer_interrupt.interrupt();
            Err("cwd authority projection did not arrive before the deadline".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("cwd authority observer stopped without reporting an outcome".to_string())
        }
    };
    observer_thread.join().unwrap();
    assert!(
        cwd_updates.unwrap().is_empty(),
        "PTY output must not publish a working-directory projection"
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new(
                fixture.descriptor.session_id.clone(),
                Some(fixture.descriptor.workspace_id.clone()),
            ),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let cwd = observer
            .attachment()
            .initial_snapshot
            .working_directory
            .clone();
        observer.detach().unwrap();
        if cwd.as_ref().is_some_and(|cwd| {
            cwd.path == provider_cwd.to_string_lossy()
                && cwd.source == WorkingDirectorySource::ProcessInspection
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "process inspection did not establish the provider cwd"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    fixture.terminate_and_verify();
}

#[test]
#[ignore = "launched as the deterministic provider child by the semantic state smoke"]
fn semantic_agent_fixture_provider() {
    if std::env::var("HMUX_SESSION_NAME").as_deref() != Ok(SEMANTIC_AGENT_SESSION_NAME) {
        return;
    }
    loop {
        std::thread::park();
    }
}

#[test]
#[ignore = "launched as the deterministic provider child by the terminal text authority smoke"]
fn terminal_text_authority_fixture_provider() {
    if std::env::var("HMUX_SESSION_NAME").as_deref() != Ok(TERMINAL_TEXT_AUTHORITY_SESSION_NAME) {
        return;
    }
    let mut submitted = String::new();
    std::io::stdin().read_line(&mut submitted).unwrap();
    assert_eq!(submitted.trim(), "emit");
    println!("* Thinking (esc to interrupt)");
    println!("This command requires your approval");
    println!("1. Allow");
    println!("Enter to confirm");
    println!("› ");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    println!("PTY_TEXT_COMPLETE");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
#[ignore = "launched as the deterministic provider child by the cwd authority smoke"]
fn osc7_cwd_authority_fixture_provider() {
    if std::env::var("HMUX_SESSION_NAME").as_deref() != Ok(OSC7_CWD_AUTHORITY_SESSION_NAME) {
        return;
    }
    let mut submitted = String::new();
    std::io::stdin().read_line(&mut submitted).unwrap();
    assert_eq!(submitted.trim(), "emit");
    std::io::stdout()
        .write_all(b"\x1b]7;file:///forged\x07OSC7_CWD_COMPLETE\r\n")
        .unwrap();
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
fn external_agent_state_reports_fold_into_broadcast_projections() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                std::env::current_dir().unwrap().canonicalize().unwrap(),
                Some("state-report-smoke".into()),
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    assert!(
        session
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == "agent_state_report_v1")
    );
    assert!(
        session
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| { capability == "agent_state_report_completion_id_v1" })
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let mut observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            session.descriptor().session_id.clone(),
            Some(session.descriptor().workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();

    let blocked = session
        .report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: hmux_client::AgentRuntimeActivity::Waiting,
                attention: hmux_client::AgentRuntimeAttention::ApprovalRequired,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            None,
        )
        .unwrap();
    assert_eq!(blocked, AgentStateReportOutcome::Applied);
    let projected = wait_for_provider_event_state(&mut observer);
    assert_eq!(
        projected.attention,
        hmux_client::AgentRuntimeAttention::ApprovalRequired
    );
    assert_eq!(
        projected.activity,
        hmux_client::AgentRuntimeActivity::Waiting
    );
    assert_eq!(projected.turn_completed_count, "0");
    assert!(projected.attention_id.is_some());

    // Completion without attention detail preserves the episode and reaches
    // subscribers as a counter increment even though the triple is unchanged.
    let completed = session
        .report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: hmux_client::AgentRuntimeActivity::Waiting,
                attention: hmux_client::AgentRuntimeAttention::None,
                turn_completed: true,
                turn_completion_id: Some("turn-0199aaaa-bbbb-7ac2".into()),
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            None,
        )
        .unwrap();
    assert_eq!(
        completed,
        AgentStateReportOutcome::NoOp,
        "an identified completion remains pending until the Host observes quiescence"
    );
    let counted = wait_for_provider_event_state(&mut observer);
    assert_eq!(counted.turn_completed_count, "1");
    assert_eq!(counted.attention_id, projected.attention_id);

    let duplicate_completion = session
        .report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: hmux_client::AgentRuntimeActivity::Waiting,
                attention: hmux_client::AgentRuntimeAttention::None,
                turn_completed: true,
                turn_completion_id: Some("turn-0199aaaa-bbbb-7ac2".into()),
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            None,
        )
        .unwrap();
    assert_eq!(duplicate_completion, AgentStateReportOutcome::NoOp);

    // The same report without a completion is a receipt-visible no-op.
    let repeated = session
        .report_agent_state(
            AgentStateReport {
                identity_only: false,
                activity: hmux_client::AgentRuntimeActivity::Waiting,
                attention: hmux_client::AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            None,
        )
        .unwrap();
    assert_eq!(repeated, AgentStateReportOutcome::NoOp);

    // A delayed error report from this exact snapshot must lose to a later
    // working recovery. The current boundary still accepts a real error.
    let baseline_observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            session.descriptor().session_id.clone(),
            Some(session.descriptor().workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let baseline_snapshot = &baseline_observer.attachment().initial_snapshot;
    let baseline_runtime = baseline_snapshot.agent_runtime_state.as_ref().unwrap();
    let stale_boundary = AgentStateReportObservationFence {
        terminal_epoch: baseline_snapshot.terminal_epoch.clone(),
        runtime_revision: baseline_runtime.revision.parse().unwrap(),
        output_sequence: baseline_snapshot.sequence_through.parse().unwrap(),
    };
    assert_eq!(
        session
            .report_agent_state(
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Working,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: None,
                },
                None,
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    let recovered = wait_for_provider_event_state(&mut observer);
    assert_eq!(
        session
            .report_agent_state(
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Waiting,
                    attention: hmux_client::AgentRuntimeAttention::Error,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: Some(stale_boundary),
                },
                None,
            )
            .unwrap(),
        AgentStateReportOutcome::NoOp
    );
    let current_observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            session.descriptor().session_id.clone(),
            Some(session.descriptor().workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let current_snapshot = &current_observer.attachment().initial_snapshot;
    let current_runtime = current_snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(current_runtime.revision, recovered.revision);
    assert_eq!(
        current_runtime.activity,
        hmux_client::AgentRuntimeActivity::Working
    );
    assert_eq!(
        current_runtime.attention,
        hmux_client::AgentRuntimeAttention::None
    );
    assert_eq!(
        session
            .report_agent_state(
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Waiting,
                    attention: hmux_client::AgentRuntimeAttention::Error,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: Some(AgentStateReportObservationFence {
                        terminal_epoch: current_snapshot.terminal_epoch.clone(),
                        runtime_revision: current_runtime.revision.parse().unwrap(),
                        output_sequence: current_snapshot.sequence_through.parse().unwrap(),
                    }),
                },
                None,
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    let actual_error = wait_for_provider_event_state(&mut observer);
    assert_eq!(
        actual_error.attention,
        hmux_client::AgentRuntimeAttention::Error
    );

    session
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn bounded_working_report_expires_without_terminal_text_inference() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                std::env::current_dir().unwrap().canonicalize().unwrap(),
                Some("bounded-working-report-smoke".into()),
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let mut observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            session.descriptor().session_id.clone(),
            Some(session.descriptor().workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();

    assert_eq!(
        session
            .report_agent_state(
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Working,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: Some(50),
                    conversation_identity: None,
                    expected_observation: None,
                },
                None,
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    let working = wait_for_provider_event_state(&mut observer);
    assert_eq!(working.activity, hmux_client::AgentRuntimeActivity::Working);

    let expired = wait_for_provider_event_state(&mut observer);
    assert_eq!(expired.activity, hmux_client::AgentRuntimeActivity::Waiting);
    assert_eq!(expired.attention, hmux_client::AgentRuntimeAttention::None);
    assert_eq!(
        expired.revision.parse::<u64>().unwrap(),
        working.revision.parse::<u64>().unwrap() + 1
    );
    assert_eq!(
        expired.observed_through_output_seq, working.observed_through_output_seq,
        "deadline expiry is ordered Host state, not a terminal-output observation"
    );

    session
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_surface_carries_initial_and_live_agent_runtime_state() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            StandaloneCreateRequest::new(
                std::env::current_dir().unwrap().canonicalize().unwrap(),
                Some("structured-runtime-state-smoke".into()),
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    let catalog = LocalSessionCatalog::new(&discovery_root);

    assert_eq!(
        session
            .report_agent_state(
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Working,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: Some(10_000),
                    conversation_identity: None,
                    expected_observation: None,
                },
                None,
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    let connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let initial = surface
        .initial_agent_runtime_state()
        .expect("structured attach must carry current Host runtime state");
    assert_eq!(initial.activity, hmux_client::AgentRuntimeActivity::Working);
    assert_eq!(
        initial.source,
        hmux_client::AgentRuntimeStateSource::ProviderEvent
    );
    let initial_revision = initial.revision.parse::<u64>().unwrap();

    assert_eq!(
        session
            .report_agent_state(
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Waiting,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: None,
                },
                None,
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    let live = loop {
        match surface.read_delivery_record().unwrap() {
            ConnectionRecord::Control(body) => {
                if let FrameBody::AgentRuntimeState(state) = *body {
                    break state;
                }
            }
            ConnectionRecord::TerminalState(_) => {}
        }
    };
    assert_eq!(live.revision, initial_revision + 1);
    assert_eq!(
        live.activity,
        hmux_host::local_protocol::AgentRuntimeActivity::Waiting
    );
    assert_eq!(
        live.source,
        hmux_host::local_protocol::AgentRuntimeStateSource::ProviderEvent
    );

    surface.detach().unwrap();
    session
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

fn wait_for_provider_event_state(
    observer: &mut LocalSessionObserver,
) -> hmux_client::AgentRuntimeStateDescriptor {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(
            Instant::now() < deadline,
            "observer did not receive the provider-event projection"
        );
        match observer.read_event().unwrap() {
            Some(ObserverEvent::AgentRuntimeState(state))
                if state.source == hmux_client::AgentRuntimeStateSource::ProviderEvent =>
            {
                return state;
            }
            Some(_) => {}
            None => panic!("observer disconnected before the provider-event projection"),
        }
    }
}

#[test]
fn verified_recipe_restores_an_exited_shell_as_a_new_session() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let shell_release = state.path().join("shell-release");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let terminal_environment = TerminalEnvironment::new(BTreeMap::from([(
        "NO_COLOR".to_string(),
        Some("explicit-restore-value".to_string()),
    )]))
    .unwrap();
    let first = creator
        .create(
            StandaloneCreateRequest::new(
                &cwd,
                Some("restore-smoke".into()),
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "while [ ! -f \"$1\" ]; do sleep 0.05; done".into(),
                    "--".into(),
                    shell_release.to_string_lossy().into_owned(),
                ],
                31,
                97,
            )
            .unwrap()
            .with_terminal_environment(terminal_environment.clone())
            .unwrap()
            .with_retirement_policy(idle_retirement_policy())
            .unwrap(),
        )
        .unwrap();
    let first_session_id = first.receipt().session_id().to_string();
    let first_workspace_id = first.receipt().workspace_id().to_string();
    fs::write(&shell_release, b"release").unwrap();
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let descriptor = catalog
            .find(&SessionSelector::new(
                &first_session_id,
                Some(first_workspace_id.clone()),
            ))
            .unwrap();
        if descriptor.lifecycle == hmux_client::SessionLifecycle::Exited {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "source shell did not publish its exited tombstone"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let recipe_path = fs::read_dir(discovery_root.join(".resurrection"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let recipe: StandaloneResurrectionRecipe =
        serde_json::from_slice(&fs::read(recipe_path).unwrap()).unwrap();
    recipe.validate().unwrap();
    assert_eq!(recipe.retirement_policy(), Some(idle_retirement_policy()));
    fs::remove_file(&shell_release).unwrap();
    let restored = creator
        .create(
            StandaloneCreateRequest::new(
                recipe.provider_cwd(),
                Some(recipe.session_name().to_string()),
                recipe.command().to_vec(),
                recipe.initial_rows(),
                recipe.initial_columns(),
            )
            .unwrap()
            .with_resurrection_replay_policy(recipe.resurrection_replay_policy())
            .unwrap()
            .with_terminal_environment(recipe.terminal_environment().clone())
            .unwrap()
            .with_retirement_policy_option(recipe.retirement_policy())
            .unwrap(),
        )
        .unwrap();

    assert_ne!(restored.receipt().session_id(), first_session_id);
    assert_eq!(restored.receipt().session_name(), "restore-smoke");
    assert_eq!(recipe.provider_cwd(), cwd);
    assert_eq!(recipe.initial_rows(), 31);
    assert_eq!(recipe.initial_columns(), 97);
    assert_eq!(recipe.terminal_environment(), &terminal_environment);
    assert_eq!(
        restored.session().descriptor().retirement_policy,
        Some(idle_retirement_policy())
    );
    fs::write(&shell_release, b"release").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let descriptor = catalog
            .find(&SessionSelector::new(
                restored.receipt().session_id(),
                Some(restored.receipt().workspace_id().to_string()),
            ))
            .unwrap();
        if descriptor.lifecycle == hmux_client::SessionLifecycle::Exited {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "restored shell did not publish its exited tombstone"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn verified_recipe_recovers_a_ready_manifest_after_abrupt_host_loss() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let first = creator
        .create(
            StandaloneCreateRequest::new(
                &cwd,
                Some("reboot-recovery-smoke".into()),
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'recovery-ready:%s\\n' \"$HMUX_SESSION_ID\"; sleep 15".into(),
                ],
                29,
                91,
            )
            .unwrap(),
        )
        .unwrap();
    let first_descriptor = first.session().descriptor().clone();
    let first_selector = SessionSelector::new(
        first_descriptor.session_id.clone(),
        Some(first_descriptor.workspace_id.clone()),
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);

    assert_eq!(
        probe_local_session(&catalog, &first_selector),
        SessionProbeStatus::Healthy
    );
    let predecessor_marker = format!("recovery-ready:{}", first_descriptor.session_id);
    assert_replay_contains(first.session(), predecessor_marker.as_bytes());
    let checkpoint = wait_for_presentation_checkpoint(&discovery_root, &first_descriptor);
    assert!(
        checkpoint.sequence_through() >= 1,
        "checkpoint did not include the source provider output"
    );
    let recipe_path = fs::read_dir(discovery_root.join(".resurrection"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let recipe: StandaloneResurrectionRecipe =
        serde_json::from_slice(&fs::read(recipe_path).unwrap()).unwrap();
    recipe.validate().unwrap();

    abruptly_kill_test_session(&first_descriptor);

    let stale = catalog.find(&first_selector).unwrap();
    assert_eq!(
        stale.lifecycle,
        SessionLifecycle::Ready,
        "abrupt Host loss must leave the source manifest Ready, as a reboot does"
    );
    assert_eq!(
        probe_local_session(&catalog, &first_selector),
        SessionProbeStatus::StaleTransport
    );

    let restored = creator.create(request_from_recipe(&recipe)).unwrap();
    let restored_descriptor = restored.session().descriptor().clone();
    let restored_selector = SessionSelector::new(
        restored_descriptor.session_id.clone(),
        Some(restored_descriptor.workspace_id.clone()),
    );
    assert_ne!(restored_descriptor.session_id, first_descriptor.session_id);
    assert_ne!(
        restored_descriptor.host_instance_id,
        first_descriptor.host_instance_id
    );
    assert_ne!(
        restored_descriptor.terminal_epoch,
        first_descriptor.terminal_epoch
    );
    assert_eq!(
        restored_descriptor.workspace_id,
        first_descriptor.workspace_id
    );
    assert_eq!(
        restored_descriptor.session_name,
        first_descriptor.session_name
    );
    assert_eq!(
        probe_local_session(&catalog, &restored_selector),
        SessionProbeStatus::Healthy
    );
    let restored_snapshot = wait_for_replay_snapshot(
        restored.session(),
        format!("recovery-ready:{}", restored_descriptor.session_id).as_bytes(),
    );
    assert!(
        restored_snapshot
            .repaint_bytes
            .windows(predecessor_marker.len())
            .any(|window| window == predecessor_marker.as_bytes()),
        "replacement terminal did not preserve its predecessor presentation"
    );
    let recovered = restored_snapshot
        .recovered_presentation
        .expect("replacement snapshot did not identify its presentation predecessor");
    assert_eq!(
        recovered.source_fence.session_id,
        first_descriptor.session_id
    );
    assert_eq!(
        recovered.source_fence.host_instance_id,
        first_descriptor.host_instance_id
    );
    assert_eq!(
        recovered.source_fence.terminal_epoch,
        first_descriptor.terminal_epoch
    );
    assert_eq!(recovered.sequence_through, checkpoint.sequence_through());

    let duplicate = creator.create(request_from_recipe(&recipe)).unwrap_err();
    assert_eq!(duplicate.code(), "hmux_standalone_create_refused");
    let ready_with_same_name: Vec<_> = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| {
            descriptor.lifecycle == SessionLifecycle::Ready
                && descriptor.session_name.as_deref() == Some(recipe.session_name())
        })
        .collect();
    assert_eq!(
        ready_with_same_name.len(),
        1,
        "a recovery retry must converge on one live named session"
    );
    assert_eq!(
        ready_with_same_name[0].session_id,
        restored_descriptor.session_id
    );

    restored
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn ghostty_native_rehost_preserves_history_then_resizes_and_scrolls() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_cwd = state.path().canonicalize().unwrap();
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let first = creator
        .create(
            StandaloneCreateRequest::new(
                &provider_cwd,
                Some("ghostty-rehost-resize-scroll".into()),
                vec![
                    std::env::current_exe()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    "--ignored".into(),
                    "--exact".into(),
                    "ghostty_rehost_resize_scroll_fixture_provider".into(),
                    "--nocapture".into(),
                ],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let first_descriptor = first.session().descriptor().clone();
    let first_snapshot = wait_for_replay_snapshot(first.session(), b"ALT_SOURCE_MARKER");
    assert!(first_snapshot.alternate_screen);
    let checkpoint = wait_for_presentation_checkpoint_at_least(
        &discovery_root,
        &first_descriptor,
        first_snapshot.sequence_through,
    );
    assert!(checkpoint.terminal_checkpoint().alternate_screen);
    assert!(matches!(
        checkpoint.terminal_checkpoint().encoding,
        TerminalCheckpointEncoding::EngineNativeV1 { .. }
    ));

    let recipe_path = fs::read_dir(discovery_root.join(".resurrection"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let recipe: StandaloneResurrectionRecipe =
        serde_json::from_slice(&fs::read(recipe_path).unwrap()).unwrap();
    recipe.validate().unwrap();
    abruptly_kill_test_session(&first_descriptor);

    let restored = creator.create(request_from_recipe(&recipe)).unwrap();
    let restored_descriptor = restored.session().descriptor().clone();
    assert_ne!(
        restored_descriptor.terminal_epoch,
        first_descriptor.terminal_epoch
    );
    let normal_snapshot = wait_for_replay_snapshot(restored.session(), b"REHOST_NORMAL_READY");
    assert!(!normal_snapshot.alternate_screen);
    assert!(
        normal_snapshot
            .repaint_bytes
            .windows(b"NORMAL_HISTORY_ANCHOR".len())
            .any(|window| window == b"NORMAL_HISTORY_ANCHOR"),
        "native rehost lost the inactive normal buffer while alternate screen was active"
    );
    let recovered = normal_snapshot
        .recovered_presentation
        .as_ref()
        .expect("replacement did not expose its recovered presentation fence");
    assert_eq!(
        recovered.source_fence.terminal_epoch,
        first_descriptor.terminal_epoch
    );
    assert_eq!(recovered.sequence_through, checkpoint.sequence_through());

    let receipt = restored.session().send_resize(37, 103).unwrap();
    assert_eq!((receipt.rows, receipt.columns), (Some(37), Some(103)));
    let resized = wait_for_replay_snapshot(restored.session(), b"REHOST_SCROLL_TAIL");
    assert_eq!((resized.rows, resized.columns), (37, 103));
    assert!(
        resized
            .repaint_bytes
            .windows(b"REHOST_WINCH:37 103".len())
            .any(|window| window == b"REHOST_WINCH:37 103"),
        "rehosted provider did not observe the canonical PTY geometry"
    );
    assert!(
        resized
            .repaint_bytes
            .windows(b"NORMAL_HISTORY_ANCHOR".len())
            .any(|window| window == b"NORMAL_HISTORY_ANCHOR"),
        "continued scrolling after resize discarded the recovered normal history"
    );

    restored
        .session()
        .terminate_standalone(
            &LocalSessionCatalog::new(&discovery_root),
            Duration::from_secs(3),
        )
        .unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as the deterministic provider by the Ghostty rehost/resize/scroll smoke"]
fn ghostty_rehost_resize_scroll_fixture_provider() {
    let generation_file = std::env::current_dir()
        .unwrap()
        .join(".ghostty-rehost-generation");
    let is_source = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&generation_file)
        .is_ok();
    if is_source {
        for line in 0..64 {
            println!("NORMAL_HISTORY:{line:03}");
        }
        println!("NORMAL_HISTORY_ANCHOR");
        print!("\x1b[?1049h\x1b[2J\x1b[HALT_SOURCE_MARKER");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }

    RESIZE_SIGNAL_RECEIVED.store(false, Ordering::Release);
    let previous = unsafe {
        libc::signal(
            libc::SIGWINCH,
            record_resize_signal as *const () as libc::sighandler_t,
        )
    };
    assert_ne!(previous, libc::SIG_ERR);
    print!("\x1b[?1049l\r\nREHOST_NORMAL_READY\r\n");
    std::io::stdout().flush().unwrap();

    loop {
        if !RESIZE_SIGNAL_RECEIVED.swap(false, Ordering::AcqRel) {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let mut size = libc::winsize {
            ws_row: 0,
            ws_col: 0,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe { libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut size) };
        assert_eq!(result, 0, "read rehosted fixture PTY geometry");
        println!("REHOST_WINCH:{} {}", size.ws_row, size.ws_col);
        for line in 0..96 {
            println!("REHOST_SCROLL:{line:03}");
        }
        println!("REHOST_SCROLL_TAIL");
        std::io::stdout().flush().unwrap();
    }
}

#[test]
fn verified_recipe_recovery_waits_for_new_transport_handshake() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let first = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            StandaloneCreateRequest::new(
                &cwd,
                Some("recovery-readiness-smoke".into()),
                vec!["/bin/sh".into(), "-c".into(), "sleep 15".into()],
                29,
                91,
            )
            .unwrap(),
        )
        .unwrap();
    let first_descriptor = first.session().descriptor().clone();
    let recipe = read_only_resurrection_recipe(&discovery_root, "recovery-readiness-smoke");
    abruptly_kill_test_session(&first_descriptor);

    let (runtime, ready_marker) = host_ready_pause_runtime(&state);
    let creator = StandaloneSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    let (created_tx, created_rx) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        let _ = created_tx.send(creator.create(request_from_recipe(&recipe)));
    });

    wait_for_exact_file(&ready_marker, b"host_ready_published");
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let replacement_deadline = Instant::now() + Duration::from_secs(2);
    let replacement = loop {
        if let Some(descriptor) = catalog.list().unwrap().into_iter().find(|descriptor| {
            descriptor.lifecycle == SessionLifecycle::Ready
                && descriptor.session_name.as_deref() == Some("recovery-readiness-smoke")
                && descriptor.session_id != first_descriptor.session_id
        }) {
            break descriptor;
        }
        assert!(
            Instant::now() < replacement_deadline,
            "replacement Ready generation was not published"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let resume_host = PausedTestProcessGroup(exact_owned_process_group(
        &replacement.host_process,
        "replacement Host",
    ));
    let early = created_rx.recv_timeout(Duration::from_millis(250));
    let returned_before_handshake = early.is_ok();
    drop(resume_host);
    let restored = match early {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => created_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("recovery did not complete after transport readiness"),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            panic!("recovery worker disconnected before returning a result")
        }
    }
    .unwrap();
    worker.join().unwrap();

    assert!(
        restored
            .session()
            .descriptor()
            .same_generation(&replacement),
        "recovery returned a different generation than the paused Ready target"
    );
    assert_eq!(
        probe_local_session_exact(&catalog, restored.session().descriptor()),
        SessionProbeStatus::Healthy
    );
    restored
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
    assert!(
        !returned_before_handshake,
        "verified recipe recovery returned before the new Host completed a control-plane handshake"
    );
}

#[test]
fn repository_runtime_owns_termination_and_does_not_wait_forever_on_pty_descendants() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let descendant_pid_path = state.path().join("descendant.pid");
    let command = format!(
        "set -m; (trap \"\" HUP TERM; sleep 30) & echo $! > '{}'; \
         trap \"\" HUP TERM; wait",
        descendant_pid_path.display()
    );
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        Some("termination-canary".into()),
        vec!["/bin/sh".into(), "-c".into(), command],
        24,
        80,
    )
    .unwrap();
    let created = creator.create(request).unwrap();
    let session = created.session().clone();
    let descriptor = session.descriptor().clone();
    let catalog = LocalSessionCatalog::new(discovery_root);
    let descendant_pid = wait_for_pid_file(&descendant_pid_path);
    let descendant_group = process_group(descendant_pid);
    assert_ne!(
        descendant_group,
        i32::try_from(descriptor.provider_process.process_id).unwrap(),
        "termination canary did not create a separate job-control process group"
    );
    let (writer_done_tx, writer_done_rx) = mpsc::sync_channel(1);
    let blocked_writer = {
        let session = session.clone();
        std::thread::spawn(move || {
            let result =
                (0..1_024).try_for_each(|_| session.send_input(vec![b'x'; 64 * 1024]).map(|_| ()));
            let _ = writer_done_tx.send(result);
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        matches!(writer_done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "termination canary did not establish a blocked PTY write"
    );

    session
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
    assert!(
        wait_for_process_exit(descriptor.host_process.process_id, Duration::from_secs(7)),
        "standalone Host remained alive while a descendant held the slave PTY"
    );
    assert!(
        wait_for_process_exit(descendant_pid, Duration::from_secs(2)),
        "Host-owned termination left a PTY descendant running"
    );
    assert!(
        writer_done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err(),
        "input unexpectedly committed after provider-session termination"
    );
    blocked_writer.join().unwrap();
}

fn assert_process_lifecycle_runtime_state(runtime: &hmux_client::AgentRuntimeStateDescriptor) {
    assert_eq!(
        runtime.lifecycle,
        hmux_client::AgentRuntimeLifecycle::Running
    );
    assert_eq!(runtime.activity, hmux_client::AgentRuntimeActivity::Waiting);
    assert_eq!(runtime.attention, hmux_client::AgentRuntimeAttention::None);
    assert_eq!(
        runtime.source,
        hmux_client::AgentRuntimeStateSource::ProcessLifecycle
    );
}

fn recipe_sync_fault_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let wrapper = state.path().join("recipe-sync-fault-hook");
    let runtime_link = wrapper.with_extension("runtime");
    let fault_marker = wrapper.with_extension("fault");
    symlink(env!("CARGO_BIN_EXE_hmux-runtime"), &runtime_link).unwrap();
    fs::write(
        &wrapper,
        "#!/bin/sh\n\
         export HMUX_RUNTIME_TEST_RECIPE_DIRECTORY_SYNC_FAULT_MARKER=\"${0}.fault\"\n\
         exec \"${0}.runtime\" \"$@\"\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, fault_marker)
}

fn host_spawn_before_start_fault_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf) {
    runtime_fault_wrapper(
        state,
        "host-spawn-before-start-fault-hook",
        "HMUX_RUNTIME_TEST_HOST_SPAWN_BEFORE_START_FAULT_MARKER",
        "fault",
        None,
    )
}

fn ready_probe_after_match_fault_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf) {
    runtime_fault_wrapper(
        state,
        "ready-probe-after-match-fault-hook",
        "HMUX_RUNTIME_TEST_READY_PROBE_AFTER_MATCH_FAULT_MARKER",
        "fault",
        None,
    )
}

fn host_ready_pause_runtime(state: &tempfile::TempDir) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let wrapper = state.path().join("host-ready-pause-hook");
    let runtime_link = wrapper.with_extension("runtime");
    let ready_marker = wrapper.with_extension("ready");
    symlink(env!("CARGO_BIN_EXE_hmux-runtime"), &runtime_link).unwrap();
    fs::write(
        &wrapper,
        "#!/bin/sh\n\
         export HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE=host_ready_published\n\
         export HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER=\"${0}.ready\"\n\
         exec \"${0}.runtime\" \"$@\"\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, ready_marker)
}

fn runtime_fault_wrapper(
    state: &tempfile::TempDir,
    name: &str,
    environment: &str,
    marker_extension: &str,
    additional_export: Option<(&str, &str)>,
) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let wrapper = state.path().join(name);
    let runtime_link = wrapper.with_extension("runtime");
    let marker = wrapper.with_extension(marker_extension);
    let additional_export = additional_export
        .map(|(name, value)| format!("export {name}='{value}'\n"))
        .unwrap_or_default();
    let runtime = std::env::var_os("DURE_QA_HMUX_RUNTIME")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_hmux-runtime").into());
    let runtime = std::path::PathBuf::from(runtime)
        .canonicalize()
        .expect("runtime fault fixture requires an existing runtime executable");
    symlink(runtime, &runtime_link).unwrap();
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n\
             export {environment}=\"${{0}}.{marker_extension}\"\n\
             {additional_export}\
             exec \"${{0}}.runtime\" \"$@\"\n"
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, marker)
}

#[cfg(feature = "terminal-state-stream")]
fn pty_read_before_ingest_pause_runtime(
    state: &tempfile::TempDir,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let (runtime, paused_marker) = runtime_fault_wrapper(
        state,
        "pty-read-before-ingest-pause-hook",
        "HMUX_RUNTIME_TEST_PTY_READ_BEFORE_INGEST_PAUSE_MARKER",
        "paused",
        None,
    );
    let arm_marker = paused_marker.with_extension("arm");
    let release_marker = paused_marker.with_extension("release");
    (runtime, arm_marker, paused_marker, release_marker)
}

#[cfg(feature = "terminal-state-stream")]
fn pty_resize_liveness_fault_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let (runtime, observed_marker) = runtime_fault_wrapper(
        state,
        "pty-resize-liveness-fault-hook",
        "HMUX_RUNTIME_TEST_PTY_RESIZE_LIVENESS_FAULT_MARKER",
        "observed",
        Some(("HMUX_RUNTIME_TEST_MAX_PENDING_HISTORY_TRANSFER_BYTES", "1")),
    );
    let arm_marker = observed_marker.with_extension("arm");
    (runtime, arm_marker, observed_marker)
}

fn read_only_resurrection_recipe(
    discovery_root: &std::path::Path,
    session_name: &str,
) -> StandaloneResurrectionRecipe {
    let path = resurrection_recipe_path(discovery_root, session_name);
    let recipe: StandaloneResurrectionRecipe =
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    recipe.validate().unwrap();
    assert_eq!(recipe.session_name(), session_name);
    recipe
}

fn resurrection_recipe_path(
    discovery_root: &std::path::Path,
    session_name: &str,
) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(session_name.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    discovery_root
        .join(".resurrection")
        .join(format!("recipe_{}.json", &digest[..32]))
}

fn recipe_read_fault_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let wrapper = state.path().join("recipe-read-fault-hook");
    let runtime_link = wrapper.with_extension("runtime");
    let fault_marker = wrapper.with_extension("fault");
    symlink(env!("CARGO_BIN_EXE_hmux-runtime"), &runtime_link).unwrap();
    fs::write(
        &wrapper,
        "#!/bin/sh\n\
         export HMUX_RUNTIME_TEST_RECIPE_READ_FAULT_MARKER=\"${0}.fault\"\n\
         exec \"${0}.runtime\" \"$@\"\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, fault_marker)
}

fn retirement_policy_recipe_publish_pause_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let wrapper = state.path().join("retirement-policy-recipe-publish-hook");
    let runtime_link = wrapper.with_extension("runtime");
    let published_marker = wrapper.with_extension("published");
    symlink(env!("CARGO_BIN_EXE_hmux-runtime"), &runtime_link).unwrap();
    fs::write(
        &wrapper,
        "#!/bin/sh\n\
         export HMUX_RUNTIME_TEST_RETIREMENT_POLICY_RECIPE_PUBLISHED_MARKER=\"${0}.published\"\n\
         exec \"${0}.runtime\" \"$@\"\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, published_marker)
}

fn retirement_departure_before_transition_pause_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let wrapper = state
        .path()
        .join("retirement-departure-before-transition-hook");
    let runtime_link = wrapper.with_extension("runtime");
    let paused_marker = wrapper.with_extension("paused");
    let release_marker = paused_marker.with_extension("release");
    symlink(env!("CARGO_BIN_EXE_hmux-runtime"), &runtime_link).unwrap();
    fs::write(
        &wrapper,
        "#!/bin/sh\n\
         export HMUX_RUNTIME_TEST_RETIREMENT_DEPARTURE_BEFORE_TRANSITION_MARKER=\"${0}.paused\"\n\
         exec \"${0}.runtime\" \"$@\"\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, paused_marker, release_marker)
}

fn assert_no_pending_resurrection_recipe(discovery_root: &std::path::Path) {
    let pending = fs::read_dir(discovery_root.join(".resurrection"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".pending"))
        })
        .count();
    assert_eq!(pending, 0, "recovery left a pending recipe residue");
}

fn idle_retirement_freeze_hook_runtime(
    state: &tempfile::TempDir,
) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let wrapper = state.path().join("idle-retirement-hook");
    let runtime_link = wrapper.with_extension("runtime");
    let frozen_marker = wrapper.with_extension("frozen");
    symlink(env!("CARGO_BIN_EXE_hmux-runtime"), &runtime_link).unwrap();
    fs::write(
        &wrapper,
        "#!/bin/sh\n\
         export HMUX_RUNTIME_TEST_IDLE_RETIREMENT_FROZEN_MARKER=\"${0}.frozen\"\n\
         exec \"${0}.runtime\" \"$@\"\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, frozen_marker)
}

fn guardian_readiness_fault_runtime(
    state: &tempfile::TempDir,
    fault: &str,
) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    assert!(matches!(fault, "exit" | "timeout"));
    let wrapper = state
        .path()
        .join(format!("idle-retirement-guardian-{fault}-hook"));
    let runtime_link = wrapper.with_extension("runtime");
    let observed_marker = wrapper.with_extension("observed");
    symlink(env!("CARGO_BIN_EXE_hmux-runtime"), &runtime_link).unwrap();
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n\
             export HMUX_RUNTIME_TEST_IDLE_RETIREMENT_GUARDIAN_READY_FAULT='{fault}'\n\
             export HMUX_RUNTIME_TEST_IDLE_RETIREMENT_GUARDIAN_READY_FAULT_MARKER=\"${{0}}.observed\"\n\
             exec \"${{0}}.runtime\" \"$@\"\n"
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (wrapper, observed_marker)
}

fn wait_for_exact_file(path: &std::path::Path, expected: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if fs::read(path).is_ok_and(|contents| contents == expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for exact guardian fault marker"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_pid_file(path: &std::path::Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(process_id) = contents.trim().parse() {
                return process_id;
            }
        }
        assert!(
            Instant::now() < deadline,
            "temporary descendant did not publish its pid"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_process_session_member(session_leader: u32, member_pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if SharedProcessSampler::host_default()
            .and_then(|sampler| sampler.fresh_process_snapshot())
            .is_ok_and(|snapshot| {
                snapshot.processes.iter().any(|process| {
                    process.pid == member_pid && process.session_id == session_leader
                })
            })
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "temporary descendant did not enter the provider process session"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_is_stopped(process_id: u32) -> bool {
    let output = Command::new("ps")
        .args(["-o", "state=", "-p", &process_id.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "could not inspect temporary process state: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    matches!(
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .chars()
            .next(),
        Some('T' | 't')
    )
}

fn wait_for_process_exit(process_id: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_exists(process_id) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_process_generation_exit_with_timeout(
    process: &ProcessDescriptor,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_generation_is_live(process).unwrap_or(true) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn process_exists(process_id: u32) -> bool {
    let Ok(process_id) = i32::try_from(process_id) else {
        return false;
    };
    // SAFETY: signal 0 performs an existence check and does not mutate the
    // generated temporary process.
    unsafe { libc::kill(process_id, 0) == 0 }
}

fn best_effort_kill_exact_test_group(process: &ProcessDescriptor) {
    if !process_generation_is_live(process).unwrap_or(false) {
        return;
    }
    let Ok(process_id) = libc::pid_t::try_from(process.process_id) else {
        return;
    };
    // SAFETY: getpgid/getpgrp only inspect process-group identity.
    let group = unsafe { libc::getpgid(process_id) };
    let caller_group = unsafe { libc::getpgrp() };
    if group == process_id && group > 0 && group != caller_group {
        // SAFETY: the exact live test generation was revalidated above and is
        // still the leader of this test-owned process group.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
}

fn best_effort_kill_tracked_process_group(process_id: u32, expected_group: libc::pid_t) {
    let Ok(process_id) = libc::pid_t::try_from(process_id) else {
        return;
    };
    // SAFETY: these calls inspect the temporary descendant recorded by the
    // fixture; a group is signalled only while that PID still names it.
    let current_group = unsafe { libc::getpgid(process_id) };
    let caller_group = unsafe { libc::getpgrp() };
    if current_group == expected_group && expected_group > 0 && expected_group != caller_group {
        unsafe {
            libc::kill(-expected_group, libc::SIGKILL);
        }
    }
}

fn process_group(process_id: u32) -> libc::pid_t {
    let process_id = i32::try_from(process_id).unwrap();
    // SAFETY: getpgid only reads metadata for the temporary test process.
    let group = unsafe { libc::getpgid(process_id) };
    assert!(group > 0, "temporary descendant has no process group");
    group
}

fn process_session(process_id: u32) -> libc::pid_t {
    let process_id = i32::try_from(process_id).unwrap();
    // SAFETY: getsid only reads metadata for the exact temporary test process.
    let session = unsafe { libc::getsid(process_id) };
    assert!(session > 0, "temporary process has no POSIX session");
    session
}

fn abruptly_kill_test_session(descriptor: &SessionDescriptor) {
    let host_group = exact_owned_process_group(&descriptor.host_process, "Host");
    let provider_group = exact_owned_process_group(&descriptor.provider_process, "provider");
    assert_ne!(
        host_group, provider_group,
        "temporary Host and provider unexpectedly share a process group"
    );

    signal_exact_test_group(&descriptor.host_process, host_group, "Host");
    signal_exact_test_group(&descriptor.provider_process, provider_group, "provider");
    wait_for_process_generation_exit(&descriptor.host_process, "Host");
    wait_for_process_generation_exit(&descriptor.provider_process, "provider");
}

fn exact_owned_process_group(process: &ProcessDescriptor, role: &str) -> libc::pid_t {
    assert!(
        process_generation_is_live(process).unwrap(),
        "temporary {role} generation is not live before fault injection"
    );
    let group = process_group(process.process_id);
    assert_eq!(
        group,
        i32::try_from(process.process_id).unwrap(),
        "temporary {role} is not its process-group leader"
    );
    // SAFETY: getpgrp only reads the current test runner's process group.
    let caller_group = unsafe { libc::getpgrp() };
    assert_ne!(
        group, caller_group,
        "fault injection would target the test runner"
    );
    group
}

struct PausedTestProcessGroup(libc::pid_t);

impl Drop for PausedTestProcessGroup {
    fn drop(&mut self) {
        // SAFETY: this guard is created only after exact generation and
        // process-group ownership checks for a temporary test Host.
        unsafe {
            libc::kill(-self.0, libc::SIGCONT);
        }
    }
}

fn pause_exact_test_group(process: &ProcessDescriptor, role: &str) -> PausedTestProcessGroup {
    let group = exact_owned_process_group(process, role);
    // SAFETY: exact_owned_process_group proved this is a test-owned group and
    // not the caller's process group.
    let result = unsafe { libc::kill(-group, libc::SIGSTOP) };
    assert_eq!(
        result,
        0,
        "could not pause temporary {role} process group: {}",
        std::io::Error::last_os_error()
    );
    PausedTestProcessGroup(group)
}

fn signal_exact_test_group(process: &ProcessDescriptor, expected_group: libc::pid_t, role: &str) {
    if !process_generation_is_live(process).unwrap() {
        return;
    }
    assert_eq!(
        process_group(process.process_id),
        expected_group,
        "temporary {role} process-group ownership changed"
    );
    assert!(
        process_generation_is_live(process).unwrap(),
        "temporary {role} generation changed before fault injection"
    );
    // SAFETY: the exact temporary process generation and its group ownership
    // were revalidated immediately above. The negative PID targets only that
    // test-owned process group.
    if unsafe { libc::kill(-expected_group, libc::SIGKILL) } == 0 {
        return;
    }
    let error = std::io::Error::last_os_error();
    assert!(
        error.raw_os_error() == Some(libc::ESRCH) && !process_generation_is_live(process).unwrap(),
        "could not stop temporary {role} process group: {error}"
    );
}

fn wait_for_process_generation_exit(process: &ProcessDescriptor, role: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if !process_generation_is_live(process).unwrap() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "temporary {role} process generation remained live after fault injection"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn request_from_recipe(recipe: &StandaloneResurrectionRecipe) -> StandaloneCreateRequest {
    StandaloneCreateRequest::new(
        recipe.provider_cwd(),
        Some(recipe.session_name().to_string()),
        recipe.command().to_vec(),
        recipe.initial_rows(),
        recipe.initial_columns(),
    )
    .unwrap()
    .with_resurrection_replay_policy(recipe.resurrection_replay_policy())
    .unwrap()
    .with_terminal_environment(recipe.terminal_environment().clone())
    .unwrap()
    .with_retirement_policy_option(recipe.retirement_policy())
    .unwrap()
}

fn presentation_predecessor(descriptor: &SessionDescriptor) -> PresentationCheckpointPredecessor {
    PresentationCheckpointPredecessor::new(
        descriptor.session_id.clone(),
        descriptor.runner_principal.clone(),
        descriptor.runner_instance.clone(),
        descriptor.channel_epoch.parse().unwrap(),
        descriptor.host_instance_id.clone(),
        descriptor.terminal_epoch.clone(),
    )
    .unwrap()
}

fn recovery_identity_for_source(
    descriptor: &SessionDescriptor,
    target_session_id: &str,
    launch_owner_proof: &str,
) -> StandaloneRecoveryCreateIdentity {
    StandaloneRecoveryCreateIdentity::new(target_session_id, launch_owner_proof)
        .unwrap()
        .with_source_predecessor(presentation_predecessor(descriptor))
        .unwrap()
}

fn assert_replay_contains(session: &hmux_client::LocalSession, expected: &[u8]) {
    let _ = wait_for_replay_snapshot(session, expected);
}

fn wait_for_replay_snapshot(
    session: &hmux_client::LocalSession,
    expected: &[u8],
) -> ScreenSnapshot {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = session.read_screen(None).unwrap();
        if snapshot
            .repaint_bytes
            .windows(expected.len())
            .any(|window| window == expected)
        {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "standalone Host did not replay expected recovery output"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_presentation_checkpoint(
    discovery_root: &std::path::Path,
    descriptor: &SessionDescriptor,
) -> PresentationCheckpoint {
    wait_for_presentation_checkpoint_at_least(discovery_root, descriptor, 1)
}

fn wait_for_presentation_checkpoint_at_least(
    discovery_root: &std::path::Path,
    descriptor: &SessionDescriptor,
    sequence_through: u64,
) -> PresentationCheckpoint {
    let root = DiscoveryRoot::open(discovery_root).unwrap();
    let found = root
        .find_manifest_by_session(&descriptor.workspace_id, &descriptor.session_id)
        .unwrap();
    let DiscoveryManifest::Ready(ready) = found.manifest else {
        panic!("checkpoint source was not Ready")
    };
    let source = PresentationCheckpointSource::from_ready(&ready);
    let discovery = root.open_session(found.key).unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if let Some(checkpoint) = discovery
            .read_presentation_checkpoint(&source)
            .unwrap()
            .filter(|checkpoint| checkpoint.sequence_through() >= sequence_through)
        {
            return checkpoint;
        }
        assert!(
            Instant::now() < deadline,
            "Host did not durably checkpoint its terminal presentation"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_observer_receives(observer: &mut LocalConnection, expected: &[&[u8]]) {
    let mut output = Vec::new();
    loop {
        match observer.read_body().unwrap() {
            FrameBody::OutputDelta(delta) => {
                output.extend_from_slice(&delta.bytes);
                if expected.iter().all(|expected| {
                    output
                        .windows(expected.len())
                        .any(|window| window == *expected)
                }) {
                    return;
                }
            }
            FrameBody::Exit(exit) => {
                panic!("provider exited before observer fanout: {}", exit.reason)
            }
            _ => {}
        }
    }
}

/// A shared writer must stop reaching the PTY once the provider epoch has left
/// `Running`.
///
/// Shared writers used to skip `admit_mutation` entirely, so the Host attempted
/// the PTY write without ever consulting the provider epoch or the fence. This
/// receipt came back `Failed` — the write was tried and the dead PTY rejected
/// it. That the bytes did not land was a property of the PTY, not of any
/// authorization check, which is the point: on a provider *replacement* rather
/// than an exit the PTY is alive and the write lands on the wrong provider.
///
/// The provider waits for an explicit controller command before exiting, and
/// the Host drains existing connections for a bounded interval after broadcasting
/// `Exit`, so neither side of the tested window depends on wall-clock timing.
#[test]
fn shared_writer_input_is_refused_once_the_provider_epoch_ends() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        Some("shared-writer-epoch".into()),
        vec!["/bin/sh".into(), "-s".into()],
        24,
        80,
    )
    .unwrap();
    let created = creator.create(request).unwrap();
    let session = created.session().clone();

    let catalog = LocalSessionCatalog::new(&discovery_root);
    let mut shared_writer = LocalSessionController::connect(
        &catalog,
        &SessionSelector::new(
            session.descriptor().session_id.clone(),
            Some(session.descriptor().workspace_id.clone()),
        ),
        Default::default(),
    )
    .unwrap();

    let exit_request_id = shared_writer
        .mutation_handle()
        .send_input(b"exit\n".to_vec())
        .unwrap();
    loop {
        match shared_writer.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt))
                if receipt.request_id == exit_request_id
                    && receipt.state == ControllerReceiptState::WrittenToPty =>
            {
                break;
            }
            Some(_) => {}
            None => panic!("shared writer disconnected before its exit input receipt"),
        }
    }
    loop {
        match shared_writer.read_event().unwrap() {
            Some(ControllerEvent::Exit(_)) => break,
            Some(_) => {}
            None => panic!("shared writer disconnected before the provider exit"),
        }
    }

    let request_id = shared_writer
        .mutation_handle()
        .send_input(b"after-exit\n".to_vec())
        .unwrap();
    loop {
        match shared_writer.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt)) if receipt.request_id == request_id => {
                assert_eq!(
                    receipt.state,
                    ControllerReceiptState::Refused,
                    "shared writer input reached a PTY whose provider epoch had already ended"
                );
                break;
            }
            Some(_) => {}
            None => panic!("shared writer disconnected before its input receipt"),
        }
    }
}
