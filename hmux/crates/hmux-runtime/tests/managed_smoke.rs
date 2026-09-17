#![cfg(unix)]

#[path = "managed_smoke/rehost_cli.rs"]
mod rehost_cli;

#[path = "managed_smoke/quiescent_stop.rs"]
mod quiescent_stop;

#[cfg(debug_assertions)]
#[path = "managed_smoke/socket_owner.rs"]
mod socket_owner;

#[cfg(debug_assertions)]
#[path = "managed_smoke/fresh_host.rs"]
mod fresh_host;

use hmux_client::recovery_journal::{
    MANAGED_STOP_RECOVERY_ACTION, ManagedRehostResolutionLookup, RecoveryJournalGcPolicy,
    garbage_collect_completed_action, managed_create_ledger, resolve_managed_rehost_current,
};
use hmux_client::{
    AgentStateReport, AgentStateReportObservationFence, AgentStateReportOutcome, ConnectionOptions,
    ControllerEvent, ControllerReceiptState, ExactDiscoveryWorker, ExactSessionProbeResult,
    FrameBody, LocalAttachRole, LocalProcessGenerationStatus, LocalSession, LocalSessionCatalog,
    LocalSessionObserver, MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV, ManagedAgentStateReporter,
    ManagedAttachRequest, ManagedCreateAdvanceResolution, ManagedCreateFailureDisposition,
    ManagedCreateOutcome, ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedRehostRecipe,
    ManagedRehostReconcileRequest, ManagedRehostReplacement, ManagedRehostRequest,
    ManagedSessionAttacher, ManagedSessionCreator, ManagedSessionRehoster, ManagedSessionStopper,
    ManagedStopConversationFence, ManagedStopOutcome, ManagedStopQuiescenceFence,
    ManagedStopRequest, ObserverAttachOptions, PermissionMode, PresentationCheckpointPredecessor,
    ProcessDescriptor, ProviderConversationIdentity, ProviderConversationIdentitySeed,
    ProviderConversationIdentitySource, SessionClass, SessionFence, SessionLifecycle,
    SessionSelector, TerminalEnvironment, exact_local_process_generation,
    inspect_local_sessions_exact_isolated, prepare_managed_attach_receipt,
    probe_local_process_generation,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_client::{
    CreatedManagedSession, TerminalIntentReceipt, TerminalSurfaceAccess, TerminalSurfaceAttachment,
    TerminalSurfaceEvent,
};
use hmux_host::local_discovery::{
    DiscoveryKey, DiscoveryManifest, DiscoveryRoot, PresentationCheckpointSource, SessionLookupKey,
    StartingManifest,
};
use hmux_host::local_protocol::{
    MANAGED_AUTHORIZATION_GRANT_CAPABILITY, MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
    MANAGED_PROVIDER_STOP_CAPABILITY, ManagedProviderStop, ManagedProviderStopConversationFence,
    ManagedProviderStopReceiptState,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR;
use hmux_runtime_contract::{
    MANAGED_CONVERSATION_WRITER_CONFLICT_CODE, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_REQUEST_INVALID_CODE, MANAGED_CREATE_RETIRED_EXACT_CODE,
    MANAGED_REHOST_BROKER_SUBCOMMAND, MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
    MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND, MANAGED_REHOST_RECOVERY_ACTION,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedCreateBrokerResponse, ManagedRehostBrokerResponse, ManagedStopBrokerResponse,
    ManagedStopReconcileRequest, PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
    PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY, ProviderStateEnvironment, read_json_frame,
    write_json_frame,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(feature = "terminal-state-stream")]
use terminal_state_protocol::{
    FocusInputIntent, InputIntent, TerminalStateRecord, encode_record_for_minor, input_intent,
    input_receipt, terminal_state_record,
};

const ABANDONED_STARTING_LOCK_PATH_ENV: &str = "HMUX_TEST_ABANDONED_STARTING_LOCK_PATH";
const ABANDONED_STARTING_LOCK_READY_ENV: &str = "HMUX_TEST_ABANDONED_STARTING_LOCK_READY";
const COMPATIBILITY_STOP_FIXTURE_ROOT_ENV: &str = "HMUX_TEST_COMPATIBILITY_STOP_FIXTURE_ROOT";
const AMBIENT_REHOST_SOURCE_FIXTURE_ROOT_ENV: &str = "HMUX_TEST_AMBIENT_REHOST_SOURCE_FIXTURE_ROOT";
const MANAGED_STOP_CLEANUP_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_MANAGED_STOP_CLEANUP_MARKER";

fn isolated_managed_runtime_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    command.env_remove(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV);
    command
}

#[test]
#[ignore = "launched as the same-session advisory-lock holder by the abandoned Starting test"]
fn abandoned_starting_advisory_lock_holder_fixture() {
    let lock_path = std::env::var_os(ABANDONED_STARTING_LOCK_PATH_ENV)
        .expect("lock-holder fixture requires its isolated lock path");
    let ready_path = std::env::var_os(ABANDONED_STARTING_LOCK_READY_ENV)
        .expect("lock-holder fixture requires its isolated ready path");
    // SAFETY: this fixture deliberately survives closure of the abandoned
    // provider's PTY. The owning integration test retains an exact process
    // generation descriptor and delivers SIGKILL during teardown.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    // SAFETY: `lock` owns this valid file descriptor for the rest of the
    // fixture lifetime.
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let ready_path = std::path::PathBuf::from(ready_path);
    let ready_staging_path = ready_path.with_extension("staging");
    fs::write(&ready_staging_path, std::process::id().to_string()).unwrap();
    fs::rename(ready_staging_path, ready_path).unwrap();
    loop {
        thread::park();
    }
}

#[test]
#[ignore = "launched in an isolated process by managed_stop_locates_compatibility_root"]
fn managed_compatibility_root_stop_fixture() {
    let state = std::path::PathBuf::from(
        std::env::var_os(COMPATIBILITY_STOP_FIXTURE_ROOT_ENV)
            .expect("compatibility stop fixture requires its isolated root"),
    );
    let legacy_root = state.join("legacy-home/state/hebbian-agent/hmux-hosts");
    let canonical_root = state.join("dure-home/state/hmux-hosts");
    fs::create_dir_all(legacy_root.parent().unwrap()).unwrap();
    fs::create_dir_all(canonical_root.parent().unwrap()).unwrap();
    DiscoveryRoot::create(&canonical_root).unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&legacy_root);
    let created = creator
        .create(
            ManagedCreateRequest::new(
                "compatibility-root-stop-create",
                "compatibility-root-stop-session",
                "compatibility-root-stop-workspace",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = exact_managed_stop_request("compatibility-root-stop", &source);

    let result =
        ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd).stop(request.clone());
    if result.is_err() {
        ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&legacy_root)
            .stop(request.clone())
            .expect("the failed regression must still clean up its exact fixture Host");
    }
    result.expect("managed stop must locate a live session in a compatibility discovery root");

    let legacy_recovery = legacy_root.join(".recovery");
    let canonical_recovery = canonical_root.join(".recovery");
    fs::create_dir(&canonical_recovery).unwrap();
    fs::set_permissions(&canonical_recovery, fs::Permissions::from_mode(0o700)).unwrap();
    for entry in fs::read_dir(&legacy_recovery).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("operation_") && name.ends_with(".json") {
            fs::copy(entry.path(), canonical_recovery.join(name.as_ref())).unwrap();
        }
    }
    let ambiguous = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .stop(request)
        .unwrap_err();
    assert_eq!(ambiguous.code(), "hmux_managed_stop_outcome_unknown");
    fs::remove_dir_all(canonical_recovery).unwrap();

    let replayed = creator
        .create(
            ManagedCreateRequest::new(
                "compatibility-root-replay-create",
                "compatibility-root-replay-session",
                "compatibility-root-stop-workspace",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let replayed = replayed.session().descriptor().clone();
    let replay_request = exact_managed_stop_request("compatibility-root-replay", &replayed);
    assert!(run_raw_managed_stop(&legacy_root, &cwd, &replay_request, false).is_none());
    let stopped = DiscoveryRoot::open(&legacy_root)
        .unwrap()
        .find_manifest_by_session(&replayed.workspace_id, &replayed.session_id)
        .unwrap();
    fs::remove_dir_all(stopped.discovery_path).unwrap();

    let receipt = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .stop(replay_request)
        .unwrap();
    assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
    assert_eq!(receipt.stop_id(), "compatibility-root-replay");
}

#[test]
fn managed_stop_locates_compatibility_root() {
    let state = tempfile::tempdir().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--ignored")
        .arg("--exact")
        .arg("managed_compatibility_root_stop_fixture")
        .arg("--nocapture")
        .env_remove(hmux_client::DISCOVERY_ROOT_ENV)
        .env("HOME", state.path())
        .env("DURE_HOME", state.path().join("dure-home"))
        .env("HEBBIAN_HOME", state.path().join("legacy-home"))
        .env(COMPATIBILITY_STOP_FIXTURE_ROOT_ENV, state.path())
        .status()
        .unwrap();

    assert!(
        status.success(),
        "managed stop child fixture failed with {status}"
    );
}

#[test]
fn managed_legacy_discovery_attaches_exact_generation_and_blocks_duplicate_create() {
    let state = tempfile::tempdir().unwrap();
    let legacy_home = state.path().join("legacy-home");
    let legacy_root = legacy_home.join("state/hebbian-agent/hmux-hosts");
    let dure_home = state.path().join("dure-home");
    let canonical_root = dure_home.join("state/hmux-hosts");
    fs::create_dir_all(legacy_root.parent().unwrap()).unwrap();
    fs::create_dir_all(canonical_root.parent().unwrap()).unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "legacy-managed-create",
        "legacy-managed-session",
        "legacy-managed-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec!["/bin/sleep".into(), "30".into()],
        24,
        80,
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&legacy_root);
    let created = creator.create(request.clone()).unwrap();
    let source = created.session().descriptor().clone();
    let migration_catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        &canonical_root,
        vec![legacy_root.clone()],
    )
    .unwrap();

    let receipt = prepare_managed_attach_receipt(
        &migration_catalog,
        &ManagedAttachRequest::new(&source.session_id, &source.workspace_id).unwrap(),
    )
    .unwrap();
    let rediscovered = LocalSession::from_manifest(receipt.manifest().clone()).unwrap();
    assert!(rediscovered.descriptor().same_generation(&source));
    assert!(!receipt.authorization_proof_reference().is_empty());
    assert!(!canonical_root.exists());

    let mut duplicate = isolated_managed_runtime_command()
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .env_remove(hmux_client::DISCOVERY_ROOT_ENV)
        .env("HOME", state.path())
        .env("DURE_HOME", &dure_home)
        .env("HEBBIAN_HOME", &legacy_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    write_json_frame(duplicate.stdin.as_mut().unwrap(), &request).unwrap();
    drop(duplicate.stdin.take());
    let response =
        read_json_frame::<ManagedCreateBrokerResponse>(duplicate.stdout.as_mut().unwrap()).unwrap();
    assert!(duplicate.wait().unwrap().success());
    assert!(matches!(
        response,
        ManagedCreateBrokerResponse::Refused(ref failure)
            if failure.code == "hmux_managed_launch_failed"
                && failure.message.contains("read-only legacy discovery")
    ));
    assert!(
        LocalSessionCatalog::new(&canonical_root)
            .list()
            .unwrap()
            .is_empty()
    );

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&legacy_root)
        .stop(exact_managed_stop_request(
            "legacy-managed-cleanup",
            &source,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_moves_an_exact_compatibility_source_into_the_canonical_root() {
    let state = tempfile::tempdir().unwrap();
    let source_root = state.path().join("legacy-discovery");
    let canonical_parent = state.path().join("state");
    let canonical_root = canonical_parent.join("hmux-hosts");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    assert!(!canonical_parent.exists());
    assert!(!canonical_root.exists());
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&source_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "compatibility-root",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        &canonical_root,
        vec![source_root.clone()],
    )
    .unwrap();
    let located = catalog
        .managed_rehost_source(&SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    assert!(located.descriptor().same_generation(&source));

    let unconfirmed = exact_managed_rehost_request("compatibility-root-operation", &source, false);
    let error = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&canonical_root)
        .with_source(located.clone())
        .rehost(unconfirmed)
        .expect_err("an unconfirmed rehost must not provision canonical state");
    if error.code() != "hmux_managed_rehost_confirmation_required" {
        ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&source_root)
            .stop(exact_managed_stop_request(
                "compatibility-root-unconfirmed-red-cleanup",
                &source,
            ))
            .unwrap();
    }
    assert_eq!(error.code(), "hmux_managed_rehost_confirmation_required");
    assert!(!canonical_parent.exists());
    assert!(!canonical_root.exists());

    let request = exact_managed_rehost_request("compatibility-root-operation", &source, true)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id("conversation-compatibility-root")
        .unwrap();
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let quoted_runtime = runtime.replace('\'', "'\\''");
    let crashing_runtime = state.path().join("crashing-hmux-runtime");
    fs::write(
        &crashing_runtime,
        format!(
            "#!/bin/sh\nHMUX_TEST_MANAGED_REHOST_FAULT=after_payload_journaled exec '{quoted_runtime}' \"$@\"\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&crashing_runtime, fs::Permissions::from_mode(0o700)).unwrap();

    let error = ManagedSessionRehoster::new(&crashing_runtime, &cwd)
        .with_discovery_root(&canonical_root)
        .with_source(located)
        .rehost(request.clone())
        .expect_err("the fault cut must occur after the complete cross-root payload is journaled");
    if error.code() != "hmux_managed_runtime_failed" {
        ManagedSessionStopper::new(runtime, &cwd)
            .with_discovery_root(&source_root)
            .stop(exact_managed_stop_request(
                "compatibility-root-red-cleanup",
                &source,
            ))
            .unwrap();
    }
    assert_eq!(
        error.code(),
        "hmux_managed_runtime_failed",
        "the managed runtime failed before the journal fault cut: {error}",
    );
    assert_eq!(
        fs::metadata(&canonical_parent)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700,
    );
    assert_eq!(
        fs::metadata(&canonical_root).unwrap().permissions().mode() & 0o777,
        0o700,
    );
    assert_eq!(
        LocalSessionCatalog::new(&source_root)
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );
    assert!(matches!(
        resolve_managed_rehost_current(&source_root, &source.workspace_id, &source.session_id)
            .unwrap(),
        ManagedRehostResolutionLookup::NotFound,
    ));

    let receipt = ManagedSessionRehoster::new(runtime, &cwd)
        .with_discovery_root(&canonical_root)
        .rehost(request.clone())
        .expect("a hint-free retry must use the journaled compatibility source root");
    wait_for_file_content(&replacement_marker, b"conversation-compatibility-root");
    wait_for_exited(&source_root, &source.session_id, &source.workspace_id);
    let replacement = LocalSessionCatalog::new(&canonical_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id.clone()),
        ))
        .expect("the replacement must be created in the canonical root");
    assert!(
        LocalSessionCatalog::new(&source_root)
            .find(&SessionSelector::new(
                receipt.replacement_receipt().session_id(),
                Some(source.workspace_id.clone()),
            ))
            .is_err(),
        "the compatibility root must not become replacement authority"
    );
    assert!(matches!(
        resolve_managed_rehost_current(&source_root, &source.workspace_id, &source.session_id)
            .unwrap(),
        ManagedRehostResolutionLookup::NotFound,
    ));
    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(&canonical_root, &source.workspace_id, &source.session_id)
            .unwrap()
    else {
        panic!("the canonical journal did not publish the cross-root successor")
    };
    assert_eq!(
        resolution.current_generation().session_id(),
        replacement.session_id
    );

    let replayed = ManagedSessionRehoster::new(runtime, &cwd)
        .with_discovery_root(&canonical_root)
        .rehost(request)
        .unwrap();
    assert!(replayed.replayed());
    ManagedSessionStopper::new(runtime, &cwd)
        .with_discovery_root(&canonical_root)
        .stop(exact_managed_stop_request(
            "compatibility-root-replacement-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_reconcile_reports_no_intent_when_the_canonical_root_is_absent() {
    let state = tempfile::tempdir().unwrap();
    let canonical_parent = state.path().join("state");
    let canonical_root = canonical_parent.join("hmux-hosts");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedRehostReconcileRequest::by_operation_identity(
        "absent-canonical-root-operation",
        "absent-canonical-root-session",
        "absent-canonical-root-workspace",
    )
    .unwrap();

    let error = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&canonical_root)
        .reconcile(request)
        .expect_err("an absent canonical root cannot contain a durable rehost intent");

    assert_eq!(error.code(), "hmux_managed_rehost_intent_not_found");
    assert!(
        !canonical_parent.exists(),
        "reconcile must remain read-only"
    );
    assert!(!canonical_root.exists(), "reconcile must remain read-only");
}

#[test]
#[ignore = "launched with an isolated ambient rehost source by the client boundary test"]
fn managed_rehost_ambient_source_fixture() {
    let ambient_root = std::env::var_os(AMBIENT_REHOST_SOURCE_FIXTURE_ROOT_ENV)
        .expect("ambient-source fixture requires its isolated root");
    DiscoveryRoot::create(ambient_root).unwrap();
    managed_rehost_is_confirmed_exact_and_replays_one_replacement();
}

#[test]
fn managed_rehost_client_does_not_inherit_ambient_source_without_an_explicit_handle() {
    let state = tempfile::tempdir().unwrap();
    let ambient_root = state.path().join("ambient-source");
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--ignored")
        .arg("--exact")
        .arg("managed_rehost_ambient_source_fixture")
        .arg("--nocapture")
        .env(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV, &ambient_root)
        .env(AMBIENT_REHOST_SOURCE_FIXTURE_ROOT_ENV, &ambient_root)
        .status()
        .unwrap();

    assert!(
        status.success(),
        "ambient source authority escaped into a handle-free rehost broker: {status}"
    );
}

#[test]
fn managed_rehost_is_confirmed_exact_and_replays_one_replacement() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "normal",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);

    let unconfirmed = exact_managed_rehost_request("normal-operation", &source, false);
    let error = rehoster
        .rehost(unconfirmed)
        .expect_err("an unconfirmed exact rehost must fail before source retirement");
    assert_eq!(error.code(), "hmux_managed_rehost_confirmation_required");
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );

    let request = exact_managed_rehost_request("normal-operation", &source, true)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id("conversation-normal")
        .unwrap()
        .with_expected_launch_reference("credential-normal")
        .unwrap();
    let receipt = rehoster.rehost(request.clone()).unwrap();
    assert!(!receipt.replayed());
    assert_eq!(receipt.conversation_id(), Some("conversation-normal"));
    assert_ne!(
        receipt.source_stop_receipt().session_id(),
        receipt.replacement_receipt().session_id()
    );
    wait_for_file_content(&replacement_marker, b"conversation-normal");
    wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);
    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(&discovery_root, &source.workspace_id, &source.session_id)
            .unwrap()
    else {
        panic!("completed rehost did not publish a durable source resolution")
    };
    assert_eq!(resolution.operation_ids(), ["normal-operation"]);
    assert_eq!(
        resolution.source_generation().channel_epoch(),
        source.channel_epoch
    );
    assert_eq!(
        resolution.current_generation().session_id(),
        receipt.replacement_receipt().session_id()
    );
    assert_eq!(
        resolution.current_generation().channel_epoch(),
        receipt
            .replacement_receipt()
            .generation_fence()
            .unwrap()
            .channel_epoch()
            .to_string()
    );
    let launch_identity = resolution
        .launch_identity()
        .expect("canonical exact rehost must retain its launch identity");
    assert_eq!(
        launch_identity.launch_reference(),
        Some("credential-normal")
    );
    assert_eq!(
        launch_identity.conversation_id(),
        Some("conversation-normal")
    );

    let replayed = rehoster.rehost(request.clone()).unwrap();
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    assert_eq!(
        fs::read(&replacement_marker).unwrap(),
        b"conversation-normal"
    );

    let first_replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    let second_request =
        exact_managed_rehost_request("normal-operation-2", &first_replacement, true);
    let second_receipt = rehoster.rehost(second_request).unwrap();
    wait_for_exited(
        &discovery_root,
        &first_replacement.session_id,
        &first_replacement.workspace_id,
    );
    let ManagedRehostResolutionLookup::Resolved(chained) =
        resolve_managed_rehost_current(&discovery_root, &source.workspace_id, &source.session_id)
            .unwrap()
    else {
        panic!("completed rehost chain did not resolve to its current generation")
    };
    assert_eq!(
        chained.operation_ids(),
        ["normal-operation", "normal-operation-2"]
    );
    assert_eq!(
        chained.current_generation().session_id(),
        second_receipt.replacement_receipt().session_id()
    );
    let current = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            second_receipt.replacement_receipt().session_id(),
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "normal-replacement-cleanup",
            &current,
        ))
        .unwrap();
    let stable = rehoster
        .rehost(request)
        .expect("completed operation receipt must outlive replacement readiness");
    assert!(stable.replayed());
    assert_eq!(
        stable.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    assert!(matches!(
        resolve_managed_rehost_current(&discovery_root, &source.workspace_id, &source.session_id,)
            .unwrap(),
        ManagedRehostResolutionLookup::Resolved(_)
    ));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn managed_rehost_launches_the_successor_at_the_current_checkpoint_geometry() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source_request =
        rehostable_create_request(&cwd, &replacement_marker, "checkpoint-geometry")
            .with_managed_rehost_recipe(
                ManagedRehostRecipe::new(
                    vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "printf '%s:' \"$1\" > \"$2\"; stty size >> \"$2\"; sleep 30".into(),
                        "--".into(),
                        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                        replacement_marker.to_string_lossy().into_owned(),
                    ],
                    Some("credential-checkpoint-geometry".into()),
                )
                .unwrap(),
            )
            .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(source_request)
        .unwrap();
    let source = created.session().descriptor().clone();
    assert_eq!(
        managed_create_ledger::managed_rehost_recipe(
            &discovery_root,
            &source.workspace_id,
            &source.session_id,
        )
        .unwrap()
        .map(|recipe| (recipe.initial_rows(), recipe.initial_columns())),
        Some((24, 80))
    );

    let mut controller = ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .attach(ManagedAttachRequest::new(&source.session_id, &source.workspace_id).unwrap())
        .unwrap();
    let resize_id = controller.mutation_handle().resize(18, 34).unwrap();
    wait_for_resize_receipt(&mut controller, &resize_id);
    controller.detach().unwrap();
    wait_for_presentation_dimensions(&discovery_root, &source, 18, 34);

    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(exact_managed_rehost_request(
            "checkpoint-geometry-operation",
            &source,
            true,
        ))
        .unwrap();
    wait_for_file_content(
        &replacement_marker,
        b"conversation-checkpoint-geometry:18 34\n",
    );
    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    let replacement_recipe = managed_create_ledger::managed_rehost_recipe(
        &discovery_root,
        &replacement.workspace_id,
        &replacement.session_id,
    )
    .unwrap()
    .expect("managed successor must persist its exact launch recipe");
    assert_eq!(
        (
            replacement_recipe.initial_rows(),
            replacement_recipe.initial_columns(),
        ),
        (18, 34),
        "the current presentation checkpoint, not the stale create recipe, must own successor launch geometry"
    );

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "checkpoint-geometry-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn managed_create_predecessor_launches_at_the_checkpoint_geometry() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let source_release = state.path().join("source-release");
    let replacement_geometry = state.path().join("replacement-geometry");
    let replacement_release = state.path().join("replacement-release");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let source = creator
        .create(
            ManagedCreateRequest::new(
                "predecessor-geometry-source-create",
                "predecessor-geometry-source",
                "predecessor-geometry-workspace",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "while [ ! -f \"$1\" ]; do sleep 0.05; done".into(),
                    "--".into(),
                    source_release.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let source = source.session().descriptor().clone();
    let mut controller = ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .attach(ManagedAttachRequest::new(&source.session_id, &source.workspace_id).unwrap())
        .unwrap();
    let resize_id = controller.mutation_handle().resize(19, 57).unwrap();
    wait_for_resize_receipt(&mut controller, &resize_id);
    controller.detach().unwrap();
    wait_for_presentation_dimensions(&discovery_root, &source, 19, 57);
    fs::write(&source_release, b"release").unwrap();
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if catalog
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle
            == SessionLifecycle::Exited
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "managed source did not publish an exited tombstone"
        );
        thread::sleep(Duration::from_millis(20));
    }

    let replacement = creator
        .create(
            ManagedCreateRequest::new(
                "predecessor-geometry-replacement-create",
                "predecessor-geometry-replacement",
                source.workspace_id.clone(),
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "stty size > \"$1\"; while [ ! -f \"$2\" ]; do sleep 0.05; done".into(),
                    "--".into(),
                    replacement_geometry.to_string_lossy().into_owned(),
                    replacement_release.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_presentation_predecessor(
                PresentationCheckpointPredecessor::new(
                    &source.session_id,
                    &source.runner_principal,
                    &source.runner_instance,
                    source.channel_epoch.parse().unwrap(),
                    &source.host_instance_id,
                    &source.terminal_epoch,
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

    wait_for_file_content(&replacement_geometry, b"19 57\n");
    fs::write(&replacement_release, b"release").unwrap();
    let replacement = replacement.session().descriptor().clone();
    let deadline = Instant::now() + Duration::from_secs(3);
    while catalog
        .find(&SessionSelector::new(
            &replacement.session_id,
            Some(replacement.workspace_id.clone()),
        ))
        .unwrap()
        .lifecycle
        != SessionLifecycle::Exited
    {
        assert!(
            Instant::now() < deadline,
            "managed replacement did not publish an exited tombstone"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn managed_rehost_fresh_ready_source_replays_one_conversationless_replacement() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let fresh_marker = state.path().join("fresh-provider-launches");
    let future_resume_marker = state.path().join("future-resume-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source_request = ManagedCreateRequest::new(
        "fresh-rehost-source-create",
        "fresh-rehost-source",
        "fresh-rehost-workspace",
        "codex",
        PermissionMode::BypassApprovals,
        &cwd,
        vec!["/bin/sleep".into(), "30".into()],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap()
    .with_managed_rehost_recipe(
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s' \"$1\" >> \"$2\"; sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                future_resume_marker.to_string_lossy().into_owned(),
            ],
            None,
        )
        .unwrap(),
    )
    .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(source_request)
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = fresh_managed_rehost_request_from_wire(
        "fresh-ready-operation",
        &source,
        &cwd,
        &fresh_marker,
        &future_resume_marker,
    );
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);

    let receipt = rehoster
        .rehost(request.clone())
        .expect("a ready source without conversation identity must admit one fresh successor");
    assert!(!receipt.replayed());
    assert!(
        serde_json::to_value(&receipt).unwrap()["conversationId"].is_null(),
        "fresh replacement must not invent a provider conversation identity"
    );
    let stop = receipt.source_stop_receipt();
    assert_eq!(stop.session_id(), source.session_id);
    assert_eq!(stop.workspace_id(), source.workspace_id);
    assert_eq!(stop.runner_principal(), source.runner_principal);
    assert_eq!(stop.runner_instance(), source.runner_instance);
    assert_eq!(stop.channel_epoch().to_string(), source.channel_epoch);
    assert_eq!(stop.host_instance_id(), source.host_instance_id);
    assert_eq!(stop.terminal_epoch(), source.terminal_epoch);
    wait_for_file_content(&fresh_marker, b"fresh\n");
    wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);
    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(&discovery_root, &source.workspace_id, &source.session_id)
            .unwrap()
    else {
        panic!("canonical fresh rehost must publish its launch identity")
    };
    let launch_identity = resolution
        .launch_identity()
        .expect("fresh launch identity is known even when both selections use defaults");
    assert_eq!(launch_identity.launch_reference(), None);
    assert_eq!(launch_identity.conversation_id(), None);

    let replayed = rehoster.rehost(request).unwrap();
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    assert_eq!(fs::read(&fresh_marker).unwrap(), b"fresh\n");

    let ready = LocalSessionCatalog::new(&discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| descriptor.lifecycle == SessionLifecycle::Ready)
        .collect::<Vec<_>>();
    assert_eq!(ready.len(), 1, "fresh replay created a second successor");
    assert_eq!(
        ready[0].session_id,
        receipt.replacement_receipt().session_id()
    );

    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "fresh-ready-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
#[cfg(feature = "terminal-state-stream")]
fn managed_rehost_keeps_the_source_tail_scrollable_after_redraw_and_retry() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let conversation_id = "conversation-rehost-history";
    let request = ManagedCreateRequest::new(
        "rehost-history-source-create",
        "rehost-history-source",
        "rehost-history-workspace",
        "codex",
        PermissionMode::BypassApprovals,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'SOURCE_CONTEXT_A\r\nSOURCE_CONTEXT_B\r\nLATEST_SOURCE_EXCHANGE'; sleep 30"
                .into(),
        ],
        4,
        40,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap(),
    )
    .unwrap()
    .with_managed_rehost_recipe(
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                r#"test "$1" = 'conversation-rehost-history'; printf '\033[2J\033[HSUCCESSOR_REDRAW_A\r\nSUCCESSOR_REDRAW_B'; sleep 30"#
                    .into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ],
            Some("credential-rehost-history".into()),
        )
        .unwrap(),
    )
    .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request)
        .unwrap();
    let source_session = created.session().clone();
    let source = source_session.descriptor().clone();
    wait_for_screen_text(&source_session, &["LATEST_SOURCE_EXCHANGE"]);

    let rehost_request = exact_managed_rehost_request("rehost-history-operation", &source, true);
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let receipt = rehoster.rehost(rehost_request.clone()).unwrap();
    assert!(!receipt.replayed());
    let replacement = ready_rehost_target(&discovery_root, &source);
    assert_eq!(
        replacement.session_id,
        receipt.replacement_receipt().session_id()
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let attach = prepare_managed_attach_receipt(
        &catalog,
        &ManagedAttachRequest::new(&replacement.session_id, &replacement.workspace_id).unwrap(),
    )
    .unwrap();
    let replacement_session = LocalSession::from_manifest(attach.manifest().clone()).unwrap();
    let snapshot = wait_for_screen_text(&replacement_session, &["SUCCESSOR_REDRAW_B"]);
    let recovered = snapshot
        .recovered_presentation
        .as_ref()
        .expect("the exact successor must expose its recovered source fence");
    assert!(!recovered.truncated);
    assert_eq!(recovered.source_fence.terminal_epoch, source.terminal_epoch);

    let assert_source_tail = |session: &LocalSession| {
        let connection = session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::ReadOnly,
                None,
            ))
            .unwrap();
        let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
        let tail = surface
            .set_viewport_rows_confirmed(4, Duration::from_secs(3))
            .unwrap();
        assert!(tail.text().contains("SUCCESSOR_REDRAW"));
        let history = surface
            .scroll_rows_confirmed(64, Duration::from_secs(3))
            .unwrap();
        assert!(
            history.text().contains("LATEST_SOURCE_EXCHANGE"),
            "the newest source exchange was absent after exact managed rehost: {:?}",
            history.text()
        );
        surface.detach().unwrap();
    };
    assert_source_tail(&replacement_session);

    let replayed = rehoster.rehost(rehost_request).unwrap();
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    assert_source_tail(&replacement_session);

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "rehost-history-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_replaces_an_exact_source_that_exited_before_admission() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let source_exit_trigger = state.path().join("exit-source");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(rehostable_create_request_with_command(
            &cwd,
            &replacement_marker,
            "exited-before-admission",
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "while [ ! -e \"$1\" ]; do sleep 0.05; done".into(),
                "--".into(),
                source_exit_trigger.to_string_lossy().into_owned(),
            ],
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    fs::write(&source_exit_trigger, b"exit").unwrap();
    wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);

    let request = exact_managed_rehost_request("exited-before-admission-operation", &source, true)
        .with_expected_conversation_id("conversation-exited-before-admission")
        .unwrap();
    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect("an exact exited source must create its canonical AlreadyExited stop receipt");

    assert_eq!(
        receipt.source_stop_receipt().outcome(),
        ManagedStopOutcome::AlreadyExited
    );
    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-exited-before-admission")
    );
    wait_for_file_content(&replacement_marker, b"conversation-exited-before-admission");
    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_replaces_an_exact_source_retired_by_an_earlier_stop() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "explicitly-stopped-before-admission",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let stopped = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request("earlier-explicit-stop", &source))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);

    let request = exact_managed_rehost_request(
        "explicitly-stopped-before-admission-operation",
        &source,
        true,
    )
    .with_expected_conversation_id("conversation-explicitly-stopped-before-admission")
    .unwrap();
    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect("an earlier exact stop must not block a new canonical rehost stop receipt");

    assert_eq!(
        receipt.source_stop_receipt().outcome(),
        ManagedStopOutcome::AlreadyExited
    );
    wait_for_file_content(
        &replacement_marker,
        b"conversation-explicitly-stopped-before-admission",
    );
    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_recovers_an_exact_abandoned_starting_generation() {
    let fixture = abandoned_starting_fixture("abandoned-starting");
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root);
    let receipt = rehoster
        .rehost(fixture.request.clone())
        .expect("an exact abandoned Starting generation must recover after both processes exit");

    assert_eq!(
        receipt.source_stop_receipt().outcome(),
        ManagedStopOutcome::AlreadyExited
    );
    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-abandoned-starting")
    );
    wait_for_file_content(
        &fixture.replacement_marker,
        b"conversation-abandoned-starting",
    );
    let replayed = rehoster.rehost(fixture.request).unwrap();
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    assert_eq!(
        fs::read(&fixture.replacement_marker).unwrap(),
        b"conversation-abandoned-starting"
    );
    stop_ready_managed_test_sessions(&fixture.discovery_root, &fixture.cwd);
}

