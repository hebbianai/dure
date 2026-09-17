use super::*;
use crate::managed_structured_runtime::{
    ManagedProviderExecutable, ManagedProviderKind, ManagedStructuredRuntimeConfiguration,
    ManagedStructuredRuntimeManager,
};

#[tokio::test]
#[ignore = "requires isolated real Hmux, control-plane driver and app-server protocol fixture"]
async fn delegated_worker_chat_removal_uses_the_managed_provider_runtime() {
    remove_chat_worker(RemovalSource::Adopted).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux, control-plane driver and app-server protocol fixture"]
async fn legacy_worker_converted_to_chat_before_upgrade_releases_its_original_checkout() {
    remove_chat_worker(RemovalSource::Legacy).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux, control-plane driver and app-server protocol fixture"]
async fn legacy_chat_worker_failed_replacement_removal_uses_the_retained_source() {
    remove_chat_worker(RemovalSource::LegacyFailedReplacement).await;
}

enum RemovalSource {
    Adopted,
    Legacy,
    LegacyFailedReplacement,
}

async fn remove_chat_worker(source: RemovalSource) {
    let mut fixture = DelegateCheckout::new().await;
    let active = receipt(&fixture.delegate().await.unwrap());
    let worker = active.session.as_ref().unwrap();
    let agent_id = AgentIdV1::new("backend-delegate-worker").unwrap();
    let legacy_selection = !matches!(source, RemovalSource::Adopted);
    if legacy_selection {
        bind_source_conversation(&fixture.state, &agent_id, worker, None).await;
    } else {
        fixture.adopt_worker(worker).await;
    }
    report_worker_state(&fixture, worker, None);
    let retained = fixture
        .state
        .store
        .agent_runtime_checkout(&agent_id)
        .await
        .unwrap();
    install_structured_runtime(&mut fixture);
    let converted = if legacy_selection {
        super::legacy_removal::replace_before_upgrade(
            &fixture,
            &agent_id,
            AgentInteractionProfileV1::StructuredProtocol,
            dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            None,
        )
        .await;
        Ok(())
    } else {
        agent_runtime_transition_apply::apply(
            &fixture.state,
            "delegate-to-chat",
            agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
                target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                expected_source_revision: Some(1),
                source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
                target_execution_profile: None,
                target_launch_selection: None,
            },
        )
        .await
        .map(|_| ())
    };
    let target_failure = fixture
        .state
        .store
        .active_agent_runtime_transition(&agent_id)
        .await
        .unwrap()
        .and_then(|transition| transition.target_failure);
    assert!(
        converted.is_ok(),
        "actual managed structured conversion failed: {converted:?}; target: {target_failure:?}"
    );
    let binding = fixture
        .state
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let turn = fixture
        .state
        .agent_conversations
        .start_turn_intent(&dure_app::AgentStartTurnIntentV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id.clone(),
            runtime: binding.runtime.clone(),
            turn_id: dure_app::AgentTurnIdV1::new("turn-remove-chat-worker").unwrap(),
            client_message_id: dure_app::AgentClientMessageIdV1::new("message-remove-chat-worker")
                .unwrap(),
            input: "fixture removal turn".into(),
            requested_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(turn.state, dure_app::AgentTurnEffectStateV1::Accepted);
    let binding = fixture
        .state
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert!(binding.provider_conversation_ref.is_some());
    assert_eq!(
        fixture
            .state
            .store
            .agent_runtime_checkout(&agent_id)
            .await
            .unwrap(),
        retained
    );
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
        .filter(|session| {
            session.session_id != worker.session_id
                && session.session_id != fixture.coordinator.session_id
        })
        .collect::<Vec<_>>();
    let [driver] = drivers.as_slice() else {
        panic!("the converted worker must have exactly one Hmux-owned Chat driver");
    };
    assert_eq!(
        hmux_client::probe_local_session_exact(&catalog, driver),
        hmux_client::SessionProbeStatus::Healthy
    );
    if matches!(source, RemovalSource::LegacyFailedReplacement) {
        park_failed_replacement(&fixture, &agent_id, binding).await;
    }
    let stopped = crate::agent_runtime_remove_apply::apply(
        &fixture.state,
        "remove-chat-worker",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await;
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    assert!(
        stopped.is_ok(),
        "actual managed structured removal failed: {stopped:?}"
    );
    let after = catalog
        .find(&hmux_client::SessionSelector::new(
            &driver.session_id,
            Some(driver.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(after.host_process, driver.host_process);
    assert_eq!(after.lifecycle, hmux_client::SessionLifecycle::Exited);
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
        dure_app::SessionCheckoutAdmissionV1::Closed
    );
    assert_eq!(inspect(&fixture.state, &agent_id).await["state"], "closed");
    fixture.close_worker(&active).await;
    fixture.hmux.stop(&fixture.coordinator);
}

pub(super) fn install_structured_runtime(
    fixture: &mut DelegateCheckout,
) -> Arc<ManagedStructuredRuntimeManager<SqliteDomainStore>> {
    // Production uses a short socket alias; this isolated root is already short.
    let configuration = ManagedStructuredRuntimeConfiguration::new(
        &fixture.state.descriptor.generation,
        ManagedProviderExecutable::new(
            ManagedProviderKind::Codex,
            Some(env_executable("DURE_CODEX_APP_SERVER_FIXTURE_BIN")),
        ),
        env_executable("DURE_QA_CONTROL_PLANE_BIN"),
        &fixture.state.hmux_identity.runtime_executable_path,
        &fixture.hmux.discovery,
        &fixture.hmux.root,
        &fixture.hmux.root,
    )
    .unwrap();
    let manager = Arc::new(ManagedStructuredRuntimeManager::new(
        configuration,
        Arc::clone(&fixture.state.credential_profiles),
        Arc::new(crate::agent_conversation::AgentConversationService::new(
            Arc::clone(&fixture.state.store),
        )),
        Arc::clone(&fixture.state.agent_conversation_runtimes),
        Arc::clone(&fixture.state.store),
    ));
    let mut runtimes =
        crate::structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(ProviderIdV1::new("codex").unwrap(), manager.clone())
        .unwrap();
    fixture.state.structured_runtimes = Arc::new(runtimes);
    fixture.state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    manager
}

async fn park_failed_replacement(
    fixture: &DelegateCheckout,
    agent_id: &AgentIdV1,
    source_binding: dure_app::AgentInteractionBindingV1,
) {
    let source = fixture
        .state
        .store
        .agent_runtime_selection(agent_id)
        .await
        .unwrap()
        .unwrap();
    // Bypass only the new resource adoption hook to model a pre-upgrade
    // transition. Stop, target launch, failure cleanup and publication are real.
    let admitted = fixture
        .state
        .store
        .admit_agent_runtime_transition(&dure_app::AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("legacy-chat-failed-replacement").unwrap(),
            idempotency_key: "legacy-chat-failed-replacement".into(),
            source: source.clone(),
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: source_binding.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::from_option(
                source_binding.provider_conversation_ref.clone(),
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: source.execution_profile.clone(),
            target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
                model: None,
                effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
                permission_mode: None,
            }),
            requested_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap();
    // The protocol fixture rejects resume. Production must retire that exact
    // failed driver and retain the stopped source in RepairRequired.
    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&fixture.state, admitted)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::RepairRequired,
    ));
    let parked = fixture
        .state
        .store
        .active_agent_runtime_transition(agent_id)
        .await
        .unwrap()
        .unwrap();
    let current = fixture
        .state
        .store
        .agent_interaction_for_agent(agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(current.runtime, source_binding.runtime);
    assert_eq!(parked.intent.source, source);
    assert_eq!(
        parked.replacement_authority.unwrap().0,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: current },
    );
    assert!(
        fixture
            .state
            .store
            .agent_runtime_checkout(agent_id)
            .await
            .unwrap()
            .is_none()
    );
}

fn env_executable(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).expect("the isolated runner must pin its executables"))
        .canonicalize()
        .unwrap()
}
