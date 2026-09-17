use super::*;
use dure_app::{AgentRuntimeLaunchSelectionV1, AgentRuntimeSourceStopPolicyV1};

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn legacy_worker_removal_follows_the_checkout_before_native_replacement() {
    let fixture = DelegateCheckout::new().await;
    let active = receipt(&fixture.delegate().await.unwrap());
    let worker = active.session.as_ref().unwrap();
    let agent_id = AgentIdV1::new("legacy-delegate-worker").unwrap();
    // Previous backends published Native selection without the Agent resource
    // association. Keep that real legacy shape instead of moving a new claim.
    bind_source_conversation(&fixture.state, &agent_id, worker, None).await;
    assert!(
        fixture
            .state
            .store
            .agent_runtime_checkout(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    let replacement = replace_worker_native(&fixture, &agent_id, worker).await;
    assert_ne!(replacement.session_id(), worker.session_id);
    remove_worker(&fixture, &agent_id, &active).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn legacy_worker_removed_after_ordinary_stop_releases_its_retired_checkout() {
    let fixture = DelegateCheckout::new().await;
    let active = receipt(&fixture.delegate().await.unwrap());
    let worker = active.session.as_ref().unwrap();
    let agent_id = AgentIdV1::new("legacy-stopped-worker").unwrap();
    bind_source_conversation(&fixture.state, &agent_id, worker, None).await;
    agent_runtime_close_apply::apply(
        &fixture.state,
        "stop-legacy-worker",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        read_git_checkout_claims(&fixture.registration)
            .unwrap()
            .len(),
        2
    );
    assert!(
        fixture
            .state
            .store
            .agent_runtime_checkout(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    remove_worker(&fixture, &agent_id, &active).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn legacy_worker_already_replaced_before_upgrade_releases_its_original_checkout() {
    remove_previously_replaced_worker(0, 0).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn legacy_worker_rehost_after_settings_replacement_releases_its_original_checkout() {
    remove_previously_replaced_worker(0, 1).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn legacy_worker_rehost_before_settings_replacement_releases_its_original_checkout() {
    remove_previously_replaced_worker(1, 0).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the control-plane smoke"]
async fn legacy_worker_repeated_rehosts_around_settings_release_the_original_checkout() {
    remove_previously_replaced_worker(1, 2).await;
}

async fn remove_previously_replaced_worker(rehosts_before: i64, rehosts_after: i64) {
    let fixture = DelegateCheckout::new().await;
    let active = receipt(&fixture.delegate().await.unwrap());
    let worker = active.session.as_ref().unwrap();
    let agent_id = AgentIdV1::new("legacy-replaced-worker").unwrap();
    bind_source_conversation(&fixture.state, &agent_id, worker, Some(CONVERSATION)).await;
    report_worker_state(&fixture, worker, Some(CONVERSATION));
    for index in 0..rehosts_before {
        rehost_worker(
            &fixture,
            &agent_id,
            &format!("legacy-rehost-before-{index}"),
        )
        .await;
    }
    replace_before_upgrade(
        &fixture,
        &agent_id,
        AgentInteractionProfileV1::NativeCli,
        AgentRuntimeSourceStopPolicyV1::Discard,
        Some(AgentRuntimeLaunchSelectionV1 {
            model: None,
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
            permission_mode: None,
        }),
    )
    .await;
    for index in 0..rehosts_after {
        rehost_worker(&fixture, &agent_id, &format!("legacy-rehost-after-{index}")).await;
    }
    assert!(
        fixture
            .state
            .store
            .agent_runtime_checkout(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture
            .state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        2 + rehosts_before + rehosts_after
    );
    assert!(
        hmux_client::recovery_journal::managed_create_ledger::completed_create_receipt(
            &fixture.hmux.discovery,
            &worker.workspace_id,
            &worker.session_id,
        )
        .unwrap()
        .is_none(),
        "the original runtime is retired, not live create authority"
    );
    remove_worker(&fixture, &agent_id, &active).await;
}

pub(super) async fn replace_before_upgrade(
    fixture: &DelegateCheckout,
    agent_id: &AgentIdV1,
    target_interaction_profile: AgentInteractionProfileV1,
    source_stop_policy: AgentRuntimeSourceStopPolicyV1,
    target_launch_selection: Option<AgentRuntimeLaunchSelectionV1>,
) {
    let source = fixture
        .state
        .store
        .agent_runtime_selection(agent_id)
        .await
        .unwrap()
        .unwrap();
    let authority = fixture
        .state
        .store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .unwrap()
        .unwrap();
    // This retained admission predates the resource association. Drive its
    // actual stop/start/commit, without calling the new fresh-admission hook.
    let transition = fixture
        .state
        .store
        .admit_agent_runtime_transition(&dure_app::AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("legacy-effort-before-upgrade").unwrap(),
            idempotency_key: "legacy-effort-before-upgrade".into(),
            source,
            source_stop_policy,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::from_option(
                authority.binding.provider_conversation_id.clone(),
            )
            .unwrap(),
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli { authority },
            target_interaction_profile,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection,
            requested_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap();
    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&fixture.state, transition)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::Committed(_)
    ));
}

async fn rehost_worker(fixture: &DelegateCheckout, agent_id: &AgentIdV1, operation_id: &str) {
    let authority = fixture
        .state
        .store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .unwrap()
        .unwrap();
    let source = WorkflowSessionGenerationV1::from_checkpoint_authority(
        &authority,
        &ProviderIdV1::new("codex").unwrap(),
    );
    report_worker_state(fixture, &source, Some(CONVERSATION));
    let request = hmux_client::ManagedRehostRequest::new(
        operation_id,
        &source.session_id,
        &source.workspace_id,
        &source.runner_principal,
        &source.runner_instance,
        source.channel_epoch.parse().unwrap(),
        &source.host_instance_id,
        &source.terminal_epoch,
        true,
    )
    .unwrap();
    let receipt = hmux_client::ManagedSessionRehoster::new(
        &fixture.state.hmux_identity.runtime_executable_path,
        &fixture.hmux.root,
    )
    .with_discovery_root(&fixture.hmux.discovery)
    .rehost(request)
    .unwrap();
    crate::agent_runtime_native_rehost::request::apply(
        &fixture.state,
        serde_json::from_value(json!({
            "schemaVersion": 1, "agentId": agent_id, "operationId": receipt.operation_id(),
            "sourceSessionId": source.session_id, "sourceWorkspaceId": source.workspace_id,
        }))
        .unwrap(),
    )
    .await
    .unwrap();
}

async fn remove_worker(
    fixture: &DelegateCheckout,
    agent_id: &AgentIdV1,
    active: &DelegateOnceReceiptV1,
) {
    let removed = crate::agent_runtime_remove_apply::apply(
        &fixture.state,
        "remove-legacy-worker",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await;
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();

    // Observe product membership before fixture cleanup; cleaning the original
    // root manually must not turn a leaked product claim into a passing test.
    cleanup_adopted_checkout(fixture, agent_id, active).await;
    fixture.close_worker(active).await;
    fixture.hmux.stop(&fixture.coordinator);
    assert!(removed.is_ok(), "legacy removal failed: {removed:?}");
    assert_eq!(
        remaining.len(),
        1,
        "removing the new Native root must also end its original checkout lifetime",
    );
    assert_eq!(remaining[0].claim_id, fixture.coordinator_claim);
}
