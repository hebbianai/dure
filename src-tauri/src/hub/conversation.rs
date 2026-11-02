//! A phone reads one local agent's conversation and types a prompt into it.
//!
//! # Who decides what
//!
//! - **The transcript** is read with the desktop's provider transcript reader,
//!   for the conversation the Hmux Host observed on the session, from the
//!   default state root or the account profile the agent runs under
//!   (`conv::transcript_any_account`). The phone names a session, never a
//!   provider file or conversation to read.
//! - **The prompt** is admitted by the Hmux Host, through the same
//!   agent-prompt input the control plane's `agent_runtime.native.input`
//!   sends: the Host writes only when it observes the agent idle, with no
//!   attention raised, on the expected conversation, and writes the text and
//!   its submit as one record.
//! - **This module** routes the request to this desktop's sessions, refuses
//!   what it can prove before touching the Host (another box, another process,
//!   another conversation, no conversation yet), and names a Host refusal from
//!   what the Host observes once it has refused. It never re-decides what the
//!   Host admits.
//!
//! Sessions on remote hosts are refused `remote_unsupported` for now: their
//! transcript lives on the remote machine.

use dure_hub_protocol::conversation::{
    normalize_agent_prompt, ConversationCursor, ConversationEntry, ConversationRefusal,
    ConversationRole, HubAgentPromptResult, HubConversationTranscriptResult, TranscriptParts,
};
use dure_provider_profile::transcript::{ConversationTurnRole, ProviderConversationTranscript};
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
    AgentRuntimeStateDescriptor, ClientError, LocalSessionCatalog,
    ProviderConversationIdentityDescriptor, ProviderConversationIdentitySeed,
    ProviderConversationIdentitySource, SessionClass, SessionDescriptor, SessionFence,
    SessionHealth, SessionLifecycle, SessionSelector, TerminalSurfaceAttachment,
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

/// Whether the catalog offers a chat for a local session: one this desktop
/// serves whose manifest still says it runs. An exited session would only be
/// refused.
#[must_use]
pub fn offers_conversation(
    session_class: &SessionClass,
    provider_id: &str,
    lifecycle: &SessionLifecycle,
) -> bool {
    *lifecycle == SessionLifecycle::Ready && serves_conversation(session_class, provider_id)
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
    pub workspace_id: String,
    pub session_id: String,
    pub limit: Option<u32>,
    pub after: Option<ConversationCursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptRequest {
    pub workspace_id: String,
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
    match admit(route, sink, &request.workspace_id, &request.session_id) {
        Ok(sink) => sink.transcript(request),
        Err((code, detail)) => HubConversationTranscriptResult::refused(code, detail),
    }
}

/// Type one prompt into a session's agent, if it is this desktop's to write.
pub fn answer_prompt(
    sink: Option<&dyn ConversationSink>,
    route: BoxRoute,
    mut request: PromptRequest,
) -> HubAgentPromptResult {
    let sink = match admit(route, sink, &request.workspace_id, &request.session_id) {
        Ok(sink) => sink,
        Err((code, detail)) => return HubAgentPromptResult::refused(code, detail),
    };
    // The same normalization the phone applies before sending, so both sides
    // agree on the bytes and the limit; the refusal names the limit.
    request.text = match normalize_agent_prompt(&request.text) {
        Ok(text) => text,
        Err(error) => {
            return HubAgentPromptResult::refused(
                ConversationRefusal::InvalidRequest,
                error.to_string(),
            )
        }
    };
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
    sink.prompt(request)
}

/// The sink to ask, once the request is this desktop's own and names a
/// session it could hold.
fn admit<'a>(
    route: BoxRoute,
    sink: Option<&'a dyn ConversationSink>,
    workspace_id: &str,
    session_id: &str,
) -> Result<&'a dyn ConversationSink, (ConversationRefusal, &'static str)> {
    match route {
        BoxRoute::Remote => Err((
            ConversationRefusal::RemoteUnsupported,
            "Conversations of sessions on remote hosts are not served yet. Open the terminal",
        )),
        BoxRoute::Unknown => Err((
            ConversationRefusal::SessionNotFound,
            "This desktop serves no such session",
        )),
        BoxRoute::Local => {
            let sink = sink.ok_or((
                ConversationRefusal::Unavailable,
                "This desktop cannot serve agent conversations",
            ))?;
            if !bounded_identifier(workspace_id) || !bounded_identifier(session_id) {
                return Err((
                    ConversationRefusal::InvalidRequest,
                    "The session is not named validly",
                ));
            }
            Ok(sink)
        }
    }
}

