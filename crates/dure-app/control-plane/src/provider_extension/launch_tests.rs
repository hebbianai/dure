use super::*;
use hmux_client::{MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, ManagedRehostRecipe};
use std::sync::atomic::{AtomicUsize, Ordering};

const CONVERSATION: &str = "019f0000-0000-7000-8000-000000000001";

#[test]
fn session_launch_and_resume_conform_to_the_existing_provider_adapter() {
    let registry = test_local_agent_provider_registry();
    let cases = reviewed_native_provider_ids()
        .map(|provider| (provider, ProviderPermissionModeV1::Default, None, None))
        .chain([
            (
                "codex",
                ProviderPermissionModeV1::AutoEdit,
                Some("gpt-6-astra"),
                Some("high"),
            ),
            (
                "codex",
                ProviderPermissionModeV1::SkipPermissions,
                Some("gpt-5.6-sol"),
                Some("ultra"),
            ),
            (
                "claude",
                ProviderPermissionModeV1::AutoEdit,
                Some("opus"),
                Some("high"),
            ),
            (
                "claude",
                ProviderPermissionModeV1::SkipPermissions,
                Some("ultracode"),
                None,
            ),
        ]);
    for (provider, permission, model, effort) in cases {
        let provider = ProviderIdV1::new(provider).unwrap();
        let model = model.map(|model| AgentSpawnModelSelectionV1::parse(model).unwrap());
        let effort = effort.map(|effort| AgentSpawnEffortSelectionV1::parse(effort).unwrap());
        for conversation in [None, Some(CONVERSATION)] {
            if provider.as_str() == "continue" && conversation.is_some() {
                assert!(
                    registry
                        .launch_plan(
                            &provider,
                            &permission,
                            model.as_ref(),
                            effort.as_ref(),
                            conversation
                        )
                        .is_err()
                );
                continue;
            }
            let plan = registry
                .session_launch_plan(
                    &provider,
                    &permission,
                    model.as_ref(),
                    effort.as_ref(),
                    conversation,
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
                )
                .unwrap()
                .unwrap();
            let expected_launch = registry
                .launch_plan(
                    &provider,
                    &permission,
                    model.as_ref(),
                    effort.as_ref(),
                    conversation,
                )
                .unwrap()
                .unwrap();
            assert_eq!(plan.launch, expected_launch);
            if provider.as_str() == "continue" {
                assert!(plan.resume_arguments.is_none());
                continue;
            }
            let exact = registry
                .launch_plan(
                    &provider,
                    &permission,
                    model.as_ref(),
                    effort.as_ref(),
                    Some(CONVERSATION),
                )
                .unwrap()
                .unwrap();
            let recipe = ManagedRehostRecipe::new(
                std::iter::once(plan.launch.executable)
                    .chain(plan.resume_arguments.unwrap())
                    .collect(),
                None,
            )
            .unwrap();
            assert_eq!(
                recipe.render_command(CONVERSATION).unwrap(),
                std::iter::once(exact.executable)
                    .chain(exact.arguments)
                    .collect::<Vec<_>>(),
                "resume must preserve the provider's selection: {}",
                provider.as_str(),
            );
        }
    }
}

struct ChangingIntegration(AtomicUsize);

#[test]
fn pi_native_settings_launch_installs_the_reporter_and_keeps_the_exact_selection() {
    let registry = test_local_agent_provider_registry();
    let plan = registry
        .session_launch_plan(
            &ProviderIdV1::new("pi").unwrap(),
            &ProviderPermissionModeV1::Default,
            Some(&AgentSpawnModelSelectionV1::parse("fixture/model-b").unwrap()),
            Some(&AgentSpawnEffortSelectionV1::parse("low").unwrap()),
            Some(CONVERSATION),
            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        )
        .unwrap()
        .unwrap();
    assert_eq!(plan.launch.executable, "/fixture/managed-pi-launch.sh");
    assert_eq!(plan.launch.arguments[0], "pi");
    for pair in [
        ["--session", CONVERSATION],
        ["--model", "fixture/model-b"],
        ["--thinking", "low"],
    ] {
        assert!(plan.launch.arguments.windows(2).any(|args| args == pair));
    }
    let recipe = ManagedRehostRecipe::new(
        std::iter::once(plan.launch.executable.clone())
            .chain(plan.resume_arguments.unwrap())
            .collect(),
        None,
    )
    .unwrap();
    assert_eq!(
        recipe.render_command(CONVERSATION).unwrap(),
        std::iter::once(plan.launch.executable)
            .chain(plan.launch.arguments)
            .collect::<Vec<_>>(),
    );
}

struct NativeWrapperIntegration;

