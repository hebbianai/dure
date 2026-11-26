use super::*;

/// A managed Claude Host whose provider is a shell that runs Dure's published
/// script hook the way Claude does: as its own child, with the Host's fence in
/// its environment. A step the test sends names a hook payload, and whether the
/// provider process itself runs the hook (`pane`) or another process that
/// inherited its environment does (`background`), like a background session
/// copied with `/fork`.
struct ClaudeHookFixture {
    _state: tempfile::TempDir,
    discovery_root: std::path::PathBuf,
    cwd: std::path::PathBuf,
    payloads: std::path::PathBuf,
    transcripts: std::path::PathBuf,
    steps: std::path::PathBuf,
    created: hmux_client::CreatedManagedSession,
}

impl ClaudeHookFixture {
    fn new() -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let payloads = state.path().join("payloads");
        let transcripts = state.path().join("transcripts");
        let steps = state.path().join("steps");
        let ready = state.path().join("ready");
        fs::create_dir(&payloads).unwrap();
        fs::create_dir(&transcripts).unwrap();
        let hook = state.path().join("managed-claude-hook.py");
        let source = fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../src-tauri/resources/managed-claude-hook.py"),
        )
        .unwrap();
        let runtime = serde_json::to_string(env!("CARGO_BIN_EXE_hmux-runtime")).unwrap();
        let source = source.replacen("\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"", &runtime, 1);
        assert!(!source.contains("__DURE_HMUX_RUNTIME_EXECUTABLE__"));
        fs::write(&hook, source).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    "claude-conversation-announcement-create",
                    "claude-conversation-announcement",
                    "workspace-claude-conversation-announcement",
                    "claude",
                    PermissionMode::Default,
                    &cwd,
                    vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        // One long-lived background shell runs every
                        // `background` hook, as one background session's
                        // Claude process would.
                        r#"stty -echo
hook=$1 payloads=$5 steps=$6
export HMUX_DISCOVERY_ROOT="$2" DURE_HOME="$3"
run() { "$hook" claude --managed-direct --terminal-events < "$payloads/$1.json"; printf '%s\n' "$1" >> "$steps"; }
mkfifo "$7"
(while IFS= read -r payload; do run "$payload"; done < "$7") &
exec 3> "$7"
printf ready > "$4"
while IFS=' ' read -r process payload; do
  case "$process" in
    pane) run "$payload" ;;
    background) printf '%s\n' "$payload" >&3 ;;
  esac
done"#
                            .into(),
                        "claude-hook-provider".into(),
                        hook.to_string_lossy().into_owned(),
                        discovery_root.to_string_lossy().into_owned(),
                        state.path().join("dure-home").to_string_lossy().into_owned(),
                        ready.to_string_lossy().into_owned(),
                        payloads.to_string_lossy().into_owned(),
                        steps.to_string_lossy().into_owned(),
                        state
                            .path()
                            .join("background")
                            .to_string_lossy()
                            .into_owned(),
                    ],
                    24,
                    80,
                )
                .unwrap()
                .with_conversation_identity(
                    ProviderConversationIdentitySeed::new("claude", "conversation-first").unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        wait_for_file_content(&ready, b"ready");
        Self {
            _state: state,
            discovery_root,
            cwd,
            payloads,
            transcripts,
            steps,
            created,
        }
    }

    fn transcript(&self, conversation_id: &str) -> std::path::PathBuf {
        self.transcripts.join(format!("{conversation_id}.jsonl"))
    }

    /// Claude writes a conversation's transcript once a prompt lands in it.
    fn write_transcript(&self, conversation_id: &str) {
        fs::write(self.transcript(conversation_id), "{\"type\":\"user\"}\n").unwrap();
    }

    /// Run one hook event in the provider's terminal and wait until it ran.
    fn run(&self, process: &str, name: &str, mut native: serde_json::Value) {
        let conversation_id = native["session_id"].as_str().unwrap().to_string();
        native["transcript_path"] = self
            .transcript(&conversation_id)
            .to_string_lossy()
            .into_owned()
            .into();
        fs::write(
            self.payloads.join(format!("{name}.json")),
            native.to_string(),
        )
        .unwrap();
        let ran_before = fs::read_to_string(&self.steps).unwrap_or_default();
        let descriptor = self.created.session().descriptor();
        let mut controller =
            ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &self.cwd)
                .with_discovery_root(&self.discovery_root)
                .attach(
                    ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                        .unwrap(),
                )
                .unwrap();
        let input_id = controller
            .mutation_handle()
            .send_input(format!("{process} {name}\n").into_bytes())
            .unwrap();
        loop {
            match controller.read_event().unwrap() {
                Some(ControllerEvent::InputReceipt(receipt)) if receipt.request_id == input_id => {
                    assert_eq!(receipt.state, ControllerReceiptState::WrittenToPty);
                    break;
                }
                Some(_) => {}
                None => panic!("controller detached before the input receipt"),
            }
        }
        controller.detach().unwrap();
        wait_for_file_content(&self.steps, format!("{ran_before}{name}\n").as_bytes());
    }

    /// The conversation the Host says its provider runs.
    fn conversation(&self) -> String {
        let descriptor = self.created.session().descriptor();
        let observer = LocalSessionObserver::connect(
            &LocalSessionCatalog::new(&self.discovery_root),
            &SessionSelector::new(
                &descriptor.session_id,
                Some(descriptor.workspace_id.clone()),
            ),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let conversation_id = observer
            .attachment()
            .initial_snapshot
            .provider_conversation_identity
            .as_ref()
            .map(|identity| identity.conversation_id.clone());
        observer.detach().unwrap();
        conversation_id.unwrap()
    }
}

