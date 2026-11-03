//! A paired phone reads one agent session's conversation from this box.
//!
//! The phone's Chat for a session on this server, with no desktop in the
//! path: the desktop hub answers the same question for its own sessions
//! (`src-tauri/src/hub/conversation.rs`), and this answers it here in the same
//! `dure_hub_protocol::conversation` shape, so the phone draws both alike.
//!
//! # Who decides what
//!
//! - **Which session** is the exact fence the phone listed. A Host that was
//!   replaced since is a changed identity, never a neighbour's conversation.
//! - **Which conversation, and whether a turn moved** come from the Host,
//!   captured in one bounded inspection: the provider conversation identity
//!   and the agent runtime state of the current terminal epoch. The phone
//!   names a session, never a file or a conversation.
//! - **The transcript** is read with the reader the desktop uses
//!   (`dure-provider-transcript`), from the provider's default state root and
//!   Dure's account profiles under this user's home.
//! - **`unchanged`** is decided by [`ConversationCursor::same_turns_as`], the
//!   hub's own rule, and only while the Host reports runtime state; then the
//!   provider file is not read at all.
//!
//! The rules below that name a Host observation (`ObservedAgent`,
//! `transcript_answer`, `health_refusal`) are the desktop hub's, applied to
//! this box's Host. They answer refusals the chat already knows; this module
//! adds none.
//!
//! # Why no forced-command gate
//!
//! A read, like the listing and the source-control status: no fence is
//! claimed, nothing is written, and the key that sends it may already watch
//! the same agent's terminal.

use super::{GatewayRefusal, local_fence, validate_gateway_identifier};
use dure_hub_protocol::conversation::{
    ConversationCursor, ConversationEntry, ConversationRefusal, ConversationRole,
    HubConversationTranscriptResult, TranscriptParts,
};
use dure_provider_transcript::{
    ConversationTurnRole, ProviderConversationTranscript, ProviderStateRoots,
};
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeLifecycle, AgentRuntimeStateDescriptor, LocalSessionCatalog,
    ProviderConversationIdentityDescriptor, SessionClass, SessionHealth, SessionSelector,
};
use hmux_host::local_protocol::{ErrorCode, FrameLimits, RetryPosture};
use std::path::PathBuf;

pub(super) type ConversationTranscriptRequest =
    hmux_ssh_transport::conversation_transcript::ConversationTranscriptRequest<ConversationCursor>;

/// The providers whose transcript this box reads.
const CONVERSATION_PROVIDERS: [&str; 2] = ["claude", "codex"];

/// The Host-owned facts one answer is decided on, captured in one handshake.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedAgent {
    terminal_epoch: String,
    conversation: Option<ObservedConversation>,
    runtime: Option<ObservedRuntime>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedConversation {
    provider_id: String,
    conversation_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ObservedRuntime {
    revision: u64,
    turn_completed_count: u64,
    /// A turn is running: the agent works on a prompt. Background work after
    /// a turn ended is not a turn.
    turn_open: bool,
}

impl ObservedAgent {
    /// Keep only what the Host reported for this process: a projection from
    /// another terminal epoch describes a provider that is gone.
    fn from_host(
        terminal_epoch: &str,
        identity: Option<&ProviderConversationIdentityDescriptor>,
        runtime: Option<&AgentRuntimeStateDescriptor>,
    ) -> Self {
        let conversation = identity
            .filter(|identity| identity.terminal_epoch == terminal_epoch)
            .map(|identity| ObservedConversation {
                provider_id: identity.provider_id.clone(),
                conversation_id: identity.conversation_id.clone(),
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
            turn_completed_count: self
                .runtime
                .map_or(0, |runtime| runtime.turn_completed_count),
            turn_open: self.runtime.is_some_and(|runtime| runtime.turn_open),
            runtime_revision: self.runtime.map_or(0, |runtime| runtime.revision),
        }
    }
}

/// Answer from what the Host observed. `read` is the provider transcript
/// reader; it is not called while the turns are the same. The answer is
/// fitted to one gateway frame, which is smaller than the hub's.
fn transcript_answer(
    observed: &ObservedAgent,
    limit: Option<u32>,
    after: Option<&ConversationCursor>,
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
    // complete, so it never vouches for "unchanged".
    if observed.runtime.is_some() && after.is_some_and(|after| after.same_turns_as(&cursor)) {
        return HubConversationTranscriptResult::unchanged(
            conversation.provider_id.clone(),
            conversation.conversation_id.clone(),
            cursor,
        );
    }
    match read(&conversation.provider_id, &conversation.conversation_id) {
        Ok(transcript) => HubConversationTranscriptResult::transcript_within(
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
            limit,
            FrameLimits::default().max_frame_bytes,
        ),
        Err(detail) => HubConversationTranscriptResult::refused(
            ConversationRefusal::TranscriptUnavailable,
            format!("Could not read the provider transcript: {detail}"),
        ),
    }
}

/// Name an inspection that did not observe a healthy Host. Only an exited
/// session is not running; a probe that ran out of time says nothing about
/// the agent, so it is its own, retryable code.
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
        SessionHealth::Exited => Some((ConversationRefusal::Unavailable, "The session has exited")),
    }
}

