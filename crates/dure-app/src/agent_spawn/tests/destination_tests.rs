use super::*;

#[test]
fn explicit_destination_binds_the_plan_without_changing_legacy_wire_or_token() {
    let legacy = create_agent_spawn_plan_v1(draft()).unwrap();
    assert_eq!(
        legacy.plan_token.as_str(),
        "sha256:86c1d20b95b068995c144845e8412f718a18493528b6d140ede705e6ae681b08"
    );
    let document = serde_json::to_value(&legacy).unwrap();
    assert!(
        document["request"]["worktree"]
            .get("checkout_path")
            .is_none()
    );
    assert!(document["request"]["worktree"].get("branch_mode").is_none());
    assert_eq!(
        serde_json::from_value::<AgentSpawnPlanV1>(document).unwrap(),
        legacy
    );

    let mut selected = draft();
    if let AgentSpawnWorktreePolicyV1::Dedicated { checkout_path, .. } =
        &mut selected.request.worktree
    {
        *checkout_path = Some("/selected/work/codex-1".into());
    }
    let selected = create_agent_spawn_plan_v1(selected).unwrap();
    assert_ne!(selected.plan_token, legacy.plan_token);
    let mut document = serde_json::to_value(&selected).unwrap();
    assert_eq!(
        serde_json::from_value::<AgentSpawnPlanV1>(document.clone()).unwrap(),
        selected
    );
    document["request"]["worktree"]["checkout_path"] = json!("/another/codex-1");
    assert!(serde_json::from_value::<AgentSpawnPlanV1>(document).is_err());
}

#[test]
fn existing_branch_mode_binds_the_plan_without_changing_legacy_defaults() {
    let legacy = create_agent_spawn_plan_v1(draft()).unwrap();
    let mut selected = draft();
    if let AgentSpawnWorktreePolicyV1::Dedicated { branch_mode, .. } =
        &mut selected.request.worktree
    {
        *branch_mode = AgentSpawnBranchModeV1::Existing;
    }
    let selected = create_agent_spawn_plan_v1(selected).unwrap();
    assert_ne!(selected.plan_token, legacy.plan_token);
    let mut document = serde_json::to_value(&selected).unwrap();
    assert_eq!(
        serde_json::from_value::<AgentSpawnPlanV1>(document.clone()).unwrap(),
        selected
    );
    document["request"]["worktree"]["branch_mode"] = json!("create");
    assert!(serde_json::from_value::<AgentSpawnPlanV1>(document).is_err());
}
