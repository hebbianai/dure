use super::*;
use crate::{
    Limits, ProviderToolState, TranscriptRoots, TranscriptWindow, activity_from_file,
    read_roots_activity_page, read_window,
};
use serde_json::json;
use std::io::Write;

const SESSION: &str = "01a08472-815b-781e-b56a-89b2a12f7771";

/// A Pi session file being written entry by entry, with each entry's offset.
struct Session {
    file: tempfile::NamedTempFile,
    offsets: HashMap<String, u64>,
}

impl Session {
    fn new() -> Self {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session","version":3,"id":SESSION,"cwd":"/workspace"})
        )
        .unwrap();
        Self {
            file,
            offsets: HashMap::new(),
        }
    }

    fn entry(&mut self, id: &str, parent: Option<&str>, entry: Value) -> &mut Self {
        let mut entry = entry;
        entry["id"] = json!(id);
        entry["parentId"] = json!(parent);
        let offset = self.file.as_file().metadata().unwrap().len();
        writeln!(self.file, "{entry}").unwrap();
        self.offsets.insert(id.into(), offset);
        self
    }

    fn message(&mut self, id: &str, parent: Option<&str>, message: Value) -> &mut Self {
        self.entry(id, parent, json!({"type":"message","message":message}))
    }

    fn prompt(&mut self, id: &str, parent: Option<&str>, text: &str) -> &mut Self {
        self.message(
            id,
            parent,
            json!({"role":"user","content":[{"type":"text","text":text}],"timestamp":1}),
        )
    }

    fn reply(&mut self, id: &str, parent: &str, text: &str) -> &mut Self {
        self.message(
            id,
            Some(parent),
            json!({"role":"assistant","content":[{"type":"text","text":text}],"stopReason":"stop","timestamp":2}),
        )
    }

    fn path(&self) -> &Path {
        self.file.path()
    }

    fn at(&self, id: &str) -> u64 {
        self.offsets[id]
    }
}

fn read(path: &Path, before: Option<u64>, limits: Limits) -> TranscriptWindow {
    read_window(
        path,
        "pi",
        SESSION,
        pi_turn,
        Some(crate::pi_tool_events),
        limits,
        before,
        0,
    )
    .unwrap()
}

fn texts(window: &TranscriptWindow) -> Vec<String> {
    window
        .transcript
        .entries
        .iter()
        .map(|entry| entry.text.clone())
        .collect()
}

/// Pages back from the newest read with `limits`, oldest first.
fn pages(path: &Path, limits: Limits) -> Vec<TranscriptWindow> {
    let mut pages = vec![read(path, None, limits)];
    while let Some(before) = pages.last().unwrap().older_cursor {
        pages.push(read(path, Some(before), limits));
    }
    pages.reverse();
    pages
}

/// A reader shows a Pi conversation the way its Chat timeline does: the
/// person's prompts, the replies' text, the commands the person ran in Pi
/// itself, and each tool call with how its result says it ended. What a
/// command printed, thinking and settings changes are no messages.
#[test]
fn pi_messages_commands_and_tool_calls_read_like_the_chat_timeline() {
    let mut session = Session::new();
    session
        .entry("m", None, json!({"type":"model_change","provider":"fixture","modelId":"model-a"}))
        .prompt("u1", Some("m"), "List the files")
        .message(
            "a1",
            Some("u1"),
            json!({"role":"assistant","content":[
                {"type":"thinking","thinking":"Use bash."},
                {"type":"toolCall","id":"call-ok","name":"bash","arguments":{"command":"ls"}},
                {"type":"toolCall","id":"call-bad","name":"read","arguments":{"path":"missing"}}
            ],"stopReason":"toolUse","timestamp":2}),
        )
        .message(
            "r1",
            Some("a1"),
            json!({"role":"toolResult","toolCallId":"call-ok","toolName":"bash","content":[{"type":"text","text":"a\nb"}],"isError":false,"timestamp":3}),
        )
        .message(
            "r2",
            Some("r1"),
            json!({"role":"toolResult","toolCallId":"call-bad","toolName":"read","content":[{"type":"text","text":"ENOENT"}],"isError":true,"timestamp":3}),
        )
        .reply("a2", "r2", "Two files.")
        .message(
            "b1",
            Some("a2"),
            json!({"role":"bashExecution","command":" git status ","output":"clean","exitCode":0,"timestamp":4}),
        )
        .message(
            "b2",
            Some("b1"),
            json!({"role":"bashExecution","command":"cat .env","output":"secret","excludeFromContext":true,"timestamp":5}),
        );
    let read = activity_from_file(session.path(), "pi", SESSION).unwrap();
    assert_eq!(
        read.transcript
            .entries
            .iter()
            .map(|entry| (entry.role, entry.text.as_str()))
            .collect::<Vec<_>>(),
        [
            (ConversationTurnRole::User, "List the files"),
            (ConversationTurnRole::Agent, "Two files."),
            (ConversationTurnRole::User, "! git status"),
            (ConversationTurnRole::User, "!! cat .env"),
        ]
    );
    assert_eq!(
        read.tools
            .iter()
            .map(|call| (
                call.call_id.as_str(),
                call.name.as_str(),
                call.state,
                call.after_entries
            ))
            .collect::<Vec<_>>(),
        [
            ("call-ok", "bash", ProviderToolState::Completed, 1),
            ("call-bad", "read", ProviderToolState::Failed, 1),
        ]
    );
    assert_eq!(read.tools[0].input, json!({"command":"ls"}));
    assert_eq!(
        read.transcript.final_response, None,
        "a later command clears it"
    );
    assert!(read.transcript.history_complete);
    assert_eq!(read.older_cursor, None);
}