fn refused(
    code: ConversationRefusal,
    detail: impl Into<String>,
) -> HubConversationTranscriptResult {
    HubConversationTranscriptResult::refused(code, detail)
}

/// Serve one conversation transcript request.
///
/// `Err` is the gateway's own typed refusal (an unusable or out-of-scope
/// request); everything about the session itself is an answer.
pub(super) fn conversation_transcript(
    catalog: &LocalSessionCatalog,
    request: &ConversationTranscriptRequest,
    pinned_session: Option<&str>,
    pinned_workspace: Option<&str>,
) -> Result<HubConversationTranscriptResult, (GatewayRefusal, RetryPosture)> {
    let expected = &request.expected_fence;
    for (label, value) in [
        ("session id", expected.session_id.as_str()),
        ("workspace id", expected.workspace_id.as_str()),
        ("runner principal", expected.runner_principal.as_str()),
        ("runner instance", expected.runner_instance.as_str()),
        ("host instance id", expected.host_instance_id.as_str()),
        ("terminal epoch", expected.terminal_epoch.as_str()),
    ] {
        if validate_gateway_identifier(label, value, 256).is_err() {
            return Err((
                GatewayRefusal::new(
                    ErrorCode::IdentityMismatch,
                    format!("the conversation transcript {label} is invalid"),
                ),
                RetryPosture::Never,
            ));
        }
    }
    if pinned_session.is_some_and(|pinned| pinned != expected.session_id)
        || pinned_workspace.is_some_and(|pinned| pinned != expected.workspace_id)
    {
        return Err((
            GatewayRefusal::new(
                ErrorCode::AuthorizationDenied,
                "the conversation transcript request is outside this gateway's pinned scope",
            ),
            RetryPosture::Never,
        ));
    }
    let descriptor = match catalog.find(&SessionSelector::new(
        &expected.session_id,
        Some(expected.workspace_id.clone()),
    )) {
        Ok(descriptor) => descriptor,
        Err(error) if error.is_session_absent() => {
            return Ok(refused(
                ConversationRefusal::SessionNotFound,
                "This server serves no such session",
            ));
        }
        Err(error) => {
            return Ok(refused(
                ConversationRefusal::Unavailable,
                format!("Could not find the session ({})", error.code()),
            ));
        }
    };
    let Ok(local) = local_fence(&descriptor) else {
        return Ok(refused(
            ConversationRefusal::Unavailable,
            "The session reported an unreadable generation",
        ));
    };
    if expected.ensure_matches(&local).is_err() {
        return Ok(refused(
            ConversationRefusal::IdentityChanged,
            "The agent's process changed. Read the conversation again",
        ));
    }
    if descriptor.session_class != SessionClass::Managed
        || !CONVERSATION_PROVIDERS.contains(&descriptor.provider_id.as_str())
    {
        return Ok(refused(
            ConversationRefusal::UnsupportedRuntime,
            "This session is not a Claude Code or Codex agent",
        ));
    }
    // The one bounded handshake that tells whether a turn moved. When nothing
    // did, it is the whole cost of the answer.
    let inspection = hmux_client::inspect_local_session(catalog, descriptor);
    if let Some((code, detail)) = health_refusal(inspection.health) {
        return Ok(refused(code, detail));
    }
    let observed = ObservedAgent::from_host(
        &inspection.descriptor.terminal_epoch,
        inspection.provider_conversation_identity.as_deref(),
        inspection.agent_runtime_state.as_ref(),
    );
    Ok(transcript_answer(
        &observed,
        request.limit,
        request.after.as_ref(),
        read_this_users_transcript,
    ))
}

