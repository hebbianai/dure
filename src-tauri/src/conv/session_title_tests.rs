use super::*;
use std::io::Write;

fn user(cwd: &Path, text: &str) -> Value {
    serde_json::json!({
        "type": "user", "uuid": "first-user", "cwd": cwd,
        "message": { "content": text }
    })
}

#[test]
fn recent_codex_app_conversations_keep_their_identity_title_and_preview_after_history_fills() {
    let temporary = tempfile::tempdir().unwrap();
    let cwd = temporary.path().join("workspace");
    let provider_root = temporary.path().join("codex");
    let sessions = provider_root.join("sessions");
    fs::create_dir_all(&cwd).unwrap();
    let write = |relative: &str, id: &str, updated: u64, subagent: bool| {
        let path = sessions.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let records = [
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id, "cwd": cwd, "originator": "codex-tui", "source": "vscode",
                    "thread_source": if subagent { "subagent" } else { "user" }
                }
            }),
            serde_json::json!({
                "type": "response_item", "payload": {
                    "type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": "Continue from the Codex app"}]
                }
            }),
        ];
        fs::write(&path, records.map(|value| value.to_string()).join("\n")).unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(updated))
            .unwrap();
    };
    for index in 0..300 {
        write(
            &format!("2026/07/01/old-{index:03}.jsonl"),
            &format!("old-{index}"),
            100,
            false,
        );
    }
    write("2026/09/15/app.jsonl", "app-conversation", 300, false);
    write(
        "2026/04/01/resumed.jsonl",
        "resumed-conversation",
        400,
        false,
    );
    write("2026/09/15/subagent.jsonl", "app-subagent", 500, true);
    fs::write(
        provider_root.join("session_index.jsonl"),
        serde_json::json!({"id": "app-conversation", "thread_name": "My Codex app work"})
            .to_string(),
    )
    .unwrap();

    let mut candidates = Vec::new();
    collect_codex(&sessions, &mut candidates);
    let records = finalize(candidates);
    assert_eq!(records[0].id, "resumed-conversation");
    let app = records
        .iter()
        .find(|record| record.id == "app-conversation")
        .unwrap();
    assert_eq!(app.title, "My Codex app work");
    assert_eq!(app.provider, "codex");
    assert_eq!(app.cwd, cwd.to_str().unwrap());
    assert!(app.working_directory_available);
    assert_eq!(
        serde_json::to_value(app).unwrap()["resumeCapability"],
        "exact"
    );
    assert_eq!(
        app.recent_turns.last().unwrap().text,
        "Continue from the Codex app"
    );
    assert!(!records.iter().any(|record| record.id == "app-subagent"));
}

#[test]
fn claude_saved_session_names_survive_later_prompts_and_rescans() {
    let temporary = tempfile::tempdir().unwrap();
    let cwd = temporary.path().join("workspace");
    let root = temporary.path().join("claude");
    let projects = root.join("projects");
    let project = projects.join(super::super::encode_cwd(&cwd.to_string_lossy()));
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&project).unwrap();
    let path = project.join("named-session.jsonl");
    let prefix = [
        user(&cwd, "Initial prompt"),
        serde_json::json!({"type": "custom-title", "customTitle": "Saved session name", "sessionId": "named-session"}),
    ].map(|value| value.to_string()).join("\n");
    // The name exists only in the prefix; newer conversation text is in the suffix.
    fs::write(
        &path,
        format!(
            "{prefix}\n{}\n{}\n",
            " ".repeat(MAX_SESSION_BYTES as usize + 1),
            user(&cwd, "Please continue")
        ),
    )
    .unwrap();
    let discover = || {
        let mut candidates = Vec::new();
        collect_claude(&projects, &mut candidates);
        assert_eq!(candidates.len(), 1);
        let candidate = candidates.pop().unwrap();
        assert_eq!(candidate.record.id, "named-session");
        assert_eq!(candidate.logical_identity, "first-user");
        candidate.record.title
    };
    assert_eq!(discover(), "Saved session name");
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "{}", serde_json::json!({"type": "custom-title", "customTitle": "Renamed session", "sessionId": "named-session"})).unwrap();
    writeln!(file, "{}", user(&cwd, "Another follow-up")).unwrap();
    assert_eq!(discover(), "Renamed session");
    let picker = super::super::list_claude_from_root(&cwd.to_string_lossy(), &root);
    assert_eq!(picker[0].title, "Renamed session");
}

#[test]
fn claude_generated_session_name_is_used_until_the_user_names_it() {
    let temporary = tempfile::tempdir().unwrap();
    let cwd = temporary.path().join("workspace");
    let projects = temporary.path().join("projects");
    let project = projects.join("workspace");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&project).unwrap();
    let path = project.join("generated-session.jsonl");
    let lines = [
        user(&cwd, "Initial prompt"),
        serde_json::json!({"type": "ai-title", "aiTitle": "Generated session name", "sessionId": "generated-session"}),
        user(&cwd, "Please continue"),
    ].map(|value| value.to_string()).join("\n");
    fs::write(&path, format!("{lines}\n")).unwrap();
    let discover = || {
        let mut candidates = Vec::new();
        collect_claude(&projects, &mut candidates);
        candidates.pop().unwrap().record.title
    };
    assert_eq!(discover(), "Generated session name");
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "{}", serde_json::json!({"type": "custom-title", "customTitle": "My session name", "sessionId": "generated-session"})).unwrap();
    writeln!(file, "{}", serde_json::json!({"type": "ai-title", "aiTitle": "Later generated title", "sessionId": "generated-session"})).unwrap();
    assert_eq!(discover(), "My session name");
}
