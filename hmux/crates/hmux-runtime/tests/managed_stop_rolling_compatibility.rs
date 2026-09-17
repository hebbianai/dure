#![cfg(unix)]

use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, AgentStateReportOutcome,
    LocalSessionCatalog, LocalSessionObserver, ManagedAgentStateReporter, ManagedAttachRequest,
    ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper,
    ManagedStopConversationFence, ManagedStopOutcome, ManagedStopQuiescenceFence,
    ManagedStopRequest, ObserverAttachOptions, PermissionMode, ProviderConversationIdentitySeed,
    SessionDescriptor, SessionLifecycle, SessionSelector,
};
use std::path::Path;
use std::process::Command;

const OMIT_CAPABILITIES_ENV: &str = "HMUX_RUNTIME_TEST_HOST_OMIT_CAPABILITIES";
const CONVERSATION_STOP_CAPABILITY: &str = "managed_provider_conversation_fenced_stop_v1";
const IDENTITY_CAPABILITY: &str = "provider_conversation_identity_v1";

#[test]
fn current_broker_stops_an_exact_some_conversation_on_an_old_local_host() {
    run_isolated_fixture(
        "old_host_exact_some_local_fixture",
        CONVERSATION_STOP_CAPABILITY,
    );
}

#[test]
fn current_broker_stops_old_local_host_with_legacy_token_authorization() {
    run_isolated_fixture(
        "old_host_exact_some_local_fixture",
        &format!("{CONVERSATION_STOP_CAPABILITY},managed_authorization_grant_v1"),
    );
}

#[test]
fn current_broker_refuses_old_local_host_without_identity_projection() {
    run_isolated_fixture(
        "old_host_missing_projection_local_fixture",
        &format!("{CONVERSATION_STOP_CAPABILITY},{IDENTITY_CAPABILITY}"),
    );
}

fn run_isolated_fixture(name: &str, omitted: &str) {
    let state = tempfile::tempdir().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--ignored")
        .arg("--exact")
        .arg(name)
        .arg("--nocapture")
        .env(OMIT_CAPABILITIES_ENV, omitted)
        .env("HOME", state.path().join("home"))
        .env("DURE_HOME", state.path().join("dure"))
        .env_remove("HEBBIAN_HOME")
        .env_remove("BEADS_ACTOR")
        .status()
        .unwrap();
    assert!(
        status.success(),
        "isolated old-Host fixture failed: {status}"
    );
}

#[test]
#[ignore = "runs in an isolated process with a simulated old Host capability manifest"]
fn old_host_exact_some_local_fixture() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let runtime = Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    let stopper = ManagedSessionStopper::new(runtime, &cwd).with_discovery_root(&discovery_root);

    let rejected = creator
        .create_with_disposition(
            ManagedCreateRequest::new(
                "v5-required-create",
                "v5-required-session",
                "old-host-workspace",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap_err();
    assert_eq!(
        rejected.disposition(),
        hmux_client::ManagedCreateFailureDisposition::Rejected
    );
    assert_eq!(rejected.code(), "hmux_managed_request_invalid");
    assert!(
        LocalSessionCatalog::new(&discovery_root)
            .list()
            .unwrap()
            .is_empty()
    );

    let discard = create_old_host(&creator, &cwd, "discard", "conversation-discard");
    assert_old_host(&discard, true);
    let stopped = stopper
        .stop(exact_stop(
            &discard,
            "discard-stop",
            Some("conversation-discard"),
            None,
        ))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);

    let preserve = create_old_host(&creator, &cwd, "preserve", "conversation-preserve");
    assert_old_host(&preserve, true);
    let stale_quiescence = report_waiting_and_observe(runtime, &cwd, &discovery_root, &preserve);
    report_activity(
        runtime,
        &cwd,
        &discovery_root,
        &preserve,
        AgentRuntimeActivity::Working,
    );
    let error = stopper
        .stop(exact_stop(
            &preserve,
            "preserve-stale-stop",
            Some("conversation-preserve"),
            Some(stale_quiescence),
        ))
        .unwrap_err();
    assert_eq!(error.code(), "hmux_managed_stop_refused");
    assert_ready(&discovery_root, &preserve);
    let quiescence = report_waiting_and_observe(runtime, &cwd, &discovery_root, &preserve);
    let stopped = stopper
        .stop(exact_stop(
            &preserve,
            "preserve-stop",
            Some("conversation-preserve"),
            Some(quiescence),
        ))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);

    for (suffix, expected) in [("mismatch", Some("conversation-other")), ("none", None)] {
        let actual = format!("conversation-{suffix}");
        let descriptor = create_old_host(&creator, &cwd, suffix, &actual);
        assert_old_host(&descriptor, true);
        let error = stopper
            .stop(exact_stop(
                &descriptor,
                format!("{suffix}-refused"),
                expected,
                None,
            ))
            .unwrap_err();
        assert_eq!(error.code(), "hmux_managed_stop_refused");
        assert_ready(&discovery_root, &descriptor);
        stopper
            .stop(exact_stop(
                &descriptor,
                format!("{suffix}-cleanup"),
                Some(&actual),
                None,
            ))
            .unwrap();
    }
}

