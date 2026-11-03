//! The observer chat for an agent on a server this phone reaches over SSH (#384).
//!
//! The same two questions [`crate::hub_conversation`] asks a paired computer,
//! asked of the server itself, so Chat keeps working with the laptop closed:
//!
//! - **The transcript** is one `conversation_transcript` request to
//!   `hmux mobile-gateway` (gateway request 12). The server resolves the
//!   session by the exact fence this phone listed, reads the provider
//!   transcript there and answers in the hub's conversation shape, so the
//!   screen draws a server's answer exactly as a computer's.
//! - **The prompt** goes through the Host's own idle-only admission, over
//!   [`hmux_ssh_transport::attach_agent_prompt_over_ssh`]: the Host writes it
//!   only while it observes the agent idle, with no attention, on the
//!   conversation the provider reported, and writes text and submit as one
//!   record. Nothing here re-decides that.
//!
//! The refusal names below are the desktop hub's
//! (`src-tauri/src/hub/conversation.rs`), applied to what this attach
//! observed, so a prompt reads the same refused by either.
//!
//! # A server whose Hmux predates the request
//!
//! It refuses request 12 as an unsupported version. That is answered as
//! [`SERVER_UPDATE_REQUIRED`], which the screen shows as "update the server's
//! Dure CLI" and gives way to the terminal, which still works.
//!
//! # A prompt whose answer is lost
//!
//! An error from [`prompt`] means nothing was written: the dial, the key or
//! the attach failed before the prompt left. Once it has, every failure is
//! the protocol's `unknown`.

use crate::catalog::RemoteSession;
use crate::CommandError;
use dure_hub_protocol::conversation::{
    normalize_agent_prompt, ConversationCursor, ConversationRefusal, HubAgentPromptResult,
    HubConversationTranscriptResult, HUB_CONVERSATION_VERSION,
};
use hmux_client::{
    AgentRuntimeAttention, AgentRuntimeStateDescriptor, ClientError,
    ProviderConversationIdentityDescriptor, ProviderConversationIdentitySeed,
    ProviderConversationIdentitySource, SessionFence,
};
use hmux_ssh_transport::conversation_transcript::{self, ConversationTranscriptRequest};
use hmux_ssh_transport::{AttachError, CatalogError, SshExecConfig};
use std::time::Duration;

/// The server's Hmux predates the conversation request: its Dure CLI needs an
/// update before Chat can read it.
pub const SERVER_UPDATE_REQUIRED: &str = "conversation_server_update_required";

/// The phone could not reach the server, before anything was written.
pub const SERVER_UNREACHABLE: &str = "server_unreachable";

/// One transcript, dial to answer. The server spends at most one bounded Host
/// inspection and one bounded file read of it.
pub const TRANSCRIPT_BUDGET: Duration = Duration::from_secs(15);

/// How long the Host has to admit and confirm one prompt, as on the hub.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(10);

/// The Host-owned facts a prompt is decided on, from the prompt attach itself.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedAgent {
    terminal_epoch: String,
    conversation: Option<ObservedConversation>,
    attention: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedConversation {
    provider_id: String,
    conversation_id: String,
    /// The provider itself reported it, rather than the launch request
    /// naming it. Only such an identity admits an existing-conversation
    /// prompt.
    reported_by_provider: bool,
}

impl ObservedAgent {
    /// Keep only what the Host reported for this process.
    fn from_host(
        terminal_epoch: &str,
        identity: Option<&ProviderConversationIdentityDescriptor>,
        runtime: Option<&AgentRuntimeStateDescriptor>,
    ) -> Self {
        Self {
            terminal_epoch: terminal_epoch.to_string(),
            conversation: identity
                .filter(|identity| identity.terminal_epoch == terminal_epoch)
                .map(|identity| ObservedConversation {
                    provider_id: identity.provider_id.clone(),
                    conversation_id: identity.conversation_id.clone(),
                    reported_by_provider: identity.source
                        == ProviderConversationIdentitySource::ProviderEvent,
                }),
            attention: runtime
                .filter(|runtime| runtime.terminal_epoch == terminal_epoch)
                .is_some_and(|runtime| {
                    runtime.attention != AgentRuntimeAttention::None
                        || runtime.attention_id.is_some()
                }),
        }
    }
}

