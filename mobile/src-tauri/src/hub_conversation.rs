//! The observer chat's two questions to the paired computer (#361).
//!
//! `ConversationTranscriptV1` reads the newest messages of one local agent
//! session; `AgentPromptV1` types one prompt into it while it waits for input;
//! `AgentApprovalAnswerV1` answers the approval it waits on.
//! Both ride a fresh TLS connection over the paired relay, the way the account
//! sheet's questions do: the greeting carries the request, the ack comes back,
//! then one answer document (`dure_hub_protocol::conversation`).
//!
//! # A transcript that never comes
//!
//! A desktop that predates these requests reads them as `Unsupported`, acks
//! and closes without another byte — but so does a relay that drops, a desktop
//! that restarts, or one that fails to encode its answer. Chat is only offered
//! when the catalog says the computer serves it, which an older desktop never
//! does, so a silent close is reported as [`NO_ANSWER`] and the screen treats
//! it as one more failed ask; only a run of them suggests updating.
//!
//! # A prompt whose answer is lost
//!
//! Once the greeting with the prompt is fully written, the desktop may write
//! the prompt even if nothing at all comes back: it acknowledges and then acts,
//! and the ack can be lost after it was sent. From that point every failure is
//! the protocol's own `unknown` ("read the transcript before sending this
//! again"), never an error. An error from [`hub_agent_prompt`] therefore always
//! means nothing was written.

use crate::hub_client::{self, HubClientError};
use crate::CommandError;
use dure_hub_protocol::agent_chat::{
    self, AgentChatAnswer, AgentChatRefusal, HubAgentChatActionResult, HubAgentChatTimelineResult,
};
use dure_hub_protocol::background_work::{self, HubAgentBackgroundWorkResult};
use dure_hub_protocol::conversation::{
    self, ConversationCursor, ConversationError, ConversationRefusal, HubAgentPromptResult,
    HubConversationTranscriptResult,
};
use dure_hub_protocol::frame::FrameError;
use dure_hub_protocol::hello::{self, HubRequest};
use serde::Deserialize;
use std::io::{Read, Write};

/// The computer took a transcript request and closed without answering. An
/// older Dure does this, and so does a dropped relay or a restarting desktop.
pub const NO_ANSWER: &str = "conversation_no_answer";

/// The computer answered in a conversation version this build cannot read.
pub const VERSION_UNSUPPORTED: &str = "conversation_version_unsupported";

/// The computer answered a chat-owned agent's request in an older chat
/// version than this phone speaks: update Dure on the computer.
pub const DESKTOP_OUTDATED: &str = "agent_chat_desktop_outdated";

/// Counts what a reader handed out, so "closed before saying anything" is told
/// apart from "broke off in the middle of an answer".
///
/// The byte count is the evidence, not the error kind: a desktop that drops
/// its TLS stream sends no `close_notify`, so rustls reports the silent close
/// as an unexpected end of file, which the frame reader names `Truncated` just
/// as it names a connection lost half-way through a frame.
struct Counted<'a, R> {
    inner: &'a mut R,
    read: usize,
}

impl<R: Read> Read for Counted<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.read += read;
        Ok(read)
    }
}

/// Nothing came back: the stream ended before the first byte.
fn closed_silently(error: &FrameError, read: usize) -> bool {
    read == 0 && matches!(error, FrameError::Closed | FrameError::Truncated(_))
}

fn command_error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.to_string(),
        message: message.into(),
    }
}

pub(crate) fn client_error(error: &HubClientError) -> CommandError {
    command_error(error.code(), error.to_string())
}

fn no_answer() -> CommandError {
    command_error(
        NO_ANSWER,
        "The computer closed the connection without answering",
    )
}

fn lost(error: impl std::fmt::Display) -> String {
    format!("The computer's answer was lost: {error}")
}

