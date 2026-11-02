//! A phone reads one local agent's conversation and types a prompt into it.
//!
//! # Who decides what
//!
//! - **The transcript** is read by the reader the desktop's own response view
//!   and the CLI server's `/transcript` use (`conv::transcript_global`), for
//!   the conversation the Hmux Host observed on the session. The phone names a
//!   session, never a provider file or conversation to read.
//! - **The prompt** is admitted by the Hmux Host, through the same
//!   agent-prompt input the control plane's `agent_runtime.native.input`
//!   sends: the Host writes only when it observes the agent idle, with no
//!   attention raised, on the expected conversation, and writes the text and
//!   its submit as one record.
//! - **This module** routes the request to this desktop's sessions, refuses
//!   what it can prove before touching the Host (another box, another process,
//!   another conversation, no conversation yet), and names a Host refusal from
//!   the runtime state captured in the same attach. It never re-decides what
//!   the Host admits.
//!
//! Sessions on remote hosts are refused `remote_unsupported` for now: their
//! transcript lives on the remote machine.

use dure_hub_protocol::conversation::{
    ConversationCursor, ConversationEntry, ConversationRefusal, ConversationRole,
    HubAgentPromptResult, HubConversationTranscriptResult, TranscriptParts,
};
use dure_provider_profile::transcript::{ConversationTurnRole, ProviderConversationTranscript};
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
    AgentRuntimeStateDescriptor, ClientError, ProviderConversationIdentityDescriptor,
    ProviderConversationIdentitySeed, ProviderConversationIdentitySource, SessionClass,
    SessionDescriptor, SessionFence, SessionHealth, SessionSelector, TerminalSurfaceAttachment,
};
use std::time::Duration;

/// How long the Host has to admit and confirm one prompt. The phone's
/// connection waits longer than this (`server::CONNECTION_TIMEOUT`).
const PROMPT_TIMEOUT: Duration = Duration::from_secs(10);

/// The providers whose transcript the desktop reads and whose native agent
/// takes an existing-conversation prompt.
const CONVERSATION_PROVIDERS: [&str; 2] = ["claude", "codex"];

/// Whether this desktop answers conversation requests for a local session: a
/// managed native Claude Code or Codex agent. Shells and standalone sessions
/// have no Host-observed conversation and take no agent prompt.
#[must_use]
pub fn serves_conversation(session_class: &SessionClass, provider_id: &str) -> bool {
    *session_class == SessionClass::Managed && CONVERSATION_PROVIDERS.contains(&provider_id)
}