fn command_error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.to_string(),
        message: message.into(),
    }
}

/// The question for one listed session.
fn transcript_request(
    session: &RemoteSession,
    limit: Option<u32>,
    after: Option<ConversationCursor>,
) -> Result<ConversationTranscriptRequest<ConversationCursor>, CommandError> {
    Ok(ConversationTranscriptRequest {
        expected_fence: session
            .fence()
            .map_err(|error| command_error(error.code(), error.to_string()))?,
        limit,
        after,
    })
}

/// Name what came back. A refusal about the session is an answer; only a
/// server that could not answer, or answered in another shape, is an error.
fn transcript_answer(
    answer: Result<HubConversationTranscriptResult, CatalogError>,
) -> Result<HubConversationTranscriptResult, CommandError> {
    match answer {
        Ok(answer) if answer.hub_conversation_version == HUB_CONVERSATION_VERSION => Ok(answer),
        Ok(answer) => Err(command_error(
            crate::hub_conversation::VERSION_UNSUPPORTED,
            format!(
                "The server answered conversation version {}; this phone reads {HUB_CONVERSATION_VERSION}",
                answer.hub_conversation_version
            ),
        )),
        Err(error) if error.is_unsupported_protocol_version() => Err(command_error(
            SERVER_UPDATE_REQUIRED,
            format!("The server's Dure CLI cannot serve Chat yet: {error}"),
        )),
        Err(error) => Err(CommandError::from(error)),
    }
}

/// Read one server session's conversation.
pub fn transcript(
    config: SshExecConfig,
    session: &RemoteSession,
    limit: Option<u32>,
    after: Option<ConversationCursor>,
) -> Result<HubConversationTranscriptResult, CommandError> {
    let request = transcript_request(session, limit, after)?;
    transcript_answer(conversation_transcript::over_ssh(
        config,
        &request,
        TRANSCRIPT_BUDGET,
    ))
}

/// The prompt as it is sent and the exact generation it is fenced on.
/// Refused here, before dialing, when its shape would be refused anyway.
fn prompt_fence(
    session: &RemoteSession,
    text: &str,
    expected_terminal_epoch: &str,
) -> Result<(SessionFence, String), HubAgentPromptResult> {
    let text = normalize_agent_prompt(text).map_err(|error| {
        HubAgentPromptResult::refused(ConversationRefusal::InvalidRequest, error.to_string())
    })?;
    let mut fence = session.fence().map_err(|_| {
        HubAgentPromptResult::refused(
            ConversationRefusal::InvalidRequest,
            "The session reported an unreadable generation",
        )
    })?;
    // The chat's view of the provider process is the fence: a Host that moved
    // since refuses the attach.
    fence.terminal_epoch = expected_terminal_epoch.to_string();
    Ok((fence, text))
}

fn identity_changed() -> HubAgentPromptResult {
    HubAgentPromptResult::refused(
        ConversationRefusal::IdentityChanged,
        "The agent's process or conversation changed. Read the conversation again",
    )
}

/// The conversation to prompt, once everything provable before the Host
/// admits is ruled out. Nothing has been written when this refuses.
fn prompt_target(
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

/// Name the Host's answer to a prompt it did not confirm, from what the
/// prompt attach observed. The hub takes a second look after an idle refusal;
/// over SSH that would be another connection, and the queue keeps a `not_idle`
/// prompt and asks again at the next idle, where a changed conversation is
/// refused before anything is written.
fn prompt_failure(
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
        "hmux_agent_prompt_runtime_changed" if observed.attention => HubAgentPromptResult::refused(
            ConversationRefusal::AttentionPending,
            "The agent is waiting for an answer in the terminal",
        ),
        "hmux_agent_prompt_runtime_changed" => HubAgentPromptResult::refused(
            ConversationRefusal::NotIdle,
            "The agent is not waiting for input",
        ),
        "hmux_input_draft_pending" => HubAgentPromptResult::refused(
            ConversationRefusal::InputDraftPending,
            "Someone has typed into the terminal without submitting",
        ),
        "hmux_capability_missing" | "hmux_capability_unsupported" => HubAgentPromptResult::refused(
            ConversationRefusal::UnsupportedRuntime,
            "This session's Host cannot take an agent prompt",
        ),
        _ => HubAgentPromptResult::refused(
            ConversationRefusal::Unavailable,
            format!("The session did not take the prompt ({code})"),
        ),
    }
}

