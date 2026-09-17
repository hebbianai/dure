use super::*;

#[derive(Clone, Copy)]
enum ResumeFault {
    Timeout,
    Malformed,
    Publication,
}

async fn assert_same_target_recovery(fault: ResumeFault) {
    let agent_id = AgentIdV1::new("native-resume-observation-agent").unwrap();
    let (root, mut state, launcher, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        Vec::new(),
        Vec::new(),
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            conversation_id: Some("conversation-observation".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let source_selection = AgentRuntimeSelectionV1 {
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
    };
    state
        .store
        .initialize_agent_runtime_selection(&source_selection)
        .await
        .unwrap();
    let source_authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "native-resume-observation-target".into(),
        workspace_id: "coordinator-workspace".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: "resume-runner".into(),
        runner_instance: "resume-instance".into(),
        channel_epoch: "2".into(),
        host_instance_id: "resume-host".into(),
        terminal_epoch: "resume-terminal".into(),
    };
    write_ready_hmux_session(&state, &target, "conversation-observation");
    let delay_marker = root.path().join("delay-observation");
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    let (stage, cause) = match fault {
        ResumeFault::Timeout => {
            let executable = &state.hmux_identity.executable_path;
            let original = fs::read_to_string(executable).unwrap();
            // Replace the fixture process with sleep so timeout cleanup owns
            // the exact blocked process, not a shell with an orphaned child.
            fs::write(
                executable,
                format!(
                    "#!/bin/sh\nif [ -f '{}' ]; then exec /bin/sleep {}; fi\n{}",
                    delay_marker.display(),
                    HMUX_QUERY_TIMEOUT.as_secs() + 30,
                    original.strip_prefix("#!/bin/sh\n").unwrap(),
                ),
            )
            .unwrap();
            state.hmux_identity = resolve_hmux_toolchain_identity(
                executable,
                &state.hmux_identity.runtime_executable_path,
                &state.hmux_identity.discovery_root,
            )
            .unwrap();
            fs::write(&delay_marker, b"delay").unwrap();
            ("target_observation", "hmux_descriptor_timeout")
        }
        ResumeFault::Malformed => {
            fs::write(
                state
                    .hmux_identity
                    .discovery_root
                    .join("current-session.json"),
                b"{",
            )
            .unwrap();
            ("target_observation", "hmux_descriptor_malformed")
        }
        ResumeFault::Publication => {
            // Fail the final write, after the transaction has updated both
            // selection and binding, so the unchanged-state assertions prove
            // rollback rather than a refusal before publication starts.
            sqlx::query(
                "CREATE TRIGGER fail_resume_publication
                 BEFORE INSERT ON agent_runtime_native_rehost_receipts
                 BEGIN SELECT RAISE(ABORT, 'fixture publication failure'); END",
            )
            .execute(&fault_pool)
            .await
            .unwrap();
            ("publication", "sqlite")
        }
    };
    let request = native_resume_request(
        &state,
        json!({
            "schemaVersion": 1,
            "agentId": agent_id,
            "operationId": "native-resume-observation",
            "providerId": "codex",
            "targetCredential": { "kind": "provider_default" },
            "providerConversationRef": "conversation-observation",
            "permissionMode": "default",
            "launchIdempotencyKey": "native-resume-observation",
            "target": generation_json(
                &target.session_id,
                &target.runner_principal,
                &target.runner_instance,
                &target.channel_epoch,
                &target.host_instance_id,
                &target.terminal_epoch,
            ),
        }),
    );
    let failure = dispatch(&state, &request).await.unwrap_err();
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap(),
        Some(source_selection),
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap(),
        Some(source_authority.clone()),
    );
    match fault {
        ResumeFault::Timeout => fs::remove_file(&delay_marker).unwrap(),
        ResumeFault::Malformed => {
            write_ready_hmux_session(&state, &target, "conversation-observation");
        }
        ResumeFault::Publication => {
            sqlx::query("DROP TRIGGER fail_resume_publication")
                .execute(&fault_pool)
                .await
                .unwrap();
        }
    }
    fault_pool.close().await;

    let response = dispatch(&state, &request).await.unwrap();
    assert_eq!(dispatch(&state, &request).await.unwrap(), response);
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(authority.binding.session_id, target.session_id);
    assert_eq!(authority.host_instance_id, target.host_instance_id);
    assert_eq!(
        authority.binding.provider_conversation_id.as_deref(),
        Some("conversation-observation"),
    );
    assert_eq!(
        authority.binding.binding_generation,
        source_authority.binding.binding_generation + 1,
    );
    assert!(launcher.requests.lock().unwrap().is_empty());
    assert_eq!(
        failure.code,
        match fault {
            ResumeFault::Publication => "agent_runtime_native_rehost_store_failed",
            _ => "agent_runtime_native_rehost_unavailable",
        },
    );
    assert_eq!(failure.disposition, BackendFailureDispositionV1::RetrySame);
    assert_eq!(
        failure.details,
        Some(json!({ "stage": stage, "cause": cause })),
    );
    assert!(failure.message.contains(cause));
    if matches!(fault, ResumeFault::Publication) {
        assert!(failure.message.contains("fixture publication failure"));
    }
}

#[tokio::test]
async fn native_resume_preserves_timeout_cause_and_replays_the_same_target() {
    assert_same_target_recovery(ResumeFault::Timeout).await;
}

#[tokio::test]
async fn native_resume_preserves_malformed_cause_and_replays_the_same_target() {
    assert_same_target_recovery(ResumeFault::Malformed).await;
}

#[tokio::test]
async fn native_resume_preserves_publication_cause_and_replays_the_same_target() {
    assert_same_target_recovery(ResumeFault::Publication).await;
}
