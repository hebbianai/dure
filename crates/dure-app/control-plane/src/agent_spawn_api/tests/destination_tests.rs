use super::*;

#[tokio::test]
async fn service_resolved_base_does_not_replace_a_changed_checkout_destination() {
    changed_worktree_input_is_not_replaced(false).await;
}

#[tokio::test]
async fn service_resolved_base_does_not_replace_a_changed_existing_branch_mode() {
    changed_worktree_input_is_not_replaced(true).await;
}

async fn changed_worktree_input_is_not_replaced(change_branch_mode: bool) {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let mut first = dedicated_request(&"a".repeat(40), "agent/codex-1");
    if let AgentSpawnWorktreePolicyV1::Dedicated { checkout_path, .. } = &mut first.worktree {
        *checkout_path = Some("/repo/custom/codex-1".into());
    }
    let original = preview_with_service_resolved_base(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        first.clone(),
        1,
    )
    .await
    .unwrap();
    let mut changed = first;
    if let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch_mode,
        checkout_path,
        ..
    } = &mut changed.worktree
    {
        *base_commit_sha = "b".repeat(40);
        if change_branch_mode {
            *branch_mode = dure_app::AgentSpawnBranchModeV1::Existing;
        } else {
            *checkout_path = Some("/repo/another/codex-1".into());
        }
    }
    let result = preview_with_service_resolved_base(
        &store,
        &providers,
        "dure-local",
        "generation-2",
        project(),
        changed,
        2,
    )
    .await;
    assert_eq!(result.unwrap_err(), "agent_spawn_idempotency_conflict");
    assert_eq!(
        store
            .agent_spawn_receipt(&original.operation_id)
            .await
            .unwrap()
            .unwrap(),
        original
    );
}
