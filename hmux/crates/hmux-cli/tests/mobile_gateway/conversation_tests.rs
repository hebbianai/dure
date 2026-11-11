//! The phone's Chat for an agent on this server: `conversation_transcript`
//! served by the real gateway binary for a real managed Host, reading the
//! provider transcript from a disposable home.

use super::*;
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, ManagedAgentStateReporter,
    ManagedAttachRequest, ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper,
    ManagedStopRequest, PermissionMode, ProviderConversationIdentitySeed,
};

const SESSION: &str = "conversation-session";
const WORKSPACE: &str = "conversation-workspace";
const CONVERSATION: &str = "0b9c3c8e-7a51-4d4f-9a3e-5f0c2f3b1d01";

struct AgentFixture {
    state: tempfile::TempDir,
    discovery_root: PathBuf,
    descriptor: SessionDescriptor,
}

impl AgentFixture {
    /// A managed Claude Code session whose launch named `CONVERSATION`, with
    /// its transcript in a Dure account profile of a disposable home.
    fn start() -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let home = state.path().join("home");
        std::fs::create_dir_all(home.join(".claude/projects")).unwrap();
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let created = ManagedSessionCreator::new(runtime_executable())
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    "conversation-create",
                    SESSION,
                    WORKSPACE,
                    "claude",
                    PermissionMode::Default,
                    &cwd,
                    vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()],
                    24,
                    80,
                )
                .unwrap()
                .with_conversation_identity(
                    ProviderConversationIdentitySeed::new("claude", CONVERSATION).unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        let fixture = Self {
            state,
            discovery_root,
            descriptor: created.session().descriptor().clone(),
        };
        fixture.write_transcript(&["Fix the build", "Done."]);
        fixture
    }

    fn home(&self) -> PathBuf {
        self.state.path().join("home")
    }

    fn write_transcript(&self, turns: &[&str]) {
        let path = self
            .home()
            .join(".dure/accounts/claude-work/projects/-srv-project")
            .join(format!("{CONVERSATION}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut lines = String::new();
        for (index, text) in turns.iter().enumerate() {
            let record = if index % 2 == 0 {
                serde_json::json!({ "type": "user", "message": { "content": text } })
            } else {
                serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "text", "text": text }], "stop_reason": "end_turn" }
                })
            };
            lines.push_str(&record.to_string());
            lines.push('\n');
        }
        std::fs::write(path, lines).unwrap();
    }

    fn fence(&self) -> SessionFence {
        SessionFence {
            workspace_id: self.descriptor.workspace_id.clone(),
            session_id: self.descriptor.session_id.clone(),
            runner_principal: self.descriptor.runner_principal.clone(),
            runner_instance: self.descriptor.runner_instance.clone(),
            channel_epoch: self.descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: self.descriptor.host_instance_id.clone(),
            terminal_epoch: self.descriptor.terminal_epoch.clone(),
        }
    }

    fn ask_for(
        &self,
        fence: &SessionFence,
        after: Option<&serde_json::Value>,
    ) -> serde_json::Value {
        let mut question = serde_json::json!({ "expected_fence": fence, "limit": 50 });
        if let Some(after) = after {
            question["after"] = after.clone();
        }
        let home = self.home();
        gateway_request_with_environment(
            &self.discovery_root,
            serde_json::json!({
                "gateway_request_version": 12,
                "request": { "conversation_transcript": question },
            }),
            // The provider overrides are blanked so this process's own state
            // root cannot answer for the disposable home.
            &[
                ("HOME", home.as_path()),
                ("CLAUDE_CONFIG_DIR", Path::new("")),
                ("CODEX_HOME", Path::new("")),
            ],
        )
    }

    fn ask(&self, after: Option<&serde_json::Value>) -> serde_json::Value {
        self.ask_for(&self.fence(), after)
    }

    fn report(&self, activity: AgentRuntimeActivity, turn_completed: bool) {
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        ManagedAgentStateReporter::new(runtime_executable(), &cwd)
            .with_discovery_root(&self.discovery_root)
            .report_agent_state(
                ManagedAttachRequest::new(SESSION, WORKSPACE).unwrap(),
                AgentStateReport {
                    progress: None,
                    identity_only: false,
                    activity,
                    attention: AgentRuntimeAttention::None,
                    turn_completed,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: None,
                    background_work: false,
                    startup_gate: None,
                },
            )
            .unwrap();
    }
}