/// Where the request's box is, from this hub's point of view.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoxRoute {
    /// The box this desktop's own Hmux sessions belong to.
    Local,
    /// A remote host this desktop reaches over SSH.
    Remote,
    /// No box this hub knows.
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptRequest {
    pub session_id: String,
    pub limit: Option<u32>,
    pub after: Option<ConversationCursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptRequest {
    pub session_id: String,
    pub text: String,
    pub expected_terminal_epoch: String,
    pub expected_conversation_id: Option<String>,
}

/// The side that reads and writes this desktop's agent sessions.
pub trait ConversationSink: Send + Sync {
    fn transcript(&self, request: TranscriptRequest) -> HubConversationTranscriptResult;
    fn prompt(&self, request: PromptRequest) -> HubAgentPromptResult;
}

/// Read one session's conversation, if it is this desktop's to read.
pub fn answer_transcript(
    sink: Option<&dyn ConversationSink>,
    route: BoxRoute,
    request: TranscriptRequest,
) -> HubConversationTranscriptResult {
    if let Err((code, detail)) = admit(route, sink.is_some(), &request.session_id) {
        return HubConversationTranscriptResult::refused(code, detail);
    }
    match sink {
        Some(sink) => sink.transcript(request),
        None => HubConversationTranscriptResult::refused(ConversationRefusal::Unavailable, UNAVAILABLE),
    }
}

/// Type one prompt into a session's agent, if it is this desktop's to write.
pub fn answer_prompt(
    sink: Option<&dyn ConversationSink>,
    route: BoxRoute,
    request: PromptRequest,
) -> HubAgentPromptResult {
    if let Err((code, detail)) = admit(route, sink.is_some(), &request.session_id) {
        return HubAgentPromptResult::refused(code, detail);
    }
    if request.text.trim().is_empty() || request.text.contains('\0') {
        return HubAgentPromptResult::refused(
            ConversationRefusal::InvalidRequest,
            "The prompt is empty or contains a NUL character",
        );
    }
    if !bounded_identifier(&request.expected_terminal_epoch)
        || request
            .expected_conversation_id
            .as_deref()
            .is_some_and(|id| !bounded_identifier(id))
    {
        return HubAgentPromptResult::refused(
            ConversationRefusal::InvalidRequest,
            "The prompt does not name a valid process or conversation",
        );
    }
    match sink {
        Some(sink) => sink.prompt(request),
        None => HubAgentPromptResult::refused(ConversationRefusal::Unavailable, UNAVAILABLE),
    }
}

const UNAVAILABLE: &str = "This desktop cannot serve agent conversations";

fn admit(
    route: BoxRoute,
    has_sink: bool,
    session_id: &str,
) -> Result<(), (ConversationRefusal, &'static str)> {
    match route {
        BoxRoute::Remote => Err((
            ConversationRefusal::RemoteUnsupported,
            "Conversations of sessions on remote hosts are not served yet. Open the terminal",
        )),
        BoxRoute::Unknown => Err((
            ConversationRefusal::SessionNotFound,
            "This desktop serves no such session",
        )),
        BoxRoute::Local if !has_sink => Err((ConversationRefusal::Unavailable, UNAVAILABLE)),
        BoxRoute::Local if !bounded_identifier(session_id) => Err((
            ConversationRefusal::InvalidRequest,
            "The session id is not valid",
        )),
        BoxRoute::Local => Ok(()),
    }
}

/// The identifier shape Hmux accepts (`hmux::validate_identifier`).
fn bounded_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// The Host-owned facts one answer is decided on, captured in one attach.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedAgent {
    pub terminal_epoch: String,
    pub conversation: Option<ObservedConversation>,
    pub runtime: Option<ObservedRuntime>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedConversation {
    pub provider_id: String,
    pub conversation_id: String,
    /// The provider itself reported it, rather than the launch request
    /// naming it. Only such an identity admits an existing-conversation
    /// prompt.
    pub reported_by_provider: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObservedRuntime {
    pub revision: u64,
    pub turn_completed_count: u64,
    pub waiting: bool,
    pub attention: bool,
}

impl ObservedAgent {
    /// Keep only what the Host reported for this process: a projection from
    /// another terminal epoch describes a provider that is gone.
    #[must_use]
    pub fn from_host(
        terminal_epoch: &str,
        identity: Option<&ProviderConversationIdentityDescriptor>,
        runtime: Option<&AgentRuntimeStateDescriptor>,
    ) -> Self {
        let conversation = identity
            .filter(|identity| identity.terminal_epoch == terminal_epoch)
            .map(|identity| ObservedConversation {
                provider_id: identity.provider_id.clone(),
                conversation_id: identity.conversation_id.clone(),
                reported_by_provider: identity.source
                    == ProviderConversationIdentitySource::ProviderEvent,
            });
        let runtime = runtime
            .filter(|runtime| runtime.terminal_epoch == terminal_epoch)
            .and_then(|runtime| {
                Some(ObservedRuntime {
                    revision: runtime.revision.parse().ok()?,
                    turn_completed_count: runtime.turn_completed_count.parse().ok()?,
                    waiting: runtime.lifecycle == AgentRuntimeLifecycle::Running
                        && (runtime.activity == AgentRuntimeActivity::Waiting
                            || runtime.background_work),
                    attention: runtime.attention != AgentRuntimeAttention::None
                        || runtime.attention_id.is_some(),
                })
            });
        Self {
            terminal_epoch: terminal_epoch.to_string(),
            conversation,
            runtime,
        }
    }

    fn cursor(&self, conversation: &ObservedConversation) -> ConversationCursor {
        ConversationCursor {
            terminal_epoch: self.terminal_epoch.clone(),
            conversation_id: conversation.conversation_id.clone(),
            turn_completed_count: self.runtime.map_or(0, |runtime| runtime.turn_completed_count),
            runtime_revision: self.runtime.map_or(0, |runtime| runtime.revision),
        }
    }
}

/// Answer a transcript request from what the Host observed. `read` is the
/// provider transcript reader; it is not called when nothing moved.
pub fn transcript_answer(
    observed: &ObservedAgent,
    request: &TranscriptRequest,
    read: impl FnOnce(&str, &str) -> Result<ProviderConversationTranscript, String>,
) -> HubConversationTranscriptResult {
    let Some(conversation) = &observed.conversation else {
        return HubConversationTranscriptResult::refused(
            ConversationRefusal::ConversationUnknown,
            "The agent has not reported its conversation yet",
        );
    };
    let cursor = observed.cursor(conversation);
    // Without the Host's runtime state the cursor cannot see a turn move, so
    // it never vouches for "unchanged".
    if observed.runtime.is_some() && request.after.as_ref() == Some(&cursor) {
        return HubConversationTranscriptResult::unchanged(
            conversation.provider_id.clone(),
            conversation.conversation_id.clone(),
            cursor,
        );
    }
    match read(&conversation.provider_id, &conversation.conversation_id) {
        Ok(transcript) => HubConversationTranscriptResult::transcript(
            TranscriptParts {
                provider: conversation.provider_id.clone(),
                conversation_id: conversation.conversation_id.clone(),
                entries: transcript
                    .entries
                    .into_iter()
                    .map(|entry| ConversationEntry {
                        role: match entry.role {
                            ConversationTurnRole::User => ConversationRole::User,
                            ConversationTurnRole::Agent => ConversationRole::Agent,
                        },
                        text: entry.text,
                        truncated: false,
                    })
                    .collect(),
                final_response: transcript.final_response,
                history_complete: transcript.history_complete,
                cursor,
            },
            request.limit,
        ),
        Err(detail) => HubConversationTranscriptResult::refused(
            ConversationRefusal::TranscriptUnavailable,
            format!("Could not read the provider transcript: {detail}"),
        ),
    }
}

/// The conversation to prompt, once everything provable before the Host
/// admits is ruled out. Nothing has been written when this refuses.
pub fn prompt_target(
    observed: &ObservedAgent,
    expected_terminal_epoch: &str,
    expected_conversation_id: Option<&str>,
) -> Result<ProviderConversationIdentitySeed, HubAgentPromptResult> {
    if observed.terminal_epoch != expected_terminal_epoch {
        return Err(identity_changed());
    }
    let Some(conversation) = observed
        .conversation
        .as_ref()
        .filter(|conversation| conversation.reported_by_provider)
    else {
        return Err(HubAgentPromptResult::refused(
            ConversationRefusal::ConversationUnknown,
            "The agent has not reported its conversation yet",
        ));
    };
    if expected_conversation_id.is_some_and(|expected| expected != conversation.conversation_id) {
        return Err(identity_changed());
    }
    ProviderConversationIdentitySeed::new(
        conversation.provider_id.as_str(),
        conversation.conversation_id.as_str(),
    )
    .map_err(|_| {
        HubAgentPromptResult::refused(
            ConversationRefusal::ConversationUnknown,
            "The agent reported a conversation that cannot be addressed",
        )
    })
}

fn identity_changed() -> HubAgentPromptResult {
    HubAgentPromptResult::refused(
        ConversationRefusal::IdentityChanged,
        "The agent's process or conversation changed. Read the conversation again",
    )
}

/// Name the Host's answer to a prompt it did not confirm.
#[must_use]
pub fn prompt_failure(
    code: &str,
    delivery_state: &str,
    observed: &ObservedAgent,
) -> HubAgentPromptResult {
    if delivery_state != "not_written" {
        return HubAgentPromptResult::unknown(format!(
            "The prompt may have reached the agent ({code}). Read the conversation before sending it again"
        ));
    }
    match code {
        // One Host reason covers every idle-admission refusal; the state
        // captured in the same attach says which one it was.
        "hmux_agent_prompt_runtime_changed" => match observed.runtime {
            Some(runtime) if runtime.attention => HubAgentPromptResult::refused(
                ConversationRefusal::AttentionPending,
                "The agent is waiting for an answer in the terminal",
            ),
            _ => HubAgentPromptResult::refused(
                ConversationRefusal::NotIdle,
                "The agent is not waiting for input",
            ),
        },
        "hmux_input_draft_pending" => HubAgentPromptResult::refused(
            ConversationRefusal::InputDraftPending,
            "Someone has typed into the terminal without submitting",
        ),
        "hmux_capability_missing" | "hmux_capability_unsupported" => {
            HubAgentPromptResult::refused(
                ConversationRefusal::UnsupportedRuntime,
                "This session's Host cannot take an agent prompt",
            )
        }
        _ => HubAgentPromptResult::refused(
            ConversationRefusal::Unavailable,
            format!("The session did not take the prompt ({code})"),
        ),
    }
}

/// Name a failure to attach for a prompt. Nothing was written.
fn attach_refusal(error: &ClientError) -> HubAgentPromptResult {
    match error.code() {
        "hmux_expected_generation_mismatch" | "hmux_identity_mismatch" => identity_changed(),
        "hmux_agent_prompt_requires_managed" => HubAgentPromptResult::refused(
            ConversationRefusal::UnsupportedRuntime,
            "This session takes no agent prompt",
        ),
        _ if error.is_session_absent() => HubAgentPromptResult::refused(
            ConversationRefusal::SessionNotFound,
            "This desktop serves no such session",
        ),
        code => HubAgentPromptResult::refused(
            ConversationRefusal::Unavailable,
            format!("Could not reach the session ({code})"),
        ),
    }
}

/// This desktop's own Hmux sessions.
pub struct LocalConversations;

impl LocalConversations {
    fn session(
        session_id: &str,
    ) -> Result<(hmux_client::LocalSessionCatalog, SessionDescriptor), (ConversationRefusal, String)>
    {
        let catalog = crate::hmux::product_catalog().map_err(|error| {
            (
                ConversationRefusal::Unavailable,
                format!("Could not open the session list ({})", error.code()),
            )
        })?;
        let descriptor = catalog
            .find(&SessionSelector::new(session_id, None))
            .map_err(|error| {
                if error.is_session_absent() || error.code() == "hmux_session_ambiguous" {
                    (
                        ConversationRefusal::SessionNotFound,
                        "This desktop serves no such session".to_string(),
                    )
                } else {
                    (
                        ConversationRefusal::Unavailable,
                        format!("Could not find the session ({})", error.code()),
                    )
                }
            })?;
        if !serves_conversation(&descriptor.session_class, &descriptor.provider_id) {
            return Err((
                ConversationRefusal::UnsupportedRuntime,
                "This session is not a Claude Code or Codex agent".to_string(),
            ));
        }
        Ok((catalog, descriptor))
    }
}

impl ConversationSink for LocalConversations {
    fn transcript(&self, request: TranscriptRequest) -> HubConversationTranscriptResult {
        let (catalog, descriptor) = match Self::session(&request.session_id) {
            Ok(found) => found,
            Err((code, detail)) => return HubConversationTranscriptResult::refused(code, detail),
        };
        let inspection = hmux_client::inspect_local_session(&catalog, descriptor);
        if inspection.health != SessionHealth::Healthy {
            return HubConversationTranscriptResult::refused(
                ConversationRefusal::Unavailable,
                "The session is not running",
            );
        }
        let observed = ObservedAgent::from_host(
            &inspection.descriptor.terminal_epoch,
            inspection.provider_conversation_identity.as_deref(),
            inspection.agent_runtime_state.as_ref(),
        );
        transcript_answer(&observed, &request, crate::conv::transcript_global)
    }

    fn prompt(&self, request: PromptRequest) -> HubAgentPromptResult {
        let (catalog, descriptor) = match Self::session(&request.session_id) {
            Ok(found) => found,
            Err((code, detail)) => return HubAgentPromptResult::refused(code, detail),
        };
        // The person's view of the process is the fence: the rest of it comes
        // from the catalog, and the attach refuses a Host that moved since.
        if descriptor.terminal_epoch != request.expected_terminal_epoch {
            return identity_changed();
        }
        let Ok(channel_epoch) = descriptor.channel_epoch.parse() else {
            return HubAgentPromptResult::refused(
                ConversationRefusal::Unavailable,
                "The session reported an unreadable generation",
            );
        };
        let fence = SessionFence {
            workspace_id: descriptor.workspace_id,
            session_id: descriptor.session_id,
            runner_principal: descriptor.runner_principal,
            runner_instance: descriptor.runner_instance,
            channel_epoch,
            host_instance_id: descriptor.host_instance_id,
            terminal_epoch: request.expected_terminal_epoch.clone(),
        };
        let mut surface = match TerminalSurfaceAttachment::connect_local_agent_prompt(&catalog, &fence)
        {
            Ok(surface) => surface,
            Err(error) => return attach_refusal(&error),
        };
        let observed = ObservedAgent::from_host(
            &fence.terminal_epoch,
            surface.initial_provider_conversation_identity(),
            surface.initial_agent_runtime_state(),
        );
        let result = match prompt_target(
            &observed,
            &request.expected_terminal_epoch,
            request.expected_conversation_id.as_deref(),
        ) {
            Err(refusal) => refusal,
            Ok(expected) => match surface.send_existing_idle_agent_prompt_confirmed(
                request.text,
                &expected,
                PROMPT_TIMEOUT,
            ) {
                Ok(receipt) => HubAgentPromptResult::written(
                    receipt.terminal_epoch(),
                    receipt.input().in_reply_to_record_id.to_string(),
                ),
                Err(error) => prompt_failure(error.code(), error.delivery_state(), &observed),
            },
        };
        let _ = surface.detach();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::conversation::{AgentPromptState, TranscriptOutcome};
    use dure_provider_profile::transcript::ProviderTranscriptEntry;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        transcripts: Mutex<Vec<TranscriptRequest>>,
        prompts: Mutex<Vec<PromptRequest>>,
    }

    impl ConversationSink for Recorder {
        fn transcript(&self, request: TranscriptRequest) -> HubConversationTranscriptResult {
            self.transcripts.lock().unwrap().push(request);
            HubConversationTranscriptResult::refused(ConversationRefusal::ConversationUnknown, "recorded")
        }

        fn prompt(&self, request: PromptRequest) -> HubAgentPromptResult {
            self.prompts.lock().unwrap().push(request);
            HubAgentPromptResult::written("terminal-1", "7")
        }
    }

    fn read_request() -> TranscriptRequest {
        TranscriptRequest {
            session_id: "session-1".into(),
            limit: None,
            after: None,
        }
    }

    fn prompt_request() -> PromptRequest {
        PromptRequest {
            session_id: "session-1".into(),
            text: "Run the tests".into(),
            expected_terminal_epoch: "terminal-1".into(),
            expected_conversation_id: None,
        }
    }

    fn identity(
        terminal_epoch: &str,
        source: ProviderConversationIdentitySource,
    ) -> ProviderConversationIdentityDescriptor {
        ProviderConversationIdentityDescriptor {
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            runner_principal: "local-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: terminal_epoch.into(),
            revision: "1".into(),
            observed_through_output_seq: "10".into(),
            provider_id: "claude".into(),
            conversation_id: "conversation-1".into(),
            source,
        }
    }

    fn runtime(
        terminal_epoch: &str,
        activity: AgentRuntimeActivity,
        attention: AgentRuntimeAttention,
    ) -> AgentRuntimeStateDescriptor {
        AgentRuntimeStateDescriptor {
            progress: None,
            terminal_epoch: terminal_epoch.into(),
            revision: "12".into(),
            observed_through_output_seq: "10".into(),
            lifecycle: AgentRuntimeLifecycle::Running,
            activity,
            attention,
            attention_id: None,
            source: hmux_client::AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: "3".into(),
            program_status: None,
            background_work: false,
        }
    }

    fn idle_agent() -> ObservedAgent {
        ObservedAgent::from_host(
            "terminal-1",
            Some(&identity("terminal-1", ProviderConversationIdentitySource::ProviderEvent)),
            Some(&runtime(
                "terminal-1",
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
            )),
        )
    }

    fn transcript() -> ProviderConversationTranscript {
        ProviderConversationTranscript {
            schema_version: 1,
            provider: "claude".into(),
            conversation_id: "conversation-1".into(),
            history_complete: true,
            final_response: Some("All green.".into()),
            entries: vec![
                ProviderTranscriptEntry {
                    role: ConversationTurnRole::User,
                    text: "Run the tests".into(),
                },
                ProviderTranscriptEntry {
                    role: ConversationTurnRole::Agent,
                    text: "All green.".into(),
                },
            ],
        }
    }

    #[test]
    fn a_remote_session_is_refused_before_the_desktop_hears_of_it() {
        let sink = Recorder::default();
        let read = answer_transcript(Some(&sink), BoxRoute::Remote, read_request());
        let prompt = answer_prompt(Some(&sink), BoxRoute::Remote, prompt_request());
        assert_eq!(read.code, Some(ConversationRefusal::RemoteUnsupported));
        assert_eq!(prompt.state, AgentPromptState::Refused);
        assert_eq!(prompt.code, Some(ConversationRefusal::RemoteUnsupported));
        assert!(sink.transcripts.lock().unwrap().is_empty());
        assert!(sink.prompts.lock().unwrap().is_empty());
    }

    #[test]
    fn a_box_this_hub_does_not_know_has_no_such_session() {
        let read = answer_transcript(Some(&Recorder::default()), BoxRoute::Unknown, read_request());
        assert_eq!(read.code, Some(ConversationRefusal::SessionNotFound));
    }

    #[test]
    fn a_hub_without_the_service_says_so() {
        let read = answer_transcript(None, BoxRoute::Local, read_request());
        let prompt = answer_prompt(None, BoxRoute::Local, prompt_request());
        assert_eq!(read.code, Some(ConversationRefusal::Unavailable));
        assert_eq!(prompt.code, Some(ConversationRefusal::Unavailable));
    }

    #[test]
    fn a_local_request_reaches_the_desktop_unchanged() {
        let sink = Recorder::default();
        let prompt = answer_prompt(Some(&sink), BoxRoute::Local, prompt_request());
        assert_eq!(prompt.state, AgentPromptState::WrittenToPty);
        assert_eq!(sink.prompts.lock().unwrap().as_slice(), [prompt_request()]);
        let _ = answer_transcript(Some(&sink), BoxRoute::Local, read_request());
        assert_eq!(sink.transcripts.lock().unwrap().as_slice(), [read_request()]);
    }

    #[test]
    fn an_unusable_prompt_never_reaches_the_desktop() {
        let sink = Recorder::default();
        for request in [
            PromptRequest {
                text: "  \n".into(),
                ..prompt_request()
            },
            PromptRequest {
                text: "a\0b".into(),
                ..prompt_request()
            },
            PromptRequest {
                expected_terminal_epoch: String::new(),
                ..prompt_request()
            },
            PromptRequest {
                session_id: String::new(),
                ..prompt_request()
            },
        ] {
            let result = answer_prompt(Some(&sink), BoxRoute::Local, request);
            assert_eq!(result.code, Some(ConversationRefusal::InvalidRequest));
        }
        assert!(sink.prompts.lock().unwrap().is_empty());
    }

    #[test]
    fn only_managed_claude_and_codex_sessions_serve_a_conversation() {
        for (provider, served) in [("claude", true), ("codex", true), ("shell", false), ("gemini", false)] {
            assert_eq!(serves_conversation(&SessionClass::Managed, provider), served, "{provider}");
        }
        assert!(!serves_conversation(&SessionClass::Standalone, "claude"));
    }

    #[test]
    fn projections_from_another_process_are_not_this_agent() {
        let observed = ObservedAgent::from_host(
            "terminal-2",
            Some(&identity("terminal-1", ProviderConversationIdentitySource::ProviderEvent)),
            Some(&runtime(
                "terminal-1",
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
            )),
        );
        assert_eq!(observed.conversation, None);
        assert_eq!(observed.runtime, None);
    }

    #[test]
    fn the_host_runtime_state_is_read_as_waiting_and_attention() {
        let observed = idle_agent();
        assert_eq!(
            observed.runtime,
            Some(ObservedRuntime {
                revision: 12,
                turn_completed_count: 3,
                waiting: true,
                attention: false,
            })
        );
        let mut working = runtime(
            "terminal-1",
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::ApprovalRequired,
        );
        let observed = ObservedAgent::from_host("terminal-1", None, Some(&working));
        assert!(!observed.runtime.unwrap().waiting);
        assert!(observed.runtime.unwrap().attention);
        working.background_work = true;
        let observed = ObservedAgent::from_host("terminal-1", None, Some(&working));
        assert!(observed.runtime.unwrap().waiting);
    }

    #[test]
    fn a_transcript_carries_the_conversation_and_a_cursor() {
        let result = transcript_answer(&idle_agent(), &read_request(), |provider, conversation| {
            assert_eq!((provider, conversation), ("claude", "conversation-1"));
            Ok(transcript())
        });
        assert_eq!(result.outcome, TranscriptOutcome::Transcript);
        assert_eq!(result.provider.as_deref(), Some("claude"));
        assert_eq!(result.conversation_id.as_deref(), Some("conversation-1"));
        assert_eq!(result.final_response.as_deref(), Some("All green."));
        assert!(result.history_complete);
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| (entry.role, entry.text.as_str()))
                .collect::<Vec<_>>(),
            [
                (ConversationRole::User, "Run the tests"),
                (ConversationRole::Agent, "All green."),
            ]
        );
        assert_eq!(
            result.cursor,
            Some(ConversationCursor {
                terminal_epoch: "terminal-1".into(),
                conversation_id: "conversation-1".into(),
                turn_completed_count: 3,
                runtime_revision: 12,
            })
        );
    }

    /// The cheap path: echoing the cursor back reads no provider file.
    #[test]
    fn an_echoed_cursor_answers_unchanged_without_reading_the_transcript() {
        let first = transcript_answer(&idle_agent(), &read_request(), |_, _| Ok(transcript()));
        let again = TranscriptRequest {
            after: first.cursor.clone(),
            ..read_request()
        };
        let result = transcript_answer(&idle_agent(), &again, |_, _| {
            panic!("an unchanged conversation must not be read")
        });
        assert_eq!(result.outcome, TranscriptOutcome::Unchanged);
        assert_eq!(result.cursor, first.cursor);
        assert!(result.entries.is_empty());
    }

    /// A prompt that starts a turn moves the runtime revision, so the next
    /// read shows the new user turn instead of answering "unchanged".
    #[test]
    fn a_turn_starting_moves_the_cursor() {
        let first = transcript_answer(&idle_agent(), &read_request(), |_, _| Ok(transcript()));
        let mut working = runtime(
            "terminal-1",
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
        );
        working.revision = "13".into();
        let observed = ObservedAgent::from_host(
            "terminal-1",
            Some(&identity("terminal-1", ProviderConversationIdentitySource::ProviderEvent)),
            Some(&working),
        );
        let again = TranscriptRequest {
            after: first.cursor,
            ..read_request()
        };
        let result = transcript_answer(&observed, &again, |_, _| Ok(transcript()));
        assert_eq!(result.outcome, TranscriptOutcome::Transcript);
    }

    #[test]
    fn without_runtime_state_the_cursor_never_vouches_for_unchanged() {
        let observed = ObservedAgent::from_host(
            "terminal-1",
            Some(&identity("terminal-1", ProviderConversationIdentitySource::ProviderEvent)),
            None,
        );
        let first = transcript_answer(&observed, &read_request(), |_, _| Ok(transcript()));
        let again = TranscriptRequest {
            after: first.cursor,
            ..read_request()
        };
        let result = transcript_answer(&observed, &again, |_, _| Ok(transcript()));
        assert_eq!(result.outcome, TranscriptOutcome::Transcript);
    }

    #[test]
    fn an_agent_without_a_conversation_has_nothing_to_read() {
        let observed = ObservedAgent::from_host("terminal-1", None, None);
        let result = transcript_answer(&observed, &read_request(), |_, _| {
            panic!("no conversation to read")
        });
        assert_eq!(result.code, Some(ConversationRefusal::ConversationUnknown));
    }

    #[test]
    fn a_transcript_the_reader_cannot_open_is_a_typed_refusal() {
        let result = transcript_answer(&idle_agent(), &read_request(), |_, _| {
            Err("provider conversation was not found".into())
        });
        assert_eq!(result.outcome, TranscriptOutcome::Refused);
        assert_eq!(result.code, Some(ConversationRefusal::TranscriptUnavailable));
    }

    #[test]
    fn a_prompt_targets_the_conversation_the_provider_reported() {
        let expected = prompt_target(&idle_agent(), "terminal-1", Some("conversation-1"))
            .expect("admissible");
        assert_eq!(expected.provider_id(), "claude");
        assert_eq!(expected.conversation_id(), "conversation-1");
        assert!(prompt_target(&idle_agent(), "terminal-1", None).is_ok());
    }

    #[test]
    fn a_prompt_for_another_process_or_conversation_is_refused_unwritten() {
        for (epoch, conversation) in [
            ("terminal-0", None),
            ("terminal-1", Some("conversation-0")),
        ] {
            let refused = prompt_target(&idle_agent(), epoch, conversation).expect_err("refused");
            assert_eq!(refused.state, AgentPromptState::Refused);
            assert_eq!(refused.code, Some(ConversationRefusal::IdentityChanged));
        }
    }

    /// The Host admits an existing-conversation prompt only on an identity
    /// the provider reported; one the launch request named is not enough.
    #[test]
    fn a_prompt_needs_a_conversation_the_provider_reported() {
        for observed in [
            ObservedAgent::from_host("terminal-1", None, None),
            ObservedAgent::from_host(
                "terminal-1",
                Some(&identity("terminal-1", ProviderConversationIdentitySource::LaunchRequest)),
                None,
            ),
        ] {
            let refused = prompt_target(&observed, "terminal-1", None).expect_err("refused");
            assert_eq!(refused.code, Some(ConversationRefusal::ConversationUnknown));
        }
    }

    #[test]
    fn a_host_refusal_is_named_from_the_state_it_was_decided_on() {
        let working = ObservedAgent::from_host(
            "terminal-1",
            None,
            Some(&runtime(
                "terminal-1",
                AgentRuntimeActivity::Working,
                AgentRuntimeAttention::None,
            )),
        );
        let approving = ObservedAgent::from_host(
            "terminal-1",
            None,
            Some(&runtime(
                "terminal-1",
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::ApprovalRequired,
            )),
        );
        let cases = [
            ("hmux_agent_prompt_runtime_changed", &working, ConversationRefusal::NotIdle),
            (
                "hmux_agent_prompt_runtime_changed",
                &approving,
                ConversationRefusal::AttentionPending,
            ),
            ("hmux_input_draft_pending", &working, ConversationRefusal::InputDraftPending),
            ("hmux_capability_missing", &working, ConversationRefusal::UnsupportedRuntime),
            ("hmux_endpoint_unavailable", &working, ConversationRefusal::Unavailable),
        ];
        for (code, observed, expected) in cases {
            let result = prompt_failure(code, "not_written", observed);
            assert_eq!(result.state, AgentPromptState::Refused, "{code}");
            assert_eq!(result.code, Some(expected), "{code}");
            assert!(result.record_id.is_none());
        }
    }

    /// When writing may have started, the phone must not be told "refused":
    /// sending again could type the prompt twice.
    #[test]
    fn an_unconfirmed_write_is_unknown_not_refused() {
        let result = prompt_failure("hmux_agent_prompt_failed", "unknown", &idle_agent());
        assert_eq!(result.state, AgentPromptState::Unknown);
        assert_eq!(result.code, None);
    }

    #[test]
    fn an_attach_that_finds_another_generation_is_an_identity_change() {
        let moved = ClientError::Transport {
            code: "hmux_expected_generation_mismatch",
            message: "managed session generation changed before exact input".into(),
        };
        assert_eq!(attach_refusal(&moved).code, Some(ConversationRefusal::IdentityChanged));
        let shell = ClientError::Transport {
            code: "hmux_agent_prompt_requires_managed",
            message: "agent prompt input requires a managed session".into(),
        };
        assert_eq!(attach_refusal(&shell).code, Some(ConversationRefusal::UnsupportedRuntime));
        let gone = ClientError::SessionNotFound {
            session_id: "session-1".into(),
            workspace_id: None,
        };
        assert_eq!(attach_refusal(&gone).code, Some(ConversationRefusal::SessionNotFound));
    }
}