fn answer_error(error: &ConversationError) -> CommandError {
    match error {
        ConversationError::UnsupportedVersion { .. } => {
            command_error(VERSION_UNSUPPORTED, error.to_string())
        }
        ConversationError::Frame(FrameError::TimedOut) => client_error(
            &HubClientError::Unreachable("The computer did not answer in time".to_string()),
        ),
        ConversationError::Frame(_) => command_error("hub_protocol", error.to_string()),
    }
}

/// One question on an open stream, read by `read`. A close before the first
/// byte of the answer is [`NO_ANSWER`]; any other failure is `error`'s.
fn ask_on_stream<'s, S: Read + Write, T>(
    stream: &'s mut S,
    token: &str,
    request: HubRequest,
    read: impl FnOnce(&mut Counted<'s, S>) -> Result<T, ConversationError>,
    error: impl FnOnce(&ConversationError) -> CommandError,
) -> Result<T, CommandError> {
    hub_client::handshake_for(stream, token, request).map_err(|error| client_error(&error))?;
    let mut counted = Counted {
        inner: stream,
        read: 0,
    };
    match read(&mut counted) {
        Ok(result) => Ok(result),
        Err(ConversationError::Frame(frame)) if closed_silently(&frame, counted.read) => {
            Err(no_answer())
        }
        Err(failure) => Err(error(&failure)),
    }
}

/// One write on an open stream, read by `read`.
///
/// `Err` only while the greeting is not yet fully written: the desktop cannot
/// act on part of a frame. Once it is, every failure — no ack, a lost ack, a
/// silent close, a broken answer — is `Ok(unknown(..))`, because the desktop
/// acks before it acts and the write may already have happened.
fn write_on_stream<S: Read + Write, T>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
    read: impl FnOnce(&mut S) -> Result<T, ConversationError>,
    unknown: impl FnOnce(String) -> T,
) -> Result<T, CommandError> {
    let framed = hello::encode_hello_for(token, request)
        .map_err(|error| command_error("hub_protocol", error.to_string()))?;
    stream
        .write_all(&framed)
        .and_then(|()| stream.flush())
        .map_err(|error| client_error(&HubClientError::Unreachable(error.to_string())))?;
    if let Err(error) = hello::read_ack(stream) {
        return Ok(unknown(lost(error)));
    }
    Ok(read(stream).unwrap_or_else(|error| unknown(lost(error))))
}

/// One transcript question on an open stream.
pub(crate) fn transcript_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubConversationTranscriptResult, CommandError> {
    ask_on_stream(
        stream,
        token,
        request,
        conversation::read_transcript,
        answer_error,
    )
}

/// One background-work question on an open stream.
fn background_work_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubAgentBackgroundWorkResult, CommandError> {
    ask_on_stream(
        stream,
        token,
        request,
        background_work::read_background_work,
        answer_error,
    )
}

/// One prompt on an open stream. See [`write_on_stream`] for why only an
/// unwritten greeting is an error.
fn prompt_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubAgentPromptResult, CommandError> {
    write_on_stream(
        stream,
        token,
        request,
        conversation::read_prompt,
        HubAgentPromptResult::unknown,
    )
}

/// The pinned TLS stream [`hub_client::dial_tls`] opens.
pub(crate) type HubStream = rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>;

/// Dial the computer behind `id` on a blocking thread and hand `run` the
/// stream, with the device token to greet it with.
pub(crate) async fn with_stream<T: Send + 'static>(
    app: &tauri::AppHandle,
    id: &str,
    run: impl FnOnce(HubStream, &str) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let entry = crate::hub_target(app, id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let relay = entry
            .relay_endpoint
            .as_deref()
            .zip(entry.server_id.as_deref());
        let stream = hub_client::dial_tls(&entry.endpoint, relay, &entry.fingerprint)
            .map_err(|error| client_error(&error))?;
        run(stream, &entry.token)
    })
    .await
    .map_err(|error| command_error("hub_join", error.to_string()))?
}

/// Dial the computer behind `id` and run one exchange on the stream.
async fn exchange<T: Send + 'static>(
    app: &tauri::AppHandle,
    id: &str,
    run: impl FnOnce(&mut HubStream, &str) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    with_stream(app, id, move |mut stream, token| run(&mut stream, token)).await
}

