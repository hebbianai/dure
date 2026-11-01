use super::*;
use hmux_client::recovery_journal::{
    ManagedRehostResolutionLookup, PreparedRecoveryIdentity, RecoveryReservationState,
    reserve_prepared, resolve_managed_rehost_current,
};
use hmux_client::{MANAGED_REHOST_RECOVERY_ACTION, MANAGED_REHOST_RECOVERY_ID_PREFIX};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};

const OPERATION_ID: &str =
    "recovery4_0123456789abcdef_0000000000000000000000000000000000000000000000000000000000000000";
const SOURCE_SESSION: &str = "runtime-native-fixture-source";
const WORKSPACE: &str = "workspace-fixture";

struct ScriptedResumer {
    outcome: Result<(), ResumeFailure>,
    calls: AtomicUsize,
}

impl ScriptedResumer {
    fn new(outcome: Result<(), ResumeFailure>) -> Arc<Self> {
        Arc::new(Self {
            outcome,
            calls: AtomicUsize::new(0),
        })
    }

    fn refusing(code: &str) -> Arc<Self> {
        Self::new(Err(ResumeFailure {
            code: code.into(),
            message: format!("{code}: fixture refusal"),
        }))
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl PendingRehostResumer for ScriptedResumer {
    fn resume(&self, operation: &PendingManagedRehostOperation) -> Result<(), ResumeFailure> {
        assert_eq!(operation.operation_id, OPERATION_ID);
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.outcome.clone()
    }
}

fn discovery_root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    root
}

/// Reserve the operation the way `hmux managed-rehost` does, then let the
/// executing process die before (or just after) its first checkpoint.
fn strand(root: &Path, stop_receipt_checkpointed: bool) {
    let RecoveryReservationState::Pending(mut reservation) = reserve_prepared(
        root,
        PreparedRecoveryIdentity {
            recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{OPERATION_ID}"),
            source_session_id: SOURCE_SESSION.into(),
            source_workspace_id: WORKSPACE.into(),
            action: MANAGED_REHOST_RECOVERY_ACTION,
            legacy_request_fingerprint: None,
        },
        Some(
            json!({
                "request": {
                    "schema": "managed-session-replacement-v5",
                    "operationId": OPERATION_ID,
                    "confirmed": true,
                },
                "conversationId": "00000000-0000-4000-8000-000000000000",
                "launchReference": "fixture-launch",
            })
            .to_string(),
        ),
    )
    .unwrap() else {
        panic!("a fresh rehost fixture must be pending")
    };
    if stop_receipt_checkpointed {
        reservation
            .checkpoint_source_stop_receipt(json!({ "kind": "managed_stop_fixture" }).to_string())
            .unwrap();
    }
}

fn resolution(root: &Path) -> ManagedRehostResolutionLookup {
    resolve_managed_rehost_current(root, WORKSPACE, SOURCE_SESSION).unwrap()
}

fn pending(root: &Path) -> usize {
    pending_managed_rehost_operations(root).unwrap().len()
}

async fn sweep_now(root: &Path, resumer: Arc<ScriptedResumer>) -> SweepReport {
    sweep(root.to_path_buf(), resumer, Duration::ZERO)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_refused_resume_expires_an_operation_that_never_started() {
    let root = discovery_root();
    strand(root.path(), false);
    assert!(matches!(
        resolution(root.path()),
        ManagedRehostResolutionLookup::RetryRequired { .. }
    ));
    let resumer = ScriptedResumer::refusing("hmux_managed_rehost_unavailable");

    let report = sweep_now(root.path(), Arc::clone(&resumer)).await;

    assert_eq!(resumer.calls(), 1, "resumption is always attempted first");
    assert_eq!(
        report,
        SweepReport {
            expired: 1,
            ..SweepReport::default()
        }
    );
    assert!(matches!(
        resolution(root.path()),
        ManagedRehostResolutionLookup::NotFound
    ));
    assert_eq!(pending(root.path()), 0);
    assert_eq!(
        sweep_now(root.path(), Arc::clone(&resumer)).await,
        SweepReport::default()
    );
    assert_eq!(resumer.calls(), 1);
}

#[tokio::test]
async fn attempt_scoped_failures_keep_the_operation_for_the_next_sweep() {
    for code in [
        "hmux_recovery_busy",
        "hmux_managed_runtime_failed",
        "hmux_managed_rehost_protocol",
        "hmux_managed_rehost_outcome_unknown",
    ] {
        let root = discovery_root();
        strand(root.path(), false);

        let report = sweep_now(root.path(), ScriptedResumer::refusing(code)).await;

        assert_eq!(
            report,
            SweepReport {
                retained: 1,
                ..SweepReport::default()
            },
            "{code}"
        );
        assert_eq!(pending(root.path()), 1, "{code}");
        assert!(
            matches!(
                resolution(root.path()),
                ManagedRehostResolutionLookup::RetryRequired { .. }
            ),
            "{code}"
        );
    }
}

#[tokio::test]
async fn recorded_progress_is_never_expired() {
    let root = discovery_root();
    strand(root.path(), true);

    let report = sweep_now(
        root.path(),
        ScriptedResumer::refusing("hmux_managed_rehost_source_changed"),
    )
    .await;

    assert_eq!(
        report,
        SweepReport {
            retained: 1,
            ..SweepReport::default()
        }
    );
    assert_eq!(pending(root.path()), 1);
}

#[tokio::test]
async fn young_reservations_stay_with_the_client_that_admitted_them() {
    let root = discovery_root();
    strand(root.path(), false);
    let resumer = ScriptedResumer::refusing("hmux_managed_rehost_source_changed");

    let report = sweep(
        root.path().to_path_buf(),
        Arc::clone(&resumer) as Arc<dyn PendingRehostResumer>,
        Duration::from_secs(60 * 60),
    )
    .await
    .unwrap();

    assert_eq!(resumer.calls(), 0);
    assert_eq!(
        report,
        SweepReport {
            deferred: 1,
            ..SweepReport::default()
        }
    );
    assert_eq!(pending(root.path()), 1);
}

#[tokio::test]
async fn a_resumed_or_vanished_operation_is_finished_without_expiry() {
    for outcome in [
        Ok(()),
        Err(ResumeFailure {
            code: "hmux_managed_rehost_intent_not_found".into(),
            message: "fixture".into(),
        }),
    ] {
        let root = discovery_root();
        strand(root.path(), false);

        let report = sweep_now(root.path(), ScriptedResumer::new(outcome)).await;

        assert_eq!(
            report,
            SweepReport {
                resumed: 1,
                ..SweepReport::default()
            }
        );
        // The scripted resumer wrote no receipt; the sweep itself never
        // removes a record that it did not prove refused.
        assert_eq!(pending(root.path()), 1);
    }
}

#[tokio::test]
async fn an_empty_or_missing_journal_is_a_quiet_sweep() {
    let root = discovery_root();
    let resumer = ScriptedResumer::refusing("hmux_managed_rehost_source_changed");

    assert_eq!(
        sweep_now(root.path(), Arc::clone(&resumer)).await,
        SweepReport::default()
    );
    assert_eq!(resumer.calls(), 0);
}

#[test]
fn disposition_forfeits_only_refusals_of_the_journaled_intent() {
    assert_eq!(disposition(&Ok(())), Disposition::Finished);
    let failure = |code: &str| {
        Err(ResumeFailure {
            code: code.into(),
            message: String::new(),
        })
    };
    assert_eq!(
        disposition(&failure("hmux_managed_rehost_intent_not_found")),
        Disposition::Finished
    );
    for code in [
        "hmux_recovery_busy",
        "hmux_managed_runtime_failed",
        "hmux_managed_rehost_protocol",
        "hmux_managed_rehost_outcome_unknown",
        "hmux_recovery_journal_invalid",
    ] {
        assert_eq!(disposition(&failure(code)), Disposition::Retry, "{code}");
    }
    for code in [
        "hmux_managed_rehost_unavailable",
        "hmux_managed_rehost_source_changed",
        "hmux_managed_rehost_identity_mismatch",
        "hmux_managed_rehost_conversation_required",
        "hmux_managed_rehost_recipe_missing",
        "hmux_managed_rehost_request_invalid",
        "hmux_managed_rehost_refused",
    ] {
        assert_eq!(disposition(&failure(code)), Disposition::Expire, "{code}");
    }
}
