#![cfg(unix)]

#[path = "standalone_create_operation/bound_broker.rs"]
mod bound_broker;
#[path = "standalone_create_operation/completed_target.rs"]
mod completed_target;
#[path = "standalone_create_operation/cross_root_upgrade.rs"]
mod cross_root_upgrade;
#[path = "standalone_create_operation/located_upgrade.rs"]
mod located_upgrade;
#[path = "standalone_create_operation/lost_response.rs"]
mod lost_response;
#[path = "standalone_create_operation/refusal_gc.rs"]
mod refusal_gc;
#[path = "standalone_create_operation/source_ownership.rs"]
mod source_ownership;
#[path = "standalone_create_operation/upgrade.rs"]
mod upgrade;
#[path = "standalone_create_operation/upgrade_failure.rs"]
mod upgrade_failure;

use hmux_client::recovery_journal::{
    self, RecoveryIdentity, RecoveryOperationPayload, RecoveryReservationState,
    STANDALONE_CREATE_OPERATION_RECOVERY_ACTION, request_fingerprint, reserve,
};
use hmux_client::{
    ExitedSessionRetirementGeneration, LocalProcessGenerationStatus, LocalSessionCatalog,
    SessionSelector, StandaloneCreateRequest, StandaloneRecipeRequirement,
    StandaloneRecoveryCreateIdentity, StandaloneSessionCreator, probe_local_process_generation,
};
use hmux_host::local_discovery::{DiscoveryManifest, DiscoveryRoot, workspace_id_for_path};
use hmux_runtime_contract::{
    STANDALONE_CREATE_OPERATION_SUBCOMMAND, StandaloneCreateOperationMode,
    StandaloneCreateOperationRequest as Request, StandaloneCreateOperationResponse as Response,
    read_standalone_create_operation_response_for, write_json_frame,
};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write as _};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStringExt as _;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn hmux_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_hmux"))
}

fn runtime_executable() -> PathBuf {
    let runtime =
        hmux_executable().with_file_name(format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX));
    assert!(runtime.is_file(), "missing {}", runtime.display());
    runtime
}

fn fixture_provider_command() -> Vec<String> {
    vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "--exact".into(),
        "fixture_provider_process".into(),
        "--ignored".into(),
        "--nocapture".into(),
    ]
}

fn fixture_provider_marker(cwd: &Path) -> PathBuf {
    cwd.join("fixture-provider-ready")
}

#[test]
#[ignore = "spawned by standalone operation integration tests"]
fn fixture_provider_process() {
    let marker = fixture_provider_marker(&std::env::current_dir().unwrap());
    let mut marker = OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker)
        .unwrap();
    writeln!(marker, "ready").unwrap();
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn spawn_operation(
    discovery_root: &Path,
    cwd: &Path,
    request: &Request,
    guardian_cut: Option<&Path>,
) -> Child {
    let mut child = spawn_operation_process(discovery_root, cwd, guardian_cut);
    send_operation(&mut child, request);
    child
}

fn spawn_operation_process(
    discovery_root: &Path,
    cwd: &Path,
    guardian_cut: Option<&Path>,
) -> Child {
    let mut command = Command::new(hmux_executable());
    command
        .arg("--discovery-root")
        .arg(discovery_root)
        .arg(STANDALONE_CREATE_OPERATION_SUBCOMMAND)
        .env("HMUX_RUNTIME", runtime_executable())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(marker) = guardian_cut {
        command
            .env(
                "HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE",
                "host_starting_published",
            )
            .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER", marker)
            .process_group(0);
    }
    command.spawn().unwrap()
}

fn send_operation(child: &mut Child, request: &Request) {
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
}

fn finish_operation(child: Child, request: &Request) -> Response {
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "operation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    read_standalone_create_operation_response_for(&mut Cursor::new(output.stdout), request).unwrap()
}

fn run(discovery_root: &Path, cwd: &Path, request: &Request) -> Response {
    finish_operation(spawn_operation(discovery_root, cwd, request, None), request)
}

fn prepared_request_payload_bytes(request: &Request, cwd: &Path) -> usize {
    let admitted = request
        .clone()
        .admit(cwd.to_path_buf())
        .expect("operation fixture must have a valid public binding");
    let recovery_identity = StandaloneRecoveryCreateIdentity::new(
        admitted.target_session_id(),
        "00000000-0000-4000-8000-000000000000",
    )
    .unwrap()
    .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound);
    serde_json::to_vec(
        &admitted
            .standalone_request()
            .unwrap()
            .clone()
            .with_recovery_identity(recovery_identity)
            .unwrap(),
    )
    .unwrap()
    .len()
}

