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

#[test]
fn project_move_claude_reads_exact_history_in_its_selected_account_without_mutation() {
    let root = tempfile::tempdir().unwrap();
    let account = root.path().join("account-a");
    let project = account.join("projects/old-project");
    fs::create_dir_all(&project).unwrap();
    let id = "019f0000-0000-7000-8000-000000000185";
    let history = project.join(format!("{id}.jsonl"));
    let bytes = format!(
        "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"message\":{{\"content\":\"retain me\"}}}}\n"
    );
    fs::write(&history, &bytes).unwrap();
    assert_eq!(
        preflight_project_move_history("claude", Some(account.clone()), id),
        Ok(())
    );
    assert_eq!(fs::read_to_string(&history).unwrap(), bytes);
    assert_eq!(
        preflight_project_move_history("claude", Some(root.path().join("account-b")), id),
        Err("agent_project_move_history_unavailable")
    );
    fs::write(&history, "{\"type\":\"user\",\"sessionId\":\"other\"}\n").unwrap();
    assert_eq!(
        preflight_project_move_history("claude", Some(account), id),
        Err("agent_project_move_history_unavailable")
    );
}

#[test]
fn project_move_claude_refuses_ambiguous_history_and_non_regular_transcripts() {
    let root = tempfile::tempdir().unwrap();
    let id = "019f0000-0000-7000-8000-000000000185";
    for project in ["first", "second"] {
        let directory = root.path().join("projects").join(project);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{id}.jsonl")),
            format!("{{\"type\":\"user\",\"sessionId\":\"{id}\"}}\n"),
        )
        .unwrap();
    }
    assert_eq!(
        preflight_project_move_history("claude", Some(root.path().into()), id),
        Err("agent_project_move_history_ambiguous")
    );
    let second = root.path().join(format!("projects/second/{id}.jsonl"));
    fs::remove_file(&second).unwrap();
    fs::create_dir(second).unwrap();
    assert_eq!(
        preflight_project_move_history("claude", Some(root.path().into()), id),
        Err("agent_project_move_history_unavailable")
    );
}

#[test]
fn claude_session_settings_follow_the_latest_main_thread_turn() {
    let root = tempfile::tempdir().unwrap();
    let id = "019f0000-0000-7000-8000-000000000287";
    let project = root.path().join("projects/project");
    fs::create_dir_all(&project).unwrap();
    let turn = |model: &str, effort: &str| {
        serde_json::json!({"type":"assistant","requestedModel":model,"effort":effort,
            "message":{"model":"claude-opus-5-5","content":"ok"}})
    };
    let lines = [
        turn("claude-opus-5-5[1m]", "xhigh"),
        // An in-session `/model` and `/effort` change is recorded on later turns.
        turn("claude-sonnet-5-5", "low"),
        serde_json::json!({"type":"user","message":{"content":"next"}}),
        serde_json::json!({"type":"assistant","isSidechain":true,"requestedModel":"claude-haiku-5-5",
            "effort":"medium","message":{"model":"claude-haiku-5-5","content":"subagent"}}),
        serde_json::json!({"type":"assistant","isApiErrorMessage":true,"effort":"max",
            "message":{"model":"<synthetic>","content":"rate limited"}}),
    ];
    let mut content = lines.map(|line| format!("{line}\n")).concat();
    // A record still being appended is not a turn yet.
    content.push_str("{\"type\":\"assistant\",\"requestedModel\":\"partial");
    fs::write(project.join(format!("{id}.jsonl")), content).unwrap();
    let empty = root.path().join("sessions");
    assert_eq!(
        read_session_settings_roots(&root.path().join("projects"), &empty, "claude", id),
        Ok(ProviderSessionSettings {
            model: Some("claude-sonnet-5-5".into()),
            effort: Some("low".into()),
        })
    );

    // A turn on a model without effort, or from a CLI that predates
    // `requestedModel`, records nothing to carry for that setting.
    fs::write(
        project.join(format!("{id}.jsonl")),
        format!(
            "{}\n{}\n",
            turn("claude-opus-5-5[1m]", "xhigh"),
            serde_json::json!({"type":"assistant","message":{"model":"claude-opus-5","content":"ok"}})
        ),
    )
    .unwrap();
    assert_eq!(
        read_session_settings_roots(&root.path().join("projects"), &empty, "claude", id),
        Ok(ProviderSessionSettings::default())
    );
    assert!(
        read_session_settings_roots(&root.path().join("projects"), &empty, "claude", "missing")
            .is_err()
    );
}

