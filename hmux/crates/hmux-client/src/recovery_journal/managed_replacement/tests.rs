use super::*;
use crate::recovery_journal::{RecoveryCompletion, RecoveryReservationState, reserve_prepared};
use hmux_runtime_contract::{PermissionMode, ProviderConversationIdentitySeed};

fn request(root: &Path) -> ManagedCreateRequest {
    ManagedCreateRequest::new(
        "create-replacement",
        "source",
        "workspace",
        "fixture",
        PermissionMode::Default,
        root,
        vec!["fixture-provider".into()],
        24,
        80,
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "original-conversation").unwrap(),
    )
    .unwrap()
}

fn prepare(root: &Path, request: &ManagedCreateRequest, completed: bool) {
    let stop = ManagedStopRequest::new("stop-source", request.session_id(), request.workspace_id())
        .unwrap()
        .with_expected_fence("runner", "instance", 1, "host", "epoch")
        .unwrap();
    let payload = serde_json::to_string(&PreparedReplacement {
        request: request.clone(),
        stop,
    })
    .unwrap();
    let RecoveryReservationState::Pending(mut operation) =
        reserve_prepared(root, identity(request), Some(payload)).unwrap()
    else {
        panic!("fixture must start pending")
    };
    if completed {
        let target = crate::managed_replacement_root_request(request).unwrap();
        operation
            .complete(RecoveryCompletion {
                target_session_id: target.session_id().into(),
                target_workspace_id: target.workspace_id().into(),
                target_build_id: "fixture-build".into(),
                action: ACTION.into(),
                outcome: "replaced".into(),
                resume_checkpoint: None,
                operation_checkpoint: operation.operation_checkpoint().cloned(),
            })
            .unwrap();
    }
}

fn drift(request: &ManagedCreateRequest) -> ManagedCreateRequest {
    let mut value = serde_json::to_value(request).unwrap();
    value["conversationIdentity"] = serde_json::Value::Null;
    value["permissionMode"] = serde_json::json!("bypass_approvals");
    serde_json::from_value(value).unwrap()
}

#[test]
fn pending_replay_preserves_all_inputs_but_completed_replay_keeps_only_identity() {
    for completed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let discovery = root.path().join("discovery");
        let original = request(&discovery);
        assert!(replay_request(&discovery, &original).unwrap().is_none());
        assert!(!discovery.exists());
        prepare(&discovery, &original, completed);
        let changed = drift(&original);
        let resolved = replay_request(&discovery, &changed).unwrap().unwrap();
        let expected = if completed {
            changed
                .with_conversation_identity(original.conversation_identity().unwrap().clone())
                .unwrap()
        } else {
            original.clone()
        };
        assert_eq!(resolved, expected);
        assert_eq!(
            crate::managed_replacement_root_request(&resolved)
                .unwrap()
                .session_id(),
            crate::managed_replacement_root_request(&original)
                .unwrap()
                .session_id(),
        );
    }
}

#[test]
fn completed_replay_cannot_retarget_an_existing_operation() {
    let root = tempfile::tempdir().unwrap();
    let discovery = root.path().join("discovery");
    let original = request(&discovery);
    prepare(&discovery, &original, true);
    let changed_conversation = original
        .clone()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new("fixture", "different-conversation").unwrap(),
        )
        .unwrap();
    assert!(replay_request(&discovery, &changed_conversation).is_err());
    let mut changed_provider = serde_json::to_value(drift(&original)).unwrap();
    changed_provider["providerId"] = serde_json::json!("another-provider");
    let changed_provider = serde_json::from_value(changed_provider).unwrap();
    assert!(replay_request(&discovery, &changed_provider).is_err());
    assert_eq!(
        replay_request(&discovery, &original).unwrap(),
        Some(original)
    );
}
