use super::super::*;
use std::collections::BTreeSet;

#[test]
fn outer_claude_session_markers_never_reach_the_conversation() {
    // A backend launched from inside a Claude Code session inherits that
    // session's markers; forwarding them makes the SDK host refuse the
    // bind (reserved_environment_conflict) and would hand the pane CLI a
    // foreign session identity.
    let environment = prepared_claude_environment(
        &BTreeMap::from([
            ("HOME".into(), "/home/test".into()),
            ("PATH".into(), "/bin".into()),
            ("CLAUDECODE".into(), "1".into()),
            ("CODEX_SESSION_ID".into(), "outer-codex-session".into()),
            ("CODEX_THREAD_ID".into(), "outer-codex-thread".into()),
            ("CLAUDE_CODE_USE_BEDROCK".into(), "1".into()),
            ("CLAUDE_CODE_ENTRYPOINT".into(), "cli".into()),
            ("CLAUDE_CODE_SESSION_ID".into(), "outer-session".into()),
            ("CLAUDE_AGENT_SDK_VERSION".into(), "0.3.0".into()),
            ("CLAUDE_PID".into(), "123".into()),
            ("CLAUDE_EFFORT".into(), "high".into()),
            ("DISABLE_AUTOUPDATER".into(), "0".into()),
            ("CLAUDE_CODE_OAUTH_TOKEN".into(), "ambient-token".into()),
            ("CLAUDE_CONFIG_DIR".into(), "/credentials/default".into()),
            (
                "ANTHROPIC_CONFIG_DIR".into(),
                "/credentials/anthropic".into(),
            ),
        ]),
        &ProviderStateEnvironment::from_mutations(
            BTreeMap::new(),
            BTreeSet::from(["CLAUDE_CONFIG_DIR".into(), "ANTHROPIC_CONFIG_DIR".into()]),
        )
        .unwrap(),
    )
    .unwrap();
    for removed in [
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
        "DISABLE_AUTOUPDATER",
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_CONFIG_DIR",
    ] {
        assert!(!environment.contains_key(removed), "{removed} leaked");
    }
    assert_eq!(environment["CLAUDE_CODE_OAUTH_TOKEN"], "ambient-token");
    assert_eq!(environment["CLAUDE_CODE_USE_BEDROCK"], "1");
}
