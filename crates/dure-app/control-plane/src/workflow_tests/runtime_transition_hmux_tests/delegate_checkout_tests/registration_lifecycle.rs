use super::*;
use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntime,
};
use dure_app::SessionCheckoutAdmissionV1;
use dure_session_runtime::{AgentCheckoutRegistrationV1, CheckoutSessionRuntime};

async fn register(fixture: &DelegateCheckout) -> AgentCheckoutRegistrationV1 {
    let agent_id = AgentIdV1::new("registered-chat-agent").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-1").unwrap();
    assert!(
        fixture
            .state
            .store
            .agent(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    let workspace = fixture
        .state
        .store
        .workspace(&workspace_id)
        .await
        .unwrap()
        .unwrap();
    runtime(fixture)
        .register_agent_checkout(
            OperationIdV1::new("registered-chat-incarnation").unwrap(),
            dure_app::AgentBootstrapV1 {
                agent_id,
                runtime_workspace_id: workspace_id,
                provider_id: ProviderIdV1::new("codex").unwrap(),
                working_directory: workspace.root_path,
                display_name: "Registered Chat".into(),
            },
        )
        .await
        .unwrap()
}

fn runtime(fixture: &DelegateCheckout) -> CheckoutSessionRuntime {
    CheckoutSessionRuntime::at_root(
        fixture.state.store.as_ref().clone(),
        fixture.state.hmux_identity.runtime_executable_path.clone(),
        fixture.hmux.discovery.clone(),
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires isolated real Hmux, control-plane driver and app-server protocol fixture"]
async fn registered_chat_first_removal_releases_the_never_launched_native_root() {
    let mut fixture = DelegateCheckout::new().await;
    let registered = register(&fixture).await;
    let manager = super::structured_removal::install_structured_runtime(&mut fixture);
    let agent_id = AgentIdV1::new("registered-chat-agent").unwrap();
    let binding = manager
        .open(StructuredProviderOpenRequestV1 {
            agent_id: agent_id.clone(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        })
        .await
        .unwrap();
    fixture
        .state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: binding.provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: binding.execution_profile.clone(),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: binding.updated_at_ms,
        })
        .await
        .unwrap();
    assert_eq!(
        read_git_checkout_claims(&fixture.registration)
            .unwrap()
            .len(),
        2
    );
    let catalog = hmux_client::LocalSessionCatalog::new(&fixture.hmux.discovery);
    let drivers = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| session.session_id != fixture.coordinator.session_id)
        .collect::<Vec<_>>();
    let [driver] = drivers.as_slice() else {
        panic!("exactly one Chat driver required")
    };
    assert_ne!(driver.session_id, registered.root.session_id());
    let removed = crate::agent_runtime_remove_apply::apply(
        &fixture.state,
        "remove-registered-chat",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await;
    // Stop the unrelated owned fixture even when the removal assertion fails.
    fixture.hmux.stop(&fixture.coordinator);
    assert!(removed.is_ok(), "Chat-first removal failed: {removed:?}");
    let after = catalog
        .find(&hmux_client::SessionSelector::new(
            &driver.session_id,
            Some(driver.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(after.host_process, driver.host_process);
    assert_eq!(after.lifecycle, hmux_client::SessionLifecycle::Exited);
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].claim_id, fixture.coordinator_claim);
    assert_eq!(
        fixture
            .state
            .store
            .agent_runtime_checkout(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .admission,
        SessionCheckoutAdmissionV1::Closed
    );
    assert!(
        runtime(&fixture)
            .register_agent_checkout(
                OperationIdV1::new("registered-chat-incarnation").unwrap(),
                dure_app::AgentBootstrapV1 {
                    agent_id,
                    runtime_workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
                    provider_id: ProviderIdV1::new("codex").unwrap(),
                    working_directory: registered.binding.working_directory.clone(),
                    display_name: "Registered Chat".into(),
                },
            )
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "requires isolated real Hmux and the process guardian"]
async fn backend_restart_finishes_registered_preselection_cancellation() {
    let mut fixture = DelegateCheckout::new().await;
    let registered = register(&fixture).await;
    fixture
        .state
        .store
        .begin_agent_registration_close(&registered.binding)
        .await
        .unwrap();
    make_fixture_mutation_authority(&mut fixture.state);
    let (reopened, launcher) =
        reopen_fixture_service_state(&fixture.state, fixture.state.store.database_path()).await;
    let reopened = Arc::new(reopened);
    let recovery = tokio::spawn(crate::agent_runtime_recovery::run(Arc::clone(&reopened)));
    let completed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if reopened
                .store
                .session_checkout(&registered.binding.identity)
                .await
                .unwrap()
                .is_some_and(|record| record.admission == SessionCheckoutAdmissionV1::Closed)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    recovery.abort();
    let _ = recovery.await;
    fixture.hmux.stop(&fixture.coordinator);
    completed.expect("startup recovery must finish cancellation without catalog or user request");
    assert!(launcher.requests().is_empty());
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].claim_id, fixture.coordinator_claim);
    assert!(
        !reopened
            .store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .contains(&AgentIdV1::new("registered-chat-agent").unwrap())
    );
}
