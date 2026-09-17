use dure_app::{ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_launch_plan_with_initial_prompt,
};

#[test]
fn qwen_auto_edit_preserves_exact_resume_and_prompt_without_bypassing_shell_approval() {
    let plan = native_provider_launch_plan_with_initial_prompt(
        &ProviderIdV1::new("qwen-code").unwrap(),
        &ProviderPermissionModeV1::AutoEdit,
        None,
        None,
        NativeProviderConversationReference::Exact("conversation-1"),
        Some("Review 'quoted'\n한글"),
    )
    .expect("Qwen supports auto_edit independently of yolo")
    .unwrap();
    assert_eq!(plan.executable, "qwen");
    assert_eq!(
        plan.arguments,
        [
            "--approval-mode=auto-edit",
            "--resume",
            "conversation-1",
            "--prompt-interactive",
            "Review 'quoted'\n한글",
        ]
    );
}

#[test]
fn qwen_default_requires_approval_instead_of_inheriting_auto_mode() {
    let plan = native_provider_launch_plan_with_initial_prompt(
        &ProviderIdV1::new("qwen-code").unwrap(),
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Fresh,
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(plan.arguments, ["--approval-mode=default"]);
}

/// The native smoke consumes actual product launch plans, not duplicated flags.
#[test]
#[ignore = "materialized by the isolated Qwen Hmux conformance runner"]
fn publish_qwen_conformance_launches() {
    let output = std::env::var("DURE_QA_QWEN_PLANS").expect("fixture-owned output path");
    let provider = ProviderIdV1::new("qwen-code").unwrap();
    let model = "qwen-fixture";
    let mut plans = serde_json::Map::new();
    for (name, permission, conversation, prompt) in [
        (
            "initial",
            ProviderPermissionModeV1::Default,
            None,
            "DURE_QWEN_INITIAL 한글 'quoted'\nSecond line",
        ),
        (
            "default",
            ProviderPermissionModeV1::Default,
            None,
            "DURE_QWEN_DEFAULT",
        ),
        (
            "auto_edit",
            ProviderPermissionModeV1::AutoEdit,
            None,
            "DURE_QWEN_AUTO_EDIT",
        ),
        (
            "yolo",
            ProviderPermissionModeV1::SkipPermissions,
            None,
            "DURE_QWEN_YOLO",
        ),
        (
            "decoy",
            ProviderPermissionModeV1::Default,
            None,
            "DURE_QWEN_DECOY",
        ),
        (
            "resume",
            ProviderPermissionModeV1::Default,
            Some("__DURE_RESUME__"),
            "DURE_QWEN_RESUME",
        ),
    ] {
        let plan = native_provider_launch_plan_with_initial_prompt(
            &provider,
            &permission,
            Some(&dure_app::AgentSpawnModelSelectionV1::parse(model).unwrap()),
            None,
            conversation.map_or(
                NativeProviderConversationReference::Fresh,
                NativeProviderConversationReference::Exact,
            ),
            Some(prompt),
        )
        .unwrap()
        .unwrap();
        plans.insert(name.into(), serde_json::json!({"executable": plan.executable, "arguments": plan.arguments, "prompt": prompt, "model": model}));
    }
    std::fs::write(output, serde_json::to_vec(&plans).unwrap()).unwrap();
}
