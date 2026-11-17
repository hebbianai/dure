//! A native provider's permission prompt: what it asks, as its hook reports
//! it, and the keys its terminal UI takes for each answer.
//!
//! A chat or phone surface shows the prompt and answers it by sending these
//! keys through the Host's attention response, which writes them only while
//! that exact approval is pending and no one has typed into the terminal
//! since it was raised. Every Claude spelling lives here, so the hook path,
//! the desktop answer and the paired-phone answer cannot drift apart. The
//! Windows direct hook (`managed-claude-hook.py`) mirrors the prompt reading.

use serde_json::{Map, Value};

/// What one Claude `PermissionRequest` hook event asks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaudePermissionPrompt {
    /// `AskUserQuestion`: the person answers a question, not an approval.
    Question,
    /// An approval, with its content when it is a plain approve/deny prompt.
    Approval(Option<NativeApprovalPrompt>),
}

/// A plain approve/deny prompt a chat can show and answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeApprovalPrompt {
    pub tool_name: String,
    /// The tool input a person needs to judge the request, bounded.
    pub summary: String,
    /// Whether the prompt offers "Yes, and don't ask again".
    pub approve_always: bool,
}

/// Tools whose permission prompt is not a plain approve/deny question: the
/// plan review has its own options.
const CLAUDE_UNANSWERABLE_TOOLS: &[&str] = &["ExitPlanMode"];

/// The input field that says what each tool acts on. Other tools show their
/// whole input.
const CLAUDE_SUMMARY_FIELDS: &[(&str, &str)] = &[
    ("Bash", "command"),
    ("Edit", "file_path"),
    ("MultiEdit", "file_path"),
    ("Write", "file_path"),
    ("Read", "file_path"),
    ("NotebookEdit", "notebook_path"),
    ("WebFetch", "url"),
    ("WebSearch", "query"),
    ("Glob", "pattern"),
    ("Grep", "pattern"),
];

/// Every input field a Claude permission prompt is summarized from, for a
/// reporter that must slim an oversized hook body without losing it.
pub fn claude_approval_summary_fields() -> impl Iterator<Item = &'static str> {
    CLAUDE_SUMMARY_FIELDS.iter().map(|(_, field)| *field)
}

/// Reads one Claude `PermissionRequest` hook event. The summary is printable
/// (control characters other than line breaks and tabs become spaces) and at
/// most `max_summary_bytes`, cut on a character boundary. Claude offers
/// "don't ask again" exactly when it has permission suggestions.
#[must_use]
pub fn claude_permission_prompt(
    event: &Map<String, Value>,
    max_summary_bytes: usize,
) -> ClaudePermissionPrompt {
    let tool_name = event
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool_name == "AskUserQuestion" {
        return ClaudePermissionPrompt::Question;
    }
    if tool_name.is_empty() || CLAUDE_UNANSWERABLE_TOOLS.contains(&tool_name) {
        return ClaudePermissionPrompt::Approval(None);
    }
    let input = event.get("tool_input");
    let field = CLAUDE_SUMMARY_FIELDS
        .iter()
        .find(|(tool, _)| *tool == tool_name)
        .map(|(_, field)| *field);
    let text = match (field, input) {
        (Some(field), Some(input)) => input
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        (None, Some(input)) if !input.is_null() => input.to_string(),
        _ => String::new(),
    };
    ClaudePermissionPrompt::Approval(Some(NativeApprovalPrompt {
        tool_name: tool_name.to_string(),
        summary: bounded_summary(&text, max_summary_bytes),
        approve_always: event
            .get("permission_suggestions")
            .and_then(Value::as_array)
            .is_some_and(|suggestions| !suggestions.is_empty()),
    }))
}

fn bounded_summary(text: &str, max_bytes: usize) -> String {
    const ELLIPSIS: char = '…';
    let printable: String = text
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() && c != '\n' && c != '\t' {
                ' '
            } else {
                c
            }
        })
        .collect();
    if printable.len() <= max_bytes {
        return printable;
    }
    let mut end = max_bytes.saturating_sub(ELLIPSIS.len_utf8());
    while !printable.is_char_boundary(end) {
        end -= 1;
    }
    let mut summary = printable[..end].to_string();
    summary.push(ELLIPSIS);
    summary
}

