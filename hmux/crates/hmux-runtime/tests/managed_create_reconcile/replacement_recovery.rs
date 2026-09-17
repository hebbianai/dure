use super::*;

fn interrupted_replacement(shared_writer: bool, fault: Option<&str>) {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = state.path().canonicalize().unwrap();
    let hold = cwd.join("hold-open");
    fs::write(&hold, b"1").unwrap();
    let mut request = ManagedCreateRequest::new(
        "replacement-recovery-create",
        "replacement-recovery-session",
        "replacement-recovery-workspace",
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
            cwd.to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    if shared_writer {
        request = request
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new("fixture", "replacement-recovery").unwrap(),
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
            )
            .unwrap();
    }
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let source = creator.create(request.clone()).unwrap();
    let identity = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let cut = if let Some(fault) = fault {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"));
        command
            .arg("--no-autostart")
            .arg(MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND)
            .current_dir(&cwd)
            .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
            .env(
                if fault.starts_with("replacement_") {
                    "HMUX_TEST_MANAGED_CREATE_ADVANCE_FAULT"
                } else {
                    "HMUX_TEST_MANAGED_STOP_FAULT"
                },
                fault,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::null());
        let mut broker = command.spawn().unwrap();
        write_json_frame(
            broker.stdin.as_mut().unwrap(),
            &ManagedCreateAdvanceRequest::replace_current(request.clone()).unwrap(),
        )
        .unwrap();
        drop(broker.stdin.take());
        Some(broker.wait().unwrap())
    } else {
        assert!(matches!(
            creator
                .replace_current_and_advance(request.clone())
                .unwrap(),
            ManagedCreateAdvanceResolution::Advanced(_)
        ));
        None
    };
    let closed = managed_create_ledger::closed_retired_chain(&discovery_root, &identity).unwrap();
    let target = hmux_client::managed_replacement_root_request(&request).unwrap();
    let target_identity = ManagedCreateReconcileRequest::new(
        target.idempotency_key(),
        target.session_id(),
        target.workspace_id(),
    )
    .unwrap();
    let ready_before =
        managed_create_ledger::completed_generation_evidence(&discovery_root, &target_identity)
            .unwrap()
            .map(|evidence| evidence.receipt().generation_fence().cloned());

    // A reconnect carries identity, but no longer owns the interrupted launch
    // inputs. It must not substitute a new policy or lose the saved conversation.
    let mut drift = serde_json::to_value(&request).unwrap();
    drift["permissionMode"] = serde_json::json!("bypass_approvals");
    drift["conversationIdentity"] = serde_json::Value::Null;
    let retried = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .replace_current_and_advance(serde_json::from_value(drift).unwrap());
    let observed = retried
        .as_ref()
        .ok()
        .and_then(|resolution| match resolution {
            ManagedCreateAdvanceResolution::Advanced(target) => Some((
                target.receipt().permission_mode(),
                target.session().descriptor().lifecycle,
            )),
            _ => None,
        });
    let same_target = ready_before.as_ref().is_none_or(|expected| {
        matches!(&retried, Ok(ManagedCreateAdvanceResolution::Advanced(target))
            if target.receipt().generation_fence() == expected.as_ref())
    });
    fs::remove_file(hold).unwrap();
    if let Ok(ManagedCreateAdvanceResolution::Advanced(target)) = &retried {
        wait_for_exited(
            &discovery_root,
            request.workspace_id(),
            target.receipt().session_id(),
        );
    }
    drop(source);
    assert_eq!(
        cut.map(|status| status.code()),
        fault.map(|_| Some(86)),
        "the exact runtime checkpoint was not reached"
    );
    assert!(
        closed.is_some(),
        "replacement retirement lost its logical-close intent"
    );
    assert!(same_target, "reconnect replaced the already-ready target");
    assert_eq!(
        observed,
        Some((PermissionMode::Default, SessionLifecycle::Ready)),
        "interrupted replacement did not resume its durable inputs: {retried:?}"
    );
}

#[test]
fn explicit_replace_current_recovers_after_target_ready_and_source_retirement() {
    interrupted_replacement(false, Some("after_create_ledger_retirement"));
}

#[test]
fn explicit_replace_current_recovers_before_target_launch_without_conversation_hint() {
    interrupted_replacement(true, Some("after_create_ledger_retirement"));
}

#[test]
fn explicit_replace_current_reuses_ready_target_before_replacement_completion() {
    interrupted_replacement(
        true,
        Some("replacement_after_target_ready_before_completion"),
    );
}

#[test]
fn explicit_replace_current_replays_completed_target_without_conversation_hint() {
    interrupted_replacement(true, None);
}
