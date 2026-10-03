use super::*;
use hmux_client::{AgentRuntimeActivity, AgentRuntimeAttention};

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn cli_account_switch_preserves_conversation_with_real_hmux() {
    for provider in ["claude", "codex"] {
        account_switch(provider).await;
    }
}

async fn account_switch(provider: &str) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let starts = root.path().join("provider-starts");
    let environment = root.path().join("provider-environment");
    let executable = root.path().join("codex-fixture");
    fs::write(&executable, format!(
        "#!/bin/sh\nprintf 'started\\n' >> '{}'\nprintf '%s\\n' \"$CODEX_HOME\" \"$CLAUDE_CONFIG_DIR\" \"$@\" > '{}'\nexec sleep 120\n",
        starts.display(), environment.display(),
    )).unwrap();
    state.agent_providers = Arc::new(provider_extension::test_bundled_provider_registry(
        provider,
        executable.to_str().unwrap(),
        false,
    ));
    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_name = format!("{provider}-work");
    let profile_dir = accounts.join(&profile_name);
    fs::create_dir(&profile_dir).unwrap();
    fs::set_permissions(&profile_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let profile = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: 1,
                provider_id: provider.into(),
                reference_id: "work".into(),
                profile_directory_name: profile_name,
            },
        )
        .await
        .unwrap();
    let repository = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        "project-1".into(),
        "Account switch fixture".into(),
        repository
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let prompt = "account switch fixture";
    let preview = preview_agent_spawn(&state, &authority, &json!({
        "schemaVersion": 1, "idempotencyKey": "account-switch-run", "projectId": "project-1",
        "providerId": provider, "agentName": "account-worker", "worktree": {"kind": "project_root"},
        "providerConversationRef": CONVERSATION, "interactionPreference": "native_cli",
        "promptDigest": dure_app::AgentSpawnPromptDigestV1::sha256(prompt),
    })).await.unwrap();
    let planned: dure_app::AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    let applied = apply_agent_spawn(
        &state,
        &authority,
        agent_spawn_apply::AgentSpawnApplyBody {
            schema_version: 1,
            operation_id: planned.operation_id,
            plan_token: planned.plan.plan_token,
            expected_last_sequence: planned.last_sequence,
            prompt: Some(prompt.into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"], "succeeded", "{applied}");
    let agent_id = AgentIdV1::new(applied["receipt"]["plan"]["agentId"].as_str().unwrap()).unwrap();
    let source = current_session(&hmux, provider);
    wait_for_provider_starts(&starts, 1).await;
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    let state = publication_state(state);
    let _server = PublicationServer::start(Arc::clone(&state));
    let (ok, discovered) = run_cli(
        &state,
        &hmux.root,
        &[
            "recovery",
            "get",
            provider,
            "--backend",
            "fixture",
            "--json",
        ],
        None,
        None,
    )
    .await;
    assert!(ok, "{discovered}");
    assert_eq!(discovered["profiles"][0]["referenceId"], "work");
    assert_eq!(
        discovered["profiles"][0]["credentialGeneration"],
        profile.credential_generation
    );
    let args = [
        "runs",
        "switch-account",
        "account-worker",
        "--account",
        "work",
        "--backend",
        "fixture",
        "--json",
    ];
    let (ok, preview) = run_cli(&state, &hmux.root, &args, None, None).await;
    assert!(ok, "{preview}");
    assert_eq!(preview["accountSwitch"]["state"], "preview");
    assert_eq!(hmux.requests().len(), 1);
    let mut confirmed = args.to_vec();
    confirmed.push("--confirm-restart");
    let (ok, busy) = run_cli(&state, &hmux.root, &confirmed, None, None).await;
    assert!(!ok, "{busy}");
    assert_eq!(
        busy["error"]["remoteCode"], "agent_runtime_source_busy",
        "{busy}"
    );
    assert_eq!(hmux.requests().len(), 1);
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Ready
    );
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    let (ok, switched) = run_cli(&state, &hmux.root, &confirmed, None, None).await;
    assert!(ok, "{switched}");
    assert_eq!(switched["accountSwitch"]["state"], "completed");
    let receipt = &switched["accountSwitch"]["result"]["receipt"];
    assert_eq!(receipt["providerConversationRef"], CONVERSATION);
    assert_eq!(receipt["providerId"], provider);
    assert_eq!(receipt["authority"]["interactionProfile"], "native_cli");
    assert_eq!(receipt["executionProfile"]["reference_id"], "work");
    assert_eq!(
        receipt["executionProfile"]["credential_generation"],
        profile.credential_generation
    );
    wait_for_provider_starts(&starts, 2).await;
    assert_eq!(hmux.requests().len(), 2);
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    let launched = fs::read_to_string(&environment).unwrap();
    assert!(
        launched.contains(profile_dir.to_str().unwrap()),
        "selected profile not passed to provider"
    );
    assert!(
        launched.contains(CONVERSATION),
        "conversation not passed to provider"
    );
    let retry: Vec<&str> = switched["accountSwitch"]["continuation"]["retry"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    // A new CLI process can replay the exact request after losing success.
    for _ in 0..2 {
        let (ok, replay) = run_cli(&state, &hmux.root, &retry, None, None).await;
        assert!(ok, "{replay}");
        assert_eq!(&replay["result"]["receipt"], receipt);
        assert_eq!(hmux.requests().len(), 2);
    }
    assert_eq!(
        inspect(&state, &agent_id).await["receipt"]["executionProfile"]["reference_id"],
        "work"
    );
    hmux.stop(&current_session(&hmux, provider));
}

fn current_session(hmux: &RealHmux, provider: &str) -> WorkflowSessionGenerationV1 {
    let request = hmux.requests().last().unwrap().clone();
    let session = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
        .find(&hmux_client::SessionSelector::new(
            &request.session_id,
            Some(request.workspace_id),
        ))
        .unwrap();
    WorkflowSessionGenerationV1 {
        session_id: session.session_id,
        workspace_id: session.workspace_id,
        provider_id: ProviderIdV1::new(provider).unwrap(),
        runner_principal: session.runner_principal,
        runner_instance: session.runner_instance,
        channel_epoch: session.channel_epoch,
        host_instance_id: session.host_instance_id,
        terminal_epoch: session.terminal_epoch,
    }
}
