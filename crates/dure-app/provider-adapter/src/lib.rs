//! Provider-owned native CLI launch arguments shared by every Dure host.
//!
//! The control plane journals semantic selections; OS adapters execute the
//! resulting argv. Keeping the reviewed provider spellings here prevents
//! spawn, recovery, and rehost paths from silently drifting apart.

pub mod claude_continuation;
pub mod managed_environment;

use dure_app::{
    AgentProviderLaunchPlanV1, AgentProviderPreflightPlanV1, AgentProviderPromptTargetV1,
    AgentProviderSessionLaunchPlanV1, AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1,
    ExtensionFailureCodeV1, ProviderIdV1, ProviderPermissionModeV1, ProviderRuntimeIntegrationV1,
    agent_provider_launch_prompt_is_valid, codex_lifecycle_hook_arguments_v1,
};

const CODEX_MANAGED_STARTUP_CONFIG: &str = "check_for_update_on_startup=false";

#[derive(Clone, Copy)]
enum ResumeArgument {
    Unsupported,
    Adjacent(&'static [&'static str]),
    Inline(&'static str),
}

#[derive(Clone, Copy)]
enum EffortArgument {
    Flag(&'static str),
    CodexConfig,
    ClaudeFlag,
}

/// A native flag may be accepted by the parser but ignored by its resume route.
/// Prompt and model delivery consume the same reviewed applicability rule.
#[derive(Clone, Copy)]
enum LaunchFlag {
    Always(&'static str),
    FreshOnly(&'static str),
}

impl LaunchFlag {
    fn resolve(self, conversation: Option<&str>) -> Option<&'static str> {
        match self {
            Self::Always(flag) => Some(flag),
            Self::FreshOnly(flag) if conversation.is_none() => Some(flag),
            Self::FreshOnly(_) => None,
        }
    }
}

#[derive(Clone, Copy)]
enum PromptDelivery {
    ProviderEvent,
    Stdin,
    Positional,
    FramedPositional,
    FreshFramedPositional,
    Named(LaunchFlag),
}

impl PromptDelivery {
    fn target(self, conversation: Option<&str>) -> AgentProviderPromptTargetV1 {
        match self {
            Self::ProviderEvent => AgentProviderPromptTargetV1::ProviderEvent,
            Self::FreshFramedPositional if conversation.is_some() => {
                AgentProviderPromptTargetV1::ProviderEvent
            }
            Self::Named(flag) if flag.resolve(conversation).is_none() => {
                AgentProviderPromptTargetV1::ProviderEvent
            }
            Self::Stdin
            | Self::Positional
            | Self::FramedPositional
            | Self::FreshFramedPositional
            | Self::Named(_) => AgentProviderPromptTargetV1::LaunchArgument,
        }
    }

    fn arguments(
        self,
        conversation: Option<&str>,
        prompt: &str,
    ) -> Result<Vec<String>, ExtensionFailureCodeV1> {
        if !agent_provider_launch_prompt_is_valid(prompt) {
            return Err(failure("initial_prompt_invalid"));
        }
        if self.target(conversation) != AgentProviderPromptTargetV1::LaunchArgument {
            return Err(failure("initial_prompt_launch_unsupported"));
        }
        match self {
            Self::ProviderEvent | Self::Stdin => Err(failure("initial_prompt_launch_unsupported")),
            Self::Positional => Ok(vec!["--".to_owned(), prompt.to_owned()]),
            // ponytail: these CLIs dispatch positional command words even after
            // --. A leading newline frames literal input until they expose an
            // unambiguous interactive prompt option.
            Self::FramedPositional | Self::FreshFramedPositional => {
                Ok(vec!["--".to_owned(), format!("\n{prompt}")])
            }
            Self::Named(flag) => flag
                .resolve(conversation)
                .map(|flag| {
                    if prompt.starts_with('-') {
                        vec![format!("{flag}={prompt}")]
                    } else {
                        vec![flag.to_owned(), prompt.to_owned()]
                    }
                })
                .ok_or_else(|| failure("initial_prompt_launch_unsupported")),
        }
    }
}

#[derive(Clone, Copy)]
struct NativeProviderAdapter {
    provider_id: &'static str,
    executable: &'static str,
    startup_arguments: &'static [&'static str],
    prompt_delivery: PromptDelivery,
    auto_edit_arguments: Option<&'static [&'static str]>,
    skip_permissions_argument: Option<&'static str>,
    model_argument: Option<LaunchFlag>,
    effort_argument: Option<EffortArgument>,
    resume: ResumeArgument,
    exact_identity_is_uuid: bool,
}

