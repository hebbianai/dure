use super::*;

fn retry_exited_replacement(change_policy: bool, completed_operation: bool) {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let hold_open = state.path().join("hold-open");
    fs::write(&hold_open, b"1").unwrap();
    let request = ManagedCreateRequest::new(
        "resume-exited-create",
        "resume-exited-session",
        "resume-exited-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            FIXTURE_STATE_DIR_ENV.into(),
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "resume-exited-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let _source = completed_operation.then(|| creator.create(request.clone()).unwrap());
    let ManagedCreateAdvanceResolution::Advanced(first) = creator
        .replace_current_and_advance(request.clone())
        .expect("the first exact Resume must launch its target")
    else {
        panic!("first Resume did not return Advanced")
    };
    fs::remove_file(&hold_open).unwrap();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        first.receipt().session_id(),
    );
    fs::write(&hold_open, b"1").unwrap();

    let request = if change_policy {
        let mut changed = serde_json::to_value(&request).unwrap();
        changed["permissionMode"] = serde_json::json!("bypass_approvals");
        if completed_operation {
            changed["conversationIdentity"] = serde_json::Value::Null;
        }
        serde_json::from_value(changed).unwrap()
    } else {
        request
    };
    let ManagedCreateAdvanceResolution::Advanced(retried) = creator
        .replace_current_and_advance(request.clone())
        .expect("an exited replacement must advance, not retry the dead target forever")
    else {
        panic!("retry of an exited replacement did not return Advanced")
    };
    assert_ne!(retried.receipt().session_id(), first.receipt().session_id());
    assert_ne!(
        retried.receipt().generation_fence(),
        first.receipt().generation_fence()
    );
    assert_eq!(
        retried.session().descriptor().lifecycle,
        SessionLifecycle::Ready
    );
    assert_eq!(
        retried.receipt().permission_mode(),
        if change_policy {
            PermissionMode::BypassApprovals
        } else {
            PermissionMode::Default
        }
    );
    let identity = ManagedCreateReconcileRequest::new(
        retried.receipt().idempotency_key(),
        retried.receipt().session_id(),
        retried.receipt().workspace_id(),
    )
    .unwrap();
    let origin = managed_create_ledger::resolve_create_origin(&discovery_root, &identity).unwrap();
    assert_eq!(origin.session_id(), first.receipt().session_id());
    assert_eq!(origin.idempotency_key(), first.receipt().idempotency_key());
    let ManagedCreateAdvanceResolution::Advanced(replayed) = creator
        .replace_current_and_advance(request.clone())
        .expect("response-loss replay must converge on the living successor")
    else {
        panic!("successor replay did not return Advanced")
    };
    assert_eq!(
        replayed.receipt().session_id(),
        retried.receipt().session_id()
    );
    assert_eq!(
        replayed.receipt().generation_fence(),
        retried.receipt().generation_fence()
    );
    fs::remove_file(&hold_open).unwrap();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        retried.receipt().session_id(),
    );
}

#[test]
fn explicit_replace_current_advances_an_exited_target() {
    retry_exited_replacement(false, false);
}

#[test]
fn explicit_replace_current_does_not_adopt_an_exited_target_after_policy_drift() {
    retry_exited_replacement(true, false);
}

#[test]
fn completed_replace_current_advances_its_target_with_new_policy_without_conversation_hint() {
    retry_exited_replacement(true, true);
}