#[test]
#[cfg(unix)]
fn gemini_fresh_and_exact_resume_share_the_published_native_hook() {
    let registry = test_local_agent_provider_registry();
    let provider = ProviderIdV1::new("gemini").unwrap();
    for conversation in [None, Some(CONVERSATION)] {
        let plan = registry
            .session_launch_plan(
                &provider,
                &ProviderPermissionModeV1::AutoEdit,
                Some(&AgentSpawnModelSelectionV1::parse("gemini-3.5-flash").unwrap()),
                None,
                conversation,
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
            )
            .unwrap()
            .unwrap();
        assert_eq!(plan.launch.executable, "/fixture/managed-gemini-launch.sh");
        assert_eq!(plan.launch.arguments[0], "gemini");
        assert!(
            plan.launch
                .arguments
                .contains(&"--approval-mode=auto_edit".into())
        );
        let recipe = ManagedRehostRecipe::new(
            std::iter::once(plan.launch.executable)
                .chain(plan.resume_arguments.unwrap())
                .collect(),
            None,
        )
        .unwrap();
        let resumed = recipe.render_command(CONVERSATION).unwrap();
        assert_eq!(
            &resumed[..2],
            ["/fixture/managed-gemini-launch.sh", "gemini"]
        );
        assert!(
            resumed
                .windows(2)
                .any(|pair| pair == ["--resume", CONVERSATION])
        );
    }
    let missing = NativeAgentProviders::new(
        BTreeSet::new(),
        Arc::new(StaticProviderRuntimeIntegrationSource {
            integrations: BTreeMap::new(),
        }),
    );
    assert_eq!(
        missing
            .launch_plan(
                &provider,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                None
            )
            .unwrap_err()
            .as_str(),
        "provider_runtime_integration_unavailable"
    );
}

impl ProviderRuntimeIntegrationSource for NativeWrapperIntegration {
    fn integration(
        &self,
        _: &ProviderIdV1,
    ) -> Result<ProviderRuntimeIntegrationV1, ExtensionFailureCodeV1> {
        Ok(ProviderRuntimeIntegrationV1::CommandWrapper {
            path: "/fixture/channel/native-codex.sh".into(),
        })
    }
}

#[test]
fn native_wrapper_preserves_pinned_executable_and_exact_resume_recipe() {
    let provider = BundledAgentProvider::new(
        "test.native.codex",
        "Codex",
        "codex",
        "/fixture/pinned-codex",
        Arc::new(NativeWrapperIntegration),
        false,
    );
    let codex = ProviderIdV1::new("codex").unwrap();
    let plan = provider
        .session_launch_plan(
            &codex,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            None,
            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        )
        .unwrap();
    assert_eq!(plan.launch.executable, "/fixture/channel/native-codex.sh");
    assert_eq!(plan.launch.arguments[0], "/fixture/pinned-codex");
    let recipe = ManagedRehostRecipe::new(
        std::iter::once(plan.launch.executable)
            .chain(plan.resume_arguments.unwrap())
            .collect(),
        None,
    )
    .unwrap();
    let resumed = provider
        .launch_plan(
            &codex,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            Some(CONVERSATION),
        )
        .unwrap();
    assert_eq!(
        recipe.render_command(CONVERSATION).unwrap(),
        std::iter::once(resumed.executable)
            .chain(resumed.arguments)
            .collect::<Vec<_>>()
    );
}

impl ProviderRuntimeIntegrationSource for ChangingIntegration {
    fn integration(
        &self,
        _provider_id: &ProviderIdV1,
    ) -> Result<ProviderRuntimeIntegrationV1, ExtensionFailureCodeV1> {
        let generation = self.0.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderRuntimeIntegrationV1::NotificationCommand {
            command: vec![format!("/fixture/hook-{generation}.sh")],
        })
    }
}

#[test]
fn session_launch_reads_the_runtime_integration_once_for_both_commands() {
    let integration = Arc::new(ChangingIntegration(AtomicUsize::new(0)));
    let provider = BundledAgentProvider::new(
        "test.native.codex",
        "Test Codex",
        "codex",
        "/fixture/selected-codex",
        integration.clone(),
        false,
    );
    let plan = provider
        .session_launch_plan(
            &ProviderIdV1::new("codex").unwrap(),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            None,
            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        )
        .unwrap();
    assert_eq!(integration.0.load(Ordering::SeqCst), 1);
    assert_eq!(plan.launch.executable, "/fixture/selected-codex");
    for arguments in [
        &plan.launch.arguments,
        plan.resume_arguments.as_ref().unwrap(),
    ] {
        assert!(
            arguments
                .iter()
                .any(|argument| argument.contains("/fixture/hook-0.sh"))
        );
        assert!(
            !arguments
                .iter()
                .any(|argument| argument.contains("/fixture/hook-1.sh"))
        );
    }
}

struct LaunchOnlyProvider(ExtensionDescriptorV1);

impl ExtensionImplementation for LaunchOnlyProvider {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.0
    }
    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        ExtensionProbeOutcomeV1::Available
    }
}