/// The identifier shape Hmux accepts (`hmux::validate_identifier`).
fn bounded_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// Name an inspection that did not observe a healthy Host.
///
/// Only an exited session is reported as not running. A probe that ran out of
/// its time, or a transport that did not answer, says nothing about the agent
/// — on a busy desktop a live one does that — so it is its own, retryable
/// code.
fn health_refusal(health: SessionHealth) -> Option<(ConversationRefusal, &'static str)> {
    match health {
        SessionHealth::Healthy => None,
        SessionHealth::Unprobed | SessionHealth::StaleTransport => Some((
            ConversationRefusal::ProbeTimeout,
            "The session's Host did not answer in time. Ask again",
        )),
        SessionHealth::IncompatibleProtocol => Some((
            ConversationRefusal::UnsupportedRuntime,
            "This session's Host cannot serve its conversation",
        )),
        SessionHealth::GenerationChanged => Some((
            ConversationRefusal::IdentityChanged,
            "The agent's process changed. Read the conversation again",
        )),
        SessionHealth::Exited => {
            Some((ConversationRefusal::Unavailable, "The session has exited"))
        }
    }
}

/// The Host-owned facts one answer is decided on, captured in one handshake.
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
    /// A turn is running: the agent works on a prompt. Background work after
    /// a turn ended is not a turn.
    pub turn_open: bool,
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
                    turn_open: runtime.lifecycle == AgentRuntimeLifecycle::Running
                        && runtime.activity == AgentRuntimeActivity::Working
                        && !runtime.background_work,
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
            turn_open: self.runtime.is_some_and(|runtime| runtime.turn_open),
            runtime_revision: self.runtime.map_or(0, |runtime| runtime.revision),
        }
    }

    /// Still the process and conversation a prompt was fenced on.
    fn is_on(&self, expected_terminal_epoch: &str, expected: &ProviderConversationIdentitySeed) -> bool {
        self.terminal_epoch == expected_terminal_epoch
            && self.conversation.as_ref().is_some_and(|conversation| {
                conversation.provider_id == expected.provider_id()
                    && conversation.conversation_id == expected.conversation_id()
            })
    }
}

