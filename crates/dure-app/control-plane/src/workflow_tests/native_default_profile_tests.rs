use super::*;

#[tokio::test]
async fn native_default_without_selectors_refuses_private_environment() {
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            include_rehost_recipe: true,
            source_provider_id: "amp",
            agent_provider_id: ProviderIdV1::new("amp").unwrap(),
            provider_state_environment: ProviderStateEnvironment::new(BTreeMap::from([(
                "CODEX_HOME".into(),
                "/fixture/private-profile".into(),
            )]))
            .unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let body = legacy_binding_body(&root);
    let agent_id = body.agent_id.clone();
    assert_eq!(
        ensure_binding(&state, body).await.unwrap_err(),
        "agent_checkpoint_binding_credential_authority_unsupported"
    );
    assert!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn native_default_without_profile_selectors_can_adopt_its_exact_launch() {
    for provider in ["amp", "copilot", "pi"] {
        let provider_id = ProviderIdV1::new(provider).unwrap();
        let expected =
            provider_credential_profile::native_provider_state_environment(&provider_id, None)
                .unwrap();
        assert!(expected.is_empty());
        let (root, state, _, _, _) = fixture_with_source_launch_authority(
            Vec::new(),
            vec![DeliveryOutcome::Succeed],
            vec![ActivityOutcome::Observed("9")],
            HmuxPermissionMode::Default,
            "coordinator-terminal",
            SourceLaunchAuthorityFixture {
                include_rehost_recipe: true,
                source_provider_id: provider,
                provider_state_environment: expected,
                agent_provider_id: provider_id.clone(),
                ..SourceLaunchAuthorityFixture::default()
            },
        )
        .await;
        let body = legacy_binding_body(&root);
        let agent_id = body.agent_id.clone();
        ensure_binding(&state, body).await.unwrap();
        let selection = state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selection.provider_id, provider_id);
        assert_eq!(
            selection.execution_profile,
            AgentExecutionProfileV1::ProviderDefault
        );
        assert_eq!(selection.revision, 1);
    }
}
