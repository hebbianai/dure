use super::*;

const CONVERSATION: &str = "conversation-history";
const CAPABILITY: &str = "agent_conversation.read_provider_history";
const AFTER_CAPABILITY: &str = "agent_conversation.read_provider_history.after.v1";

fn claude_record(kind: &str, text: &str) -> String {
    format!(
        "{}\n",
        json!({"type": kind, "message": {"role": kind, "content": text}})
    )
}

/// A Claude Chat session under a selected account whose transcript holds two
/// turns before the history its timeline was seeded with.
async fn history_fixture() -> (
    TempDir,
    ServiceState,
    AgentInteractionBindingV1,
    std::path::PathBuf,
) {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let accounts = root.path().join("accounts");
    fs::create_dir_all(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("claude-history-test");
    fs::create_dir(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let profile = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "claude".into(),
                reference_id: "history-test".into(),
                profile_directory_name: "claude-history-test".into(),
            },
        )
        .await
        .unwrap();
    let agent_id = AgentIdV1::new("agent-claude-history").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            display_name: "Claude history".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-claude-history")
            .unwrap(),
        agent_id,
        provider_id: ProviderIdV1::new("claude").unwrap(),
        execution_profile: AgentExecutionProfileV1::CredentialReference {
            reference_id: "history-test".into(),
            credential_generation: Some(profile.credential_generation.clone()),
        },
        provider_conversation_ref: Some(CONVERSATION.into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-claude-history".into(),
            provider_epoch: "provider-claude-history".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-claude-history").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    let project = profile_directory.join("projects").join("-workspace");
    fs::create_dir_all(&project).unwrap();
    let transcript = project.join(format!("{CONVERSATION}.jsonl"));
    fs::write(
        &transcript,
        [
            claude_record("user", "first prompt"),
            claude_record("assistant", "first answer"),
            claude_record("user", "second prompt"),
            claude_record("assistant", "second answer"),
        ]
        .concat(),
    )
    .unwrap();
    (root, state, binding, transcript)
}

fn history_request(state: &ServiceState, body: Value) -> BackendRequest {
    let mut required_capabilities = vec![CAPABILITY.into()];
    if body.get("after").is_some() {
        required_capabilities.push(AFTER_CAPABILITY.into());
    }
    BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: "agent-conversation-history-1".into(),
        operation: CAPABILITY.into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities,
        },
        body,
        connection: None,
    }
}

fn history_body(binding: &AgentInteractionBindingV1, before: u64) -> Value {
    json!({
        "schemaVersion": 1,
        "interactionSessionId": binding.interaction_session_id,
        "providerConversationRef": binding.provider_conversation_ref,
        "before": before,
    })
}

/// The backend that owns a Chat session answers the history older than its
/// seeded window from the session's own account, with the tool-aware shape
/// the desktop's own transcript reads have.
#[tokio::test]
async fn chat_reads_the_history_before_its_seeded_window_from_its_own_account() {
    let (_root, state, binding, _transcript) = history_fixture().await;
    let window_start = (claude_record("user", "first prompt")
        + &claude_record("assistant", "first answer"))
        .len() as u64;

    let response = dispatch(
        &state,
        &history_request(&state, history_body(&binding, window_start)),
    )
    .await
    .unwrap();

    assert_eq!(response["schemaVersion"], 1);
    let activity = &response["activity"];
    assert_eq!(activity["provider"], "claude");
    assert_eq!(activity["conversationId"], CONVERSATION);
    assert_eq!(activity["historyComplete"], true);
    assert_eq!(
        activity["entries"],
        json!([
            { "role": "user", "text": "first prompt" },
            { "role": "agent", "text": "first answer" },
        ])
    );
    assert!(
        activity.get("olderCursor").is_none(),
        "the start is reached"
    );
}

/// A read names the conversation it pages, and a cursor only means something
/// in the transcript it came from: another conversation, an unknown session,
/// a cursor past the transcript's end and an unknown schema are refused.
#[tokio::test]
async fn a_read_outside_the_sessions_own_conversation_is_refused() {
    let (_root, state, binding, transcript) = history_fixture().await;
    let length = fs::metadata(&transcript).unwrap().len();

    let mut other = history_body(&binding, length);
    other["providerConversationRef"] = json!("conversation-other");
    let mut unknown = history_body(&binding, length);
    unknown["interactionSessionId"] = json!("interaction-unknown");
    let mut schema = history_body(&binding, length);
    schema["schemaVersion"] = json!(2);
    for (body, code) in [
        (other, "agent_conversation_conflict"),
        (unknown, "agent_conversation_not_found"),
        (
            history_body(&binding, length + 1),
            "agent_conversation_history_unavailable",
        ),
        (schema, "agent_conversation_request_invalid"),
    ] {
        let error = dispatch(&state, &history_request(&state, body))
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
    }

    fs::remove_file(&transcript).unwrap();
    let error = dispatch(
        &state,
        &history_request(&state, history_body(&binding, length)),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "agent_conversation_history_unavailable");
}

