use super::*;
use crate::child_result_delivery::{self, ChildResultDeliveries};
use dure_app::{AgentSpawnJournalReceiptV1, AgentSpawnParentV1};

const PARENT_SESSION: &str = "coordinator-session";
const PARENT_WORKSPACE: &str = "coordinator-workspace";

/// Starts a native child through the public spawn path, linked to the
/// fixture's coordinator Session as its parent. The repository it runs in is
/// returned so it outlives the Run.
async fn spawn_linked_child(state: &ServiceState) -> (AgentSpawnJournalReceiptV1, TempDir) {
    let repository = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        "child-result-project".into(),
        "Child result fixture".into(),
        repository
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    )
    .unwrap();
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let preview = preview_agent_spawn(
        state,
        &authority,
        &json!({
            "schemaVersion": 1,
            "idempotencyKey": "child-result",
            "projectId": "child-result-project",
            "providerId": "codex",
            "agentName": "fix-12",
            "interactionPreference": "native_cli",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
            "parent": { "sessionId": PARENT_SESSION, "workspaceId": PARENT_WORKSPACE },
        }),
    )
    .await
    .unwrap();
    let planned: AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    let mut wire = orchestration_backend_request(state, "child-result-apply", "", Value::Null);
    wire.operation = "agent_spawn.apply".into();
    wire.expected.required_capabilities = vec!["agent_spawn.apply".into()];
    wire.body = json!({
        "schemaVersion": 1,
        "operationId": planned.operation_id,
        "planToken": planned.plan.plan_token,
        "expectedLastSequence": planned.last_sequence,
        "prompt": null,
    });
    let applied = dispatch(state, &wire).await.unwrap();
    assert_eq!(applied["receipt"]["state"], "succeeded");
    (
        serde_json::from_value(applied["receipt"].clone()).unwrap(),
        repository,
    )
}

/// What the fixture Host reports for the child's exact Session.
fn report_child(
    state: &ServiceState,
    authority: &AgentCheckpointBindingAuthorityV1,
    lifecycle: &str,
    activity: &str,
    attention: &str,
    turns: &str,
) {
    let session = json!({
        "schema_version": 1,
        "session_id": authority.binding.session_id,
        "workspace_id": authority.runtime_workspace_id,
        "session_class": "managed",
        "lifecycle": lifecycle,
        "provider_id": "codex",
        "runner_principal": authority.runner_principal,
        "runner_instance": authority.runner_instance,
        "channel_epoch": authority.channel_epoch,
        "host_instance_id": authority.host_instance_id,
        "terminal_epoch": authority.terminal_epoch,
        "output_seq": "9",
        "health": if lifecycle == "exited" { "exited" } else { "healthy" },
        "controllerInputPending": false,
        "agentRuntimeState": {
            "terminal_epoch": authority.terminal_epoch,
            "revision": "3",
            "observed_through_output_seq": "9",
            "turn_completed_count": turns,
            "lifecycle": if lifecycle == "exited" { "exited" } else { "running" },
            "activity": activity,
            "attention": attention,
            "attention_id": if attention == "none" { None } else { Some("attention-1") },
            "background_work": false,
        },
    });
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join(format!("session-{}.json", authority.binding.session_id)),
        session.to_string(),
    )
    .unwrap();
}

async fn parent_message(state: &ServiceState, context: &Value, interaction_id: &str) -> Value {
    invoke_orchestration(
        state,
        &format!("read-{interaction_id}"),
        "interaction.get",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "interactionId": interaction_id,
            "participant": context["coordinatorGrant"]["participant"],
            "readCapability": context["coordinatorGrant"]["deliveryCapability"],
        }),
    )
    .await["receipt"]
        .clone()
}