fn reconcile_completed_target(request: &Request) -> Request {
    request
        .clone()
        .with_mode(StandaloneCreateOperationMode::ReconcileCompletedTarget)
}

fn acknowledge_retired_target(request: &Request) -> Request {
    request
        .clone()
        .with_mode(StandaloneCreateOperationMode::AcknowledgeRetiredTarget)
}

fn retire_completed_target(request: &Request) -> Request {
    request
        .clone()
        .with_mode(StandaloneCreateOperationMode::RetireCompletedTarget)
}

fn await_marker(marker: &Path) {
    await_marker_lines(marker, 1);
}

fn await_marker_lines(marker: &Path, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if fs::read_to_string(marker).is_ok_and(|contents| contents.lines().count() >= expected) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("provider marker did not reach {expected} entries");
}

fn general_resurrection_recipe_count(discovery_root: &Path) -> usize {
    let directory = discovery_root.join(".resurrection");
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("recipe_") && name.ends_with(".json"))
        .count()
}

fn created_identity(response: &Response) -> (&str, &str) {
    match response {
        Response::Created {
            session_id,
            workspace_id,
            ..
        } => (session_id, workspace_id),
        Response::Refused { error_code, .. } => {
            panic!("operation was refused: {error_code}")
        }
        Response::Pending { error_code, .. } => {
            panic!("operation is still pending: {error_code}")
        }
        Response::Retired { .. } => panic!("operation target was retired"),
        Response::Acknowledged { .. } => panic!("operation completion was acknowledged"),
    }
}

fn terminate(discovery_root: &Path, session_id: &str, workspace_id: &str) {
    let catalog = LocalSessionCatalog::new(discovery_root);
    let session = catalog
        .open(&SessionSelector::new(
            session_id,
            Some(workspace_id.to_string()),
        ))
        .unwrap();
    session
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

fn checkpoint_target_before_completion(
    discovery_root: &Path,
    cwd: &Path,
    request: &Request,
) -> (String, String) {
    DiscoveryRoot::create(discovery_root).unwrap();
    let admitted = request.clone().admit(cwd.to_path_buf()).unwrap();
    let target_session_id = admitted.target_session_id().to_string();
    let public_payload = admitted.canonical_payload().to_string();
    let public_request = admitted.standalone_request().unwrap().clone();
    let recovery_identity = StandaloneRecoveryCreateIdentity::new(
        target_session_id.clone(),
        "checkpoint-before-completion-fixture",
    )
    .unwrap()
    .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound);
    let prepared_request = public_request
        .with_recovery_identity(recovery_identity)
        .unwrap();
    let identity = RecoveryIdentity {
        recovery_id: format!("standalone_create_operation_v1_{}", request.operation_id()),
        source_session_id: format!("operation_{}", request.operation_id()),
        source_workspace_id: "standalone_create_operation_v1".to_string(),
        request_fingerprint: request_fingerprint(&[&public_payload]),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    };
    let RecoveryReservationState::Pending(mut reservation) =
        reserve(discovery_root, identity).unwrap()
    else {
        panic!("new operation unexpectedly completed");
    };
    reservation
        .prepare_operation_payload(
            RecoveryOperationPayload::new(serde_json::to_string(&prepared_request).unwrap())
                .unwrap(),
        )
        .unwrap();
    let created = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(discovery_root)
        .create(prepared_request)
        .unwrap();
    let descriptor = created.session().descriptor();
    let checkpoint = serde_json::json!({
        "schema": "hmux-standalone-create-operation-completed-target-v1",
        "schemaVersion": 1,
        "receipt": created.receipt(),
        "generation": ExitedSessionRetirementGeneration::from_descriptor(descriptor).unwrap(),
        "providerProcess": descriptor.provider_process,
        "hostBuildVersion": descriptor.host_build_version,
    });
    reservation
        .checkpoint_replacement_receipt(serde_json::to_string(&checkpoint).unwrap())
        .unwrap();
    (
        created.receipt().session_id().to_string(),
        created.receipt().workspace_id().to_string(),
    )
}

