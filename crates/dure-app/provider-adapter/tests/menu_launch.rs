use dure_app::{AgentProviderPromptTargetV1, ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_launch_plan_with_initial_prompt,
    native_provider_prompt_target,
};

#[test]
fn installed_menu_providers_deliver_the_first_turn_at_launch() {
    let prompt = "Describe /tmp/image with spaces.png\n한글 'quoted'";
    let framed = format!("\n{prompt}");
    let goose_prompt = format!("--text={prompt}");
    for id in [
        "goose",
        "hermes",
        "gemini",
        "cursor",
        "copilot",
        "grok",
        "droid",
        "auggie",
        "qwen-code",
        "cline",
        "continue",
        "codebuff",
        "kilocode",
        "mistral-vibe",
        "antigravity",
        "openclaude",
        "oh-my-pi",
        "command-code",
    ] {
        let provider = ProviderIdV1::new(id).unwrap();
        let plan = native_provider_launch_plan_with_initial_prompt(
            &provider,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
            Some(prompt),
        )
        .unwrap();
        let plan =
            plan.unwrap_or_else(|| panic!("{id}: installed menu provider has no launch plan"));
        assert_eq!(
            plan.arguments.last().map(String::as_str),
            Some(if id == "goose" {
                goose_prompt.as_str()
            } else if matches!(
                id,
                "droid" | "cline" | "continue" | "codebuff" | "openclaude" | "command-code"
            ) {
                framed.as_str()
            } else {
                prompt
            }),
            "{id}: prompt must be preserved as one argument"
        );
        assert_eq!(
            native_provider_prompt_target(&provider, None),
            Some(AgentProviderPromptTargetV1::LaunchArgument),
            "{id}"
        );
    }
}

#[test]
fn continue_does_not_fabricate_an_exact_resume_command() {
    let provider = ProviderIdV1::new("continue").unwrap();
    let plan = dure_provider_adapter::native_provider_session_launch_plan(
        &provider,
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Fresh,
        "__DURE_CONVERSATION__",
    )
    .unwrap()
    .unwrap();
    assert!(plan.resume_arguments.is_none());
    assert_eq!(
        native_provider_launch_plan_with_initial_prompt(
            &provider,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Exact("existing"),
            None
        )
        .unwrap_err()
        .as_str(),
        "conversation_resume_unsupported"
    );
}

