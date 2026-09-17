use dure_app::{ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_launch_plan_with_initial_prompt,
};

#[test]
fn gemini_auto_edit_preserves_exact_resume_and_prompt_without_bypassing_shell_approval() {
    let plan = native_provider_launch_plan_with_initial_prompt(
        &ProviderIdV1::new("gemini").unwrap(),
        &ProviderPermissionModeV1::AutoEdit,
        None,
        None,
        NativeProviderConversationReference::Exact("conversation-1"),
        Some("Review 'quoted'\n한글"),
    )
    .expect("Gemini supports auto_edit independently of yolo")
    .unwrap();
    assert_eq!(plan.executable, "gemini");
    assert_eq!(
        plan.arguments,
        [
            "--approval-mode=auto_edit",
            "--resume",
            "conversation-1",
            "--prompt-interactive",
            "Review 'quoted'\n한글",
        ]
    );
}

/// The native smoke consumes actual product launch plans, not duplicated flags.
#[test]
#[ignore = "materialized by the isolated Gemini Hmux conformance runner"]
fn publish_gemini_conformance_launches() {
    let output = std::env::var("DURE_QA_GEMINI_PLANS").expect("fixture-owned output path");
    let provider = ProviderIdV1::new("gemini").unwrap();
    let model = "gemini-3.5-flash";
    let mut plans = serde_json::Map::new();
    for (name, permission, conversation, prompt) in [
        (
            "initial",
            ProviderPermissionModeV1::Default,
            None,
            "DURE_GEMINI_INITIAL 한글 'quoted'\nSecond line",
        ),
        (
            "default",
            ProviderPermissionModeV1::Default,
            None,
            "DURE_GEMINI_DEFAULT",
        ),
        (
            "auto_edit",
            ProviderPermissionModeV1::AutoEdit,
            None,
            "DURE_GEMINI_AUTO_EDIT",
        ),
        (
            "yolo",
            ProviderPermissionModeV1::SkipPermissions,
            None,
            "DURE_GEMINI_YOLO",
        ),
        (
            "decoy",
            ProviderPermissionModeV1::Default,
            None,
            "DURE_GEMINI_DECOY",
        ),
        (
            "resume",
            ProviderPermissionModeV1::Default,
            Some("__DURE_RESUME__"),
            "DURE_GEMINI_RESUME",
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
