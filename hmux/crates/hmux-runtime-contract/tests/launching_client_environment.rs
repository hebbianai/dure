use hmux_runtime_contract::launching_client_session_env_keys;

#[test]
fn launching_client_environment_removes_both_session_families() {
    let markers = [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
    ];
    assert_eq!(launching_client_session_env_keys(markers), markers);
}

#[test]
fn launching_client_environment_preserves_auth_and_provider_configuration() {
    let configuration = [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "USER_TOOL_SETTING",
        "HMUX_DISCOVERY_ROOT",
        "PATH",
    ];
    assert!(launching_client_session_env_keys(configuration).is_empty());
}

#[test]
fn launching_client_environment_uses_platform_case_rules_without_rewriting_keys() {
    let mixed = ["codex_thread_id", "Claude_Code_Messaging_Token"];
    let selected = launching_client_session_env_keys(mixed);
    if cfg!(windows) {
        assert_eq!(selected, mixed);
    } else {
        assert!(selected.is_empty());
    }
    assert_eq!(
        launching_client_session_env_keys([
            "CLAUDE_CODE_MESSAGING_FUTURE_CHANNEL",
            "CODEX_THREAD_ID_SUFFIX",
            "CLAUDE_CODE_SESSION_ID_SUFFIX",
            "CLAUDE_CODE_MESSAGING",
            "한글_CONFIG",
        ]),
        ["CLAUDE_CODE_MESSAGING_FUTURE_CHANNEL"]
    );
}