#[test]
fn chain_stop_retires_an_exact_abandoned_starting_generation() {
    let fixture = abandoned_starting_fixture("chain-stop-abandoned-starting");
    let root = ManagedCreateReconcileRequest::new(
        &fixture.source_idempotency_key,
        &fixture.source_session_id,
        &fixture.source_workspace_id,
    )
    .unwrap();
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root);

    let closed = stopper.stop_create_chain_v2(root.clone()).unwrap();
    assert_eq!(closed.chain(), std::slice::from_ref(&root));
    assert!(closed.stop_receipt().is_none());
    assert_eq!(stopper.stop_create_chain_v2(root).unwrap(), closed);
    assert_eq!(
        probe_local_process_generation(&fixture.old_host_process).unwrap(),
        LocalProcessGenerationStatus::Absent,
    );
    assert_eq!(
        probe_local_process_generation(&fixture.old_provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent,
    );
}

#[test]
fn managed_rehost_retirement_errors_preserve_its_exact_abandoned_replacement() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let guardian_cut = state.path().join("replacement-provider-spawned");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "abandoned-replacement",
        ))
        .unwrap();
    let operation_id = "abandoned-replacement-operation";
    let launch_reference = "credential-abandoned-replacement-target";
    let replacement = ManagedRehostReplacement::new(
        "codex",
        PermissionMode::BypassApprovals,
        &cwd,
        24,
        80,
        TerminalEnvironment::default(),
        Some(launch_reference.to_string()),
        ProviderStateEnvironment::default(),
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ],
            Some(launch_reference.to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let request = exact_managed_rehost_request(operation_id, source.session().descriptor(), true)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id("conversation-abandoned-replacement")
        .unwrap()
        .with_replacement(replacement)
        .unwrap();
    let mut broker =
        spawn_managed_rehost_at_guardian_cut(&discovery_root, &cwd, &request, &guardian_cut);
    wait_for_child_marker(&mut broker, &guardian_cut);

    let target_session_id = managed_rehost_target_session_id(&request);
    let generation = managed_create_ledger::starting_generation(
        &discovery_root,
        source.receipt().workspace_id(),
        &target_session_id,
    )
    .unwrap()
    .expect("replacement Host did not checkpoint its exact Starting generation");
    terminate_owned_test_process(generation.provider_process());
    terminate_owned_test_process(generation.host_process());
    wait_for_process_absent(generation.provider_process());
    wait_for_process_absent(generation.host_process());
    let _ = broker.kill();
    let _ = broker.wait();

    let mut observed_codes = Vec::new();
    for fault in [
        "process_observation_unavailable",
        "publish_exited_outcome_unknown",
        "retire_exited_outcome_unknown",
    ] {
        let response =
            run_managed_rehost_with_retirement_error(&discovery_root, &cwd, &request, fault);
        let ManagedRehostBrokerResponse::Refused(failure) = response else {
            panic!("fault-injected abandoned replacement retirement must remain retryable")
        };
        observed_codes.push(failure.code);
        assert!(
            ready_managed_sessions(&discovery_root).is_empty(),
            "retirement failure at {fault} must not launch a successor"
        );
    }
    assert_eq!(
        observed_codes,
        [
            "hmux_managed_rehost_unavailable",
            "hmux_managed_rehost_outcome_unknown",
            "hmux_managed_rehost_outcome_unknown",
        ]
    );

    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect("the same rehost must replace its abandoned successor generation");
    assert_eq!(
        receipt.replacement_receipt().session_id(),
        target_session_id
    );
    assert_eq!(ready_managed_sessions(&discovery_root).len(), 1);
    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_refuses_an_abandoned_starting_session_with_a_live_lock_holder() {
    let mut fixture = abandoned_starting_fixture_with_lock_holder("abandoned-starting-lock");
    assert!(
        !advisory_lock_is_available(&fixture.lock_path),
        "the exact same-session descendant must hold a real advisory lock"
    );

    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root);
    let first = rehoster.rehost(fixture.request.clone());
    let source_manifest = read_manifest(
        &fixture.discovery_root,
        &fixture.source_workspace_id,
        &fixture.source_session_id,
    );
    let source_stop = reconcile_managed_stop(
        &fixture.discovery_root,
        &fixture.cwd,
        fixture.request.source(),
    );
    let ready_before_descendant_exit = ready_managed_sessions(&fixture.discovery_root);
    let replacement_started = fixture.replacement_marker.exists();

    if first.is_ok() || !ready_before_descendant_exit.is_empty() {
        stop_ready_managed_test_sessions(&fixture.discovery_root, &fixture.cwd);
    }
    fixture.stop_lock_holder();

    let error = first
        .expect_err("an exact provider leader exit cannot retire its still-live process session");
    assert_eq!(error.code(), "hmux_managed_rehost_source_changed");
    assert!(
        matches!(source_manifest, DiscoveryManifest::Starting(_)),
        "a live same-session descendant must prevent Exited publication"
    );
    assert!(
        matches!(source_stop, ManagedStopBrokerResponse::Refused(_)),
        "a live same-session descendant must prevent the exact source stop receipt"
    );
    assert!(ready_before_descendant_exit.is_empty());
    assert!(!replacement_started);
    wait_for_advisory_lock_available(&fixture.lock_path);

    let receipt = rehoster
        .rehost(fixture.request)
        .expect("the same operation must resume after the recorded process session is absent");
    assert_eq!(
        receipt.source_stop_receipt().outcome(),
        ManagedStopOutcome::AlreadyExited
    );
    wait_for_file_content(
        &fixture.replacement_marker,
        b"conversation-abandoned-starting-lock",
    );
    let ready_after_descendant_exit = ready_managed_sessions(&fixture.discovery_root);
    assert_eq!(ready_after_descendant_exit.len(), 1);
    assert_eq!(
        ready_after_descendant_exit[0].session_id,
        receipt.replacement_receipt().session_id()
    );
    stop_ready_managed_test_sessions(&fixture.discovery_root, &fixture.cwd);
}

#[test]
fn abandoned_starting_rehost_crash_retires_once_before_one_successor() {
    let fixture = abandoned_starting_fixture("abandoned-starting-crash");
    run_crashing_managed_rehost(
        &fixture.discovery_root,
        &fixture.cwd,
        &fixture.request,
        "after_abandoned_starting_exited",
    );
    assert!(!fixture.replacement_marker.exists());
    wait_for_exited(
        &fixture.discovery_root,
        &fixture.source_session_id,
        &fixture.source_workspace_id,
    );
    assert_eq!(
        resolve_managed_rehost_current(
            &fixture.discovery_root,
            &fixture.source_workspace_id,
            &fixture.source_session_id,
        )
        .unwrap(),
        ManagedRehostResolutionLookup::RetryRequired {
            operation_id: "abandoned-starting-crash-operation".into()
        }
    );

    let changed_hint = fixture
        .request
        .clone()
        .with_expected_conversation_id("untrusted-retry-hint")
        .unwrap();
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root);
    let receipt = rehoster
        .rehost(changed_hint)
        .expect("retry must resume the durable operation after exact source retirement");
    assert!(receipt.replayed());
    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-abandoned-starting-crash")
    );
    wait_for_file_content(
        &fixture.replacement_marker,
        b"conversation-abandoned-starting-crash",
    );
    assert_eq!(
        probe_local_process_generation(&fixture.old_host_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    assert_eq!(
        probe_local_process_generation(&fixture.old_provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    let ready = LocalSessionCatalog::new(&fixture.discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| descriptor.lifecycle == SessionLifecycle::Ready)
        .collect::<Vec<_>>();
    assert_eq!(
        ready.len(),
        1,
        "crash retry created more than one successor"
    );
    assert_eq!(
        ready[0].session_id,
        receipt.replacement_receipt().session_id()
    );
    assert_eq!(
        probe_local_process_generation(&ready[0].provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "the one successor must own exactly one live provider generation"
    );
    let replayed = rehoster.rehost(fixture.request).unwrap();
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    assert_eq!(
        fs::read(&fixture.replacement_marker).unwrap(),
        b"conversation-abandoned-starting-crash",
        "crash retry launched more than one successor"
    );
    stop_ready_managed_test_sessions(&fixture.discovery_root, &fixture.cwd);
}

#[test]
fn managed_rehost_recovers_an_exact_abandoned_ready_generation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "abandoned-ready-source",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let paused_source = pause_exact_managed_test_host(&source.host_process);
    terminate_owned_test_process(&source.provider_process);
    terminate_owned_test_process(&source.host_process);
    wait_for_process_absent(&source.provider_process);
    wait_for_process_absent(&source.host_process);
    drop(paused_source);
    assert!(matches!(
        read_manifest(&discovery_root, &source.workspace_id, &source.session_id),
        DiscoveryManifest::Ready(_)
    ));

    let request = exact_managed_rehost_request("abandoned-ready-source-operation", &source, true)
        .with_expected_conversation_id("conversation-abandoned-ready-source")
        .unwrap();
    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect("an exact abandoned Ready generation must recover after both processes exit");

    assert_eq!(
        receipt.source_stop_receipt().outcome(),
        ManagedStopOutcome::AlreadyExited
    );
    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-abandoned-ready-source")
    );
    wait_for_file_content(&replacement_marker, b"conversation-abandoned-ready-source");
    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_restores_an_exact_conversation_after_source_manifest_loss() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "missing-ready-source",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let paused_source = pause_exact_managed_test_host(&source.host_process);
    terminate_owned_test_process(&source.provider_process);
    terminate_owned_test_process(&source.host_process);
    wait_for_process_absent(&source.provider_process);
    wait_for_process_absent(&source.host_process);
    drop(paused_source);
    let root = DiscoveryRoot::open(&discovery_root).unwrap();
    let key = SessionLookupKey::new(&source.workspace_id, &source.session_id).unwrap();
    fs::remove_file(root.session_base_path(&key).join("manifest.json")).unwrap();

    let mut wrong_source = source.clone();
    wrong_source.terminal_epoch.push_str("-changed");
    let wrong_request = v2_managed_rehost_request(
        "missing-ready-source-wrong-fence",
        &wrong_source,
        &cwd,
        &replacement_marker,
        "missing-ready-source",
        None,
    );
    let error = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(wrong_request)
        .expect_err("manifest loss must not let a changed generation fence resume");
    assert_eq!(error.code(), "hmux_managed_rehost_identity_mismatch");

    let request = v2_managed_rehost_request(
        "missing-ready-source-operation",
        &source,
        &cwd,
        &replacement_marker,
        "missing-ready-source",
        None,
    );
    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect("an exact resume must not require the obsolete source manifest");

    assert_eq!(
        receipt.source_stop_receipt().outcome(),
        ManagedStopOutcome::AlreadyExited
    );
    assert_eq!(
        receipt.source_stop_receipt().exit_reason(),
        "missing_discovery_generation"
    );
    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-missing-ready-source")
    );
    wait_for_file_content(&replacement_marker, b"conversation-missing-ready-source");
    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_recovers_an_exact_live_source_with_a_stale_transport() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "unresponsive-ready-source",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    fs::remove_file(&source.endpoint.address).unwrap();
    let stale_transport = UnixListener::bind(&source.endpoint.address).unwrap();
    let closed_handshake = thread::spawn(move || {
        let (mut transport, _) = stale_transport.accept().unwrap();
        let hello = hmux_host::local_protocol::FrameCodec::new(
            hmux_host::local_protocol::FrameLimits::default(),
        )
        .read_from(&mut transport)
        .unwrap();
        assert!(matches!(
            hello.body,
            hmux_host::local_protocol::FrameBody::Hello(_)
        ));
    });

    let request =
        exact_managed_rehost_request("unresponsive-ready-source-operation", &source, true)
            .with_expected_conversation_id("conversation-unresponsive-ready-source")
            .unwrap();
    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect("an exact conversation must replace a live generation with stale transport");
    closed_handshake.join().unwrap();

    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-unresponsive-ready-source")
    );
    wait_for_file_content(
        &replacement_marker,
        b"conversation-unresponsive-ready-source",
    );
    wait_for_process_absent(&source.provider_process);
    wait_for_process_absent(&source.host_process);
    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_uses_an_explicit_conversation_for_an_identityless_ready_source() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source_request = ManagedCreateRequest::new(
        "identityless-ready-source-create",
        "identityless-ready-source",
        "identityless-ready-workspace",
        "codex",
        PermissionMode::BypassApprovals,
        &cwd,
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap()
    .with_managed_rehost_recipe(
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s' \"$1\" >> \"$2\"; sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                replacement_marker.to_string_lossy().into_owned(),
            ],
            Some("credential-identityless-ready".into()),
        )
        .unwrap(),
    )
    .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(source_request)
        .unwrap();
    let source = created.session().descriptor().clone();
    let missing_selection =
        exact_managed_rehost_request("identityless-ready-source-without-selection", &source, true)
            .with_expected_provider_id("codex")
            .unwrap();
    let missing_selection_error =
        ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root)
            .rehost(missing_selection)
            .expect_err("an identity-less source still requires one explicit selection");
    assert_eq!(
        missing_selection_error.code(),
        "hmux_managed_rehost_conversation_required"
    );
    let request =
        exact_managed_rehost_request("identityless-ready-source-operation", &source, true)
            .with_expected_provider_id("codex")
            .unwrap()
            .with_expected_conversation_id("conversation-selected-by-user")
            .unwrap();

    let result = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request);
    let receipt = match result {
        Ok(receipt) => receipt,
        Err(error) => {
            stop_ready_managed_test_sessions(&discovery_root, &cwd);
            panic!(
                "an explicit replacement conversation must not depend on source identity: {error}"
            );
        }
    };

    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-selected-by-user")
    );
    wait_for_file_content(&replacement_marker, b"conversation-selected-by-user");
    wait_for_process_absent(&source.provider_process);
    // Provider retirement is the replacement boundary; the old Host may
    // remain briefly in its bounded cleanup after publishing Exited.
    terminate_owned_test_process_if_live(&source.host_process);
    wait_for_process_absent(&source.host_process);
    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_refuses_a_second_source_operation_before_successor_launch() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "single-successor",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let request = |operation_id| {
        exact_managed_rehost_request(operation_id, &source, true)
            .with_expected_conversation_id("conversation-single-successor")
            .unwrap()
    };

    rehoster.rehost(request("single-successor-a")).unwrap();
    wait_for_file_content(&replacement_marker, b"conversation-single-successor");

    let error = rehoster
        .rehost(request("single-successor-b"))
        .expect_err("one exact source must never launch a second direct successor");
    assert_eq!(error.code(), "hmux_managed_rehost_source_changed");
    assert_eq!(
        fs::read(&replacement_marker).unwrap(),
        b"conversation-single-successor",
        "the second operation crossed the replacement launch boundary"
    );

    stop_ready_managed_test_sessions(&discovery_root, &cwd);
}

#[test]
fn managed_rehost_refuses_a_changed_target_build_before_source_retirement() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "target-build-fence",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = v2_managed_rehost_request(
        "target-build-fence-operation",
        &source,
        &cwd,
        &replacement_marker,
        "target-build-fence",
        Some("credential-target-build-fence"),
    )
    .with_expected_target_build_id("not-the-running-build")
    .unwrap();

    let error = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect_err("a changed target build must fail before source retirement");
    assert_eq!(error.code(), "hmux_managed_rehost_target_build_changed");
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "target-build-fence-cleanup",
            &source,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_resolution_survives_completed_receipt_gc() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "receipt-gc",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let first_receipt = rehoster
        .rehost(exact_managed_rehost_request(
            "receipt-gc-operation",
            &source,
            true,
        ))
        .unwrap();
    wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);
    let first_replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            first_receipt.replacement_receipt().session_id(),
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    let second_receipt = rehoster
        .rehost(exact_managed_rehost_request(
            "receipt-gc-operation-2",
            &first_replacement,
            true,
        ))
        .unwrap();
    wait_for_exited(
        &discovery_root,
        &first_replacement.session_id,
        &first_replacement.workspace_id,
    );

    let start = Arc::new(Barrier::new(5));
    let readers = (0..4)
        .map(|_| {
            let start = Arc::clone(&start);
            let discovery_root = discovery_root.clone();
            let workspace_id = source.workspace_id.clone();
            let session_id = source.session_id.clone();
            thread::spawn(move || {
                start.wait();
                for _ in 0..8 {
                    let ManagedRehostResolutionLookup::Resolved(resolution) =
                        resolve_managed_rehost_current(&discovery_root, &workspace_id, &session_id)
                            .unwrap()
                    else {
                        panic!("a concurrent reader observed a partial successor chain")
                    };
                    assert_eq!(resolution.operation_ids().len(), 2);
                }
            })
        })
        .collect::<Vec<_>>();
    start.wait();

    let gc = garbage_collect_completed_action(
        &discovery_root,
        MANAGED_REHOST_RECOVERY_ACTION,
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(gc.removed_completed_records, 2);
    for reader in readers {
        reader.join().unwrap();
    }

    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(&discovery_root, &source.workspace_id, &source.session_id)
            .unwrap()
    else {
        panic!("receipt GC must retain the permanent managed-rehost successor authority")
    };
    assert_eq!(
        resolution.operation_ids(),
        ["receipt-gc-operation", "receipt-gc-operation-2"]
    );
    assert_eq!(
        resolution.current_generation().session_id(),
        second_receipt.replacement_receipt().session_id()
    );
}