/// Which session, as the catalog entry names it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptInput {
    box_id: String,
    workspace_id: String,
    session_id: String,
    #[serde(default)]
    limit: Option<u32>,
    /// The cursor of the previous answer, echoed so an unchanged conversation
    /// is answered without the desktop reading its transcript.
    #[serde(default)]
    after: Option<ConversationCursor>,
}

/// The chat opened, refreshed, or noticed a turn end.
#[tauri::command]
pub async fn hub_conversation_transcript(
    app: tauri::AppHandle,
    id: String,
    input: TranscriptInput,
) -> Result<HubConversationTranscriptResult, CommandError> {
    let request = HubRequest::ConversationTranscriptV1 {
        box_id: input.box_id,
        workspace_id: input.workspace_id,
        session_id: input.session_id,
        limit: input.limit,
        after: input.after,
    };
    exchange(&app, &id, move |stream, token| {
        transcript_on_stream(stream, token, request)
    })
    .await
}

/// Which session, as the catalog entry names it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundWorkInput {
    box_id: String,
    workspace_id: String,
    session_id: String,
}

/// The chat is open on an agent whose catalog entry carries `background_work`.
#[tauri::command]
pub async fn hub_agent_background_work(
    app: tauri::AppHandle,
    id: String,
    input: BackgroundWorkInput,
) -> Result<HubAgentBackgroundWorkResult, CommandError> {
    let request = HubRequest::AgentBackgroundWorkV1 {
        box_id: input.box_id,
        workspace_id: input.workspace_id,
        session_id: input.session_id,
    };
    exchange(&app, &id, move |stream, token| {
        background_work_on_stream(stream, token, request)
    })
    .await
}

/// One prompt for an agent, with the process and conversation it is meant for.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptInput {
    pub(crate) box_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) expected_terminal_epoch: String,
    #[serde(default)]
    pub(crate) expected_conversation_id: Option<String>,
}

/// Normalized here as the desktop will normalize it, so a prompt it would
/// refuse for its shape never leaves the phone.
fn prompt_request(input: PromptInput) -> Result<HubRequest, HubAgentPromptResult> {
    let text = conversation::normalize_agent_prompt(&input.text).map_err(|error| {
        HubAgentPromptResult::refused(ConversationRefusal::InvalidRequest, error.to_string())
    })?;
    Ok(HubRequest::AgentPromptV1 {
        box_id: input.box_id,
        workspace_id: input.workspace_id,
        session_id: input.session_id,
        text,
        expected_terminal_epoch: input.expected_terminal_epoch,
        expected_conversation_id: input.expected_conversation_id,
    })
}

/// Deliver one prompt. A refusal is an answer, not an error; an error means
/// nothing was written. Of the errors, only `hub_unreachable` and
/// `hub_computer_offline` say the computer may answer a retry: both come from
/// dialing or from writing the greeting, before anything could be acted on.
#[tauri::command]
pub async fn hub_agent_prompt(
    app: tauri::AppHandle,
    id: String,
    input: PromptInput,
) -> Result<HubAgentPromptResult, CommandError> {
    send_prompt(&app, &id, input).await
}

/// The one way this phone sends a prompt to an agent on a paired computer:
/// the chat's composer through the command above, and a reply from a
/// finished turn's alert (`push::reply_from_alert`).
pub(crate) async fn send_prompt(
    app: &tauri::AppHandle,
    id: &str,
    input: PromptInput,
) -> Result<HubAgentPromptResult, CommandError> {
    let request = match prompt_request(input) {
        Ok(request) => request,
        Err(refused) => return Ok(refused),
    };
    exchange(app, id, move |stream, token| {
        prompt_on_stream(stream, token, request)
    })
    .await
}

