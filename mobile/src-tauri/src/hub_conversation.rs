//! The observer chat's two questions to the paired computer (#361).
//!
//! `ConversationTranscriptV1` reads the newest messages of one local agent
//! session; `AgentPromptV1` types one prompt into it while it waits for input.
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

fn client_error(error: &HubClientError) -> CommandError {
    command_error(error.code(), error.to_string())
}

fn no_answer() -> CommandError {
    command_error(
        NO_ANSWER,
        "The computer closed the connection without answering",
    )
}

fn lost(error: impl std::fmt::Display) -> HubAgentPromptResult {
    HubAgentPromptResult::unknown(format!("The computer's answer was lost: {error}"))
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

/// One transcript question on an open stream.
fn transcript_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubConversationTranscriptResult, CommandError> {
    hub_client::handshake_for(stream, token, request).map_err(|error| client_error(&error))?;
    let mut counted = Counted {
        inner: stream,
        read: 0,
    };
    match conversation::read_transcript(&mut counted) {
        Ok(result) => Ok(result),
        Err(ConversationError::Frame(error)) if closed_silently(&error, counted.read) => {
            Err(no_answer())
        }
        Err(error) => Err(answer_error(&error)),
    }
}

/// One background-work question on an open stream. A silent close is
/// [`NO_ANSWER`], as for the transcript.
fn background_work_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubAgentBackgroundWorkResult, CommandError> {
    hub_client::handshake_for(stream, token, request).map_err(|error| client_error(&error))?;
    let mut counted = Counted {
        inner: stream,
        read: 0,
    };
    match background_work::read_background_work(&mut counted) {
        Ok(result) => Ok(result),
        Err(ConversationError::Frame(error)) if closed_silently(&error, counted.read) => {
            Err(no_answer())
        }
        Err(error) => Err(answer_error(&error)),
    }
}

/// One prompt on an open stream.
///
/// `Err` only while the greeting is not yet fully written: the desktop cannot
/// act on part of a frame. Once it is, every failure — no ack, a lost ack, a
/// silent close, a broken answer — is `Ok(unknown)`, because the desktop acks
/// before it acts and the prompt may already be in the agent's terminal.
fn prompt_on_stream<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubAgentPromptResult, CommandError> {
    let framed = hello::encode_hello_for(token, request)
        .map_err(|error| command_error("hub_protocol", error.to_string()))?;
    stream
        .write_all(&framed)
        .and_then(|()| stream.flush())
        .map_err(|error| client_error(&HubClientError::Unreachable(error.to_string())))?;

    if let Err(error) = hello::read_ack(stream) {
        return Ok(lost(error));
    }
    conversation::read_prompt(stream).or_else(|error| Ok(lost(error)))
}

/// The pinned TLS stream [`hub_client::dial_tls`] opens.
type HubStream = rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>;

/// Dial the computer behind `id` and run one exchange on the stream.
async fn exchange<T: Send + 'static>(
    app: &tauri::AppHandle,
    id: &str,
    run: impl FnOnce(&mut HubStream, &str) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let entry = crate::hub_target(app, id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let relay = entry
            .relay_endpoint
            .as_deref()
            .zip(entry.server_id.as_deref());
        let mut stream = hub_client::dial_tls(&entry.endpoint, relay, &entry.fingerprint)
            .map_err(|error| client_error(&error))?;
        run(&mut stream, &entry.token)
    })
    .await
    .map_err(|error| command_error("hub_join", error.to_string()))?
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
    box_id: String,
    workspace_id: String,
    session_id: String,
    text: String,
    expected_terminal_epoch: String,
    #[serde(default)]
    expected_conversation_id: Option<String>,
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
    let request = match prompt_request(input) {
        Ok(request) => request,
        Err(refused) => return Ok(refused),
    };
    exchange(&app, &id, move |stream, token| {
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