#[test]
#[ignore = "runs in an isolated process with a simulated old Host capability manifest"]
fn old_host_missing_projection_local_fixture() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let runtime = Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    let descriptor = create_old_host(&creator, &cwd, "projection", "conversation-projection");
    assert_old_host(&descriptor, false);

    let stopper = ManagedSessionStopper::new(runtime, &cwd).with_discovery_root(&discovery_root);
    let error = stopper
        .stop(exact_stop(
            &descriptor,
            "projection-refused",
            Some("conversation-projection"),
            None,
        ))
        .unwrap_err();
    assert_eq!(error.code(), "hmux_managed_stop_refused");
    assert_ready(&discovery_root, &descriptor);
    stopper
        .stop(exact_unfenced_stop(&descriptor, "projection-cleanup"))
        .unwrap();
}

fn create_old_host(
    creator: &ManagedSessionCreator,
    cwd: &Path,
    suffix: &str,
    conversation_id: &str,
) -> SessionDescriptor {
    creator
        .create(
            ManagedCreateRequest::new(
                format!("old-host-create-{suffix}"),
                format!("old-host-{suffix}"),
                "old-host-workspace",
                "codex",
                PermissionMode::Default,
                cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap()
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap(),
            )
            .unwrap(),
        )
        .unwrap()
        .session()
        .descriptor()
        .clone()
}

fn assert_old_host(descriptor: &SessionDescriptor, has_identity_projection: bool) {
    assert!(
        !descriptor
            .capabilities
            .iter()
            .any(|capability| { capability == CONVERSATION_STOP_CAPABILITY })
    );
    assert_eq!(
        descriptor
            .capabilities
            .iter()
            .any(|capability| capability == IDENTITY_CAPABILITY),
        has_identity_projection
    );
}

fn exact_stop(
    descriptor: &SessionDescriptor,
    stop_id: impl Into<String>,
    conversation_id: Option<&str>,
    quiescence: Option<ManagedStopQuiescenceFence>,
) -> ManagedStopRequest {
    let request = exact_unfenced_stop(descriptor, stop_id)
        .with_expected_conversation(
            ManagedStopConversationFence::new("codex", conversation_id.map(ToString::to_string))
                .unwrap(),
        )
        .unwrap();
    quiescence.map_or(request.clone(), |fence| {
        request.with_expected_quiescence(fence).unwrap()
    })
}

fn exact_unfenced_stop(
    descriptor: &SessionDescriptor,
    stop_id: impl Into<String>,
) -> ManagedStopRequest {
    ManagedStopRequest::new(stop_id, &descriptor.session_id, &descriptor.workspace_id)
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

fn report_waiting_and_observe(
    runtime: &Path,
    cwd: &Path,
    discovery_root: &Path,
    descriptor: &SessionDescriptor,
) -> ManagedStopQuiescenceFence {
    report_activity(
        runtime,
        cwd,
        discovery_root,
        descriptor,
        AgentRuntimeActivity::Waiting,
    );
    let observer = LocalSessionObserver::connect(
        &LocalSessionCatalog::new(discovery_root),
        &SessionSelector::new(
            &descriptor.session_id,
            Some(descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let snapshot = &observer.attachment().initial_snapshot;
    let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
    let fence = ManagedStopQuiescenceFence::new(
        &runtime.terminal_epoch,
        runtime.revision.parse().unwrap(),
        snapshot.sequence_through.parse().unwrap(),
    )
    .unwrap();
    observer.detach().unwrap();
    fence
}

fn report_activity(
    runtime: &Path,
    cwd: &Path,
    discovery_root: &Path,
    descriptor: &SessionDescriptor,
    activity: AgentRuntimeActivity,
) {
    let reporter = ManagedAgentStateReporter::new(runtime, cwd).with_discovery_root(discovery_root);
    assert!(matches!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                    .unwrap(),
                AgentStateReport {
                    identity_only: false,
                    activity,
                    attention: AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: None,
                },
            )
            .unwrap(),
        AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
    ));
}

fn assert_ready(discovery_root: &Path, descriptor: &SessionDescriptor) {
    assert_eq!(
        LocalSessionCatalog::new(discovery_root)
            .find(&SessionSelector::new(
                &descriptor.session_id,
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );
}