/// Answer a transcript request from what the Host observed. `read` is the
/// provider transcript reader; it is not called while the turns are the same.
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
    // Without the Host's runtime state the cursor cannot see a turn start or
    // complete, so it never vouches for "unchanged". The runtime revision
    // moves on every progress event and does not decide it (`same_turns_as`).
    if observed.runtime.is_some()
        && request
            .after
            .as_ref()
            .is_some_and(|after| after.same_turns_as(&cursor))
    {
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

/// The Host refusals whose reason the Host does not name: idle admission
/// (`agent_runtime_changed`) and the rest (`refused`, a stale terminal epoch
/// among them).
fn refusal_needs_a_second_look(code: &str) -> bool {
    matches!(
        code,
        "hmux_agent_prompt_runtime_changed" | "hmux_agent_prompt_refused"
    )
}

/// Name the Host's answer to a prompt it did not confirm.
///
/// For the refusals the Host gives one reason for
/// ([`refusal_needs_a_second_look`]), `now` is a second inspection taken
/// after the refusal ([`refusal_after_second_look`]), not the snapshot taken
/// at attach: the conversation can change between the two. When the agent is
/// no longer on the conversation the prompt was fenced on, that is the
/// reason.
#[must_use]
pub fn prompt_failure(
    code: &str,
    delivery_state: &str,
    expected_terminal_epoch: &str,
    expected: &ProviderConversationIdentitySeed,
    now: &ObservedAgent,
) -> HubAgentPromptResult {
    if delivery_state != "not_written" {
        return HubAgentPromptResult::unknown(format!(
            "The prompt may have reached the agent ({code}). Read the conversation before sending it again"
        ));
    }
    match code {
        _ if refusal_needs_a_second_look(code) && !now.is_on(expected_terminal_epoch, expected) => {
            identity_changed()
        }
        "hmux_agent_prompt_runtime_changed" => match now.runtime {
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

/// Name a Host refusal from the second inspection taken after it, on its own
/// terms: a Host that cannot be observed now, has exited or was replaced says
/// so, rather than the attach snapshot answering for it. Nothing was written.
#[must_use]
pub fn refusal_after_second_look(
    code: &str,
    expected_terminal_epoch: &str,
    expected: &ProviderConversationIdentitySeed,
    health: SessionHealth,
    now: &ObservedAgent,
) -> HubAgentPromptResult {
    match health_refusal(health) {
        Some((refusal, detail)) => HubAgentPromptResult::refused(refusal, detail),
        None => prompt_failure(code, "not_written", expected_terminal_epoch, expected, now),
    }
}

/// A deadline ran out, as opposed to the Host or the transport refusing. Only
/// this is worth asking again unchanged.
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
                | "hmux_discovery_census_timeout"
        ),
    }
}

/// Name a failure to attach for a prompt. Nothing was written. Incompatibility
/// and generation changes are final, a deadline is worth asking again, and
/// anything else (authorization, a Host that is exiting, a broken transport)
/// is reported as unavailable with its code, not as something a retry fixes.
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
            "This desktop serves no such session",
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

/// This desktop's own Hmux sessions.
pub struct LocalConversations;

impl LocalConversations {
    fn session(
        workspace_id: &str,
        session_id: &str,
    ) -> Result<(LocalSessionCatalog, SessionDescriptor), (ConversationRefusal, String)> {
        let catalog = crate::hmux::product_catalog().map_err(|error| {
            (
                ConversationRefusal::Unavailable,
                format!("Could not open the session list ({})", error.code()),
            )
        })?;
        let descriptor = catalog
            .find(&SessionSelector::new(
                session_id,
                Some(workspace_id.to_string()),
            ))
            .map_err(|error| {
                if error.is_session_absent() {
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
        let (catalog, descriptor) = match Self::session(&request.workspace_id, &request.session_id) {
            Ok(found) => found,
            Err((code, detail)) => return HubConversationTranscriptResult::refused(code, detail),
        };
        // The one bounded handshake that tells whether a turn completed. When
        // nothing did, it is the whole cost of the answer: the provider file
        // is not read.
        let inspection = hmux_client::inspect_local_session(&catalog, descriptor);
        if let Some((code, detail)) = health_refusal(inspection.health) {
            return HubConversationTranscriptResult::refused(code, detail);
        }
        let observed = ObservedAgent::from_host(
            &inspection.descriptor.terminal_epoch,
            inspection.provider_conversation_identity.as_deref(),
            inspection.agent_runtime_state.as_ref(),
        );
        transcript_answer(&observed, &request, crate::conv::transcript_any_account)
    }

    fn prompt(&self, request: PromptRequest) -> HubAgentPromptResult {
        let (catalog, descriptor) = match Self::session(&request.workspace_id, &request.session_id) {
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
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch,
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: request.expected_terminal_epoch.clone(),
        };
        let mut surface = match TerminalSurfaceAttachment::connect_local_agent_prompt(&catalog, &fence)
        {
            Ok(surface) => surface,
            Err(error) => return attach_refusal(&error),
        };
        let snapshot = ObservedAgent::from_host(
            &fence.terminal_epoch,
            surface.initial_provider_conversation_identity(),
            surface.initial_agent_runtime_state(),
        );
        let expected = match prompt_target(
            &snapshot,
            &request.expected_terminal_epoch,
            request.expected_conversation_id.as_deref(),
        ) {
            Ok(expected) => expected,
            Err(refusal) => {
                let _ = surface.detach();
                return refusal;
            }
        };
        let sent =
            surface.send_existing_idle_agent_prompt_confirmed(request.text, &expected, PROMPT_TIMEOUT);
        let _ = surface.detach();
        match sent {
            Ok(receipt) => HubAgentPromptResult::written(
                receipt.terminal_epoch(),
                receipt.input().in_reply_to_record_id.to_string(),
            ),
            Err(error)
                if error.delivery_state() == "not_written"
                    && refusal_needs_a_second_look(error.code()) =>
            {
                let inspection = hmux_client::inspect_local_session(&catalog, descriptor);
                let now = ObservedAgent::from_host(
                    &inspection.descriptor.terminal_epoch,
                    inspection.provider_conversation_identity.as_deref(),
                    inspection.agent_runtime_state.as_ref(),
                );
                refusal_after_second_look(
                    error.code(),
                    &request.expected_terminal_epoch,
                    &expected,
                    inspection.health,
                    &now,
                )
            }
            Err(error) => prompt_failure(
                error.code(),
                error.delivery_state(),
                &request.expected_terminal_epoch,
                &expected,
                &snapshot,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::conversation::{
        AgentPromptState, TranscriptOutcome, MAX_AGENT_PROMPT_BYTES,
    };
    use dure_provider_profile::transcript::ProviderTranscriptEntry;
    use hmux_client::{AgentRuntimeActivity, AgentRuntimeLifecycle};
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
            workspace_id: "workspace-1".into(),
            session_id: "session-1".into(),
            limit: None,
            after: None,
        }
    }

    fn prompt_request() -> PromptRequest {
        PromptRequest {
            workspace_id: "workspace-1".into(),
            session_id: "session-1".into(),
            text: "Run the tests".into(),
            expected_terminal_epoch: "terminal-1".into(),
            expected_conversation_id: None,
        }
    }

    fn identity(
        terminal_epoch: &str,
        conversation_id: &str,
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
            conversation_id: conversation_id.into(),
            source,
        }
    }

    fn reported(terminal_epoch: &str) -> ProviderConversationIdentityDescriptor {
        identity(
            terminal_epoch,
            "conversation-1",
            ProviderConversationIdentitySource::ProviderEvent,
        )
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

    fn agent(
        activity: AgentRuntimeActivity,
        attention: AgentRuntimeAttention,
    ) -> ObservedAgent {
        ObservedAgent::from_host(
            "terminal-1",
            Some(&reported("terminal-1")),
            Some(&runtime("terminal-1", activity, attention)),
        )
    }

    fn idle_agent() -> ObservedAgent {
        agent(AgentRuntimeActivity::Waiting, AgentRuntimeAttention::None)
    }

    fn expected() -> ProviderConversationIdentitySeed {
        ProviderConversationIdentitySeed::new("claude", "conversation-1").unwrap()
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

    /// The workspace travels with the session id, so the desktop resolves
    /// the one session the catalog entry named.
    #[test]
    fn a_local_request_reaches_the_desktop_with_its_workspace() {
        let sink = Recorder::default();
        let prompt = answer_prompt(Some(&sink), BoxRoute::Local, prompt_request());
        assert_eq!(prompt.state, AgentPromptState::WrittenToPty);
        assert_eq!(sink.prompts.lock().unwrap().as_slice(), [prompt_request()]);
        let _ = answer_transcript(Some(&sink), BoxRoute::Local, read_request());
        assert_eq!(sink.transcripts.lock().unwrap().as_slice(), [read_request()]);
        assert_eq!(sink.transcripts.lock().unwrap()[0].workspace_id, "workspace-1");
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
                text: "clear \u{1b}[2J".into(),
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
            PromptRequest {
                workspace_id: String::new(),
                ..prompt_request()
            },
        ] {
            let result = answer_prompt(Some(&sink), BoxRoute::Local, request);
            assert_eq!(result.code, Some(ConversationRefusal::InvalidRequest));
        }
        assert!(sink.prompts.lock().unwrap().is_empty());
    }

    /// The hub refuses a long prompt with the same limit the phone checks,
    /// and says what the limit is.
    #[test]
    fn a_prompt_over_the_protocol_limit_is_refused_with_the_limit_named() {
        let sink = Recorder::default();
        let result = answer_prompt(
            Some(&sink),
            BoxRoute::Local,
            PromptRequest {
                text: "x".repeat(MAX_AGENT_PROMPT_BYTES + 1),
                ..prompt_request()
            },
        );
        assert_eq!(result.code, Some(ConversationRefusal::InvalidRequest));
        assert!(
            result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains(&MAX_AGENT_PROMPT_BYTES.to_string())),
            "{:?}",
            result.detail
        );
        assert!(sink.prompts.lock().unwrap().is_empty());
    }

    #[test]
    fn only_managed_claude_and_codex_sessions_serve_a_conversation() {
        for (provider, served) in [("claude", true), ("codex", true), ("shell", false), ("gemini", false)] {
            assert_eq!(serves_conversation(&SessionClass::Managed, provider), served, "{provider}");
        }
        assert!(!serves_conversation(&SessionClass::Standalone, "claude"));
    }

    /// An exited session would only be refused, so the catalog never offers
    /// it a chat.
    #[test]
    fn only_a_running_session_offers_a_conversation() {
        assert!(offers_conversation(&SessionClass::Managed, "claude", &SessionLifecycle::Ready));
        assert!(!offers_conversation(&SessionClass::Managed, "claude", &SessionLifecycle::Exited));
        assert!(!offers_conversation(&SessionClass::Standalone, "claude", &SessionLifecycle::Ready));
    }

    /// A probe that ran out of time is not a dead agent: a busy desktop must
    /// not flip a live chat to "not running".
    #[test]
    fn an_unhealthy_inspection_is_named_by_what_it_proves() {
        assert_eq!(health_refusal(SessionHealth::Healthy), None);
        for (health, code) in [
            (SessionHealth::Unprobed, ConversationRefusal::ProbeTimeout),
            (SessionHealth::StaleTransport, ConversationRefusal::ProbeTimeout),
            (SessionHealth::IncompatibleProtocol, ConversationRefusal::UnsupportedRuntime),
            (SessionHealth::GenerationChanged, ConversationRefusal::IdentityChanged),
            (SessionHealth::Exited, ConversationRefusal::Unavailable),
        ] {
            assert_eq!(health_refusal(health).map(|(code, _)| code), Some(code), "{health:?}");
        }
    }

    #[test]
    fn projections_from_another_process_are_not_this_agent() {
        let observed = ObservedAgent::from_host(
            "terminal-2",
            Some(&reported("terminal-1")),
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
    fn the_host_runtime_state_is_read_with_its_attention() {
        assert_eq!(
            idle_agent().runtime,
            Some(ObservedRuntime {
                revision: 12,
                turn_completed_count: 3,
                turn_open: false,
                attention: false,
            })
        );
        let approving = agent(
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::ApprovalRequired,
        );
        assert!(approving.runtime.unwrap().attention);
        assert!(approving.runtime.unwrap().turn_open);
        // Background work after a turn ended is not a running turn.
        let mut background = runtime(
            "terminal-1",
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
        );
        background.background_work = true;
        let observed = ObservedAgent::from_host("terminal-1", None, Some(&background));
        assert!(!observed.runtime.unwrap().turn_open);
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
                turn_open: false,
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

    fn working_at(revision: &str) -> ObservedAgent {
        let mut working = runtime(
            "terminal-1",
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
        );
        working.revision = revision.into();
        ObservedAgent::from_host("terminal-1", Some(&reported("terminal-1")), Some(&working))
    }

    /// The prompt the phone just wrote (or one typed in the terminal) starts a
    /// turn; that re-reads once, so it shows before the turn completes.
    #[test]
    fn a_turn_starting_rereads_the_transcript_once() {
        let idle = transcript_answer(&idle_agent(), &read_request(), |_, _| Ok(transcript()));
        let started = transcript_answer(
            &working_at("13"),
            &TranscriptRequest {
                after: idle.cursor,
                ..read_request()
            },
            |_, _| Ok(transcript()),
        );
        assert_eq!(started.outcome, TranscriptOutcome::Transcript);
        assert_eq!(started.cursor.as_ref().map(|cursor| cursor.turn_open), Some(true));
    }

    /// A working agent reports progress on every step. The phone polls every
    /// few seconds, so progress alone must not re-read the provider file.
    #[test]
    fn progress_while_a_turn_runs_does_not_reread_the_transcript() {
        let started = transcript_answer(&working_at("13"), &read_request(), |_, _| Ok(transcript()));
        let result = transcript_answer(
            &working_at("40"),
            &TranscriptRequest {
                after: started.cursor,
                ..read_request()
            },
            |_, _| panic!("progress alone must not read the transcript"),
        );
        assert_eq!(result.outcome, TranscriptOutcome::Unchanged);
        // The answer still reports where the runtime is now.
        assert_eq!(result.cursor.map(|cursor| cursor.runtime_revision), Some(40));
    }

    #[test]
    fn a_completed_turn_or_another_conversation_rereads_the_transcript() {
        let first = transcript_answer(&idle_agent(), &read_request(), |_, _| Ok(transcript()));
        let mut completed = runtime(
            "terminal-1",
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
        );
        completed.turn_completed_count = "4".into();
        let next_turn =
            ObservedAgent::from_host("terminal-1", Some(&reported("terminal-1")), Some(&completed));
        let cleared = ObservedAgent::from_host(
            "terminal-1",
            Some(&identity(
                "terminal-1",
                "conversation-2",
                ProviderConversationIdentitySource::ProviderEvent,
            )),
            Some(&runtime(
                "terminal-1",
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
            )),
        );
        for observed in [next_turn, cleared] {
            let again = TranscriptRequest {
                after: first.cursor.clone(),
                ..read_request()
            };
            let result = transcript_answer(&observed, &again, |_, _| Ok(transcript()));
            assert_eq!(result.outcome, TranscriptOutcome::Transcript);
        }
    }

    #[test]
    fn without_runtime_state_the_cursor_never_vouches_for_unchanged() {
        let observed = ObservedAgent::from_host("terminal-1", Some(&reported("terminal-1")), None);
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
                Some(&identity(
                    "terminal-1",
                    "conversation-1",
                    ProviderConversationIdentitySource::LaunchRequest,
                )),
                None,
            ),
        ] {
            let refused = prompt_target(&observed, "terminal-1", None).expect_err("refused");
            assert_eq!(refused.code, Some(ConversationRefusal::ConversationUnknown));
        }
    }

    #[test]
    fn a_host_refusal_on_the_same_conversation_is_named_from_the_state_now() {
        let working = agent(AgentRuntimeActivity::Working, AgentRuntimeAttention::None);
        let approving = agent(
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::ApprovalRequired,
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
            ("hmux_agent_prompt_refused", &working, ConversationRefusal::Unavailable),
            ("hmux_endpoint_unavailable", &working, ConversationRefusal::Unavailable),
        ];
        for (code, now, refusal) in cases {
            let result = prompt_failure(code, "not_written", "terminal-1", &expected(), now);
            assert_eq!(result.state, AgentPromptState::Refused, "{code}");
            assert_eq!(result.code, Some(refusal), "{code}");
            assert!(result.record_id.is_none());
        }
    }

    /// The conversation changed between the attach snapshot and the write:
    /// the agent is idle, just elsewhere. "Busy" would be the wrong answer.
    #[test]
    fn a_host_refusal_after_the_conversation_moved_is_an_identity_change() {
        let elsewhere = ObservedAgent::from_host(
            "terminal-1",
            Some(&identity(
                "terminal-1",
                "conversation-2",
                ProviderConversationIdentitySource::ProviderEvent,
            )),
            Some(&runtime(
                "terminal-1",
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
            )),
        );
        for code in ["hmux_agent_prompt_runtime_changed", "hmux_agent_prompt_refused"] {
            let result = prompt_failure(code, "not_written", "terminal-1", &expected(), &elsewhere);
            assert_eq!(result.code, Some(ConversationRefusal::IdentityChanged), "{code}");
        }
        // A replaced process is moved too, whatever its new conversation.
        let respawned = ObservedAgent::from_host(
            "terminal-2",
            Some(&reported("terminal-2")),
            None,
        );
        let result = prompt_failure(
            "hmux_agent_prompt_runtime_changed",
            "not_written",
            "terminal-1",
            &expected(),
            &respawned,
        );
        assert_eq!(result.code, Some(ConversationRefusal::IdentityChanged));
    }

    /// When writing may have started, the phone must not be told "refused":
    /// sending again could type the prompt twice.
    #[test]
    fn an_unconfirmed_write_is_unknown_not_refused() {
        let result = prompt_failure(
            "hmux_agent_prompt_failed",
            "unknown",
            "terminal-1",
            &expected(),
            &idle_agent(),
        );
        assert_eq!(result.state, AgentPromptState::Unknown);
        assert_eq!(result.code, None);
    }

    #[test]
    fn an_attach_failure_is_named_the_way_hmux_classifies_a_probe() {
        let transport = |code: &'static str| ClientError::Transport {
            code,
            message: "test".into(),
        };
        for (error, refusal) in [
            (
                transport("hmux_expected_generation_mismatch"),
                ConversationRefusal::IdentityChanged,
            ),
            (
                transport("hmux_agent_prompt_requires_managed"),
                ConversationRefusal::UnsupportedRuntime,
            ),
            (
                ClientError::MissingCapability {
                    capability: "agent_prompt",
                },
                ConversationRefusal::UnsupportedRuntime,
            ),
            (
                ClientError::SessionNotFound {
                    session_id: "session-1".into(),
                    workspace_id: Some("workspace-1".into()),
                },
                ConversationRefusal::SessionNotFound,
            ),
        ] {
            assert_eq!(attach_refusal(&error).code, Some(refusal), "{}", error.code());
        }
    }

    /// Only a deadline is worth asking again. A permanent failure reported as
    /// "ask again" would keep the phone retrying forever.
    #[test]
    fn only_a_deadline_is_a_probe_timeout() {
        let transport = |code: &'static str| ClientError::Transport {
            code,
            message: "test".into(),
        };
        for error in [
            transport("hmux_attach_deadline_exceeded"),
            transport("hmux_read_deadline_exceeded"),
            transport("hmux_managed_authorization_grant_timeout"),
            ClientError::Io {
                operation: "read",
                source: std::io::Error::from(std::io::ErrorKind::TimedOut),
            },
            ClientError::WriteNotStarted {
                message: "write deadline".into(),
            },
        ] {
            assert_eq!(
                attach_refusal(&error).code,
                Some(ConversationRefusal::ProbeTimeout),
                "{}",
                error.code()
            );
        }
        for error in [
            transport("hmux_authorization_denied"),
            transport("hmux_managed_attach_proof_invalid"),
            ClientError::Io {
                operation: "connect",
                source: std::io::Error::from(std::io::ErrorKind::ConnectionRefused),
            },
            transport("hmux_session_exited"),
        ] {
            let result = attach_refusal(&error);
            assert_eq!(result.code, Some(ConversationRefusal::Unavailable), "{}", error.code());
            assert!(
                result.detail.as_deref().is_some_and(|detail| detail.contains(error.code())),
                "{:?}",
                result.detail
            );
        }
    }

    /// The second inspection after a Host refusal is classified on its own:
    /// the attach snapshot never stands in for a Host that cannot be observed
    /// now, has exited or was replaced.
    #[test]
    fn a_second_look_that_finds_no_healthy_host_says_what_it_found() {
        // The snapshot would have read as idle on the expected conversation.
        let snapshot = idle_agent();
        for (health, refusal) in [
            (SessionHealth::Unprobed, ConversationRefusal::ProbeTimeout),
            (SessionHealth::StaleTransport, ConversationRefusal::ProbeTimeout),
            (SessionHealth::Exited, ConversationRefusal::Unavailable),
            (SessionHealth::GenerationChanged, ConversationRefusal::IdentityChanged),
            (SessionHealth::IncompatibleProtocol, ConversationRefusal::UnsupportedRuntime),
        ] {
            let result = refusal_after_second_look(
                "hmux_agent_prompt_runtime_changed",
                "terminal-1",
                &expected(),
                health,
                &snapshot,
            );
            assert_eq!(result.state, AgentPromptState::Refused, "{health:?}");
            assert_eq!(result.code, Some(refusal), "{health:?}");
        }
        // A healthy second look on another process is an identity change.
        let respawned = ObservedAgent::from_host("terminal-2", Some(&reported("terminal-2")), None);
        let result = refusal_after_second_look(
            "hmux_agent_prompt_runtime_changed",
            "terminal-1",
            &expected(),
            SessionHealth::Healthy,
            &respawned,
        );
        assert_eq!(result.code, Some(ConversationRefusal::IdentityChanged));
    }

    /// The hub sends what the shared normalization returns: a CRLF prompt
    /// from a phone's text field reaches the Host as line feeds only.
    #[test]
    fn a_prompt_reaches_the_desktop_normalized() {
        let sink = Recorder::default();
        let _ = answer_prompt(
            Some(&sink),
            BoxRoute::Local,
            PromptRequest {
                text: "first\r\nsecond\rthird".into(),
                ..prompt_request()
            },
        );
        assert_eq!(sink.prompts.lock().unwrap()[0].text, "first\nsecond\nthird");
    }
}
