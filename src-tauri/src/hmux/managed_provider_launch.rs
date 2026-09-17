use dure_app::{AgentProviderLaunchPlanV1, ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    native_provider_launch_plan_with_initial_prompt, NativeProviderConversationReference,
};
use hmux_client::{PermissionMode, MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER};

fn permission_mode(permission_mode: PermissionMode) -> ProviderPermissionModeV1 {
    match permission_mode {
        PermissionMode::Default => ProviderPermissionModeV1::Default,
        PermissionMode::BypassApprovals => ProviderPermissionModeV1::SkipPermissions,
    }
}

fn plan(
    provider_id: &str,
    hmux_permission_mode: PermissionMode,
    conversation: NativeProviderConversationReference<'_>,
) -> Option<AgentProviderLaunchPlanV1> {
    plan_with_initial_prompt(provider_id, hmux_permission_mode, conversation, None)
}

fn plan_with_initial_prompt(
    provider_id: &str,
    hmux_permission_mode: PermissionMode,
    conversation: NativeProviderConversationReference<'_>,
    initial_prompt: Option<&str>,
) -> Option<AgentProviderLaunchPlanV1> {
    let provider_id = ProviderIdV1::new(provider_id).ok()?;
    native_provider_launch_plan_with_initial_prompt(
        &provider_id,
        &permission_mode(hmux_permission_mode),
        None,
        None,
        conversation,
        initial_prompt,
    )
    .ok()?
}

fn command(plan: &AgentProviderLaunchPlanV1) -> String {
    let mut command = plan.executable.clone();
    for argument in &plan.arguments {
        command.push(' ');
        command.push_str(argument);
    }
    command
}

pub(crate) fn fresh_plan(
    provider_id: &str,
    permission_mode: PermissionMode,
) -> Option<AgentProviderLaunchPlanV1> {
    plan(
        provider_id,
        permission_mode,
        NativeProviderConversationReference::Fresh,
    )
}

pub(crate) fn exact_plan(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: &str,
) -> Option<AgentProviderLaunchPlanV1> {
    let conversation = if conversation_id == MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER {
        NativeProviderConversationReference::TemplatePlaceholder(conversation_id)
    } else {
        NativeProviderConversationReference::Exact(conversation_id)
    };
    plan(provider_id, permission_mode, conversation)
}

pub(crate) fn plan_with_launch_prompt(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: Option<&str>,
    initial_prompt: &str,
) -> Option<AgentProviderLaunchPlanV1> {
    let conversation = match conversation_id {
        Some(conversation_id)
            if conversation_id == MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER =>
        {
            NativeProviderConversationReference::TemplatePlaceholder(conversation_id)
        }
        Some(conversation_id) => NativeProviderConversationReference::Exact(conversation_id),
        None => NativeProviderConversationReference::Fresh,
    };
    plan_with_initial_prompt(
        provider_id,
        permission_mode,
        conversation,
        Some(initial_prompt),
    )
}

pub(crate) fn create_plan(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: Option<&str>,
    initial_prompt: Option<&str>,
) -> Option<(AgentProviderLaunchPlanV1, bool)> {
    if let Some(prompt) = initial_prompt {
        if let Some(plan) =
            plan_with_launch_prompt(provider_id, permission_mode, conversation_id, prompt)
        {
            return Some((plan, true));
        }
    }
    let plan = match conversation_id {
        Some(conversation_id) => exact_plan(provider_id, permission_mode, conversation_id),
        None => fresh_plan(provider_id, permission_mode),
    }?;
    Some((plan, false))
}

pub(crate) fn reviewed_create_plan(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: Option<&str>,
    requested_command: &str,
    initial_prompt: Option<&str>,
) -> Option<(AgentProviderLaunchPlanV1, bool)> {
    reviewed_plan_matching_command(
        provider_id,
        permission_mode,
        conversation_id,
        requested_command,
    )?;
    create_plan(
        provider_id,
        permission_mode,
        conversation_id,
        initial_prompt,
    )
}

#[cfg(any(not(windows), test))]
pub(crate) fn reviewed_command_accepts_launch_prompt(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: Option<&str>,
    requested_command: &str,
    initial_prompt: &str,
) -> bool {
    reviewed_create_plan(
        provider_id,
        permission_mode,
        conversation_id,
        requested_command,
        Some(initial_prompt),
    )
    .is_some_and(|(_, accepted)| accepted)
}

pub(crate) fn reviewed_plan_matching_command(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: Option<&str>,
    requested_command: &str,
) -> Option<AgentProviderLaunchPlanV1> {
    let plan = match conversation_id {
        Some(conversation_id) => exact_plan(provider_id, permission_mode, conversation_id),
        None => fresh_plan(provider_id, permission_mode),
    }?;
    (command(&plan) == requested_command).then_some(plan)
}

