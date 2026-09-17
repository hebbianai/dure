use dure_app::{AgentSpawnModelSelectionV1, ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{NativeProviderConversationReference, native_provider_launch_plan};
use std::process::Command;

/// Exercise the product's argv against a supplied CLI without starting a
/// conversation or reading credentials. Handwritten smoke-test argv missed
/// the removal of --full-auto from Codex 0.154.0-alpha.3.
#[test]
#[ignore = "requires DURE_QA_CODEX_BIN pointing to the Codex version under qualification"]
fn codex_accepts_permission_plans_for_fresh_and_resumed_sessions() {
    let executable = std::env::var_os("DURE_QA_CODEX_BIN").expect("DURE_QA_CODEX_BIN");
    let provider = ProviderIdV1::new("codex").unwrap();
    let model = AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap();
    for mode in [
        ProviderPermissionModeV1::Default,
        ProviderPermissionModeV1::AutoEdit,
        ProviderPermissionModeV1::SkipPermissions,
    ] {
        for conversation in [
            NativeProviderConversationReference::Fresh,
            NativeProviderConversationReference::Exact("019f0000-0000-7000-8000-000000000001"),
        ] {
            let plan =
                native_provider_launch_plan(&provider, &mode, Some(&model), None, conversation)
                    .unwrap()
                    .unwrap();
            let output = Command::new(&executable)
                .args(&plan.arguments)
                .arg("--help")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{mode:?} / {conversation:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
