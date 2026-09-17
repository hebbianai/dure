use super::*;
use dure_app::*;
use tokio::time::{Duration, timeout};

pub(super) type Manager = ManagedStructuredRuntimeManager<SqliteDomainStore>;

pub(super) fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap())
        .canonicalize()
        .unwrap()
}

pub(super) fn open_request(
    agent_id: &AgentIdV1,
    conversation: Option<String>,
    settings: &ProviderTurnSettings,
) -> StructuredProviderOpenRequestV1 {
    StructuredProviderOpenRequestV1 {
        agent_id: agent_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: conversation,
        permission_mode: settings.permission_mode.clone(),
        model: settings.model.clone(),
        effort: settings.effort.clone(),
    }
}

pub(super) fn turn_intent(
    binding: &AgentInteractionBindingV1,
    key: &str,
    input: &str,
) -> AgentStartTurnIntentV1 {
    AgentStartTurnIntentV1 {
        schema_version: 1,
        interaction_session_id: binding.interaction_session_id.clone(),
        runtime: binding.runtime.clone(),
        turn_id: AgentTurnIdV1::new(format!("turn-{key}")).unwrap(),
        client_message_id: AgentClientMessageIdV1::new(format!("client-{key}")).unwrap(),
        input: input.into(),
        requested_at_ms: now_ms().unwrap(),
    }
}

pub(super) async fn bridge(
    manager: &Manager,
    binding: &AgentInteractionBindingV1,
) -> Arc<dyn ManagedProviderConnection> {
    let slot = manager
        .slots
        .lock()
        .await
        .get(&binding.interaction_session_id)
        .unwrap()
        .clone();
    slot.lock().await.as_ref().unwrap().bridge.clone()
}

pub(super) async fn page(
    service: &AgentConversationService<SqliteDomainStore>,
    binding: &AgentInteractionBindingV1,
) -> AgentTimelinePageV1 {
    let read = service
        .read(&AgentTimelineReadRequestV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id.clone(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 128,
        })
        .await
        .unwrap();
    let AgentTimelineReadV1::Page { page } = read else {
        panic!("timeline reset")
    };
    page
}

pub(super) async fn wait_completed(
    service: &AgentConversationService<SqliteDomainStore>,
    binding: &AgentInteractionBindingV1,
    turn: &AgentTurnIdV1,
) {
    timeout(Duration::from_secs(20), async {
        loop {
            let page = page(service, binding).await;
            if page.rows.iter().any(|row| {
                row.item.turn_id.as_ref() == Some(turn)
                    && matches!(
                        row.item.body,
                        AgentTimelineItemBodyV1::Lifecycle {
                            state: AgentTimelineLifecycleStateV1::TurnCompleted,
                            ..
                        }
                    )
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
}

pub(super) async fn admit(
    store: &SqliteDomainStore,
    binding: &AgentInteractionBindingV1,
    next: &ProviderTurnSettings,
    index: usize,
) -> AgentRuntimeTransitionRecordV1 {
    store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new(format!(
                "{}-switch-{index}",
                binding.provider_id.as_str()
            ))
            .unwrap(),
            idempotency_key: format!("{}-switch-key-{index}", binding.provider_id.as_str()),
            source: store
                .agent_runtime_selection(&binding.agent_id)
                .await
                .unwrap()
                .unwrap(),
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            },
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: binding
                .provider_conversation_ref
                .as_deref()
                .map(|id| AgentProviderConversationPlanV1::resume(id).unwrap())
                .unwrap_or_default(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: binding.execution_profile.clone(),
            target_launch_selection: Some(AgentRuntimeLaunchSelectionV1 {
                model: next.model.clone(),
                effort: next.effort.clone(),
                permission_mode: Some(next.permission_mode.clone()),
            }),
            requested_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap()
}

pub(super) async fn advance(
    store: &SqliteDomainStore,
    transition: &AgentRuntimeTransitionRecordV1,
    advance: AgentRuntimeTransitionAdvanceV1,
) -> AgentRuntimeTransitionRecordV1 {
    store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: transition.intent.operation_id.clone(),
            expected_journal_revision: transition.journal_revision,
            advance,
            advanced_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap()
}

pub(super) async fn fixture(
    root: &Path,
    reconnect: bool,
    provider: ManagedProviderKind,
    executable: PathBuf,
) -> (
    Arc<SqliteDomainStore>,
    Arc<AgentConversationService<SqliteDomainStore>>,
    Manager,
) {
    for directory in ["state", "discovery", "credentials"] {
        let path = root.join(directory);
        if !path.exists() {
            tests::owner_directory(&path);
        }
    }
    let store = Arc::new(
        SqliteDomainStore::open(root.join("domain.sqlite"))
            .await
            .unwrap(),
    );
    if !reconnect {
        tests::seed_provider(&store, root, 1, provider.id()).await;
    }
    let service = Arc::new(AgentConversationService::new(store.clone()));
    let manager = Manager::new(
        ManagedStructuredRuntimeConfiguration::new(
            if reconnect {
                "fixture-reconnected"
            } else {
                "fixture-initial"
            },
            ManagedProviderExecutable::new(provider, Some(executable)),
            env_path("DURE_QA_CONTROL_PLANE_BIN"),
            env_path("DURE_QA_HMUX_RUNTIME"),
            root.join("discovery"),
            root.join("state"),
            root.join("state"),
        )
        .unwrap(),
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.join("credentials"),
            store.clone(),
        )),
        service.clone(),
        Arc::new(AgentConversationRuntimeRegistry::default()),
        store.clone(),
    );
    (store, service, manager)
}