#[test]
fn codex_session_settings_follow_the_latest_default_mode_turn() {
    let root = tempfile::tempdir().unwrap();
    let id = "019f0000-0000-7000-8000-000000000288";
    let day = root.path().join("sessions/2026/10/30");
    fs::create_dir_all(&day).unwrap();
    let context = |model: &str, effort: &str, mode: &str| {
        serde_json::json!({"type":"turn_context","payload":{"model":model,"effort":effort,
            "collaboration_mode":{"mode":mode}}})
    };
    let lines = [
        serde_json::json!({"type":"session_meta","payload":{"id":id}}),
        context("gpt-6-astra", "xhigh", "default"),
        context("gpt-6-astra", "low", "default"),
        // Plan mode runs at its own effort setting.
        context("gpt-6-astra", "high", "plan"),
    ];
    fs::write(
        day.join(format!("rollout-2026-10-30T00-00-00-{id}.jsonl")),
        lines.map(|line| format!("{line}\n")).concat(),
    )
    .unwrap();
    assert_eq!(
        read_session_settings_roots(
            &root.path().join("projects"),
            &root.path().join("sessions"),
            "codex",
            id
        ),
        Ok(ProviderSessionSettings {
            model: Some("gpt-6-astra".into()),
            effort: Some("low".into()),
        })
    );
}

#[test]
fn session_settings_read_only_a_bounded_suffix() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let latest = format!(
        "{}\n",
        serde_json::json!({"type":"assistant","requestedModel":"claude-opus-5-5","effort":"high",
            "message":{"model":"claude-opus-5-5","content":"ok"}})
    );
    write!(file, "{}{}", record("old"), latest).unwrap();
    for extra in [0, 4] {
        let suffix = bounded_suffix(file.path(), latest.len() as u64 + extra).unwrap();
        assert_eq!(suffix, latest);
    }
}

fn page(path: &Path, before: Option<u64>, limits: Limits) -> TranscriptWindow {
    read_window(
        path,
        "claude",
        "test",
        claude_turn,
        Some(claude_tool_events),
        limits,
        before,
    )
    .unwrap()
}

fn assistant_with_call(text: &str, call_id: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"assistant","message":{"content":[
            {"type":"text","text":text},
            {"type":"tool_use","id":call_id,"name":"Read","input":{"file_path":text}}
        ]}})
    )
}

fn texts(window: &TranscriptWindow) -> Vec<String> {
    window
        .transcript
        .entries
        .iter()
        .map(|entry| entry.text.clone())
        .collect()
}

/// Paging back from the newest page reaches the transcript's start, and the
/// pages join where each stopped: every message and call appears once, and a
/// message is never split from the call its record makes.
#[test]
fn older_pages_join_exactly_where_the_newer_page_stopped() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let mut expected = Vec::new();
    for index in 0..40 {
        if index % 3 == 0 {
            write!(
                file,
                "{}",
                assistant_with_call(&format!("reply {index}"), &format!("call-{index}"))
            )
            .unwrap();
        } else {
            write!(file, "{}", record(&format!("prompt {index}"))).unwrap();
        }
        expected.push(if index % 3 == 0 {
            format!("reply {index}")
        } else {
            format!("prompt {index}")
        });
    }
    let limits = Limits {
        source: 1024 * 1024,
        output: 1024,
        entries: 7,
        ..Limits::PAGE
    };
    let newest = page(file.path(), None, limits);
    assert!(!newest.transcript.history_complete);
    let mut pages = vec![newest];
    while let Some(before) = pages.last().unwrap().older_cursor {
        let older = page(file.path(), Some(before), limits);
        if let Some(next) = older.older_cursor {
            assert!(next < before, "every page moves back");
        }
        pages.push(older);
    }
    let oldest = pages.last().unwrap();
    assert!(oldest.transcript.history_complete, "the start is reached");
    assert_eq!(pages.len(), 6);
    let joined = pages.iter().rev().flat_map(texts).collect::<Vec<_>>();
    assert_eq!(joined, expected);
    let calls = pages
        .iter()
        .rev()
        .flat_map(|window| window.tools.iter().map(|call| call.call_id.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        calls,
        (0..40)
            .filter(|index| index % 3 == 0)
            .map(|index| format!("call-{index}"))
            .collect::<Vec<_>>()
    );
    for window in &pages {
        // A call sits right after the message its own record carries.
        for call in &window.tools {
            let reply = &window.transcript.entries[call.after_entries - 1].text;
            assert_eq!(call.call_id.replace("call-", "reply "), *reply);
        }
    }
}

