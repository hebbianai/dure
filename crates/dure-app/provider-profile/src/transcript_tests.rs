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