/// One chat-owned agent's timeline on an open stream (#562). A silent close
/// is [`NO_ANSWER`], as for the transcript: the phone asks only about agents
/// the catalog listed, which an older desktop never does. An answer in an
/// older chat version names the computer as the side to update.
fn agent_chat_timeline_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubAgentChatTimelineResult, CommandError> {
    ask_on_stream(
        stream,
        token,
        request,
        agent_chat::read_timeline,
        |error| match error {
            ConversationError::UnsupportedVersion { found }
                if *found < agent_chat::HUB_AGENT_CHAT_VERSION =>
            {
                command_error(
                    DESKTOP_OUTDATED,
                    format!(
                        "The computer speaks chat version {found}. Update Dure on the computer"
                    ),
                )
            }
            other => answer_error(other),
        },
    )
}

/// One chat action on an open stream, with the prompt's rule
/// ([`write_on_stream`]).
fn agent_chat_action_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubAgentChatActionResult, CommandError> {
    write_on_stream(
        stream,
        token,
        request,
        agent_chat::read_action,
        HubAgentChatActionResult::unknown,
    )
}

/// Which chat-owned agent, as the catalog's `chat_sessions` entry names it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatTarget {
    pub(crate) box_id: String,
    pub(crate) agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatTimelineInput {
    #[serde(flatten)]
    target: AgentChatTarget,
    #[serde(default)]
    before: Option<u64>,
    #[serde(default)]
    limit: Option<u32>,
}

/// The chat of a chat-owned agent opened, refreshed, or paged back.
#[tauri::command]
pub async fn hub_agent_chat_timeline(
    app: tauri::AppHandle,
    id: String,
    input: AgentChatTimelineInput,
) -> Result<HubAgentChatTimelineResult, CommandError> {
    let request = HubRequest::AgentChatTimelineV1 {
        box_id: input.target.box_id,
        agent_id: input.target.agent_id,
        before: input.before,
        limit: input.limit,
    };
    exchange(&app, &id, move |stream, token| {
        agent_chat_timeline_on_stream(stream, token, request)
    })
    .await
}

/// One action on a chat-owned agent. `actionId` names the press, so a retry
/// after a lost answer finds what the first attempt did.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentChatActionInput {
    Send {
        #[serde(flatten)]
        target: AgentChatTarget,
        action_id: String,
        text: String,
    },
    Interrupt {
        #[serde(flatten)]
        target: AgentChatTarget,
        action_id: String,
        turn_id: String,
    },
    Answer {
        #[serde(flatten)]
        target: AgentChatTarget,
        action_id: String,
        request_id: String,
        answer: AgentChatAnswer,
    },
}

/// The request for an action, normalized as the desktop will normalize it.
fn agent_chat_action_request(
    input: AgentChatActionInput,
) -> Result<HubRequest, HubAgentChatActionResult> {
    let refused = |detail: String| {
        HubAgentChatActionResult::refused(AgentChatRefusal::InvalidRequest, detail)
    };
    let valid = |action_id: &str| {
        agent_chat::valid_action_id(action_id)
            .then_some(())
            .ok_or_else(|| refused("The press has no valid name".to_string()))
    };
    Ok(match input {
        AgentChatActionInput::Send {
            target,
            action_id,
            text,
        } => {
            valid(&action_id)?;
            let text = conversation::normalize_agent_prompt(&text)
                .map_err(|error| refused(error.to_string()))?;
            HubRequest::AgentChatSendV1 {
                box_id: target.box_id,
                agent_id: target.agent_id,
                action_id,
                text,
            }
        }
        AgentChatActionInput::Interrupt {
            target,
            action_id,
            turn_id,
        } => {
            valid(&action_id)?;
            HubRequest::AgentChatInterruptV1 {
                box_id: target.box_id,
                agent_id: target.agent_id,
                action_id,
                turn_id,
            }
        }
        AgentChatActionInput::Answer {
            target,
            action_id,
            request_id,
            answer,
        } => {
            valid(&action_id)?;
            HubRequest::AgentChatAnswerV1 {
                box_id: target.box_id,
                agent_id: target.agent_id,
                action_id,
                request_id,
                answer,
            }
        }
    })
}

