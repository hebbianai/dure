use super::*;
use crate::recovery_journal::{
    RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE, RecoveryIdentity, RecoveryReservationState,
    STANDALONE_CREATE_OPERATION_RECOVERY_ACTION, request_fingerprint, reserve,
};
use crate::{
    SessionRetirementPolicy, StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity,
    TerminalDefaultColors, TerminalEnvironment,
};
use std::path::Path;

fn identity() -> RecoveryIdentity {
    RecoveryIdentity {
        recovery_id: "test-standalone-creation".into(),
        source_session_id: "operation".into(),
        source_workspace_id: "create-operation".into(),
        request_fingerprint: request_fingerprint(&["immutable-client-request"]),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    }
}

fn pending(root: &Path) -> RecoveryReservation {
    let RecoveryReservationState::Pending(reservation) = reserve(root, identity()).unwrap() else {
        panic!("test operation must remain pending");
    };
    reservation
}

fn request(root: &Path) -> StandaloneCreateRequest {
    StandaloneCreateRequest::new(
        root,
        Some("terminal".into()),
        vec!["/bin/sh".into()],
        24,
        80,
    )
    .unwrap()
    .with_terminal_environment(
        TerminalEnvironment::new(
            [
                ("TERM".into(), Some("xterm-256color".into())),
                ("NO_COLOR".into(), None),
            ]
            .into(),
        )
        .unwrap(),
    )
    .unwrap()
    .with_terminal_default_colors(TerminalDefaultColors::new(0x123456, 0x654321).unwrap())
    .unwrap()
    .with_retirement_policy(
        SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
            grace_period_ms: 10_000,
        },
    )
    .unwrap()
    .with_recovery_identity(
        StandaloneRecoveryCreateIdentity::new("standalone_target", "private-test-proof")
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
    )
    .unwrap()
}

#[test]
fn replay_preserves_the_full_request_without_preparing_again() {
    let root = tempfile::tempdir().unwrap();
    let expected = request(root.path());
    let mut reservation = pending(root.path());
    let first = load_or_prepare(&mut reservation, || {
        PreparedStandaloneCreate::new(expected.clone())
    })
    .unwrap();
    assert_eq!(first, expected);
    assert_eq!(
        reservation
            .operation_checkpoint()
            .unwrap()
            .canonical_payload,
        serde_json::to_string(&expected).unwrap(),
    );
    let replacement_receipt = r#"{"targetSessionId":"standalone_target"}"#;
    reservation
        .checkpoint_replacement_receipt(replacement_receipt.into())
        .unwrap();
    drop(reservation);

    let mut reopened = pending(root.path());
    let replayed = load_or_prepare(&mut reopened, || {
        panic!("replay must use the saved request")
    })
    .unwrap();
    assert_eq!(replayed, expected);
    assert_eq!(
        reopened
            .operation_checkpoint()
            .unwrap()
            .replacement_receipt
            .as_deref(),
        Some(replacement_receipt),
    );
}

#[test]
fn invalid_saved_request_is_not_replaced_by_new_preparation() {
    let root = tempfile::tempdir().unwrap();
    let mut reservation = pending(root.path());
    reservation
        .prepare_operation_payload(RecoveryOperationPayload::new("{}".into()).unwrap())
        .unwrap();
    drop(reservation);
    let mut reopened = pending(root.path());
    let error = load_or_prepare(&mut reopened, || {
        panic!("an invalid record must remain intact")
    })
    .unwrap_err();
    assert_eq!(error, "saved standalone create request is malformed");
    assert_eq!(
        reopened.operation_checkpoint().unwrap().canonical_payload,
        "{}"
    );
}

#[test]
fn unavailable_completion_capacity_leaves_the_request_unprepared() {
    let root = tempfile::tempdir().unwrap();
    let mut reservation = pending(root.path());
    let completion = RecoveryCompletion {
        target_session_id: "standalone_target".into(),
        target_workspace_id: "workspace".into(),
        target_build_id: "test-build".into(),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION.into(),
        outcome: "created".into(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    };
    let replacement_receipt = serde_json::to_string(&"\\".repeat(16_382)).unwrap();
    let prepared = PreparedStandaloneCreate::new(request(root.path()))
        .unwrap()
        .with_completion_capacity(completion, replacement_receipt);
    let error = load_or_prepare(&mut reservation, || Ok(prepared)).unwrap_err();
    assert_eq!(error, RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE);
    assert!(reservation.operation_checkpoint().is_none());
    drop(reservation);
    assert!(pending(root.path()).operation_checkpoint().is_none());
}