/// A byte-bounded page starts at a whole record; the next older page ends
/// exactly where it starts, including a record on the exact boundary.
#[test]
fn byte_bounded_pages_meet_on_record_boundaries() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    for index in 0..30 {
        write!(file, "{}", record(&format!("message {index:02} 한글"))).unwrap();
    }
    let line = record("message 00 한글").len() as u64;
    for source in [line * 4, line * 4 + 3] {
        let limits = Limits {
            source,
            output: 1024 * 1024,
            entries: 1000,
            ..Limits::PAGE
        };
        let mut before = None;
        let mut joined = Vec::new();
        loop {
            let window = page(file.path(), before, limits);
            joined.splice(0..0, texts(&window));
            match window.older_cursor {
                Some(cursor) => before = Some(cursor),
                None => break,
            }
        }
        assert_eq!(
            joined,
            (0..30)
                .map(|index| format!("message {index:02} 한글"))
                .collect::<Vec<_>>()
        );
    }
}

/// A record no page can hold is left out, the read says so, and paging still
/// moves past it.
#[test]
fn a_record_larger_than_a_page_is_skipped_and_reported() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        "{}{}{}",
        record("before"),
        record(&"x".repeat(4096)),
        record("after")
    )
    .unwrap();
    let limits = Limits {
        source: 1024 * 1024,
        output: 1024,
        entries: 100,
        ..Limits::PAGE
    };
    let newest = page(file.path(), None, limits);
    assert_eq!(texts(&newest), ["after"]);
    assert!(
        !newest.transcript.history_complete,
        "the left-out record is reported"
    );
    let oldest = page(file.path(), newest.older_cursor, limits);
    assert_eq!(texts(&oldest), ["before"]);
    assert_eq!(oldest.older_cursor, None);
}

#[test]
fn the_whole_small_transcript_has_no_older_cursor_and_a_stale_one_fails() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(file, "{}{}", record("one"), record("two")).unwrap();
    let read = activity_from_file(file.path(), "claude", "test").unwrap();
    assert!(read.transcript.history_complete);
    assert_eq!(read.older_cursor, None);
    assert!(
        serde_json::to_value(&read)
            .unwrap()
            .get("olderCursor")
            .is_none()
    );
    let length = std::fs::metadata(file.path()).unwrap().len();
    assert!(activity_page_from_file(file.path(), "claude", "test", Some(length + 1)).is_err());
    let first = record("one").len() as u64;
    let older = activity_page_from_file(file.path(), "claude", "test", Some(first)).unwrap();
    assert_eq!(older.transcript.entries.len(), 1);
    assert_eq!(older.transcript.entries[0].text, "one");
    assert_eq!(older.older_cursor, None);
}

fn tool_result(call_id: &str, is_error: bool) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":call_id,"is_error":is_error,"content":"output"}
        ]}})
    )
}

fn states(window: &TranscriptWindow) -> Vec<(String, ProviderToolState)> {
    window
        .tools
        .iter()
        .map(|call| (call.call_id.clone(), call.state))
        .collect()
}

/// Pages back from the newest read with `limits` and returns them oldest
/// first.
fn all_pages(path: &Path, limits: Limits) -> Vec<TranscriptWindow> {
    let mut pages = vec![page(path, None, limits)];
    while let Some(before) = pages.last().unwrap().older_cursor {
        pages.push(page(path, Some(before), limits));
    }
    pages.reverse();
    pages
}

/// A page that ends between a call and its result shows how the call ended:
/// the result sits in the newer page, which records no call to give it to.
#[test]
fn an_older_page_settles_a_call_whose_result_the_newer_page_holds() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        "{}{}{}{}{}{}",
        record("prompt"),
        assistant_with_call("reading", "call-read"),
        tool_result("call-read", false),
        assistant_with_call("reading again", "call-failed"),
        tool_result("call-failed", true),
        assistant_with_call("done", "call-open"),
    )
    .unwrap();
    let limits = Limits {
        source: 1024 * 1024,
        output: 1024 * 1024,
        entries: 1,
        ..Limits::PAGE
    };
    let pages = all_pages(file.path(), limits);
    assert_eq!(
        pages.iter().map(texts).collect::<Vec<_>>(),
        [
            vec!["prompt"],
            vec!["reading"],
            vec!["reading again"],
            vec!["done"]
        ],
        "each page ends between a call and its result"
    );
    assert_eq!(
        pages.iter().flat_map(states).collect::<Vec<_>>(),
        [
            ("call-read".to_string(), ProviderToolState::Completed),
            ("call-failed".to_string(), ProviderToolState::Failed),
            // The newest call has no result yet: it is still running.
            ("call-open".to_string(), ProviderToolState::Running),
        ]
    );
}

