use dure_app::{AgentSpawnModelSelectionV1, ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_session_launch_plan,
};

#[test]
fn amp_fresh_start_retains_an_exact_resume_recipe() {
    let plan = native_provider_session_launch_plan(
        &ProviderIdV1::new("amp").unwrap(),
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Fresh,
        "conversation-id",
    )
    .unwrap()
    .expect("Amp fresh start must not require an existing conversation");
    assert_eq!(plan.launch.executable, "amp");
    assert!(plan.launch.arguments.is_empty());
    assert_eq!(
        plan.resume_arguments.unwrap(),
        ["threads", "continue", "conversation-id"]
    );
}

#[test]
fn amp_rejects_unreviewed_selections_and_unsafe_thread_ids() {
    let provider = ProviderIdV1::new("amp").unwrap();
    for mode in [
        ProviderPermissionModeV1::AutoEdit,
        ProviderPermissionModeV1::SkipPermissions,
    ] {
        assert_eq!(
            native_provider_session_launch_plan(
                &provider,
                &mode,
                None,
                None,
                NativeProviderConversationReference::Fresh,
                "conversation-id"
            )
            .unwrap_err()
            .as_str(),
            "permission_mode_unsupported"
        );
    }
    let model = AgentSpawnModelSelectionV1::parse("unreviewed-model").unwrap();
    assert_eq!(
        native_provider_session_launch_plan(
            &provider,
            &ProviderPermissionModeV1::Default,
            Some(&model),
            None,
            NativeProviderConversationReference::Fresh,
            "conversation-id"
        )
        .unwrap_err()
        .as_str(),
        "model_selection_unsupported"
    );
    for identity in [
        "--last",
        "--pick",
        "",
        "thread id",
        "thread;command",
        "thread\ncommand",
    ] {
        assert_eq!(
            native_provider_session_launch_plan(
                &provider,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::Exact(identity),
                "conversation-id"
            )
            .unwrap_err()
            .as_str(),
            "conversation_resume_identity_invalid"
        );
    }
}

#[test]
fn amp_exact_resume_preserves_the_thread_identity_as_one_argument() {
    let plan = native_provider_session_launch_plan(
        &ProviderIdV1::new("amp").unwrap(),
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Exact("T-019e0000-1234-7000-8000-000000000001"),
        "conversation-id",
    )
    .unwrap()
    .expect("Amp supports explicit thread continuation");
    assert_eq!(
        plan.launch.arguments,
        [
            "threads",
            "continue",
            "T-019e0000-1234-7000-8000-000000000001"
        ]
    );
}
