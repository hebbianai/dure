use super::*;
use crate::{Limits, activity_from_file, claude_turn, read_window, transcript_from_file};
use serde_json::json;
use std::io::Write;

fn write_lines(lines: &[Value]) -> tempfile::NamedTempFile {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
    file
}

fn user(text: &str) -> Value {
    json!({"type":"user","message":{"content":text}})
}

fn assistant_text(text: &str) -> Value {
    json!({"type":"assistant","message":{"content":[{"type":"text","text":text}]}})
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type":"assistant","message":{"content":[
        {"type":"tool_use","id":id,"name":name,"input":input}
    ]}})
}

fn tool_result(id: &str, is_error: bool) -> Value {
    json!({"type":"user","message":{"content":[
        {"type":"tool_result","tool_use_id":id,"content":"output stays behind","is_error":is_error}
    ]}})
}

fn summary(tools: &[ProviderToolCall]) -> Vec<(usize, &str, &str, ProviderToolState)> {
    tools
        .iter()
        .map(|call| {
            (
                call.after_entries,
                call.call_id.as_str(),
                call.name.as_str(),
                call.state,
            )
        })
        .collect()
}

#[test]
fn claude_calls_sit_between_the_messages_with_how_they_ended() {
    let file = write_lines(&[
        user("Fix the build"),
        assistant_text("Looking."),
        tool_use("toolu_1", "Read", json!({"file_path":"/repo/src/lib.rs"})),
        tool_result("toolu_1", false),
        tool_use("toolu_2", "Bash", json!({"command":"cargo test"})),
        tool_result("toolu_2", true),
        assistant_text("Fixed."),
        user("Thanks, once more"),
        tool_use("toolu_3", "Bash", json!({"command":"cargo build"})),
    ]);
    let read = activity_from_file(file.path(), "claude", "c").unwrap();
    assert_eq!(read.transcript.entries.len(), 4);
    assert_eq!(
        summary(&read.tools),
        [
            (2, "toolu_1", "Read", ProviderToolState::Completed),
            (2, "toolu_2", "Bash", ProviderToolState::Failed),
            (4, "toolu_3", "Bash", ProviderToolState::Running),
        ]
    );
    assert_eq!(read.tools[0].input, json!({"file_path":"/repo/src/lib.rs"}));
}

#[test]
fn a_record_text_comes_before_the_calls_it_makes() {
    let file = write_lines(&[
        user("Go"),
        json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"Reading it."},
            {"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a"}}
        ]}}),
    ]);
    let read = activity_from_file(file.path(), "claude", "c").unwrap();
    assert_eq!(read.transcript.entries.len(), 2);
    assert_eq!(read.tools[0].after_entries, 2);
}

#[test]
fn a_subagent_call_and_an_unmatched_result_are_not_the_conversation_calls() {
    let mut sidechain = tool_use("toolu_side", "Bash", json!({"command":"ls"}));
    sidechain["isSidechain"] = json!(true);
    let file = write_lines(&[user("Go"), sidechain, tool_result("toolu_elsewhere", true)]);
    let read = activity_from_file(file.path(), "claude", "c").unwrap();
    assert!(read.tools.is_empty());
}

#[test]
fn a_long_input_keeps_only_its_short_scannable_fields() {
    let content = "x".repeat(MAX_TOOL_INPUT_BYTES);
    let file = write_lines(&[
        user("Write it"),
        tool_use(
            "toolu_1",
            "Write",
            json!({"file_path":"/repo/big.txt","content":content}),
        ),
    ]);
    let read = activity_from_file(file.path(), "claude", "c").unwrap();
    assert_eq!(
        read.tools[0].input,
        json!({"file_path":"/repo/big.txt","truncated":true})
    );
}

#[test]
fn the_text_only_read_is_unchanged_by_tool_records() {
    let file = write_lines(&[
        user("Go"),
        tool_use("toolu_1", "Bash", json!({"command":"ls"})),
        tool_result("toolu_1", false),
        assistant_text("Done."),
    ]);
    let read = transcript_from_file(file.path(), "claude", "c", claude_turn).unwrap();
    let encoded = serde_json::to_value(&read).unwrap();
    let without_tools = ProviderConversationActivity {
        transcript: read.clone(),
        tools: Vec::new(),
    };
    assert_eq!(serde_json::to_value(&without_tools).unwrap(), encoded);
    assert_eq!(
        encoded["entries"],
        json!([{"role":"user","text":"Go"},{"role":"agent","text":"Done."}])
    );
    assert!(encoded.get("tools").is_none());
    let activity =
        serde_json::to_value(activity_from_file(file.path(), "claude", "c").unwrap()).unwrap();
    assert_eq!(activity["entries"], encoded["entries"]);
    assert_eq!(
        activity["tools"],
        json!([{
            "afterEntries": 1,
            "callId": "toolu_1",
            "name": "Bash",
            "state": "completed",
            "input": {"command":"ls"}
        }])
    );
}

/// A call made before a message the window left out is left out with it; a
/// call after the last left-out message opens the window, as an agent reply
/// whose prompt was left out does.
#[test]
fn calls_before_a_left_out_message_are_left_out_and_the_rest_rebased() {
    let file = write_lines(&[
        tool_use("toolu_0", "Read", json!({"file_path":"z"})),
        user("one"),
        tool_use("toolu_1", "Read", json!({"file_path":"a"})),
        user("two"),
        tool_use("toolu_2", "Read", json!({"file_path":"b"})),
        user("three"),
        tool_use("toolu_3", "Read", json!({"file_path":"c"})),
    ]);
    let (transcript, tools) = read_window(
        file.path(),
        "claude",
        "c",
        claude_turn,
        Some(claude_tool_events),
        Limits {
            source: 1024 * 1024,
            output: 1024,
            entries: 2,
        },
    )
    .unwrap();
    assert!(!transcript.history_complete);
    assert_eq!(transcript.entries[0].text, "two");
    assert_eq!(
        summary(&tools),
        [
            (0, "toolu_1", "Read", ProviderToolState::Running),
            (1, "toolu_2", "Read", ProviderToolState::Running),
            (2, "toolu_3", "Read", ProviderToolState::Running),
        ]
    );
}

