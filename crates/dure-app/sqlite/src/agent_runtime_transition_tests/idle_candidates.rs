use super::*;

#[tokio::test]
async fn idle_candidates_are_read_only_bounded_native_selection_pages() {
    let root = tempfile::tempdir().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    assert!(
        store
            .agent_runtime_native_candidates(None)
            .await
            .unwrap()
            .is_empty()
    );
    for index in 0..66 {
        let mut selection = native_selection();
        selection.agent_id = AgentIdV1::new(format!("idle-agent-{index:03}")).unwrap();
        if index == 65 {
            selection.interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
        }
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: selection.agent_id.clone(),
                workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
                provider_id: selection.provider_id.clone(),
                display_name: "Idle candidate".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .initialize_agent_runtime_selection(&selection)
            .await
            .unwrap();
    }
    let first = store.agent_runtime_native_candidates(None).await.unwrap();
    assert_eq!(first.len(), 64);
    assert_eq!(first[0].as_str(), "idle-agent-000");
    assert_eq!(first[63].as_str(), "idle-agent-063");
    let second = store
        .agent_runtime_native_candidates(first.last())
        .await
        .unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].as_str(), "idle-agent-064");
    assert!(
        store
            .agent_runtime_native_candidates(second.last())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.agent_runtime_native_candidates(None).await.unwrap(),
        first
    );
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .agent_runtime_selection(&second[0])
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );
}
