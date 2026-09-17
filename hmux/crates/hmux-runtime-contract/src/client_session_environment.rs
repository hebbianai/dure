/// Classify inherited client identity and messaging state at process launch.
/// Authentication and provider configuration are separate from session identity:
/// `CLAUDE_CODE_` also contains documented credentials and routing settings.
#[must_use]
pub fn is_launching_client_session_env_key(key: &str) -> bool {
    const EXACT_KEYS: [&str; 6] = [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
    ];
    const MESSAGING_PREFIX: &str = "CLAUDE_CODE_MESSAGING_";
    let equals = |expected: &str| {
        if cfg!(windows) {
            key.eq_ignore_ascii_case(expected)
        } else {
            key == expected
        }
    };
    EXACT_KEYS.into_iter().any(equals)
        || key.get(..MESSAGING_PREFIX.len()).is_some_and(|prefix| {
            if cfg!(windows) {
                prefix.eq_ignore_ascii_case(MESSAGING_PREFIX)
            } else {
                prefix == MESSAGING_PREFIX
            }
        })
}

/// Preserve each selected key's original spelling for the platform adapter.
pub fn launching_client_session_env_keys<I, S>(present_keys: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    present_keys
        .into_iter()
        .filter(|key| is_launching_client_session_env_key(key.as_ref()))
        .map(|key| key.as_ref().to_owned())
        .collect()
}