/// Send, interrupt or answer. A refusal or `unknown` is an answer; an error
/// means nothing reached the computer.
#[tauri::command]
pub async fn hub_agent_chat_action(
    app: tauri::AppHandle,
    id: String,
    input: AgentChatActionInput,
) -> Result<HubAgentChatActionResult, CommandError> {
    let request = match agent_chat_action_request(input) {
        Ok(request) => request,
        Err(refused) => return Ok(refused),
    };
    exchange(&app, &id, move |stream, token| {
        agent_chat_action_on_stream(stream, token, request)
    })
    .await
}

/// One answer to the agent's pending approval, as its chat card shows it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAnswerInput {
    pub(crate) box_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) expected_terminal_epoch: String,
    pub(crate) attention_id: String,
    pub(crate) choice: String,
}

fn approval_answer_request(input: ApprovalAnswerInput) -> HubRequest {
    HubRequest::AgentApprovalAnswerV1 {
        box_id: input.box_id,
        workspace_id: input.workspace_id,
        session_id: input.session_id,
        expected_terminal_epoch: input.expected_terminal_epoch,
        attention_id: input.attention_id,
        choice: input.choice,
    }
}

/// Deliver one approval answer. Like a prompt: a refusal is an answer, an
/// error means nothing was written, and once the greeting is written a lost
/// answer is `unknown` ("look at the terminal before answering again").
#[tauri::command]
pub async fn hub_agent_approval_answer(
    app: tauri::AppHandle,
    id: String,
    input: ApprovalAnswerInput,
) -> Result<HubAgentPromptResult, CommandError> {
    answer_approval(&app, &id, input).await
}

