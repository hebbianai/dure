use super::*;
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, ManagedAgentStateReporter,
    ManagedRehostReceipt, ManagedRehostResolution, ProviderConversationIdentity, SessionFence,
};
use std::path::Path;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_run_rehost_uses_real_hmux() {
    for conversation in [None, Some(CONVERSATION)] {
        run_then_rehost(conversation).await;
    }
}

async fn run_then_rehost(conversation: Option<&str>) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let starts = root.path().join("provider-starts");
    fs::write(
        root.path().join("codex-fixture"),
        format!(
            "#!/bin/sh\nprintf '%s\\0' \"$PWD\" \"$CODEX_HOME\" \"$@\" END >> '{}'\nexec sleep 120\n",
            starts.display()
        ),
    )
    .unwrap();
    let repository = crate::workspace_git::tests::repository().await;
    let project_root = repository.path().canonicalize().unwrap();
    let setup_marker = root.path().join("setup-runs");
    let (worktree, setup) = if conversation.is_some() {
        let output = tokio::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&project_root)
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        (
            json!({"kind": "dedicated", "branch": "run-rehost-worktree",
                "base_commit_sha": String::from_utf8(output.stdout).unwrap().trim()}),
            Some(format!("printf 'setup\\n' >> '{}'", setup_marker.display())),
        )
    } else {
        (json!({"kind": "project_root"}), None)
    };
    register_project(
        &state.projects_catalog_path,
        "project-1".into(),
        "Run rehost fixture".into(),
        project_root.to_str().unwrap().into(),
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let prompt = "run-only initial prompt";
    let preview = preview_agent_spawn(
        &state,
        &authority,
        &json!({
            "schemaVersion": 1,
            "idempotencyKey": "native-run-rehost",
            "projectId": "project-1",
            "providerId": "codex",
            "agentName": "run-rehost",
            "worktree": worktree,
            "setupCommand": setup,
            "providerConversationRef": conversation,
            "permissionOverride": "bypass_approvals",
            "model": "gpt-6-astra",
            "effort": "high",
            "promptDigest": dure_app::AgentSpawnPromptDigestV1::sha256(prompt),
            "interactionPreference": "native_cli",
        }),
    )
    .await
    .unwrap();
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
    let launched = hmux.requests();
    assert_eq!(launched.len(), 1);
    let source = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
        .find(&hmux_client::SessionSelector::new(
            &launched[0].session_id,
            Some(launched[0].workspace_id.clone()),
        ))
        .unwrap();
    let source_fence = SessionFence {
        session_id: source.session_id.clone(),
        workspace_id: source.workspace_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: source.runner_instance.clone(),
        channel_epoch: source.channel_epoch.parse().unwrap(),
        host_instance_id: source.host_instance_id.clone(),
        terminal_epoch: source.terminal_epoch.clone(),
    };
    if conversation.is_none() {
        ManagedAgentStateReporter::new(&state.hmux_identity.runtime_executable_path, &hmux.root)
            .with_discovery_root(&hmux.discovery)
            .report_agent_state_for_fence(
                hmux_client::ManagedAttachRequest::new(&source.session_id, &source.workspace_id)
                    .unwrap(),
                AgentStateReport {
                    identity_only: true,
                    activity: AgentRuntimeActivity::Waiting,
                    attention: AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: Some(ProviderConversationIdentity {
                        provider_id: "codex".into(),
                        conversation_id: CONVERSATION.into(),
                        previous_conversation_id: None,
                        expected_fence: Some(source_fence.clone()),
                    }),
                    expected_observation: None,
                },
                source_fence,
            )
            .unwrap();
    }
    let before = wait_for_starts(&starts, 1).await;
    if setup.is_some() {
        assert_eq!(fs::read_to_string(&setup_marker).unwrap(), "setup\n");
    }
    // Lose the successful output. A new caller retains only the original tuple.
    drop(rehost_cli(&state, &hmux, &source).await);
    let receipt = rehost_cli(&state, &hmux, &source).await;
    assert_eq!(receipt.conversation_id(), Some(CONVERSATION));
    let resolution = ManagedRehostResolution::from_receipts(
        receipt.operation_id(),
        receipt.source_stop_receipt(),
        receipt.replacement_receipt(),
    )
    .unwrap();
    let generation = resolution.current_generation();
    let target = WorkflowSessionGenerationV1 {
        session_id: generation.session_id().into(),
        workspace_id: generation.workspace_id().into(),
        provider_id: ProviderIdV1::new(&source.provider_id).unwrap(),
        runner_principal: generation.runner_principal().into(),
        runner_instance: generation.runner_instance().into(),
        channel_epoch: generation.channel_epoch().to_string(),
        host_instance_id: generation.host_instance_id().into(),
        terminal_epoch: generation.terminal_epoch().into(),
    };
    let after = wait_for_starts(&starts, 2).await;
    assert_eq!(before[0], after[0]);
    let mut expected = before[0].clone();
    assert_eq!(expected.pop().as_deref(), Some(prompt));
    assert_eq!(expected.pop().as_deref(), Some("--"));
    if conversation.is_none() {
        expected.extend(["resume".into(), CONVERSATION.into()]);
    }
    assert_eq!(
        after[1], expected,
        "resume must retain cwd, profile and provider argv"
    );
    let original_target = hmux.session(&target);
    // Independent CLI processes replay the completed operation concurrently.
    let (left, right) = tokio::join!(
        rehost_cli(&state, &hmux, &source),
        rehost_cli(&state, &hmux, &source),
    );
    assert_eq!(left.replacement_receipt(), receipt.replacement_receipt());
    assert_eq!(right.replacement_receipt(), receipt.replacement_receipt());
    assert!(original_target.same_generation(&hmux.session(&target)));
    assert_eq!(
        original_target.provider_process,
        hmux.session(&target).provider_process
    );
    assert_eq!(read_starts(&starts), after);
    if setup.is_some() {
        assert_eq!(fs::read_to_string(&setup_marker).unwrap(), "setup\n");
    }
    hmux.stop(&target);
}

async fn rehost_cli(
    state: &ServiceState,
    hmux: &RealHmux,
    source: &hmux_client::SessionDescriptor,
) -> ManagedRehostReceipt {
    let output = tokio::time::timeout(
        Duration::from_secs(50),
        tokio::process::Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs"))
            .args([
                "hmux",
                "rehost",
                "start",
                &source.session_id,
                "--workspace",
                &source.workspace_id,
            ])
            .args([
                "--operation-id",
                "native-run-rehost-operation",
                "--confirm-restart",
                "--json",
            ])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", &hmux.root)
            .env("DURE_HOME", hmux.root.join("no-app"))
            .env("DURE_HMUX_BIN", &state.hmux_identity.executable_path)
            .env("HMUX_RUNTIME", &state.hmux_identity.runtime_executable_path)
            .env("HMUX_DISCOVERY_ROOT", &hmux.discovery)
            .current_dir(&hmux.root)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("owned CLI command timed out")
    .unwrap();
    assert!(
        output.status.success(),
        "CLI rehost failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn read_starts(path: &Path) -> Vec<Vec<String>> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => panic!("provider marker failed: {error}"),
    };
    contents
        .split_inclusive("END\0")
        .filter_map(|launch| launch.strip_suffix("END\0"))
        .map(|launch| launch.split_terminator('\0').map(str::to_owned).collect())
        .collect()
}

async fn wait_for_starts(path: &Path, expected: usize) -> Vec<Vec<String>> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let starts = read_starts(path);
            if starts.len() == expected {
                return starts;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("provider startup marker did not arrive")
}