#[cfg(any(not(windows), test))]
pub(crate) fn fresh_command(provider_id: &str, permission_mode: PermissionMode) -> Option<String> {
    fresh_plan(provider_id, permission_mode).map(|plan| command(&plan))
}

#[cfg(any(not(windows), test))]
pub(crate) fn exact_command(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: &str,
) -> Option<String> {
    exact_plan(provider_id, permission_mode, conversation_id).map(|plan| command(&plan))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_adapter_builds_fresh_and_exact_commands() {
        let exact_cases = [
            ("claude", "claude --dangerously-skip-permissions --resume"),
            (
                "codex",
                "codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false resume",
            ),
            ("kimi", "kimi --yolo -S"),
            ("gemini", "gemini --approval-mode=yolo --resume"),
            ("cursor", "cursor-agent --force --resume="),
            ("copilot", "copilot --allow-all --resume="),
            ("opencode", "opencode --auto --session"),
            ("grok", "grok --always-approve --resume"),
        ];
        for (provider, expected) in exact_cases {
            let command = exact_command(
                provider,
                PermissionMode::BypassApprovals,
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
            )
            .expect("reviewed provider must have an exact bypass adapter");
            assert!(command.starts_with(expected), "{provider}: {command}");
            assert_eq!(
                command
                    .matches(MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER)
                    .count(),
                1,
                "{provider}: {command}"
            );
        }

        assert_eq!(
            fresh_command("codex", PermissionMode::BypassApprovals).as_deref(),
            Some(
                "codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false"
            )
        );
        assert_eq!(
            fresh_command("pi", PermissionMode::Default).as_deref(),
            Some("pi")
        );
        assert_eq!(
            exact_command("pi", PermissionMode::Default, "pi-session-1").as_deref(),
            Some("pi --session pi-session-1")
        );
        assert!(fresh_command("pi", PermissionMode::BypassApprovals).is_none());
        assert!(fresh_command("unknown", PermissionMode::Default).is_none());

        let uuid_identity = "019c10d2-8d16-7cc0-a44e-55847c4eb786";
        assert!(exact_command("cursor", PermissionMode::Default, uuid_identity).is_some());
        assert!(exact_command("cursor", PermissionMode::Default, "not-a-full-uuid").is_none());
    }

    #[test]
    fn only_the_exact_reviewed_command_recovers_a_typed_plan() {
        let command =
            "codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false";
        let plan =
            reviewed_plan_matching_command("codex", PermissionMode::BypassApprovals, None, command)
                .expect("the adapter's own command should recover its typed plan");
        assert_eq!(plan.executable, "codex");
        assert_eq!(
            plan.arguments,
            [
                "--dangerously-bypass-approvals-and-sandbox",
                "-c",
                "check_for_update_on_startup=false",
            ]
            .map(str::to_string)
        );

        for changed in [
            " codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false",
            "codex  --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false",
            "codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false --custom",
        ] {
            assert!(
                reviewed_plan_matching_command(
                    "codex",
                    PermissionMode::BypassApprovals,
                    None,
                    changed,
                )
                .is_none(),
                "custom command must remain on the legacy shell path: {changed}"
            );
        }
    }

    #[test]
    fn launch_prompt_is_one_quoted_final_codex_argument() {
        let requested_command = exact_command(
            "codex",
            PermissionMode::Default,
            "conversation-1",
        )
        .unwrap();
        let (plan, initial_prompt_accepted) = reviewed_create_plan(
            "codex",
            PermissionMode::Default,
            Some("conversation-1"),
            &requested_command,
            Some("ship 'this' safely\nnow"),
        )
        .unwrap();
        assert!(initial_prompt_accepted);
        assert_eq!(
            &plan.arguments[plan.arguments.len() - 3..],
            ["resume", "conversation-1", "ship 'this' safely\nnow"]
        );
        let claude_command = fresh_command("claude", PermissionMode::Default).unwrap();
        assert!(!reviewed_create_plan(
            "claude",
            PermissionMode::Default,
            None,
            &claude_command,
            Some("ship it"),
        )
        .unwrap()
        .1);

        assert!(reviewed_command_accepts_launch_prompt(
            "codex",
            PermissionMode::Default,
            Some("conversation-1"),
            "codex -c check_for_update_on_startup=false resume conversation-1",
            "ship it",
        ));
        assert!(!reviewed_command_accepts_launch_prompt(
            "codex",
            PermissionMode::Default,
            None,
            "codex --custom-runtime",
            "ship it",
        ));
    }
}