/// The one way this phone answers an approval on a paired computer: the
/// screen's cards through the command above, and an alert's Allow once and
/// Deny (`push::answer_from_alert`).
pub(crate) async fn answer_approval(
    app: &tauri::AppHandle,
    id: &str,
    input: ApprovalAnswerInput,
) -> Result<HubAgentPromptResult, CommandError> {
    let request = approval_answer_request(input);
    exchange(app, id, move |stream, token| {
        prompt_on_stream(stream, token, request)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::conversation::{
        AgentPromptState, ConversationEntry, ConversationRole, TranscriptOutcome, TranscriptParts,
    };
    use std::io::Cursor;

    /// What the desktop says, then what the stream does after it runs out.
    struct Duplex {
        incoming: Cursor<Vec<u8>>,
        end: End,
        written: Vec<u8>,
    }

    #[derive(Clone, Copy)]
    enum End {
        /// A clean end of stream, as `close_notify` reads.
        Closed,
        /// The end rustls reports when the peer drops without `close_notify`.
        Dropped,
        /// The socket's read timeout.
        TimedOut,
    }

    impl Duplex {
        fn new(incoming: Vec<u8>, end: End) -> Self {
            Self {
                incoming: Cursor::new(incoming),
                end,
                written: Vec::new(),
            }
        }
    }

    impl Read for Duplex {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.incoming.read(buffer)?;
            if read > 0 || buffer.is_empty() {
                return Ok(read);
            }
            match self.end {
                End::Closed => Ok(0),
                End::Dropped => Err(std::io::ErrorKind::UnexpectedEof.into()),
                End::TimedOut => Err(std::io::ErrorKind::TimedOut.into()),
            }
        }
    }

    impl Write for Duplex {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(buffer);
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn ack() -> Vec<u8> {
        hello::encode_ack("device-1", "phone").expect("ack encodes")
    }

    fn cursor() -> ConversationCursor {
        ConversationCursor {
            terminal_epoch: "terminal-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            turn_completed_count: 2,
            turn_open: false,
            runtime_revision: 7,
        }
    }

    fn transcript_request() -> HubRequest {
        HubRequest::ConversationTranscriptV1 {
            box_id: "box-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            session_id: "session-1".to_string(),
            limit: None,
            after: Some(cursor()),
        }
    }

    fn prompt_input(text: &str) -> PromptInput {
        PromptInput {
            box_id: "box-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            session_id: "session-1".to_string(),
            text: text.to_string(),
            expected_terminal_epoch: "terminal-1".to_string(),
            expected_conversation_id: Some("conversation-1".to_string()),
        }
    }

    fn prompt_request_for(text: &str) -> HubRequest {
        prompt_request(prompt_input(text)).expect("a usable prompt")
    }

    fn background_request() -> HubRequest {
        HubRequest::AgentBackgroundWorkV1 {
            box_id: "box-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            session_id: "session-1".to_string(),
        }
    }

    #[test]
    fn a_background_work_answer_is_read_after_the_ack() {
        let answer = dure_hub_protocol::background_work::HubAgentBackgroundWorkResult::listed(
            Vec::new(),
            dure_hub_protocol::background_work::HubBackgroundWorkCounts {
                shells: 1,
                ..Default::default()
            },
            false,
        );
        let mut incoming = ack();
        incoming.extend(
            dure_hub_protocol::background_work::encode_background_work(&answer).expect("encodes"),
        );
        let mut stream = Duplex::new(incoming, End::Dropped);

        let read = background_work_on_stream(&mut stream, "token-1", background_request())
            .expect("an answer");

        assert_eq!(read, answer);
        let sent = hello::read_hello(&mut stream.written.as_slice()).expect("a greeting");
        assert_eq!(sent.request, background_request());
    }

    /// The flag in the catalog keeps a phone from asking an older desktop, so
    /// a silent close is one failed ask, as for the transcript.
    #[test]
    fn background_work_closed_after_the_ack_reads_as_no_answer() {
        for end in [End::Closed, End::Dropped] {
            let mut stream = Duplex::new(ack(), end);
            let error = background_work_on_stream(&mut stream, "token-1", background_request())
                .expect_err("no answer");
            assert_eq!(error.code, NO_ANSWER);
        }
    }

    #[test]
    fn a_transcript_answer_is_read_after_the_ack() {
        let answer = HubConversationTranscriptResult::transcript(
            TranscriptParts {
                provider: "claude".to_string(),
                conversation_id: "conversation-1".to_string(),
                entries: vec![ConversationEntry {
                    role: ConversationRole::User,
                    text: "Run the tests".to_string(),
                    truncated: false,
                }],
                final_response: None,
                history_complete: true,
                cursor: cursor(),
            },
            None,
        );
        let mut incoming = ack();
        incoming.extend(conversation::encode_transcript(&answer).expect("encodes"));
        let mut stream = Duplex::new(incoming, End::Dropped);

        let read =
            transcript_on_stream(&mut stream, "token-1", transcript_request()).expect("an answer");

        assert_eq!(read, answer);
        assert_eq!(read.outcome, TranscriptOutcome::Transcript);
        let sent = hello::read_hello(&mut stream.written.as_slice()).expect("a greeting");
        assert_eq!(sent.request, transcript_request());
    }

    /// A silent close after the ack — an older desktop, a dropped relay, a
    /// restart — is named for what was seen, not for a guessed cause. Through
    /// rustls it is an unexpected end, not a clean one; both read the same.
    #[test]
    fn a_transcript_closed_after_the_ack_reads_as_no_answer() {
        for end in [End::Closed, End::Dropped] {
            let mut stream = Duplex::new(ack(), end);
            let error = transcript_on_stream(&mut stream, "token-1", transcript_request())
                .expect_err("no answer");
            assert_eq!(error.code, NO_ANSWER);
        }
    }

    /// Half an answer is a broken connection, not a silent close.
    #[test]
    fn a_transcript_cut_mid_answer_is_not_no_answer() {
        let answer = HubConversationTranscriptResult::refused(
            ConversationRefusal::ConversationUnknown,
            "not yet",
        );
        let mut incoming = ack();
        let frame = conversation::encode_transcript(&answer).expect("encodes");
        incoming.extend(&frame[..frame.len() / 2]);
        let mut stream = Duplex::new(incoming, End::Dropped);

        let error =
            transcript_on_stream(&mut stream, "token-1", transcript_request()).expect_err("cut");
        assert_eq!(error.code, "hub_protocol");
    }

    #[test]
    fn a_silent_transcript_is_unreachable() {
        let mut stream = Duplex::new(ack(), End::TimedOut);
        let error = transcript_on_stream(&mut stream, "token-1", transcript_request())
            .expect_err("timed out");
        assert_eq!(error.code, "hub_unreachable");
    }

    #[test]
    fn a_prompt_answer_is_passed_through() {
        for answer in [
            HubAgentPromptResult::written("terminal-1", "record-1"),
            HubAgentPromptResult::refused(ConversationRefusal::NotIdle, "working"),
        ] {
            let mut incoming = ack();
            incoming.extend(conversation::encode_prompt(&answer).expect("encodes"));
            let mut stream = Duplex::new(incoming, End::Dropped);
            let read = prompt_on_stream(&mut stream, "token-1", prompt_request_for("hello"))
                .expect("an answer");
            assert_eq!(read, answer);
        }
    }

    /// The desktop acks and then acts, and an ack can be lost after it was
    /// sent. Once the greeting is out, nothing that comes back — or does not —
    /// proves the prompt was not written.
    #[test]
    fn every_failure_after_the_greeting_is_unknown_never_an_error() {
        let written =
            conversation::encode_prompt(&HubAgentPromptResult::written("terminal-1", "record-1"))
                .expect("encodes");
        let mut cut_answer = ack();
        cut_answer.extend(&written[..written.len() - 3]);
        let half_ack = ack()[..3].to_vec();
        let cases: [(&str, Vec<u8>, End); 9] = [
            ("closed before the ack", Vec::new(), End::Closed),
            ("dropped before the ack", Vec::new(), End::Dropped),
            ("silent before the ack", Vec::new(), End::TimedOut),
            ("cut inside the ack", half_ack, End::Dropped),
            ("closed after the ack", ack(), End::Closed),
            ("dropped after the ack", ack(), End::Dropped),
            ("silent after the ack", ack(), End::TimedOut),
            ("cut inside the answer", cut_answer, End::Dropped),
            (
                "garbage for an answer",
                {
                    let mut garbage = ack();
                    garbage.extend([0, 0, 0, 2, b'{', b'}']);
                    garbage
                },
                End::Dropped,
            ),
        ];
        for (case, incoming, end) in cases {
            let mut stream = Duplex::new(incoming, end);
            let read = prompt_on_stream(&mut stream, "token-1", prompt_request_for("hello"))
                .unwrap_or_else(|error| panic!("{case}: an error ({})", error.code));
            assert_eq!(read.state, AgentPromptState::Unknown, "{case}");
        }
    }

    /// A greeting that never got out whole cannot have been acted on.
    #[test]
    fn a_prompt_whose_greeting_did_not_go_out_was_not_sent() {
        struct Unwritable;
        impl Read for Unwritable {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Ok(0)
            }
        }
        impl Write for Unwritable {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let error = prompt_on_stream(&mut Unwritable, "token-1", prompt_request_for("hello"))
            .expect_err("not sent");
        assert_eq!(error.code, "hub_unreachable");
    }

    fn chat_target() -> AgentChatTarget {
        AgentChatTarget {
            box_id: "box-1".to_string(),
            agent_id: "agent-1".to_string(),
        }
    }

    fn chat_send(text: &str) -> HubRequest {
        agent_chat_action_request(AgentChatActionInput::Send {
            target: chat_target(),
            action_id: "press-1".to_string(),
            text: text.to_string(),
        })
        .expect("a usable message")
    }

    #[test]
    fn a_chat_timeline_is_read_after_the_ack_and_a_silent_close_is_no_answer() {
        let answer = HubAgentChatTimelineResult::refused(AgentChatRefusal::AgentNotFound, "gone");
        let request = HubRequest::AgentChatTimelineV1 {
            box_id: "box-1".to_string(),
            agent_id: "agent-1".to_string(),
            before: None,
            limit: None,
        };
        let mut incoming = ack();
        incoming.extend(agent_chat::encode_timeline(&answer).expect("encodes"));
        let mut stream = Duplex::new(incoming, End::Dropped);
        let read =
            agent_chat_timeline_on_stream(&mut stream, "token-1", request.clone()).expect("read");
        assert_eq!(read, answer);
        assert_eq!(
            hello::read_hello(&mut stream.written.as_slice())
                .expect("greeting")
                .request,
            request
        );
        let mut silent = Duplex::new(ack(), End::Dropped);
        let error =
            agent_chat_timeline_on_stream(&mut silent, "token-1", request).expect_err("silent");
        assert_eq!(error.code, NO_ANSWER);
    }

    /// As for a prompt: once the greeting is out, a lost answer is `unknown`.
    #[test]
    fn a_chat_action_whose_answer_is_lost_is_unknown() {
        for (incoming, end) in [
            (Vec::new(), End::Closed),
            (ack(), End::Dropped),
            (ack(), End::TimedOut),
        ] {
            let mut stream = Duplex::new(incoming, end);
            let read = agent_chat_action_on_stream(&mut stream, "token-1", chat_send("hi"))
                .expect("an answer, not an error");
            assert_eq!(read.state, agent_chat::AgentChatActionState::Unknown);
        }
        let done = agent_chat::HubAgentChatActionResult::done(Some(
            agent_chat::AgentChatDelivery::Started,
        ));
        let mut incoming = ack();
        incoming.extend(agent_chat::encode_action(&done).expect("encodes"));
        let mut stream = Duplex::new(incoming, End::Dropped);
        let read =
            agent_chat_action_on_stream(&mut stream, "token-1", chat_send("hi")).expect("read");
        assert_eq!(read, done);
    }

    #[test]
    fn a_chat_message_is_normalized_and_a_bad_press_never_leaves() {
        let HubRequest::AgentChatSendV1 { text, .. } = chat_send("one\r\ntwo") else {
            panic!("a send");
        };
        assert_eq!(text, "one\ntwo");
        for input in [
            AgentChatActionInput::Send {
                target: chat_target(),
                action_id: "press-1".to_string(),
                text: "  ".to_string(),
            },
            AgentChatActionInput::Interrupt {
                target: chat_target(),
                action_id: "bad press".to_string(),
                turn_id: "turn-1".to_string(),
            },
        ] {
            let refused = agent_chat_action_request(input).expect_err("refused");
            assert_eq!(refused.code, Some(AgentChatRefusal::InvalidRequest));
        }
    }

    /// The shape the phone's screen sends.
    #[test]
    fn chat_action_input_reads_the_screens_shape() {
        let input: AgentChatActionInput = serde_json::from_value(serde_json::json!({
            "kind": "answer", "boxId": "box-1", "agentId": "agent-1", "actionId": "press-1",
            "requestId": "request-1", "answer": {"kind": "permission", "allow": true},
        }))
        .expect("reads");
        let HubRequest::AgentChatAnswerV1 {
            request_id, answer, ..
        } = agent_chat_action_request(input).expect("a request")
        else {
            panic!("an answer");
        };
        assert_eq!(request_id, "request-1");
        assert_eq!(answer, AgentChatAnswer::Permission { allow: true });
    }

    #[test]
    fn a_prompt_is_normalized_before_it_leaves() {
        let HubRequest::AgentPromptV1 { text, .. } = prompt_request_for("one\r\ntwo\rthree") else {
            panic!("a prompt request");
        };
        assert_eq!(text, "one\ntwo\nthree");

        for unusable in [
            "   ",
            "bell\u{7}",
            &"x".repeat(conversation::MAX_AGENT_PROMPT_BYTES + 1),
        ] {
            let refused = prompt_request(prompt_input(unusable)).expect_err("refused");
            assert_eq!(refused.state, AgentPromptState::Refused);
            assert_eq!(refused.code, Some(ConversationRefusal::InvalidRequest));
        }
    }
}