/// The transcript as this user's providers keep it: the default state roots
/// (honouring `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the providers do) and
/// the provider's Dure account profiles, owned by this effective user.
fn read_this_users_transcript(
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "this server's account has no home directory".to_string())?;
    let roots = ProviderStateRoots::resolve(
        &home,
        std::env::var_os("CLAUDE_CONFIG_DIR"),
        std::env::var_os("CODEX_HOME"),
    );
    let profiles =
        dure_provider_transcript::account_profile_directories(&home, provider, owned_by_this_user);
    dure_provider_transcript::read_newest(&roots, &profiles, provider, conversation_id)
}

#[cfg(unix)]
fn owned_by_this_user(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid takes no arguments and only reads process identity.
    metadata.uid() == unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn owned_by_this_user(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::conversation::{MAX_ENTRY_TEXT_BYTES, TranscriptOutcome};
    use dure_provider_transcript::{ConversationTurnRole, ProviderTranscriptEntry};
    use hmux_client::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
        AgentRuntimeStateSource, ProviderConversationIdentitySource,
    };

    fn identity(terminal_epoch: &str) -> ProviderConversationIdentityDescriptor {
        ProviderConversationIdentityDescriptor {
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            runner_principal: "server-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: terminal_epoch.into(),
            revision: "1".into(),
            observed_through_output_seq: "10".into(),
            provider_id: "claude".into(),
            conversation_id: "conversation-1".into(),
            source: ProviderConversationIdentitySource::ProviderEvent,
        }
    }

    fn runtime(
        terminal_epoch: &str,
        activity: AgentRuntimeActivity,
        turns: u64,
    ) -> AgentRuntimeStateDescriptor {
        AgentRuntimeStateDescriptor {
            progress: None,
            terminal_epoch: terminal_epoch.into(),
            revision: "12".into(),
            observed_through_output_seq: "10".into(),
            lifecycle: AgentRuntimeLifecycle::Running,
            activity,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: turns.to_string(),
            program_status: None,
            background_work: false,
        }
    }

    fn observed(turns: u64) -> ObservedAgent {
        ObservedAgent::from_host(
            "terminal-1",
            Some(&identity("terminal-1")),
            Some(&runtime("terminal-1", AgentRuntimeActivity::Waiting, turns)),
        )
    }

    fn transcript(texts: &[&str]) -> ProviderConversationTranscript {
        ProviderConversationTranscript {
            schema_version: 1,
            provider: "claude".into(),
            conversation_id: "conversation-1".into(),
            history_complete: true,
            final_response: texts.last().map(|text| (*text).to_string()),
            entries: texts
                .iter()
                .map(|text| ProviderTranscriptEntry {
                    role: ConversationTurnRole::Agent,
                    text: (*text).to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn the_answer_carries_the_hosts_conversation_and_a_cursor_of_its_facts() {
        let mut asked = None;
        let answer = transcript_answer(&observed(3), Some(50), None, |provider, id| {
            asked = Some((provider.to_string(), id.to_string()));
            Ok(transcript(&["Done."]))
        });
        assert_eq!(asked, Some(("claude".into(), "conversation-1".into())));
        assert_eq!(answer.outcome, TranscriptOutcome::Transcript);
        assert_eq!(answer.entries[0].text, "Done.");
        assert_eq!(answer.final_response.as_deref(), Some("Done."));
        assert!(answer.history_complete);
        assert_eq!(
            answer.cursor,
            Some(ConversationCursor {
                terminal_epoch: "terminal-1".into(),
                conversation_id: "conversation-1".into(),
                turn_completed_count: 3,
                turn_open: false,
                runtime_revision: 12,
            })
        );
    }

    #[test]
    fn the_same_turns_answer_unchanged_without_reading_the_provider_file() {
        let first = transcript_answer(&observed(3), None, None, |_, _| Ok(transcript(&["a"])));
        let cursor = first.cursor.unwrap();
        let mut moved = cursor.clone();
        moved.runtime_revision += 5;
        let answer = transcript_answer(&observed(3), None, Some(&moved), |_, _| {
            panic!("an unchanged conversation must not be read")
        });
        assert_eq!(answer.outcome, TranscriptOutcome::Unchanged);
        assert!(answer.entries.is_empty());
        assert_eq!(answer.cursor.as_ref(), Some(&cursor));

        // A completed turn reads again.
        let answer = transcript_answer(&observed(4), None, Some(&cursor), |_, _| {
            Ok(transcript(&["b"]))
        });
        assert_eq!(answer.outcome, TranscriptOutcome::Transcript);
    }

    #[test]
    fn without_the_hosts_runtime_state_the_cursor_never_vouches_for_unchanged() {
        let observed = ObservedAgent::from_host("terminal-1", Some(&identity("terminal-1")), None);
        let cursor = ConversationCursor {
            terminal_epoch: "terminal-1".into(),
            conversation_id: "conversation-1".into(),
            turn_completed_count: 0,
            turn_open: false,
            runtime_revision: 0,
        };
        let answer = transcript_answer(&observed, None, Some(&cursor), |_, _| {
            Ok(transcript(&["read again"]))
        });
        assert_eq!(answer.outcome, TranscriptOutcome::Transcript);
    }

    #[test]
    fn a_turn_running_is_open_and_background_work_after_it_is_not() {
        let working = ObservedAgent::from_host(
            "terminal-1",
            Some(&identity("terminal-1")),
            Some(&runtime("terminal-1", AgentRuntimeActivity::Working, 3)),
        );
        let answer = transcript_answer(&working, None, None, |_, _| Ok(transcript(&["a"])));
        assert!(answer.cursor.unwrap().turn_open);

        let mut background = runtime("terminal-1", AgentRuntimeActivity::Working, 3);
        background.background_work = true;
        let after_turn = ObservedAgent::from_host(
            "terminal-1",
            Some(&identity("terminal-1")),
            Some(&background),
        );
        let answer = transcript_answer(&after_turn, None, None, |_, _| Ok(transcript(&["a"])));
        assert!(!answer.cursor.unwrap().turn_open);
    }

    #[test]
    fn facts_from_another_process_are_not_this_agents() {
        let stale = ObservedAgent::from_host(
            "terminal-2",
            Some(&identity("terminal-1")),
            Some(&runtime("terminal-1", AgentRuntimeActivity::Waiting, 3)),
        );
        let answer = transcript_answer(&stale, None, None, |_, _| {
            panic!("no conversation is known for this process")
        });
        assert_eq!(answer.outcome, TranscriptOutcome::Refused);
        assert_eq!(answer.code, Some(ConversationRefusal::ConversationUnknown));
    }

    #[test]
    fn an_unreadable_transcript_is_named() {
        let answer = transcript_answer(&observed(3), None, None, |_, _| {
            Err("provider conversation was not found".into())
        });
        assert_eq!(
            answer.code,
            Some(ConversationRefusal::TranscriptUnavailable)
        );
        assert!(answer.detail.unwrap().contains("not found"));
    }

    #[test]
    fn the_answer_fits_the_gateways_frame() {
        let long = "\"".repeat(MAX_ENTRY_TEXT_BYTES);
        let texts: Vec<&str> = (0..100).map(|_| long.as_str()).collect();
        let answer = transcript_answer(&observed(3), None, None, |_, _| Ok(transcript(&texts)));
        let mut written = Vec::new();
        super::super::write_gateway_document(&mut written, &answer, "conversation transcript")
            .expect("one gateway frame");
        assert!(!answer.entries.is_empty());
        assert!(!answer.history_complete);
    }

    #[test]
    fn only_a_healthy_host_is_read_and_a_slow_one_is_worth_asking_again() {
        assert_eq!(health_refusal(SessionHealth::Healthy), None);
        assert_eq!(
            health_refusal(SessionHealth::Unprobed).map(|(code, _)| code),
            Some(ConversationRefusal::ProbeTimeout)
        );
        assert_eq!(
            health_refusal(SessionHealth::GenerationChanged).map(|(code, _)| code),
            Some(ConversationRefusal::IdentityChanged)
        );
        assert_eq!(
            health_refusal(SessionHealth::Exited).map(|(code, _)| code),
            Some(ConversationRefusal::Unavailable)
        );
    }
}
