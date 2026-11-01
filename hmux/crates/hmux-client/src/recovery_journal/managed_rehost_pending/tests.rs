//! The fixture mirrors the shape of a `managed_rehost_exact_fence_v1` record
//! that a host reboot stranded in `reserved` (hebbianai/dure#309): a complete
//! `managed-session-replacement-v5` request, its rendered replacement and the
//! presentation handoff, with no stop or replacement receipt. Identifiers,
//! paths, credentials and commands are fixture values.

use super::*;
use crate::recovery_journal::tests::private_root;
use serde_json::json;

const OPERATION_ID: &str =
    "recovery4_0123456789abcdef_0000000000000000000000000000000000000000000000000000000000000000";
const SOURCE_SESSION: &str = "runtime-native-fixture-source";
const WORKSPACE: &str = "workspace-fixture";
const CONVERSATION: &str = "00000000-0000-4000-8000-000000000000";
const FIVE_MINUTES: Duration = Duration::from_secs(5 * 60);
const ELEVEN_HOURS_MS: u64 = 11 * 60 * 60 * 1_000;

fn identity() -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{OPERATION_ID}"),
        source_session_id: SOURCE_SESSION.into(),
        source_workspace_id: WORKSPACE.into(),
        action: MANAGED_REHOST_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    }
}

fn request() -> ManagedRehostReconcileRequest {
    ManagedRehostReconcileRequest::by_operation_identity(OPERATION_ID, SOURCE_SESSION, WORKSPACE)
        .unwrap()
}

fn stranded_payload() -> String {
    let environment = json!({
        "CLAUDE_CONFIG_DIR": "/fixture/provider-state",
        "ANTHROPIC_API_KEY": null,
    });
    let recipe = json!({
        "schema": "hmux-managed-rehost-recipe-v1",
        "schemaVersion": 1,
        "commandTemplate": ["/bin/sh", "-c", "exec provider --resume __HMUX_EXACT_CONVERSATION_ID__"],
        "launchReference": "fixture-launch",
    });
    json!({
        "request": {
            "schema": "managed-session-replacement-v5",
            "schemaVersion": 5,
            "operationId": OPERATION_ID,
            "source": {
                "schema": "hmux-managed-stop-v1",
                "schemaVersion": 3,
                "stopId": format!("managed_rehost_stop_{OPERATION_ID}"),
                "sessionId": SOURCE_SESSION,
                "workspaceId": WORKSPACE,
                "expectedRunnerPrincipal": "local-user",
                "expectedRunnerInstance": "runner_fixture",
                "expectedChannelEpoch": 1,
                "expectedHostInstanceId": "host_fixture",
                "expectedTerminalEpoch": "terminal_fixture",
            },
            "confirmed": true,
            "expectedProviderId": "claude",
            "expectedConversationId": CONVERSATION,
            "expectedTargetBuildId": "0.0.0+fixture",
            "replacement": {
                "providerId": "claude",
                "permissionMode": "bypass_approvals",
                "providerCwd": "/fixture/project",
                "initialRows": 30,
                "initialColumns": 120,
                "launchReference": "fixture-launch",
                "providerStateEnvironment": environment,
                "rehost": recipe,
            },
        },
        "replacement": {
            "schema": "hmux-managed-create-v6",
            "schemaVersion": 6,
            "idempotencyKey": "managed_rehost_00000000000000000000000000000000",
            "sessionId": "managed_rehost_00000000000000000000000000000000",
            "workspaceId": WORKSPACE,
            "providerId": "claude",
            "permissionMode": "bypass_approvals",
            "providerCwd": "/fixture/project",
            "command": ["/bin/sh", "-c", format!("exec provider --resume {CONVERSATION}")],
            "initialRows": 14,
            "initialColumns": 41,
            "providerStateEnvironment": environment,
            "presentationPredecessor": {
                "sessionId": SOURCE_SESSION,
                "runnerPrincipal": "local-user",
                "runnerInstance": "runner_fixture",
                "channelEpoch": 1,
                "hostInstanceId": "host_fixture",
                "terminalEpoch": "terminal_fixture",
            },
            "conversationIdentity": { "providerId": "claude", "conversationId": CONVERSATION },
            "requiredManagedStopRequestVersion": 5,
            "managedRehostRecipe": recipe,
        },
        "conversationId": CONVERSATION,
        "launchReference": "fixture-launch",
        "presentationHandoff": { "fileId": "fixture-handoff", "checkpointDigest": [228, 224] },
    })
    .to_string()
}

/// Reserve the operation and let its executor die before any checkpoint.
fn strand(root: &Path) -> RecoveryReservation {
    let RecoveryReservationState::Pending(reservation) =
        reserve_prepared(root, identity(), Some(stranded_payload())).unwrap()
    else {
        panic!("a fresh rehost fixture must be pending")
    };
    reservation
}

fn resolve(root: &Path) -> ManagedRehostResolutionLookup {
    resolve_managed_rehost_current(root, WORKSPACE, SOURCE_SESSION).unwrap()
}

fn expire_at(root: &Path, now_unix_ms: u64) -> ManagedRehostExpiry {
    expire_pending_managed_rehost_at(root, &request(), FIVE_MINUTES, now_unix_ms).unwrap()
}