/// Claude Code numbers its permission options: 1 is "Yes", 2 is "Yes, and
/// don't ask again" when it offers one, and Escape is always "No". A number
/// picks its option directly, wherever the cursor stands. Each key is a W3C
/// `KeyboardEvent` key and code.
const CLAUDE_APPROVE: &[(&str, &str)] = &[("1", "Digit1")];
const CLAUDE_APPROVE_ALWAYS: &[(&str, &str)] = &[("2", "Digit2")];
const CLAUDE_DENY: &[(&str, &str)] = &[("Escape", "Escape")];

/// The keys (W3C key and code) that pick `choice` (`approve`,
/// `approve_always` or `deny`, the wire names of the Host's approval
/// choices) in `provider_id`'s approval prompt, or `None` when this
/// provider's prompt is not known.
#[must_use]
pub fn native_approval_answer_keys(
    provider_id: &str,
    choice: &str,
) -> Option<&'static [(&'static str, &'static str)]> {
    match (provider_id, choice) {
        ("claude", "approve") => Some(CLAUDE_APPROVE),
        ("claude", "approve_always") => Some(CLAUDE_APPROVE_ALWAYS),
        ("claude", "deny") => Some(CLAUDE_DENY),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(event: Value) -> ClaudePermissionPrompt {
        claude_permission_prompt(event.as_object().unwrap(), 2048)
    }

    fn approval(event: Value) -> NativeApprovalPrompt {
        match prompt(event) {
            ClaudePermissionPrompt::Approval(Some(approval)) => approval,
            other => panic!("expected a plain approval, got {other:?}"),
        }
    }

    #[test]
    fn a_prompt_reads_its_command_path_or_whole_input() {
        let bash = approval(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "cargo test -p dure", "description": "Run tests" },
            "permission_suggestions": [{ "type": "addRules" }],
        }));
        assert_eq!(bash.summary, "cargo test -p dure");
        assert!(bash.approve_always);
        let write = approval(serde_json::json!({
            "tool_name": "Write",
            "tool_input": { "file_path": "/tmp/fixture.txt", "content": "secret body" },
        }));
        assert_eq!(write.summary, "/tmp/fixture.txt");
        assert!(!write.approve_always);
        let mcp = approval(serde_json::json!({
            "tool_name": "mcp__fixture__lookup",
            "tool_input": { "id": 7 },
        }));
        assert_eq!(mcp.summary, r#"{"id":7}"#);
        assert!(claude_approval_summary_fields().any(|field| field == "file_path"));
    }

    #[test]
    fn a_long_or_unprintable_input_is_bounded_on_a_character_boundary() {
        let command = format!("echo {}\r\u{1b}[2J", "가".repeat(2000));
        let bash = approval(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": command },
        }));
        assert!(bash.summary.len() <= 2048);
        assert!(bash.summary.ends_with('…'));
        assert!(!bash.summary.contains('\u{1b}'));
    }

    #[test]
    fn prompts_that_are_not_plain_approvals_carry_no_content() {
        assert_eq!(
            prompt(serde_json::json!({ "tool_name": "AskUserQuestion" })),
            ClaudePermissionPrompt::Question
        );
        for event in [
            serde_json::json!({ "tool_name": "ExitPlanMode", "tool_input": { "plan": "p" } }),
            serde_json::json!({ "tool_input": { "command": "ls" } }),
        ] {
            assert_eq!(prompt(event), ClaudePermissionPrompt::Approval(None));
        }
    }

    #[test]
    fn claude_choices_name_their_prompt_options() {
        assert_eq!(
            native_approval_answer_keys("claude", "approve"),
            Some(&[("1", "Digit1")][..])
        );
        assert_eq!(
            native_approval_answer_keys("claude", "approve_always"),
            Some(&[("2", "Digit2")][..])
        );
        assert_eq!(
            native_approval_answer_keys("claude", "deny"),
            Some(&[("Escape", "Escape")][..])
        );
    }

    #[test]
    fn an_unknown_provider_or_choice_has_no_answer() {
        assert_eq!(native_approval_answer_keys("codex", "approve"), None);
        assert_eq!(native_approval_answer_keys("claude", "maybe"), None);
    }
}
