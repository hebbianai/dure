use super::*;
use hmux_client::recovery_journal::managed_create_ledger::{
    checkpoint_retirement_exact, finalize_retirement_exact,
};

async fn retired_source(
    finalized: bool,
) -> (
    TempDir,
    ServiceState,
    AgentRuntimeSelectionV1,
    AgentCheckpointBindingAuthorityV1,
) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let agent_id = AgentIdV1::new("coordinator-1").unwrap();
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id,
        provider_id: ProviderIdV1::new("provider.codex").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 2,
    };
    let request = ManagedStopRequest::new(
        "exited-retirement-before-close",
        &authority.binding.session_id,
        &authority.runtime_workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        &authority.runner_principal,
        &authority.runner_instance,
        authority.channel_epoch.parse().unwrap(),
        &authority.host_instance_id,
        &authority.terminal_epoch,
    )
    .unwrap();
    let stop = ManagedStopReceipt::from_request(
        &request,
        ManagedStopOutcome::AlreadyExited,
        "managed_provider_already_exited",
    )
    .unwrap();
    checkpoint_retirement_exact(&state.hmux_identity.discovery_root, &stop).unwrap();
    if finalized {
        finalize_retirement_exact(&state.hmux_identity.discovery_root, &stop).unwrap();
    }
    // There is no discoverable Host in this storage fixture. Any new broker
    // invocation must fail, rather than fabricate a second successful stop.
    state.hmux_identity.runtime_executable_path = root.path().join("missing-runtime");
    (root, state, selection, authority)
}

#[tokio::test]
async fn native_close_reuses_final_retirement_from_another_stop_without_discovery() {
    let (_root, state, selection, authority) = retired_source(true).await;
    for key in ["new-close", "new-close-replay"] {
        let result = agent_runtime_transition_apply::native::stop_current(
            &state,
            &selection,
            &authority,
            &OperationIdV1::new(key).unwrap(),
        )
        .await;
        assert!(
            result.is_ok(),
            "final exact retirement must not require another broker"
        );
    }
}

#[tokio::test]
async fn native_close_does_not_accept_unfinished_retirement_as_stopped() {
    let (_root, state, selection, authority) = retired_source(false).await;
    assert!(
        agent_runtime_transition_apply::native::stop_current(
            &state,
            &selection,
            &authority,
            &OperationIdV1::new("unfinished-close").unwrap(),
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn native_close_refuses_retirement_for_a_different_selected_generation() {
    let (_root, state, selection, original) = retired_source(true).await;
    for (index, field) in ["principal", "runner", "channel", "host", "terminal"]
        .into_iter()
        .enumerate()
    {
        let mut authority = original.clone();
        authority.binding.binding_generation += index as i64 + 1;
        match field {
            "principal" => authority.runner_principal = "different-principal".into(),
            "runner" => authority.runner_instance = "different-runner".into(),
            "channel" => authority.channel_epoch = "2".into(),
            "host" => authority.host_instance_id = "different-host".into(),
            "terminal" => authority.terminal_epoch = "different-terminal".into(),
            _ => unreachable!(),
        }
        state
            .store
            .upsert_agent_checkpoint_binding_authority(&authority)
            .await
            .unwrap();
        let result = agent_runtime_transition_apply::native::stop_current(
            &state,
            &selection,
            &authority,
            &OperationIdV1::new(format!("changed-{field}")).unwrap(),
        )
        .await;
        assert!(
            matches!(
                result,
                Err(crate::agent_runtime_stop_boundary::SourceStopFailure::SourceRetained)
            ),
            "{field}: a mismatched receipt must refuse before any broker"
        );
    }
}