impl AgentProviderImplementation for LaunchOnlyProvider {
    fn preflight_plan(
        &self,
        _provider_id: &ProviderIdV1,
    ) -> Result<AgentProviderPreflightPlanV1, ExtensionFailureCodeV1> {
        Ok(AgentProviderPreflightPlanV1 {
            executable: "/fixture/custom-provider".into(),
        })
    }
}

#[test]
fn launch_only_provider_does_not_inherit_a_recipe_from_its_id() {
    let mut registry = AgentProviderRegistry::default();
    register_provider(
        &mut registry,
        LaunchOnlyProvider(
            NativeAgentProviders::new(BTreeSet::new(), test_integration_source()).descriptor,
        ),
    );
    let plan = registry
        .session_launch_plan(
            &ProviderIdV1::new("kimi").unwrap(),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            None,
            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        )
        .unwrap()
        .unwrap();
    assert_eq!(plan.launch.executable, "/fixture/custom-provider");
    assert!(plan.launch.arguments.is_empty());
    assert!(plan.resume_arguments.is_none());
}

#[test]
#[cfg(unix)]
fn native_launch_and_resume_bind_channel_without_interpreting_provider_arguments() {
    struct Channel;
    impl ProviderRuntimeIntegrationSource for Channel {
        fn app_channel(&self) -> Option<&str> {
            Some("stable")
        }
        fn integration(
            &self,
            _: &ProviderIdV1,
        ) -> Result<ProviderRuntimeIntegrationV1, ExtensionFailureCodeV1> {
            Err(integration_unavailable())
        }
    }
    let literal = "literal $HOME `false` ' quoted";
    let mut plan = dure_app::AgentProviderSessionLaunchPlanV1 {
        launch: AgentProviderLaunchPlanV1 {
            executable: "/usr/bin/printenv".into(),
            arguments: vec!["DURE_APP_CHANNEL".into()],
        },
        resume_arguments: Some(vec!["DURE_APP_CHANNEL".into()]),
    };
    super::launch::bind_session_channel(&Channel, &mut plan).unwrap();
    dure_app::WorkflowSessionLaunchRequestV1 {
        runtime_kind_id: dure_app::RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        launch_idempotency_key: "test-launch".into(),
        session_id: "test-session".into(),
        workspace_id: "test-workspace".into(),
        provider_id: ProviderIdV1::new("claude").unwrap(),
        provider_conversation_ref: None,
        permission_mode: ProviderPermissionModeV1::Default,
        provider_executable: plan.launch.executable.clone(),
        provider_arguments: plan.launch.arguments.clone(),
        provider_resume: None,
        initial_prompt: Some("test".into()),
        working_directory: "/tmp".into(),
        prelaunch_command: None,
    }
    .validate()
    .expect("channel binding must fit the existing runtime launch contract");
    for args in [
        &plan.launch.arguments,
        plan.resume_arguments.as_ref().unwrap(),
    ] {
        let output = std::process::Command::new(&plan.launch.executable)
            .args(args)
            .env("DURE_APP_CHANNEL", "dev-wrong")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"stable\n");
    }
    let mut echo = AgentProviderLaunchPlanV1 {
        executable: "/usr/bin/printf".into(),
        arguments: vec!["%s".into(), literal.into()],
    };
    super::launch::wrap_launch_channel(&mut echo, "stable", Some(Path::new("/fixture/space path")));
    let output = std::process::Command::new(&echo.executable)
        .args(echo.arguments)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), literal);
}

#[test]
#[cfg(unix)]
fn managed_environment_removes_build_overrides_and_preserves_isolation_and_credentials() {
    let mut plan = AgentProviderLaunchPlanV1 {
        executable: "/usr/bin/env".into(),
        arguments: vec![],
    };
    super::launch::wrap_launch_channel(&mut plan, "stable", None);
    let mut command = std::process::Command::new(plan.executable);
    command
        .args(plan.arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin");
    for key in dure_provider_adapter::managed_environment::INHERITED_LAUNCH_KEYS {
        command.env(key, "synthetic-parent");
    }
    for key in [
        "HOME",
        "DURE_HOME",
        "HMUX_DISCOVERY_ROOT",
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_API_KEY",
        "CARGO_HOME",
    ] {
        command.env(key, "synthetic-preserved");
    }
    let output = command.output().unwrap();
    assert!(output.status.success());
    let values: std::collections::BTreeMap<_, _> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    for key in dure_provider_adapter::managed_environment::INHERITED_LAUNCH_KEYS {
        assert_eq!(
            values.get(key).copied(),
            if *key == "DURE_APP_CHANNEL" {
                Some("stable")
            } else {
                None
            },
            "{key}"
        );
    }
    for key in [
        "HOME",
        "DURE_HOME",
        "HMUX_DISCOVERY_ROOT",
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_API_KEY",
        "CARGO_HOME",
    ] {
        assert_eq!(values.get(key), Some(&"synthetic-preserved"));
    }
}
