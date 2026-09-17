use super::*;
use crate::recovery_journal::managed_create_ledger::{
    ManagedCreateReconcileLedgerState, claim_successor_chain_cleanup, reconcile_identity,
};
use hmux_runtime_contract::{ManagedCreateReconcileRequest, PermissionMode};

fn request(key: &str, session: &str) -> ManagedCreateRequest {
    ManagedCreateRequest::new(
        key,
        session,
        "workspace-prepared",
        "test-provider",
        PermissionMode::Default,
        "/tmp",
        vec!["sleep".into(), "60".into()],
        24,
        80,
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("test-provider", "conversation-prepared").unwrap(),
    )
    .unwrap()
}

#[test]
fn preparation_preserves_the_live_writer_and_execution_still_requires_it() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let source = request("create-source", "session-source");
    let target = request("create-target", "session-target");
    let ManagedCreateLedgerState::Prepared(mut source_owner) =
        reserve_request(&root, &source, ManagedCreateLineageAdmission::Root).unwrap()
    else {
        panic!("source must own the writer");
    };

    prepare_root_request(&root, &target).unwrap();
    prepare_root_request(&root, &target).unwrap();
    assert!(matches!(
        reserve_request(&root, &target, ManagedCreateLineageAdmission::Root),
        Err(ManagedCreateAdmissionError::ConversationWriterConflict { owner_session_id, .. })
            if owner_session_id == source.session_id()
    ));
    let identity = ManagedCreateReconcileRequest::new(
        target.idempotency_key(),
        target.session_id(),
        target.workspace_id(),
    )
    .unwrap();
    assert!(matches!(
        reconcile_identity(&root, &identity).unwrap(),
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_)
    ));

    // This unit fixture has never spawned a Host. End only its own writer.
    source_owner.checkpoint_pre_spawn_absence().unwrap();
    source_owner.abandon_before_completion().unwrap();
    assert!(matches!(
        reserve_request(&root, &target, ManagedCreateLineageAdmission::Root).unwrap(),
        ManagedCreateLedgerState::Prepared(_)
    ));
    assert!(matches!(
        reserve_request(&root, &request("create-third", "session-third"), ManagedCreateLineageAdmission::Root),
        Err(ManagedCreateAdmissionError::ConversationWriterConflict { owner_session_id, .. })
            if owner_session_id == target.session_id()
    ));
}

#[test]
fn prepared_identity_keeps_immutable_policy_and_close_authority() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let original = request("create-target", "session-target");
    prepare_root_request(&root, &original).unwrap();
    let changed = ManagedCreateRequest::new(
        "create-target",
        "session-target",
        "workspace-prepared",
        "test-provider",
        PermissionMode::Default,
        "/tmp",
        vec!["sleep".into(), "61".into()],
        24,
        80,
    )
    .unwrap()
    .with_conversation_identity(original.conversation_identity().unwrap().clone())
    .unwrap();
    assert!(matches!(
        prepare_root_request(&root, &changed),
        Err(ManagedCreateAdmissionError::CanonicalRequestDigestConflict)
    ));
    let identity = ManagedCreateReconcileRequest::new(
        original.idempotency_key(),
        original.session_id(),
        original.workspace_id(),
    )
    .unwrap();
    claim_successor_chain_cleanup(&root, &identity).unwrap();
    assert!(matches!(
        prepare_root_request(&root, &original),
        Err(ManagedCreateAdmissionError::GenerationRetiredExact)
    ));
}
