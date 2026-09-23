#![cfg(windows)]

#[path = "windows_native_runtime/managed_stop_transport.rs"]
mod managed_stop_transport;

use hmux_client::recovery_journal::managed_create_ledger::{
    ManagedCreateLedgerState, ManagedStartingGeneration, ManagedStartingProviderContainment,
};
use hmux_client::recovery_journal::{managed_create_ledger, request_fingerprint};
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, AgentStateReportOutcome,
    ControllerReceiptState, EndpointKind, LocalProcessGenerationStatus, LocalSessionCatalog,
    LocalSessionObserver, ManagedAgentStateReporter, ManagedCreateFailureDisposition,
    ManagedSessionAttacher, ManagedSessionCreator, ManagedSessionStopper,
    ManagedStopQuiescenceFence, ObserverAttachOptions, ProcessDescriptor, ProviderStateEnvironment,
    SessionLifecycle, SessionSelector, StandaloneSessionCreator, probe_local_process_generation,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_client::{
    CreatedManagedSession, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY, ProviderConversationIdentity,
    SessionFence, TerminalSurfaceAttachment,
};
use hmux_host::local_discovery::{DiscoveryRoot, LocalEndpoint, LocalEndpointKind};
use hmux_runtime_contract::{
    MANAGED_CREATE_BROKER_SUBCOMMAND, MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    ManagedAttachRequest, ManagedCreateGenerationFence, ManagedCreateOutcome,
    ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedStopConversationFence,
    ManagedStopOutcome, ManagedStopRequest, PermissionMode, ProviderConversationIdentitySeed,
    StandaloneCreateRequest, write_json_frame,
};
use std::collections::BTreeMap;
use std::fs;
#[cfg(feature = "terminal-state-stream")]
use std::io::{BufRead, Write};
use std::mem::size_of;
use std::process::{Command, Stdio};
#[cfg(feature = "terminal-state-stream")]
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE, STILL_ACTIVE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE, TerminateProcess,
};

const READY_MARKER: &[u8] = b"WINDOWS_PROVIDER_READY";
const INPUT_MARKER: &[u8] = b"WINDOWS_PROVIDER_ECHO:hello-from-controller";
const WINDOWS_FIXTURE_STATE_DIR_ENV: &str = "WINDOWS_NATIVE_TEST_STATE_DIR";
const ATOMIC_JOB_EXIT_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_CONPTY_ATOMIC_JOB_EXIT_MARKER";
#[cfg(feature = "terminal-state-stream")]
const AGENT_PROMPT_CAPTURE_FILE: &str = "received-prompt.txt";
#[cfg(feature = "terminal-state-stream")]
const AGENT_PROMPT_POST_WAIT_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_AGENT_PROMPT_POST_WAIT_MARKER";
#[cfg(feature = "terminal-state-stream")]
const AGENT_PROMPT_POST_WAIT_RELEASE_ENV: &str = "HMUX_RUNTIME_TEST_AGENT_PROMPT_POST_WAIT_RELEASE";

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched as a direct Codex-shaped ConPTY provider fixture"]
fn process_observed_agent_prompt_fixture_provider() {
    let state = std::env::var_os(WINDOWS_FIXTURE_STATE_DIR_ENV)
        .expect("the direct provider fixture requires its state directory");
    let capture = std::path::Path::new(&state).join(AGENT_PROMPT_CAPTURE_FILE);
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).unwrap() == 0 {
            return;
        }
        let mut output = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&capture)
            .unwrap();
        output.write_all(line.as_bytes()).unwrap();
        output.flush().unwrap();
    }
}

#[test]
#[ignore = "launched as the deterministic provider by the pre-checkpoint recovery test"]
fn managed_windows_precheckpoint_fixture_provider() {
    if let Some(state) = std::env::var_os(WINDOWS_FIXTURE_STATE_DIR_ENV) {
        fs::write(std::path::Path::new(&state).join("provider-spawns"), b"x").unwrap();
        std::thread::sleep(Duration::from_secs(5));
    }
}

fn precheckpoint_fixture_provider_command() -> Vec<String> {
    vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "--ignored".into(),
        "--exact".into(),
        "managed_windows_precheckpoint_fixture_provider".into(),
        "--nocapture".into(),
    ]
}

