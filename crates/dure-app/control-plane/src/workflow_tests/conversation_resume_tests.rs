//! A new Agent on an exact provider conversation the backend no longer holds an
//! Agent for (`dure runs resume --conversation`). The Run creation is the
//! existing spawn path; these tests pin that the conversation reaches the
//! provider's resume launch and the Hmux create as its single writer, and that
//! a conversation another session holds is refused without touching it.

use super::*;
use hmux_runtime_contract::MANAGED_CONVERSATION_WRITER_CONFLICT_CODE;

const CONVERSATION: &str = "019a4c2e-7d3b-7f00-9c11-conversation";
const PROJECT_ID: &str = "conversation-resume-project";

fn authority(state: &ServiceState) -> BackendRequestAuthority {
    BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    }
}

/// The exact body `dure runs resume --conversation` previews
/// (`scripts/dure-runs-command.test.mjs` pins the same body).
fn resume_request(key: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "idempotencyKey": key,
        "projectId": PROJECT_ID,
        "providerId": "codex",
        "executionProfile": { "kind": "provider_default" },
        "agentName": key,
        "interactionPreference": "native_cli",
        "providerConversationRef": CONVERSATION,
        "worktree": { "kind": "project_root" },
        "promptDigest": null,
    })
}

async fn register_resume_project(state: &ServiceState) -> TempDir {
    let repository = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        PROJECT_ID.into(),
        "Conversation resume fixture".into(),
        repository
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    )
    .unwrap();
    repository
}

/// Preview (or replay) the plan, then apply it at its current sequence.
async fn preview_and_apply(state: &ServiceState, key: &str) -> (Value, Value) {
    let preview = preview_agent_spawn(state, &authority(state), &resume_request(key))
        .await
        .unwrap();
    let planned: dure_app::AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    let applied = apply_agent_spawn(
        state,
        &authority(state),
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
    (preview, applied)
}

fn stage_error(receipt: &Value) -> Option<&str> {
    receipt["terminalCode"]
        .as_str()
        .or_else(|| receipt["recovery"]["error_code"].as_str())
}

#[tokio::test]
async fn spawn_resumes_an_exact_conversation_in_a_new_terminal_agent() {
    let (_root, state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    let _repository = register_resume_project(&state).await;

    let (preview, applied) = preview_and_apply(&state, "resume-exact").await;
    let plan = &preview["receipt"]["plan"];
    assert_eq!(plan["request"]["providerConversationRef"], CONVERSATION);
    assert_eq!(plan["launch"]["interactionProfile"], "native_cli");
    assert_eq!(applied["receipt"]["state"], "succeeded", "{applied}");

    let launches = launcher.requests();
    assert_eq!(launches.len(), 1);
    assert_eq!(
        launches[0].provider_conversation_ref.as_deref(),
        Some(CONVERSATION)
    );
    // The provider is started on that conversation, not a fresh one, and a
    // later rehost keeps the same exact conversation recipe.
    assert!(
        launches[0]
            .provider_arguments
            .iter()
            .any(|argument| argument == CONVERSATION),
        "{:?}",
        launches[0].provider_arguments
    );
    assert!(launches[0].provider_resume.is_some());

    let agent_id = AgentIdV1::new(plan["agentId"].as_str().unwrap()).unwrap();
    let binding = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        binding.binding.provider_conversation_id.as_deref(),
        Some(CONVERSATION)
    );
    let mut inspect = orchestration_backend_request(&state, "resume-inspect", "", Value::Null);
    inspect.operation = "agent_runtime.inspect".into();
    inspect.expected.required_capabilities = Vec::new();
    inspect.body = json!({ "schemaVersion": 1, "agentId": agent_id.as_str() });
    let inspected = dispatch(&state, &inspect).await.unwrap();
    assert_eq!(inspected["state"], "stable", "{inspected}");
    assert_eq!(
        inspected["receipt"]["providerConversationRef"],
        CONVERSATION
    );

    // The retry the CLI prints replays the same plan and receipt: one launch.
    assert_eq!(preview_and_apply(&state, "resume-exact").await.1, applied);
    assert_eq!(launcher.requests().len(), 1);
}

#[tokio::test]
async fn spawn_refuses_a_held_conversation_and_the_same_apply_resumes_after_it_exits() {
    let (_root, state, launcher, _) = fixture(vec![
        LaunchOutcome::Reject(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE),
        LaunchOutcome::Succeed,
    ])
    .await;
    let _repository = register_resume_project(&state).await;

    let (preview, refused) = preview_and_apply(&state, "resume-held").await;
    // The CLI reads this exact retryable shape as a refusal.
    assert_eq!(refused["receipt"]["state"], "retry_required", "{refused}");
    assert_eq!(refused["receipt"]["recovery"]["stage"], "runtime_launch");
    assert_eq!(
        stage_error(&refused["receipt"]),
        Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE),
        "{refused}"
    );
    let agent_id = AgentIdV1::new(preview["receipt"]["plan"]["agentId"].as_str().unwrap()).unwrap();
    assert!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .is_none(),
        "a refused resume must not publish a binding for the conversation"
    );

    // Once the holder exits, the same retry key continues the same plan.
    let (_, resumed) = preview_and_apply(&state, "resume-held").await;
    assert_eq!(resumed["receipt"]["state"], "succeeded", "{resumed}");
    assert_eq!(
        resumed["receipt"]["operationId"],
        preview["receipt"]["operationId"]
    );
    let launches = launcher.requests();
    assert_eq!(launches.len(), 2);
    assert_eq!(launches[0].session_id, launches[1].session_id);
    assert!(
        launches
            .iter()
            .all(|launch| launch.provider_conversation_ref.as_deref() == Some(CONVERSATION))
    );
}

