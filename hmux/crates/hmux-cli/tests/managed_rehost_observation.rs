//! Actual CLI processes over a disposable native journal, without an app or provider.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime};

use hmux_client::recovery_journal::{
    PreparedRecoveryIdentity, RecoveryCompletion, RecoveryJournalGcPolicy, RecoveryReservation,
    RecoveryReservationState, garbage_collect_completed, reserve_prepared,
};
use hmux_runtime_contract::{
    MANAGED_REHOST_RECOVERY_ACTION, MANAGED_REHOST_RECOVERY_ID_PREFIX,
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt, ManagedStopOutcome,
    ManagedStopReceipt, ManagedStopRequest, PermissionMode,
};
use serde_json::Value;

fn private_root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    root
}

fn pending(root: &Path, operation: &str, source: &str) -> RecoveryReservation {
    let identity = PreparedRecoveryIdentity {
        recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{operation}"),
        source_session_id: source.into(),
        source_workspace_id: "workspace-1".into(),
        action: MANAGED_REHOST_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    };
    let RecoveryReservationState::Pending(reservation) = reserve_prepared(
        root,
        identity,
        Some(r#"{"launchReference":null,"conversationId":"conversation-1"}"#.into()),
    )
    .unwrap() else {
        panic!("new fixture must be pending")
    };
    reservation
}

fn complete(root: &Path, operation: &str, source: &str, target: &str, epoch: u64) {
    let mut reservation = pending(root, operation, source);
    let source_receipt = ManagedStopReceipt::from_request(
        &ManagedStopRequest::new(
            format!("managed_rehost_stop_{operation}"),
            source,
            "workspace-1",
        )
        .unwrap()
        .with_expected_fence(
            "principal",
            "runner",
            epoch,
            format!("host-{source}"),
            format!("terminal-{source}"),
        )
        .unwrap(),
        ManagedStopOutcome::Stopped,
        "fixture source stopped",
    )
    .unwrap();
    let replacement = ManagedCreateReceipt::new(
        format!("create-{operation}"),
        target,
        "workspace-1",
        "fixture",
        PermissionMode::Default,
        root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            "principal",
            "runner",
            epoch + 1,
            format!("host-{target}"),
            format!("terminal-{target}"),
        )
        .unwrap(),
    )
    .unwrap();
    reservation
        .checkpoint_source_stop_receipt(serde_json::to_string(&source_receipt).unwrap())
        .unwrap();
    reservation
        .checkpoint_replacement_receipt(serde_json::to_string(&replacement).unwrap())
        .unwrap();
    reservation
        .complete(RecoveryCompletion {
            target_session_id: target.into(),
            target_workspace_id: "workspace-1".into(),
            target_build_id: "fixture".into(),
            action: MANAGED_REHOST_RECOVERY_ACTION.into(),
            outcome: "replaced".into(),
            resume_checkpoint: None,
            operation_checkpoint: reservation.operation_checkpoint().cloned(),
        })
        .unwrap();
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime)> {
    let mut files = BTreeMap::new();
    if !root.exists() {
        return files;
    }
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.insert(
                path.clone(),
                (Vec::new(), fs::metadata(&path).unwrap().modified().unwrap()),
            );
            files.extend(snapshot(&path));
        } else {
            files.insert(
                path.clone(),
                (
                    fs::read(&path).unwrap(),
                    fs::metadata(path).unwrap().modified().unwrap(),
                ),
            );
        }
    }
    files
}

fn query(root: &Path, operation: &str, source: &str, dure: bool) -> Output {
    query_selected(root, operation, Some(source), dure)
}

fn query_selected(root: &Path, operation: &str, source: Option<&str>, dure: bool) -> Output {
    let mut command = if dure {
        let mut command = Command::new("node");
        command
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs"))
            .args(["hmux", "rehost", "status"]);
        if let Some(source) = source {
            command.arg(source);
        }
        command
    } else {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hmux"));
        command.arg("managed-rehost-resolve");
        if let Some(source) = source {
            command.args(["--session", source]);
        }
        command
    };
    if source.is_some() {
        command.args(["--workspace", "workspace-1"]);
    }
    command
        .args(["--operation-id", operation, "--json"])
        .current_dir(root)
        .env("HOME", root)
        .env("DURE_HOME", root.join("app"))
        .env("DURE_APP_CHANNEL", "stable")
        .env("HMUX_DISCOVERY_ROOT", root)
        .env("DURE_HMUX_BIN", env!("CARGO_BIN_EXE_hmux"))
        .env("HMUX_RUNTIME", root.join("no-runtime-installed"))
        .env_remove("HEBBIAN_APP_CHANNEL")
        .env_remove("HMUX_MANAGED_REHOST_SOURCE_DISCOVERY_ROOT")
        .output()
        .unwrap()
}