#[test]
fn the_tool_window_leaves_the_oldest_calls_out_past_its_budget() {
    let mut window = ToolWindow::default();
    let call = |index: usize| ToolEvent::Call {
        call_id: format!("call-{index}"),
        name: "Read".to_string(),
        state: ProviderToolState::Running,
        input: Value::Null,
    };
    let complete: Vec<bool> = (0..=MAX_TOOL_CALLS)
        .map(|index| window.apply(vec![call(index)], 0))
        .collect();
    assert!(complete[..MAX_TOOL_CALLS].iter().all(|complete| *complete));
    assert!(!complete[MAX_TOOL_CALLS]);
    // The oldest call is gone; a result for it no longer lands anywhere, and
    // the newest still takes its result.
    window.apply(
        vec![
            ToolEvent::Result {
                call_id: "call-0".to_string(),
                state: ProviderToolState::Failed,
            },
            ToolEvent::Result {
                call_id: format!("call-{MAX_TOOL_CALLS}"),
                state: ProviderToolState::Completed,
            },
        ],
        0,
    );
    let calls = window.finish(0);
    assert_eq!(calls.len(), MAX_TOOL_CALLS);
    assert_eq!(calls[0].call_id, "call-1");
    assert_eq!(calls.last().unwrap().state, ProviderToolState::Completed);
}

fn codex_item(item: Value) -> Value {
    json!({"type":"event_msg","payload":{"type":"item_completed","item":item}})
}

#[test]
fn codex_completed_items_are_named_as_the_structured_timeline_names_them() {
    let session = json!({"type":"session_meta","payload":{"id":"t"}});
    let prompt = json!({"type":"event_msg","payload":{"type":"user_message","message":"Fix it"}});
    let answer = json!({"type":"response_item","payload":{
        "type":"message","role":"assistant",
        "content":[{"type":"output_text","text":"Fixed."}]
    }});
    let file = write_lines(&[
        session,
        prompt,
        codex_item(json!({
            "type":"CommandExecution","id":"exec-1",
            "command":["/bin/zsh","-lc","cargo test"],"status":"failed","exit_code":101,
            "aggregated_output":"output stays behind"
        })),
        codex_item(json!({
            "type":"FileChange","id":"exec-2","status":"completed",
            "changes":{"/repo/a.rs":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b\n","move_path":null}}
        })),
        codex_item(json!({
            "type":"McpToolCall","id":"exec-3","server":"docs","tool":"search",
            "arguments":{"q":"x"},"status":"completed","result":"output stays behind"
        })),
        codex_item(json!({"type":"Extension","kind":"web.search","id":"exec-4","query":"rust"})),
        codex_item(json!({"type":"ImageView","id":"exec-5","path":"/tmp/a.png"})),
        codex_item(json!({"type":"Reasoning","id":"r-1"})),
        codex_item(json!({"type":"Extension","kind":"other","id":"exec-6"})),
        answer,
    ]);
    let read = activity_from_file(file.path(), "codex", "t").unwrap();
    assert_eq!(read.transcript.entries.len(), 2);
    assert_eq!(
        summary(&read.tools),
        [
            (1, "exec-1", "commandExecution", ProviderToolState::Failed),
            (1, "exec-2", "fileChange", ProviderToolState::Completed),
            (1, "exec-3", "mcpToolCall", ProviderToolState::Completed),
            (1, "exec-4", "webSearch", ProviderToolState::Completed),
            (1, "exec-5", "imageView", ProviderToolState::Completed),
        ]
    );
    assert_eq!(read.tools[0].input, json!({"command":"cargo test"}));
    assert_eq!(
        read.tools[1].input,
        json!({"changes":[{"path":"/repo/a.rs","kind":"update","diff":"@@ -1 +1 @@\n-a\n+b\n"}]})
    );
    assert_eq!(
        read.tools[2].input,
        json!({"server":"docs","tool":"search","arguments":{"q":"x"}})
    );
}

#[test]
fn a_long_codex_patch_keeps_its_files_without_the_diffs() {
    let diff = "+".repeat(MAX_TOOL_INPUT_BYTES);
    let event = codex_item(json!({
        "type":"FileChange","id":"exec-1","status":"completed",
        "changes":{"/repo/a.rs":{"type":"add","unified_diff":diff}}
    }));
    let events: [ToolEvent; 1] = codex_tool_events(&event).try_into().unwrap();
    let [ToolEvent::Call { input, .. }] = events else {
        panic!("one call");
    };
    assert_eq!(
        input,
        json!({"changes":[{"path":"/repo/a.rs","kind":"add"}],"truncated":true})
    );
}

#[test]
fn a_codex_command_that_is_not_a_shell_wrapper_reads_as_its_words() {
    assert_eq!(
        codex_command(Some(&json!(["git", "status", "--short"]))).as_deref(),
        Some("git status --short")
    );
    assert_eq!(codex_command(Some(&json!("ls"))).as_deref(), Some("ls"));
    assert_eq!(codex_command(Some(&json!([1, 2]))), None);
}