/// Real Hmux holds the conversation's single-writer reservation: a second
/// Agent is refused while the first runs, the first keeps running, and the
/// refused Apply resumes the conversation once the first has stopped.
#[tokio::test]
#[ignore = "requires isolated real Hmux; run pnpm test:hmux-conversation-resume"]
async fn conversation_resume_uses_real_hmux() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let executable = root.path().join("resumable-provider");
    fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$0.arguments\"\nexec sleep 120\n",
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let arguments = executable.with_extension("arguments");
    state.agent_providers = Arc::new(provider_extension::test_agent_provider_registry(
        executable.to_str().unwrap(),
    ));
    let _repository = register_resume_project(&state).await;
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let generation = |launch: &WorkflowSessionLaunchRequestV1| {
        let session = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
            .find(&hmux_client::SessionSelector::new(
                &launch.session_id,
                Some(launch.workspace_id.clone()),
            ))
            .unwrap();
        (
            WorkflowSessionGenerationV1 {
                session_id: session.session_id.clone(),
                workspace_id: session.workspace_id.clone(),
                provider_id: ProviderIdV1::new(&session.provider_id).unwrap(),
                runner_principal: session.runner_principal.clone(),
                runner_instance: session.runner_instance.clone(),
                channel_epoch: session.channel_epoch.clone(),
                host_instance_id: session.host_instance_id.clone(),
                terminal_epoch: session.terminal_epoch.clone(),
            },
            session,
        )
    };

    let (_, holder) = preview_and_apply(&state, "resume-holder").await;
    assert_eq!(holder["receipt"]["state"], "succeeded", "{holder}");
    let (holder_generation, holder_session) = generation(&hmux.requests()[0]);
    // A created session's provider process is live before its script runs, so
    // contend only once the holder's provider has really started.
    started_providers(&arguments, 1).await;

    let (contender_preview, refused) = preview_and_apply(&state, "resume-contender").await;
    assert_eq!(
        stage_error(&refused["receipt"]),
        Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE),
        "{refused}"
    );
    for process in [
        &holder_session.host_process,
        &holder_session.provider_process,
    ] {
        assert_eq!(
            hmux_client::probe_local_process_generation(process).unwrap(),
            hmux_client::LocalProcessGenerationStatus::Live,
            "a refused resume must leave the holder running"
        );
    }

    hmux.stop(&holder_generation);
    real_hmux::RealHmux::assert_exited(&holder_session).await;
    let (_, resumed) = preview_and_apply(&state, "resume-contender").await;
    assert_eq!(resumed["receipt"]["state"], "succeeded", "{resumed}");
    assert_eq!(
        resumed["receipt"]["operationId"],
        contender_preview["receipt"]["operationId"]
    );
    let launches = hmux.requests();
    let (contender_generation, contender_session) = generation(launches.last().unwrap());
    // Both started providers were handed the exact conversation to resume.
    let started = started_providers(&arguments, 2).await;
    assert!(
        started.lines().all(|line| line.contains(CONVERSATION)),
        "{started}"
    );
    hmux.stop(&contender_generation);
    real_hmux::RealHmux::assert_exited(&contender_session).await;
}

/// Wait until `count` fixture providers have recorded their arguments.
async fn started_providers(arguments: &Path, count: usize) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let started = fs::read_to_string(arguments).unwrap_or_default();
            if started.lines().count() >= count {
                return started;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("provider {count} must actually start"))
}