#[test]
fn managed_rehost_crash_boundaries_retry_without_duplicate_provider_launch() {
    for fault in [
        "after_payload_journaled",
        "after_source_stop",
        "after_replacement_create",
    ] {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let replacement_marker = state.path().join("replacement-conversation");
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root)
            .create(rehostable_create_request(&cwd, &replacement_marker, fault))
            .unwrap();
        let source = created.session().descriptor().clone();
        let request = exact_managed_rehost_request(format!("fault-{fault}"), &source, true);

        run_crashing_managed_rehost(&discovery_root, &cwd, &request, fault);
        assert_eq!(
            resolve_managed_rehost_current(
                &discovery_root,
                &source.workspace_id,
                &source.session_id,
            )
            .unwrap(),
            ManagedRehostResolutionLookup::RetryRequired {
                operation_id: format!("fault-{fault}")
            }
        );
        let changed_hint_receipt = if fault == "after_payload_journaled" {
            let changed_hint = request
                .clone()
                .with_expected_conversation_id("different-conversation")
                .unwrap();
            let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
                .with_discovery_root(&discovery_root)
                .rehost(changed_hint)
                .expect("a retry hint must not block the journaled operation");
            assert!(receipt.replayed());
            Some(receipt)
        } else {
            None
        };
        let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root)
            .rehost(request.clone())
            .unwrap();
        if let Some(changed_hint_receipt) = changed_hint_receipt {
            assert!(receipt.replayed());
            assert_eq!(
                receipt.replacement_receipt().generation_fence(),
                changed_hint_receipt
                    .replacement_receipt()
                    .generation_fence()
            );
        }
        wait_for_file_content(
            &replacement_marker,
            format!("conversation-{fault}").as_bytes(),
        );
        wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);
        let replayed = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root)
            .rehost(request)
            .unwrap();
        assert!(replayed.replayed());
        assert_eq!(
            replayed.replacement_receipt().generation_fence(),
            receipt.replacement_receipt().generation_fence()
        );
        assert_eq!(
            fs::read(&replacement_marker).unwrap(),
            format!("conversation-{fault}").as_bytes()
        );

        let replacement = LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                receipt.replacement_receipt().session_id(),
                Some(source.workspace_id.clone()),
            ))
            .unwrap();
        ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root)
            .stop(exact_managed_stop_request(
                format!("fault-{fault}-cleanup"),
                &replacement,
            ))
            .unwrap();
    }
}

#[test]
fn managed_rehost_retry_after_source_retirement_uses_only_the_durable_operation_identity() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "journal-authority",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = v2_managed_rehost_request(
        "journal-authority-operation",
        &source,
        &cwd,
        &replacement_marker,
        "journal-authority",
        Some("credential-journal-authority"),
    );

    run_crashing_managed_rehost(&discovery_root, &cwd, &request, "after_source_stop");
    wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);

    let hintless_retry =
        exact_managed_rehost_request("journal-authority-operation", &source, false);
    let rehoster = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let receipt = rehoster.rehost(hintless_retry).unwrap();
    assert!(receipt.replayed());
    assert_eq!(
        receipt.conversation_id(),
        Some("conversation-journal-authority")
    );
    wait_for_file_content(&replacement_marker, b"conversation-journal-authority");

    let changed_hints = request
        .with_expected_provider_id("different-provider")
        .unwrap()
        .with_expected_conversation_id("different-conversation")
        .unwrap()
        .with_expected_launch_reference("different-launch")
        .unwrap()
        .with_expected_target_build_id("different-build")
        .unwrap();
    let replayed = rehoster.rehost(changed_hints).unwrap();
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    assert_eq!(
        fs::read(&replacement_marker).unwrap(),
        b"conversation-journal-authority"
    );

    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "journal-authority-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_refuses_environment_capability_loss_before_source_stop() {
    let state = tempfile::tempdir().unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let selected_home = state.path().join("selected-home");
    fs::create_dir(&selected_home).unwrap();
    let mutations = [
        (
            "set",
            ProviderStateEnvironment::from_mutations(
                BTreeMap::from([(
                    "CODEX_HOME".to_string(),
                    selected_home.to_string_lossy().into_owned(),
                )]),
                BTreeSet::new(),
            )
            .unwrap(),
            PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
        ),
        (
            "remove",
            ProviderStateEnvironment::from_mutations(
                BTreeMap::new(),
                BTreeSet::from(["CODEX_HOME".to_string()]),
            )
            .unwrap(),
            PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY,
        ),
    ];

    for (mutation_name, environment, omitted_capability) in mutations {
        for payload_journaled in [false, true] {
            let phase = if payload_journaled {
                "journaled-replay"
            } else {
                "new-prepare"
            };
            let suffix = format!("capability-{mutation_name}-{phase}");
            let discovery_root = state.path().join(format!("discovery-{suffix}"));
            let replacement_marker = state.path().join(format!("replacement-{suffix}"));
            let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
                .with_discovery_root(&discovery_root)
                .create(rehostable_create_request(
                    &cwd,
                    &replacement_marker,
                    &suffix,
                ))
                .unwrap();
            let source = created.session().descriptor().clone();
            let request = provider_state_managed_rehost_request(
                format!("operation-{suffix}"),
                &source,
                &cwd,
                &replacement_marker,
                &suffix,
                environment.clone(),
            );
            if payload_journaled {
                run_crashing_managed_rehost(
                    &discovery_root,
                    &cwd,
                    &request,
                    "after_payload_journaled",
                );
            }

            let response = run_managed_rehost_with_omitted_capabilities(
                &discovery_root,
                &cwd,
                &request,
                omitted_capability,
            );
            let ManagedRehostBrokerResponse::Refused(failure) = response else {
                panic!(
                    "{phase} {mutation_name} mutation without {omitted_capability} must be refused"
                )
            };
            assert_eq!(failure.code, "hmux_managed_rehost_request_invalid");
            let current = LocalSessionCatalog::new(&discovery_root)
                .find(&SessionSelector::new(
                    &source.session_id,
                    Some(source.workspace_id.clone()),
                ))
                .unwrap();
            assert_eq!(current.lifecycle, SessionLifecycle::Ready);
            assert!(current.same_generation(&source));
            assert!(matches!(
                probe_local_process_generation(&source.provider_process).unwrap(),
                LocalProcessGenerationStatus::Live
            ));
            assert!(
                !replacement_marker.exists(),
                "{phase} {mutation_name} refusal launched the replacement"
            );
            let ready = ready_managed_sessions(&discovery_root);
            assert_eq!(ready.len(), 1);
            assert_eq!(ready[0].session_id, source.session_id);

            ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
                .with_discovery_root(&discovery_root)
                .stop(exact_managed_stop_request(
                    format!("cleanup-{suffix}"),
                    &source,
                ))
                .unwrap();
        }
    }
}

#[test]
fn managed_rehost_retry_ignores_source_output_and_changed_hints_after_payload_journal() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request_with_command(
            &cwd,
            &replacement_marker,
            "advancing-source",
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "i=1; while [ \"$i\" -le 400 ]; do printf 'ADVANCE_%04d\\n' \"$i\"; i=$((i + 1)); sleep 0.01; done; sleep 30".into(),
            ],
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    wait_for_screen_text(created.session(), &["ADVANCE_0001"]);
    let request = exact_managed_rehost_request("advancing-source-operation", &source, true);

    run_crashing_managed_rehost(&discovery_root, &cwd, &request, "after_payload_journaled");
    wait_for_screen_text(created.session(), &["ADVANCE_0020"]);
    let changed_hint = request
        .with_expected_conversation_id("changed-after-journal")
        .unwrap();
    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(changed_hint)
        .expect("journaled exact resume must ignore later terminal output and client hints");

    assert!(receipt.replayed());
    wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);
    wait_for_file_content(&replacement_marker, b"conversation-advancing-source");
    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "advancing-source-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_retry_uses_durable_target_receipt_when_attach_is_temporarily_unavailable() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "fresh-target-handshake",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = exact_managed_rehost_request("fresh-target-handshake-operation", &source, true);
    run_crashing_managed_rehost(&discovery_root, &cwd, &request, "after_replacement_create");
    let target = ready_rehost_target(&discovery_root, &source);
    let paused_target = pause_exact_managed_test_host(&target.host_process);

    let started = Instant::now();
    let retry = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request);
    let elapsed = started.elapsed();
    let source_lifecycle = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap()
        .lifecycle;
    drop(paused_target);
    stop_ready_managed_test_sessions(&discovery_root, &cwd);

    let receipt =
        retry.expect("a completed target receipt is durable attach-independent authority");
    assert!(receipt.replayed());
    assert_eq!(source_lifecycle, SessionLifecycle::Exited);
    assert!(
        elapsed < Duration::from_secs(8),
        "durable target receipt replay waited on presentation health: {elapsed:?}"
    );
}

#[test]
fn managed_rehost_retry_reconciles_source_stop_before_receipt_checkpoint() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "source-stop-side-effect",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = exact_managed_rehost_request("source-stop-side-effect-operation", &source, true);

    run_crashing_managed_rehost_at_stop_side_effect(&discovery_root, &cwd, &request);
    let before_retry = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap()
        .lifecycle;
    let retry = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request);
    let marker = fs::read(&replacement_marker).unwrap();
    stop_ready_managed_test_sessions(&discovery_root, &cwd);

    assert_eq!(before_retry, SessionLifecycle::Exited);
    let receipt = retry.expect("the exact durable stop intent must reconcile on retry");
    assert!(receipt.replayed());
    assert_eq!(marker, b"conversation-source-stop-side-effect");
}

#[test]
fn managed_rehost_stops_exact_source_before_replacement_create() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "completed-target-resume",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = exact_managed_rehost_request("completed-target-resume-operation", &source, true);

    run_crashing_managed_rehost_at_create_completion(&discovery_root, &cwd, &request);
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Exited,
        "the exact source stop receipt must be durable before a replacement provider can start"
    );
    let retry = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request);
    let marker = fs::read(&replacement_marker).unwrap();
    stop_ready_managed_test_sessions(&discovery_root, &cwd);

    let receipt = retry.expect("the exact completed target ledger must resume on retry");
    assert!(receipt.replayed());
    assert_eq!(marker, b"conversation-completed-target-resume");
}

#[test]
fn managed_rehost_reconcile_uses_the_journal_instead_of_changed_client_hints() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "reconcile",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = v2_managed_rehost_request(
        "reconcile-operation",
        &source,
        &cwd,
        &replacement_marker,
        "reconcile",
        Some("credential-reconcile"),
    );
    let reconcile = ManagedRehostReconcileRequest::by_operation_identity(
        request.operation_id(),
        request.source().session_id(),
        request.source().workspace_id(),
    )
    .unwrap();

    run_crashing_managed_rehost(&discovery_root, &cwd, &request, "after_source_stop");
    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .reconcile(reconcile)
        .expect("source-retired retry must need only durable operation identity");

    assert!(receipt.replayed());
    assert_eq!(receipt.conversation_id(), Some("conversation-reconcile"));
    assert_eq!(
        receipt.launch_reference(),
        Some("credential-target-reconcile")
    );
    let changed_hints = ManagedRehostReconcileRequest::new(
        request.operation_id(),
        request.source().clone(),
        "different-provider",
        "different-conversation",
        Some("different-launch".to_string()),
    )
    .unwrap();
    let replayed = run_managed_rehost_reconcile(&discovery_root, &cwd, &changed_hints);
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );
    wait_for_file_content(&replacement_marker, b"conversation-reconcile");
    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "reconcile-replacement-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_v2_replaces_a_pre_recipe_source_from_the_complete_packet() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "pre-recipe-source-create",
        "pre-recipe-source",
        "pre-recipe-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
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
        ProviderConversationIdentitySeed::new("codex", "conversation-pre-recipe").unwrap(),
    )
    .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request)
        .unwrap();
    let source = created.session().descriptor().clone();
    let hinted_request = v2_managed_rehost_request(
        "pre-recipe-operation",
        &source,
        &cwd,
        &replacement_marker,
        "pre-recipe",
        None,
    );
    let request = exact_managed_rehost_request("pre-recipe-operation", &source, true)
        .with_replacement(hinted_request.replacement().unwrap().clone())
        .unwrap();

    let unverifiable = request
        .clone()
        .with_expected_launch_reference("unknown-source-profile")
        .unwrap();
    let error = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(unverifiable)
        .expect_err("a pre-recipe source cannot satisfy a source launch-reference assertion");
    assert_eq!(error.code(), "hmux_managed_rehost_identity_mismatch");
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );

    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request.clone())
        .unwrap();

    assert!(!receipt.replayed());
    assert_eq!(receipt.conversation_id(), Some("conversation-pre-recipe"));
    assert_eq!(
        receipt.launch_reference(),
        Some("credential-target-pre-recipe")
    );
    wait_for_file_content(&replacement_marker, b"conversation-pre-recipe");
    wait_for_exited(&discovery_root, &source.session_id, &source.workspace_id);
    let replayed = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .unwrap();
    assert!(replayed.replayed());
    assert_eq!(
        replayed.replacement_receipt().generation_fence(),
        receipt.replacement_receipt().generation_fence()
    );

    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "pre-recipe-replacement-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_rehost_refuses_a_pre_recipe_source_without_stopping_it() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "legacy-source-create",
        "legacy-source",
        "legacy-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
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
        ProviderConversationIdentitySeed::new("codex", "legacy-conversation").unwrap(),
    )
    .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request)
        .unwrap();
    let source = created.session().descriptor().clone();

    let error = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(exact_managed_rehost_request(
            "legacy-operation",
            &source,
            true,
        ))
        .expect_err("legacy sources must not be reconstructed from discovery projections");
    assert_eq!(error.code(), "hmux_managed_rehost_recipe_missing");
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request("legacy-cleanup", &source))
        .unwrap();
}

#[test]
fn managed_rehost_ignores_missing_optional_presentation_after_intent_is_journaled() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "checkpoint-preflight",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let request = exact_managed_rehost_request("checkpoint-preflight-operation", &source, true);
    run_crashing_managed_rehost(&discovery_root, &cwd, &request, "after_payload_journaled");
    let checkpoint_source = PresentationCheckpointSource::new(
        &source.workspace_id,
        &source.session_id,
        &source.runner_principal,
        &source.runner_instance,
        source.channel_epoch.parse().unwrap(),
        &source.host_instance_id,
        &source.terminal_epoch,
    )
    .unwrap();
    let root = DiscoveryRoot::open(&discovery_root).unwrap();
    let discovery = root
        .open_session(checkpoint_source.discovery_key().unwrap())
        .unwrap();
    let handoff_path = fs::read_dir(discovery.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("presentation-handoff-") && name.ends_with(".json")
                })
        });
    if let Some(handoff_path) = handoff_path {
        fs::remove_file(handoff_path).unwrap();
    }

    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(request)
        .expect("missing optional presentation must not block the journaled exact resume");
    assert!(receipt.replayed());
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                &source.session_id,
                Some(source.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Exited
    );

    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "checkpoint-preflight-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn managed_rehost_ignores_an_unrestorable_optional_presentation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(rehostable_create_request_with_command(
            &cwd,
            &replacement_marker,
            "unrestorable-presentation",
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf 'source\\n'; sleep 30".into(),
            ],
        ))
        .unwrap();
    wait_for_screen_text(source.session(), &["source"]);
    let found = DiscoveryRoot::open(&discovery_root)
        .unwrap()
        .find_manifest_by_session(
            source.receipt().workspace_id(),
            source.receipt().session_id(),
        )
        .unwrap();
    let presentation_path = found.discovery_path.join("presentation.json");
    wait_for_path(&presentation_path);
    let mut checkpoint: serde_json::Value =
        serde_json::from_slice(&fs::read(&presentation_path).unwrap()).unwrap();
    assert_eq!(checkpoint["encoding"], "engine_native_v1");
    checkpoint["stateBytes"] = serde_json::Value::String("AA".to_string());
    fs::write(&presentation_path, serde_json::to_vec(&checkpoint).unwrap()).unwrap();

    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(exact_managed_rehost_request(
            "unrestorable-presentation-operation",
            source.session().descriptor(),
            true,
        ))
        .expect("optional presentation failure must not block exact conversation resume");
    wait_for_file_content(
        &replacement_marker,
        b"conversation-unrestorable-presentation",
    );
    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(receipt.replacement_receipt().workspace_id().to_string()),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "unrestorable-presentation-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_create_is_idempotent_and_reattaches_to_one_provider_pty() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let spawn_marker = state.path().join("provider-spawns");
    let canonical_home = state.path().join("canonical-codex-home");
    fs::create_dir(&canonical_home).unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "spawn_contract_1",
        "agent_managed_1",
        "workspace_managed_1",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf x >> \"$1\"; printf 'cwd:%s\\n' \"$PWD\"; printf 'codex-home:%s\\n' \"$CODEX_HOME\"; IFS= read -r first; printf 'first:%s\\n' \"$first\"; IFS= read -r second; printf 'second:%s\\n' \"$second\"; exit 7".into(),
            "--".into(),
            spawn_marker.to_string_lossy().into_owned(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            "CODEX_HOME".to_string(),
            canonical_home.to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);

    let first = creator.create(request.clone()).unwrap();
    assert_eq!(first.receipt().outcome(), ManagedCreateOutcome::Created);
    assert_eq!(
        first.session().descriptor().session_class,
        SessionClass::Managed
    );
    assert!(
        first
            .session()
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == "provider_state_environment_v1")
    );
    assert!(
        !first
            .session()
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == "standalone_termination")
    );
    let provider_pid = first.session().descriptor().provider_process.process_id;
    let checkpoint_source = PresentationCheckpointSource::new(
        &first.session().descriptor().workspace_id,
        &first.session().descriptor().session_id,
        &first.session().descriptor().runner_principal,
        &first.session().descriptor().runner_instance,
        first.session().descriptor().channel_epoch.parse().unwrap(),
        &first.session().descriptor().host_instance_id,
        &first.session().descriptor().terminal_epoch,
    )
    .unwrap();
    wait_for_file_content(&spawn_marker, b"x");
    assert_tree_omits(&discovery_root, &canonical_home.to_string_lossy());

    let duplicate = creator.create(request).unwrap();
    assert_eq!(duplicate.receipt().outcome(), ManagedCreateOutcome::Reused);
    assert_eq!(
        duplicate.session().descriptor().provider_process.process_id,
        provider_pid
    );
    assert_eq!(fs::read(&spawn_marker).unwrap(), b"x");

    let process = std::process::Command::new("ps")
        .args(["-p", &provider_pid.to_string(), "-o", "command="])
        .output()
        .unwrap();
    assert!(process.status.success());
    assert!(!String::from_utf8_lossy(&process.stdout).contains("hebbian-session"));

    let attacher = || {
        ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root)
            .attach(
                hmux_client::ManagedAttachRequest::new("agent_managed_1", "workspace_managed_1")
                    .unwrap(),
            )
            .unwrap()
    };
    let mut controller = attacher();
    let resize_id = controller.mutation_handle().resize(42, 100).unwrap();
    let input_id = controller
        .mutation_handle()
        .send_input(b"one\n".to_vec())
        .unwrap();
    wait_for_receipts(&mut controller, &input_id, &resize_id);
    controller.detach().unwrap();

    // A fresh client object models panel close/reopen or an app restart.
    let mut reattached = attacher();
    assert_eq!(
        reattached.attachment().session.provider_process.process_id,
        provider_pid
    );
    assert_eq!(
        reattached
            .attachment()
            .initial_snapshot
            .working_directory
            .as_ref()
            .map(|directory| directory.path.clone()),
        Some(cwd.to_string_lossy().into_owned())
    );
    let initial = String::from_utf8_lossy(&reattached.attachment().initial_snapshot.repaint_bytes)
        .replace("\r\n", "");
    assert!(
        initial.contains(&canonical_home.to_string_lossy().to_string()),
        "{initial:?}"
    );
    let input_id = reattached
        .mutation_handle()
        .send_input(b"two\n".to_vec())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut wrote = false;
    let mut output = Vec::new();
    let exit = loop {
        match reattached.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt))
                if receipt.request_id == input_id
                    && receipt.state == ControllerReceiptState::WrittenToPty =>
            {
                wrote = true;
            }
            Some(ControllerEvent::Output(delta)) => output.extend(delta.bytes),
            Some(ControllerEvent::Exit(exit)) => break exit,
            Some(_) => {}
            None => panic!("managed controller disconnected before typed provider exit"),
        }
        assert!(Instant::now() < deadline, "managed provider did not exit");
    };
    assert!(wrote);
    assert_eq!(exit.exit_code, Some(7));
    assert!(exit.reason.contains("provider exited with status 7"));
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("second:two"), "{output:?}");

    wait_for_exited(
        &discovery_root,
        first.receipt().session_id(),
        first.receipt().workspace_id(),
    );
    let root = DiscoveryRoot::open(&discovery_root).unwrap();
    let found = root
        .find_manifest_by_session(first.receipt().workspace_id(), first.receipt().session_id())
        .unwrap();
    let DiscoveryManifest::Exited(exited) = found.manifest else {
        panic!("managed provider did not retain its exited tombstone")
    };
    let tombstone = serde_json::to_value(&exited.tombstone).unwrap();
    let failure = tombstone
        .get("failure")
        .expect("managed provider failure did not survive Host exit");
    assert_eq!(failure.as_object().map(|fields| fields.len()), Some(11));
    assert_eq!(
        failure["code"],
        "provider_exited_before_conversation_identity"
    );
    assert_eq!(failure["phase"], "conversation_identity");
    assert_eq!(failure["session_id"], "agent_managed_1");
    assert_eq!(failure["workspace_id"], "workspace_managed_1");
    assert_eq!(failure["exit_code"], 7);
    assert_eq!(failure["retry_posture"], "never");
    assert!(
        failure["correlation_id"]
            .as_str()
            .is_some_and(|value| value.starts_with("failure_"))
    );
    assert_eq!(
        failure["occurred_unix_ms"],
        exited.tombstone.created_unix_ms
    );
    let catalog_failure = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            "agent_managed_1",
            Some("workspace_managed_1".to_string()),
        ))
        .unwrap()
        .failure
        .expect("catalog projection lost the exited failure");
    assert_eq!(
        Some(catalog_failure.correlation_id.as_str()),
        failure["correlation_id"].as_str()
    );
    assert_eq!(
        catalog_failure.code,
        "provider_exited_before_conversation_identity"
    );
    let persisted_failure = failure.to_string();
    assert!(!persisted_failure.contains("second:two"));
    assert!(!persisted_failure.contains(&canonical_home.to_string_lossy().to_string()));
    let checkpoint = root
        .open_session(found.key)
        .unwrap()
        .read_presentation_checkpoint(&checkpoint_source)
        .unwrap()
        .expect("final presentation checkpoint was not retained");
    assert_eq!(
        checkpoint.sequence_through(),
        exited.tombstone.exit.final_output_seq,
        "final checkpoint and exited tombstone must share the exact output fence"
    );
}

#[test]
fn managed_create_refuses_a_second_live_exact_conversation_writer_before_spawn() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let fault_marker = state.path().join("competing-spawn-reached");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let first_request = conversation_writer_request(
        &cwd,
        "live-owner",
        "writer-workspace-1",
        "conversation-writer-1",
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
    );
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let first = creator.create(first_request).unwrap();
    let competing_request = conversation_writer_request(
        &cwd,
        "competing-owner",
        "writer-workspace-2",
        "conversation-writer-1",
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
    );

    let response =
        run_faulted_managed_create(&discovery_root, &cwd, &competing_request, &fault_marker);
    let ManagedCreateBrokerResponse::Refused(failure) = response else {
        panic!("the competing exact conversation writer must be refused")
    };
    assert_eq!(failure.code, MANAGED_CONVERSATION_WRITER_CONFLICT_CODE);
    assert!(
        !fault_marker.exists(),
        "conversation admission must refuse before the pre-spawn boundary"
    );
    let client_error = creator.create(competing_request.clone()).unwrap_err();
    assert_eq!(
        client_error.code(),
        MANAGED_CONVERSATION_WRITER_CONFLICT_CODE
    );

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "release-live-conversation-writer",
            first.session().descriptor(),
        ))
        .unwrap();
    let replacement = creator.create(competing_request).unwrap();
    assert_eq!(
        replacement.receipt().outcome(),
        ManagedCreateOutcome::Created
    );
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "cleanup-replacement-conversation-writer",
            replacement.session().descriptor(),
        ))
        .unwrap();
}

