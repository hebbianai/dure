//! Input the person ran in Claude Code itself instead of sending it as a
//! prompt, and what that input printed. Claude Code records both as user
//! records whose whole text is one envelope of tags. Chat's seeded history
//! (`agent-sdk-history.mjs`, `localCommand`) follows the same rule.

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ClaudeLocalCommand {
    /// The command line the person ran: `/effort max` for a slash command,
    /// `! git status` for shell input.
    Input(String),
    /// What the command printed, which Claude Code wrote.
    Output,
}

const SLASH_COMMAND_TAGS: &[&str] = &["command-name", "command-message", "command-args"];
const SHELL_INPUT_TAGS: &[&str] = &["bash-input"];
const OUTPUT_TAGS: &[&str] = &[
    "local-command-stdout",
    "local-command-stderr",
    "bash-stdout",
    "bash-stderr",
];

/// The command `text` records, or None for any other text, including the
/// person's own text that only mentions one of these tags.
pub(crate) fn claude_local_command(text: &str) -> Option<ClaudeLocalCommand> {
    if let Some(elements) = envelope(text, SLASH_COMMAND_TAGS) {
        let field = |tag: &str| {
            elements
                .iter()
                .find(|(name, _)| *name == tag)
                .map(|(_, body)| body.trim())
        };
        let name = field("command-name").filter(|name| !name.is_empty())?;
        return Some(ClaudeLocalCommand::Input(
            match field("command-args").filter(|args| !args.is_empty()) {
                Some(args) => format!("{name} {args}"),
                None => name.to_string(),
            },
        ));
    }
    if let Some([(_, command)]) = envelope(text, SHELL_INPUT_TAGS).as_deref() {
        return Some(ClaudeLocalCommand::Input(format!("! {}", command.trim())));
    }
    envelope(text, OUTPUT_TAGS).map(|_| ClaudeLocalCommand::Output)
}

/// `text` as `<tag>…</tag>` elements with nothing but whitespace around
/// them, each tag from `tags` and at most once.
fn envelope<'a>(text: &'a str, tags: &[&'static str]) -> Option<Vec<(&'static str, &'a str)>> {
    let mut rest = text.trim_start();
    let mut elements: Vec<(&'static str, &'a str)> = Vec::new();
    while !rest.is_empty() {
        let (tag, after_open) = tags.iter().find_map(|tag| {
            rest.strip_prefix('<')
                .and_then(|after| after.strip_prefix(*tag))
                .and_then(|after| after.strip_prefix('>'))
                .map(|after| (*tag, after))
        })?;
        if elements.iter().any(|(seen, _)| *seen == tag) {
            return None;
        }
        let close = format!("</{tag}>");
        let end = after_open.find(&close)?;
        elements.push((tag, &after_open[..end]));
        rest = after_open[end + close.len()..].trim_start();
    }
    (!elements.is_empty()).then_some(elements)
}