#[test]
fn completed_operation_replays_one_exact_session_without_exposing_launch_proof() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let marker = fixture_provider_marker(&cwd);
    let command = fixture_provider_command();
    let request = Request::new(
        "a".repeat(64),
        "prepared-create-fixture",
        command.clone(),
        24,
        80,
    )
    .unwrap();

    let first = run(&discovery_root, &cwd, &request);
    assert!(
        matches!(first, Response::Created { .. }),
        "first operation was refused: {first:?}"
    );
    await_marker(&marker);
    let gc = recovery_journal::garbage_collect_completed(
        &discovery_root,
        recovery_journal::RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..recovery_journal::RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(gc.removed_completed_records, 0);
    let second = run(&discovery_root, &cwd, &request);
    assert_eq!(second, first);
    assert_eq!(
        run(&discovery_root, &cwd, &reconcile_completed_target(&request),),
        first,
    );
    assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);
    assert_eq!(
        general_resurrection_recipe_count(&discovery_root),
        0,
        "the private operation journal must be the only replay authority"
    );
    assert!(matches!(
        run(
            &discovery_root,
            &cwd,
            &acknowledge_retired_target(&request),
        ),
        Response::Pending { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_reconciliation_pending"
    ));
    assert_eq!(
        recovery_journal::inspect(&discovery_root)
            .unwrap()
            .completed_records,
        1
    );

    let changed = Request::new(request.operation_id(), "changed-recipe", command, 24, 80).unwrap();
    assert!(matches!(
        run(&discovery_root, &cwd, &changed),
        Response::Refused { error_code, .. }
            if error_code == "hmux_recovery_idempotency_conflict"
    ));

    let (session_id, workspace_id) = created_identity(&first);
    terminate(&discovery_root, session_id, workspace_id);
}

#[test]
fn completed_operation_retires_an_ended_target_before_authorizing_a_successor() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let marker = fixture_provider_marker(&cwd);
    let command = fixture_provider_command();
    let request = Request::new(
        "1".repeat(64),
        "completed-target-successor-fixture",
        command.clone(),
        24,
        80,
    )
    .unwrap();

    let created = run(&discovery_root, &cwd, &request);
    await_marker(&marker);
    let (session_id, workspace_id) = created_identity(&created);
    terminate(&discovery_root, session_id, workspace_id);

    assert_eq!(run(&discovery_root, &cwd, &request), created);
    let retirement_request = retire_completed_target(&request);
    let deadline = Instant::now() + Duration::from_secs(6);
    let reconciliation = loop {
        let response = run(&discovery_root, &cwd, &retirement_request);
        if matches!(response, Response::Retired { .. }) {
            break response;
        }
        assert!(
            matches!(response, Response::Pending { .. }),
            "unexpected reconciliation response: {response:?}"
        );
        assert!(Instant::now() < deadline, "ended target was not retired");
        thread::sleep(Duration::from_millis(25));
    };
    assert!(
        matches!(
            &reconciliation,
            Response::Retired {
                operation_id,
                session_name,
                session_id: retired_session_id,
                workspace_id: retired_workspace_id,
                ..
            } if operation_id == request.operation_id()
                && session_name == request.session_name()
                && retired_session_id == session_id
                && retired_workspace_id == workspace_id
        ),
        "unexpected reconciliation response: {reconciliation:?}"
    );
    assert_eq!(
        run(&discovery_root, &cwd, &retirement_request),
        reconciliation,
        "a lost retirement response must replay without allocating a target",
    );
    let reconciled = reconcile_completed_target(&request);
    assert_eq!(
        run(&discovery_root, &cwd, &reconciled),
        reconciliation,
        "ordinary reconciliation must observe the same retired lifecycle"
    );
    let acknowledgement = acknowledge_retired_target(&request);
    let acknowledged = run(&discovery_root, &cwd, &acknowledgement);
    assert!(matches!(
        acknowledged,
        Response::Acknowledged { ref operation_id, .. }
            if operation_id == request.operation_id()
    ));
    assert_eq!(
        recovery_journal::inspect_existing(&discovery_root)
            .unwrap()
            .operation_records,
        0
    );
    assert_eq!(
        general_resurrection_recipe_count(&discovery_root),
        0,
        "acknowledgement must leave no general resurrection path"
    );
    assert_eq!(
        run(&discovery_root, &cwd, &acknowledgement),
        acknowledged,
        "a lost acknowledgement response must not recreate journal state",
    );
    assert_eq!(
        recovery_journal::inspect_existing(&discovery_root)
            .unwrap()
            .operation_records,
        0
    );
    for stale in [&request, &reconciled] {
        assert!(matches!(
            run(&discovery_root, &cwd, stale),
            Response::Refused { ref error_code, .. }
                if error_code == "hmux_recovery_completion_acknowledged"
        ));
    }
    assert_eq!(
        fs::read_to_string(&marker).unwrap().lines().count(),
        1,
        "an acknowledged operation must never resurrect its retired provider",
    );

    let successor = Request::new("2".repeat(64), request.session_name(), command, 24, 80).unwrap();
    let successor_created = run(&discovery_root, &cwd, &successor);
    assert!(
        matches!(successor_created, Response::Created { .. }),
        "successor was not created: {successor_created:?}"
    );
    await_marker_lines(&marker, 2);
    assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 2);
    assert_eq!(
        general_resurrection_recipe_count(&discovery_root),
        0,
        "successive private operations must not accumulate general recipes"
    );
    let (session_id, workspace_id) = created_identity(&successor_created);
    terminate(&discovery_root, session_id, workspace_id);
}