fn session_start(source: &str, conversation_id: &str) -> serde_json::Value {
    serde_json::json!({
        "hook_event_name": "SessionStart",
        "source": source,
        "session_id": conversation_id,
    })
}

/// A prompt landing in the conversation, and the turn it starts ending.
fn turn(fixture: &ClaudeHookFixture, process: &str, conversation_id: &str, turn: &str) {
    let prompt_id = format!("prompt-{turn}");
    fixture.run(
        process,
        &format!("{turn}-prompt"),
        serde_json::json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": conversation_id,
            "prompt_id": prompt_id,
            "prompt": "continue",
        }),
    );
    fixture.run(
        process,
        &format!("{turn}-stop"),
        serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": conversation_id,
            "prompt_id": prompt_id,
            "background_tasks": [],
            "session_crons": [],
        }),
    );
}

/// Remote Claude reports through the script hook and this broker, never
/// through the desktop. `/clear`, `/resume` and `/branch` move the provider's
/// own process to another conversation and write no forward link, so the
/// Host follows the move only because that process announced it. A
/// background copy with the pane's fence and hook settings moves nothing.
#[test]
fn the_providers_own_process_moves_the_host_to_the_conversation_it_announced() {
    let fixture = ClaudeHookFixture::new();
    fixture.write_transcript("conversation-first");
    fixture.run(
        "pane",
        "startup",
        session_start("startup", "conversation-first"),
    );
    turn(&fixture, "pane", "conversation-first", "first");
    assert_eq!(fixture.conversation(), "conversation-first");

    // `/clear`: the new conversation has no transcript until its first
    // prompt, so its SessionStart carries no identity yet.
    fixture.run(
        "pane",
        "clear",
        session_start("clear", "conversation-cleared"),
    );
    assert_eq!(fixture.conversation(), "conversation-first");
    fixture.write_transcript("conversation-cleared");
    turn(&fixture, "pane", "conversation-cleared", "cleared");
    assert_eq!(fixture.conversation(), "conversation-cleared");

    // `/fork`'s background copy announces its own conversation from another
    // process. The Host keeps the pane's.
    fixture.write_transcript("conversation-copy");
    fixture.run(
        "background",
        "copy",
        session_start("fork", "conversation-copy"),
    );
    turn(&fixture, "background", "conversation-copy", "copy");
    assert_eq!(fixture.conversation(), "conversation-cleared");

    // `/resume <first>` and `/branch` name a conversation whose transcript
    // exists. The Host folds no idle report after ordered work, so the move
    // lands with the next prompt, which still carries the announcement.
    fixture.run(
        "pane",
        "resume",
        session_start("resume", "conversation-first"),
    );
    assert_eq!(fixture.conversation(), "conversation-cleared");
    turn(&fixture, "pane", "conversation-first", "resumed");
    assert_eq!(fixture.conversation(), "conversation-first");
    fixture.write_transcript("conversation-branch");
    fixture.run(
        "pane",
        "branch",
        session_start("fork", "conversation-branch"),
    );
    turn(&fixture, "pane", "conversation-branch", "branch");
    assert_eq!(fixture.conversation(), "conversation-branch");
}
