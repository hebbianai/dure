use dure_app::{AgentSpawnModelSelectionV1, ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_launch_plan_with_initial_prompt,
    native_provider_session_launch_plan,
};
use std::process::Command;

#[test]
fn fresh_native_run_retains_an_exact_resume_recipe_for_its_persisted_model() {
    let plan = native_provider_session_launch_plan(
        &ProviderIdV1::new("opencode").unwrap(),
        &ProviderPermissionModeV1::SkipPermissions,
        Some(&AgentSpawnModelSelectionV1::parse("fixture/model").unwrap()),
        None,
        NativeProviderConversationReference::Fresh,
        "__DURE_CONVERSATION__",
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        plan.launch.arguments,
        ["--auto", "--model", "fixture/model"]
    );
    assert_eq!(
        plan.resume_arguments.unwrap(),
        ["--auto", "--session", "__DURE_CONVERSATION__"]
    );
}

#[test]
fn opencode_delivers_the_fresh_prompt_as_a_named_argument() {
    let provider = ProviderIdV1::new("opencode").unwrap();
    let model = AgentSpawnModelSelectionV1::parse("fixture/model").unwrap();
    let plan = native_provider_launch_plan_with_initial_prompt(
        &provider,
        &ProviderPermissionModeV1::SkipPermissions,
        Some(&model),
        None,
        NativeProviderConversationReference::Fresh,
        Some("한글 입력 'quoted'\ncontinue the same work"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        plan.arguments,
        [
            "--auto",
            "--model",
            "fixture/model",
            "--prompt",
            "한글 입력 'quoted'\ncontinue the same work"
        ]
    );
}

#[test]
fn opencode_does_not_claim_that_resume_delivered_an_ignored_prompt() {
    let result = native_provider_launch_plan_with_initial_prompt(
        &ProviderIdV1::new("opencode").unwrap(),
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Exact("ses_exact_fixture"),
        Some("continue this conversation"),
    );
    assert_eq!(
        result.unwrap_err().as_str(),
        "initial_prompt_launch_unsupported"
    );
}

#[test]
fn opencode_refuses_a_model_override_that_native_resume_would_ignore() {
    let result = native_provider_launch_plan_with_initial_prompt(
        &ProviderIdV1::new("opencode").unwrap(),
        &ProviderPermissionModeV1::Default,
        Some(&AgentSpawnModelSelectionV1::parse("fixture/alternate").unwrap()),
        None,
        NativeProviderConversationReference::Exact("ses_exact_fixture"),
        None,
    );
    assert_eq!(result.unwrap_err().as_str(), "model_selection_unsupported");
}

/// Qualify the product's argv, including namespaced model IDs, against the
/// exact CLI being shipped. The optional plan output feeds the PTY fixture.
#[test]
#[ignore = "requires DURE_QA_OPENCODE_BIN pointing to the OpenCode version under qualification"]
fn opencode_accepts_fresh_and_exact_launch_plans() {
    let executable = std::env::var_os("DURE_QA_OPENCODE_BIN").expect("DURE_QA_OPENCODE_BIN");
    let provider = ProviderIdV1::new("opencode").unwrap();
    let mut plans = Vec::new();
    for permission in [
        ProviderPermissionModeV1::Default,
        ProviderPermissionModeV1::SkipPermissions,
    ] {
        let model =
            AgentSpawnModelSelectionV1::parse(if permission == ProviderPermissionModeV1::Default {
                "fixture/fixture-model"
            } else {
                "fixture/fixture-alternate"
            })
            .unwrap();
        for conversation in [
            NativeProviderConversationReference::Fresh,
            NativeProviderConversationReference::Exact("ses_exact_fixture"),
        ] {
            let plan = native_provider_launch_plan_with_initial_prompt(
                &provider,
                &permission,
                matches!(conversation, NativeProviderConversationReference::Fresh)
                    .then_some(&model),
                None,
                conversation,
                matches!(conversation, NativeProviderConversationReference::Fresh)
                    .then_some("한글 입력 'quoted'\nkeep this conversation"),
            )
            .unwrap()
            .unwrap();
            let output = Command::new(&executable)
                .args(&plan.arguments)
                .arg("--help")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{permission:?} / {conversation:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            plans.push(serde_json::json!({"arguments": plan.arguments}));
        }
    }
    if let Some(path) = std::env::var_os("DURE_QA_OPENCODE_PLANS") {
        std::fs::write(path, serde_json::to_vec(&plans).unwrap()).unwrap();
    }
}