#[test]
fn explicit_retirement_terminates_one_exact_target_and_replays_after_response_loss() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let request = Request::new(
        "6".repeat(64),
        "explicit-retirement-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();
    let created = run(&discovery_root, &cwd, &request);
    await_marker(&fixture_provider_marker(&cwd));
    let (session_id, workspace_id) = created_identity(&created);
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let descriptor = catalog
        .find(&SessionSelector::new(
            session_id,
            Some(workspace_id.to_string()),
        ))
        .unwrap();

    assert_eq!(
        run(&discovery_root, &cwd, &reconcile_completed_target(&request)),
        created,
        "ordinary reconciliation must remain non-destructive"
    );
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );

    let retirement = retire_completed_target(&request);
    let mut first = spawn_operation_process(&discovery_root, &cwd, None);
    drop(first.stdout.take());
    send_operation(&mut first, &retirement);
    let output = first.wait_with_output().unwrap();
    assert!(
        !output.status.success(),
        "closing the response reader must cut the retirement delivery"
    );

    let deadline = Instant::now() + Duration::from_secs(6);
    let retired = loop {
        let response = run(&discovery_root, &cwd, &retirement);
        if matches!(response, Response::Retired { .. }) {
            break response;
        }
        assert!(
            matches!(response, Response::Pending { .. }),
            "unexpected retirement response: {response:?}"
        );
        assert!(Instant::now() < deadline, "target did not retire");
        thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(run(&discovery_root, &cwd, &retirement), retired);
    assert_eq!(
        fs::read_to_string(fixture_provider_marker(&cwd))
            .unwrap()
            .lines()
            .count(),
        1
    );

    let acknowledged = run(&discovery_root, &cwd, &acknowledge_retired_target(&request));
    assert!(matches!(acknowledged, Response::Acknowledged { .. }));
}

#[test]
fn reconciliation_after_checkpoint_before_completion_resolves_the_exact_target() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let marker = fixture_provider_marker(&cwd);
    let request = Request::new(
        "3".repeat(64),
        "checkpoint-before-completion-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();

    let (session_id, workspace_id) =
        checkpoint_target_before_completion(&discovery_root, &cwd, &request);
    await_marker(&marker);
    terminate(&discovery_root, &session_id, &workspace_id);

    let reconciled = reconcile_completed_target(&request);
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let response = run(&discovery_root, &cwd, &reconciled);
        match response {
            Response::Retired {
                ref operation_id,
                session_id: ref retired_session_id,
                workspace_id: ref retired_workspace_id,
                ..
            } => {
                assert_eq!(operation_id, request.operation_id());
                assert_eq!(retired_session_id, &session_id);
                assert_eq!(retired_workspace_id, &workspace_id);
                break;
            }
            Response::Pending { .. } => {
                assert!(Instant::now() < deadline, "ended target was not retired");
                thread::sleep(Duration::from_millis(25));
            }
            Response::Created { .. } => {
                panic!("reconciliation bypassed exact target lifecycle resolution")
            }
            Response::Refused { error_code, .. } => {
                panic!("reconciliation was refused: {error_code}")
            }
            Response::Acknowledged { .. } => {
                panic!("reconciliation returned an acknowledgement")
            }
        }
    }
    assert_eq!(fs::read_to_string(marker).unwrap().lines().count(), 1);
}