/// A deadline ran out, as opposed to the Host or the transport refusing.
fn timed_out(error: &ClientError) -> bool {
    match error {
        ClientError::Io { source, .. } => matches!(
            source.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        ),
        ClientError::WriteNotStarted { .. } => true,
        _ => matches!(
            error.code(),
            "hmux_attach_deadline_exceeded"
                | "hmux_read_deadline_exceeded"
                | "hmux_managed_authorization_grant_timeout"
        ),
    }
}

/// Name a failure to attach for a prompt. Nothing was written.
fn attach_refusal(error: &ClientError) -> HubAgentPromptResult {
    match error.code() {
        "hmux_expected_generation_mismatch"
        | "hmux_identity_mismatch"
        | "hmux_manifest_process_mismatch" => identity_changed(),
        "hmux_agent_prompt_requires_managed" => HubAgentPromptResult::refused(
            ConversationRefusal::UnsupportedRuntime,
            "This session takes no agent prompt",
        ),
        "hmux_protocol_version_unsupported"
        | "hmux_capability_missing"
        | "hmux_capability_unsupported" => HubAgentPromptResult::refused(
            ConversationRefusal::UnsupportedRuntime,
            "This session's Host cannot take an agent prompt",
        ),
        _ if error.is_session_absent() => HubAgentPromptResult::refused(
            ConversationRefusal::SessionNotFound,
            "This server serves no such session",
        ),
        code if timed_out(error) => HubAgentPromptResult::refused(
            ConversationRefusal::ProbeTimeout,
            format!("The session's Host did not answer in time ({code}). Ask again"),
        ),
        code => HubAgentPromptResult::refused(
            ConversationRefusal::Unavailable,
            format!("Could not reach the session ({code})"),
        ),
    }
}

