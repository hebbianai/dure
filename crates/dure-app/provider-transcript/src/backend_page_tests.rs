use super::*;
use crate::{ConversationTurnRole, MAX_BACKEND_PAGE_OUTPUT_BYTES, ProviderToolState};
use serde_json::json;

fn said(role: ConversationTurnRole, text: &str) -> ConversationRecord {
    ConversationRecord {
        entry: Some(ProviderTranscriptEntry {
            role,
            text: text.into(),
        }),
        tool_events: Vec::new(),
    }
}

fn prompt(text: &str) -> ConversationRecord {
    said(ConversationTurnRole::User, text)
}

fn answer(text: &str) -> ConversationRecord {
    said(ConversationTurnRole::Agent, text)
}

fn call(id: &str, state: ProviderToolState) -> ConversationRecord {
    ConversationRecord {
        entry: None,
        tool_events: vec![ToolEvent::Call {
            call_id: id.into(),
            name: "bash".into(),
            state,
            input: json!({"command": "ls"}),
        }],
    }
}

fn texts(page: &ProviderConversationActivity) -> Vec<&str> {
    page.transcript
        .entries
        .iter()
        .map(|entry| entry.text.as_str())
        .collect()
}

/// Places added newest first read oldest first, each call between the
/// messages it was made between, as a transcript page reads.
#[test]
fn a_page_reads_oldest_first_with_its_calls_between_its_messages() {
    let mut page = BackendActivityPage::new("opencode", "ses_page");

    assert_eq!(
        page.prepend(vec![prompt("second prompt"), answer("second answer")]),
        Prepended::Added
    );
    assert_eq!(
        page.prepend(vec![
            prompt("first prompt"),
            call("call-1", ProviderToolState::Completed),
            answer("first answer"),
        ]),
        Prepended::Added
    );
    let page = page.finish(Some(42));

    assert_eq!(
        texts(&page),
        [
            "first prompt",
            "first answer",
            "second prompt",
            "second answer"
        ]
    );
    assert_eq!(page.tools.len(), 1);
    assert_eq!(page.tools[0].after_entries, 1);
    assert_eq!(page.tools[0].state, ProviderToolState::Completed);
    assert_eq!(page.older_cursor, Some(42));
    assert!(
        !page.transcript.history_complete,
        "older records precede the page"
    );
}

/// A place that does not fit beside the newer ones ends the page before it,
/// whole, so the next older page starts with it.
#[test]
fn a_place_that_does_not_fit_starts_the_next_page_whole() {
    let half = "h".repeat(MAX_BACKEND_PAGE_OUTPUT_BYTES / 2);
    let mut page = BackendActivityPage::new("opencode", "ses_page");

    assert_eq!(page.prepend(vec![answer(&half)]), Prepended::Added);
    assert_eq!(
        page.prepend(vec![prompt("older"), answer(&half)]),
        Prepended::Full
    );
    let page = page.finish(Some(7));

    assert_eq!(page.transcript.entries.len(), 1, "nothing of it is kept");
}

/// Records larger than a whole page can never be shown: they are left out,
/// and the page goes on before them without claiming to be whole.
#[test]
fn a_place_larger_than_a_page_is_left_out() {
    let oversized = "o".repeat(MAX_BACKEND_PAGE_OUTPUT_BYTES + 1);
    let mut page = BackendActivityPage::new("opencode", "ses_page");

    assert_eq!(page.prepend(vec![answer(&oversized)]), Prepended::LeftOut);
    assert_eq!(page.prepend(vec![prompt("before it")]), Prepended::Added);
    let page = page.finish(None);

    assert_eq!(texts(&page), ["before it"]);
    assert!(!page.transcript.history_complete);
}

#[test]
fn a_page_that_reaches_the_start_whole_is_complete() {
    let mut page = BackendActivityPage::new("opencode", "ses_page");
    page.prepend(vec![prompt("only prompt")]);
    let whole = page.finish(None);
    assert!(whole.transcript.history_complete);

    let mut page = BackendActivityPage::new("opencode", "ses_page");
    page.prepend(vec![prompt("only prompt")]);
    page.leave_out();
    assert!(
        !page.finish(None).transcript.history_complete,
        "a record it could not read is missing"
    );
}