/// An older page looks past its end for the calls its last turn left open,
/// past a message sent while one ran, but no further than one page's source
/// bound. It takes nothing else from there: those records are the newer
/// page's.
#[test]
fn an_older_page_settles_its_last_turn_from_past_its_end_within_its_bound() {
    let steered = assistant_with_call("steered", "call-steered");
    let sent_while_running = record("sent while it ran");
    let steered_result = tool_result("call-steered", false);
    let slow = assistant_with_call("slow", "call-slow");
    let filler = format!(
        "{}\n",
        serde_json::json!({"type":"progress","data":"x".repeat(2048)})
    );
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        "{steered}{sent_while_running}{steered_result}{slow}{filler}{}{}{}",
        tool_result("call-slow", false),
        assistant_with_call("answer", "call-newest"),
        tool_result("call-newest", false),
    )
    .unwrap();
    let limits = Limits {
        source: 1024,
        output: 1024 * 1024,
        entries: 1,
        ..Limits::PAGE
    };
    let steered_page = page(file.path(), Some(steered.len() as u64), limits);
    assert_eq!(texts(&steered_page), ["steered"]);
    assert_eq!(
        states(&steered_page),
        [("call-steered".to_string(), ProviderToolState::Completed)]
    );
    // The slow call's result lies past a record longer than the bound; with
    // a larger bound the page sees it.
    let slow_end = [&steered, &sent_while_running, &steered_result, &slow]
        .iter()
        .map(|record| record.len() as u64)
        .sum::<u64>();
    let slow_page = page(file.path(), Some(slow_end), limits);
    assert_eq!(texts(&slow_page), ["slow"]);
    assert_eq!(
        states(&slow_page),
        [("call-slow".to_string(), ProviderToolState::Running)]
    );
    let wider = Limits {
        source: 4096,
        ..limits
    };
    assert_eq!(
        states(&page(file.path(), Some(slow_end), wider)),
        [("call-slow".to_string(), ProviderToolState::Completed)]
    );
    // The newest read records its own results and looks no further.
    let newest = page(file.path(), None, wider);
    assert_eq!(texts(&newest), ["answer"]);
    assert_eq!(
        states(&newest),
        [("call-newest".to_string(), ProviderToolState::Completed)]
    );
}

/// An older page read for a client across a backend connection fits one
/// backend response, however long the conversation's messages are, and its
/// pages still join exactly where each stopped.
#[test]
fn backend_pages_fit_one_response_and_join_where_each_stopped() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("-project");
    std::fs::create_dir(&project).unwrap();
    let path = project.join("conversation.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    // Quotes and line breaks grow when the page is encoded as JSON.
    let long = "\"quoted\" line\n".repeat(2048);
    let mut expected = Vec::new();
    for index in 0..120 {
        let message = format!("{index} {long}");
        write!(
            file,
            "{}",
            assistant_with_call(&message, &format!("call-{index}"))
        )
        .unwrap();
        expected.push(message);
    }
    drop(file);
    let codex = root.path().join("no-codex-sessions");
    let mut before = std::fs::metadata(&path).unwrap().len();
    let (mut joined, mut calls, mut pages) = (Vec::new(), Vec::new(), 0);
    loop {
        let page = read_roots_activity_page(root.path(), &codex, "claude", "conversation", before)
            .unwrap();
        let encoded = serde_json::to_vec(&page).unwrap();
        assert!(
            encoded.len() <= 1024 * 1024,
            "a page of {} bytes does not fit one response",
            encoded.len()
        );
        joined.splice(
            0..0,
            page.transcript
                .entries
                .iter()
                .map(|entry| entry.text.clone()),
        );
        calls.splice(0..0, page.tools.iter().map(|call| call.call_id.clone()));
        pages += 1;
        match page.older_cursor {
            Some(cursor) => {
                assert!(cursor < before, "every page moves back");
                before = cursor;
            }
            None => {
                assert!(page.transcript.history_complete, "the start is reached");
                break;
            }
        }
    }
    assert!(pages > 1, "a long conversation takes several backend pages");
    assert_eq!(joined, expected);
    assert_eq!(
        calls,
        (0..120)
            .map(|index| format!("call-{index}"))
            .collect::<Vec<_>>()
    );
}

