#![cfg(unix)]

use hmux_client::recovery_journal::{
    PreparedRecoveryIdentity, RecoveryCompletion, RecoveryJournalGcPolicy,
    RecoveryReservationState, garbage_collect_completed_action, reserve_prepared,
};
use hmux_client::{
    MANAGED_REHOST_RECOVERY_ACTION, MANAGED_REHOST_RECOVERY_ID_PREFIX,
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt, ManagedStopOutcome,
    ManagedStopReceipt, ManagedStopRequest, PermissionMode,
};
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::Duration;

#[test]
fn cli_projects_retry_and_resolved_generations_without_an_app() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    std::fs::create_dir(&discovery_root).unwrap();
    std::fs::set_permissions(&discovery_root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let operation_id = "daemonless-resolution-operation";
    let identity = PreparedRecoveryIdentity {
        recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{operation_id}"),
        source_session_id: "source-session".into(),
        source_workspace_id: "workspace-1".into(),
        action: MANAGED_REHOST_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    };
    let RecoveryReservationState::Pending(mut reservation) = reserve_prepared(
        &discovery_root,
        identity,
        Some(
            serde_json::json!({
                "launchReference": "credential+profile",
                "conversationId": "conversation-final"
            })
            .to_string(),
        ),
    )
    .unwrap() else {
        panic!("new resolution fixture unexpectedly replayed")
    };

    let pending = run_resolution(&discovery_root);
    assert_eq!(pending["state"], "retry_required");
    assert_eq!(pending["code"], "hmux_managed_rehost_retry_required");
    assert_eq!(pending["operationId"], operation_id);

    let source_request = ManagedStopRequest::new("rehost-stop", "source-session", "workspace-1")
        .unwrap()
        .with_expected_fence(
            "principal-source",
            "runner-source",
            u64::MAX,
            "host-source",
            "terminal-source",
        )
        .unwrap();
    let source = ManagedStopReceipt::from_request(
        &source_request,
        ManagedStopOutcome::Stopped,
        "managed source stopped",
    )
    .unwrap();
    let replacement = ManagedCreateReceipt::new(
        "replacement-create",
        "replacement-session",
        "workspace-1",
        "codex",
        PermissionMode::BypassApprovals,
        &discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            "principal-replacement",
            "runner-replacement",
            u64::MAX,
            "host-replacement",
            "terminal-replacement",
        )
        .unwrap(),
    )
    .unwrap();
    reservation
        .checkpoint_source_stop_receipt(serde_json::to_string(&source).unwrap())
        .unwrap();
    reservation
        .checkpoint_replacement_receipt(serde_json::to_string(&replacement).unwrap())
        .unwrap();
    reservation
        .complete(RecoveryCompletion {
            target_session_id: "replacement-session".into(),
            target_workspace_id: "workspace-1".into(),
            target_build_id: "build-1".into(),
            action: MANAGED_REHOST_RECOVERY_ACTION.into(),
            outcome: "rehosted".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    drop(reservation);

    // Model a process death after the completed journal record became durable
    // but before its compacted edge could be retained. The journal remains the
    // repair authority and GC must rebuild the index before retiring it.
    let successor_index = discovery_root.join(".managed-rehost-successors-v1");
    assert!(successor_index.is_dir());
    std::fs::remove_dir_all(&successor_index).unwrap();

    let resolved = run_resolution(&discovery_root);
    assert_eq!(resolved["schema"], "hmux-managed-rehost-resolution-v1");
    assert_eq!(resolved["schemaVersion"], 1);
    assert_eq!(resolved["state"], "resolved");
    assert_eq!(resolved["operationIds"], serde_json::json!([operation_id]));
    assert_eq!(
        resolved["sourceGeneration"]["channelEpoch"],
        "18446744073709551615"
    );
    assert_eq!(
        resolved["currentGeneration"]["channelEpoch"],
        "18446744073709551615"
    );
    assert_eq!(
        resolved["currentGeneration"]["sessionId"],
        "replacement-session"
    );
    assert_eq!(
        resolved["launchIdentity"],
        serde_json::json!({
            "launchReference": "credential+profile",
            "conversationId": "conversation-final"
        })
    );

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
    assert_eq!(gc.removed_completed_records, 1);
    assert_eq!(run_resolution(&discovery_root), resolved);
}

fn run_resolution(discovery_root: &std::path::Path) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_hmux"))
        .args([
            "--json",
            "--discovery-root",
            discovery_root.to_str().unwrap(),
            "managed-rehost-resolve",
            "--session",
            "source-session",
            "--workspace",
            "workspace-1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "hmux failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
