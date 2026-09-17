use super::*;

#[tokio::test]
async fn completed_native_rehost_publication_never_invokes_recovery() {
    publication_never_invokes_recovery(false, None).await;
}

#[tokio::test]
async fn completed_native_rehost_publishes_by_operation_identity() {
    publication_never_invokes_recovery(true, None).await;
}

#[tokio::test]
async fn operation_publication_resolves_the_recorded_credential_without_a_client_hint() {
    publication_never_invokes_recovery(true, Some("codex-account-b")).await;
    publication_never_invokes_recovery(true, Some("missing-profile")).await;
}

async fn publication_never_invokes_recovery(by_operation: bool, launch_reference: Option<&str>) {
    let agent_id = AgentIdV1::new("publication-observation-agent").unwrap();
    let (root, mut state, launcher, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        Vec::new(),
        Vec::new(),
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            conversation_id: Some("conversation-1".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    if launch_reference == Some("codex-account-b") {
        let accounts = root.path().join("accounts");
        fs::create_dir(&accounts).unwrap();
        fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
        let directory = accounts.join("codex-account-b");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        state
            .credential_profiles
            .register(
                provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                    schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                    provider_id: "codex".into(),
                    reference_id: "account-b".into(),
                    profile_directory_name: "codex-account-b".into(),
                },
            )
            .await
            .unwrap();
    }
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let request = hmux_client::ManagedRehostRequest::new(
        "publication-observation-operation",
        "coordinator-session",
        "coordinator-workspace",
        "coordinator-runner",
        "coordinator-instance",
        1,
        "coordinator-host",
        "coordinator-terminal",
        true,
    )
    .unwrap();
    let stop = hmux_client::ManagedStopReceipt::from_request(
        request.source(),
        hmux_client::ManagedStopOutcome::Stopped,
        "fixture source stopped",
    )
    .unwrap();
    let replacement = hmux_client::ManagedCreateReceipt::new(
        "publication-observation-create",
        "publication-observation-target",
        "coordinator-workspace",
        "codex",
        hmux_client::PermissionMode::Default,
        &state.hmux_identity.discovery_root,
        hmux_client::ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        hmux_client::ManagedCreateGenerationFence::new(
            "target-runner",
            "target-instance",
            2,
            "target-host",
            "target-terminal",
        )
        .unwrap(),
    )
    .unwrap();
    let receipt = hmux_client::ManagedRehostReceipt::new(
        &request,
        stop,
        replacement,
        "conversation-1",
        launch_reference.map(str::to_owned),
        false,
    )
    .unwrap();
    record_completion(&state.hmux_identity.discovery_root, &request, &receipt);
    let resolution = hmux_client::ManagedRehostResolution::from_receipts(
        request.operation_id(),
        receipt.source_stop_receipt(),
        receipt.replacement_receipt(),
    )
    .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("rehost-resolution.json"),
        serde_json::to_vec(&resolution).unwrap(),
    )
    .unwrap();
    let target: WorkflowSessionGenerationV1 = serde_json::from_value(json!({
        "sessionId": "publication-observation-target", "workspaceId": "coordinator-workspace",
        "providerId": "codex", "runnerPrincipal": "target-runner", "runnerInstance": "target-instance",
        "channelEpoch": "2", "hostInstanceId": "target-host", "terminalEpoch": "target-terminal",
    })).unwrap();
    write_ready_hmux_session(&state, &target, "conversation-1");
    let called = root.path().join("recovery-invoked");
    let runtime = state.hmux_identity.runtime_executable_path.clone();
    fs::write(
        &runtime,
        format!(
            "#!/bin/sh\nprintf invoked > '{}'\nexit 91\n",
            called.display()
        ),
    )
    .unwrap();
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &runtime,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    let body = json!({
        "schemaVersion": 1, "agentId": agent_id, "operationId": request.operation_id(),
        "providerId": "codex", "targetCredential": { "kind": "provider_default" },
        "source": resolution.source_generation(), "target": resolution.current_generation(),
    });
    let body = if by_operation {
        json!({
            "schemaVersion": 1, "agentId": agent_id, "operationId": request.operation_id(),
            "sourceSessionId": request.source().session_id(),
            "sourceWorkspaceId": request.source().workspace_id(),
        })
    } else {
        body
    };
    if by_operation {
        for (field, value) in [
            ("operationId", json!("missing-operation")),
            ("sourceSessionId", json!("wrong-source")),
            ("sourceWorkspaceId", json!("wrong-workspace")),
            ("targetCredential", json!({ "kind": "provider_default" })),
        ] {
            let mut wrong = body.clone();
            wrong[field] = value;
            assert!(
                dispatch(&state, &native_rehost_request(&state, wrong))
                    .await
                    .is_err()
            );
        }
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&agent_id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert!(!called.exists());
    }
    let result = dispatch(&state, &native_rehost_request(&state, body.clone())).await;
    assert!(
        !called.exists(),
        "publishing a completed binding invoked runtime recovery: {result:?}"
    );
    if launch_reference == Some("missing-profile") {
        let error = result.unwrap_err();
        assert_eq!(error.code, "agent_runtime_native_rehost_conflict");
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&agent_id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert!(launcher.requests().is_empty());
        return;
    }
    let first = result.unwrap();
    assert_eq!(first["receipt"]["selectionRevision"], 2);
    if launch_reference.is_some() {
        assert_eq!(
            first["receipt"]["executionProfile"]["reference_id"],
            "account-b"
        );
    }
    assert_eq!(
        first["receipt"]["authority"]["authority"]["binding"]["sessionId"],
        target.session_id
    );
    let replay = dispatch(&state, &native_rehost_request(&state, body))
        .await
        .unwrap();
    assert_eq!(first, replay);
    assert!(!called.exists());
    assert!(launcher.requests().is_empty());
}