/// A Codex rollout under a sessions root with one turn per answer, each a
/// prompt and that answer, and the offset of each turn's `task_started` event.
fn codex_rollout_fixture(sessions: &Path, id: &str, answers: &[String]) -> Vec<u64> {
    let day = sessions.join("2026/11/25");
    fs::create_dir_all(&day).unwrap();
    let path = day.join(format!("rollout-2026-11-25T00-00-00-{id}.jsonl"));
    let mut source = format!(
        "{}\n",
        serde_json::json!({"type":"session_meta","payload":{"id":id}})
    );
    let mut starts = Vec::new();
    for (index, answer) in answers.iter().enumerate() {
        let turn = format!("turn-{index}");
        starts.push(source.len() as u64);
        let records = [
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn}}),
            serde_json::json!({"type":"turn_context","payload":{"turn_id":turn}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user",
                "content":[{"type":"input_text","text":format!("prompt {index}")}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant",
                "content":[{"type":"output_text","text":answer}]}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn}}),
        ];
        for record in records {
            source.push_str(&format!("{record}\n"));
        }
    }
    fs::write(path, source).unwrap();
    starts
}

/// A turn starts at the `task_started` event that opens it, though other
/// records name it too, and the page before that cursor ends just before the
/// turn: its records are the newer history's, never shown twice.
#[test]
fn a_codex_turn_starts_at_its_task_started_event_where_the_page_before_it_ends() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    let id = "019f0000-0000-7000-8000-000000000675";
    // Answers longer than one backward read put records across its steps.
    let long = "x".repeat(BACKWARD_READ_BYTES as usize * 5 / 2);
    let answers = [
        "answer 0".to_string(),
        long.clone(),
        long,
        "answer 3".into(),
    ];
    let starts = codex_rollout_fixture(&sessions, id, &answers);

    for (index, start) in starts.iter().enumerate() {
        assert_eq!(
            codex_turn_start_cursor(&sessions, id, &format!("turn-{index}")),
            Ok(Some(*start)),
            "turn {index}"
        );
    }
    let before = codex_turn_start_cursor(&sessions, id, "turn-1")
        .unwrap()
        .unwrap();
    let older = read_roots_activity_page(
        &root.path().join("projects"),
        &sessions,
        "codex",
        id,
        before,
    )
    .unwrap();
    assert_eq!(
        older
            .transcript
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        ["prompt 0", "answer 0"]
    );
    assert_eq!(older.older_cursor, None);
}

#[test]
fn a_codex_turn_the_rollout_does_not_name_has_no_start() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    let id = "019f0000-0000-7000-8000-000000000676";
    codex_rollout_fixture(&sessions, id, &["answer".to_string()]);

    assert_eq!(codex_turn_start_cursor(&sessions, id, "turn-9"), Ok(None));
    assert!(
        codex_turn_start_cursor(&sessions, "019f0000-0000-7000-8000-000000000000", "turn-0")
            .is_err()
    );
    assert!(codex_turn_start_cursor(&sessions, id, "").is_err());
}