const ADAPTERS: &[NativeProviderAdapter] = &[
    NativeProviderAdapter {
        provider_id: "claude",
        executable: "claude",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Positional,
        auto_edit_arguments: Some(&["--permission-mode", "acceptEdits"]),
        skip_permissions_argument: Some("--dangerously-skip-permissions"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: Some(EffortArgument::ClaudeFlag),
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "codex",
        executable: "codex",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Positional,
        auto_edit_arguments: Some(&[
            "--sandbox",
            "workspace-write",
            "--ask-for-approval",
            "on-request",
        ]),
        skip_permissions_argument: Some("--dangerously-bypass-approvals-and-sandbox"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: Some(EffortArgument::CodexConfig),
        resume: ResumeArgument::Adjacent(&["resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "kimi",
        executable: "kimi",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::ProviderEvent,
        auto_edit_arguments: None,
        skip_permissions_argument: Some("--yolo"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["-S"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "gemini",
        executable: "gemini",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::Always("--prompt-interactive")),
        auto_edit_arguments: Some(&["--approval-mode=auto_edit"]),
        skip_permissions_argument: Some("--approval-mode=yolo"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "cursor",
        executable: "cursor-agent",
        startup_arguments: &["agent"],
        prompt_delivery: PromptDelivery::Positional,
        auto_edit_arguments: None,
        skip_permissions_argument: Some("--force"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Inline("--resume"),
        exact_identity_is_uuid: true,
    },
    NativeProviderAdapter {
        provider_id: "copilot",
        executable: "copilot",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::Always("--interactive")),
        auto_edit_arguments: None,
        skip_permissions_argument: Some("--allow-all"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Inline("--resume"),
        exact_identity_is_uuid: true,
    },
    NativeProviderAdapter {
        provider_id: "opencode",
        executable: "opencode",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::FreshOnly("--prompt")),
        auto_edit_arguments: None,
        skip_permissions_argument: Some("--auto"),
        model_argument: Some(LaunchFlag::FreshOnly("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--session"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "grok",
        executable: "grok",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Positional,
        auto_edit_arguments: None,
        skip_permissions_argument: Some("--always-approve"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: true,
    },
    NativeProviderAdapter {
        provider_id: "pi",
        executable: "pi",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::ProviderEvent,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: Some(EffortArgument::Flag("--thinking")),
        resume: ResumeArgument::Adjacent(&["--session"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "amp",
        executable: "amp",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Stdin,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: None,
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["threads", "continue"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "droid",
        executable: "droid",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::FramedPositional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: None,
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "auggie",
        executable: "auggie",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::Always("--instruction")),
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "qwen-code",
        executable: "qwen",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::Always("--prompt-interactive")),
        auto_edit_arguments: Some(&["--approval-mode=auto-edit"]),
        skip_permissions_argument: Some("--approval-mode=yolo"),
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "cline",
        executable: "cline",
        startup_arguments: &["--tui"],
        prompt_delivery: PromptDelivery::FramedPositional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--id"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "continue",
        executable: "cn",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::FramedPositional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Unsupported,
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "codebuff",
        executable: "codebuff",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::FramedPositional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: None,
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--continue"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "kilocode",
        executable: "kilo",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::FreshOnly("--prompt")),
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--session"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "mistral-vibe",
        executable: "vibe",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Positional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: None,
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "antigravity",
        executable: "agy",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::Always("--prompt-interactive")),
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--conversation"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "openclaude",
        executable: "openclaude",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::FramedPositional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "oh-my-pi",
        executable: "omp",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::Positional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "command-code",
        executable: "cmd",
        startup_arguments: &[],
        prompt_delivery: PromptDelivery::FreshFramedPositional,
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "goose",
        executable: "goose",
        startup_arguments: &["run", "--interactive", "--text="],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::Always("--text")),
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume", "--session-id"]),
        exact_identity_is_uuid: false,
    },
    NativeProviderAdapter {
        provider_id: "hermes",
        executable: "hermes",
        startup_arguments: &["chat", "--tui"],
        prompt_delivery: PromptDelivery::Named(LaunchFlag::Always("-q")),
        auto_edit_arguments: None,
        skip_permissions_argument: None,
        model_argument: Some(LaunchFlag::Always("--model")),
        effort_argument: None,
        resume: ResumeArgument::Adjacent(&["--resume"]),
        exact_identity_is_uuid: false,
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeProviderConversationReference<'a> {
    Fresh,
    Exact(&'a str),
    TemplatePlaceholder(&'a str),
}

impl<'a> NativeProviderConversationReference<'a> {
    fn as_option(self) -> Option<&'a str> {
        match self {
            Self::Fresh => None,
            Self::Exact(reference) | Self::TemplatePlaceholder(reference) => Some(reference),
        }
    }
}

pub fn reviewed_native_provider_ids() -> impl ExactSizeIterator<Item = &'static str> {
    ADAPTERS.iter().map(|adapter| adapter.provider_id)
}

pub fn native_provider_preflight_plan(
    provider_id: &ProviderIdV1,
) -> Option<AgentProviderPreflightPlanV1> {
    adapter(provider_id).map(|adapter| AgentProviderPreflightPlanV1 {
        executable: adapter.executable.to_string(),
    })
}

pub fn native_provider_prompt_target(
    provider_id: &ProviderIdV1,
    conversation: Option<&str>,
) -> Option<AgentProviderPromptTargetV1> {
    adapter(provider_id).map(|adapter| adapter.prompt_delivery.target(conversation))
}

/// Apply initial input to an already prepared command, preserving pinned
/// executables, model selections and runtime integration wrappers.
pub fn native_provider_command_with_initial_prompt(
    provider_id: &ProviderIdV1,
    conversation: Option<&str>,
    mut command: Vec<String>,
    prompt: &str,
) -> Result<Vec<String>, ExtensionFailureCodeV1> {
    let adapter =
        adapter(provider_id).ok_or_else(|| failure("initial_prompt_launch_unsupported"))?;
    if !agent_provider_launch_prompt_is_valid(prompt) {
        return Err(failure("initial_prompt_invalid"));
    }
    if command.is_empty() {
        return Err(failure("launch_plan_missing"));
    }
    if matches!(adapter.prompt_delivery, PromptDelivery::Stdin) {
        let mut wrapped = vec![
            "/bin/sh".into(),
            "-c".into(),
            "prompt=$1; shift; printf '%s' \"$prompt\" | \"$@\"".into(),
            "dure-provider-stdin".into(),
            prompt.into(),
        ];
        wrapped.extend(command);
        return Ok(wrapped);
    }
    if provider_id.as_str() == "goose" {
        // Goose run requires input even for an empty interactive launch. Replace
        // its reviewed empty value instead of emitting a duplicate --text flag.
        if command.get(1..4) != Some(&["run".into(), "--interactive".into(), "--text=".into()]) {
            return Err(failure("initial_prompt_launch_unsupported"));
        }
        command[3] = format!("--text={prompt}");
    } else {
        command.extend(adapter.prompt_delivery.arguments(conversation, prompt)?);
    }
    Ok(command)
}

/// The reviewed permission mapping is shared by native launch and managed
/// providers whose structured protocol has the same approval semantics.
pub fn native_provider_permission_arguments(
    provider_id: &ProviderIdV1,
    permission_mode: &ProviderPermissionModeV1,
) -> Result<Vec<String>, ExtensionFailureCodeV1> {
    let adapter = adapter(provider_id).ok_or_else(|| failure("permission_mode_unsupported"))?;
    let mut arguments = Vec::new();
    match permission_mode {
        ProviderPermissionModeV1::Default => {
            // Qwen 0.24 defaults to auto mode; require the selected approval posture.
            if provider_id.as_str() == "qwen-code" {
                arguments.push("--approval-mode=default".to_string());
            }
        }
        ProviderPermissionModeV1::AutoEdit => {
            let values = adapter
                .auto_edit_arguments
                .ok_or_else(|| failure("permission_mode_unsupported"))?;
            arguments.extend(values.iter().map(|value| (*value).to_string()));
        }
        ProviderPermissionModeV1::SkipPermissions => {
            let value = adapter
                .skip_permissions_argument
                .ok_or_else(|| failure("permission_mode_unsupported"))?;
            arguments.push(value.to_string());
        }
    }
    Ok(arguments)
}

pub fn native_provider_launch_plan(
    provider_id: &ProviderIdV1,
    permission_mode: &ProviderPermissionModeV1,
    model: Option<&AgentSpawnModelSelectionV1>,
    effort: Option<&AgentSpawnEffortSelectionV1>,
    conversation: NativeProviderConversationReference<'_>,
) -> Result<Option<AgentProviderLaunchPlanV1>, ExtensionFailureCodeV1> {
    native_provider_launch_plan_with_initial_prompt(
        provider_id,
        permission_mode,
        model,
        effort,
        conversation,
        None,
    )
}

pub fn native_provider_session_launch_plan(
    provider_id: &ProviderIdV1,
    permission_mode: &ProviderPermissionModeV1,
    model: Option<&AgentSpawnModelSelectionV1>,
    effort: Option<&AgentSpawnEffortSelectionV1>,
    conversation: NativeProviderConversationReference<'_>,
    conversation_placeholder: &str,
) -> Result<Option<AgentProviderSessionLaunchPlanV1>, ExtensionFailureCodeV1> {
    let Some(launch) =
        native_provider_launch_plan(provider_id, permission_mode, model, effort, conversation)?
    else {
        return Ok(None);
    };
    // A retained recipe resumes the conversation's persisted selection. A
    // fresh-only flag cannot override that selection during native resume.
    let resume_model = match adapter(provider_id).and_then(|adapter| adapter.model_argument) {
        Some(LaunchFlag::FreshOnly(_)) => None,
        _ => model,
    };
    let resume = if matches!(
        adapter(provider_id).map(|adapter| adapter.resume),
        Some(ResumeArgument::Unsupported)
    ) {
        None
    } else {
        native_provider_launch_plan(
            provider_id,
            permission_mode,
            resume_model,
            effort,
            NativeProviderConversationReference::TemplatePlaceholder(conversation_placeholder),
        )?
    };
    Ok(Some(AgentProviderSessionLaunchPlanV1 {
        launch,
        resume_arguments: resume.map(|plan| plan.arguments),
    }))
}

pub fn native_provider_launch_plan_with_initial_prompt(
    provider_id: &ProviderIdV1,
    permission_mode: &ProviderPermissionModeV1,
    model: Option<&AgentSpawnModelSelectionV1>,
    effort: Option<&AgentSpawnEffortSelectionV1>,
    conversation: NativeProviderConversationReference<'_>,
    initial_prompt: Option<&str>,
) -> Result<Option<AgentProviderLaunchPlanV1>, ExtensionFailureCodeV1> {
    let Some(adapter) = adapter(provider_id) else {
        return Ok(None);
    };
    let mut arguments = adapter
        .startup_arguments
        .iter()
        .map(|argument| (*argument).to_string())
        .collect::<Vec<_>>();
    arguments.extend(native_provider_permission_arguments(
        provider_id,
        permission_mode,
    )?);
    if adapter.provider_id == "codex" {
        arguments.extend(["-c".to_string(), CODEX_MANAGED_STARTUP_CONFIG.to_string()]);
    }
    if let Some(model) = model {
        let flag = adapter
            .model_argument
            .and_then(|flag| flag.resolve(conversation.as_option()))
            .ok_or_else(|| failure("model_selection_unsupported"))?;
        arguments.extend([flag.to_string(), model.as_str().to_string()]);
    }
    if let Some(effort) = effort {
        match adapter
            .effort_argument
            .ok_or_else(|| failure("effort_selection_unsupported"))?
        {
            EffortArgument::Flag(flag) => {
                arguments.extend([flag.to_string(), effort.as_str().to_string()]);
            }
            EffortArgument::CodexConfig => {
                arguments.extend([
                    "-c".to_string(),
                    format!("model_reasoning_effort={}", effort.as_str()),
                ]);
            }
            EffortArgument::ClaudeFlag if effort.as_str() == "ultracode" => {
                arguments.extend([
                    "--effort".to_string(),
                    "xhigh".to_string(),
                    "--settings".to_string(),
                    "{\"ultracode\":true}".to_string(),
                ]);
            }
            EffortArgument::ClaudeFlag => {
                arguments.extend(["--effort".to_string(), effort.as_str().to_string()]);
            }
        }
    }
    if let Some((reference, exact)) = match conversation {
        NativeProviderConversationReference::Fresh => None,
        NativeProviderConversationReference::Exact(reference) => Some((reference, true)),
        NativeProviderConversationReference::TemplatePlaceholder(reference) => {
            Some((reference, false))
        }
    } {
        if !safe_cli_identity(reference)
            || (exact && adapter.exact_identity_is_uuid && !exact_uuid_identity(reference))
        {
            return Err(failure("conversation_resume_identity_invalid"));
        }
        match adapter.resume {
            ResumeArgument::Unsupported => return Err(failure("conversation_resume_unsupported")),
            ResumeArgument::Adjacent(prefix) => {
                arguments.extend(prefix.iter().map(|argument| (*argument).to_string()));
                arguments.push(reference.to_string());
            }
            ResumeArgument::Inline(flag) => {
                arguments.push(format!("{flag}={reference}"));
            }
        }
    }
    let mut plan = AgentProviderLaunchPlanV1 {
        executable: adapter.executable.to_string(),
        arguments,
    };
    if let Some(prompt) = initial_prompt {
        let mut command = native_provider_command_with_initial_prompt(
            provider_id,
            conversation.as_option(),
            std::iter::once(plan.executable)
                .chain(plan.arguments)
                .collect(),
            prompt,
        )?
        .into_iter();
        plan.executable = command.next().expect("validated provider command");
        plan.arguments = command.collect();
    }
    Ok(Some(plan))
}

/// Render provider-native runtime integration arguments beside the native
/// launch plan. The integration must already have been parsed at its source
/// boundary; execution adapters do not reinterpret that contract.
pub fn provider_runtime_integration_arguments(
    provider_id: &ProviderIdV1,
    integration: &ProviderRuntimeIntegrationV1,
) -> Result<Vec<String>, ExtensionFailureCodeV1> {
    match (provider_id.as_str(), integration) {
        ("codex", ProviderRuntimeIntegrationV1::NotificationCommand { command }) => {
            let hook = command
                .first()
                .ok_or_else(|| failure("provider_runtime_integration_invalid"))?;
            let lifecycle = codex_lifecycle_hook_arguments_v1(hook)
                .map_err(|_| failure("provider_runtime_integration_invalid"))?;
            let mut arguments = provider_notification_arguments(provider_id, integration)?;
            arguments.extend(lifecycle);
            Ok(arguments)
        }
        ("claude", ProviderRuntimeIntegrationV1::SettingsFile { path }) => {
            Ok(vec!["--settings".into(), path.clone()])
        }
        _ => Err(failure("provider_runtime_integration_unsupported")),
    }
}

/// Apply the parsed channel integration to both executable and argv. Wrappers
/// receive the original executable, preserving pinned provider selection.
pub fn apply_provider_runtime_integration(
    provider_id: &ProviderIdV1,
    integration: &ProviderRuntimeIntegrationV1,
    plan: &mut AgentProviderLaunchPlanV1,
) -> Result<(), ExtensionFailureCodeV1> {
    match (provider_id.as_str(), integration) {
        (
            "codex" | "pi" | "gemini" | "qwen-code",
            ProviderRuntimeIntegrationV1::CommandWrapper { path },
        ) => {
            plan.arguments
                .insert(0, std::mem::replace(&mut plan.executable, path.clone()));
        }
        _ => {
            plan.arguments.splice(
                0..0,
                provider_runtime_integration_arguments(provider_id, integration)?,
            );
        }
    }
    Ok(())
}

/// Install only the completion notification command. Remote adapters use this
/// without opting user-owned lifecycle hooks into invocation-wide trust.
pub fn provider_notification_arguments(
    provider_id: &ProviderIdV1,
    integration: &ProviderRuntimeIntegrationV1,
) -> Result<Vec<String>, ExtensionFailureCodeV1> {
    let ("codex", ProviderRuntimeIntegrationV1::NotificationCommand { command }) =
        (provider_id.as_str(), integration)
    else {
        return Err(failure("provider_runtime_integration_unsupported"));
    };
    integration
        .validate()
        .map_err(|_| failure("provider_runtime_integration_invalid"))?;
    let notify = command
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| failure("provider_runtime_integration_invalid"))?
        .join(",");
    Ok(vec!["-c".into(), format!("notify=[{notify}]")])
}

pub fn exact_uuid_identity(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn adapter(provider_id: &ProviderIdV1) -> Option<&'static NativeProviderAdapter> {
    ADAPTERS
        .iter()
        .find(|adapter| adapter.provider_id == provider_id.as_str())
}

fn safe_cli_identity(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
        })
}

fn failure(code: &'static str) -> ExtensionFailureCodeV1 {
    ExtensionFailureCodeV1::new(code).expect("static provider failure code is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(value: &str) -> ProviderIdV1 {
        ProviderIdV1::new(value).unwrap()
    }

    #[test]
    fn one_integration_renderer_serves_every_execution_adapter() {
        let codex = ProviderRuntimeIntegrationV1::NotificationCommand {
            command: vec![
                "/fixture/managed-codex-notify.sh".into(),
                "/fixture/managed-codex-user-notify.sh".into(),
            ],
        };
        let codex_arguments =
            provider_runtime_integration_arguments(&provider("codex"), &codex).unwrap();
        assert_eq!(
            provider_notification_arguments(&provider("codex"), &codex).unwrap(),
            codex_arguments[..2],
        );
        assert_eq!(
            &codex_arguments[..2],
            [
                "-c",
                "notify=[\"/fixture/managed-codex-notify.sh\",\"/fixture/managed-codex-user-notify.sh\"]",
            ]
        );
        assert!(
            codex_arguments
                .iter()
                .any(|value| value == "--dangerously-bypass-hook-trust")
        );
        assert!(
            codex_arguments
                .iter()
                .any(|value| value.contains("hooks.SessionStart="))
        );
        assert!(
            !codex_arguments
                .iter()
                .any(|value| value.contains("hooks.Stop="))
        );
        assert!(
            !codex_arguments
                .iter()
                .any(|value| value.starts_with("hooks.state="))
        );

        let claude = ProviderRuntimeIntegrationV1::SettingsFile {
            path: "/fixture/managed-claude-settings.json".into(),
        };
        assert_eq!(
            provider_runtime_integration_arguments(&provider("claude"), &claude).unwrap(),
            ["--settings", "/fixture/managed-claude-settings.json"]
        );
        assert_eq!(
            provider_runtime_integration_arguments(&provider("claude"), &codex)
                .unwrap_err()
                .as_str(),
            "provider_runtime_integration_unsupported"
        );
    }

    #[test]
    fn pi_and_kimi_compile_reviewed_launch_arguments() {
        let model = AgentSpawnModelSelectionV1::parse("reviewed-model").unwrap();
        let effort = AgentSpawnEffortSelectionV1::parse("high").unwrap();
        assert_eq!(
            native_provider_launch_plan(
                &provider("pi"),
                &ProviderPermissionModeV1::Default,
                Some(&model),
                Some(&effort),
                NativeProviderConversationReference::Exact("pi-session-1"),
            )
            .unwrap()
            .unwrap(),
            AgentProviderLaunchPlanV1 {
                executable: "pi".into(),
                arguments: [
                    "--model",
                    "reviewed-model",
                    "--thinking",
                    "high",
                    "--session",
                    "pi-session-1",
                ]
                .map(str::to_string)
                .into(),
            }
        );
        assert_eq!(
            native_provider_launch_plan(
                &provider("kimi"),
                &ProviderPermissionModeV1::SkipPermissions,
                Some(&model),
                None,
                NativeProviderConversationReference::Exact("kimi-session-1"),
            )
            .unwrap()
            .unwrap(),
            AgentProviderLaunchPlanV1 {
                executable: "kimi".into(),
                arguments: [
                    "--yolo",
                    "--model",
                    "reviewed-model",
                    "-S",
                    "kimi-session-1"
                ]
                .map(str::to_string)
                .into(),
            }
        );
    }

    #[test]
    fn unsupported_permission_and_effort_selections_fail_closed() {
        let effort = AgentSpawnEffortSelectionV1::parse("high").unwrap();
        let pi_permission = native_provider_launch_plan(
            &provider("pi"),
            &ProviderPermissionModeV1::SkipPermissions,
            None,
            None,
            NativeProviderConversationReference::Fresh,
        )
        .unwrap_err();
        assert_eq!(pi_permission.as_str(), "permission_mode_unsupported");
        let kimi_effort = native_provider_launch_plan(
            &provider("kimi"),
            &ProviderPermissionModeV1::Default,
            None,
            Some(&effort),
            NativeProviderConversationReference::Fresh,
        )
        .unwrap_err();
        assert_eq!(kimi_effort.as_str(), "effort_selection_unsupported");
    }

    #[test]
    fn codex_launch_disables_the_interactive_startup_update_check() {
        let fresh = native_provider_launch_plan(
            &provider("codex"),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            fresh.arguments,
            ["-c", "check_for_update_on_startup=false"].map(str::to_string)
        );
    }

    #[test]
    fn exact_uuid_providers_reject_ambiguous_ids_but_allow_recipe_placeholders() {
        let cursor = provider("cursor");
        assert!(
            native_provider_launch_plan(
                &cursor,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::Exact("not-a-full-uuid"),
            )
            .is_err()
        );
        assert!(
            native_provider_launch_plan(
                &cursor,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::TemplatePlaceholder("conversation-id"),
            )
            .unwrap()
            .is_some()
        );
    }

    #[test]
    fn every_reviewed_provider_has_one_preflight_plan() {
        assert_eq!(reviewed_native_provider_ids().len(), 24);
        for provider_id in reviewed_native_provider_ids() {
            assert!(native_provider_preflight_plan(&provider(provider_id)).is_some());
        }
        assert!(native_provider_preflight_plan(&provider("unknown")).is_none());
    }

    #[test]
    fn codex_bootstraps_its_first_turn_in_the_managed_launch() {
        assert_eq!(
            native_provider_prompt_target(&provider("codex"), None),
            Some(AgentProviderPromptTargetV1::LaunchArgument),
        );
        assert_eq!(
            native_provider_prompt_target(&provider("claude"), None),
            Some(AgentProviderPromptTargetV1::LaunchArgument),
        );
        assert_eq!(
            native_provider_prompt_target(&provider("unknown"), None),
            None
        );
    }

    #[test]
    fn codex_launch_owns_fresh_and_exact_initial_prompts() {
        let fresh = native_provider_launch_plan_with_initial_prompt(
            &provider("codex"),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
            Some("ship 'this' safely\nnow"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(fresh.arguments.last().unwrap(), "ship 'this' safely\nnow");

        let exact = native_provider_launch_plan_with_initial_prompt(
            &provider("codex"),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Exact("conversation-1"),
            Some("continue"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            &exact.arguments[exact.arguments.len() - 4..],
            ["resume", "conversation-1", "--", "continue"]
        );

        assert_eq!(
            native_provider_launch_plan_with_initial_prompt(
                &provider("kimi"),
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::Fresh,
                Some("ship it"),
            )
            .unwrap_err()
            .as_str(),
            "initial_prompt_launch_unsupported"
        );

        assert_eq!(
            native_provider_launch_plan_with_initial_prompt(
                &provider("codex"),
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::Fresh,
                Some(&"x".repeat(16385)),
            )
            .unwrap_err()
            .as_str(),
            "initial_prompt_invalid"
        );
    }
}