impl Drop for AgentFixture {
    fn drop(&mut self) {
        let cwd = std::env::current_dir().unwrap();
        let fence = self.fence();
        let Ok(request) = ManagedStopRequest::new("conversation-stop", SESSION, WORKSPACE)
            .and_then(|request| {
                request.with_expected_fence(
                    fence.runner_principal,
                    fence.runner_instance,
                    fence.channel_epoch,
                    fence.host_instance_id,
                    fence.terminal_epoch,
                )
            })
        else {
            return;
        };
        let _ = ManagedSessionStopper::new(runtime_executable(), cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(request);
    }
}

fn texts(answer: &serde_json::Value) -> Vec<String> {
    answer["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["text"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_server_session_is_read_by_its_fence_from_an_account_profile() {
    let fixture = AgentFixture::start();
    let answer = fixture.ask(None);
    assert_eq!(answer["hub_conversation_version"], 1, "{answer}");
    assert_eq!(answer["outcome"], "transcript", "{answer}");
    assert_eq!(answer["provider"], "claude");
    assert_eq!(answer["conversation_id"], CONVERSATION);
    assert_eq!(texts(&answer), ["Fix the build", "Done."]);
    assert_eq!(answer["final_response"], "Done.");
    assert_eq!(answer["history_complete"], true);
    assert_eq!(
        answer["cursor"]["terminal_epoch"],
        fixture.descriptor.terminal_epoch
    );
    assert_eq!(answer["cursor"]["conversation_id"], CONVERSATION);

    // The shared native reader decodes the real gateway's bytes.
    let home = fixture.home();
    let encoded = gateway_request_output_with_environment(
        &fixture.discovery_root,
        serde_json::json!({
            "gateway_request_version": 12,
            "request": { "conversation_transcript": { "expected_fence": fixture.fence() } },
        }),
        &[
            ("HOME", home.as_path()),
            ("CLAUDE_CONFIG_DIR", Path::new("")),
            ("CODEX_HOME", Path::new("")),
        ],
    );
    let decoded: serde_json::Value =
        hmux_ssh_transport::conversation_transcript::read(&mut encoded.stdout.as_slice()).unwrap();
    assert_eq!(texts(&decoded), ["Fix the build", "Done."]);
}

#[test]
fn the_same_turns_are_answered_unchanged_until_a_turn_completes() {
    let fixture = AgentFixture::start();
    fixture.report(AgentRuntimeActivity::Waiting, false);
    let first = fixture.ask(None);
    assert_eq!(first["outcome"], "transcript", "{first}");
    let cursor = first["cursor"].clone();

    // The provider file moves mid-turn; the Host's turns do not.
    fixture.write_transcript(&["Fix the build", "Done.", "And the tests"]);
    let unchanged = fixture.ask(Some(&cursor));
    assert_eq!(unchanged["outcome"], "unchanged", "{unchanged}");
    assert!(unchanged["entries"].as_array().unwrap().is_empty());
    assert_eq!(unchanged["cursor"], cursor);

    fixture.write_transcript(&["Fix the build", "Done.", "And the tests", "They pass."]);
    fixture.report(AgentRuntimeActivity::Waiting, true);
    let completed = fixture.ask(Some(&cursor));
    assert_eq!(completed["outcome"], "transcript", "{completed}");
    assert_eq!(
        texts(&completed),
        ["Fix the build", "Done.", "And the tests", "They pass."]
    );
    assert_eq!(
        completed["cursor"]["turn_completed_count"]
            .as_u64()
            .unwrap(),
        cursor["turn_completed_count"].as_u64().unwrap() + 1
    );
}

#[test]
fn a_moved_process_an_unknown_session_and_a_shell_are_refused_by_name() {
    let fixture = AgentFixture::start();
    let mut moved = fixture.fence();
    moved.terminal_epoch = "a-replaced-provider-process".into();
    let answer = fixture.ask_for(&moved, None);
    assert_eq!(answer["outcome"], "refused");
    assert_eq!(answer["code"], "identity_changed", "{answer}");

    let mut missing = fixture.fence();
    missing.session_id = "no-such-session".into();
    let answer = fixture.ask_for(&missing, None);
    assert_eq!(answer["code"], "session_not_found", "{answer}");

    // A shell has no conversation to read.
    let shell = Fixture::start();
    let answer = gateway_request(
        &shell.discovery_root,
        serde_json::json!({
            "gateway_request_version": 12,
            "request": { "conversation_transcript": { "expected_fence": shell.fence() } },
        }),
    );
    assert_eq!(answer["code"], "unsupported_runtime", "{answer}");
}

#[test]
fn a_missing_transcript_is_named_and_a_pinned_gateway_keeps_its_scope() {
    let fixture = AgentFixture::start();
    std::fs::remove_dir_all(fixture.home().join(".dure")).unwrap();
    let answer = fixture.ask(None);
    assert_eq!(answer["code"], "transcript_unavailable", "{answer}");

    let mut child = Command::new(env!("CARGO_BIN_EXE_hmux"))
        .arg("--discovery-root")
        .arg(&fixture.discovery_root)
        .args(["mobile-gateway", "--session", "another-session"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            &hmux_ssh_transport::conversation_transcript::request(
                &hmux_ssh_transport::conversation_transcript::ConversationTranscriptRequest::<
                    serde_json::Value,
                > {
                    expected_fence: fixture.fence(),
                    limit: None,
                    after: None,
                },
            )
            .unwrap(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert_eq!(
        catalog_documents(&output.stdout)[0]["body"]["payload"]["code"],
        "authorization_denied"
    );
}