#[test]
fn suspended_provider_enters_its_kill_on_close_job_at_process_creation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let process_marker = state.path().join("created-provider.json");
    let cwd = state.path().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "windows-atomic-job-create",
        "windows-atomic-job-session",
        "windows-atomic-job-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        precheckpoint_fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            WINDOWS_FIXTURE_STATE_DIR_ENV.into(),
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
        .env(ATOMIC_JOB_EXIT_MARKER_ENV, &process_marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
    drop(broker.stdin.take());

    let deadline = Instant::now() + Duration::from_secs(5);
    let provider = loop {
        if let Ok(encoded) = fs::read(&process_marker) {
            if let Ok(provider) = serde_json::from_slice::<ProcessDescriptor>(&encoded) {
                break provider;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the Host did not reach the post-CreateProcess crash cut"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let provider_exited = loop {
        match probe_local_process_generation(&provider).unwrap() {
            LocalProcessGenerationStatus::Absent => break true,
            LocalProcessGenerationStatus::Live if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            LocalProcessGenerationStatus::Live => break false,
        }
    };
    if !provider_exited {
        terminate_exact_process(&provider);
    }
    if broker.try_wait().unwrap().is_none() {
        broker.kill().unwrap();
    }
    broker.wait().unwrap();
    assert!(
        provider_exited,
        "a Host exit immediately after CreateProcess orphaned its suspended provider"
    );
    assert!(
        !provider_spawns.exists(),
        "the provider must remain suspended until its durable checkpoint"
    );
}

#[test]
fn same_create_retry_waits_for_checkpointed_windows_provider_retirement() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    DiscoveryRoot::create(&discovery_root).unwrap();
    let provider_spawns = state.path().join("provider-spawns");
    let request = ManagedCreateRequest::new(
        "windows-checkpointed-retry-create",
        "windows-checkpointed-retry-session",
        "windows-checkpointed-retry-workspace",
        "fixture",
        PermissionMode::Default,
        state.path().canonicalize().unwrap(),
        precheckpoint_fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            WINDOWS_FIXTURE_STATE_DIR_ENV.into(),
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let canonical = request.canonical_create_identity_json().unwrap();
    let digest = request_fingerprint(&[&canonical]);
    let ManagedCreateLedgerState::Prepared(mut reservation) = managed_create_ledger::reserve(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
        request.idempotency_key(),
        &digest,
    )
    .unwrap() else {
        panic!("the isolated create identity must reserve once")
    };
    reservation.checkpoint_pre_spawn_absence().unwrap();

    let process_id = std::process::id();
    let provider_start = process_creation_filetime(process_id).unwrap();
    let provider_process = ProcessDescriptor {
        process_id,
        start_marker: format!("windows-proc-start-v1:{provider_start}"),
    };
    let host_process = ProcessDescriptor {
        process_id,
        start_marker: format!("windows-proc-start-v1:{}", provider_start + 1),
    };
    reservation
        .mark_spawn_reserved(host_process.clone())
        .unwrap();
    reservation.release_with_barrier_proof().unwrap();
    let generation = ManagedStartingGeneration::new(
        request.idempotency_key(),
        host_process,
        provider_process,
        ManagedCreateGenerationFence::new(
            "windows-test-principal",
            "windows-test-runner",
            1,
            "windows-test-host",
            "windows-test-terminal",
        )
        .unwrap(),
        LocalEndpoint {
            kind: LocalEndpointKind::WindowsNamedPipe,
            address: r"\\.\pipe\hmux-checkpointed-retry".into(),
        },
        "windows-test-capability",
        None,
    )
    .unwrap()
    .with_provider_containment(ManagedStartingProviderContainment::WindowsKillOnJobCloseV1)
    .unwrap();
    managed_create_ledger::checkpoint_starting_generation_exact(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
        request.idempotency_key(),
        generation,
    )
    .unwrap();
    drop(reservation);

    let error = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(request)
        .expect_err("a live checkpointed provider must keep exact retry pending");
    assert_eq!(
        error.disposition(),
        ManagedCreateFailureDisposition::Retryable
    );
    assert!(
        !provider_spawns.exists(),
        "same-create retry must not spawn before exact Job containment retirement"
    );
}

#[test]
fn standalone_windows_native_runtime_round_trips_resizes_replays_and_retires_job() {
    eprintln!("windows-native-stage standalone:fixture");
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let request = StandaloneCreateRequest::new(
        state.path().canonicalize().unwrap(),
        Some("windows-native-smoke".into()),
        Vec::new(),
        24,
        80,
    )
    .unwrap();
    eprintln!("windows-native-stage standalone:create");
    let mut created = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(&discovery_root)
        .create(request)
        .expect("Windows native Hmux creation must publish a ready named-pipe Host");
    eprintln!("windows-native-stage standalone:created");
    let session = created.session().clone();
    let descriptor = session.descriptor().clone();
    assert_eq!(descriptor.endpoint.kind, EndpointKind::WindowsNamedPipe);
    assert_eq!(
        probe_local_process_generation(&descriptor.host_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );

    let mut controller = created.connect_controller().unwrap_or_else(|error| {
        panic!(
            "connect to created standalone Host: {error}; discovery observation: {:?}",
            LocalSessionCatalog::new(&discovery_root).find(&SessionSelector::new(
                descriptor.session_id.clone(),
                Some(descriptor.workspace_id.clone()),
            ))
        )
    });
    eprintln!("windows-native-stage standalone:first-input");
    send_shell_command(&mut controller, b"echo WINDOWS_PROVIDER_READY\r\n");
    wait_for_snapshot(&session, READY_MARKER, (24, 80));
    eprintln!("windows-native-stage standalone:first-snapshot-ready");
    let input = controller
        .send_input_confirmed(
            b"echo WINDOWS_PROVIDER_ECHO:hello-from-controller\r\n".to_vec(),
            Duration::from_secs(3),
        )
        .unwrap();
    assert_eq!(input.state, ControllerReceiptState::WrittenToPty);

    let resize_id = controller.mutation_handle().resize(31, 101).unwrap();
    controller
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    loop {
        match controller.read_event().unwrap() {
            Some(hmux_client::ControllerEvent::ResizeReceipt(receipt))
                if receipt.request_id == resize_id =>
            {
                assert_eq!(receipt.state, ControllerReceiptState::AppliedToTerminal);
                assert_eq!((receipt.rows, receipt.columns), (Some(31), Some(101)));
                break;
            }
            Some(_) => {}
            None => panic!("Windows controller detached before its resize receipt"),
        }
    }
    send_shell_command(&mut controller, b"ping.exe -t 127.0.0.1 >nul\r\n");
    let descendant = wait_for_child_process(descriptor.provider_process.process_id, "ping.exe");
    controller.detach().unwrap();

    // A fresh attach must reconstruct both prior output and the latest PTY
    // dimensions from Host-owned replay state.
    wait_for_snapshot(&session, INPUT_MARKER, (31, 101));

    let catalog = LocalSessionCatalog::new(&discovery_root);
    let selector = SessionSelector::new(
        descriptor.session_id.clone(),
        Some(descriptor.workspace_id.clone()),
    );
    session
        .terminate_standalone(&catalog, Duration::from_secs(5))
        .expect("Host-owned termination must close the complete provider Job");
    assert_eq!(
        catalog
            .find(&selector)
            .expect("termination must publish its authoritative Exited generation")
            .lifecycle,
        SessionLifecycle::Exited,
    );
    wait_for_process_generation_exit(descendant);
    let retirement_deadline = Instant::now() + Duration::from_secs(5);
    while catalog.find(&selector).is_ok() {
        assert!(
            Instant::now() < retirement_deadline,
            "terminated standalone generation remained in discovery after its exit grace"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn managed_windows_native_runtime_is_idempotent_attachable_and_stoppable() {
    eprintln!("windows-native-stage managed:fixture");
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let request = ManagedCreateRequest::new(
        "windows-managed-create-1",
        "windows-managed-session-1",
        "windows-managed-workspace-1",
        "local-shell",
        PermissionMode::Default,
        state.path().canonicalize().unwrap(),
        windows_shell_command(),
        25,
        90,
    )
    .unwrap()
    .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("local-shell", "windows-conversation-1").unwrap(),
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    eprintln!("windows-native-stage managed:create");
    let created = creator.create(request.clone()).unwrap();
    eprintln!("windows-native-stage managed:created");
    assert_eq!(created.receipt().outcome(), ManagedCreateOutcome::Created);
    let generation = created.receipt().generation_fence().unwrap().clone();
    let descriptor = created.session().descriptor().clone();
    assert_eq!(descriptor.endpoint.kind, EndpointKind::WindowsNamedPipe);
    assert!(
        descriptor
            .capabilities
            .iter()
            .any(|capability| { capability == "managed_provider_conversation_fenced_stop_v1" })
    );
    assert!(
        descriptor
            .capabilities
            .iter()
            .any(|capability| capability == "managed_provider_quiescent_stop_v1")
    );
    assert!(
        descriptor
            .capabilities
            .iter()
            .any(|capability| capability == "agent_state_report_v1")
    );
    eprintln!("windows-native-stage managed:first-input");
    let mut initial_controller = ManagedSessionAttacher::new(runtime, state.path())
        .with_discovery_root(&discovery_root)
        .attach(
            ManagedAttachRequest::new(
                descriptor.session_id.clone(),
                descriptor.workspace_id.clone(),
            )
            .unwrap(),
        )
        .unwrap_or_else(|error| {
            panic!(
                "attach to created managed Host: {error}; discovery observation: {:?}",
                LocalSessionCatalog::new(&discovery_root).find(&SessionSelector::new(
                    descriptor.session_id.clone(),
                    Some(descriptor.workspace_id.clone()),
                ))
            )
        });
    send_shell_command(&mut initial_controller, b"echo WINDOWS_PROVIDER_READY\r\n");
    initial_controller.detach().unwrap();
    wait_for_snapshot(created.session(), READY_MARKER, (25, 90));
    eprintln!("windows-native-stage managed:first-snapshot-ready");

    let reused = creator.create(request).unwrap();
    assert_eq!(reused.receipt().outcome(), ManagedCreateOutcome::Reused);
    assert_eq!(
        reused.receipt().generation_fence(),
        Some(&generation),
        "an idempotent managed create must retain the exact Host generation"
    );

    let mut controller = ManagedSessionAttacher::new(runtime, state.path())
        .with_discovery_root(&discovery_root)
        .attach(
            ManagedAttachRequest::new(
                descriptor.session_id.clone(),
                descriptor.workspace_id.clone(),
            )
            .unwrap(),
        )
        .unwrap();
    let input = controller
        .send_input_confirmed(
            b"echo WINDOWS_PROVIDER_ECHO:hello-from-controller\r\n".to_vec(),
            Duration::from_secs(3),
        )
        .unwrap();
    assert_eq!(input.state, ControllerReceiptState::WrittenToPty);
    controller.detach().unwrap();
    wait_for_snapshot(reused.session(), INPUT_MARKER, (25, 90));

    let reporter =
        ManagedAgentStateReporter::new(runtime, state.path()).with_discovery_root(&discovery_root);
    let report_waiting = || AgentStateReport {
        identity_only: false,
        activity: AgentRuntimeActivity::Waiting,
        attention: AgentRuntimeAttention::None,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        conversation_identity: None,
        expected_observation: None,
    };
    assert!(matches!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(
                    descriptor.session_id.clone(),
                    descriptor.workspace_id.clone(),
                )
                .unwrap(),
                report_waiting(),
            )
            .unwrap(),
        AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
    ));
    let stale_quiescence = observe_quiescence(&discovery_root, &descriptor);

    let mut changed_controller = ManagedSessionAttacher::new(runtime, state.path())
        .with_discovery_root(&discovery_root)
        .attach(
            ManagedAttachRequest::new(
                descriptor.session_id.clone(),
                descriptor.workspace_id.clone(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        changed_controller
            .send_input_confirmed(
                b"echo WINDOWS_STOP_FENCE_CHANGED\r\n".to_vec(),
                Duration::from_secs(3),
            )
            .unwrap()
            .state,
        ControllerReceiptState::WrittenToPty,
    );
    changed_controller.detach().unwrap();

    let stop = ManagedStopRequest::new(
        "windows-managed-stop-1",
        descriptor.session_id.clone(),
        descriptor.workspace_id.clone(),
    )
    .unwrap()
    .with_expected_fence(
        generation.runner_principal(),
        generation.runner_instance(),
        generation.channel_epoch(),
        generation.host_instance_id(),
        generation.terminal_epoch(),
    )
    .unwrap()
    .with_expected_conversation(
        ManagedStopConversationFence::new("local-shell", Some("windows-conversation-1".into()))
            .unwrap(),
    )
    .unwrap();
    let stopper =
        ManagedSessionStopper::new(runtime, state.path()).with_discovery_root(&discovery_root);
    let stale = ManagedStopRequest::new(
        "windows-managed-stop-stale-quiescence",
        descriptor.session_id.clone(),
        descriptor.workspace_id.clone(),
    )
    .unwrap()
    .with_expected_fence(
        generation.runner_principal(),
        generation.runner_instance(),
        generation.channel_epoch(),
        generation.host_instance_id(),
        generation.terminal_epoch(),
    )
    .unwrap()
    .with_expected_conversation(
        ManagedStopConversationFence::new("local-shell", Some("windows-conversation-1".into()))
            .unwrap(),
    )
    .unwrap()
    .with_expected_quiescence(stale_quiescence)
    .unwrap();
    let refused = stopper.stop(stale).unwrap_err();
    assert_eq!(refused.code(), "hmux_managed_stop_refused");
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                descriptor.session_id.clone(),
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready,
        "input that wins the Host lock must invalidate the quiescence fence without stopping",
    );

    let changed = ManagedStopRequest::new(
        "windows-managed-stop-changed",
        descriptor.session_id.clone(),
        descriptor.workspace_id.clone(),
    )
    .unwrap()
    .with_expected_fence(
        generation.runner_principal(),
        generation.runner_instance(),
        generation.channel_epoch(),
        generation.host_instance_id(),
        generation.terminal_epoch(),
    )
    .unwrap()
    .with_expected_conversation(
        ManagedStopConversationFence::new("local-shell", Some("windows-conversation-other".into()))
            .unwrap(),
    )
    .unwrap();
    let refused = stopper.stop(changed).unwrap_err();
    assert_eq!(refused.code(), "hmux_managed_stop_refused");
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                descriptor.session_id.clone(),
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready,
        "an exact conversation race is a definitive pre-effect refusal on Windows"
    );
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(
                    descriptor.session_id.clone(),
                    descriptor.workspace_id.clone(),
                )
                .unwrap(),
                report_waiting(),
            )
            .unwrap(),
        AgentStateReportOutcome::Applied,
    );
    let fresh_quiescence = observe_quiescence(&discovery_root, &descriptor);
    let stop = stop.with_expected_quiescence(fresh_quiescence).unwrap();
    let mut losing_controller = ManagedSessionAttacher::new(runtime, state.path())
        .with_discovery_root(&discovery_root)
        .attach(
            ManagedAttachRequest::new(
                descriptor.session_id.clone(),
                descriptor.workspace_id.clone(),
            )
            .unwrap(),
        )
        .unwrap();
    let stopped = stopper.stop(stop.clone()).unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
    assert!(
        losing_controller
            .send_input_confirmed(
                b"echo MUST_NOT_REACH_PTY\r\n".to_vec(),
                Duration::from_secs(3)
            )
            .is_err(),
        "stop that wins the Host lock must prevent a later controller write",
    );
    let replayed = stopper.stop(stop).unwrap();
    assert_eq!(
        replayed, stopped,
        "managed stop must replay its durable receipt"
    );
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                descriptor.session_id,
                Some(descriptor.workspace_id),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Exited,
    );
}

#[cfg(feature = "terminal-state-stream")]
struct WindowsAgentPromptFixture {
    _state: tempfile::TempDir,
    created: CreatedManagedSession,
    cwd: std::path::PathBuf,
    discovery_root: std::path::PathBuf,
    expected_fence: SessionFence,
    received_prompt: std::path::PathBuf,
    runtime: &'static str,
}

#[cfg(feature = "terminal-state-stream")]
fn windows_agent_prompt_capture_command(line: &str) -> String {
    let capture = format!("%{WINDOWS_FIXTURE_STATE_DIR_ENV}%\\{AGENT_PROMPT_CAPTURE_FILE}");
    format!("echo {line}>>\"{capture}\"")
}

#[cfg(feature = "terminal-state-stream")]
impl WindowsAgentPromptFixture {
    fn new(label: &str) -> Self {
        Self::with_command(label, tempfile::tempdir().unwrap(), windows_shell_command())
    }

    fn process_observed(label: &str) -> Self {
        let state = tempfile::tempdir().unwrap();
        let provider = state.path().join("CoDeX.EXE");
        fs::copy(std::env::current_exe().unwrap(), &provider).unwrap();
        Self::with_command(
            label,
            state,
            vec![
                provider.to_string_lossy().into_owned(),
                "--ignored".into(),
                "--exact".into(),
                "process_observed_agent_prompt_fixture_provider".into(),
                "--nocapture".into(),
            ],
        )
    }

    fn with_command(label: &str, state: tempfile::TempDir, command: Vec<String>) -> Self {
        let discovery_root = state.path().join("discovery");
        let received_prompt = state.path().join(AGENT_PROMPT_CAPTURE_FILE);
        let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
        let cwd = state.path().canonicalize().unwrap();
        let session_id = format!("windows-{label}");
        let workspace_id = format!("windows-workspace-{label}");
        let create_id = format!("windows-{label}-create");
        let provider_state_environment = ProviderStateEnvironment::new(BTreeMap::from([(
            WINDOWS_FIXTURE_STATE_DIR_ENV.into(),
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap();
        let created = ManagedSessionCreator::new(runtime)
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    create_id,
                    session_id,
                    workspace_id,
                    "codex",
                    PermissionMode::Default,
                    &cwd,
                    command,
                    24,
                    80,
                )
                .unwrap()
                .with_provider_state_environment(provider_state_environment)
                .unwrap(),
            )
            .unwrap();
        let descriptor = created.session().descriptor();
        let expected_fence = SessionFence {
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        Self {
            _state: state,
            created,
            cwd,
            discovery_root,
            expected_fence,
            received_prompt,
            runtime,
        }
    }

    fn surface(&self) -> TerminalSurfaceAttachment {
        TerminalSurfaceAttachment::connect_local_agent_prompt(
            &LocalSessionCatalog::new(&self.discovery_root),
            &self.expected_fence,
        )
        .unwrap()
    }

    fn report_waiting(&self, conversation_id: &str) {
        let descriptor = self.created.session().descriptor();
        let reported = ManagedAgentStateReporter::new(self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .report_agent_state(
                ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                    .unwrap(),
                AgentStateReport {
                    identity_only: false,
                    activity: AgentRuntimeActivity::Waiting,
                    attention: AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: Some(ProviderConversationIdentity {
                        provider_id: "codex".into(),
                        conversation_id: conversation_id.into(),
                        previous_conversation_id: None,
                        expected_fence: Some(self.expected_fence.clone()),
                    }),
                    expected_observation: None,
                },
            )
            .unwrap();
        assert_eq!(reported, AgentStateReportOutcome::Applied);
    }

    fn wait_for_captured_prompt_lines(&self, expected_line_count: usize) -> String {
        // ConPTY can echo submitted command text before cmd.exe executes it, so
        // the capture file is the completion authority rather than screen text.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let received = match fs::read_to_string(&self.received_prompt) {
                Ok(received) => received,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => panic!("failed to read captured Windows prompts: {error}"),
            };
            if received.ends_with('\n') && received.lines().count() >= expected_line_count {
                return received;
            }
            assert!(
                Instant::now() < deadline,
                "Windows provider captured fewer than {expected_line_count} prompt lines: {received:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn stop(&self, label: &str) {
        let descriptor = self.created.session().descriptor();
        let stop = ManagedStopRequest::new(
            format!("windows-{label}-stop"),
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
        let stopped = ManagedSessionStopper::new(self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(stop)
            .unwrap();
        assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn shell_wrapped_provider_uses_the_rolling_fresh_prompt_wire_shape_on_windows() {
    let fixture = WindowsAgentPromptFixture::new("shell-wrapped-fresh");
    assert!(
        !fixture
            .created
            .session()
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY),
        "a shell wrapper must not advertise direct process identity"
    );
    fixture.report_waiting("shell-wrapped-conversation");

    let mut surface = fixture.surface();
    surface
        .send_process_observed_fresh_agent_prompt_confirmed(
            windows_agent_prompt_capture_command("SHELL_WRAPPED_FRESH"),
            Duration::from_secs(3),
        )
        .expect("the client must use the Host's older provider-event fresh target");
    surface.detach().unwrap();

    let deadline = Instant::now() + Duration::from_secs(3);
    while !fixture.received_prompt.exists() {
        assert!(
            Instant::now() < deadline,
            "shell-wrapped provider did not receive the compatible fresh prompt"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        fs::read_to_string(&fixture.received_prompt)
            .unwrap()
            .contains("SHELL_WRAPPED_FRESH")
    );
    fixture.stop("shell-wrapped-fresh");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn process_observed_fresh_agent_prompt_writes_once_on_native_windows() {
    let fixture = WindowsAgentPromptFixture::process_observed("process-observed-fresh");
    assert!(
        fixture
            .created
            .session()
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY),
        "a direct provider executable must advertise process-observed prompt authority"
    );

    let mut strict = fixture.surface();
    let strict_error = strict
        .send_fresh_agent_prompt_confirmed(
            "STRICT_MUST_NOT_WRITE".into(),
            Duration::from_millis(150),
        )
        .expect_err("ordinary FreshAgent must still require provider-event identity");
    assert_eq!(strict_error.delivery_state(), "not_written");
    strict.detach().unwrap();
    assert!(!fixture.received_prompt.exists());

    let first = fixture.surface();
    let second = fixture.surface();
    let barrier = Arc::new(Barrier::new(2));
    let send = |mut surface: TerminalSurfaceAttachment,
                barrier: Arc<Barrier>,
                prompt: &'static str| {
        std::thread::spawn(move || {
            barrier.wait();
            let result = surface
                .send_process_observed_fresh_agent_prompt_confirmed(
                    prompt.into(),
                    Duration::from_secs(3),
                )
                .map(|receipt| receipt.input().in_reply_to_record_id)
                .map_err(|error| (error.code().to_string(), error.delivery_state().to_string()));
            surface.detach().unwrap();
            result
        })
    };
    let first = send(first, Arc::clone(&barrier), "PROCESS_FIRST");
    let second = send(second, barrier, "PROCESS_SECOND");
    let outcomes = [first.join().unwrap(), second.join().unwrap()];

    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    let refusal = outcomes
        .iter()
        .find_map(|outcome| outcome.as_ref().err())
        .expect("one concurrent initial prompt must be refused before writing");
    assert_eq!(refusal.0, "hmux_agent_prompt_runtime_changed");
    assert_eq!(refusal.1, "not_written");

    let deadline = Instant::now() + Duration::from_secs(3);
    while !fixture.received_prompt.exists() {
        assert!(
            Instant::now() < deadline,
            "direct provider received no prompt"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let received = fs::read_to_string(&fixture.received_prompt).unwrap();
    let lines = received.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1, "unexpected direct ConPTY writes: {lines:?}");
    assert!(matches!(lines[0], "PROCESS_FIRST" | "PROCESS_SECOND"));

    fixture.stop("process-observed-fresh");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn concurrent_managed_fresh_agent_prompts_produce_one_windows_conpty_write() {
    let fixture = WindowsAgentPromptFixture::new("atomic-fresh-agent-prompt");
    let descriptor = fixture.created.session().descriptor();
    let first = fixture.surface();
    let second = fixture.surface();
    let barrier = Arc::new(Barrier::new(2));
    let send = |mut surface: TerminalSurfaceAttachment, barrier: Arc<Barrier>, prompt: String| {
        std::thread::spawn(move || {
            barrier.wait();
            let outcome = surface.send_fresh_agent_prompt_confirmed(prompt, Duration::from_secs(3));
            let projected = match outcome {
                Ok(receipt) => Ok((
                    receipt.input().in_reply_to_record_id,
                    receipt
                        .admitted_agent_runtime_revision()
                        .expect("targeted prompt receipt must carry its runtime revision"),
                )),
                Err(error) => Err((error.code().to_string(), error.delivery_state().to_string())),
            };
            surface.detach().unwrap();
            projected
        })
    };
    let first = send(
        first,
        Arc::clone(&barrier),
        windows_agent_prompt_capture_command("FIRST"),
    );
    let second = send(
        second,
        barrier,
        windows_agent_prompt_capture_command("SECOND"),
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        !fixture.received_prompt.exists(),
        "the Windows Host must not write before provider-event startup authority"
    );
    fixture.report_waiting("windows-conversation-atomic-fresh-agent-prompt");
    let outcomes = [first.join().unwrap(), second.join().unwrap()];

    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    let refusal = outcomes
        .iter()
        .find_map(|outcome| outcome.as_ref().err())
        .expect("one concurrent initial prompt must be refused before writing");
    assert_eq!(refusal.0, "hmux_agent_prompt_runtime_changed");
    assert_eq!(refusal.1, "not_written");

    let mut drain = ManagedSessionAttacher::new(fixture.runtime, &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root)
        .attach(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
        )
        .unwrap();
    let drain_command = format!("{}\r\n", windows_agent_prompt_capture_command("DRAIN"));
    send_shell_command(&mut drain, drain_command.as_bytes());
    drain.detach().unwrap();
    let received = fixture.wait_for_captured_prompt_lines(2);
    let received = received.lines().collect::<Vec<_>>();
    assert_eq!(received.len(), 2, "unexpected ConPTY writes: {received:?}");
    assert!(matches!(received[0], "FIRST" | "SECOND"));
    assert_eq!(received[1], "DRAIN");

    fixture.stop("atomic-fresh-agent-prompt");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn existing_conversation_agent_prompt_requires_exact_idle_identity_and_rearms_on_windows() {
    let fixture = WindowsAgentPromptFixture::new("existing-conversation");
    let conversation_id = "windows-conversation-existing";
    fixture.report_waiting(conversation_id);

    let mut mismatched = fixture.surface();
    let wrong =
        ProviderConversationIdentitySeed::new("codex", "windows-conversation-other").unwrap();
    let error = mismatched
        .send_existing_idle_agent_prompt_confirmed(
            windows_agent_prompt_capture_command("MUST_NOT_WRITE"),
            &wrong,
            Duration::from_secs(3),
        )
        .expect_err("a mismatched Windows conversation must be refused before ConPTY mutation");
    assert_eq!(error.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(error.delivery_state(), "not_written");
    mismatched.detach().unwrap();
    assert!(!fixture.received_prompt.exists());

    let expected = ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap();
    let first = fixture.surface();
    let second = fixture.surface();
    let barrier = Arc::new(Barrier::new(2));
    let send = |mut surface: TerminalSurfaceAttachment,
                barrier: Arc<Barrier>,
                expected: ProviderConversationIdentitySeed,
                prompt: String,
                label: &'static str| {
        std::thread::spawn(move || {
            barrier.wait();
            let outcome = surface
                .send_existing_idle_agent_prompt_confirmed(
                    prompt,
                    &expected,
                    Duration::from_secs(3),
                )
                .map(|receipt| {
                    (
                        label,
                        receipt
                            .admitted_agent_runtime_revision()
                            .expect("targeted prompt receipt must carry its runtime revision"),
                    )
                })
                .map_err(|error| (error.code().to_string(), error.delivery_state().to_string()));
            surface.detach().unwrap();
            outcome
        })
    };
    let first = send(
        first,
        Arc::clone(&barrier),
        expected.clone(),
        windows_agent_prompt_capture_command("EXISTING_FIRST"),
        "EXISTING_FIRST",
    );
    let second = send(
        second,
        barrier,
        expected.clone(),
        windows_agent_prompt_capture_command("EXISTING_SECOND"),
        "EXISTING_SECOND",
    );
    let outcomes = [first.join().unwrap(), second.join().unwrap()];
    let (written_label, first_revision) = outcomes
        .iter()
        .find_map(|outcome| outcome.as_ref().ok())
        .expect("one exact Windows prompt must reserve the idle runtime");
    let refused = outcomes
        .iter()
        .find_map(|outcome| outcome.as_ref().err())
        .expect("the competing exact Windows prompt must be refused before ConPTY mutation");
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(refused.0, "hmux_agent_prompt_runtime_changed");
    assert_eq!(refused.1, "not_written");
    assert_eq!(
        fixture
            .wait_for_captured_prompt_lines(1)
            .lines()
            .collect::<Vec<_>>(),
        [*written_label]
    );

    let mut repeated = fixture.surface();
    let error = repeated
        .send_existing_idle_agent_prompt_confirmed(
            windows_agent_prompt_capture_command("MUST_REMAIN_ONE_SHOT"),
            &expected,
            Duration::from_secs(3),
        )
        .expect_err("controller-owned working state must consume the Windows idle admission");
    assert_eq!(error.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(error.delivery_state(), "not_written");
    repeated.detach().unwrap();

    fixture.report_waiting(conversation_id);
    let mut rearmed = fixture.surface();
    let second_receipt = rearmed
        .send_existing_idle_agent_prompt_confirmed(
            windows_agent_prompt_capture_command("AFTER_REARM"),
            &expected,
            Duration::from_secs(3),
        )
        .unwrap();
    assert!(
        second_receipt
            .admitted_agent_runtime_revision()
            .expect("targeted prompt receipt must carry its runtime revision")
            > *first_revision
    );
    rearmed.detach().unwrap();
    assert_eq!(
        fixture
            .wait_for_captured_prompt_lines(2)
            .lines()
            .collect::<Vec<_>>(),
        [*written_label, "AFTER_REARM"]
    );

    fixture.stop("existing-conversation");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
#[ignore = "launched with an isolated post-wait pause by the parent regression test"]
fn fresh_agent_prompt_timeout_stays_not_written_after_runtime_becomes_ready_fixture() {
    let marker = std::env::var_os(AGENT_PROMPT_POST_WAIT_MARKER_ENV)
        .map(std::path::PathBuf::from)
        .expect("post-wait marker is required");
    let release = std::env::var_os(AGENT_PROMPT_POST_WAIT_RELEASE_ENV)
        .map(std::path::PathBuf::from)
        .expect("post-wait release is required");
    let fixture = WindowsAgentPromptFixture::new("post-wait-runtime-change");
    let descriptor = fixture.created.session().descriptor();
    let mut surface = fixture.surface();
    let prompt_timeout = Duration::from_secs(5);
    let sender = std::thread::spawn(move || {
        let outcome = surface.send_fresh_agent_prompt_confirmed(
            windows_agent_prompt_capture_command("LATE"),
            prompt_timeout,
        );
        surface.detach().unwrap();
        outcome
    });

    let deadline = Instant::now() + prompt_timeout + Duration::from_secs(2);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "the Windows Host did not reach the post-wait publication boundary"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fs::read_to_string(&marker).unwrap(), "TimedOut");
    assert!(
        !fixture.received_prompt.exists(),
        "a timed-out initial prompt reached ConPTY before publication"
    );

    fixture.report_waiting("windows-conversation-post-wait-runtime-change");
    fs::write(&release, b"release").unwrap();

    let error = sender
        .join()
        .unwrap()
        .expect_err("the final timeout outcome must remain not-written");
    assert_eq!(error.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(error.delivery_state(), "not_written");

    let mut drain = ManagedSessionAttacher::new(fixture.runtime, &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root)
        .attach(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
        )
        .unwrap();
    let drain_command = format!("{}\r\n", windows_agent_prompt_capture_command("DRAIN"));
    send_shell_command(&mut drain, drain_command.as_bytes());
    drain.detach().unwrap();
    assert_eq!(
        fixture
            .wait_for_captured_prompt_lines(1)
            .lines()
            .collect::<Vec<_>>(),
        ["DRAIN"],
        "only the later ordinary command may reach ConPTY"
    );

    fixture.stop("post-wait-runtime-change");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn fresh_agent_prompt_timeout_stays_not_written_after_runtime_becomes_ready() {
    let state = tempfile::tempdir().unwrap();
    let marker = state.path().join("post-wait.marker");
    let release = state.path().join("post-wait.release");
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--ignored")
        .arg("--exact")
        .arg("fresh_agent_prompt_timeout_stays_not_written_after_runtime_becomes_ready_fixture")
        .arg("--nocapture")
        .env(AGENT_PROMPT_POST_WAIT_MARKER_ENV, &marker)
        .env(AGENT_PROMPT_POST_WAIT_RELEASE_ENV, &release)
        .status()
        .unwrap();

    assert!(
        status.success(),
        "post-wait Windows agent-prompt fixture failed with {status}"
    );
}

#[test]
fn managed_windows_chain_stop_closes_and_replays_the_create_root() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let root = ManagedCreateReconcileRequest::new(
        "windows-managed-chain-create-1",
        "windows-managed-chain-session-1",
        "windows-managed-chain-workspace-1",
    )
    .unwrap();
    let create = ManagedCreateRequest::new(
        root.idempotency_key(),
        root.session_id(),
        root.workspace_id(),
        "local-shell",
        PermissionMode::Default,
        state.path().canonicalize().unwrap(),
        windows_shell_command(),
        25,
        90,
    )
    .unwrap()
    .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("local-shell", "windows-chain-conversation-1")
            .unwrap(),
    )
    .unwrap();
    ManagedSessionCreator::new(runtime)
        .with_discovery_root(&discovery_root)
        .create(create)
        .expect("Windows managed generation must start");
    let stopper =
        ManagedSessionStopper::new(runtime, state.path()).with_discovery_root(&discovery_root);

    let stopped = stopper
        .stop_create_chain(root.clone())
        .expect("Windows runtime must close and stop the create chain");
    assert_eq!(stopped.root(), &root);
    assert_eq!(stopped.effective(), &root);
    assert_eq!(
        stopped
            .stop_receipt()
            .expect("the completed generation must have a stop receipt")
            .outcome(),
        ManagedStopOutcome::Stopped,
    );
    assert_eq!(
        stopper.stop_create_chain(root).unwrap(),
        stopped,
        "Windows chain-stop retry must replay the durable final receipt",
    );
}

#[test]
fn managed_windows_chain_stop_converges_every_precheckpoint_host_cut() {
    for (phase, suffix) in [
        ("host_starting_published", "starting"),
        ("before_provider_spawn", "before-provider"),
        ("provider_spawned_before_checkpoint", "provider-suspended"),
    ] {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let provider_spawns = state.path().join("provider-spawns");
        let cut_marker = state.path().join(format!("{suffix}-cut"));
        let cwd = state.path().canonicalize().unwrap();
        let request = ManagedCreateRequest::new(
            format!("windows-precheckpoint-create-{suffix}"),
            format!("windows-precheckpoint-session-{suffix}"),
            "windows-precheckpoint-workspace",
            "fixture",
            PermissionMode::Default,
            &cwd,
            precheckpoint_fixture_provider_command(),
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                WINDOWS_FIXTURE_STATE_DIR_ENV.into(),
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
            .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE", phase)
            .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER", &cut_marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
        drop(broker.stdin.take());

        let deadline = Instant::now() + Duration::from_secs(5);
        while !cut_marker.exists() {
            assert!(
                Instant::now() < deadline,
                "managed Host did not reach {phase}"
            );
            assert!(
                broker.try_wait().unwrap().is_none(),
                "managed create broker exited before {phase}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            broker.wait().unwrap().success(),
            "the broker must durably report the abrupt Host failure"
        );
        assert!(
            managed_create_ledger::starting_generation(
                &discovery_root,
                request.workspace_id(),
                request.session_id(),
            )
            .unwrap()
            .is_none(),
            "{phase} must precede the exact provider checkpoint"
        );
        assert!(
            !provider_spawns.exists(),
            "the Windows provider executed before its durable checkpoint"
        );

        let root = ManagedCreateReconcileRequest::new(
            request.idempotency_key(),
            request.session_id(),
            request.workspace_id(),
        )
        .unwrap();
        let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root);
        let closed = stopper
            .stop_create_chain_v2(root.clone())
            .expect("Windows chain-stop must retire provider-unreleased Starting");
        assert_eq!(closed.chain(), &[root.clone()]);
        assert!(closed.stop_receipt().is_none());
        assert_eq!(stopper.stop_create_chain_v2(root).unwrap(), closed);
        assert!(
            !provider_spawns.exists(),
            "Windows reconciliation must not release the suspended provider"
        );
    }
}

#[test]
fn managed_windows_stop_refuses_wrong_provider_for_fresh_conversation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let created = ManagedSessionCreator::new(runtime)
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "windows-provider-fence-create",
                "windows-provider-fence-session",
                "windows-provider-fence-workspace",
                "local-shell",
                PermissionMode::Default,
                state.path().canonicalize().unwrap(),
                windows_shell_command(),
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    let generation = created.receipt().generation_fence().unwrap();
    let request = |stop_id: &str, provider_id: &str| {
        ManagedStopRequest::new(
            stop_id,
            descriptor.session_id.clone(),
            descriptor.workspace_id.clone(),
        )
        .unwrap()
        .with_expected_fence(
            generation.runner_principal(),
            generation.runner_instance(),
            generation.channel_epoch(),
            generation.host_instance_id(),
            generation.terminal_epoch(),
        )
        .unwrap()
        .with_expected_conversation(ManagedStopConversationFence::new(provider_id, None).unwrap())
        .unwrap()
    };
    let stopper =
        ManagedSessionStopper::new(runtime, state.path()).with_discovery_root(&discovery_root);

    let refused = stopper
        .stop(request("windows-provider-fence-wrong", "other-provider"))
        .unwrap_err();
    assert_eq!(refused.code(), "hmux_managed_stop_refused");
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                descriptor.session_id.clone(),
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready,
        "exact conversation absence must not authorize a stop for another provider",
    );

    let stopped = stopper
        .stop(request("windows-provider-fence-matching", "local-shell"))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}

fn observe_quiescence(
    discovery_root: &std::path::Path,
    descriptor: &hmux_client::SessionDescriptor,
) -> ManagedStopQuiescenceFence {
    let observer = LocalSessionObserver::connect(
        &LocalSessionCatalog::new(discovery_root),
        &SessionSelector::new(
            descriptor.session_id.clone(),
            Some(descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let snapshot = &observer.attachment().initial_snapshot;
    let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(runtime.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(runtime.attention, AgentRuntimeAttention::None);
    let fence = ManagedStopQuiescenceFence::new(
        runtime.terminal_epoch.clone(),
        runtime.revision.parse().unwrap(),
        snapshot.sequence_through.parse().unwrap(),
    )
    .unwrap();
    observer.detach().unwrap();
    fence
}

fn send_shell_command(controller: &mut hmux_client::LocalSessionController, command: &[u8]) {
    let receipt = controller
        .send_input_confirmed(command.to_vec(), Duration::from_secs(3))
        .unwrap();
    assert_eq!(receipt.state, ControllerReceiptState::WrittenToPty);
}

fn windows_shell_command() -> Vec<String> {
    vec![
        std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
        "/D".into(),
        "/Q".into(),
        "/K".into(),
    ]
}

fn wait_for_snapshot(
    session: &hmux_client::LocalSession,
    marker: &[u8],
    expected_geometry: (u16, u16),
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        eprintln!("windows-native-stage snapshot:request");
        let snapshot = session.read_screen(None).unwrap();
        eprintln!("windows-native-stage snapshot:received");
        let contains_marker = snapshot
            .repaint_bytes
            .windows(marker.len())
            .any(|window| window == marker);
        if contains_marker && (snapshot.rows, snapshot.columns) == expected_geometry {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Windows Host did not replay marker {:?} at {:?}; snapshot was {}x{} at sequence {} with {} repaint bytes: {:?}",
            String::from_utf8_lossy(marker),
            expected_geometry,
            snapshot.columns,
            snapshot.rows,
            snapshot.sequence_through,
            snapshot.repaint_bytes.len(),
            String::from_utf8_lossy(&snapshot.repaint_bytes),
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(Clone, Copy)]
struct ProcessGeneration {
    process_id: u32,
    creation_filetime: u64,
}

fn wait_for_child_process(parent_process_id: u32, executable: &str) -> ProcessGeneration {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(process_id) = child_process(parent_process_id, executable) {
            if let Some(creation_filetime) = process_creation_filetime(process_id) {
                return ProcessGeneration {
                    process_id,
                    creation_filetime,
                };
            }
        }
        assert!(
            Instant::now() < deadline,
            "provider did not launch a live {executable} child process generation"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn child_process(parent_process_id: u32, executable: &str) -> Option<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).unwrap(),
        ..Default::default()
    };
    let mut found = None;
    if unsafe { Process32FirstW(snapshot, &raw mut entry) } != 0 {
        loop {
            let name_end = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_end]);
            if entry.th32ParentProcessID == parent_process_id
                && name.eq_ignore_ascii_case(executable)
            {
                found = Some(entry.th32ProcessID);
                break;
            }
            if unsafe { Process32NextW(snapshot, &raw mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe {
        CloseHandle(snapshot);
    }
    found
}

fn wait_for_process_generation_exit(expected: ProcessGeneration) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_creation_filetime(expected.process_id) == Some(expected.creation_filetime) {
        assert!(
            Instant::now() < deadline,
            "provider descendant remained alive after the Host closed its Job"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn terminate_exact_process(expected: &ProcessDescriptor) {
    let Some(expected_creation_time) = expected
        .start_marker
        .strip_prefix("windows-proc-start-v1:")
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return;
    };
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            expected.process_id,
        )
    };
    if process.is_null() {
        return;
    }
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let exact = unsafe {
        GetProcessTimes(
            process,
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        ) != 0
    } && ((u64::from(creation.dwHighDateTime) << 32)
        | u64::from(creation.dwLowDateTime))
        == expected_creation_time;
    if exact {
        unsafe {
            TerminateProcess(process, 1);
        }
    }
    unsafe {
        CloseHandle(process);
    }
}

fn process_creation_filetime(process_id: u32) -> Option<u64> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return None;
    }
    let mut exit_code = 0_u32;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let observed = unsafe {
        GetExitCodeProcess(process, &raw mut exit_code) != 0
            && exit_code == STILL_ACTIVE as u32
            && GetProcessTimes(
                process,
                &raw mut creation,
                &raw mut exit,
                &raw mut kernel,
                &raw mut user,
            ) != 0
    };
    unsafe {
        CloseHandle(process);
    }
    observed.then(|| (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}