#[tokio::test]
async fn a_child_outcome_reaches_its_parent_once_as_a_durable_message() {
    let (_root, state, launcher, prompt_deliverer) = fixture_with_delivery(
        vec![LaunchOutcome::Succeed],
        vec![DeliveryOutcome::Succeed; 3],
    )
    .await;
    let (context, _) = prepare_exact_session_run(&state).await;
    let (child, _repository) = spawn_linked_child(&state).await;
    assert_eq!(launcher.requests().len(), 1);
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&child.plan.agent_id)
        .await
        .unwrap()
        .unwrap();
    let parent = AgentSpawnParentV1 {
        session_id: PARENT_SESSION.into(),
        workspace_id: PARENT_WORKSPACE.into(),
    };
    let epoch = authority.terminal_epoch.clone();
    let mut deliveries = ChildResultDeliveries::default();

    // A child that is still working has nothing to report.
    report_child(&state, &authority, "ready", "working", "none", "0");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert!(prompt_deliverer.requests().is_empty());

    // A finished turn opens one Message on the parent and wakes it once.
    report_child(&state, &authority, "ready", "waiting", "none", "1");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let turn = child_result_delivery::interaction_id(
        &child.operation_id,
        &parent,
        &format!("turn_completed:{epoch}:1"),
    );
    let message = parent_message(&state, &context, &turn).await;
    assert_eq!(message["kind"], "message");
    assert_eq!(message["common"]["title"], "fix-12 finished a turn");
    let body = message["common"]["descriptionMarkdown"].as_str().unwrap();
    assert!(body.starts_with("Your child Run **fix-12** finished a turn"));
    assert!(body.contains(child.operation_id.as_str()));
    let wakes = prompt_deliverer.requests();
    assert_eq!(wakes.len(), 1);
    assert_eq!(wakes[0].session.session_id, PARENT_SESSION);
    assert!(wakes[0].handoff.starts_with("Dure inbox message: "));

    // The same outcome is not sent again, nor after a restart forgets it.
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    child_result_delivery::tick(&state, &mut ChildResultDeliveries::default())
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 1);

    // A pending approval is its own outcome, and so is the Run's exit.
    report_child(
        &state,
        &authority,
        "ready",
        "working",
        "approval_required",
        "1",
    );
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let approval = child_result_delivery::interaction_id(
        &child.operation_id,
        &parent,
        &format!("approval_required:{epoch}:1"),
    );
    assert_eq!(
        parent_message(&state, &context, &approval).await["common"]["title"],
        "fix-12 needs approval"
    );
    report_child(&state, &authority, "exited", "waiting", "none", "2");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let exited = child_result_delivery::interaction_id(
        &child.operation_id,
        &parent,
        &format!("exited:{epoch}"),
    );
    assert_eq!(
        parent_message(&state, &context, &exited).await["common"]["title"],
        "fix-12 exited"
    );
    assert_eq!(prompt_deliverer.requests().len(), 3);

    // An exited Run is finished; nothing more is observed or sent.
    report_child(&state, &authority, "ready", "waiting", "none", "3");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 3);
}

#[tokio::test]
async fn a_child_whose_parent_exited_is_not_reported() {
    let (_root, state, _launcher, prompt_deliverer) =
        fixture_with_delivery(vec![LaunchOutcome::Succeed], Vec::new()).await;
    prepare_exact_session_run(&state).await;
    let (child, _repository) = spawn_linked_child(&state).await;
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&child.plan.agent_id)
        .await
        .unwrap()
        .unwrap();
    report_child(&state, &authority, "ready", "waiting", "none", "1");
    let parent = json!({
        "schema_version": 1,
        "session_id": PARENT_SESSION,
        "workspace_id": PARENT_WORKSPACE,
        "session_class": "managed",
        "lifecycle": "exited",
        "provider_id": "codex",
        "runner_principal": "coordinator-runner",
        "runner_instance": "coordinator-instance",
        "channel_epoch": "1",
        "host_instance_id": "coordinator-host",
        "terminal_epoch": "coordinator-terminal",
        "output_seq": "4",
        "health": "exited",
    });
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join(format!("session-{PARENT_SESSION}.json")),
        parent.to_string(),
    )
    .unwrap();
    let mut deliveries = ChildResultDeliveries::default();
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    // No delivery is attempted; the fixture has no wake outcome to give.
    assert!(prompt_deliverer.requests().is_empty());
}
