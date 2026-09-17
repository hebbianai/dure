use super::*;
use hmux_client::recovery_journal::{
    PreparedRecoveryIdentity, RecoveryCompletion, RecoveryOperationCheckpoint,
    RecoveryReservationState, request_fingerprint, reserve_prepared,
};
use hmux_client::{
    MANAGED_REHOST_RECOVERY_ACTION, MANAGED_REHOST_RECOVERY_ID_PREFIX, ManagedRehostReceipt,
    ManagedRehostRequest,
};
use sha2::{Digest, Sha256};

pub(super) struct RecordedCompletion {
    path: PathBuf,
    original: Vec<u8>,
}

fn checkpoint(
    request: &ManagedRehostRequest,
    receipt: &ManagedRehostReceipt,
) -> RecoveryOperationCheckpoint {
    RecoveryOperationCheckpoint {
        canonical_payload: json!({
            "request": request,
            "conversationId": receipt.conversation_id(),
            "launchReference": receipt.launch_reference(),
        })
        .to_string(),
        source_stop_receipt: Some(serde_json::to_string(receipt.source_stop_receipt()).unwrap()),
        replacement_receipt: Some(serde_json::to_string(receipt.replacement_receipt()).unwrap()),
    }
}

pub(super) fn record_completion(
    discovery: &std::path::Path,
    request: &ManagedRehostRequest,
    receipt: &ManagedRehostReceipt,
) -> RecordedCompletion {
    let checkpoint = checkpoint(request, receipt);
    let recovery_id = format!(
        "{MANAGED_REHOST_RECOVERY_ID_PREFIX}{}",
        request.operation_id()
    );
    let path = discovery.join(".recovery").join(format!(
        "operation_{}.json",
        &format!("{:x}", Sha256::digest(recovery_id.as_bytes()))[..32]
    ));
    let RecoveryReservationState::Pending(mut reservation) = reserve_prepared(
        discovery,
        PreparedRecoveryIdentity {
            recovery_id,
            source_session_id: request.source().session_id().into(),
            source_workspace_id: request.source().workspace_id().into(),
            action: MANAGED_REHOST_RECOVERY_ACTION,
            legacy_request_fingerprint: None,
        },
        Some(checkpoint.canonical_payload.clone()),
    )
    .unwrap() else {
        panic!("fixture completion must be new")
    };
    reservation
        .checkpoint_source_stop_receipt(checkpoint.source_stop_receipt.clone().unwrap())
        .unwrap();
    reservation
        .checkpoint_replacement_receipt(checkpoint.replacement_receipt.clone().unwrap())
        .unwrap();
    reservation
        .complete(RecoveryCompletion {
            target_session_id: receipt.replacement_receipt().session_id().into(),
            target_workspace_id: receipt.replacement_receipt().workspace_id().into(),
            target_build_id: "fixture-build".into(),
            action: MANAGED_REHOST_RECOVERY_ACTION.into(),
            outcome: "rehosted".into(),
            resume_checkpoint: None,
            operation_checkpoint: Some(checkpoint),
        })
        .unwrap();
    RecordedCompletion {
        original: fs::read(&path).unwrap(),
        path,
    }
}

impl RecordedCompletion {
    // Fault injection changes only this fixture's exact receipt record. Native
    // production readers continue to own parsing and correlation checks.
    pub(super) fn replace(&self, request: &ManagedRehostRequest, receipt: &ManagedRehostReceipt) {
        let checkpoint = checkpoint(request, receipt);
        let mut record: Value = serde_json::from_slice(&self.original).unwrap();
        record["requestFingerprint"] = json!(request_fingerprint(&[&checkpoint.canonical_payload]));
        record["operation_checkpoint"] = serde_json::to_value(checkpoint).unwrap();
        fs::write(&self.path, serde_json::to_vec(&record).unwrap()).unwrap();
    }

    pub(super) fn restore(&self) {
        fs::write(&self.path, &self.original).unwrap();
    }
}
