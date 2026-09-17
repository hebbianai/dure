use super::*;
use std::os::unix::fs::PermissionsExt;

#[tokio::test]
async fn failed_attach_keeps_the_conversation_allocated_before_its_failure() {
    for provider in [ManagedProviderKind::Codex, ManagedProviderKind::OpenCode] {
        let root = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let store = Arc::new(
            SqliteDomainStore::open(root.path().join("domain.sqlite"))
                .await
                .unwrap(),
        );
        tests::seed_provider(&store, root.path(), 1, provider.id()).await;
        let service = Arc::new(AgentConversationService::new(store.clone()));
        let agent = store
            .agent(&dure_app::AgentIdV1::new(format!("agent-{}-scale-0", provider.id())).unwrap())
            .await
            .unwrap()
            .unwrap();
        let request = StructuredProviderOpenRequestV1 {
            agent_id: agent.agent_id.clone(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: dure_app::ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        };
        let source = initial_binding(&agent, &request, "generation-fixture").unwrap();
        service.create(&source).await.unwrap();
        service
            .commit_provider_event(&dure_app::AgentProviderEventCommitV1 {
                schema_version: 1,
                interaction_session_id: source.interaction_session_id.clone(),
                event: dure_app::AgentProviderEventIdentityV1 {
                    runtime: source.runtime.clone(),
                    sequence: 1,
                },
                source_fingerprint: "fixture-allocated-conversation".into(),
                mutations: vec![
                    dure_app::AgentTimelineMutationV1::EstablishProviderConversation {
                        provider_conversation_ref: "conversation-allocated-before-failure".into(),
                        established_at_ms: 4,
                    },
                ],
                recorded_at_ms: 4,
            })
            .await
            .unwrap();
        let manager = ManagedStructuredRuntimeManager::new(
            ManagedStructuredRuntimeConfiguration::new(
                "generation-fixture",
                ManagedProviderExecutable::new(provider, None),
                "/bin/sh",
                "/bin/sh",
                root.path(),
                root.path(),
                root.path(),
            )
            .unwrap(),
            Arc::new(ProviderCredentialProfileRegistry::new(
                root.path().to_path_buf(),
                store.clone(),
            )),
            service,
            Arc::new(AgentConversationRuntimeRegistry::default()),
            store,
        );
        let recovered = manager.rotate_failed_binding(&source).await.unwrap();
        assert_eq!(
            recovered.provider_conversation_ref.as_deref(),
            Some("conversation-allocated-before-failure")
        );
        assert_eq!(
            recovered.interaction_session_id,
            source.interaction_session_id
        );
        assert_ne!(recovered.runtime, source.runtime);
        assert!(manager.rotate_failed_binding(&source).await.is_err());
        assert_eq!(
            manager
                .conversation_service
                .binding(&source.interaction_session_id)
                .await
                .unwrap(),
            Some(recovered),
            "a stale attach failure must not rotate a successor generation"
        );
    }
}