#[test]
fn operation_only_observation_uses_original_journal_without_name_or_latest_successor() {
    let root = private_root();
    complete(root.path(), "operation-1", "source-1", "successor-1", 1);
    complete(root.path(), "operation-2", "successor-1", "successor-2", 2);
    let before = snapshot(root.path());
    for dure in [false, true] {
        let _lost_response = query_selected(root.path(), "operation-1", None, dure);
        assert_eq!(
            observed(query_selected(root.path(), "operation-1", None, dure)),
            observed(query(root.path(), "operation-1", "source-1", dure)),
        );
    }
    assert_eq!(snapshot(root.path()), before);
}

#[test]
fn operation_only_pending_missing_and_compacted_records_preserve_storage() {
    let root = private_root();
    let before = snapshot(root.path());
    let absent = query_selected(root.path(), "operation-1", None, true);
    assert!(!absent.status.success());
    assert!(
        String::from_utf8_lossy(&absent.stderr)
            .contains("hmux_managed_rehost_operation_source_unavailable")
    );
    assert_eq!(snapshot(root.path()), before);

    let held = pending(root.path(), "pending", "original");
    let before = snapshot(root.path());
    let result = observed(query_selected(root.path(), "pending", None, true));
    assert_eq!(result["state"], "retry_required");
    assert_eq!(result["source"]["sessionId"], "original");
    assert_eq!(snapshot(root.path()), before);
    drop(held);

    complete(root.path(), "operation-1", "source-1", "successor-1", 1);
    let report = garbage_collect_completed(
        root.path(),
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
    let before = snapshot(root.path());
    let compacted = query_selected(root.path(), "operation-1", None, true);
    assert!(!compacted.status.success());
    assert!(
        String::from_utf8_lossy(&compacted.stderr)
            .contains("hmux_managed_rehost_operation_source_unavailable")
    );
    assert_eq!(
        observed(query(root.path(), "operation-1", "source-1", true))["state"],
        "resolved"
    );
    assert_eq!(snapshot(root.path()), before);
}

#[test]
fn operation_lookup_reads_only_its_record_and_rejects_foreign_or_corrupt_identity() {
    let root = private_root();
    complete(root.path(), "operation-1", "source-1", "successor-1", 1);
    let record = snapshot(root.path())
        .into_keys()
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("operation_")
                && path
                    .extension()
                    .is_some_and(|extension| extension == "json")
        })
        .unwrap();
    // A malformed unrelated record is not part of this point lookup.
    fs::write(
        root.path().join(".recovery/operation_unrelated.json"),
        "broken unrelated record",
    )
    .unwrap();
    let before = snapshot(root.path());
    assert_eq!(
        observed(query_selected(root.path(), "operation-1", None, true))["state"],
        "resolved"
    );
    assert_eq!(snapshot(root.path()), before);

    let mut wire: Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    wire["recoveryId"] = format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}different-operation").into();
    fs::write(&record, serde_json::to_vec(&wire).unwrap()).unwrap();
    let before = snapshot(root.path());
    let foreign = query_selected(root.path(), "operation-1", None, true);
    assert!(!foreign.status.success());
    assert!(
        String::from_utf8_lossy(&foreign.stderr).contains("hmux_recovery_idempotency_conflict")
    );
    assert_eq!(snapshot(root.path()), before);

    fs::write(&record, "broken record").unwrap();
    let before = snapshot(root.path());
    let corrupt = query_selected(root.path(), "operation-1", None, true);
    assert!(!corrupt.status.success());
    assert!(String::from_utf8_lossy(&corrupt.stderr).contains("hmux_recovery_journal_invalid"));
    assert_eq!(snapshot(root.path()), before);
}