#[test]
fn exited_exact_conversation_writer_durably_yields_to_a_new_session() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_exit_marker = state.path().join("natural-writer-exit");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let first = creator
        .create(conversation_writer_request(
            &cwd,
            "naturally-exited-owner",
            "writer-workspace-1",
            "conversation-writer-exited",
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "while [ ! -f \"$1\" ]; do sleep 0.02; done".into(),
                "--".into(),
                provider_exit_marker.to_string_lossy().into_owned(),
            ],
        ))
        .unwrap();
    let owner_path =
        SessionLookupKey::new(first.receipt().workspace_id(), first.receipt().session_id())
            .unwrap()
            .relative_path();
    assert!(
        managed_create_ledger::pending_session_paths(&discovery_root)
            .unwrap()
            .contains(&owner_path),
        "GC must preserve the terminal evidence until the Host checkpoints release"
    );
    fs::write(&provider_exit_marker, b"exit").unwrap();
    wait_for_exited(
        &discovery_root,
        first.receipt().session_id(),
        first.receipt().workspace_id(),
    );
    let replacement_request = conversation_writer_request(
        &cwd,
        "after-natural-exit",
        "writer-workspace-2",
        "conversation-writer-exited",
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
    );
    let release_deadline = Instant::now() + Duration::from_secs(3);
    let replacement = loop {
        match creator.create_with_disposition(replacement_request.clone()) {
            Ok(replacement) => break replacement,
            Err(error) if error.code() == MANAGED_CONVERSATION_WRITER_CONFLICT_CODE => {
                assert!(
                    Instant::now() < release_deadline,
                    "the Host did not durably checkpoint the exited conversation writer"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("conversation writer release failed: {error}"),
        }
    };
    assert!(
        managed_create_ledger::pending_session_paths(&discovery_root)
            .unwrap()
            .contains(&owner_path),
        "writer release must not expose an unretired completed source to GC"
    );
    assert_eq!(
        replacement.receipt().outcome(),
        ManagedCreateOutcome::Created
    );
    let replayed = creator.create(replacement_request).unwrap();
    assert_eq!(replayed.receipt().outcome(), ManagedCreateOutcome::Reused);
    assert_eq!(
        replayed.session().descriptor().provider_process,
        replacement.session().descriptor().provider_process
    );

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "cleanup-natural-exit-replacement",
            replacement.session().descriptor(),
        ))
        .unwrap();
}

#[test]
fn completed_create_receipt_replays_after_the_provider_cwd_is_removed() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_cwd = state.path().join("ephemeral-provider-cwd");
    fs::create_dir(&provider_cwd).unwrap();
    let broker_cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "removed-cwd-create",
        "removed-cwd-session",
        "removed-cwd-workspace",
        "codex",
        PermissionMode::Default,
        &provider_cwd,
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);

    let created = creator.create(request.clone()).unwrap();
    fs::remove_dir(&provider_cwd).unwrap();
    let replayed = creator
        .create(request)
        .expect("a durable receipt must not depend on a mutable provider cwd");

    assert_eq!(replayed.receipt().outcome(), ManagedCreateOutcome::Reused);
    assert_eq!(
        replayed.receipt().generation_fence(),
        created.receipt().generation_fence()
    );
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &broker_cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "removed-cwd-cleanup",
            created.session().descriptor(),
        ))
        .unwrap();
}

#[test]
fn definite_pre_spawn_failure_retries_without_poisoning_the_create_ledger() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let fault_marker = state.path().join("before-spawn-fault");
    let provider_spawns = state.path().join("provider-spawns");
    fs::write(&fault_marker, b"fail").unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "pre-spawn-retry-create",
        "pre-spawn-retry-session",
        "pre-spawn-retry-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf x >> \"$1\"; sleep 30".into(),
            "--".into(),
            provider_spawns.to_string_lossy().into_owned(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();

    let response = run_faulted_managed_create(&discovery_root, &cwd, &request, &fault_marker);
    let ManagedCreateBrokerResponse::Refused(failure) = response else {
        panic!("faulted pre-spawn create must be refused")
    };
    assert_eq!(failure.code, "hmux_managed_launch_failed");
    assert_eq!(fs::read(&fault_marker).unwrap(), b"observed");
    assert!(!provider_spawns.exists());

    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request.clone())
        .unwrap();
    wait_for_file_content(&provider_spawns, b"x");
    assert_eq!(fs::read(&provider_spawns).unwrap(), b"x");

    let descriptor = created.session().descriptor();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "pre-spawn-retry-cleanup",
            descriptor,
        ))
        .unwrap();
    let retired = DiscoveryRoot::open(&discovery_root)
        .unwrap()
        .find_manifest_by_session(
            created.receipt().workspace_id(),
            created.receipt().session_id(),
        )
        .unwrap();
    fs::remove_dir_all(retired.discovery_path).unwrap();

    let error = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(request)
        .expect_err("manifest cleanup must not reopen the completed create intent");
    assert_eq!(error.code(), MANAGED_CREATE_RETIRED_EXACT_CODE);
    assert_eq!(
        error.disposition(),
        ManagedCreateFailureDisposition::Rejected
    );
    assert_eq!(fs::read(&provider_spawns).unwrap(), b"x");
}

#[test]
fn managed_create_recovers_collectable_discovery_capacity() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let root = DiscoveryRoot::create(&discovery_root).unwrap();
    for index in 0..1_024 {
        let session_id = format!("capacity-debris-{index:04}");
        drop(
            root.session(
                DiscoveryKey::new("capacity-workspace", &session_id, "runner", 1).unwrap(),
            )
            .unwrap(),
        );
    }
    assert_eq!(root.registration_capacity().unwrap().remaining, 0);

    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "capacity-recovery-create",
        "capacity-recovery-session",
        "capacity-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        vec!["/bin/sleep".into(), "30".into()],
        24,
        80,
    )
    .unwrap();
    let created = match ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_or_reconcile_and_advance(request)
        .expect("collectable discovery state must not block a new provider")
    {
        ManagedCreateAdvanceResolution::Current(created) => created,
        other => panic!("fresh create returned an unexpected resolution: {other:?}"),
    };
    assert!(
        root.registration_capacity().unwrap().used <= 512,
        "managed admission must keep the new session within the 50% ceiling"
    );

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "capacity-recovery-cleanup",
            created.session().descriptor(),
        ))
        .unwrap();
}

#[test]
fn managed_rehost_recovers_capacity_before_retiring_its_source() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(rehostable_create_request(
            &cwd,
            &replacement_marker,
            "capacity",
        ))
        .unwrap();
    let source = created.session().descriptor().clone();
    let root = DiscoveryRoot::open(&discovery_root).unwrap();
    for index in 0..1_023 {
        let session_id = format!("capacity-rehost-debris-{index:04}");
        drop(
            root.session(
                DiscoveryKey::new("capacity-rehost-debris", &session_id, "runner", 1).unwrap(),
            )
            .unwrap(),
        );
    }
    assert_eq!(root.registration_capacity().unwrap().remaining, 0);

    let receipt = ManagedSessionRehoster::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .rehost(exact_managed_rehost_request(
            "capacity-rehost-operation",
            &source,
            true,
        ))
        .expect("collectable discovery state must be reclaimed before source retirement");
    let replacement = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "capacity-rehost-cleanup",
            &replacement,
        ))
        .unwrap();
}

#[test]
fn managed_create_refuses_missing_environment_capabilities_before_provider_side_effects() {
    let state = tempfile::tempdir().unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let selected_home = state.path().join("selected-home");
    fs::create_dir(&selected_home).unwrap();
    let cases = [
        (
            "set",
            ProviderStateEnvironment::from_mutations(
                BTreeMap::from([(
                    "CODEX_HOME".to_string(),
                    selected_home.to_string_lossy().into_owned(),
                )]),
                BTreeSet::new(),
            )
            .unwrap(),
            PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
        ),
        (
            "remove",
            ProviderStateEnvironment::from_mutations(
                BTreeMap::new(),
                BTreeSet::from(["CODEX_HOME".to_string()]),
            )
            .unwrap(),
            PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY,
        ),
        (
            "mixed-without-set",
            ProviderStateEnvironment::from_mutations(
                BTreeMap::from([(
                    "CODEX_HOME".to_string(),
                    selected_home.to_string_lossy().into_owned(),
                )]),
                BTreeSet::from(["OPENAI_API_KEY".to_string()]),
            )
            .unwrap(),
            PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
        ),
        (
            "mixed-without-remove",
            ProviderStateEnvironment::from_mutations(
                BTreeMap::from([(
                    "CODEX_HOME".to_string(),
                    selected_home.to_string_lossy().into_owned(),
                )]),
                BTreeSet::from(["OPENAI_API_KEY".to_string()]),
            )
            .unwrap(),
            PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY,
        ),
    ];

    for (suffix, environment, omitted_capability) in cases {
        let discovery_root = state.path().join(format!("discovery-{suffix}"));
        let provider_marker = state.path().join(format!("provider-{suffix}"));
        let request = ManagedCreateRequest::new(
            format!("missing-capability-create-{suffix}"),
            format!("missing-capability-session-{suffix}"),
            format!("missing-capability-workspace-{suffix}"),
            "codex",
            PermissionMode::Default,
            &cwd,
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf 'spawned' > \"$1\"; sleep 30".into(),
                "--".into(),
                provider_marker.to_string_lossy().into_owned(),
            ],
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(environment)
        .unwrap();

        let response = run_managed_create_with_omitted_capabilities(
            &discovery_root,
            &cwd,
            &request,
            omitted_capability,
        );
        let ManagedCreateBrokerResponse::Refused(failure) = response else {
            panic!("{suffix} mutation without {omitted_capability} must be refused")
        };
        assert_eq!(failure.code, MANAGED_CREATE_REQUEST_INVALID_CODE);
        assert!(
            !provider_marker.exists(),
            "{suffix} refusal crossed the provider spawn boundary"
        );
        assert!(
            LocalSessionCatalog::new(&discovery_root)
                .list()
                .unwrap()
                .is_empty(),
            "{suffix} refusal published a managed generation"
        );
    }
}

#[test]
fn crash_after_spawn_reservation_before_host_release_retries_exactly_once() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "reserved-host-retry-create",
        "reserved-host-retry-session",
        "reserved-host-retry-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf x >> \"$1\"; sleep 30".into(),
            "--".into(),
            provider_spawns.to_string_lossy().into_owned(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();

    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_spawn_reserved_before_host_release",
    );
    assert!(
        !provider_spawns.exists(),
        "the blocked Host must not release a provider before the durable boundary"
    );

    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request)
        .unwrap();
    wait_for_file_content(&provider_spawns, b"x");
    assert_eq!(fs::read(&provider_spawns).unwrap(), b"x");

    let descriptor = created.session().descriptor();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "reserved-host-retry-cleanup",
            descriptor,
        ))
        .unwrap();
}

#[test]
fn crash_after_launch_release_before_packet_write_retries_exactly_once() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "released-before-packet-retry-create",
        "released-before-packet-retry-session",
        "released-before-packet-retry-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf x >> \"$1\"; sleep 30".into(),
            "--".into(),
            provider_spawns.to_string_lossy().into_owned(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();

    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_launch_released_before_packet_write",
    );
    assert!(
        !provider_spawns.exists(),
        "the inert Host must not launch a provider before receiving its packet"
    );

    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request)
        .unwrap();
    wait_for_file_content(&provider_spawns, b"x");
    assert_eq!(fs::read(&provider_spawns).unwrap(), b"x");

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "released-before-packet-retry-cleanup",
            created.session().descriptor(),
        ))
        .unwrap();
}

#[test]
fn released_create_stays_fail_closed_after_stop_and_manifest_gc() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "released-create",
        "released-session",
        "released-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf x >> \"$1\"; sleep 30".into(),
            "--".into(),
            provider_spawns.to_string_lossy().into_owned(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();

    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_host_launch_packet_write",
    );
    wait_for_file_content(&provider_spawns, b"x");
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let deadline = Instant::now() + Duration::from_secs(10);
    let descriptor = loop {
        if let Ok(descriptor) = catalog.find(&SessionSelector::new(
            "released-session",
            Some("released-workspace".to_string()),
        )) {
            if descriptor.lifecycle == SessionLifecycle::Ready {
                break descriptor;
            }
        }
        assert!(
            Instant::now() < deadline,
            "released Host did not become ready"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request("released-stop", &descriptor))
        .unwrap();
    let retired = DiscoveryRoot::open(&discovery_root)
        .unwrap()
        .find_manifest_by_session("released-workspace", "released-session")
        .unwrap();
    fs::remove_dir_all(retired.discovery_path).unwrap();

    let error = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request)
        .expect_err("a released and stopped create must never respawn after manifest GC");
    assert!(error.to_string().contains("retired"), "{error}");
    assert_eq!(fs::read(&provider_spawns).unwrap(), b"x");
}

#[test]
fn chain_stop_uses_generation_authority_when_conversation_publishes_after_completion() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "published-conversation-create",
        "published-conversation-session",
        "published-conversation-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request.clone())
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    publish_provider_conversation_identity(
        &discovery_root,
        &cwd,
        &descriptor,
        "codex",
        "conversation-published-after-completion",
    );
    let root = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);

    let stopped = match stopper.stop_create_chain_v2(root.clone()) {
        Ok(stopped) => stopped,
        Err(error) => {
            terminate_owned_test_process_if_live(&descriptor.provider_process);
            terminate_owned_test_process_if_live(&descriptor.host_process);
            panic!("generation-authorized chain stop failed: {error}");
        }
    };
    assert_eq!(stopped.chain(), &[root]);
    assert_eq!(
        stopped.stop_receipt().unwrap().session_id(),
        descriptor.session_id,
    );
    wait_for_process_absent(&descriptor.provider_process);
}

#[test]
fn chain_stop_recovers_a_ready_generation_after_create_response_loss() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "released-chain-create",
        "released-chain-session",
        "released-chain-workspace",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf x >> \"$1\"; sleep 30".into(),
            "--".into(),
            provider_spawns.to_string_lossy().into_owned(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_host_launch_packet_write",
    );
    wait_for_file_content(&provider_spawns, b"x");
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let deadline = Instant::now() + Duration::from_secs(10);
    let descriptor = loop {
        if let Ok(descriptor) = catalog.find(&SessionSelector::new(
            request.session_id(),
            Some(request.workspace_id().to_string()),
        )) {
            if descriptor.lifecycle == SessionLifecycle::Ready {
                break descriptor;
            }
        }
        assert!(
            Instant::now() < deadline,
            "released Host did not become ready"
        );
        thread::sleep(Duration::from_millis(10));
    };
    publish_provider_conversation_identity(
        &discovery_root,
        &cwd,
        &descriptor,
        "codex",
        "conversation-published-after-response-loss",
    );
    let root = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);

    let stopped = match stopper.stop_create_chain_v2(root.clone()) {
        Ok(stopped) => stopped,
        Err(error) => {
            terminate_owned_test_process_if_live(&descriptor.provider_process);
            terminate_owned_test_process_if_live(&descriptor.host_process);
            panic!("identity-only generation-authorized chain stop failed: {error}");
        }
    };
    assert_eq!(stopped.chain(), std::slice::from_ref(&root));
    assert_eq!(
        stopped.stop_receipt().unwrap().session_id(),
        descriptor.session_id,
    );
    assert_eq!(stopper.stop_create_chain_v2(root).unwrap(), stopped);
    wait_for_process_absent(&descriptor.provider_process);
    assert_eq!(
        ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root)
            .create(request)
            .unwrap_err()
            .code(),
        MANAGED_CREATE_RETIRED_EXACT_CODE,
    );
}

fn assert_tree_omits(root: &std::path::Path, needle: &str) {
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let file_type = entry.file_type().unwrap();
        if file_type.is_dir() {
            assert_tree_omits(&entry.path(), needle);
        } else if file_type.is_file() {
            let content = match fs::read(entry.path()) {
                Ok(content) => content,
                // Runtime state is published atomically. A temporary file may
                // disappear between file_type() and read() under runner load;
                // an absent file cannot retain the private value we are
                // checking for.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => panic!(
                    "discovery file could not be inspected: {}: {error}",
                    entry.path().display()
                ),
            };
            assert!(
                !String::from_utf8_lossy(&content).contains(needle),
                "private provider state path leaked into {}",
                entry.path().display()
            );
        }
    }
}