/// Type one prompt into a server session's agent.
pub fn prompt(
    config: SshExecConfig,
    session: &RemoteSession,
    text: &str,
    expected_terminal_epoch: &str,
    expected_conversation_id: Option<&str>,
) -> Result<HubAgentPromptResult, CommandError> {
    let (fence, text) = match prompt_fence(session, text, expected_terminal_epoch) {
        Ok(prepared) => prepared,
        Err(refused) => return Ok(refused),
    };
    let mut surface = match hmux_ssh_transport::attach_agent_prompt_over_ssh(config, fence) {
        Ok(surface) => surface,
        Err(AttachError::Ssh(error)) => {
            return Err(command_error(SERVER_UNREACHABLE, error.to_string()));
        }
        Err(AttachError::Session(error)) => return Ok(attach_refusal(&error)),
    };
    let observed = ObservedAgent::from_host(
        expected_terminal_epoch,
        surface.initial_provider_conversation_identity(),
        surface.initial_agent_runtime_state(),
    );
    let expected = match prompt_target(&observed, expected_terminal_epoch, expected_conversation_id)
    {
        Ok(expected) => expected,
        Err(refused) => {
            let _ = surface.detach();
            return Ok(refused);
        }
    };
    let sent = surface.send_existing_idle_agent_prompt_confirmed(text, &expected, PROMPT_TIMEOUT);
    let _ = surface.detach();
    Ok(match sent {
        Ok(receipt) => HubAgentPromptResult::written(
            receipt.terminal_epoch(),
            receipt.input().in_reply_to_record_id.to_string(),
        ),
        Err(error) => prompt_failure(error.code(), error.delivery_state(), &observed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogEnum;
    use dure_hub_protocol::conversation::{
        AgentPromptState, ConversationRefusal, TranscriptOutcome, HUB_CONVERSATION_VERSION,
        MAX_AGENT_PROMPT_BYTES,
    };
    use hmux_host::local_protocol::ErrorCode;

    fn session() -> RemoteSession {
        RemoteSession {
            session_id: "session-1".into(),
            session_name: None,
            workspace_id: "workspace-1".into(),
            session_class: CatalogEnum("managed".into()),
            lifecycle: CatalogEnum("ready".into()),
            provider_id: "claude".into(),
            launch_program: None,
            host_liveness: None,
            runner_principal: "server-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "7".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            capabilities: Vec::new(),
        }
    }

    fn cursor() -> ConversationCursor {
        ConversationCursor {
            terminal_epoch: "terminal-1".into(),
            conversation_id: "conversation-1".into(),
            turn_completed_count: 2,
            turn_open: false,
            runtime_revision: 9,
        }
    }

    fn observed(reported_by_provider: bool, attention: bool) -> ObservedAgent {
        ObservedAgent {
            terminal_epoch: "terminal-1".into(),
            conversation: Some(ObservedConversation {
                provider_id: "claude".into(),
                conversation_id: "conversation-1".into(),
                reported_by_provider,
            }),
            attention,
        }
    }

    fn refusal(result: &HubAgentPromptResult) -> Option<ConversationRefusal> {
        assert_eq!(result.state, AgentPromptState::Refused, "{result:?}");
        result.code
    }

    fn transport(code: &'static str) -> ClientError {
        ClientError::Transport {
            code,
            message: "fixture".into(),
        }
    }

    #[test]
    fn the_transcript_is_asked_by_the_listed_fence_with_the_last_cursor() {
        let request = transcript_request(&session(), Some(100), Some(cursor())).unwrap();
        assert_eq!(request.expected_fence, session().fence().unwrap());
        assert_eq!(request.expected_fence.channel_epoch, 7);
        assert_eq!(request.limit, Some(100));
        assert_eq!(request.after, Some(cursor()));

        let mut unreadable = session();
        unreadable.channel_epoch = "not a number".into();
        assert!(transcript_request(&unreadable, None, None).is_err());
    }

    #[test]
    fn a_server_whose_hmux_predates_the_request_asks_for_an_update() {
        let error = transcript_answer(Err(CatalogError::Refused {
            code: ErrorCode::UnsupportedProtocolVersion,
            message: "this gateway serves gateway_request_version 1..=11, not 12".into(),
        }))
        .unwrap_err();
        assert_eq!(error.code, SERVER_UPDATE_REQUIRED);
    }

    #[test]
    fn an_answer_in_another_conversation_version_is_not_read() {
        let mut answer = HubConversationTranscriptResult::unchanged(
            "claude".into(),
            "conversation-1".into(),
            cursor(),
        );
        assert_eq!(
            transcript_answer(Ok(answer.clone())).unwrap().outcome,
            TranscriptOutcome::Unchanged
        );
        answer.hub_conversation_version = HUB_CONVERSATION_VERSION + 1;
        assert_eq!(
            transcript_answer(Ok(answer)).unwrap_err().code,
            crate::hub_conversation::VERSION_UNSUPPORTED
        );
    }

    #[test]
    fn other_transcript_failures_keep_their_transport_code() {
        let error = transcript_answer(Err(CatalogError::Response("broken".into()))).unwrap_err();
        assert_eq!(error.code, "hmux_gateway_catalog_response_invalid");
    }

    #[test]
    fn a_prompt_is_checked_before_dialing_and_fenced_on_the_process_it_names() {
        let (fence, text) = prompt_fence(&session(), "fix it\r\nplease", "terminal-1").unwrap();
        assert_eq!(text, "fix it\nplease");
        assert_eq!(fence, session().fence().unwrap());

        // The chat's epoch is the fence: a catalog row from before a provider
        // restart cannot redirect the prompt.
        let (fence, _) = prompt_fence(&session(), "fix it", "terminal-2").unwrap();
        assert_eq!(fence.terminal_epoch, "terminal-2");

        let long = "x".repeat(MAX_AGENT_PROMPT_BYTES + 1);
        for text in ["   ", "\u{1b}[A", long.as_str()] {
            let refused = prompt_fence(&session(), text, "terminal-1").unwrap_err();
            assert_eq!(refusal(&refused), Some(ConversationRefusal::InvalidRequest));
        }
    }

    #[test]
    fn only_the_conversation_the_provider_reported_takes_the_prompt() {
        let seed =
            prompt_target(&observed(true, false), "terminal-1", Some("conversation-1")).unwrap();
        assert_eq!(seed.provider_id(), "claude");
        assert_eq!(seed.conversation_id(), "conversation-1");

        let launch_only = prompt_target(&observed(false, false), "terminal-1", None).unwrap_err();
        assert_eq!(
            refusal(&launch_only),
            Some(ConversationRefusal::ConversationUnknown)
        );
        let other_process = prompt_target(&observed(true, false), "terminal-2", None).unwrap_err();
        assert_eq!(
            refusal(&other_process),
            Some(ConversationRefusal::IdentityChanged)
        );
        let other_conversation =
            prompt_target(&observed(true, false), "terminal-1", Some("conversation-2"))
                .unwrap_err();
        assert_eq!(
            refusal(&other_conversation),
            Some(ConversationRefusal::IdentityChanged)
        );
    }

    #[test]
    fn the_hosts_refusal_is_named_and_a_possible_write_is_unknown() {
        let idle = observed(true, false);
        assert_eq!(
            refusal(&prompt_failure(
                "hmux_agent_prompt_runtime_changed",
                "not_written",
                &idle
            )),
            Some(ConversationRefusal::NotIdle)
        );
        assert_eq!(
            refusal(&prompt_failure(
                "hmux_agent_prompt_runtime_changed",
                "not_written",
                &observed(true, true)
            )),
            Some(ConversationRefusal::AttentionPending)
        );
        assert_eq!(
            refusal(&prompt_failure(
                "hmux_input_draft_pending",
                "not_written",
                &idle
            )),
            Some(ConversationRefusal::InputDraftPending)
        );
        assert_eq!(
            refusal(&prompt_failure(
                "hmux_capability_missing",
                "not_written",
                &idle
            )),
            Some(ConversationRefusal::UnsupportedRuntime)
        );
        assert_eq!(
            refusal(&prompt_failure("hmux_something_else", "not_written", &idle)),
            Some(ConversationRefusal::Unavailable)
        );
        let maybe = prompt_failure("hmux_transport_closed", "unknown", &idle);
        assert_eq!(maybe.state, AgentPromptState::Unknown);
    }

    #[test]
    fn an_attach_that_did_not_happen_names_why_and_wrote_nothing() {
        for (code, expected) in [
            (
                "hmux_expected_generation_mismatch",
                ConversationRefusal::IdentityChanged,
            ),
            (
                "hmux_identity_mismatch",
                ConversationRefusal::IdentityChanged,
            ),
            (
                "hmux_agent_prompt_requires_managed",
                ConversationRefusal::UnsupportedRuntime,
            ),
            (
                "hmux_protocol_version_unsupported",
                ConversationRefusal::UnsupportedRuntime,
            ),
            (
                "hmux_attach_deadline_exceeded",
                ConversationRefusal::ProbeTimeout,
            ),
            (
                "hmux_authorization_denied",
                ConversationRefusal::Unavailable,
            ),
        ] {
            assert_eq!(
                refusal(&attach_refusal(&transport(code))),
                Some(expected),
                "{code}"
            );
        }
        let absent = ClientError::SessionNotFound {
            session_id: "session-1".into(),
            workspace_id: None,
        };
        assert_eq!(
            refusal(&attach_refusal(&absent)),
            Some(ConversationRefusal::SessionNotFound)
        );
    }
}