/// A gap in a Chat timeline reads only the history between its ends: the page
/// starts where the rows above it end, and names no older cursor once it gets
/// there. A floor that is not before the page's end is refused.
#[tokio::test]
async fn a_gap_reads_only_the_history_between_the_rows_around_it() {
    let (_root, state, binding, transcript) = history_fixture().await;
    let held_end = claude_record("user", "first prompt").len() as u64;
    let resumed_at = fs::metadata(&transcript).unwrap().len()
        - claude_record("assistant", "second answer").len() as u64;
    let mut body = history_body(&binding, resumed_at);
    body["after"] = json!(held_end);

    let response = dispatch(&state, &history_request(&state, body.clone()))
        .await
        .unwrap();

    let activity = &response["activity"];
    assert_eq!(
        activity["entries"],
        json!([
            { "role": "agent", "text": "first answer" },
            { "role": "user", "text": "second prompt" },
        ])
    );
    assert!(
        activity.get("olderCursor").is_none(),
        "the floor is reached"
    );

    for after in [resumed_at, resumed_at + 1] {
        body["after"] = json!(after);
        let error = dispatch(&state, &history_request(&state, body.clone()))
            .await
            .unwrap_err();
        assert_eq!(error.code, "agent_conversation_request_invalid");
    }
}

/// A Chat runtime of a provider that keeps no transcript file, which answers
/// the history read itself and records what it was asked.
#[derive(Default)]
struct HistoryRuntime {
    reads: StdMutex<Vec<(u64, u64)>>,
}

impl crate::agent_conversation::AgentProviderCommands for HistoryRuntime {
    fn start_turn<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentStartTurnIntentV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        unreachable!("a history read starts no turn")
    }

    fn answer_pending<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentPendingAnswerIntentV1,
        _: &'a dure_app::AgentPendingRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        unreachable!("a history read answers nothing")
    }

    fn interrupt_turn<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentInterruptTurnRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        unreachable!("a history read interrupts nothing")
    }

    fn read_history<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        before: u64,
        after: u64,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.reads.lock().unwrap().push((before, after));
        Box::pin(async {
            Ok(json!({
                "schemaVersion": 1, "provider": "opencode", "conversationId": "ses_history",
                "historyComplete": true, "finalResponse": null,
                "entries": [{"role": "user", "text": "first prompt"}],
            }))
        })
    }
}

/// An OpenCode Chat session's history lives with the OpenCode server its
/// runtime is attached to, not in a transcript file: the backend reads it
/// through that runtime, at the place its boundary names, and only while
/// one is attached.
#[tokio::test]
async fn a_provider_without_a_transcript_file_reads_its_history_through_its_runtime() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    let agent_id = AgentIdV1::new("agent-opencode-history").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("opencode").unwrap(),
            display_name: "OpenCode history".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-opencode-history")
            .unwrap(),
        agent_id,
        provider_id: ProviderIdV1::new("opencode").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("ses_history".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-opencode-history".into(),
            provider_epoch: "provider-opencode-history".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-opencode-history").unwrap(),
        binding_revision: 1,
        history_complete: false,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    let place = 1_795_000_000_000_u64;

    let error = dispatch(
        &state,
        &history_request(&state, history_body(&binding, place)),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.code, "agent_conversation_history_unavailable",
        "no runtime is attached to read it through"
    );

    let runtime = Arc::new(HistoryRuntime::default());
    state
        .agent_conversation_runtimes
        .register(binding.clone(), runtime.clone())
        .unwrap();
    let response = dispatch(
        &state,
        &history_request(&state, history_body(&binding, place)),
    )
    .await
    .unwrap();

    assert_eq!(
        response["activity"]["entries"],
        json!([{"role": "user", "text": "first prompt"}])
    );
    assert_eq!(*runtime.reads.lock().unwrap(), [(place, 0)]);
}
