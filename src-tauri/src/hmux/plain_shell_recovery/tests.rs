use super::*;
use crate::hmux::RecoveryExecutionKind;
use hmux_client::StandaloneCreateReceipt;
use std::os::unix::fs::PermissionsExt;

#[test]
fn exited_source_can_be_replaced_but_a_changed_generation_cannot() {
    assert!(probe_source_refusal(SessionProbeStatus::Exited).is_none());
    assert!(matches!(
        probe_source_refusal(SessionProbeStatus::GenerationChanged),
        Some(SourceRefusal::Changed)
    ));
}

#[test]
fn terminal_failure_is_durable_and_replayed() {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let request = RecoveryExecutionRequest {
        recovery_id: "recovery-terminal-failure".into(),
        require_socket_owner_absent: false,
        kind: RecoveryExecutionKind::PlainShell,
        session_id: "source-session".into(),
        workspace_id: "source-workspace".into(),
        expected_source_fence: None,
        expected_target_build_id: None,
        conversation_id: None,
        adapter_supports_explicit_resume: false,
        confirmed: true,
        managed_launch: None,
    };
    let identity = recovery::PreparedRecoveryIdentity {
        recovery_id: request.recovery_id.clone(),
        source_session_id: request.session_id.clone(),
        source_workspace_id: request.workspace_id.clone(),
        action: ACTION,
        legacy_request_fingerprint: None,
    };
    let recovery::RecoveryReservationState::Pending(mut reservation) =
        recovery::reserve_prepared(root.path(), identity.clone(), Some("{}".into())).unwrap()
    else {
        panic!("first reservation must be pending");
    };
    let first = complete_failure(
        &mut reservation,
        &request,
        None,
        "recovery_target_build_unavailable",
    )
    .unwrap();
    assert_eq!(first.outcome, "failed");
    assert_eq!(first.reason, Some("recovery_target_build_unavailable"));
    drop(reservation);

    let recovery::RecoveryReservationState::Completed(completion) =
        recovery::reserve_prepared(root.path(), identity.clone(), None).unwrap()
    else {
        panic!("terminal failure must replay as a completed receipt");
    };
    let replayed = completed::replay_completion(
        &LocalSessionCatalog::new(root.path()),
        &request,
        &identity,
        completion,
    )
    .unwrap();
    assert_eq!(replayed.outcome, "failed");
    assert!(replayed.replayed);
    assert_eq!(replayed.reason, Some("recovery_target_build_unavailable"));
}

#[test]
fn completed_replay_keeps_an_unknown_target_retryable_without_creating() {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let request = RecoveryExecutionRequest {
        recovery_id: "recovery-completed-missing-build".into(),
        require_socket_owner_absent: false,
        kind: RecoveryExecutionKind::PlainShell,
        session_id: "source-session".into(),
        workspace_id: "source-workspace".into(),
        expected_source_fence: None,
        expected_target_build_id: None,
        conversation_id: None,
        adapter_supports_explicit_resume: false,
        confirmed: true,
        managed_launch: None,
    };
    let predecessor = PresentationCheckpointPredecessor::new(
        &request.session_id,
        "local-user",
        "runner-source",
        1,
        "host-source",
        "terminal-source",
    )
    .unwrap();
    let target_identity =
        StandaloneRecoveryCreateIdentity::new("standalone_target01", "launch-proof")
            .unwrap()
            .with_source_predecessor(predecessor)
            .unwrap();
    let create_request = StandaloneCreateRequest::new(
        root.path(),
        Some("daily-driver".into()),
        vec!["/bin/sh".into()],
        24,
        80,
    )
    .unwrap()
    .with_recovery_identity(target_identity)
    .unwrap();
    let payload = PreparedPayload {
        recovery_id: request.recovery_id.clone(),
        source_session_id: request.session_id.clone(),
        source_workspace_id: request.workspace_id.clone(),
        source_runner_principal: "local-user".into(),
        source_runner_instance: "runner-source".into(),
        source_channel_epoch: "1".into(),
        source_host_instance_id: "host-source".into(),
        source_terminal_epoch: "terminal-source".into(),
        source_session_name: "daily-driver".into(),
        target_build_id: "0.1.4+missing.replay".into(),
        create_request,
        source_checkout: None,
    };
    let identity = recovery::PreparedRecoveryIdentity {
        recovery_id: request.recovery_id.clone(),
        source_session_id: request.session_id.clone(),
        source_workspace_id: request.workspace_id.clone(),
        action: ACTION,
        legacy_request_fingerprint: None,
    };
    let recovery::RecoveryReservationState::Pending(mut reservation) = recovery::reserve_prepared(
        root.path(),
        identity.clone(),
        Some(serde_json::to_string(&payload).unwrap()),
    )
    .unwrap() else {
        panic!("first reservation must be pending");
    };
    let receipt = StandaloneCreateReceipt::new(
        "standalone_target01",
        &request.workspace_id,
        "daily-driver",
        root.path(),
        "launch-proof",
    )
    .unwrap();
    reservation
        .checkpoint_replacement_receipt(serde_json::to_string(&receipt).unwrap())
        .unwrap();
    reservation
        .complete(recovery::RecoveryCompletion {
            target_session_id: "standalone_target01".into(),
            target_workspace_id: request.workspace_id.clone(),
            target_build_id: payload.target_build_id.clone(),
            action: ACTION.into(),
            outcome: "restored".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    drop(reservation);

    let recovery::RecoveryReservationState::Completed(completion) =
        recovery::reserve_prepared(root.path(), identity.clone(), None).unwrap()
    else {
        panic!("completed recovery must replay");
    };
    let error = completed::replay_completion(
        &LocalSessionCatalog::new(root.path()),
        &request,
        &identity,
        completion,
    )
    .unwrap_err();
    assert!(
        error.starts_with("hmux_standalone_recovery_target_unavailable:"),
        "unexpected error: {error}"
    );

    let recovery::RecoveryReservationState::Completed(persisted) =
        recovery::reserve_prepared(root.path(), identity, None).unwrap()
    else {
        panic!("retryable replay must leave the completed receipt intact");
    };
    assert_eq!(persisted.outcome, "restored");
}
