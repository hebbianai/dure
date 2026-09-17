use super::*;
use crate::recovery_journal::RecoveryOperationCheckpoint;

#[test]
fn terminal_outcomes_preserve_exact_target_and_checkpoint_posture() {
    for error in [
        "hmux_standalone_recovery_target_exited",
        "hmux_standalone_recovery_identity_conflict",
        "hmux_standalone_recovery_name_conflict",
        "hmux_standalone_recipe_conflict",
    ] {
        let mut failed = completion("target", "namespace", error);
        assert!(code(&failed, "target", "namespace").is_err());
        failed.operation_checkpoint = Some(RecoveryOperationCheckpoint {
            canonical_payload: "{}".into(),
            source_stop_receipt: None,
            replacement_receipt: None,
        });
        assert_eq!(code(&failed, "target", "namespace").unwrap(), Some(error));
        assert!(code(&failed, "other-target", "namespace").is_err());
        assert!(code(&failed, "target", "other-namespace").is_err());
        failed
            .operation_checkpoint
            .as_mut()
            .unwrap()
            .replacement_receipt = Some("{}".into());
        assert!(code(&failed, "target", "namespace").is_err());
    }
    let invalid = completion("target", "namespace", INVALID_OPERATION);
    assert_eq!(
        code(&invalid, "target", "namespace").unwrap(),
        Some(INVALID_OPERATION)
    );
    let mut created = invalid;
    created.outcome = "created".into();
    assert_eq!(code(&created, "target", "namespace").unwrap(), None);
}
