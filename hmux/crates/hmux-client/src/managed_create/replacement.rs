use crate::recovery_journal::{
    managed_create_ledger::ManagedCreateAdmissionError, request_fingerprint,
};
use hmux_runtime_contract::ManagedCreateRequest;

/// One deterministic independent root for target-first replacement and its
/// resource preparation. Execution and retries must use this same identity.
pub fn managed_replacement_root_request(
    source_request: &ManagedCreateRequest,
) -> Result<ManagedCreateRequest, ManagedCreateAdmissionError> {
    let conversation = source_request.conversation_identity();
    let identity_seed = [
        source_request.workspace_id(),
        source_request.session_id(),
        source_request.idempotency_key(),
        source_request.provider_id(),
        conversation.map_or("", |identity| identity.provider_id()),
        conversation.map_or("", |identity| identity.conversation_id()),
    ];
    let session_digest = request_fingerprint(&[
        "managed-replace-current-root-session-v1",
        identity_seed[0],
        identity_seed[1],
        identity_seed[2],
        identity_seed[3],
        identity_seed[4],
        identity_seed[5],
    ]);
    let idempotency_digest = request_fingerprint(&[
        "managed-replace-current-root-create-v1",
        identity_seed[0],
        identity_seed[1],
        identity_seed[2],
        identity_seed[3],
        identity_seed[4],
        identity_seed[5],
    ]);
    source_request
        .clone()
        .retarget_identity(
            format!("create_{}", &idempotency_digest[..32]),
            format!("session_{}", &session_digest[..32]),
        )
        .map_err(|error| error.to_string().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_root_identity_matches_the_existing_native_receipt() {
        let source = ManagedCreateRequest::new(
            "create-resume-permit",
            "session-resume-permit",
            "managed-checkout-workspace",
            "test-provider",
            hmux_runtime_contract::PermissionMode::Default,
            "/tmp",
            vec!["sleep".into(), "60".into()],
            24,
            80,
        )
        .unwrap();
        let target = managed_replacement_root_request(&source).unwrap();
        assert_eq!(
            target.session_id(),
            "session_ee8569a4b73f505b29efa265f5e558cc"
        );
        assert_eq!(
            target.idempotency_key(),
            "create_7311c6cd5337b57ed913e5312b03c6af"
        );
    }
}