/// Claude Code records some user entries itself: what its own view leaves out
/// (`isMeta`), a background task's notification, and the marker where the
/// person interrupted a turn. None of them is the person's message, on the
/// conversation view's read or on an older page, while the tool call an
/// interrupt ended still shows how it ended.
#[test]
fn records_claude_code_writes_on_the_person_side_are_not_their_messages() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let records = [
        serde_json::json!({"type":"user","origin":{"kind":"human"},"promptSource":"typed",
            "message":{"content":"typed prompt"}}),
        serde_json::json!({"type":"user","isMeta":true,
            "message":{"content":"Scheduled check (every 30 minutes): read the inbox"}}),
        serde_json::json!({"type":"user","isMeta":true,
            "message":{"content":[{"type":"text","text":"Base directory for this skill: /skills/x"}]}}),
        serde_json::json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"reading the file"},
            {"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"a"}}
        ]}}),
        serde_json::json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"call-1","is_error":true,
                "content":"The user doesn't want to proceed with this tool use."},
            {"type":"text","text":"[Request interrupted by user for tool use]"}
        ]}}),
        serde_json::json!({"type":"user","message":{"content":[
            {"type":"text","text":"[Request interrupted by user]"}
        ]}}),
        serde_json::json!({"type":"user","promptSource":"system",
            "origin":{"kind":"task-notification","producer":"session-task"},
            "message":{"content":"<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"}}),
        serde_json::json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"the review finished"}
        ],"stop_reason":"end_turn"}}),
        serde_json::json!({"type":"user","origin":{"kind":"human"},
            "message":{"content":"why did it say [Request interrupted by user]?"}}),
    ];
    for record in &records {
        writeln!(file, "{record}").unwrap();
    }
    let expected = [
        (ConversationTurnRole::User, "typed prompt"),
        (ConversationTurnRole::Agent, "reading the file"),
        (ConversationTurnRole::Agent, "the review finished"),
        (
            ConversationTurnRole::User,
            "why did it say [Request interrupted by user]?",
        ),
    ];
    let shown = |entries: &[ProviderTranscriptEntry]| {
        entries
            .iter()
            .map(|entry| (entry.role, entry.text.clone()))
            .collect::<Vec<_>>()
    };
    let expected = expected
        .map(|(role, text)| (role, text.to_string()))
        .to_vec();

    let read = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert_eq!(shown(&read.entries), expected);

    let older = page(file.path(), None, Limits::PAGE);
    assert_eq!(shown(&older.transcript.entries), expected);
    assert_eq!(
        states(&older),
        [("call-1".to_string(), ProviderToolState::Failed)]
    );
}

#[test]
fn input_the_person_ran_in_claude_code_reads_as_the_command_line() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let records = [
        // Both tag orders Claude Code writes, with and without arguments.
        serde_json::json!({"type":"user","message":{"content":
            "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>check the open lanes\nthen report</command-args>"}}),
        serde_json::json!({"type":"user","isMeta":true,"message":{"content":
            "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>"}}),
        serde_json::json!({"type":"user","message":{"content":
            "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>max</command-args>"}}),
        serde_json::json!({"type":"user","message":{"content":
            "<local-command-stdout>Set effort level to max</local-command-stdout>"}}),
        serde_json::json!({"type":"user","message":{"content":
            "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"}}),
        serde_json::json!({"type":"user","message":{"content":[
            {"type":"text","text":"<local-command-stderr>Unknown model</local-command-stderr>"}
        ]}}),
        serde_json::json!({"type":"user","message":{"content":"<bash-input>git status --short</bash-input>"}}),
        serde_json::json!({"type":"user","message":{"content":
            "<bash-stdout> M src/lib.rs</bash-stdout><bash-stderr></bash-stderr>"}}),
        serde_json::json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"lib.rs has changes"}
        ],"stop_reason":"end_turn"}}),
        // The person's own text that only mentions a tag stays as written.
        serde_json::json!({"type":"user","origin":{"kind":"human"},"message":{"content":
            "why is <command-name>/loop</command-name> in the history?"}}),
        serde_json::json!({"type":"user","origin":{"kind":"human"},"message":{"content":
            "<bash-stdout>pasted output</bash-stdout> what does this mean?"}}),
    ];
    for record in &records {
        writeln!(file, "{record}").unwrap();
    }
    let expected = [
        (
            ConversationTurnRole::User,
            "/loop check the open lanes\nthen report",
        ),
        (ConversationTurnRole::User, "/effort max"),
        (ConversationTurnRole::User, "/clear"),
        (ConversationTurnRole::User, "! git status --short"),
        (ConversationTurnRole::Agent, "lib.rs has changes"),
        (
            ConversationTurnRole::User,
            "why is <command-name>/loop</command-name> in the history?",
        ),
        (
            ConversationTurnRole::User,
            "<bash-stdout>pasted output</bash-stdout> what does this mean?",
        ),
    ]
    .map(|(role, text)| (role, text.to_string()))
    .to_vec();
    let shown = |entries: &[ProviderTranscriptEntry]| {
        entries
            .iter()
            .map(|entry| (entry.role, entry.text.clone()))
            .collect::<Vec<_>>()
    };

    let read = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert_eq!(shown(&read.entries), expected);
    let older = page(file.path(), None, Limits::PAGE);
    assert_eq!(shown(&older.transcript.entries), expected);
}
