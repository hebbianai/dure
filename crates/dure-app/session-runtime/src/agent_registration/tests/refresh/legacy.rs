use super::*;
use dure_app::{
    AgentCheckpointBindingAuthorityV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeCloseAdvanceRequestV1, AgentRuntimeCloseAdvanceV1, AgentRuntimeCloseIntentV1,
    AgentRuntimeCloseRecordV1, AgentRuntimeRemovalPlanV1, RuntimeKindIdV1, SessionBindingRecordV1,
    advance_agent_runtime_close_v1,
};

fn root(created: &CreatedManagedSession) -> ManagedCreateReconcileRequest {
    let receipt = created.receipt();
    ManagedCreateReconcileRequest::new(
        receipt.idempotency_key(),
        receipt.session_id(),
        receipt.workspace_id(),
    )
    .unwrap()
}

async fn publish(fixture: &Fixture, created: &CreatedManagedSession) -> AgentRuntimeCloseRecordV1 {
    publish_generation(fixture, created, 1).await
}

async fn publish_generation(
    fixture: &Fixture,
    created: &CreatedManagedSession,
    generation: i64,
) -> AgentRuntimeCloseRecordV1 {
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id(),
        provider_id: ProviderIdV1::new("local-shell").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 1,
    };
    fixture
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let receipt = created.receipt();
    let fence = receipt.generation_fence().unwrap();
    let native = AgentCheckpointBindingAuthorityV1 {
        schema_version: 1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: receipt.session_id().into(),
            provider_conversation_id: None,
            credential_reference_id: None,
            binding_generation: generation,
            bound_at_ms: generation,
        },
        runtime_workspace_id: receipt.workspace_id().into(),
        runner_principal: fence.runner_principal().into(),
        runner_instance: fence.runner_instance().into(),
        channel_epoch: fence.channel_epoch().to_string(),
        host_instance_id: fence.host_instance_id().into(),
        terminal_epoch: fence.terminal_epoch().into(),
        updated_at_ms: generation,
    };
    fixture
        .store
        .upsert_agent_checkpoint_binding_authority(&native)
        .await
        .unwrap();
    AgentRuntimeCloseRecordV1::admitted(AgentRuntimeCloseIntentV1 {
        schema_version: 1,
        operation_id: operation("legacy-remove"),
        idempotency_key: "legacy-remove".into(),
        source: selection,
        source_authority: AgentRuntimeBindingAuthorityV1::NativeCli { authority: native },
        stopped_transition: None,
        requested_at_ms: 2,
    })
    .unwrap()
}