/// The file also holds a branch the person left with `/tree`: a prompt and
/// its reply that the conversation no longer contains. Every page shows the
/// conversation's branch only, and paging back joins the pages exactly.
#[test]
fn pages_follow_the_conversation_branch_and_leave_other_branches_out() {
    let mut session = Session::new();
    session
        .prompt("u1", None, "first")
        .reply("a1", "u1", "first answer")
        .prompt("u2", Some("a1"), "abandoned")
        .reply("a2", "u2", "abandoned answer")
        .prompt("u3", Some("a1"), "second")
        .reply("a3", "u3", "second answer");
    for index in 4..12 {
        let (prompt, reply) = (format!("u{index}"), format!("a{index}"));
        let parent = format!("a{}", index - 1);
        session
            .prompt(&prompt, Some(&parent), &format!("prompt {index}"))
            .reply(&reply, &prompt, &format!("answer {index}"));
    }
    let mut expected = vec!["first", "first answer", "second", "second answer"]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
    for index in 4..12 {
        expected.extend([format!("prompt {index}"), format!("answer {index}")]);
    }

    let whole = read(session.path(), None, Limits::DEFAULT);
    assert_eq!(texts(&whole), expected);
    assert!(whole.transcript.history_complete);
    assert_eq!(whole.older_cursor, None);

    for limits in [
        // By messages: pages end on whole records of the branch.
        Limits {
            entries: 3,
            ..Limits::PAGE
        },
        // By bytes: a page's range ends inside the branch, or inside the
        // branch the person left.
        Limits {
            source: 600,
            ..Limits::PAGE
        },
    ] {
        let pages = pages(session.path(), limits);
        assert!(pages.len() > 2);
        assert_eq!(pages.iter().flat_map(texts).collect::<Vec<_>>(), expected);
        assert!(pages[0].transcript.history_complete);
    }

    // A history that starts at a branch entry pages back from it: the Chat
    // window's place in the file.
    let older = read(session.path(), Some(session.at("u4")), Limits::PAGE);
    assert_eq!(texts(&older), expected[..4]);
    assert_eq!(older.older_cursor, None);
    assert!(older.transcript.history_complete);
}

/// A branch whose parent the file does not hold is not the whole
/// conversation, and a cursor that names no entry is not the file it was
/// measured in.
#[test]
fn a_missing_parent_is_incomplete_and_a_cursor_off_an_entry_fails() {
    let mut session = Session::new();
    session
        .prompt("u2", Some("gone"), "orphan")
        .reply("a2", "u2", "orphan answer");
    let read_all = read(session.path(), None, Limits::DEFAULT);
    assert_eq!(texts(&read_all), ["orphan", "orphan answer"]);
    assert!(!read_all.transcript.history_complete);
    assert_eq!(read_all.older_cursor, None);

    // The session header is no entry to page back from.
    assert!(
        read_window(
            session.path(),
            "pi",
            SESSION,
            pi_turn,
            Some(crate::pi_tool_events),
            Limits::PAGE,
            Some(0),
            0,
        )
        .is_err()
    );
}

/// The backend reads a Pi conversation under Pi's state directory, wherever
/// Pi filed it, and only the file whose header names it.
#[test]
fn the_backend_finds_a_pi_conversation_under_its_state_directory() {
    let home = tempfile::tempdir().unwrap();
    let roots = TranscriptRoots::in_state_directory(home.path());
    let project = roots.pi_sessions.join("--workspace--");
    fs::create_dir_all(&project).unwrap();
    let mut session = Session::new();
    session
        .prompt("u1", None, "first")
        .reply("a1", "u1", "first answer")
        .prompt("u2", Some("a1"), "second")
        .reply("a2", "u2", "second answer");
    let filed = project.join(format!("2026-11-27T00-00-00-000Z_{SESSION}.jsonl"));
    fs::copy(session.path(), &filed).unwrap();
    // Another session's file under a name that ends the same way.
    let other = format!("{}\n", json!({"type":"session","id":"another"}));
    fs::write(
        project.join(format!("2026-11-27T00-00-01-000Z_{SESSION}.jsonl")),
        format!("{other}{}", fs::read_to_string(session.path()).unwrap()),
    )
    .unwrap();

    assert_eq!(
        find_pi_conversation(&roots.pi_sessions, SESSION),
        Some(filed)
    );
    let page = read_roots_activity_page(&roots, "pi", SESSION, session.at("u2"), 0).unwrap();
    assert_eq!(
        page.transcript
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        ["first", "first answer"]
    );
    assert_eq!(page.older_cursor, None);
    assert_eq!(find_pi_conversation(&roots.pi_sessions, "missing"), None);
    assert_eq!(find_pi_conversation(&roots.pi_sessions, "../escape"), None);

    // A sessions directory Pi was given holds its files directly.
    let given = home.path().join("given");
    fs::create_dir(&given).unwrap();
    let direct = given.join(format!("2026-11-27T00-00-02-000Z_{SESSION}.jsonl"));
    fs::copy(session.path(), &direct).unwrap();
    assert_eq!(find_pi_conversation(&given, SESSION), Some(direct));
}