#[test]
fn absent_acknowledgement_never_creates_discovery_or_journal_state() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("absent-discovery");
    let request = Request::new(
        "4".repeat(64),
        "absent-acknowledgement-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();

    assert!(matches!(
        run(&discovery_root, &cwd, &retire_completed_target(&request)),
        Response::Pending { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_not_submitted"
    ));
    assert!(matches!(
        run(
            &discovery_root,
            &cwd,
            &acknowledge_retired_target(&request),
        ),
        Response::Pending { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_not_submitted"
    ));
    assert!(!discovery_root.exists());
    assert!(!fixture_provider_marker(&cwd).exists());

    let created = run(&discovery_root, &cwd, &request);
    await_marker(&fixture_provider_marker(&cwd));
    let (session_id, workspace_id) = created_identity(&created);
    terminate(&discovery_root, session_id, workspace_id);
}

#[test]
fn unresolved_target_acknowledgement_preserves_the_completed_operation() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let request = Request::new(
        "5".repeat(64),
        "unresolved-acknowledgement-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();
    let created = run(&discovery_root, &cwd, &request);
    await_marker(&fixture_provider_marker(&cwd));
    let (session_id, workspace_id) = created_identity(&created);
    let provider_process = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            session_id,
            Some(workspace_id.to_string()),
        ))
        .unwrap()
        .provider_process;
    let record_path = fs::read_dir(discovery_root.join(".recovery"))
        .unwrap()
        .map(Result::unwrap)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("operation_") && name.ends_with(".json"))
        })
        .unwrap();
    let mut record: serde_json::Value =
        serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    let replacement = record
        .get("operation_checkpoint")
        .and_then(|checkpoint| checkpoint.get("replacementReceipt"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("completed operation lost its target checkpoint: {record}"));
    let mut target: serde_json::Value = serde_json::from_str(replacement).unwrap();
    target["providerProcess"]["start_marker"] = "unrelated-generation".into();
    record["operation_checkpoint"]["replacementReceipt"] =
        serde_json::to_string(&target).unwrap().into();
    fs::write(&record_path, serde_json::to_vec(&record).unwrap()).unwrap();

    assert!(matches!(
        run(&discovery_root, &cwd, &retire_completed_target(&request)),
        Response::Pending { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_reconciliation_pending"
    ));
    assert_eq!(
        probe_local_process_generation(&provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "retirement must not signal a target whose saved generation changed"
    );
    assert!(matches!(
        run(
            &discovery_root,
            &cwd,
            &acknowledge_retired_target(&request),
        ),
        Response::Pending { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_reconciliation_pending"
    ));
    assert!(record_path.exists());
    assert_eq!(
        recovery_journal::inspect(&discovery_root)
            .unwrap()
            .completed_records,
        1
    );
    terminate(&discovery_root, session_id, workspace_id);
}

#[test]
fn concurrent_identical_operations_create_one_host_and_provider() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let marker = fixture_provider_marker(&cwd);
    let request = Request::new(
        "9".repeat(64),
        "concurrent-operation-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();

    let first = spawn_operation(&discovery_root, &cwd, &request, None);
    let second = spawn_operation(&discovery_root, &cwd, &request, None);
    let initial = [
        finish_operation(first, &request),
        finish_operation(second, &request),
    ];
    for response in &initial {
        assert!(
            matches!(response, Response::Created { .. })
                || matches!(
                    response,
                    Response::Pending { error_code, .. }
                        if error_code == "hmux_recovery_busy"
                ),
            "unexpected concurrent response: {response:?}"
        );
    }
    let created = run(&discovery_root, &cwd, &request);
    assert!(matches!(created, Response::Created { .. }));
    for response in &initial {
        if matches!(response, Response::Created { .. }) {
            assert_eq!(response, &created);
        }
    }
    await_marker(&marker);
    assert_eq!(fs::read_to_string(marker).unwrap().lines().count(), 1);
    let (session_id, workspace_id) = created_identity(&created);
    terminate(&discovery_root, session_id, workspace_id);
}

#[test]
fn deterministic_invalid_operation_completes_and_replays() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let request = Request::new("e".repeat(64), "", Vec::new(), 24, 80).unwrap();

    let first = run(&discovery_root, &cwd, &request);
    assert!(matches!(
        first,
        Response::Refused { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_invalid"
    ));
    assert_eq!(run(&discovery_root, &cwd, &request), first);
    let inspection = recovery_journal::inspect(&discovery_root).unwrap();
    assert_eq!(inspection.pending_records, 0);
    assert_eq!(inspection.completed_records, 1);

    let changed = Request::new(
        request.operation_id(),
        "now-valid",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();
    assert!(matches!(
        run(&discovery_root, &cwd, &changed),
        Response::Refused { error_code, .. }
            if error_code == "hmux_recovery_idempotency_conflict"
    ));
    assert!(
        LocalSessionCatalog::new(&discovery_root)
            .list()
            .unwrap()
            .is_empty()
    );
    assert!(!fixture_provider_marker(&cwd).exists());
}

#[test]
#[cfg(target_os = "linux")]
fn non_utf8_cwd_defers_before_binding_or_launch() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().join(std::ffi::OsString::from_vec(vec![
        b'n', b'o', b'n', b'-', b'u', b't', b'f', b'8', b'-', 0xff,
    ]));
    fs::create_dir(&cwd).unwrap();
    let discovery_root = state.path().join("discovery");
    let request = Request::new(
        "8".repeat(64),
        "non-utf8-cwd-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();

    for _ in 0..2 {
        assert!(matches!(
            run(&discovery_root, &cwd, &request),
            Response::Pending { error_code, .. }
                if error_code == "hmux_standalone_create_operation_binding_unavailable"
        ));
    }
    assert!(!discovery_root.exists());
    assert!(!fixture_provider_marker(&cwd).exists());
}

#[test]
fn oversized_private_operation_payload_settles_as_invalid() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let request_with_tail = |operation_id: char, tail_bytes: usize| {
        let mut command = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "while :; do sleep 60; done".to_string(),
            "aggregate-boundary".to_string(),
        ];
        command.extend(vec!["x".repeat(4_096); 7]);
        command.push("x".repeat(tail_bytes));
        Request::new(
            operation_id.to_string().repeat(64),
            "oversized-private-payload",
            command,
            24,
            80,
        )
        .unwrap()
    };
    let mut low: usize = 1;
    let mut high: usize = 4_096;
    while low < high {
        let candidate = low + (high - low).div_ceil(2);
        if prepared_request_payload_bytes(&request_with_tail('f', candidate), &cwd) <= 32 * 1024 {
            low = candidate;
        } else {
            high = candidate - 1;
        }
    }
    let within = request_with_tail('e', low);
    assert!(prepared_request_payload_bytes(&within, &cwd) <= 32 * 1024);
    let within_discovery_root = cwd.join("within-discovery");
    let created = run(&within_discovery_root, &cwd, &within);
    let (session_id, workspace_id) = created_identity(&created);
    terminate(&within_discovery_root, session_id, workspace_id);

    let request = request_with_tail('f', low + 1);
    assert!(prepared_request_payload_bytes(&request, &cwd) > 32 * 1024);

    let first = run(&discovery_root, &cwd, &request);
    assert!(matches!(
        first,
        Response::Refused { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_invalid"
    ));
    assert_eq!(run(&discovery_root, &cwd, &request), first);
    let inspection = recovery_journal::inspect(&discovery_root).unwrap();
    assert_eq!(inspection.pending_records, 0);
    assert_eq!(inspection.completed_records, 1);
    assert!(
        LocalSessionCatalog::new(&discovery_root)
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn escape_heavy_operation_that_cannot_complete_its_record_is_refused_before_launch() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let request_with_tail = |tail_bytes: usize| {
        let mut command = vec!["\\".repeat(4_096); 3];
        command.push("\\".repeat(tail_bytes));
        Request::new(
            "7".repeat(64),
            "escape-heavy-record-boundary",
            command,
            24,
            80,
        )
        .unwrap()
    };
    let mut low: usize = 1;
    let mut high: usize = 4_096;
    while low < high {
        let candidate = low + (high - low).div_ceil(2);
        if prepared_request_payload_bytes(&request_with_tail(candidate), &cwd) <= 32_767 {
            low = candidate;
        } else {
            high = candidate - 1;
        }
    }
    let request = request_with_tail(low);
    let prepared_bytes = prepared_request_payload_bytes(&request, &cwd);
    assert!(
        (32_765..=32_767).contains(&prepared_bytes),
        "fixture did not reach the reported inner payload boundary: {prepared_bytes}"
    );
    assert!(
        request
            .clone()
            .admit(cwd.clone())
            .unwrap()
            .standalone_request()
            .is_ok(),
        "the public operation must be valid before journal admission"
    );

    let refused = run(&discovery_root, &cwd, &request);
    assert!(matches!(
        refused,
        Response::Refused { ref error_code, .. }
            if error_code == "hmux_standalone_create_operation_invalid"
    ));
    assert_eq!(run(&discovery_root, &cwd, &request), refused);
    let inspection = recovery_journal::inspect(&discovery_root).unwrap();
    assert_eq!(inspection.pending_records, 0);
    assert_eq!(inspection.completed_records, 1);
    assert!(
        LocalSessionCatalog::new(&discovery_root)
            .list()
            .unwrap()
            .is_empty()
    );
    assert!(!fixture_provider_marker(&cwd).exists());

    assert!(matches!(
        run(&discovery_root, &cwd, &acknowledge_retired_target(&request),),
        Response::Acknowledged { .. }
    ));
    assert_eq!(
        recovery_journal::inspect_existing(&discovery_root)
            .unwrap()
            .operation_records,
        0
    );
}

#[test]
fn lost_completed_response_replays_one_exact_session() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let marker = fixture_provider_marker(&cwd);
    let request = Request::new(
        "d".repeat(64),
        "completed-response-loss-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();

    let mut first = spawn_operation_process(&discovery_root, &cwd, None);
    drop(first.stdout.take());
    send_operation(&mut first, &request);
    let output = first.wait_with_output().unwrap();
    assert!(
        !output.status.success(),
        "closing the response reader must cut the first delivery"
    );
    await_marker(&marker);

    let replayed = run(&discovery_root, &cwd, &request);
    let (session_id, workspace_id) = created_identity(&replayed);
    assert_eq!(fs::read_to_string(marker).unwrap().lines().count(), 1);
    let inspection = recovery_journal::inspect(&discovery_root).unwrap();
    assert_eq!(inspection.pending_records, 0);
    assert_eq!(inspection.completed_records, 1);
    terminate(&discovery_root, session_id, workspace_id);
}

#[test]
fn retry_after_a_lost_starting_response_keeps_one_host_and_provider() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let guardian_cut = cwd.join("host-starting-published");
    let provider_marker = fixture_provider_marker(&cwd);
    let request = Request::new(
        "b".repeat(64),
        "response-loss-create-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();

    let mut first = spawn_operation(&discovery_root, &cwd, &request, Some(&guardian_cut));
    await_marker(&guardian_cut);
    let target_session_id = request
        .clone()
        .admit(cwd.clone())
        .unwrap()
        .target_session_id()
        .to_string();
    let discovery = DiscoveryRoot::open(&discovery_root).unwrap();
    let target_workspace_id = workspace_id_for_path(&cwd);
    let starting = discovery
        .find_current_manifest_by_session(&target_workspace_id, &target_session_id)
        .unwrap()
        .manifest;
    assert!(matches!(starting, DiscoveryManifest::Starting(_)));
    let starting_host = starting.common().host_process.clone();
    assert_eq!(
        starting.common().session_name.as_deref(),
        Some(request.session_name())
    );
    assert!(!provider_marker.exists());

    let first_group = i32::try_from(first.id()).unwrap();
    // SAFETY: the CLI was placed in a test-owned process group above. The
    // detached Host created its own session and is intentionally preserved.
    assert_eq!(unsafe { libc::kill(-first_group, libc::SIGKILL) }, 0);
    let _ = first.wait();

    assert!(matches!(
        run(&discovery_root, &cwd, &request),
        Response::Pending { error_code, .. }
            if error_code == "hmux_standalone_recovery_target_unavailable"
    ));
    let transient = recovery_journal::inspect(&discovery_root).unwrap();
    assert_eq!(transient.pending_records, 1);
    assert_eq!(transient.completed_records, 0);
    let after_loss = discovery
        .find_current_manifest_by_session(&target_workspace_id, &target_session_id)
        .unwrap()
        .manifest;
    assert!(matches!(after_loss, DiscoveryManifest::Starting(_)));
    assert_eq!(after_loss.common().host_process, starting_host);

    // SAFETY: this exact Host process was created by this test and remains
    // stopped at the debug-only pre-provider cut.
    assert_eq!(
        unsafe { libc::kill(starting_host.process_id as i32, libc::SIGCONT) },
        0
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let created = loop {
        let response = run(&discovery_root, &cwd, &request);
        if matches!(response, Response::Created { .. }) {
            break response;
        }
        assert!(
            matches!(
                response,
                Response::Pending { ref error_code, .. }
                    if error_code == "hmux_standalone_recovery_target_unavailable"
            ),
            "unexpected retry response: {response:?}"
        );
        assert!(
            Instant::now() < deadline,
            "resumed Host did not become ready"
        );
        thread::sleep(Duration::from_millis(50));
    };
    await_marker(&provider_marker);
    let (session_id, workspace_id) = created_identity(&created);
    assert_eq!(session_id, target_session_id);
    assert_eq!(
        fs::read_to_string(&provider_marker)
            .unwrap()
            .lines()
            .count(),
        1
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let ready = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.session_name.as_deref() == Some(request.session_name()))
        .collect::<Vec<_>>();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].host_process.process_id, starting_host.process_id);
    assert_eq!(
        ready[0].host_process.start_marker,
        starting_host.start_marker
    );
    let completed = recovery_journal::inspect(&discovery_root).unwrap();
    assert_eq!(completed.pending_records, 0);
    assert_eq!(completed.completed_records, 1);
    terminate(&discovery_root, session_id, workspace_id);
}

#[test]
fn terminal_name_conflict_is_completed_and_replays_the_same_refusal() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let unrelated = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&discovery_root)
        .create(
            StandaloneCreateRequest::new(
                cwd.clone(),
                Some("terminal-conflict-fixture".into()),
                fixture_provider_command(),
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    await_marker(&fixture_provider_marker(&cwd));
    let request = Request::new(
        "c".repeat(64),
        "terminal-conflict-fixture",
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();
    let target_session_id = request
        .clone()
        .admit(cwd.clone())
        .unwrap()
        .target_session_id()
        .to_string();

    let first = run(&discovery_root, &cwd, &request);
    assert!(
        matches!(
            first,
            Response::Refused { ref error_code, .. }
                if error_code == "hmux_standalone_recipe_conflict"
        ),
        "unexpected active-name conflict response: {first:?}"
    );
    let inspection = recovery_journal::inspect(&discovery_root).unwrap();
    assert_eq!(inspection.pending_records, 0);
    assert_eq!(inspection.completed_records, 1);

    unrelated
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
    assert_eq!(run(&discovery_root, &cwd, &request), first);
    assert!(
        catalog
            .list()
            .unwrap()
            .into_iter()
            .all(|session| session.session_id != target_session_id),
        "a replayed terminal refusal must not launch its target"
    );
}

#[test]
fn request_bound_create_refuses_a_seeded_general_resurrection_recipe() {
    let state = tempfile::tempdir().unwrap();
    let cwd = state.path().canonicalize().unwrap();
    let discovery_root = cwd.join("discovery");
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let session_name = "seeded-general-recipe-fixture";
    let general = StandaloneSessionCreator::new(runtime_executable())
        .with_discovery_root(&discovery_root)
        .create(
            StandaloneCreateRequest::new(
                cwd.clone(),
                Some(session_name.into()),
                fixture_provider_command(),
                24,
                80,
            )
            .unwrap(),
        )
        .unwrap();
    await_marker(&fixture_provider_marker(&cwd));
    general
        .session()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
    assert_eq!(general_resurrection_recipe_count(&discovery_root), 1);

    let request = Request::new(
        "7".repeat(64),
        session_name,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();
    let refused = run(&discovery_root, &cwd, &request);
    assert!(
        matches!(
            refused,
            Response::Refused { ref error_code, .. }
                if error_code == "hmux_standalone_recipe_conflict"
        ),
        "unexpected seeded-recipe response: {refused:?}"
    );
    assert_eq!(run(&discovery_root, &cwd, &request), refused);
    assert_eq!(general_resurrection_recipe_count(&discovery_root), 1);
    assert_eq!(
        fs::read_to_string(fixture_provider_marker(&cwd))
            .unwrap()
            .lines()
            .count(),
        1,
        "request-bound create must not launch beside a general recipe authority"
    );
}