async fn mixed_version_source(
    fixture: &Fixture,
) -> (
    AgentRuntimeCloseRecordV1,
    ManagedCreateReconcileRequest,
    CreatedManagedSession,
    dure_app::SessionCheckoutRecordV1,
) {
    let original =
        ManagedCreateReconcileRequest::new("legacy-create", "legacy-session", "workspace").unwrap();
    let created = ready(
        fixture
            .runtime
            .advance(fixture.request(&original))
            .await
            .unwrap(),
    );
    let close = publish(fixture, &created).await;
    let source = fixture
        .runtime
        .checkout_for_managed_create(original.clone())
        .await
        .unwrap()
        .unwrap();
    let retained = fixture
        .store
        .adopt_agent_runtime_checkout(
            &close.intent.source,
            &close.intent.source_authority,
            &source,
        )
        .await
        .unwrap()
        .unwrap();
    // Older Refresh acquired an independent claim after a settings transition
    // had already adopted the original claim into the Agent lifetime.
    let request = fixture.request(&original);
    let target = hmux_client::managed_replacement_root_request(&request).unwrap();
    let legacy = ready(
        fixture
            .runtime
            .execute_create(target, None, true, move |creator, _| {
                creator.replace_current_and_advance(request)
            })
            .await
            .unwrap(),
    );
    let close = publish_generation(fixture, &legacy, 2).await;
    assert_eq!(fixture.claims(), 2);
    assert!(
        fixture
            .store
            .agent_checkout_roots(&retained.binding)
            .await
            .unwrap()
            .is_empty()
    );
    (close, original, legacy, retained)
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn mixed_version_refresh_keeps_the_agent_lifetime_and_retires_the_duplicate_claim() {
    let fixture = Fixture::new(true).await;
    let (close, original, legacy, retained) = mixed_version_source(&fixture).await;
    let legacy_root = root(&legacy);
    let result = fixture
        .runtime
        .replace_current_and_advance(fixture.request(&legacy_root))
        .await;
    let mut roots = vec![original, legacy_root.clone()];
    let success = matches!(
        &result,
        Ok(ManagedCreateAdvanceResolution::Current(_)
            | ManagedCreateAdvanceResolution::Advanced(_))
    );
    let error = format!("{result:?}");
    let mut repeated = false;
    if let Ok(
        ManagedCreateAdvanceResolution::Current(next)
        | ManagedCreateAdvanceResolution::Advanced(next),
    ) = result
    {
        roots.push(root(&next));
        assert_eq!(fixture.claims(), 1);
        assert_eq!(
            fixture
                .store
                .agent_runtime_checkout(&agent_id())
                .await
                .unwrap(),
            Some(retained.clone())
        );
        let replay = ready(
            fixture
                .runtime
                .replace_current_and_advance(fixture.request(&legacy_root))
                .await
                .unwrap(),
        );
        assert_eq!(next.session().descriptor(), replay.session().descriptor());
        let git_file = fixture.checkout.join(".git");
        let saved = std::fs::read(&git_file).unwrap();
        std::fs::write(&git_file, b"invalid git pointer\n").unwrap();
        let again = fixture
            .runtime
            .replace_current_and_advance(fixture.request(&root(&next)))
            .await;
        std::fs::write(&git_file, saved).unwrap();
        if let Ok(
            ManagedCreateAdvanceResolution::Current(next)
            | ManagedCreateAdvanceResolution::Advanced(next),
        ) = again
        {
            roots.push(root(&next));
            repeated = true;
        }
    }
    cleanup(&fixture, close, roots).await;
    assert!(success, "mixed-version Refresh failed: {error}");
    assert!(repeated, "later Refresh must not consult Git again");
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn failed_mixed_version_refresh_preserves_the_source_and_both_claims_until_removal() {
    let fixture = Fixture::new(true).await;
    let (close, original, legacy, retained) = mixed_version_source(&fixture).await;
    let legacy_root = root(&legacy);
    let request = ManagedCreateRequest::new(
        legacy_root.idempotency_key(),
        legacy_root.session_id(),
        legacy_root.workspace_id(),
        "local-shell",
        PermissionMode::Default,
        &fixture.checkout,
        vec![
            fixture
                .checkout
                .join("missing-provider")
                .to_str()
                .unwrap()
                .into(),
        ],
        24,
        80,
    )
    .unwrap();
    let result = fixture.runtime.replace_current_and_advance(request).await;
    assert!(!matches!(
        result,
        Ok(ManagedCreateAdvanceResolution::Current(_)
            | ManagedCreateAdvanceResolution::Advanced(_))
    ));
    assert_eq!(
        probe_local_process_generation(&legacy.session().descriptor().provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert_eq!(fixture.claims(), 2);
    assert_eq!(
        fixture
            .store
            .agent_checkout_for_root(&managed_identity(
                &fixture.runtime.namespace,
                legacy_root.idempotency_key(),
                legacy_root.session_id(),
                legacy_root.workspace_id(),
            ))
            .await
            .unwrap(),
        Some(retained.binding)
    );
    cleanup(&fixture, close, vec![original, legacy_root]).await;
}

async fn cleanup(
    fixture: &Fixture,
    close: AgentRuntimeCloseRecordV1,
    roots: Vec<ManagedCreateReconcileRequest>,
) {
    for root in &roots {
        fixture.runtime.close(root.clone()).await.unwrap();
    }
    let checkout = fixture
        .store
        .agent_runtime_checkout(&agent_id())
        .await
        .unwrap();
    if let Some(checkout) = checkout {
        let stopped = advance_agent_runtime_close_v1(
            &close,
            &AgentRuntimeCloseAdvanceRequestV1 {
                schema_version: 1,
                operation_id: close.intent.operation_id.clone(),
                expected_journal_revision: close.journal_revision,
                advance: AgentRuntimeCloseAdvanceV1::Stopped,
                advanced_at_ms: 3,
            },
        )
        .unwrap();
        fixture
            .runtime
            .finish_agent_removal(
                &stopped,
                &AgentRuntimeRemovalPlanV1 {
                    checkout: Some(checkout.binding),
                    managed_roots: roots
                        .iter()
                        .map(|root| {
                            managed_identity(
                                &fixture.runtime.namespace,
                                root.idempotency_key(),
                                root.session_id(),
                                root.workspace_id(),
                            )
                        })
                        .collect(),
                },
            )
            .await
            .unwrap();
    }
    assert_eq!(fixture.claims(), 0);
    fixture.store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn legacy_refresh_retains_the_original_claim_across_unpublished_replacements() {
    let fixture = Fixture::new(true).await;
    let original =
        ManagedCreateReconcileRequest::new("legacy-create", "legacy-session", "workspace").unwrap();
    let created = ready(
        fixture
            .runtime
            .advance(fixture.request(&original))
            .await
            .unwrap(),
    );
    let close = publish(&fixture, &created).await;
    let source = fixture
        .runtime
        .checkout_for_managed_create(original.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(
        fixture
            .store
            .agent_runtime_checkout(&agent_id())
            .await
            .unwrap()
            .is_none()
    );
    let mut roots = vec![original];
    let mut retained = Vec::new();
    for _ in 0..2 {
        let started = std::time::Instant::now();
        let next = ready(
            fixture
                .runtime
                .replace_current_and_advance(fixture.request(roots.last().unwrap()))
                .await
                .unwrap(),
        );
        eprintln!("legacy Refresh: {:?}", started.elapsed());
        roots.push(root(&next));
        retained.push(
            fixture
                .store
                .agent_runtime_checkout(&agent_id())
                .await
                .unwrap()
                .map(|record| record.binding.claim_id),
        );
        assert_eq!(fixture.claims(), 1);
    }
    // Do not publish a successor: a lost UI response must not lose the
    // retained roots or make the second Refresh acquire an independent claim.
    cleanup(&fixture, close, roots).await;
    assert_eq!(
        retained,
        vec![Some(source.claim_id.clone()), Some(source.claim_id)]
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn adopted_legacy_refresh_replays_then_no_longer_consults_git() {
    let fixture = Fixture::new(true).await;
    let original =
        ManagedCreateReconcileRequest::new("legacy-create", "legacy-session", "workspace").unwrap();
    let created = ready(
        fixture
            .runtime
            .advance(fixture.request(&original))
            .await
            .unwrap(),
    );
    let close = publish(&fixture, &created).await;
    let source = fixture
        .runtime
        .checkout_for_managed_create(original.clone())
        .await
        .unwrap()
        .unwrap();
    // Simulate an existing control-plane adoption, or response loss after its
    // durable transfer but before the first Refresh claim acknowledgement.
    fixture
        .store
        .adopt_agent_runtime_checkout(
            &close.intent.source,
            &close.intent.source_authority,
            &source,
        )
        .await
        .unwrap();
    let first = ready(
        fixture
            .runtime
            .replace_current_and_advance(fixture.request(&original))
            .await
            .unwrap(),
    );
    let replay = ready(
        fixture
            .runtime
            .replace_current_and_advance(fixture.request(&original))
            .await
            .unwrap(),
    );
    assert_eq!(first.session().descriptor(), replay.session().descriptor());
    let git_file = fixture.checkout.join(".git");
    let saved = std::fs::read(&git_file).unwrap();
    std::fs::write(&git_file, b"invalid git pointer\n").unwrap();
    let second = fixture
        .runtime
        .replace_current_and_advance(fixture.request(&root(&first)))
        .await;
    std::fs::write(&git_file, saved).unwrap();
    let success = matches!(
        &second,
        Ok(ManagedCreateAdvanceResolution::Current(_)
            | ManagedCreateAdvanceResolution::Advanced(_))
    );
    let mut roots = vec![original, root(&first)];
    if let Ok(
        ManagedCreateAdvanceResolution::Current(created)
        | ManagedCreateAdvanceResolution::Advanced(created),
    ) = second
    {
        roots.push(root(&created));
    }
    cleanup(&fixture, close, roots).await;
    assert!(
        success,
        "a retained legacy Refresh must not read Git metadata"
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn failed_legacy_refresh_preserves_the_live_source_and_original_claim() {
    let fixture = Fixture::new(true).await;
    let original =
        ManagedCreateReconcileRequest::new("legacy-create", "legacy-session", "workspace").unwrap();
    let created = ready(
        fixture
            .runtime
            .advance(fixture.request(&original))
            .await
            .unwrap(),
    );
    let close = publish(&fixture, &created).await;
    let source = fixture
        .runtime
        .checkout_for_managed_create(original.clone())
        .await
        .unwrap()
        .unwrap();
    let request = ManagedCreateRequest::new(
        original.idempotency_key(),
        original.session_id(),
        original.workspace_id(),
        "local-shell",
        PermissionMode::Default,
        &fixture.checkout,
        vec![
            fixture
                .checkout
                .join("missing-provider")
                .to_str()
                .unwrap()
                .into(),
        ],
        24,
        80,
    )
    .unwrap();
    let result = fixture.runtime.replace_current_and_advance(request).await;
    assert!(!matches!(
        result,
        Ok(ManagedCreateAdvanceResolution::Current(_)
            | ManagedCreateAdvanceResolution::Advanced(_))
    ));
    assert_eq!(
        probe_local_process_generation(&created.session().descriptor().provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert_eq!(fixture.claims(), 1);
    let retained = fixture
        .store
        .agent_runtime_checkout(&agent_id())
        .await
        .unwrap();
    assert_eq!(
        fixture.removal("during-failed-legacy-refresh"),
        Err("checkout_use_in_use")
    );
    cleanup(&fixture, close, vec![original]).await;
    assert_eq!(retained.unwrap().binding.claim_id, source.claim_id);
}