#[test]
fn cline_keeps_the_initial_prompt_in_interactive_mode() {
    let provider = ProviderIdV1::new("cline").unwrap();
    let plan = native_provider_launch_plan_with_initial_prompt(
        &provider,
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Fresh,
        Some("describe the image"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(plan.arguments, ["--tui", "--", "\ndescribe the image"]);
}

/// Qualify the actual launch argv against installed CLI parsers without starting
/// a conversation; the optional output is consumed by isolated PTY QA.
#[test]
#[ignore = "requires the installed menu CLIs under qualification"]
fn installed_clis_accept_interactive_first_turn_arguments() {
    let mut plans = Vec::new();
    for id in [
        "goose",
        "hermes",
        "gemini",
        "cursor",
        "copilot",
        "grok",
        "droid",
        "auggie",
        "qwen-code",
        "cline",
        "continue",
        "codebuff",
        "kilocode",
        "mistral-vibe",
        "antigravity",
        "openclaude",
        "oh-my-pi",
        "command-code",
    ] {
        let provider = ProviderIdV1::new(id).unwrap();
        let plan = native_provider_launch_plan_with_initial_prompt(
            &provider,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
            Some("Describe /tmp/image with spaces.png\n한글 'quoted'"),
        )
        .unwrap()
        .unwrap();
        let output = std::process::Command::new(&plan.executable)
            .arg("--help")
            .args(&plan.arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{id}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        plans.push(serde_json::json!({"provider": id, "executable": plan.executable, "arguments": plan.arguments}));
    }
    if let Some(path) = std::env::var_os("DURE_QA_MENU_PLANS") {
        std::fs::write(path, serde_json::to_vec_pretty(&plans).unwrap()).unwrap();
    }
}

#[test]
fn positional_first_turn_text_cannot_become_a_cli_option() {
    for id in [
        "codex",
        "cursor",
        "grok",
        "droid",
        "cline",
        "continue",
        "codebuff",
        "mistral-vibe",
        "openclaude",
        "oh-my-pi",
        "command-code",
    ] {
        let plan = native_provider_launch_plan_with_initial_prompt(
            &ProviderIdV1::new(id).unwrap(),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
            Some("--help"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            &plan.arguments[plan.arguments.len() - 2..],
            [
                "--",
                if matches!(
                    id,
                    "droid" | "cline" | "continue" | "codebuff" | "openclaude" | "command-code"
                ) {
                    "\n--help"
                } else {
                    "--help"
                }
            ],
            "{id}"
        );
    }
}

#[test]
#[cfg(unix)]
fn amp_initial_input_uses_finite_stdin_without_interpreting_text_or_arguments() {
    let prompt = "한글 'quoted'\n$(exit 99) `exit 98` --help";
    let script = "printf '%s\\n' \"$1\" \"$2\"; /bin/cat";
    let command = dure_provider_adapter::native_provider_command_with_initial_prompt(
        &ProviderIdV1::new("amp").unwrap(),
        None,
        [
            "/bin/sh",
            "-c",
            script,
            "dure-fixture",
            "thread with spaces",
            "$(exit 97)",
        ]
        .map(str::to_string)
        .into(),
        prompt,
    )
    .unwrap();
    let output = std::process::Command::new(&command[0])
        .args(&command[1..])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("thread with spaces\n$(exit 97)\n{prompt}")
    );
}

#[test]
fn goose_replaces_required_empty_input_without_a_duplicate_flag() {
    let provider = ProviderIdV1::new("goose").unwrap();
    for prompt in [None, Some("inspect this image")] {
        let plan = native_provider_launch_plan_with_initial_prompt(
            &provider,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
            prompt,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            plan.arguments,
            [
                "run".to_owned(),
                "--interactive".to_owned(),
                format!("--text={}", prompt.unwrap_or(""))
            ]
        );
    }
}

#[test]
fn launch_input_accepts_the_composer_byte_limit_and_rejects_invalid_input() {
    let provider = ProviderIdV1::new("gemini").unwrap();
    for prompt in ["x".repeat(16 * 1024), "한".repeat(5461)] {
        assert!(
            native_provider_launch_plan_with_initial_prompt(
                &provider,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::Fresh,
                Some(&prompt)
            )
            .is_ok()
        );
    }
    for prompt in [
        "x".repeat(16 * 1024 + 1),
        "한".repeat(5462),
        "a\0b".into(),
        String::new(),
    ] {
        assert_eq!(
            native_provider_launch_plan_with_initial_prompt(
                &provider,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::Fresh,
                Some(&prompt)
            )
            .unwrap_err()
            .as_str(),
            "initial_prompt_invalid"
        );
    }
}

#[test]
fn command_code_resume_does_not_claim_to_deliver_an_ignored_prompt() {
    assert_eq!(
        native_provider_prompt_target(&ProviderIdV1::new("command-code").unwrap(), Some("session")),
        Some(AgentProviderPromptTargetV1::ProviderEvent)
    );
}

/// Exercise the installed parser library with inert subcommand actions, never
/// invoke a provider's login/logout handlers during transport qualification.
#[test]
#[ignore = "requires DURE_QA_COMMANDER pointing to Command Code's installed commander module"]
fn framed_prompts_remain_input_through_the_installed_commander_parser() {
    let module = std::env::var_os("DURE_QA_COMMANDER").expect("DURE_QA_COMMANDER");
    let script = r#"const {Command}=require(process.argv[1]); const p=new Command(); let result;
p.argument('[prompt]').action(value=>{result=['prompt',value]});
for(const name of ['login','logout','publish','review']) p.command(name).action(()=>{result=['command',name]});
p.parse(['node','fixture',...process.argv.slice(2)]); process.stdout.write(JSON.stringify(result));"#;
    for prompt in [
        "login",
        "logout",
        "publish",
        "review",
        "--help",
        "-p",
        "hello\n한글",
    ] {
        let plan = native_provider_launch_plan_with_initial_prompt(
            &ProviderIdV1::new("command-code").unwrap(),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
            Some(prompt),
        )
        .unwrap()
        .unwrap();
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg(script)
            .arg(&module)
            .args(plan.arguments)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
            serde_json::json!(["prompt", format!("\n{prompt}")])
        );
    }
}

#[test]
#[ignore = "requires Python argparse to qualify named prompt syntax"]
fn named_initial_input_cannot_be_interpreted_as_a_help_flag() {
    let script = "import argparse,json; p=argparse.ArgumentParser(); p.add_argument('--text', '-q', dest='prompt'); print(json.dumps(p.parse_args().prompt))";
    for id in ["goose", "hermes"] {
        let plan = native_provider_launch_plan_with_initial_prompt(
            &ProviderIdV1::new(id).unwrap(),
            &ProviderPermissionModeV1::Default,
            None,
            None,
            NativeProviderConversationReference::Fresh,
            Some("--help"),
        )
        .unwrap()
        .unwrap();
        let output = std::process::Command::new("/usr/bin/python3")
            .arg("-c")
            .arg(script)
            .args(&plan.arguments[2..])
            .output()
            .unwrap();
        assert!(output.status.success(), "{id}");
        assert_eq!(
            serde_json::from_slice::<String>(&output.stdout).unwrap(),
            "--help",
            "{id}"
        );
    }
}

#[test]
fn goose_empty_launch_and_resume_are_valid_managed_command_arguments() {
    let plan = dure_provider_adapter::native_provider_session_launch_plan(
        &ProviderIdV1::new("goose").unwrap(),
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Fresh,
        "__DURE_CONVERSATION__",
    )
    .unwrap()
    .unwrap();
    assert!(
        plan.launch
            .arguments
            .iter()
            .all(|argument| !argument.is_empty())
    );
    assert!(
        plan.resume_arguments
            .unwrap()
            .iter()
            .all(|argument| !argument.is_empty())
    );
}

#[test]
fn claude_initial_prompt_preserves_integration_on_fresh_and_resume() {
    use dure_provider_adapter::native_provider_command_with_initial_prompt;

    let provider = ProviderIdV1::new("claude").unwrap();
    let prompt = "--literal QA-CLAUDE-765\nDescribe /tmp/image with spaces.png '한글'";
    for conversation in [None, Some("conversation-765")] {
        assert_eq!(
            native_provider_prompt_target(&provider, conversation),
            Some(AgentProviderPromptTargetV1::LaunchArgument)
        );
        let reference = conversation.map_or(
            NativeProviderConversationReference::Fresh,
            NativeProviderConversationReference::Exact,
        );
        let plan = native_provider_launch_plan_with_initial_prompt(
            &provider,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            reference,
            Some(prompt),
        )
        .unwrap()
        .unwrap();
        let mut expected = Vec::new();
        if let Some(id) = conversation {
            expected.extend(["--resume".to_string(), id.to_string()]);
        }
        expected.extend(["--".to_string(), prompt.to_string()]);
        assert_eq!(plan.arguments, expected);

        let prepared = vec![
            "/pinned/claude".to_string(),
            "--settings".to_string(),
            "/fixture/hook-settings.json".to_string(),
        ];
        let mut expected = prepared.clone();
        expected.extend(["--".to_string(), prompt.to_string()]);
        assert_eq!(
            native_provider_command_with_initial_prompt(&provider, conversation, prepared, prompt,)
                .unwrap(),
            expected
        );
    }
}
