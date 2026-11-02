//! The observer chat's two questions to the paired computer (#361).
//!
//! `ConversationTranscriptV1` reads the newest messages of one local agent
//! session; `AgentPromptV1` types one prompt into it while it waits for input.
//! Both ride a fresh TLS connection over the paired relay, the way the account
//! sheet's questions do: the greeting carries the request, the ack comes back,
//! then one answer document (`dure_hub_protocol::conversation`).
//!
//! # An older computer
//!
//! A desktop that predates these requests reads them as `Unsupported`, sends
//! the ack and closes without another byte. This module names that
//! [`UNSUPPORTED`] so the screen can say "update Dure on the computer" rather
//! than "could not connect". The catalog's `conversation` flag already keeps an
//! older desktop from being asked; this is the answer for the case it misses.
//!
//! # A prompt whose answer is lost
//!
//! Once the greeting with the prompt is on the wire, the desktop may write the
//! prompt even if its answer never arrives. From that point a broken
//! connection is answered as the protocol's own `unknown` ("read the
//! transcript before sending this again"), never as an error the screen would
//! retry by itself.

use crate::hub_client::{self, HubClientError};
use crate::CommandError;
use dure_hub_protocol::conversation::{
    self, ConversationCursor, ConversationError, ConversationRefusal, HubAgentPromptResult,
    HubConversationTranscriptResult,
};
use dure_hub_protocol::frame::FrameError;
use dure_hub_protocol::hello::{self, HubRequest};
use serde::Deserialize;
use std::io::{Read, Write};

/// The computer took the request and closed without answering: a Dure from
/// before the chat.
pub const UNSUPPORTED: &str = "conversation_unsupported";

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

fn unsupported() -> CommandError {
    command_error(
        UNSUPPORTED,
        "The computer's Dure does not serve conversations yet. Update Dure on the computer",
    )
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
            Err(unsupported())
        }
        Err(error) => Err(answer_error(&error)),
    }
}

/// One prompt on an open stream.
///
/// `Err` only while nothing can have been written: the greeting did not get
/// out whole, or the desktop closed without acknowledging it (it acknowledges
/// before it acts, and a stream delivers in order, so an end with no ack is an
/// end before any action). Every later failure is `Ok(unknown)`.
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

    let mut counted = Counted {
        inner: stream,
        read: 0,
    };
    match hello::read_ack(&mut counted) {
        Ok(_) => {}
        Err(hello::HelloError::Frame(error)) if closed_silently(&error, counted.read) => {
            return Err(client_error(&HubClientError::Refused));
        }
        Err(error) => {
            return Ok(HubAgentPromptResult::unknown(format!(
                "The computer's answer was lost: {error}"
            )));
        }
    }

    let mut counted = Counted {
        inner: counted.inner,
        read: 0,
    };
    match conversation::read_prompt(&mut counted) {
        Ok(result) => Ok(result),
        Err(ConversationError::Frame(error)) if closed_silently(&error, counted.read) => {
            Err(unsupported())
        }
        Err(error) => Ok(HubAgentPromptResult::unknown(format!(
            "The computer's answer was lost: {error}"
        ))),
    }
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
/// nothing was written.
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

    /// An older desktop acks and drops the stream. Through rustls that is an
    /// unexpected end, not a clean one; either way it is "update the computer".
    #[test]
    fn an_older_desktop_closing_after_the_ack_reads_as_unsupported() {
        for end in [End::Closed, End::Dropped] {
            let mut stream = Duplex::new(ack(), end);
            let error = transcript_on_stream(&mut stream, "token-1", transcript_request())
                .expect_err("no answer");
            assert_eq!(error.code, UNSUPPORTED);

            let mut stream = Duplex::new(ack(), end);
            let error = prompt_on_stream(&mut stream, "token-1", prompt_request_for("hello"))
                .expect_err("no answer");
            assert_eq!(error.code, UNSUPPORTED);
        }
    }

    /// Half an answer is a broken connection, not an older desktop.
    #[test]
    fn a_transcript_cut_mid_answer_is_not_unsupported() {
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
    fn a_silent_transcript_is_unreachable_not_unsupported() {
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

    /// The desktop acknowledges before it acts, so an end before the ack is
    /// "nothing written" and the phone may try again.
    #[test]
    fn a_prompt_closed_before_the_ack_was_not_sent() {
        let mut stream = Duplex::new(Vec::new(), End::Dropped);
        let error = prompt_on_stream(&mut stream, "token-1", prompt_request_for("hello"))
            .expect_err("refused");
        assert_eq!(error.code, "hub_refused");
    }

    /// After the greeting is out, a lost answer may hide a written prompt.
    #[test]
    fn a_prompt_whose_answer_is_lost_is_unknown_not_an_error() {
        let mut stream = Duplex::new(Vec::new(), End::TimedOut);
        let read = prompt_on_stream(&mut stream, "token-1", prompt_request_for("hello"))
            .expect("unknown is an answer");
        assert_eq!(read.state, AgentPromptState::Unknown);

        let mut stream = Duplex::new(ack(), End::TimedOut);
        let read = prompt_on_stream(&mut stream, "token-1", prompt_request_for("hello"))
            .expect("unknown is an answer");
        assert_eq!(read.state, AgentPromptState::Unknown);

        let answer = HubAgentPromptResult::written("terminal-1", "record-1");
        let frame = conversation::encode_prompt(&answer).expect("encodes");
        let mut incoming = ack();
        incoming.extend(&frame[..frame.len() - 3]);
        let mut stream = Duplex::new(incoming, End::Dropped);
        let read = prompt_on_stream(&mut stream, "token-1", prompt_request_for("hello"))
            .expect("unknown is an answer");
        assert_eq!(read.state, AgentPromptState::Unknown);
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
