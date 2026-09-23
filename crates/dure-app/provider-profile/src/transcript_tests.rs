use super::*;
use std::io::Write;

fn record(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"user","message":{"content":text}})
    )
}

#[test]
fn oversized_source_retains_recent_complete_records() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    // A sparse old tool record exercises the production byte limit without
    // allocating the entire source in the test or reading its old prefix.
    file.as_file()
        .set_len(MAX_TRANSCRIPT_SOURCE_BYTES + 128)
        .unwrap();
    file.seek(SeekFrom::End(0)).unwrap();
    writeln!(file).unwrap();
    write!(file, "{}{}", record("recent one"), record("recent two")).unwrap();
    let result = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert!(!result.history_complete);
    assert_eq!(
        result
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        ["recent one", "recent two"]
    );
}

#[test]
fn suffix_discards_split_utf8_and_keeps_record_on_exact_boundary() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let latest = record("latest 한글");
    write!(file, "{}{}", record("old 한글"), latest).unwrap();
    for extra in [0, 4] {
        let result = transcript_window(
            file.path(),
            "claude",
            "test",
            claude_turn,
            latest.len() as u64 + extra,
            1024,
            10,
        )
        .unwrap();
        assert!(!result.history_complete);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].text, "latest 한글");
    }
}

#[test]
fn output_budget_keeps_latest_entries_and_does_not_claim_full_history() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(file, "{}{}{}", record("old"), record("new"), record("last")).unwrap();
    for (bytes, entries) in [(7, 10), (1024, 2)] {
        let result = transcript_window(
            file.path(),
            "claude",
            "test",
            claude_turn,
            1024,
            bytes,
            entries,
        )
        .unwrap();
        assert!(!result.history_complete);
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| entry.text.as_str())
                .collect::<Vec<_>>(),
            ["new", "last"]
        );
    }
}

#[test]
fn partial_append_is_incomplete_and_new_prompt_clears_previous_final() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    writeln!(file, "{}", serde_json::json!({"type":"assistant","message":{"content":"done","stop_reason":"end_turn"}})).unwrap();
    let complete = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert!(complete.history_complete);
    assert_eq!(complete.final_response.as_deref(), Some("done"));
    write!(file, "{}{{\"type\":", record("next")).unwrap();
    let partial = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert!(!partial.history_complete);
    assert_eq!(partial.final_response, None);
    assert_eq!(partial.entries.last().unwrap().text, "next");
}