#[test]
fn native_boundary_keeps_confirmation_and_complete_source_requirements() {
    let root = private_root();
    let before = snapshot(root.path());
    for (command, extra, code) in [
        (
            "managed-rehost-reconcile",
            vec![],
            "hmux_managed_rehost_confirmation_required",
        ),
        (
            "managed-rehost-start",
            vec!["--confirm-restart"],
            "hmux_managed_rehost_source_required",
        ),
        (
            "managed-rehost-resolve",
            vec!["--session", "source"],
            "--workspace",
        ),
        (
            "managed-rehost-resolve",
            vec!["--workspace", "workspace"],
            "--session",
        ),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_hmux"))
            .arg("--discovery-root")
            .arg(root.path())
            .args([command, "--operation-id", "existing"])
            .args(extra)
            .current_dir(root.path())
            .env("HOME", root.path())
            .env("HMUX_RUNTIME", root.path().join("must-not-execute-runtime"))
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(code),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(snapshot(root.path()), before);
}

fn observed(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn exact_operation_survives_response_loss_later_successor_and_compaction() {
    let root = private_root();
    complete(root.path(), "operation-1", "source-1", "successor-1", 1);
    complete(root.path(), "operation-2", "successor-1", "successor-2", 2);
    for compact in [false, true] {
        if compact {
            let report = garbage_collect_completed(
                root.path(),
                RecoveryJournalGcPolicy {
                    minimum_completed_age: Duration::ZERO,
                    maximum_completed_records: 0,
                    maximum_completed_bytes: 0,
                    ..RecoveryJournalGcPolicy::default()
                },
            )
            .unwrap();
            assert_eq!(report.removed_completed_records, 2);
        }
        let before = snapshot(root.path());
        let latest = observed(
            Command::new(env!("CARGO_BIN_EXE_hmux"))
                .arg("--discovery-root")
                .arg(root.path())
                .args([
                    "managed-rehost-resolve",
                    "--session",
                    "source-1",
                    "--workspace",
                    "workspace-1",
                    "--json",
                ])
                .output()
                .unwrap(),
        );
        assert_eq!(latest["currentGeneration"]["sessionId"], "successor-2");
        assert_eq!(
            latest["operationIds"],
            serde_json::json!(["operation-1", "operation-2"])
        );
        let native = observed(query(root.path(), "operation-1", "source-1", false));
        assert_eq!(native["operationIds"], serde_json::json!(["operation-1"]));
        assert_eq!(native["currentGeneration"]["sessionId"], "successor-1");
        assert_eq!(native["launchIdentity"]["conversationId"], "conversation-1");
        let _lost_response = query(root.path(), "operation-1", "source-1", true);
        assert_eq!(
            observed(query(root.path(), "operation-1", "source-1", true)),
            native
        );
        assert_eq!(
            observed(query(root.path(), "other-operation", "source-1", true))["state"],
            "not_found"
        );
        assert_eq!(snapshot(root.path()), before);
    }
}

#[test]
fn absent_and_pending_observation_never_creates_or_continues_an_operation() {
    let root = private_root();
    let before = snapshot(root.path());
    assert_eq!(
        observed(query(root.path(), "operation-1", "source-1", true))["state"],
        "not_found"
    );
    assert_eq!(snapshot(root.path()), before);
    let held = pending(root.path(), "operation-1", "source-1");
    let before = snapshot(root.path());
    let result = observed(query(root.path(), "operation-1", "source-1", true));
    assert_eq!(result["state"], "retry_required");
    assert_eq!(result["operationId"], "operation-1");
    assert_eq!(snapshot(root.path()), before);
    drop(held);
}

#[test]
fn wrong_source_and_corrupt_journal_are_not_absence_or_success() {
    let root = private_root();
    complete(root.path(), "operation-1", "source-1", "successor-1", 1);
    let before = snapshot(root.path());
    let wrong_source = query(root.path(), "operation-1", "wrong-source", true);
    assert!(!wrong_source.status.success());
    assert!(
        String::from_utf8_lossy(&wrong_source.stderr)
            .contains("hmux_recovery_idempotency_conflict")
    );
    assert_eq!(snapshot(root.path()), before);
    let record = before
        .keys()
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("operation_")
                && path
                    .extension()
                    .is_some_and(|extension| extension == "json")
        })
        .unwrap();
    fs::write(record, "broken fixture journal").unwrap();
    let before = snapshot(root.path());
    let corrupt = query(root.path(), "operation-1", "source-1", true);
    assert!(!corrupt.status.success());
    assert!(String::from_utf8_lossy(&corrupt.stderr).contains("hmux_recovery_journal_invalid"));
    assert_eq!(snapshot(root.path()), before);
}