#[test]
fn a_reboot_stranded_rehost_is_listed_and_fails_closed_until_expired() {
    let root = private_root();
    drop(strand(root.path()));

    let pending = pending_managed_rehost_operations(root.path()).unwrap();
    assert_eq!(pending.len(), 1);
    let operation = &pending[0];
    assert_eq!(operation.operation_id, OPERATION_ID);
    assert_eq!(operation.source_session_id, SOURCE_SESSION);
    assert_eq!(operation.source_workspace_id, WORKSPACE);
    assert!(!operation.progress_checkpointed);
    assert_eq!(operation.reconcile_request().unwrap(), request());
    assert!(matches!(
        resolve(root.path()),
        ManagedRehostResolutionLookup::RetryRequired { operation_id } if operation_id == OPERATION_ID
    ));

    // The client that admitted the operation still owns a young reservation.
    let young = operation.created_unix_ms + 1_000;
    assert_eq!(
        expire_at(root.path(), young),
        ManagedRehostExpiry::TooRecent
    );
    assert_eq!(
        pending_managed_rehost_operations(root.path())
            .unwrap()
            .len(),
        1
    );

    let stale = operation.created_unix_ms + ELEVEN_HOURS_MS;
    assert_eq!(expire_at(root.path(), stale), ManagedRehostExpiry::Expired);
    assert!(
        pending_managed_rehost_operations(root.path())
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        resolve(root.path()),
        ManagedRehostResolutionLookup::NotFound
    ));
    assert_eq!(
        expire_at(root.path(), stale),
        ManagedRehostExpiry::NotPending
    );
    let directory = root.path().join(".recovery");
    let operation_digest = digest(&identity().recovery_id);
    assert!(
        !directory
            .join(format!("operation_{operation_digest}.json"))
            .exists()
    );
    assert!(
        !directory
            .join(format!("operation_{operation_digest}.lock"))
            .exists()
    );
}

#[test]
fn expiry_frees_the_operation_identity_for_a_fresh_admission() {
    let root = private_root();
    drop(strand(root.path()));
    let created = pending_managed_rehost_operations(root.path()).unwrap()[0].created_unix_ms;
    assert_eq!(
        expire_at(root.path(), created + ELEVEN_HOURS_MS),
        ManagedRehostExpiry::Expired
    );

    // A changed payload would be an idempotency conflict against the stale
    // record. After expiry the client re-admits its exact operation id afresh.
    let readmitted =
        json!({ "request": { "operationId": OPERATION_ID }, "fresh": true }).to_string();
    let RecoveryReservationState::Pending(reservation) =
        reserve_prepared(root.path(), identity(), Some(readmitted.clone())).unwrap()
    else {
        panic!("an expired operation id must admit a fresh reservation")
    };
    assert!(!reservation.was_existing());
    assert_eq!(
        reservation
            .operation_checkpoint()
            .map(|checkpoint| checkpoint.canonical_payload.as_str()),
        Some(readmitted.as_str())
    );
}

#[test]
fn an_operation_that_recorded_progress_is_never_expired() {
    let root = private_root();
    let mut reservation = strand(root.path());
    reservation
        .checkpoint_source_stop_receipt(json!({ "kind": "managed_stop_fixture" }).to_string())
        .unwrap();
    drop(reservation);

    let pending = pending_managed_rehost_operations(root.path()).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(pending[0].progress_checkpointed);
    assert_eq!(
        expire_at(root.path(), pending[0].created_unix_ms + ELEVEN_HOURS_MS),
        ManagedRehostExpiry::ProgressCheckpointed
    );
    assert_eq!(
        pending_managed_rehost_operations(root.path()).unwrap(),
        pending
    );
    assert!(matches!(
        resolve(root.path()),
        ManagedRehostResolutionLookup::RetryRequired { .. }
    ));
}

#[test]
fn an_executing_operation_is_busy_not_expired() {
    let root = private_root();
    let reservation = strand(root.path());
    let created = pending_managed_rehost_operations(root.path()).unwrap()[0].created_unix_ms;

    assert_eq!(
        expire_at(root.path(), created + ELEVEN_HOURS_MS),
        ManagedRehostExpiry::Busy
    );
    assert_eq!(
        pending_managed_rehost_operations(root.path())
            .unwrap()
            .len(),
        1
    );

    drop(reservation);
    assert_eq!(
        expire_at(root.path(), created + ELEVEN_HOURS_MS),
        ManagedRehostExpiry::Expired
    );
}

#[test]
fn completed_and_unknown_operations_are_not_pending() {
    let root = private_root();
    assert!(
        pending_managed_rehost_operations(root.path())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        expire_at(root.path(), u64::MAX / 2),
        ManagedRehostExpiry::NotPending
    );

    let mut reservation = strand(root.path());
    reservation
        .complete(RecoveryCompletion {
            target_session_id: SOURCE_SESSION.into(),
            target_workspace_id: WORKSPACE.into(),
            target_build_id: "precondition".into(),
            action: MANAGED_REHOST_RECOVERY_ACTION.into(),
            outcome: "refused_precondition".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    drop(reservation);

    assert!(
        pending_managed_rehost_operations(root.path())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        expire_at(root.path(), u64::MAX / 2),
        ManagedRehostExpiry::NotPending
    );
    let directory = root.path().join(".recovery");
    assert!(
        directory
            .join(format!(
                "operation_{}.json",
                digest(&identity().recovery_id)
            ))
            .exists()
    );
}

#[test]
fn expiry_refuses_an_identity_that_names_another_source() {
    let root = private_root();
    drop(strand(root.path()));
    let other = ManagedRehostReconcileRequest::by_operation_identity(
        OPERATION_ID,
        "another-source",
        WORKSPACE,
    )
    .unwrap();

    let error = expire_pending_managed_rehost_at(root.path(), &other, FIVE_MINUTES, u64::MAX / 2)
        .unwrap_err();

    assert!(error.contains("belongs to another request"), "{error}");
    assert_eq!(
        pending_managed_rehost_operations(root.path())
            .unwrap()
            .len(),
        1
    );
}
