use super::*;
use dure_app::AgentSpawnJournalStore;

#[tokio::test]
async fn missing_provider_setup_preserves_the_plan_and_retries_without_duplicate_launch() {
    missing_provider_setup(false).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux; run pnpm test:hmux-provider-setup"]
async fn missing_provider_setup_uses_real_hmux() {
    missing_provider_setup(true).await;
}

async fn missing_provider_setup(native: bool) {
    let (root, mut state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    let executable = root.path().join("provider-installed-later");
    state.agent_providers = Arc::new(provider_extension::test_agent_provider_registry(
        executable.to_str().unwrap(),
    ));
    let repository = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        "provider-setup-project".into(),
        "Provider setup fixture".into(),
        repository.path().canonicalize().unwrap().to_str().unwrap().into(),
    )
    .unwrap();
    let hmux = if native {
        Some(real_hmux::RealHmux::install(root, &mut state))
    } else {
        None
    };
    let launches = || hmux.as_ref().map_or_else(|| launcher.requests(), |runtime| runtime.requests());
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let request = json!({
        "schemaVersion": 1,
        "idempotencyKey": "missing-provider-setup",
        "projectId": "provider-setup-project",
        "providerId": "codex",
        "agentName": "provider-setup",
        "interactionPreference": "native_cli",
        "worktree": { "kind": "project_root" },
        "promptDigest": null,
    });
    let preview = preview_agent_spawn(&state, &authority, &request).await.unwrap();
    let planned: dure_app::AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    let mut wire = orchestration_backend_request(&state, "missing-provider-apply", "", Value::Null);
    wire.operation = "agent_spawn.apply".into();
    wire.expected.required_capabilities = vec!["agent_spawn.apply".into()];
    wire.body = json!({
        "schemaVersion": 1,
        "operationId": planned.operation_id,
        "planToken": planned.plan.plan_token,
        "expectedLastSequence": planned.last_sequence,
        "prompt": null,
    });
    let failure = dispatch(&state, &wire).await.unwrap_err();
    assert_eq!(failure.code, "agent_spawn_provider_unavailable");
    assert_eq!(failure.disposition, BackendFailureDispositionV1::RetrySame);
    assert_eq!(failure.details, Some(json!({"reasonCode": "provider_executable_not_found"})));
    assert!(launches().is_empty());
    assert!(state.store.agent(&planned.plan.agent_id).await.unwrap().is_none());
    assert!(state.store.workspace(&planned.plan.workspace_id).await.unwrap().is_none());
    assert_eq!(preview_agent_spawn(&state, &authority, &request).await.unwrap(), preview);
    let reopened = SqliteDomainStore::open(&state.descriptor.database_path).await.unwrap();
    assert_eq!(reopened.agent_spawn_receipt(&planned.operation_id).await.unwrap().unwrap(), planned);

    // Repair only the owned fixture executable; neither the plan nor the request changes.
    let started = executable.with_extension("started");
    fs::write(&executable, "#!/bin/sh\nprintf 'started\\n' >> \"$0.started\"\nexec sleep 120\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let applied = dispatch(&state, &wire).await.unwrap();
    assert_eq!(applied["receipt"]["state"], "succeeded");
    assert_eq!(applied["receipt"]["operationId"], preview["receipt"]["operationId"]);
    assert_eq!(launches().len(), 1);
    // Replaying after losing the successful response must not create another process.
    assert_eq!(dispatch(&state, &wire).await.unwrap(), applied);
    assert_eq!(launches().len(), 1);
    if let Some(hmux) = hmux {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !started.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("the repaired fixture executable must actually start");
        assert_eq!(fs::read_to_string(started).unwrap(), "started\n");
        let launched = hmux.requests();
        let session = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
            .find(&hmux_client::SessionSelector::new(
                &launched[0].session_id,
                Some(launched[0].workspace_id.clone()),
            )).unwrap();
        hmux.stop(&WorkflowSessionGenerationV1 {
            session_id: session.session_id,
            workspace_id: session.workspace_id,
            provider_id: ProviderIdV1::new(&session.provider_id).unwrap(),
            runner_principal: session.runner_principal,
            runner_instance: session.runner_instance,
            channel_epoch: session.channel_epoch,
            host_instance_id: session.host_instance_id,
            terminal_epoch: session.terminal_epoch,
        });
    }
}

#[tokio::test]
async fn existing_checkout_crosses_preview_wire_and_replays_without_recapturing_mutable_work() {
    let (_state_root, state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    let repository = crate::workspace_git::tests::repository().await;
    let project_root = repository.path().canonicalize().unwrap();
    let reference =
        crate::workspace_git::tests::existing_checkout_tests::selected_checkout(&project_root)
            .await;
    register_project(
        &state.projects_catalog_path,
        "project-existing".into(),
        "Original project".into(),
        project_root.to_str().unwrap().into(),
    )
    .unwrap();
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let request = json!({
        "schemaVersion": 1,
        "idempotencyKey": "selected-existing-checkout-wire",
        "projectId": "project-existing",
        "providerId": "codex",
        "agentName": "new-agent-in-existing-checkout",
        "interactionPreference": "native_cli",
        "worktree": { "kind": "existing_checkout", "reference": reference },
        "promptDigest": null,
    });
    let preview = preview_agent_spawn(&state, &authority, &request)
        .await
        .unwrap();
    let planned: dure_app::AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    assert!(
        planned
            .plan
            .request
            .provider_conversation_ref
            .as_option()
            .is_none()
    );
    let applied = apply_agent_spawn(
        &state,
        &authority,
        agent_spawn_apply::AgentSpawnApplyBody {
            schema_version: dure_app::AGENT_SPAWN_SCHEMA_VERSION_V1,
            operation_id: planned.operation_id.clone(),
            plan_token: planned.plan.plan_token.clone(),
            expected_last_sequence: planned.last_sequence,
            prompt: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"], "succeeded", "{applied}");
    let workspace = state
        .store
        .workspace(&planned.plan.workspace_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(workspace.project_id.as_str(), "project-existing");
    assert_eq!(workspace.root_path, reference.canonical_path);
    assert_eq!(
        workspace.base_commit_sha.as_deref(),
        Some(reference.head.as_str())
    );
    let project = state
        .store
        .project(&workspace.project_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(project.root_path, project_root.to_str().unwrap());
    let launches = launcher.requests();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].working_directory, reference.canonical_path);

    let checkout = std::path::Path::new(&reference.canonical_path);
    std::fs::write(checkout.join("untracked.txt"), "retained work\n").unwrap();
    crate::workspace_git::tests::branch_behind_head(checkout, "user/later-work").await;
    let replay = preview_agent_spawn(&state, &authority, &request)
        .await
        .unwrap();
    assert_eq!(replay["receipt"], applied["receipt"]);
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(
        std::fs::read_to_string(checkout.join("untracked.txt")).unwrap(),
        "retained work\n"
    );
    let mut changed = request;
    changed["worktree"]["reference"]["head"] = json!(
        crate::workspace_git::resolve_base_commit(checkout, None)
            .await
            .unwrap()
    );
    assert_eq!(
        preview_agent_spawn(&state, &authority, &changed)
            .await
            .unwrap_err(),
        "agent_spawn_idempotency_conflict"
    );
}

#[tokio::test]
async fn explicit_destination_crosses_preview_wire_and_launches_in_the_registered_checkout() {
    spawn_at_destination(false).await;
}

#[tokio::test]
async fn existing_branch_crosses_preview_wire_and_launches_at_its_own_commit() {
    spawn_at_destination(true).await;
}

async fn spawn_at_destination(existing_branch: bool) {
    let (_state_root, state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    let repository = crate::workspace_git::tests::repository().await;
    let project_root = repository.path().canonicalize().unwrap();
    let destination = project_root.join("custom/work/feature-x");
    let expected_base = if existing_branch {
        crate::workspace_git::tests::branch_behind_head(&project_root, "agent/feature-x").await
    } else {
        crate::workspace_git::resolve_base_commit(&project_root, None)
            .await
            .unwrap()
    };
    register_project(
        &state.projects_catalog_path,
        "project-custom".into(),
        "Custom checkout fixture".into(),
        project_root.to_string_lossy().into_owned(),
    )
    .unwrap();
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let preview = preview_agent_spawn(
        &state,
        &authority,
        &json!({
            "schemaVersion": 1,
            "idempotencyKey": "custom-destination-wire",
            "projectId": "project-custom",
            "providerId": "codex",
            "agentName": "custom-checkout",
            "interactionPreference": "native_cli",
            "worktree": {
                "kind": "dedicated",
                "branch": "agent/feature-x",
                "branch_mode": if existing_branch { "existing" } else { "create" },
                "checkout_path": destination,
            },
            "promptDigest": null,
        }),
    )
    .await
    .unwrap();
    let planned: dure_app::AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    assert_eq!(
        preview["receipt"]["plan"]["request"]["worktree"]["base_commit_sha"],
        expected_base
    );
    assert_eq!(
        preview["receipt"]["plan"]["request"]["worktree"]["checkout_path"],
        destination.to_string_lossy().as_ref()
    );
    let applied = apply_agent_spawn(
        &state,
        &authority,
        agent_spawn_apply::AgentSpawnApplyBody {
            schema_version: dure_app::AGENT_SPAWN_SCHEMA_VERSION_V1,
            operation_id: planned.operation_id.clone(),
            plan_token: planned.plan.plan_token.clone(),
            expected_last_sequence: planned.last_sequence,
            prompt: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"], "succeeded", "{applied}");
    assert_eq!(
        applied["receipt"]["checkoutRegistration"]["instance"]["canonicalPath"],
        destination.to_string_lossy().as_ref()
    );
    let launches = launcher.requests();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].working_directory, destination.to_string_lossy());
    assert!(destination.join(".git").is_file());
    assert_eq!(
        crate::workspace_git::resolve_base_commit(&destination, None)
            .await
            .unwrap(),
        expected_base
    );
    assert!(!project_root.join(".worktrees/feature-x").exists());
}