fn wait_for_file_content(path: &std::path::Path, expected: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match fs::read(path) {
            Ok(content) if content == expected => return,
            // The shell creates/truncates the marker before `printf` writes
            // its payload. Treat that short publication window like an
            // absent file instead of making parallel smoke runs flaky.
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("provider marker could not be read: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "provider did not report readiness: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn identical_session_ids_in_distinct_discovery_roots_keep_distinct_endpoints() {
    let state = tempfile::tempdir().unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let discovery_a = state.path().join("discovery-a");
    let discovery_b = state.path().join("discovery-b");
    let release_a = state.path().join("release-a");
    let release_b = state.path().join("release-b");
    let create = |discovery_root: &std::path::Path,
                  idempotency_key: &str,
                  workspace_id: &str,
                  release: &std::path::Path| {
        ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(discovery_root)
            .create(
                ManagedCreateRequest::new(
                    idempotency_key,
                    "managed-shared-session-id",
                    workspace_id,
                    "codex",
                    PermissionMode::Default,
                    &cwd,
                    vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "while [ ! -f \"$1\" ]; do sleep 0.05; done".into(),
                        "--".into(),
                        release.to_string_lossy().into_owned(),
                    ],
                    24,
                    80,
                )
                .unwrap(),
            )
            .unwrap()
    };

    let first = create(
        &discovery_a,
        "shared-id-create-a",
        "workspace-shared-id-a",
        &release_a,
    );
    let second = create(
        &discovery_b,
        "shared-id-create-b",
        "workspace-shared-id-b",
        &release_b,
    );
    let first_endpoint = first.session().descriptor().endpoint.address.clone();
    let second_endpoint = second.session().descriptor().endpoint.address.clone();

    fs::write(&release_a, b"release").unwrap();
    fs::write(&release_b, b"release").unwrap();
    wait_for_exited(
        &discovery_a,
        "managed-shared-session-id",
        "workspace-shared-id-a",
    );
    wait_for_exited(
        &discovery_b,
        "managed-shared-session-id",
        "workspace-shared-id-b",
    );

    assert_ne!(
        first_endpoint, second_endpoint,
        "independent Host generations must never share an unlinkable socket path"
    );
}

#[test]
fn explicit_resume_replacement_preserves_the_source_tombstone() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source_release = state.path().join("source-release");
    let source_home = state.path().join("source-codex-home");
    let target_home = state.path().join("target-codex-home");
    let source_home_marker = state.path().join("source-home");
    let target_home_marker = state.path().join("target-home");
    fs::create_dir(&source_home).unwrap();
    fs::create_dir(&target_home).unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let source = creator
        .create(
            ManagedCreateRequest::new(
                "source-create",
                "managed-source",
                "workspace-managed",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'managed-before-recovery\\n'; printf '%s' \"$CODEX_HOME\" > \"$1\"; while [ ! -f \"$2\" ]; do sleep 0.05; done".into(),
                    "--".into(),
                    source_home_marker.to_string_lossy().into_owned(),
                    source_release.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_provider_state_environment(
                ProviderStateEnvironment::new(BTreeMap::from([(
                    "CODEX_HOME".to_string(),
                    source_home.to_string_lossy().into_owned(),
                )]))
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let source_descriptor = source.session().descriptor().clone();
    wait_for_file_content(
        &source_home_marker,
        source_home.to_string_lossy().as_bytes(),
    );
    // The provider marker proves only that the shell wrote both outputs. Fence
    // teardown on the host-side terminal observation so runner load cannot
    // race the PTY reader and leave an empty presentation checkpoint.
    wait_for_screen_text(source.session(), &["managed-before-recovery"]);
    fs::write(&source_release, b"release").unwrap();
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let descriptor = catalog
            .find(&SessionSelector::new(
                source.receipt().session_id(),
                Some(source.receipt().workspace_id().to_string()),
            ))
            .unwrap();
        if descriptor.lifecycle == SessionLifecycle::Exited {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "managed source did not publish an exited tombstone"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let resume_marker = state.path().join("resume-identity");
    let replacement_release = state.path().join("replacement-release");
    let conversation_id = "conversation-stable";
    let replacement = creator
        .create(
            ManagedCreateRequest::new(
                "replacement-create",
                "managed-replacement",
                "workspace-managed",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf 'managed-after-recovery\\n'; printf '%s' \"$1\" > \"$2\"; printf '%s' \"$CODEX_HOME\" > \"$3\"; while [ ! -f \"$4\" ]; do sleep 0.05; done"
                        .into(),
                    "--".into(),
                    conversation_id.into(),
                    resume_marker.to_string_lossy().into_owned(),
                    target_home_marker.to_string_lossy().into_owned(),
                    replacement_release.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_presentation_predecessor(
                PresentationCheckpointPredecessor::new(
                    &source_descriptor.session_id,
                    &source_descriptor.runner_principal,
                    &source_descriptor.runner_instance,
                    source_descriptor.channel_epoch.parse().unwrap(),
                    &source_descriptor.host_instance_id,
                    &source_descriptor.terminal_epoch,
                )
                .unwrap(),
            )
            .unwrap()
            .with_provider_state_environment(
                ProviderStateEnvironment::new(BTreeMap::from([(
                    "CODEX_HOME".to_string(),
                    target_home.to_string_lossy().into_owned(),
                )]))
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

    assert_eq!(
        replacement.receipt().outcome(),
        ManagedCreateOutcome::Created
    );
    let restored_screen = wait_for_screen_text(
        replacement.session(),
        &["managed-before-recovery", "managed-after-recovery"],
    );
    let recovered = restored_screen
        .recovered_presentation
        .expect("managed replacement did not identify its presentation predecessor");
    assert_eq!(
        recovered.source_fence.session_id,
        source_descriptor.session_id
    );
    assert_eq!(
        recovered.source_fence.host_instance_id,
        source_descriptor.host_instance_id
    );
    assert_eq!(
        recovered.source_fence.terminal_epoch,
        source_descriptor.terminal_epoch
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while !resume_marker.is_file() {
        assert!(
            Instant::now() < deadline,
            "replacement did not receive the explicit conversation id"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        fs::read_to_string(resume_marker).unwrap(),
        "conversation-stable"
    );
    wait_for_file_content(
        &target_home_marker,
        target_home.to_string_lossy().as_bytes(),
    );
    assert_ne!(
        fs::read_to_string(source_home_marker).unwrap(),
        fs::read_to_string(target_home_marker).unwrap(),
        "replacement reused the source credential root"
    );
    assert_tree_omits(&discovery_root, &source_home.to_string_lossy());
    assert_tree_omits(&discovery_root, &target_home.to_string_lossy());
    assert_eq!(
        catalog
            .find(&SessionSelector::new(
                "managed-source",
                Some("workspace-managed".into())
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Exited
    );
    assert_eq!(
        replacement.session().descriptor().session_id,
        "managed-replacement"
    );
    fs::write(&replacement_release, b"release").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let descriptor = catalog
            .find(&SessionSelector::new(
                "managed-replacement",
                Some("workspace-managed".into()),
            ))
            .unwrap();
        if descriptor.lifecycle == SessionLifecycle::Exited {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "managed replacement did not publish an exited tombstone"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn managed_stop_reconciles_an_exact_abandoned_ready_generation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let target = creator
        .create(
            ManagedCreateRequest::new(
                "abandoned-stop-create",
                "abandoned-stop-target",
                "workspace-abandoned-stop",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let sibling = creator
        .create(
            ManagedCreateRequest::new(
                "abandoned-stop-sibling-create",
                "abandoned-stop-sibling",
                "workspace-abandoned-stop",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let target_descriptor = target.session().descriptor().clone();
    let sibling_descriptor = sibling.session().descriptor().clone();
    let paused_target = pause_exact_managed_test_host(&target_descriptor.host_process);
    terminate_owned_test_process(&target_descriptor.provider_process);
    terminate_owned_test_process(&target_descriptor.host_process);
    wait_for_process_absent(&target_descriptor.provider_process);
    wait_for_process_absent(&target_descriptor.host_process);
    drop(paused_target);
    wait_for_lifetime_lock_available(&discovery_root, &target_descriptor);
    assert!(matches!(
        read_manifest(
            &discovery_root,
            &target_descriptor.workspace_id,
            &target_descriptor.session_id,
        ),
        DiscoveryManifest::Ready(_)
    ));
    fs::remove_file(&target_descriptor.endpoint.address).unwrap();

    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let result = stopper.stop(exact_managed_stop_request(
        "abandoned-stop-operation",
        &target_descriptor,
    ));
    let target_exited = matches!(
        read_manifest(
            &discovery_root,
            &target_descriptor.workspace_id,
            &target_descriptor.session_id,
        ),
        DiscoveryManifest::Exited(_)
    );

    let sibling_lifecycle = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            &sibling_descriptor.session_id,
            Some(sibling_descriptor.workspace_id.clone()),
        ))
        .unwrap()
        .lifecycle;
    let sibling_cleanup = stopper.stop(exact_managed_stop_request(
        "abandoned-stop-sibling-cleanup",
        &sibling_descriptor,
    ));
    if sibling_cleanup.is_err() {
        terminate_owned_test_process_if_live(&sibling_descriptor.provider_process);
        terminate_owned_test_process_if_live(&sibling_descriptor.host_process);
        wait_for_process_absent(&sibling_descriptor.provider_process);
        wait_for_process_absent(&sibling_descriptor.host_process);
    }

    assert!(target_exited);
    assert_eq!(
        sibling_lifecycle,
        SessionLifecycle::Ready,
        "reconciling one abandoned generation must not affect a sibling"
    );
    sibling_cleanup.unwrap();

    let receipt = result.expect(
        "an exact Ready generation with absent Host and provider must reconcile as already exited",
    );
    assert_eq!(receipt.outcome(), ManagedStopOutcome::AlreadyExited);
    assert_eq!(
        receipt.host_instance_id(),
        target_descriptor.host_instance_id
    );
    assert_eq!(receipt.terminal_epoch(), target_descriptor.terminal_epoch);
}

#[test]
fn managed_stop_keeps_a_live_generation_on_socket_replacement() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "socket-replacement-create",
                "socket-replacement-target",
                "workspace-socket-replacement",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sleep".into(), "30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    fs::remove_file(&descriptor.endpoint.address).unwrap();
    let replacement_socket = UnixListener::bind(&descriptor.endpoint.address).unwrap();
    let replacement = thread::spawn(move || {
        let (mut transport, _) = replacement_socket.accept().unwrap();
        let hello = hmux_host::local_protocol::FrameCodec::new(
            hmux_host::local_protocol::FrameLimits::default(),
        )
        .read_from(&mut transport)
        .unwrap();
        assert!(matches!(
            hello.body,
            hmux_host::local_protocol::FrameBody::Hello(_)
        ));
    });

    let result = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "socket-replacement-stop",
            &descriptor,
        ));
    let replacement_result = replacement.join();

    let manifest_ready = matches!(
        read_manifest(
            &discovery_root,
            &descriptor.workspace_id,
            &descriptor.session_id,
        ),
        DiscoveryManifest::Ready(_)
    );
    let host_status = probe_local_process_generation(&descriptor.host_process).unwrap();
    let provider_status = probe_local_process_generation(&descriptor.provider_process).unwrap();

    terminate_owned_test_process_if_live(&descriptor.provider_process);
    terminate_owned_test_process_if_live(&descriptor.host_process);
    wait_for_process_absent(&descriptor.provider_process);
    wait_for_process_absent(&descriptor.host_process);

    replacement_result.unwrap();
    let error = result.unwrap_err();
    assert_eq!(error.code(), "hmux_managed_stop_outcome_unknown");
    assert!(manifest_ready);
    assert_eq!(host_status, LocalProcessGenerationStatus::Live);
    assert_eq!(provider_status, LocalProcessGenerationStatus::Live);
}

#[test]
fn fenced_managed_stop_acknowledges_before_provider_cleanup_finishes() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cleanup_marker = state.path().join("cleanup-held");
    let cleanup_release = cleanup_marker.with_extension("release");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let conversation_id = "conversation-stop-admission";
    let request = conversation_writer_request(
        &cwd,
        "stop-admission",
        "workspace-stop-admission",
        conversation_id,
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
    );
    let session =
        run_managed_create_with_stop_pause(&discovery_root, &cwd, &request, &cleanup_marker, false);
    let descriptor = session.descriptor().clone();
    let proof = session.managed_attach_authorization_proof().unwrap();
    let mut connection = session
        .connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, Some(proof))
                .with_optional_capabilities(&[
                    MANAGED_PROVIDER_STOP_CAPABILITY,
                    MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
                    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
                ]),
        )
        .unwrap();
    let request_id = "stop-before-cleanup";
    connection
        .writer()
        .send(FrameBody::ManagedProviderStop(ManagedProviderStop {
            request_id: request_id.into(),
            expected_quiescence: None,
            expected_conversation: Some(ManagedProviderStopConversationFence {
                provider_id: "codex".into(),
                conversation_id: Some(conversation_id.into()),
            }),
        }))
        .unwrap();

    let early_receipt =
        read_managed_stop_receipt(&mut connection, request_id, Duration::from_millis(750));
    wait_for_path(&cleanup_marker);
    fs::write(&cleanup_release, b"release").unwrap();
    let eventual_receipt = early_receipt
        .or_else(|| read_managed_stop_receipt(&mut connection, request_id, Duration::from_secs(3)));
    connection.shutdown();

    assert_eq!(
        eventual_receipt,
        Some(ManagedProviderStopReceiptState::Accepted),
        "the exact Host never acknowledged its managed-stop admission"
    );
    wait_for_exited(
        &discovery_root,
        &descriptor.session_id,
        &descriptor.workspace_id,
    );
    let stopped = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(
            exact_managed_stop_request("stop-admission-checkpoint", &descriptor)
                .with_expected_conversation(
                    ManagedStopConversationFence::new("codex", Some(conversation_id.to_string()))
                        .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::AlreadyExited);
    assert_eq!(
        early_receipt,
        Some(ManagedProviderStopReceiptState::Accepted),
        "fenced admission waited for provider process cleanup before acknowledging"
    );
}

#[test]
fn managed_stop_converges_when_a_legacy_host_delays_its_receipt() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cleanup_marker = state.path().join("legacy-cleanup-held");
    let cleanup_release = cleanup_marker.with_extension("release");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let conversation_id = "conversation-legacy-stop";
    let create_request = conversation_writer_request(
        &cwd,
        "legacy-stop",
        "workspace-legacy-stop",
        conversation_id,
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
    );
    let session = run_managed_create_with_stop_pause(
        &discovery_root,
        &cwd,
        &create_request,
        &cleanup_marker,
        true,
    );
    let request = exact_managed_stop_request("legacy-delayed-stop", session.descriptor())
        .with_expected_conversation(
            ManagedStopConversationFence::new("codex", Some(conversation_id.to_string())).unwrap(),
        )
        .unwrap();
    let worker_root = discovery_root.clone();
    let worker_cwd = cwd.clone();
    let worker_request = request.clone();
    let worker = thread::spawn(move || {
        ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), worker_cwd)
            .with_discovery_root(worker_root)
            .stop(worker_request)
    });

    wait_for_path(&cleanup_marker);
    thread::sleep(Duration::from_millis(3_250));
    fs::write(&cleanup_release, b"release").unwrap();
    let first = worker.join().unwrap();
    let first_succeeded = first.is_ok();
    let stopped = match first {
        Ok(receipt) => receipt,
        Err(_) => {
            wait_for_exited(
                &discovery_root,
                &session.descriptor().session_id,
                &session.descriptor().workspace_id,
            );
            ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
                .with_discovery_root(&discovery_root)
                .stop(request)
                .expect("cleanup must remain possible after the red observation")
        }
    };

    assert!(
        first_succeeded,
        "an exact Exited tombstone did not reconcile the delayed legacy receipt"
    );
    assert!(matches!(
        stopped.outcome(),
        ManagedStopOutcome::Stopped | ManagedStopOutcome::AlreadyExited
    ));
}

#[test]
fn managed_stop_is_exact_idempotent_and_leaves_sibling_session_running() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let sibling_release = state.path().join("sibling-release");
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let target = creator
        .create(
            ManagedCreateRequest::new(
                "target-create",
                "managed-target",
                "workspace-managed-stop",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let sibling = creator
        .create(
            ManagedCreateRequest::new(
                "sibling-create",
                "managed-sibling",
                "workspace-managed-stop",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "while [ ! -f \"$1\" ]; do sleep 0.05; done".into(),
                    "--".into(),
                    sibling_release.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    assert!(
        target
            .session()
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == "managed_provider_stop_v1")
    );

    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let target_descriptor = target.session().descriptor().clone();
    let records_before_stale_stop =
        hmux_client::recovery_journal::inspect_existing(&discovery_root)
            .unwrap()
            .operation_records;
    let stale = stopper.stop(
        ManagedStopRequest::new(
            "stop-target-stale",
            target.receipt().session_id(),
            target.receipt().workspace_id(),
        )
        .unwrap()
        .with_expected_fence(
            target_descriptor.runner_principal.clone(),
            "replacement-runner",
            target_descriptor.channel_epoch.parse().unwrap(),
            target_descriptor.host_instance_id.clone(),
            target_descriptor.terminal_epoch.clone(),
        )
        .unwrap(),
    );
    assert!(stale.is_err());
    assert_eq!(
        target.session().descriptor().lifecycle,
        SessionLifecycle::Ready
    );
    assert_eq!(
        hmux_client::recovery_journal::inspect_existing(&discovery_root)
            .unwrap()
            .operation_records,
        records_before_stale_stop,
        "a stale precondition must not consume durable journal capacity"
    );

    let first = stopper
        .stop(
            ManagedStopRequest::new(
                "stop-target",
                target.receipt().session_id(),
                target.receipt().workspace_id(),
            )
            .unwrap()
            .with_expected_fence(
                target_descriptor.runner_principal.clone(),
                target_descriptor.runner_instance.clone(),
                target_descriptor.channel_epoch.parse().unwrap(),
                target_descriptor.host_instance_id.clone(),
                target_descriptor.terminal_epoch.clone(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(first.outcome(), ManagedStopOutcome::Stopped);
    assert_eq!(
        first.host_instance_id(),
        target.session().descriptor().host_instance_id
    );
    assert_eq!(
        first.terminal_epoch(),
        target.session().descriptor().terminal_epoch
    );

    let repeated = stopper
        .stop(
            ManagedStopRequest::new(
                "stop-target",
                target.receipt().session_id(),
                target.receipt().workspace_id(),
            )
            .unwrap()
            .with_expected_fence(
                target_descriptor.runner_principal.clone(),
                target_descriptor.runner_instance.clone(),
                target_descriptor.channel_epoch.parse().unwrap(),
                target_descriptor.host_instance_id.clone(),
                target_descriptor.terminal_epoch.clone(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(repeated.outcome(), ManagedStopOutcome::Stopped);

    let catalog = LocalSessionCatalog::new(&discovery_root);
    assert_eq!(
        catalog
            .find(&SessionSelector::new(
                sibling.receipt().session_id(),
                Some(sibling.receipt().workspace_id().to_string()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );

    fs::write(&sibling_release, b"release").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if catalog
            .find(&SessionSelector::new(
                sibling.receipt().session_id(),
                Some(sibling.receipt().workspace_id().to_string()),
            ))
            .unwrap()
            .lifecycle
            == SessionLifecycle::Exited
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "managed sibling did not exit after release"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn quiescent_managed_stop_accepts_current_output_snapshot_after_waiting_redraw() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let redraw_trigger = state.path().join("provider-redraw");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "redraw-stop-create",
                "redraw-stop-target",
                "workspace-redraw-stop",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "while [ ! -f \"$1\" ]; do sleep 0.01; done; printf redraw; sleep 30".into(),
                    "hmux-test".into(),
                    redraw_trigger.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    assert!(
        created
            .session()
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == "managed_provider_quiescent_stop_v1")
    );
    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    assert!(matches!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("redraw-stop-target", "workspace-redraw-stop").unwrap(),
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
            )
            .unwrap(),
        AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
    ));
    let catalog = LocalSessionCatalog::new(&discovery_root);
    std::fs::write(&redraw_trigger, b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let quiescence = loop {
        let observer = LocalSessionObserver::connect(
            &catalog,
            &SessionSelector::new("redraw-stop-target", Some("workspace-redraw-stop".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let snapshot = &observer.attachment().initial_snapshot;
        let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
        let current: u64 = snapshot.sequence_through.parse().unwrap();
        let reported: u64 = runtime.observed_through_output_seq.parse().unwrap();
        let terminal_epoch = runtime.terminal_epoch.clone();
        let runtime_revision = runtime.revision.parse().unwrap();
        observer.detach().unwrap();
        if current > reported {
            break ManagedStopQuiescenceFence::new(terminal_epoch, runtime_revision, current)
                .unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "provider redraw did not advance output after its waiting report"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let stopped = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(
            exact_managed_stop_request("redraw-stop", created.session().descriptor())
                .with_expected_quiescence(quiescence)
                .unwrap(),
        )
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_input_receipt_crosses_a_live_runtime_projection() {
    fn read_runtime_projection(
        surface: &mut TerminalSurfaceAttachment,
        expected_lifecycle: hmux_host::local_protocol::AgentRuntimeLifecycle,
        expected_activity: hmux_host::local_protocol::AgentRuntimeActivity,
        expected_source: hmux_host::local_protocol::AgentRuntimeStateSource,
    ) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let event = surface
                .read_event_before(deadline)
                .expect("the expected runtime projection must remain observable");
            let TerminalSurfaceEvent::Control(body) = event else {
                continue;
            };
            match *body {
                FrameBody::AgentRuntimeState(state)
                    if state.lifecycle == expected_lifecycle
                        && state.activity == expected_activity
                        && state.source == expected_source =>
                {
                    return;
                }
                FrameBody::Error(error) => {
                    panic!("the Host rejected the expected runtime projection: {error:?}")
                }
                FrameBody::Exit(exit) => {
                    panic!("the Host exited before the expected runtime projection: {exit:?}")
                }
                _ => {}
            }
        }
    }

    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "runtime-crossing-create",
                "runtime-crossing-target",
                "workspace-runtime-crossing",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf RUNTIME_CROSSING_READY; sleep 30".into(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    wait_for_screen_text(created.session(), &["RUNTIME_CROSSING_READY"]);

    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let report = reporter
        .report_agent_state(
            ManagedAttachRequest::new("runtime-crossing-target", "workspace-runtime-crossing")
                .unwrap(),
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
        )
        .unwrap();
    assert_eq!(report, AgentStateReportOutcome::Applied);

    let connection = created
        .session()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let initial_runtime = surface.initial_agent_runtime_state().unwrap();
    assert_eq!(
        initial_runtime.source,
        hmux_client::AgentRuntimeStateSource::ProviderEvent
    );
    assert_eq!(
        initial_runtime.activity,
        hmux_client::AgentRuntimeActivity::Waiting
    );

    surface
        .send_command_input_confirmed(String::new(), true, Duration::from_secs(3))
        .expect("the input-owned working projection must not hide its receipt");
    read_runtime_projection(
        &mut surface,
        hmux_host::local_protocol::AgentRuntimeLifecycle::Running,
        hmux_host::local_protocol::AgentRuntimeActivity::Working,
        hmux_host::local_protocol::AgentRuntimeStateSource::ControllerInput,
    );
    let report = reporter
        .report_agent_state(
            ManagedAttachRequest::new("runtime-crossing-target", "workspace-runtime-crossing")
                .unwrap(),
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
        )
        .unwrap();
    assert_eq!(report, AgentStateReportOutcome::Applied);
    surface
        .follow_tail_confirmed(Duration::from_secs(3))
        .expect("a live runtime projection must not end the viewport transaction");
    read_runtime_projection(
        &mut surface,
        hmux_host::local_protocol::AgentRuntimeLifecycle::Running,
        hmux_host::local_protocol::AgentRuntimeActivity::Waiting,
        hmux_host::local_protocol::AgentRuntimeStateSource::ProviderEvent,
    );

    surface.detach().unwrap();
    let stopped = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "runtime-crossing-stop",
            created.session().descriptor(),
        ))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}

#[cfg(feature = "terminal-state-stream")]
struct UnixAgentPromptFixture {
    _state: tempfile::TempDir,
    created: CreatedManagedSession,
    cwd: std::path::PathBuf,
    discovery_root: std::path::PathBuf,
    expected_fence: SessionFence,
    received_prompt: std::path::PathBuf,
    runtime: &'static str,
}

#[cfg(feature = "terminal-state-stream")]
impl UnixAgentPromptFixture {
    fn new(label: &str) -> Self {
        Self::with_provider_script(
            label,
            "stty -echo; while IFS= read -r prompt; do printf '%s\\n' \"$prompt\" >> \"$1\"; printf 'AGENT_PROMPT_CONSUMED:%s\\r\\n' \"$prompt\"; done",
        )
    }

    fn with_provider_script(label: &str, provider_script: &str) -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let received_prompt = state.path().join("received-prompt");
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
        let session_id = format!("agent-prompt-{label}");
        let workspace_id = format!("workspace-agent-prompt-{label}");
        let created = ManagedSessionCreator::new(runtime)
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    format!("agent-prompt-{label}-create"),
                    session_id,
                    workspace_id,
                    "codex",
                    PermissionMode::Default,
                    &cwd,
                    vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        provider_script.into(),
                        "--".into(),
                        received_prompt.to_string_lossy().into_owned(),
                    ],
                    24,
                    80,
                )
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
        self.report_waiting_with_identity(Some(conversation_id));
    }

    fn report_waiting_with_identity(&self, conversation_id: Option<&str>) {
        let descriptor = self.created.session().descriptor();
        let outcome = ManagedAgentStateReporter::new(self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .report_agent_state(
                ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                    .unwrap(),
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Waiting,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: conversation_id.map(|conversation_id| {
                        ProviderConversationIdentity {
                            provider_id: "codex".into(),
                            conversation_id: conversation_id.into(),
                            expected_fence: Some(self.expected_fence.clone()),
                        }
                    }),
                    expected_observation: None,
                },
            )
            .unwrap();
        assert_eq!(outcome, AgentStateReportOutcome::Applied);
    }

    fn report_identified_completion(&self, conversation_id: &str, completion_id: &str) {
        let descriptor = self.created.session().descriptor();
        let outcome = ManagedAgentStateReporter::new(self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .report_agent_state(
                ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                    .unwrap(),
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Waiting,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: true,
                    turn_completion_id: Some(completion_id.into()),
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: Some(ProviderConversationIdentity {
                        provider_id: "codex".into(),
                        conversation_id: conversation_id.into(),
                        expected_fence: Some(self.expected_fence.clone()),
                    }),
                    expected_observation: None,
                },
            )
            .unwrap();
        assert!(matches!(
            outcome,
            AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
        ));
    }

    fn stop(&self, label: &str) {
        let stopped = ManagedSessionStopper::new(self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(exact_managed_stop_request(
                format!("agent-prompt-{label}-stop"),
                self.created.session().descriptor(),
            ))
            .unwrap();
        assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn stale_generation_cannot_open_an_agent_prompt_mutation_surface() {
    let fixture = UnixAgentPromptFixture::new("stale-generation");
    let mut stale_fence = fixture.expected_fence.clone();
    stale_fence.terminal_epoch = "terminal-stale".into();
    let error = match TerminalSurfaceAttachment::connect_local_agent_prompt(
        &LocalSessionCatalog::new(&fixture.discovery_root),
        &stale_fence,
    ) {
        Ok(_) => panic!("a stale terminal epoch opened an agent-prompt mutation surface"),
        Err(error) => error,
    };

    assert_eq!(error.code(), "hmux_expected_generation_mismatch");
    assert!(
        !fixture.received_prompt.exists(),
        "a stale agent-prompt generation reached the PTY"
    );
    fixture.stop("stale-generation");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn concurrent_managed_fresh_agent_prompts_produce_one_compound_pty_write() {
    concurrent_fresh_agent_prompts(Some("conversation-atomic-fresh"));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn identityless_managed_fresh_agent_prompts_produce_one_compound_pty_write() {
    concurrent_fresh_agent_prompts(None);
}

#[cfg(feature = "terminal-state-stream")]
fn concurrent_fresh_agent_prompts(conversation_id: Option<&str>) {
    let fixture = UnixAgentPromptFixture::new("atomic-fresh");
    let first = fixture.surface();
    let second = fixture.surface();
    let barrier = Arc::new(Barrier::new(2));
    let send = |mut surface: TerminalSurfaceAttachment,
                barrier: Arc<Barrier>,
                prompt: &'static str| {
        thread::spawn(move || {
            barrier.wait();
            let outcome =
                surface.send_fresh_agent_prompt_confirmed(prompt.into(), Duration::from_secs(3));
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
    let first = send(first, Arc::clone(&barrier), "first whole prompt");
    let second = send(second, barrier, "second whole prompt");
    thread::sleep(Duration::from_millis(100));
    assert!(
        !fixture.received_prompt.exists(),
        "the Host must not write before provider-event startup authority"
    );
    fixture.report_waiting_with_identity(conversation_id);
    let outcomes = [first.join().unwrap(), second.join().unwrap()];

    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    let refusal = outcomes
        .iter()
        .find_map(|outcome| outcome.as_ref().err())
        .expect("one concurrent initial prompt must be refused before writing");
    assert_eq!(refusal.0, "hmux_agent_prompt_runtime_changed");
    assert_eq!(refusal.1, "not_written");

    let mut reattached = fixture.surface();
    let refusal = reattached
        .send_fresh_agent_prompt_confirmed(
            "replayed prompt after lost receipt".into(),
            Duration::from_secs(3),
        )
        .expect_err("a fresh attachment must observe the Host's consumed prompt admission");
    assert_eq!(refusal.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(refusal.delivery_state(), "not_written");
    reattached.detach().unwrap();

    let descriptor = fixture.created.session().descriptor();
    let mut drain = ManagedSessionAttacher::new(fixture.runtime, &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root)
        .attach(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
        )
        .unwrap();
    drain
        .send_input_confirmed(b"__DRAIN__\r".to_vec(), Duration::from_secs(3))
        .unwrap();
    drain.detach().unwrap();
    wait_for_screen_text(
        fixture.created.session(),
        &["AGENT_PROMPT_CONSUMED:__DRAIN__"],
    );
    let received = fs::read_to_string(&fixture.received_prompt).unwrap();
    let received = received.lines().collect::<Vec<_>>();
    assert_eq!(received.len(), 2, "unexpected PTY writes: {received:?}");
    assert!(
        matches!(received[0], "first whole prompt" | "second whole prompt"),
        "the provider must receive one whole initial prompt: {received:?}"
    );
    assert_eq!(received[1], "__DRAIN__");

    fixture.stop("atomic-fresh");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn settled_identified_completion_wakes_a_pending_fresh_prompt() {
    let fixture = UnixAgentPromptFixture::new("settled-completion-wake");
    let mut surface = fixture.surface();
    let started = Instant::now();
    let sender = thread::spawn(move || {
        let outcome = surface.send_fresh_agent_prompt_confirmed(
            "after settled completion".into(),
            Duration::from_secs(5),
        );
        surface.detach().unwrap();
        outcome
    });

    thread::sleep(Duration::from_millis(100));
    fixture.report_identified_completion(
        "conversation-settled-completion-wake",
        "0199dddd-eeee-7b80-b357-ffdc5afdf273",
    );
    sender
        .join()
        .unwrap()
        .expect("the settled completion must wake and admit the pending prompt");
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the prompt waited for its client deadline instead of the Host transition"
    );
    wait_for_screen_text(
        fixture.created.session(),
        &["AGENT_PROMPT_CONSUMED:after settled completion"],
    );
    fixture.stop("settled-completion-wake");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn provider_exit_classifies_a_pending_prompt_as_host_exiting() {
    let fixture = UnixAgentPromptFixture::with_provider_script("provider-exit", "sleep 2");
    let mut surface = fixture.surface();
    let sender = thread::spawn(move || {
        let outcome = surface
            .send_fresh_agent_prompt_confirmed("must not write".into(), Duration::from_secs(5));
        let _ = surface.detach();
        outcome
    });

    let error = sender
        .join()
        .unwrap()
        .expect_err("provider exit must refuse the pending prompt before PTY mutation");
    assert_eq!(error.code(), "hmux_agent_prompt_refused");
    assert_eq!(error.delivery_state(), "not_written");
    assert!(!fixture.received_prompt.exists());
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn existing_conversation_agent_prompt_requires_exact_idle_identity_and_rearms() {
    let fixture = UnixAgentPromptFixture::new("existing-conversation");
    let conversation_id = "conversation-existing";
    fixture.report_waiting(conversation_id);
    let mut mismatched = fixture.surface();
    let wrong = ProviderConversationIdentitySeed::new("codex", "conversation-other").unwrap();
    let error = mismatched
        .send_existing_idle_agent_prompt_confirmed(
            "must not write".into(),
            &wrong,
            Duration::from_secs(3),
        )
        .expect_err("a mismatched conversation must be refused before PTY mutation");
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
                prompt: &'static str| {
        thread::spawn(move || {
            barrier.wait();
            let outcome = surface
                .send_existing_idle_agent_prompt_confirmed(
                    prompt.into(),
                    &expected,
                    Duration::from_secs(3),
                )
                .map(|receipt| {
                    (
                        prompt,
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
        "existing first",
    );
    let second = send(second, barrier, expected.clone(), "existing second");
    let outcomes = [first.join().unwrap(), second.join().unwrap()];
    let (written_prompt, first_revision) = outcomes
        .iter()
        .find_map(|outcome| outcome.as_ref().ok())
        .expect("one exact existing-conversation prompt must reserve the idle runtime");
    let refused = outcomes
        .iter()
        .find_map(|outcome| outcome.as_ref().err())
        .expect("the competing exact prompt must be refused before PTY mutation");
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(refused.0, "hmux_agent_prompt_runtime_changed");
    assert_eq!(refused.1, "not_written");
    let marker = format!("AGENT_PROMPT_CONSUMED:{written_prompt}");
    wait_for_screen_text(fixture.created.session(), &[marker.as_str()]);

    let mut repeated_surface = fixture.surface();
    let repeated = repeated_surface
        .send_existing_idle_agent_prompt_confirmed(
            "must remain one shot".into(),
            &expected,
            Duration::from_secs(3),
        )
        .expect_err("controller-owned working state must consume the idle admission");
    assert_eq!(repeated.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(repeated.delivery_state(), "not_written");
    repeated_surface.detach().unwrap();

    fixture.report_waiting(conversation_id);
    let mut rearmed = fixture.surface();
    let second_receipt = rearmed
        .send_existing_idle_agent_prompt_confirmed(
            "existing after rearm".into(),
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
    wait_for_screen_text(
        fixture.created.session(),
        &["AGENT_PROMPT_CONSUMED:existing after rearm"],
    );
    assert_eq!(
        fs::read_to_string(&fixture.received_prompt)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        [*written_prompt, "existing after rearm"]
    );

    fixture.stop("existing-conversation");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn quiescent_managed_stop_ignores_structured_focus_control_input() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "focus-control-stop-create",
                "focus-control-stop-target",
                "workspace-focus-control-stop",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf '\\033[?1004hFOCUS_REPORTING_READY'; sleep 30".into(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    wait_for_screen_text(created.session(), &["FOCUS_REPORTING_READY"]);

    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    assert!(matches!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(
                    "focus-control-stop-target",
                    "workspace-focus-control-stop",
                )
                .unwrap(),
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
            )
            .unwrap(),
        AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
    ));

    let catalog = LocalSessionCatalog::new(&discovery_root);
    let connection = created
        .session()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert!(
        surface
            .current_frame()
            .viewport()
            .input_modes
            .as_ref()
            .unwrap()
            .focus_reporting,
        "the fixture must encode focus loss into real PTY control bytes"
    );
    let focus_record_id = 10_000;
    let frame = surface.current_frame();
    let focus = TerminalStateRecord {
        schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
        terminal_epoch: frame.terminal_epoch().to_string(),
        through_output_seq: frame.through_output_seq(),
        state_revision: frame.state_revision(),
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Focus(FocusInputIntent {
                focused: false,
            })),
        })),
    };
    surface
        .upstream_handles()
        .send_envelope(
            &encode_record_for_minor(TERMINAL_STATE_BASE_PROTOCOL_MINOR, focus_record_id, &focus)
                .unwrap(),
        )
        .unwrap();
    loop {
        match surface.read_event().unwrap() {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(TerminalIntentReceipt::Input(receipt))
                if receipt.in_reply_to_record_id == focus_record_id =>
            {
                assert!(matches!(
                    receipt.outcome,
                    Some(input_receipt::Outcome::WrittenToPty(_))
                ));
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
    surface.detach().unwrap();

    let observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            "focus-control-stop-target",
            Some("workspace-focus-control-stop".into()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let snapshot = &observer.attachment().initial_snapshot;
    let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(runtime.activity, hmux_client::AgentRuntimeActivity::Waiting);
    assert_eq!(runtime.attention, hmux_client::AgentRuntimeAttention::None);
    let quiescence = ManagedStopQuiescenceFence::new(
        runtime.terminal_epoch.clone(),
        runtime.revision.parse().unwrap(),
        snapshot.sequence_through.parse().unwrap(),
    )
    .unwrap();
    observer.detach().unwrap();

    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let stop = stopper.stop(
        exact_managed_stop_request(
            "focus-control-quiescent-stop",
            created.session().descriptor(),
        )
        .with_expected_quiescence(quiescence)
        .unwrap(),
    );
    let stopped = match stop {
        Ok(stopped) => stopped,
        Err(error) => {
            stopper
                .stop(exact_managed_stop_request(
                    "focus-control-cleanup-stop",
                    created.session().descriptor(),
                ))
                .unwrap();
            panic!("focus control input retained false user-draft authority: {error}")
        }
    };
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}

#[test]
fn managed_stop_broker_rejects_v1_and_v2_before_provider_stop() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "legacy-stop-create",
                "legacy-stop-target",
                "legacy-stop-workspace",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();

    for request in [
        ManagedStopRequest::new(
            "legacy-stop-v1",
            &descriptor.session_id,
            &descriptor.workspace_id,
        )
        .unwrap(),
        ManagedStopRequest::new(
            "legacy-stop-v2",
            &descriptor.session_id,
            &descriptor.workspace_id,
        )
        .unwrap()
        .with_expected_generation(
            descriptor.host_instance_id.clone(),
            descriptor.terminal_epoch.clone(),
        )
        .unwrap(),
    ] {
        let response = run_raw_managed_stop(&discovery_root, &cwd, &request, true)
            .expect("raw broker must return a refusal");
        let ManagedStopBrokerResponse::Refused(failure) = response else {
            panic!("legacy stop must not complete")
        };
        assert_eq!(failure.code, "hmux_managed_stop_unavailable");
        assert!(failure.message.contains("complete fence"));
        assert_eq!(
            LocalSessionCatalog::new(&discovery_root)
                .find(&SessionSelector::new(
                    &descriptor.session_id,
                    Some(descriptor.workspace_id.clone()),
                ))
                .unwrap()
                .lifecycle,
            SessionLifecycle::Ready
        );
    }

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "legacy-stop-cleanup",
            &descriptor,
        ))
        .unwrap();
}

#[test]
fn managed_stop_receipt_loss_reconciles_the_durable_completed_receipt() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "receipt-loss-create",
                "receipt-loss-target",
                "receipt-loss-workspace",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    let request = ManagedStopRequest::new(
        "receipt-loss-stop",
        &descriptor.session_id,
        &descriptor.workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        descriptor.runner_principal.clone(),
        descriptor.runner_instance.clone(),
        descriptor.channel_epoch.parse().unwrap(),
        descriptor.host_instance_id.clone(),
        descriptor.terminal_epoch.clone(),
    )
    .unwrap();

    assert!(run_raw_managed_stop(&discovery_root, &cwd, &request, false).is_none());
    let stopped = DiscoveryRoot::open(&discovery_root)
        .unwrap()
        .find_manifest_by_session(&descriptor.workspace_id, &descriptor.session_id)
        .unwrap();
    fs::remove_dir_all(stopped.discovery_path).unwrap();
    let reconciled = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(request)
        .unwrap();

    assert_eq!(reconciled.outcome(), ManagedStopOutcome::Stopped);
    assert_eq!(reconciled.stop_id(), "receipt-loss-stop");
}

#[test]
fn managed_stop_retry_after_receipt_gc_never_retargets_a_recreated_session() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let create = |create_id: &str, session_id: &str| {
        creator.create(
            ManagedCreateRequest::new(
                create_id,
                session_id,
                "recreated-stop-workspace",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
    };

    let first = create("recreated-stop-create-1", "recreated-stop-target-1").unwrap();
    let first_descriptor = first.session().descriptor().clone();
    let stale_request = ManagedStopRequest::new(
        "recreated-stop-operation",
        &first_descriptor.session_id,
        &first_descriptor.workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        first_descriptor.runner_principal.clone(),
        first_descriptor.runner_instance.clone(),
        first_descriptor.channel_epoch.parse().unwrap(),
        first_descriptor.host_instance_id.clone(),
        first_descriptor.terminal_epoch.clone(),
    )
    .unwrap();
    assert_eq!(
        stopper.stop(stale_request.clone()).unwrap().outcome(),
        ManagedStopOutcome::Stopped
    );

    let gc = garbage_collect_completed_action(
        &discovery_root,
        MANAGED_STOP_RECOVERY_ACTION,
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(gc.removed_completed_records, 1);
    let first_discovery = DiscoveryRoot::open(&discovery_root)
        .unwrap()
        .find_manifest_by_session(&first_descriptor.workspace_id, &first_descriptor.session_id)
        .unwrap();
    fs::remove_dir_all(first_discovery.discovery_path).unwrap();

    assert!(
        create("recreated-stop-create-2", "recreated-stop-target-1").is_err(),
        "a logical session id must remain permanently bound to its first create request"
    );

    let replacement = create("recreated-stop-create-2", "recreated-stop-target-2").unwrap();
    let replacement_descriptor = replacement.session().descriptor().clone();
    assert_ne!(
        replacement_descriptor.host_instance_id,
        first_descriptor.host_instance_id
    );
    let replayed = stopper.stop(stale_request).unwrap();
    assert_eq!(replayed.stop_id(), "recreated-stop-operation");
    assert_eq!(replayed.outcome(), ManagedStopOutcome::Stopped);
    assert_eq!(
        replayed.host_instance_id(),
        first_descriptor.host_instance_id
    );
    assert_eq!(replayed.terminal_epoch(), first_descriptor.terminal_epoch);
    assert_eq!(
        LocalSessionCatalog::new(&discovery_root)
            .find(&SessionSelector::new(
                &replacement_descriptor.session_id,
                Some(replacement_descriptor.workspace_id.clone()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready,
        "a stale completed stop must not terminate the recreated generation"
    );

    let cleanup = ManagedStopRequest::new(
        "recreated-stop-cleanup",
        &replacement_descriptor.session_id,
        &replacement_descriptor.workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        replacement_descriptor.runner_principal.clone(),
        replacement_descriptor.runner_instance.clone(),
        replacement_descriptor.channel_epoch.parse().unwrap(),
        replacement_descriptor.host_instance_id.clone(),
        replacement_descriptor.terminal_epoch.clone(),
    )
    .unwrap();
    assert_eq!(
        stopper.stop(cleanup).unwrap().outcome(),
        ManagedStopOutcome::Stopped
    );
}

fn run_raw_managed_stop(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedStopRequest,
    capture_receipt: bool,
) -> Option<ManagedStopBrokerResponse> {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_STOP_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .stdin(Stdio::piped())
        .stdout(if capture_receipt {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response = if capture_receipt {
        Some(read_json_frame(child.stdout.as_mut().unwrap()).unwrap())
    } else {
        None
    };
    assert!(child.wait().unwrap().success());
    response
}

fn run_managed_create_with_stop_pause(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    cleanup_marker: &std::path::Path,
    legacy_fenced_barrier: bool,
) -> LocalSession {
    if legacy_fenced_barrier {
        fs::write(cleanup_marker.with_extension("legacy"), b"legacy").unwrap();
    }
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env(MANAGED_STOP_CLEANUP_MARKER_ENV, cleanup_marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response: ManagedCreateBrokerResponse =
        read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    let ManagedCreateBrokerResponse::Completed(receipt) = response else {
        panic!("managed create for the stop-pause fixture was refused")
    };
    LocalSessionCatalog::new(discovery_root)
        .open(&SessionSelector::new(
            receipt.session_id(),
            Some(receipt.workspace_id().to_string()),
        ))
        .unwrap()
}

fn read_managed_stop_receipt(
    connection: &mut hmux_client::LocalConnection,
    request_id: &str,
    timeout: Duration,
) -> Option<ManagedProviderStopReceiptState> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        connection.set_read_timeout(Some(remaining)).unwrap();
        match connection.read_body() {
            Ok(FrameBody::ManagedProviderStopReceipt(receipt))
                if receipt.request_id == request_id =>
            {
                return Some(receipt.state);
            }
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

fn run_faulted_managed_create(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    fault_marker: &std::path::Path,
) -> ManagedCreateBrokerResponse {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env(
            "HMUX_RUNTIME_TEST_HOST_SPAWN_BEFORE_START_FAULT_MARKER",
            fault_marker,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    response
}

fn run_managed_create_with_omitted_capabilities(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    omitted_capabilities: &str,
) -> ManagedCreateBrokerResponse {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env(
            "HMUX_RUNTIME_TEST_HOST_OMIT_CAPABILITIES",
            omitted_capabilities,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    response
}

fn run_crashing_managed_create(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    fault: &str,
) {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_TEST_MANAGED_CREATE_FAULT", fault)
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(86));
}

struct AbandonedStartingFixture {
    _state: tempfile::TempDir,
    discovery_root: std::path::PathBuf,
    replacement_marker: std::path::PathBuf,
    cwd: std::path::PathBuf,
    request: ManagedRehostRequest,
    source_idempotency_key: String,
    source_session_id: String,
    source_workspace_id: String,
    old_host_process: ProcessDescriptor,
    old_provider_process: ProcessDescriptor,
    lock_path: std::path::PathBuf,
    lock_holder: Option<OwnedExactTestProcess>,
}

fn abandoned_starting_fixture(suffix: &str) -> AbandonedStartingFixture {
    abandoned_starting_fixture_inner(suffix, false)
}

fn abandoned_starting_fixture_with_lock_holder(suffix: &str) -> AbandonedStartingFixture {
    abandoned_starting_fixture_inner(suffix, true)
}

fn abandoned_starting_fixture_inner(
    suffix: &str,
    retain_same_session_lock_holder: bool,
) -> AbandonedStartingFixture {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let replacement_marker = state.path().join("replacement-conversation");
    let source_identity = state.path().join("source-identity");
    let lock_path = state.path().join("conversation-writer.lock");
    let lock_ready = state.path().join("conversation-writer.ready");
    let guardian_cut = state.path().join("provider-spawned");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let command = if retain_same_session_lock_holder {
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \"$HMUX_RUNNER_PRINCIPAL\" \"$HMUX_RUNNER_INSTANCE\" \"$HMUX_CHANNEL_EPOCH\" \"$HMUX_HOST_INSTANCE_ID\" \"$HMUX_TERMINAL_EPOCH\" \"$$\" > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; set -m; HMUX_TEST_ABANDONED_STARTING_LOCK_PATH=\"$3\" HMUX_TEST_ABANDONED_STARTING_LOCK_READY=\"$4\" \"$2\" --ignored --exact abandoned_starting_advisory_lock_holder_fixture --nocapture >/dev/null 2>&1 & wait \"$!\"".into(),
            "--".into(),
            source_identity.to_string_lossy().into_owned(),
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            lock_path.to_string_lossy().into_owned(),
            lock_ready.to_string_lossy().into_owned(),
        ]
    } else {
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \"$HMUX_RUNNER_PRINCIPAL\" \"$HMUX_RUNNER_INSTANCE\" \"$HMUX_CHANNEL_EPOCH\" \"$HMUX_HOST_INSTANCE_ID\" \"$HMUX_TERMINAL_EPOCH\" \"$$\" > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; exec /bin/sleep 30".into(),
            "--".into(),
            source_identity.to_string_lossy().into_owned(),
        ]
    };
    let source_create =
        rehostable_create_request_with_command(&cwd, &replacement_marker, suffix, command);
    let mut create_broker = spawn_managed_create_at_guardian_cut(
        &discovery_root,
        &cwd,
        &source_create,
        &guardian_cut,
        "provider_spawned",
    );
    wait_for_child_marker(&mut create_broker, &guardian_cut);
    wait_for_path(&source_identity);
    let starting = read_starting_manifest(
        &discovery_root,
        source_create.workspace_id(),
        source_create.session_id(),
    );
    let identity = fs::read_to_string(&source_identity).unwrap();
    let fields = identity.lines().collect::<Vec<_>>();
    assert_eq!(fields.len(), 6);
    assert_eq!(fields[0], starting.common.lifetime.runner_principal);
    assert_eq!(fields[1], starting.common.lifetime.runner_instance);
    assert_eq!(
        fields[2],
        starting.common.lifetime.channel_epoch.to_string()
    );
    assert_eq!(fields[3], starting.common.host_instance_id);

    let recorded = managed_create_ledger::starting_generation(
        &discovery_root,
        source_create.workspace_id(),
        source_create.session_id(),
    )
    .unwrap()
    .expect("managed Host did not checkpoint its exact Starting generation");
    let recorded_fence = recorded.generation_fence();
    assert_eq!(recorded_fence.runner_principal(), fields[0]);
    assert_eq!(recorded_fence.runner_instance(), fields[1]);
    assert_eq!(recorded_fence.channel_epoch().to_string(), fields[2]);
    assert_eq!(recorded_fence.host_instance_id(), fields[3]);
    assert_eq!(recorded_fence.terminal_epoch(), fields[4]);
    assert_eq!(
        recorded.provider_process().process_id,
        fields[5].parse::<u32>().unwrap()
    );
    let provider_process_id =
        libc::pid_t::try_from(recorded.provider_process().process_id).unwrap();
    // SAFETY: this is the exact live provider generation checkpointed by the
    // paused managed Host. Spawn-time OwnedProcessSession validation must make
    // its process id the durable POSIX session id.
    assert_eq!(
        unsafe { libc::getsid(provider_process_id) },
        provider_process_id
    );
    assert_eq!(
        recorded.host_process(),
        &ProcessDescriptor {
            process_id: starting.common.host_process.process_id,
            start_marker: starting.common.host_process.start_marker.clone(),
        }
    );

    let lock_holder = retain_same_session_lock_holder.then(|| {
        wait_for_path(&lock_ready);
        let process_id = fs::read_to_string(&lock_ready)
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let process = exact_local_process_generation(process_id)
            .expect("lock holder must have an exact process generation");
        let process_id = libc::pid_t::try_from(process.process_id).unwrap();
        // SAFETY: getsid only reads metadata for the exact live fixture
        // generation captured immediately above.
        assert_eq!(
            unsafe { libc::getsid(process_id) },
            provider_process_id,
            "lock holder must remain inside the recorded provider session"
        );
        OwnedExactTestProcess(Some(process))
    });

    terminate_owned_test_process(recorded.provider_process());
    terminate_owned_test_process(recorded.host_process());
    wait_for_process_absent(recorded.provider_process());
    wait_for_process_absent(recorded.host_process());
    let old_host_process = recorded.host_process().clone();
    let old_provider_process = recorded.provider_process().clone();
    if let Some(lock_holder) = lock_holder.as_ref() {
        assert_eq!(
            probe_local_process_generation(lock_holder.process()).unwrap(),
            LocalProcessGenerationStatus::Live,
            "the lock holder must survive Host and direct-provider exit"
        );
        let process_id = libc::pid_t::try_from(lock_holder.process().process_id).unwrap();
        // SAFETY: the exact fixture generation remains live and is inspected
        // read-only before rehost admission.
        assert_eq!(unsafe { libc::getsid(process_id) }, provider_process_id);
    }
    let _ = create_broker.kill();
    let _ = create_broker.wait();

    let request = ManagedRehostRequest::new(
        format!("{suffix}-operation"),
        source_create.session_id(),
        source_create.workspace_id(),
        fields[0],
        fields[1],
        fields[2].parse().unwrap(),
        fields[3],
        fields[4],
        true,
    )
    .unwrap()
    .with_expected_provider_id("codex")
    .unwrap()
    .with_expected_conversation_id(format!("conversation-{suffix}"))
    .unwrap()
    .with_expected_launch_reference(format!("credential-{suffix}"))
    .unwrap();
    AbandonedStartingFixture {
        _state: state,
        discovery_root,
        replacement_marker,
        cwd,
        source_idempotency_key: source_create.idempotency_key().to_string(),
        source_session_id: source_create.session_id().to_string(),
        source_workspace_id: source_create.workspace_id().to_string(),
        old_host_process,
        old_provider_process,
        request,
        lock_path,
        lock_holder,
    }
}

impl AbandonedStartingFixture {
    fn stop_lock_holder(&mut self) {
        if let Some(mut process) = self.lock_holder.take() {
            process.stop();
        }
    }
}

struct OwnedExactTestProcess(Option<ProcessDescriptor>);

impl OwnedExactTestProcess {
    fn process(&self) -> &ProcessDescriptor {
        self.0.as_ref().expect("owned fixture process was stopped")
    }

    fn stop(&mut self) {
        let Some(process) = self.0.take() else {
            return;
        };
        terminate_owned_test_process(&process);
        wait_for_process_absent(&process);
    }
}

impl Drop for OwnedExactTestProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_managed_create_at_guardian_cut(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    marker: &std::path::Path,
    phase: &str,
) -> std::process::Child {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE", phase)
        .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER", marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    child
}

fn read_starting_manifest(
    discovery_root: &std::path::Path,
    workspace_id: &str,
    session_id: &str,
) -> StartingManifest {
    let root = DiscoveryRoot::open(discovery_root).unwrap();
    let key = SessionLookupKey::new(workspace_id, session_id).unwrap();
    let manifest = fs::read(root.session_base_path(&key).join("manifest.json")).unwrap();
    let DiscoveryManifest::Starting(starting) = serde_json::from_slice(&manifest).unwrap() else {
        panic!("guardian-cut source did not retain its Starting manifest")
    };
    starting
}

fn read_manifest(
    discovery_root: &std::path::Path,
    workspace_id: &str,
    session_id: &str,
) -> DiscoveryManifest {
    let root = DiscoveryRoot::open(discovery_root).unwrap();
    let key = SessionLookupKey::new(workspace_id, session_id).unwrap();
    serde_json::from_slice(&fs::read(root.session_base_path(&key).join("manifest.json")).unwrap())
        .unwrap()
}

fn reconcile_managed_stop(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedStopRequest,
) -> ManagedStopBrokerResponse {
    let reconcile = ManagedStopReconcileRequest::from_stop_request(request).unwrap();
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), &reconcile).unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    response
}

fn ready_managed_sessions(discovery_root: &std::path::Path) -> Vec<hmux_client::SessionDescriptor> {
    LocalSessionCatalog::new(discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| {
            session.session_class == SessionClass::Managed
                && session.lifecycle == SessionLifecycle::Ready
        })
        .collect()
}

fn advisory_lock_is_available(path: &std::path::Path) -> bool {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    // SAFETY: `lock` owns this valid descriptor throughout the nonblocking
    // probe and optional unlock.
    let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        // SAFETY: this process acquired the lock immediately above.
        assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) }, 0);
        return true;
    }
    let error = std::io::Error::last_os_error();
    assert_eq!(
        error.kind(),
        std::io::ErrorKind::WouldBlock,
        "advisory lock observation failed: {error}"
    );
    false
}

fn wait_for_advisory_lock_available(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !advisory_lock_is_available(path) {
        assert!(
            Instant::now() < deadline,
            "owned fixture lock remained held after its exact process generation exited"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn terminate_owned_test_process(process: &ProcessDescriptor) {
    assert_eq!(
        probe_local_process_generation(process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    let process_id = i32::try_from(process.process_id).unwrap();
    assert_ne!(process_id, unsafe { libc::getpid() });
    // SAFETY: the fixture revalidated this exact Host/provider generation,
    // launched below its disposable discovery root, immediately above.
    assert_eq!(unsafe { libc::kill(process_id, libc::SIGKILL) }, 0);
}

fn terminate_owned_test_process_if_live(process: &ProcessDescriptor) {
    if matches!(
        probe_local_process_generation(process),
        Ok(LocalProcessGenerationStatus::Live)
    ) {
        terminate_owned_test_process(process);
    }
}

fn wait_for_process_absent(process: &ProcessDescriptor) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if matches!(
            probe_local_process_generation(process).unwrap(),
            LocalProcessGenerationStatus::Absent
        ) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owned test process {} did not exit",
            process.process_id
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_lifetime_lock_available(
    discovery_root: &std::path::Path,
    descriptor: &hmux_client::SessionDescriptor,
) {
    let key = DiscoveryKey::new(
        &descriptor.workspace_id,
        &descriptor.session_id,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse().unwrap(),
    )
    .unwrap();
    let discovery = DiscoveryRoot::open(discovery_root)
        .unwrap()
        .open_session(key)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match discovery.acquire_lifetime_lock() {
            Ok(lock) => {
                drop(lock);
                return;
            }
            Err(hmux_host::local_discovery::DiscoveryError::AlreadyLocked { .. }) => {
                assert!(
                    Instant::now() < deadline,
                    "owned test Host lifetime lock was not released"
                );
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("owned test Host lifetime lock observation failed: {error}"),
        }
    }
}

fn wait_for_path(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(Instant::now() < deadline, "timed out waiting for {path:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_child_marker(child: &mut std::process::Child, path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.exists() {
        assert_eq!(
            child.try_wait().unwrap(),
            None,
            "managed broker exited before publishing {path:?}"
        );
        assert!(Instant::now() < deadline, "timed out waiting for {path:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn run_faulted_managed_stop(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedStopRequest,
    fault: &str,
) {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_STOP_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_TEST_MANAGED_STOP_FAULT", fault)
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(86));
}

#[test]
fn managed_stop_reconciles_crashes_before_and_after_provider_stop() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);

    for (suffix, fault, expected_before_retry) in [
        ("reserved", "after_reserve", SessionLifecycle::Ready),
        ("stopped", "after_provider_stop", SessionLifecycle::Exited),
        (
            "receipt-checkpointed",
            "after_stop_receipt_checkpoint",
            SessionLifecycle::Exited,
        ),
        (
            "retirement-checkpointed",
            "after_create_ledger_retirement_checkpoint",
            SessionLifecycle::Exited,
        ),
        (
            "create-ledger-retired",
            "after_create_ledger_retirement",
            SessionLifecycle::Exited,
        ),
        (
            "intent-completed",
            "after_stop_intent_completion",
            SessionLifecycle::Exited,
        ),
    ] {
        let create_request = ManagedCreateRequest::new(
            format!("crash-create-{suffix}"),
            format!("crash-session-{suffix}"),
            "crash-workspace",
            "codex",
            PermissionMode::Default,
            &cwd,
            vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
        )
        .unwrap();
        let created = creator.create(create_request.clone()).unwrap();
        let descriptor = created.session().descriptor().clone();
        let request = ManagedStopRequest::new(
            format!("crash-stop-{suffix}"),
            &descriptor.session_id,
            &descriptor.workspace_id,
        )
        .unwrap()
        .with_expected_fence(
            descriptor.runner_principal.clone(),
            descriptor.runner_instance.clone(),
            descriptor.channel_epoch.parse().unwrap(),
            descriptor.host_instance_id.clone(),
            descriptor.terminal_epoch.clone(),
        )
        .unwrap();

        run_faulted_managed_stop(&discovery_root, &cwd, &request, fault);
        assert_eq!(
            LocalSessionCatalog::new(&discovery_root)
                .find(&SessionSelector::new(
                    &descriptor.session_id,
                    Some(descriptor.workspace_id.clone()),
                ))
                .unwrap()
                .lifecycle,
            expected_before_retry
        );
        let receipt = stopper.stop(request).unwrap();
        assert_eq!(receipt.session_id(), descriptor.session_id);
        assert!(matches!(
            receipt.outcome(),
            ManagedStopOutcome::Stopped | ManagedStopOutcome::AlreadyExited
        ));
        assert_eq!(
            creator.create(create_request).unwrap_err().code(),
            MANAGED_CREATE_RETIRED_EXACT_CODE,
            "a retired exact generation must remain distinguishable from an unknown create outcome"
        );
    }
}

#[test]
fn chain_stop_finishes_retiring_and_final_stop_journal_crashes() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);

    for (suffix, fault) in [
        (
            "retirement-checkpointed",
            "after_create_ledger_retirement_checkpoint",
        ),
        ("create-ledger-retired", "after_create_ledger_retirement"),
    ] {
        let create_request = ManagedCreateRequest::new(
            format!("chain-crash-create-{suffix}"),
            format!("chain-crash-session-{suffix}"),
            "chain-crash-workspace",
            "codex",
            PermissionMode::Default,
            &cwd,
            vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
        )
        .unwrap();
        let created = creator.create(create_request.clone()).unwrap();
        let descriptor = created.session().descriptor();
        let stop_request =
            exact_managed_stop_request(format!("chain-crash-stop-{suffix}"), descriptor);
        run_faulted_managed_stop(&discovery_root, &cwd, &stop_request, fault);
        let root = ManagedCreateReconcileRequest::new(
            create_request.idempotency_key(),
            create_request.session_id(),
            create_request.workspace_id(),
        )
        .unwrap();

        let stopped = stopper.stop_create_chain_v2(root.clone()).unwrap();
        assert_eq!(stopped.chain(), std::slice::from_ref(&root));
        assert_eq!(
            stopped.stop_receipt().unwrap().stop_id(),
            stop_request.stop_id(),
        );
        assert_eq!(stopper.stop_create_chain_v2(root).unwrap(), stopped);
        assert_eq!(
            creator.create(create_request).unwrap_err().code(),
            MANAGED_CREATE_RETIRED_EXACT_CODE,
        );
    }
}

#[test]
fn codex_completion_reaches_the_exact_host_without_an_app_server() {
    codex_completion_fixture(false);
}

#[test]
#[ignore = "run pnpm test:hmux-rehost-cli wait with the isolated guardian and prepared CLI"]
fn dure_wait_observes_host_completion_without_an_app_server() {
    codex_completion_fixture(true);
}

fn codex_completion_fixture(check_cli: bool) {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_ready = state.path().join("provider-ready");
    let provider_input = state.path().join("provider-input");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "offline-codex-completion-create",
                "offline-codex-completion",
                "workspace-offline-codex-completion",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    r#"stty -echo
printf ready > "$1"
while IFS= read -r line; do printf '%s\n' "$line" >> "$2"; done"#
                        .into(),
                    "completion-provider".into(),
                    provider_ready.to_string_lossy().into_owned(),
                    provider_input.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new("codex", "conversation-offline").unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    wait_for_file_content(&provider_ready, b"ready");
    let cli_home = state.path().join("wait-cli-home");
    let cli = |args: &[&str]| {
        let mut command = Command::new("node");
        command
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs"))
            .args(args)
            .env("DURE_HOME", &cli_home)
            .env("DURE_APP_CHANNEL", "stable")
            .env(
                "DURE_HMUX_BIN",
                std::env::var_os("DURE_QA_HMUX_BIN").unwrap(),
            )
            .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
            .env_remove("DURE_BACKEND_PROFILE");
        command
    };
    let inspect_cli = || {
        let output = cli(&[
            "inspect",
            &descriptor.session_id,
            "--workspace",
            &descriptor.workspace_id,
            "--json",
        ])
        .output()
        .unwrap();
        assert!(output.status.success(), "{output:?}");
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["session"]["sessionId"], descriptor.session_id);
        assert_eq!(report["session"]["workspaceId"], descriptor.workspace_id);
        assert_eq!(
            report["session"]["runtime"]["generation"]["terminalEpoch"],
            descriptor.terminal_epoch
        );
        report["session"].clone()
    };
    let wait_cli = |cursor: &serde_json::Value, timeout: &str| {
        let output = cli(&[
            "wait",
            cursor["sessionId"].as_str().unwrap(),
            "--workspace",
            cursor["workspaceId"].as_str().unwrap(),
            "--after-turn",
            cursor["runtime"]["agentRuntimeState"]["turnCompletedCount"]
                .as_str()
                .unwrap(),
            "--terminal-epoch",
            cursor["runtime"]["generation"]["terminalEpoch"]
                .as_str()
                .unwrap(),
            "--timeout",
            timeout,
            "--json",
        ])
        .output()
        .unwrap();
        let report: serde_json::Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("wait returned no JSON: {output:?}"));
        (output.status.code(), report)
    };
    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let report_activity = |activity| {
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(
                    "offline-codex-completion",
                    "workspace-offline-codex-completion",
                )
                .unwrap(),
                AgentStateReport {
                    identity_only: false,
                    activity,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: None,
                },
            )
            .unwrap()
    };
    assert!(matches!(
        report_activity(hmux_client::AgentRuntimeActivity::Waiting),
        AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
    ));
    let cursor = check_cli.then(|| {
        fs::create_dir(&cli_home).unwrap();
        fs::write(
            cli_home.join("agents.json"),
            serde_json::json!({
                "version": 3, "updatedAt": 1,
                "agents": [{
                    "id": "completion-agent", "name": "completion-agent", "project": "fixture",
                    "sessionId": descriptor.session_id,
                    "runtimeBinding": {
                        "runtime": "hmux_managed_v1", "source": "local", "hostId": "local",
                        "sessionId": descriptor.session_id, "workspaceId": descriptor.workspace_id,
                        "stopFence": {
                            "runnerPrincipal": descriptor.runner_principal,
                            "runnerInstance": descriptor.runner_instance,
                            "channelEpoch": descriptor.channel_epoch,
                            "hostInstanceId": descriptor.host_instance_id,
                            "terminalEpoch": descriptor.terminal_epoch,
                        }
                    }
                }]
            })
            .to_string(),
        )
        .unwrap();
        let cursor = inspect_cli();
        assert_eq!(
            cursor["runtime"]["agentRuntimeState"]["turnCompletedCount"],
            "0"
        );
        cursor
    });
    if check_cli {
        use std::io::Write;
        let mut child = cli(&["send", "completion-agent", "--stdin", "--json"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"submitted turn")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["apiVersion"], "dure.send/v1");
        assert_eq!(report["target"]["sessionId"], descriptor.session_id);
        assert_eq!(
            report["receipt"]["terminalEpoch"],
            descriptor.terminal_epoch
        );
        assert_eq!(report["receipt"]["text"]["state"], "written_to_pty");
        assert_eq!(report["receipt"]["submit"]["state"], "written_to_pty");
    } else {
        let mut controller = ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root)
            .attach(
                ManagedAttachRequest::new(
                    "offline-codex-completion",
                    "workspace-offline-codex-completion",
                )
                .unwrap(),
            )
            .unwrap();
        let input_id = controller
            .mutation_handle()
            .send_input(b"submitted turn\n".to_vec())
            .unwrap();
        loop {
            match controller.read_event().unwrap() {
                Some(ControllerEvent::InputReceipt(receipt)) if receipt.request_id == input_id => {
                    assert_eq!(receipt.state, ControllerReceiptState::WrittenToPty);
                    break;
                }
                Some(_) => {}
                None => panic!("controller detached before the input receipt"),
            }
        }
        controller.detach().unwrap();
    }
    wait_for_file_content(&provider_input, b"submitted turn\n");

    // Written input is not provider acceptance. The fixture's provider adapter
    // reports its working turn before exercising the official completion hook.
    assert_eq!(
        report_activity(hmux_client::AgentRuntimeActivity::Working),
        AgentStateReportOutcome::Applied,
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let before_hook = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            "offline-codex-completion",
            Some("workspace-offline-codex-completion".into()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let before_hook_runtime = before_hook
        .attachment()
        .initial_snapshot
        .agent_runtime_state
        .as_ref()
        .unwrap();
    assert_eq!(
        before_hook_runtime.activity,
        hmux_client::AgentRuntimeActivity::Working
    );
    assert_eq!(before_hook_runtime.turn_completed_count, "0");
    before_hook.detach().unwrap();

    if let Some(cursor) = &cursor {
        let (status, report) = wait_cli(cursor, "1");
        assert_eq!(status, Some(124), "{report}");
        assert_eq!(report["state"], "unknown");
        assert_eq!(report["error"]["code"], "wait_timeout");
    }

    let hook_source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../src-tauri/resources/managed-claude-hook.py");
    let hook = state.path().join("managed-codex-notify.sh");
    // Codex remains the goal authority; only Dure's optional IDE app server is
    // absent from this direct Host-report path.
    let provider_bin = state.path().join("provider-bin");
    fs::create_dir(&provider_bin).unwrap();
    let codex = provider_bin.join("codex");
    let goal_query = state.path().join("codex-goal-query.json");
    fs::write(
        &codex,
        r#"#!/bin/sh
test "$1" = "app-server" || exit 64
while IFS= read -r request; do
  case "$request" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"id":1,"result":{"userAgent":"managed-smoke"}}'
      ;;
    *'"method":"thread/goal/get"'*)
      printf '%s' "$request" > "$HMUX_TEST_CODEX_GOAL_QUERY"
      printf '%s\n' '{"id":2,"result":{"goal":null}}'
      exit 0
      ;;
  esac
done
"#,
    )
    .unwrap();
    fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
    let mut provider_path = vec![provider_bin];
    if let Some(inherited_path) = std::env::var_os("PATH") {
        provider_path.extend(std::env::split_paths(&inherited_path));
    }
    let provider_path = std::env::join_paths(provider_path).unwrap();
    let hook_source = fs::read_to_string(hook_source).unwrap();
    let runtime = serde_json::to_string(env!("CARGO_BIN_EXE_hmux-runtime")).unwrap();
    let hook_source = hook_source.replacen("\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"", &runtime, 1);
    assert!(!hook_source.contains("__DURE_HMUX_RUNTIME_EXECUTABLE__"));
    fs::write(&hook, hook_source).unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let completion_id = "0199cccc-dddd-7b80-b357-ffdc5afdf272";
    let complete_turn = |completion_id: &str| {
        Command::new(&hook)
            .arg(
                serde_json::json!({
                    "type": "agent-turn-complete",
                    "thread-id": "conversation-offline",
                    "turn-id": completion_id,
                })
                .to_string(),
            )
            .env("DURE_HOME", state.path().join("ide-app-server-absent"))
            .env("HMUX_TEST_CODEX_GOAL_QUERY", &goal_query)
            .env("PATH", &provider_path)
            .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
            .env("HMUX_SESSION_ID", &descriptor.session_id)
            .env("HMUX_WORKSPACE_ID", &descriptor.workspace_id)
            .env("HMUX_RUNNER_PRINCIPAL", &descriptor.runner_principal)
            .env("HMUX_RUNNER_INSTANCE", &descriptor.runner_instance)
            .env("HMUX_CHANNEL_EPOCH", &descriptor.channel_epoch)
            .env("HMUX_HOST_INSTANCE_ID", &descriptor.host_instance_id)
            .env("HMUX_TERMINAL_EPOCH", &descriptor.terminal_epoch)
            .output()
            .unwrap()
    };
    let hook_result = complete_turn(completion_id);
    assert!(
        hook_result.status.success(),
        "managed Codex completion hook failed"
    );
    assert!(
        fs::read_to_string(&goal_query)
            .unwrap()
            .contains("conversation-offline"),
        "completion hook did not consult the exact Codex goal authority"
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    let settled = loop {
        let observer = LocalSessionObserver::connect(
            &catalog,
            &SessionSelector::new(
                "offline-codex-completion",
                Some("workspace-offline-codex-completion".into()),
            ),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let runtime = observer
            .attachment()
            .initial_snapshot
            .agent_runtime_state
            .as_ref()
            .unwrap();
        let settled = runtime.activity == hmux_client::AgentRuntimeActivity::Waiting
            && runtime.turn_completed_count == "1";
        observer.detach().unwrap();
        if settled || Instant::now() >= deadline {
            break settled;
        }
        thread::sleep(Duration::from_millis(20));
    };

    let isolated = inspect_local_sessions_exact_isolated(
        &catalog,
        &ExactDiscoveryWorker::new(env!("CARGO_BIN_EXE_hmux-runtime")),
        vec![SessionSelector::new(
            "offline-codex-completion",
            Some("workspace-offline-codex-completion".into()),
        )],
        1,
        Duration::from_secs(3),
    )
    .unwrap();
    let [ExactSessionProbeResult::Inspection(isolated)] = isolated.as_slice() else {
        panic!("isolated exact lookup did not return the live Codex Host")
    };
    assert_eq!(
        isolated
            .agent_runtime_state
            .as_ref()
            .map(|runtime| runtime.turn_completed_count.as_str()),
        Some("1"),
        "isolated exact lookup dropped the Host-owned completion projection",
    );

    if let Some(cursor) = &cursor {
        let (status, report) = wait_cli(cursor, "10");
        assert_eq!(status, Some(0), "{report}");
        assert_eq!(report["subject"], "response");
        assert_eq!(report["state"], "completed");
        assert_eq!(report["target"]["sessionId"], descriptor.session_id);
        assert_eq!(report["target"]["terminalEpoch"], descriptor.terminal_epoch);
        assert_eq!(report["observation"]["turnCompletedCount"], "1");
        let next_cursor = inspect_cli();
        assert_eq!(
            next_cursor["runtime"]["agentRuntimeState"]["turnCompletedCount"],
            "1"
        );
        // Duplicate official events cannot complete the next response.
        assert!(complete_turn(completion_id).status.success());
        let (status, report) = wait_cli(&next_cursor, "1");
        assert_eq!(status, Some(124), "{report}");
        assert_eq!(report["state"], "unknown");

        let wrapper = state.path().join("drop-input-receipt");
        let sent = state.path().join("send-attempts");
        let dropped = state.path().join("dropped-receipt.json");
        fs::write(
            &wrapper,
            r#"#!/bin/sh
if [ "$2" != command-input ]; then exec "$DURE_QA_HMUX_BIN" "$@"; fi
printf 'command-input\n' >> "$DURE_QA_SEND_ATTEMPTS"
"$DURE_QA_HMUX_BIN" "$@" > "$DURE_QA_DROPPED_RECEIPT"
exit "$?"
"#,
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
        let prompt = state.path().join("prompt.txt");
        fs::write(&prompt, "uncertain turn").unwrap();
        let output = cli(&[
            "send",
            "completion-agent",
            "--file",
            prompt.to_str().unwrap(),
            "--json",
        ])
        .env("DURE_HMUX_BIN", &wrapper)
        .env("DURE_QA_SEND_ATTEMPTS", &sent)
        .env("DURE_QA_DROPPED_RECEIPT", &dropped)
        .output()
        .unwrap();
        assert!(
            !output.status.success(),
            "lost receipt became success: {output:?}"
        );
        assert!(output.stdout.is_empty(), "{output:?}");
        assert!(!output.stderr.is_empty(), "{output:?}");
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(&dropped).unwrap()).unwrap();
        assert_eq!(receipt["ok"], true);
        assert_eq!(
            receipt["receipt"]["terminalEpoch"],
            descriptor.terminal_epoch
        );
        assert_eq!(receipt["receipt"]["submit"]["state"], "written_to_pty");
        wait_for_file_content(&provider_input, b"submitted turn\nuncertain turn\n");
        assert_eq!(
            report_activity(hmux_client::AgentRuntimeActivity::Working),
            AgentStateReportOutcome::Applied
        );
        let (status, report) = wait_cli(&next_cursor, "1");
        assert_eq!(status, Some(124), "{report}");
        assert_eq!(report["state"], "unknown");
        assert!(
            complete_turn("0199cccc-dddd-7b80-b357-ffdc5afdf273")
                .status
                .success()
        );
        // Restart only the observer. Neither response completion nor an uncertain
        // delivery authorizes sending the same prompt again.
        for _ in 0..2 {
            let (status, report) = wait_cli(&next_cursor, "10");
            assert_eq!(status, Some(0), "{report}");
            assert_eq!(report["observation"]["turnCompletedCount"], "2");
            assert_eq!(report["target"]["terminalEpoch"], descriptor.terminal_epoch);
        }
        assert_eq!(
            fs::read(&provider_input).unwrap(),
            b"submitted turn\nuncertain turn\n"
        );
        assert_eq!(fs::read(&sent).unwrap(), b"command-input\n");
    }

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "offline-codex-completion-cleanup",
            &descriptor,
        ))
        .unwrap();
    assert!(
        settled,
        "Codex completion was lost while the app server was absent; Host stayed working: {}",
        String::from_utf8_lossy(&hook_result.stderr)
    );
}

#[test]
fn managed_state_reports_require_the_adapter_authorization_proof() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            ManagedCreateRequest::new(
                "report-create",
                "managed-report",
                "workspace-managed-report",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new("codex", "conversation-launch").unwrap(),
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
            .any(|capability| capability == "agent_state_report_completion_id_v1")
    );
    assert!(
        session
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == "provider_conversation_identity_v1")
    );
    assert!(
        session
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == "provider_conversation_identity_only_report_v1")
    );
    let controller = ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .attach(ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap())
        .unwrap();
    assert!(
        !controller
            .attachment()
            .negotiation
            .selected_capabilities
            .iter()
            .any(|capability| capability == "managed_authorization_grant_v1"),
        "controller authorization posture must not advertise observer-only grant minting",
    );
    let initial_identity = controller
        .attachment()
        .initial_snapshot
        .provider_conversation_identity
        .as_ref()
        .expect("explicit resume identity must be present on the first snapshot");
    assert_eq!(initial_identity.conversation_id, "conversation-launch");
    assert_eq!(initial_identity.revision, "1");
    assert_eq!(
        initial_identity.source,
        ProviderConversationIdentitySource::LaunchRequest
    );
    let report = AgentStateReport {
        identity_only: false,
        activity: hmux_client::AgentRuntimeActivity::Working,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: Some(600_000),
        conversation_identity: None,
        expected_observation: None,
    };

    // A same-user observer attach is not authority on a managed Host: the
    // report capability requires the adapter-minted proof during hello.
    let denied = session
        .report_agent_state(report.clone(), None)
        .unwrap_err();
    assert_eq!(denied.code(), "hmux_authorization_denied");

    // Current Hosts no longer accept the long-lived discovery token as managed
    // authority. A short-lived grant is one-use and never enters discovery.
    let root = hmux_host::local_discovery::DiscoveryRoot::open(&discovery_root).unwrap();
    let found = root
        .find_manifest_by_session("workspace-managed-report", "managed-report")
        .unwrap();
    let hmux_host::local_discovery::DiscoveryManifest::Ready(ready) = found.manifest else {
        panic!("managed report session is not ready");
    };
    let raw_token_denied = session
        .report_agent_state(report.clone(), Some(ready.capability_token))
        .unwrap_err();
    assert_eq!(raw_token_denied.code(), "hmux_authorization_denied");
    let grant = session.request_managed_authorization_grant().unwrap();
    assert_eq!(
        session
            .report_agent_state(report.clone(), Some(grant.clone()))
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    let reused_grant = session.report_agent_state(report, Some(grant)).unwrap_err();
    assert_eq!(reused_grant.code(), "hmux_authorization_denied");

    // Product adapters use the broker-backed reporter, which mints a fresh
    // grant internally so it never crosses the product boundary. Reporting
    // the existing launch identity is idempotent within one provider epoch.
    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let descriptor = session.descriptor();
    let expected_fence = SessionFence {
        workspace_id: descriptor.workspace_id.clone(),
        session_id: descriptor.session_id.clone(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch: descriptor.channel_epoch.parse().unwrap(),
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
    };
    let identity_only_report = AgentStateReport {
        identity_only: true,
        // These values would demote the current working state if the Host
        // accidentally folded them as a runtime report.
        activity: hmux_client::AgentRuntimeActivity::Waiting,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: true,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        conversation_identity: Some(ProviderConversationIdentity {
            provider_id: "codex".into(),
            conversation_id: "conversation-launch".into(),
            expected_fence: Some(expected_fence.clone()),
        }),
        expected_observation: None,
    };
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
                identity_only_report.clone(),
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
                identity_only_report,
            )
            .unwrap(),
        AgentStateReportOutcome::NoOp
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let after_identity_only = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new("managed-report", Some("workspace-managed-report".into())),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let preserved_runtime = after_identity_only
        .attachment()
        .initial_snapshot
        .agent_runtime_state
        .as_ref()
        .expect("working runtime state must remain projected");
    assert_eq!(
        preserved_runtime.activity,
        hmux_client::AgentRuntimeActivity::Working
    );
    assert_eq!(preserved_runtime.turn_completed_count, "0");
    let confirmed_identity = after_identity_only
        .attachment()
        .initial_snapshot
        .provider_conversation_identity
        .as_ref()
        .expect("provider confirmation must remain projected");
    assert_eq!(confirmed_identity.revision, "2");
    assert_eq!(
        confirmed_identity.source,
        ProviderConversationIdentitySource::ProviderEvent
    );
    let completed_report = |fence: SessionFence, completion_id: &str| AgentStateReport {
        identity_only: false,
        activity: hmux_client::AgentRuntimeActivity::Waiting,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: true,
        turn_completion_id: Some(completion_id.into()),
        causality: None,
        working_ttl_ms: None,
        conversation_identity: Some(ProviderConversationIdentity {
            provider_id: "codex".into(),
            conversation_id: "conversation-launch".into(),
            expected_fence: Some(fence),
        }),
        expected_observation: None,
    };
    let mut stale_epoch = expected_fence.clone();
    stale_epoch.terminal_epoch = "terminal-stale".into();
    let stale_completion = reporter
        .report_agent_state(
            ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
            completed_report(stale_epoch, "turn-0199aaaa-bbbb-stale"),
        )
        .unwrap_err();
    assert_eq!(stale_completion.code(), "hmux_identity_mismatch");
    let after_stale = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new("managed-report", Some("workspace-managed-report".into())),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let after_stale_runtime = after_stale
        .attachment()
        .initial_snapshot
        .agent_runtime_state
        .as_ref()
        .unwrap();
    assert_eq!(
        after_stale_runtime.activity,
        hmux_client::AgentRuntimeActivity::Working
    );
    assert_eq!(after_stale_runtime.turn_completed_count, "0");
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
                completed_report(expected_fence.clone(), "turn-0199aaaa-bbbb-7ac2",),
            )
            .unwrap(),
        AgentStateReportOutcome::NoOp,
        "an identified completion remains pending during the Host settlement interval"
    );
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
                completed_report(expected_fence.clone(), "turn-0199aaaa-bbbb-7ac2",),
            )
            .unwrap(),
        AgentStateReportOutcome::NoOp,
        "the Host must own completion idempotency across adapter reconnects"
    );
    let completion_deadline = Instant::now() + Duration::from_secs(3);
    let baseline_observer = loop {
        let observer = LocalSessionObserver::connect(
            &catalog,
            &SessionSelector::new("managed-report", Some("workspace-managed-report".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let runtime = observer
            .attachment()
            .initial_snapshot
            .agent_runtime_state
            .as_ref()
            .unwrap();
        if runtime.activity == hmux_client::AgentRuntimeActivity::Waiting
            && runtime.turn_completed_count == "1"
        {
            break observer;
        }
        assert!(
            Instant::now() < completion_deadline,
            "identified completion did not settle exactly once"
        );
        thread::sleep(Duration::from_millis(20));
    };
    let baseline_snapshot = &baseline_observer.attachment().initial_snapshot;
    let baseline_runtime = baseline_snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(
        baseline_runtime.activity,
        hmux_client::AgentRuntimeActivity::Waiting
    );
    assert_eq!(baseline_runtime.turn_completed_count, "1");
    let stale_boundary = AgentStateReportObservationFence {
        terminal_epoch: baseline_snapshot.terminal_epoch.clone(),
        runtime_revision: baseline_runtime.revision.parse().unwrap(),
        output_sequence: baseline_snapshot.sequence_through.parse().unwrap(),
    };
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
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
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
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
            )
            .unwrap(),
        AgentStateReportOutcome::NoOp
    );
    let recovered_observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new("managed-report", Some("workspace-managed-report".into())),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let recovered_snapshot = &recovered_observer.attachment().initial_snapshot;
    let recovered_runtime = recovered_snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(
        recovered_runtime.activity,
        hmux_client::AgentRuntimeActivity::Working
    );
    assert_eq!(
        recovered_runtime.attention,
        hmux_client::AgentRuntimeAttention::None
    );
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
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
                        terminal_epoch: recovered_snapshot.terminal_epoch.clone(),
                        runtime_revision: recovered_runtime.revision.parse().unwrap(),
                        output_sequence: recovered_snapshot.sequence_through.parse().unwrap(),
                    }),
                },
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    let errored_observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new("managed-report", Some("workspace-managed-report".into())),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    assert_eq!(
        errored_observer
            .attachment()
            .initial_snapshot
            .agent_runtime_state
            .as_ref()
            .unwrap()
            .attention,
        hmux_client::AgentRuntimeAttention::Error
    );
    let conflict = reporter
        .report_agent_state(
            ManagedAttachRequest::new("managed-report", "workspace-managed-report").unwrap(),
            AgentStateReport {
                identity_only: false,
                activity: hmux_client::AgentRuntimeActivity::Waiting,
                attention: hmux_client::AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: Some(ProviderConversationIdentity {
                    provider_id: "codex".into(),
                    conversation_id: "conversation-conflict".into(),
                    expected_fence: Some(expected_fence),
                }),
                expected_observation: None,
            },
        )
        .unwrap_err();
    assert_eq!(conflict.code(), "hmux_identity_mismatch");

    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let stopped = stopper
        .stop(exact_managed_stop_request(
            "report-stop",
            created.session().descriptor(),
        ))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}

#[test]
#[cfg(feature = "terminal-state-stream")]
fn structured_semantics_follow_output_that_does_not_change_the_viewport() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let output_trigger = state.path().join("output-trigger");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            ManagedCreateRequest::new(
                "semantic-high-water-create",
                "managed-semantic-high-water",
                "workspace-semantic-high-water",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "while [ ! -f \"$1\" ]; do sleep 0.05; done; printf '\\033[31m'; sleep 30"
                        .into(),
                    "--".into(),
                    output_trigger.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    let descriptor = session.descriptor();
    let expected_fence = SessionFence {
        workspace_id: descriptor.workspace_id.clone(),
        session_id: descriptor.session_id.clone(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch: descriptor.channel_epoch.parse().unwrap(),
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
    };
    let mut connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::ReadOnly,
            None,
        ))
        .unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert_eq!(surface.current_frame().through_output_seq(), 0);

    fs::write(&output_trigger, b"emit").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut previous_output_seq = 0;
    let observed_output_seq = loop {
        let snapshot = session.read_screen(None).unwrap();
        if snapshot.sequence_through > 0 && snapshot.sequence_through == previous_output_seq {
            break snapshot.sequence_through;
        }
        previous_output_seq = snapshot.sequence_through;
        assert!(
            Instant::now() < deadline,
            "Host did not sequence the non-projecting PTY output"
        );
        thread::sleep(Duration::from_millis(20));
    };

    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(
                    "managed-semantic-high-water",
                    "workspace-semantic-high-water",
                )
                .unwrap(),
                AgentStateReport {
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Working,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: Some(600_000),
                    conversation_identity: Some(ProviderConversationIdentity {
                        provider_id: "codex".into(),
                        conversation_id: "conversation-after-noop-output".into(),
                        expected_fence: Some(expected_fence),
                    }),
                    expected_observation: None,
                },
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );

    let mut saw_high_water = false;
    let mut saw_runtime = false;
    let mut saw_identity = false;
    let mut read_failure = None;
    while !saw_runtime || !saw_identity {
        match surface.read_delivery_record() {
            Ok(hmux_client::ConnectionRecord::TerminalState(_)) => {
                assert!(
                    surface.current_frame().through_output_seq() >= observed_output_seq,
                    "the complete viewport must carry the non-projecting output high-water"
                );
                saw_high_water = true;
            }
            Ok(hmux_client::ConnectionRecord::Control(body)) => match *body {
                FrameBody::AgentRuntimeState(runtime) => {
                    assert!(
                        saw_high_water,
                        "runtime state arrived before its output high-water"
                    );
                    assert_eq!(runtime.observed_through_output_seq, observed_output_seq);
                    saw_runtime = true;
                }
                FrameBody::ProviderConversationIdentity(identity) => {
                    assert!(
                        saw_high_water,
                        "identity arrived before its output high-water"
                    );
                    assert_eq!(identity.observed_through_output_seq, observed_output_seq);
                    assert_eq!(identity.conversation_id, "conversation-after-noop-output");
                    saw_identity = true;
                }
                other => panic!("structured attach received an unexpected control: {other:?}"),
            },
            Err(error) => {
                read_failure = Some(error.to_string());
                break;
            }
        }
    }

    let _ = surface.detach();
    let stopped = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "semantic-high-water-stop",
            created.session().descriptor(),
        ))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
    assert!(
        read_failure.is_none(),
        "typed semantics remained staged without a viewport high-water: {read_failure:?}"
    );
    assert!(saw_high_water && saw_runtime && saw_identity);
}

#[test]
fn managed_identity_only_report_establishes_a_fresh_host_snapshot() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator
        .create(
            ManagedCreateRequest::new(
                "identity-only-create",
                "managed-identity-only",
                "workspace-managed-identity-only",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session().clone();
    let descriptor = session.descriptor();
    let expected_fence = SessionFence {
        workspace_id: descriptor.workspace_id.clone(),
        session_id: descriptor.session_id.clone(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch: descriptor.channel_epoch.parse().unwrap(),
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
    };
    let report = || AgentStateReport {
        identity_only: true,
        activity: hmux_client::AgentRuntimeActivity::Waiting,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: true,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        conversation_identity: Some(ProviderConversationIdentity {
            provider_id: "codex".into(),
            conversation_id: "conversation-inspected".into(),
            expected_fence: Some(expected_fence.clone()),
        }),
        expected_observation: None,
    };
    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    #[cfg(feature = "terminal-state-stream")]
    let mut live_surface = {
        let mut connection = session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::ReadOnly,
                None,
            ))
            .unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
        assert!(surface.initial_provider_conversation_identity().is_none());
        surface
    };

    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(
                    "managed-identity-only",
                    "workspace-managed-identity-only",
                )
                .unwrap(),
                report(),
            )
            .unwrap(),
        AgentStateReportOutcome::Applied
    );
    #[cfg(feature = "terminal-state-stream")]
    {
        let live_identity = loop {
            match live_surface.read_delivery_record().unwrap() {
                hmux_client::ConnectionRecord::Control(body) => match *body {
                    FrameBody::ProviderConversationIdentity(identity) => break identity,
                    other => {
                        panic!("structured attach received an unexpected control record: {other:?}")
                    }
                },
                hmux_client::ConnectionRecord::TerminalState(_) => continue,
            }
        };
        assert_eq!(live_identity.conversation_id, "conversation-inspected");
    }
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(
                    "managed-identity-only",
                    "workspace-managed-identity-only",
                )
                .unwrap(),
                report(),
            )
            .unwrap(),
        AgentStateReportOutcome::NoOp
    );

    let catalog = LocalSessionCatalog::new(&discovery_root);
    let observer = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            "managed-identity-only",
            Some("workspace-managed-identity-only".into()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let snapshot = &observer.attachment().initial_snapshot;
    let identity = snapshot
        .provider_conversation_identity
        .as_ref()
        .expect("identity-only report must survive in the Host snapshot");
    assert_eq!(identity.conversation_id, "conversation-inspected");
    assert_eq!(
        identity.source,
        ProviderConversationIdentitySource::ProviderEvent
    );
    assert!(
        snapshot.agent_runtime_state.is_none(),
        "identity-only report must not fabricate runtime activity"
    );

    #[cfg(feature = "terminal-state-stream")]
    {
        let connection = session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::ReadOnly,
                None,
            ))
            .unwrap();
        let surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
        let structured_identity = surface
            .initial_provider_conversation_identity()
            .expect("structured attach must seed the current Host-owned identity");
        assert_eq!(structured_identity.session_id, "managed-identity-only");
        assert_eq!(
            structured_identity.workspace_id,
            "workspace-managed-identity-only"
        );
        assert_eq!(
            structured_identity.conversation_id,
            "conversation-inspected"
        );
        assert_eq!(
            structured_identity.source,
            ProviderConversationIdentitySource::ProviderEvent
        );
        surface.detach().unwrap();
        live_surface.detach().unwrap();
    }

    let stopped = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "identity-only-stop",
            created.session().descriptor(),
        ))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}

#[test]
fn conversation_fenced_stop_refuses_an_identity_published_after_fresh_inspection() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "conversation-fence-create",
                "conversation-fence-session",
                "conversation-fence-workspace",
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
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    assert!(
        descriptor
            .capabilities
            .iter()
            .any(|capability| { capability == "managed_provider_conversation_fenced_stop_v1" }),
        "the exact-absence stop fence must be negotiated before destructive admission"
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let inspected_fresh = LocalSessionObserver::connect(
        &catalog,
        &SessionSelector::new(
            "conversation-fence-session",
            Some("conversation-fence-workspace".into()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    assert!(
        inspected_fresh
            .attachment()
            .initial_snapshot
            .provider_conversation_identity
            .is_none()
    );
    inspected_fresh.detach().unwrap();
    let stale_fresh_stop = exact_managed_stop_request("conversation-fence-stale", &descriptor)
        .with_expected_conversation(ManagedStopConversationFence::new("codex", None).unwrap())
        .unwrap();
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let wrong_provider = stopper
        .stop(
            exact_managed_stop_request("conversation-fence-wrong-provider", &descriptor)
                .with_expected_conversation(
                    ManagedStopConversationFence::new("claude", None).unwrap(),
                )
                .unwrap(),
        )
        .unwrap_err();
    assert_eq!(wrong_provider.code(), "hmux_managed_stop_refused");
    assert_eq!(
        catalog
            .find(&SessionSelector::new(
                "conversation-fence-session",
                Some("conversation-fence-workspace".into()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready,
        "exact conversation absence must not authorize a stop for another provider"
    );

    let conversation_id = "conversation-after-fresh-inspection";
    publish_provider_conversation_identity(
        &discovery_root,
        &cwd,
        &descriptor,
        "codex",
        conversation_id,
    );

    let stale = stopper.stop(stale_fresh_stop).unwrap_err();
    assert_eq!(stale.code(), "hmux_managed_stop_refused");
    assert_eq!(
        catalog
            .find(&SessionSelector::new(
                "conversation-fence-session",
                Some("conversation-fence-workspace".into()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready,
        "an identity-only report that wins the race must preserve the provider"
    );

    let stopped = stopper
        .stop(
            exact_managed_stop_request("conversation-fence-current", &descriptor)
                .with_expected_conversation(
                    ManagedStopConversationFence::new("codex", Some(conversation_id.to_string()))
                        .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}

fn conversation_writer_request(
    cwd: &std::path::Path,
    suffix: &str,
    workspace_id: &str,
    conversation_id: &str,
    command: Vec<String>,
) -> ManagedCreateRequest {
    ManagedCreateRequest::new(
        format!("conversation-writer-create-{suffix}"),
        format!("conversation-writer-session-{suffix}"),
        workspace_id,
        "codex",
        PermissionMode::Default,
        cwd,
        command,
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
    .unwrap()
}

fn exact_managed_stop_request(
    stop_id: impl Into<String>,
    descriptor: &hmux_client::SessionDescriptor,
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

fn publish_provider_conversation_identity(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    descriptor: &hmux_client::SessionDescriptor,
    provider_id: &str,
    conversation_id: &str,
) {
    let expected_fence = SessionFence {
        workspace_id: descriptor.workspace_id.clone(),
        session_id: descriptor.session_id.clone(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch: descriptor.channel_epoch.parse().unwrap(),
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
    };
    let outcome = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), cwd)
        .with_discovery_root(discovery_root)
        .report_agent_state(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
            AgentStateReport {
                identity_only: true,
                activity: hmux_client::AgentRuntimeActivity::Waiting,
                attention: hmux_client::AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: Some(ProviderConversationIdentity {
                    provider_id: provider_id.into(),
                    conversation_id: conversation_id.into(),
                    expected_fence: Some(expected_fence),
                }),
                expected_observation: None,
            },
        )
        .unwrap();
    assert_eq!(outcome, AgentStateReportOutcome::Applied);
}

fn rehostable_create_request(
    cwd: &std::path::Path,
    replacement_marker: &std::path::Path,
    suffix: &str,
) -> ManagedCreateRequest {
    rehostable_create_request_with_command(
        cwd,
        replacement_marker,
        suffix,
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
    )
}

fn rehostable_create_request_with_command(
    cwd: &std::path::Path,
    replacement_marker: &std::path::Path,
    suffix: &str,
    command: Vec<String>,
) -> ManagedCreateRequest {
    let conversation_id = format!("conversation-{suffix}");
    ManagedCreateRequest::new(
        format!("rehost-source-create-{suffix}"),
        format!("rehost-source-{suffix}"),
        format!("rehost-workspace-{suffix}"),
        "codex",
        PermissionMode::BypassApprovals,
        cwd,
        command,
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
    .unwrap()
    .with_managed_rehost_recipe(
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s' \"$1\" >> \"$2\"; sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                replacement_marker.to_string_lossy().into_owned(),
            ],
            Some(format!("credential-{suffix}")),
        )
        .unwrap(),
    )
    .unwrap()
}

fn exact_managed_rehost_request(
    operation_id: impl Into<String>,
    descriptor: &hmux_client::SessionDescriptor,
    confirmed: bool,
) -> ManagedRehostRequest {
    ManagedRehostRequest::new(
        operation_id,
        &descriptor.session_id,
        &descriptor.workspace_id,
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse().unwrap(),
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
        confirmed,
    )
    .unwrap()
}

fn v2_managed_rehost_request(
    operation_id: impl Into<String>,
    descriptor: &hmux_client::SessionDescriptor,
    cwd: &std::path::Path,
    replacement_marker: &std::path::Path,
    suffix: &str,
    source_launch_reference: Option<&str>,
) -> ManagedRehostRequest {
    let target_reference = format!("credential-target-{suffix}");
    let replacement = ManagedRehostReplacement::new(
        "codex",
        PermissionMode::BypassApprovals,
        cwd,
        24,
        80,
        TerminalEnvironment::default(),
        Some(target_reference.clone()),
        ProviderStateEnvironment::default(),
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s' \"$1\" >> \"$2\"; sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                replacement_marker.to_string_lossy().into_owned(),
            ],
            Some(target_reference),
        )
        .unwrap(),
    )
    .unwrap();
    let request = exact_managed_rehost_request(operation_id, descriptor, true)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id(format!("conversation-{suffix}"))
        .unwrap();
    let request = match source_launch_reference {
        Some(reference) => request.with_expected_launch_reference(reference).unwrap(),
        None => request,
    };
    request.with_replacement(replacement).unwrap()
}

fn provider_state_managed_rehost_request(
    operation_id: impl Into<String>,
    descriptor: &hmux_client::SessionDescriptor,
    cwd: &std::path::Path,
    replacement_marker: &std::path::Path,
    suffix: &str,
    provider_state_environment: ProviderStateEnvironment,
) -> ManagedRehostRequest {
    let target_reference = format!("credential-target-{suffix}");
    let replacement = ManagedRehostReplacement::new(
        "codex",
        PermissionMode::BypassApprovals,
        cwd,
        24,
        80,
        TerminalEnvironment::default(),
        Some(target_reference.clone()),
        provider_state_environment,
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s' \"$1\" >> \"$2\"; sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                replacement_marker.to_string_lossy().into_owned(),
            ],
            Some(target_reference),
        )
        .unwrap(),
    )
    .unwrap();
    exact_managed_rehost_request(operation_id, descriptor, true)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id(format!("conversation-{suffix}"))
        .unwrap()
        .with_expected_launch_reference(format!("credential-{suffix}"))
        .unwrap()
        .with_replacement(replacement)
        .unwrap()
}

fn fresh_managed_rehost_request_from_wire(
    operation_id: &str,
    descriptor: &hmux_client::SessionDescriptor,
    cwd: &std::path::Path,
    fresh_marker: &std::path::Path,
    future_resume_marker: &std::path::Path,
) -> ManagedRehostRequest {
    let replacement = ManagedRehostReplacement::new(
        "codex",
        PermissionMode::BypassApprovals,
        cwd,
        24,
        80,
        TerminalEnvironment::default(),
        None,
        ProviderStateEnvironment::default(),
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s' \"$1\" >> \"$2\"; sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                future_resume_marker.to_string_lossy().into_owned(),
            ],
            None,
        )
        .unwrap(),
    )
    .unwrap()
    .with_fresh_command(vec![
        "/bin/sh".into(),
        "-c".into(),
        "printf 'fresh\\n' >> \"$1\"; sleep 30".into(),
        "--".into(),
        fresh_marker.to_string_lossy().into_owned(),
    ])
    .unwrap();
    let request = exact_managed_rehost_request(operation_id, descriptor, true)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_replacement(replacement)
        .unwrap();
    let value = serde_json::to_value(request).unwrap();
    serde_json::from_value(value).unwrap()
}

fn managed_rehost_target_session_id(request: &ManagedRehostRequest) -> String {
    let mut digest = Sha256::new();
    digest.update(b"hmux_managed_rehost_target_v1");
    digest.update(request.operation_id().as_bytes());
    digest.update(request.source().workspace_id().as_bytes());
    digest.update(request.source().session_id().as_bytes());
    let digest = format!("{:x}", digest.finalize());
    format!("managed_rehost_{}", &digest[..32])
}

fn spawn_managed_rehost_at_guardian_cut(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedRehostRequest,
    marker: &std::path::Path,
) -> std::process::Child {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_REHOST_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE", "provider_spawned")
        .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER", marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    child
}

fn run_crashing_managed_rehost(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedRehostRequest,
    fault: &str,
) {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_REHOST_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_TEST_MANAGED_REHOST_FAULT", fault)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(87),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

fn run_managed_rehost_with_retirement_error(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedRehostRequest,
    fault: &str,
) -> ManagedRehostBrokerResponse {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_REHOST_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_TEST_MANAGED_STARTING_RETIREMENT_ERROR", fault)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    response
}

fn run_managed_rehost_with_omitted_capabilities(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedRehostRequest,
    omitted_capabilities: &str,
) -> ManagedRehostBrokerResponse {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_REHOST_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env(
            "HMUX_RUNTIME_TEST_HOST_OMIT_CAPABILITIES",
            omitted_capabilities,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    response
}

fn run_crashing_managed_rehost_at_stop_side_effect(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedRehostRequest,
) {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_REHOST_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_TEST_MANAGED_STOP_FAULT", "after_provider_stop")
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(86));
}

fn run_crashing_managed_rehost_at_create_completion(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedRehostRequest,
) {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_REHOST_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env(
            "HMUX_TEST_MANAGED_CREATE_FAULT",
            "after_create_ledger_completed_before_broker_receipt",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(86));
}

fn ready_rehost_target(
    discovery_root: &std::path::Path,
    source: &hmux_client::SessionDescriptor,
) -> hmux_client::SessionDescriptor {
    LocalSessionCatalog::new(discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .find(|descriptor| {
            descriptor.session_id != source.session_id
                && descriptor.lifecycle == SessionLifecycle::Ready
        })
        .expect("managed rehost did not leave one ready target generation")
}

struct PausedExactManagedTestHost(ProcessDescriptor);

impl Drop for PausedExactManagedTestHost {
    fn drop(&mut self) {
        if matches!(
            probe_local_process_generation(&self.0),
            Ok(LocalProcessGenerationStatus::Live)
        ) {
            let process_id = i32::try_from(self.0.process_id).unwrap();
            // SAFETY: the exact temporary Host generation was revalidated
            // immediately above; SIGCONT can only resume that test Host.
            unsafe {
                libc::kill(process_id, libc::SIGCONT);
            }
        }
    }
}

fn pause_exact_managed_test_host(process: &ProcessDescriptor) -> PausedExactManagedTestHost {
    assert!(matches!(
        probe_local_process_generation(process).unwrap(),
        LocalProcessGenerationStatus::Live
    ));
    let process_id = i32::try_from(process.process_id).unwrap();
    // SAFETY: the descriptor is an exact live generation created below the
    // disposable discovery root, and the test never targets its own pid.
    assert_ne!(process_id, unsafe { libc::getpid() });
    // SAFETY: the exact temporary Host generation was revalidated immediately
    // above; SIGSTOP targets only that Host pid.
    assert_eq!(unsafe { libc::kill(process_id, libc::SIGSTOP) }, 0);
    thread::sleep(Duration::from_millis(50));
    PausedExactManagedTestHost(process.clone())
}

fn stop_ready_managed_test_sessions(discovery_root: &std::path::Path, cwd: &std::path::Path) {
    let ready = LocalSessionCatalog::new(discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| descriptor.lifecycle == SessionLifecycle::Ready)
        .collect::<Vec<_>>();
    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), cwd)
        .with_discovery_root(discovery_root);
    for descriptor in ready {
        stopper
            .stop(exact_managed_stop_request(
                format!("managed-rehost-red-green-cleanup-{}", descriptor.session_id),
                &descriptor,
            ))
            .unwrap();
    }
}

fn run_managed_rehost_reconcile(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedRehostReconcileRequest,
) -> hmux_client::ManagedRehostReceipt {
    let mut command = isolated_managed_runtime_command();
    command
        .arg("--no-autostart")
        .arg(MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response: ManagedRehostBrokerResponse =
        read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    match response {
        ManagedRehostBrokerResponse::Completed(receipt) => *receipt,
        ManagedRehostBrokerResponse::Refused(failure) => panic!(
            "managed rehost reconciliation was refused ({}): {}",
            failure.code, failure.message
        ),
    }
}

fn wait_for_receipts(
    controller: &mut hmux_client::LocalSessionController,
    input_id: &str,
    resize_id: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut input = false;
    let mut resize = false;
    while !input || !resize {
        match controller.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt)) if receipt.request_id == input_id => {
                assert_eq!(receipt.state, ControllerReceiptState::WrittenToPty);
                input = true;
            }
            Some(ControllerEvent::ResizeReceipt(receipt)) if receipt.request_id == resize_id => {
                assert_eq!(receipt.state, ControllerReceiptState::AppliedToTerminal);
                resize = true;
            }
            Some(_) => {}
            None => panic!("managed controller disconnected before mutation receipts"),
        }
        assert!(
            Instant::now() < deadline,
            "managed mutation receipt timed out"
        );
    }
}

#[cfg(feature = "terminal-state-stream")]
fn wait_for_resize_receipt(controller: &mut hmux_client::LocalSessionController, resize_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match controller.read_event().unwrap() {
            Some(ControllerEvent::ResizeReceipt(receipt)) if receipt.request_id == resize_id => {
                assert_eq!(receipt.state, ControllerReceiptState::AppliedToTerminal);
                return;
            }
            Some(_) => {}
            None => panic!("managed controller disconnected before the resize receipt"),
        }
        assert!(
            Instant::now() < deadline,
            "managed resize receipt timed out"
        );
    }
}

#[cfg(feature = "terminal-state-stream")]
fn wait_for_presentation_dimensions(
    discovery_root: &std::path::Path,
    descriptor: &hmux_client::SessionDescriptor,
    rows: u16,
    columns: u16,
) {
    let source = PresentationCheckpointSource::new(
        &descriptor.workspace_id,
        &descriptor.session_id,
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse().unwrap(),
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
    )
    .unwrap();
    let root = DiscoveryRoot::open(discovery_root).unwrap();
    let discovery = root.open_session(source.discovery_key().unwrap()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match discovery.read_presentation_checkpoint(&source) {
            Ok(Some(checkpoint))
                if (checkpoint.rows(), checkpoint.columns()) == (rows, columns) =>
            {
                return;
            }
            Ok(_) => {}
            Err(error) => panic!("presentation checkpoint could not be read: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "presentation checkpoint never reached {rows}x{columns}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_exited(discovery_root: &std::path::Path, session_id: &str, workspace_id: &str) {
    let catalog = LocalSessionCatalog::new(discovery_root);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if catalog
            .find(&SessionSelector::new(
                session_id,
                Some(workspace_id.to_string()),
            ))
            .unwrap()
            .lifecycle
            == SessionLifecycle::Exited
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "managed provider did not publish an exited tombstone"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_screen_text(
    session: &hmux_client::LocalSession,
    expected: &[&str],
) -> hmux_host::local_protocol::ScreenSnapshot {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let snapshot = session.read_screen(None).unwrap();
        let repaint = String::from_utf8_lossy(&snapshot.repaint_bytes);
        if expected.iter().all(|needle| repaint.contains(needle)) {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "managed replacement did not restore and extend its screen: {repaint:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
