//! One agent session's provider conversation, read from the box that runs it.
//!
//! A phone that reaches a server only over SSH has no desktop to read the
//! provider's transcript for it, and a paired key's forced command leaves it
//! no file access. So it asks the gateway with one request document; the
//! gateway resolves the session by this exact fence, takes the conversation
//! and runtime state from the Host, reads the transcript on that box, and
//! answers in the hub's conversation shape (`dure-hub-protocol`), cursor rule
//! included. This crate carries the question and returns the answer in the
//! caller's type; it knows neither shape's meaning.
//!
//! A gateway that predates the request refuses it with a typed
//! `UnsupportedProtocolVersion` ([`CatalogError::is_unsupported_protocol_version`]),
//! which is how a client tells "update that server's Hmux" from a failure.

use super::{CatalogError, framed_document, read_answer};
use crate::{SshExecConfig, SshExecDialer};
use hmux_session_protocol::transport::FrameWriter;
use hmux_session_protocol::{FrameBody, FrameLimits, SessionFence, WireFrame};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::Read;
use std::time::{Duration, Instant};

/// The request-document version that carries this question. One version
/// admits exactly this one request on the far side.
pub const GATEWAY_REQUEST_VERSION: u16 = 12;

/// Which session, as the exact fence the client already listed, plus the
/// hub's paging and cursor. `C` is the cursor type the answer handed out,
/// echoed unchanged; absent fields are omitted rather than written as null.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationTranscriptRequest<C> {
    pub expected_fence: SessionFence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    // No `default`: it would require `C: Default`, and a missing `Option`
    // field already reads as `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<C>,
}

#[derive(Serialize)]
struct RequestDocument<'a, C> {
    gateway_request_version: u16,
    request: Request<'a, C>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Request<'a, C> {
    ConversationTranscript(&'a ConversationTranscriptRequest<C>),
}

/// The framed request document.
pub fn request<C: Serialize>(
    request: &ConversationTranscriptRequest<C>,
) -> Result<Vec<u8>, CatalogError> {
    framed_document(&RequestDocument {
        gateway_request_version: GATEWAY_REQUEST_VERSION,
        request: Request::ConversationTranscript(request),
    })
}

/// Read one answer: the gateway's typed refusal, or the document in `T`.
pub fn read<T: DeserializeOwned>(reader: &mut impl Read) -> Result<T, CatalogError> {
    decode(super::response::read_document(
        reader,
        FrameLimits::default().max_frame_bytes,
    )?)
}

fn decode<T: DeserializeOwned>(payload: Option<Vec<u8>>) -> Result<T, CatalogError> {
    let payload = payload.ok_or_else(|| {
        CatalogError::Response("the gateway returned no conversation transcript".into())
    })?;
    if let Ok(WireFrame {
        body: FrameBody::Error(error),
        ..
    }) = serde_json::from_slice(&payload)
    {
        return Err(CatalogError::Refused {
            code: error.code,
            message: error.message,
        });
    }
    serde_json::from_slice(&payload).map_err(|error| {
        CatalogError::Response(format!("unreadable conversation transcript: {error}"))
    })
}

/// Ask one box over SSH, within `timeout` from dial to answer.
pub fn over_ssh<C: Serialize, T: DeserializeOwned>(
    mut config: SshExecConfig,
    question: &ConversationTranscriptRequest<C>,
    timeout: Duration,
) -> Result<T, CatalogError> {
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        CatalogError::Request("conversation transcript timeout overflowed".into())
    })?;
    config.connect_timeout = config.connect_timeout.min(timeout);
    let encoded = request(question)?;
    let mut transport = SshExecDialer::open_halves(config).map_err(CatalogError::Ssh)?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));
    decode(read_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_session_protocol::{
        ErrorCode, ErrorFrame, FrameBody, PROTOCOL_V1, RetryPosture, WireFrame,
    };

    fn fence() -> SessionFence {
        SessionFence {
            session_id: "session".into(),
            workspace_id: "workspace".into(),
            runner_principal: "account".into(),
            runner_instance: "runner".into(),
            channel_epoch: u64::MAX,
            host_instance_id: "host".into(),
            terminal_epoch: "epoch".into(),
        }
    }

    fn framed<T: Serialize>(value: &T) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend(payload);
        bytes
    }

    fn sent(bytes: &[u8]) -> serde_json::Value {
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(length, bytes.len() - 4);
        serde_json::from_slice(&bytes[4..]).unwrap()
    }

    #[test]
    fn the_request_names_the_exact_session_and_echoes_the_cursor() {
        let cursor = serde_json::json!({ "terminal_epoch": "epoch", "turn_completed_count": 3 });
        let encoded = request(&ConversationTranscriptRequest {
            expected_fence: fence(),
            limit: Some(100),
            after: Some(cursor.clone()),
        })
        .unwrap();
        let document = sent(&encoded);
        assert_eq!(document["gateway_request_version"], 12);
        let asked = &document["request"]["conversation_transcript"];
        assert_eq!(
            asked["expected_fence"]["channel_epoch"],
            u64::MAX.to_string()
        );
        assert_eq!(asked["expected_fence"]["terminal_epoch"], "epoch");
        assert_eq!(asked["limit"], 100);
        assert_eq!(asked["after"], cursor);

        // A first read carries neither, rather than nulls a strict reader
        // would have to know about.
        let first = sent(
            &request(&ConversationTranscriptRequest::<serde_json::Value> {
                expected_fence: fence(),
                limit: None,
                after: None,
            })
            .unwrap(),
        );
        let asked = first["request"]["conversation_transcript"]
            .as_object()
            .unwrap();
        assert_eq!(asked.keys().collect::<Vec<_>>(), ["expected_fence"]);
    }

    #[test]
    fn the_answer_is_read_in_the_callers_shape() {
        let answer = serde_json::json!({ "hub_conversation_version": 1, "outcome": "unchanged" });
        let read: serde_json::Value = read(&mut framed(&answer).as_slice()).unwrap();
        assert_eq!(read, answer);
    }

    #[test]
    fn a_gateway_that_predates_the_request_is_a_typed_version_refusal() {
        let refused = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::Error(ErrorFrame {
                origin_code: None,
                code: ErrorCode::UnsupportedProtocolVersion,
                message: "this gateway serves gateway_request_version 1..=11, not 12".into(),
                retry: RetryPosture::Never,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: None,
            }),
        };
        let error = read::<serde_json::Value>(&mut framed(&refused).as_slice()).unwrap_err();
        assert!(error.is_unsupported_protocol_version());
        assert_eq!(error.code(), "hmux_protocol_version_unsupported");
    }

    #[test]
    fn a_missing_partial_or_oversized_answer_is_not_an_answer() {
        for bytes in [
            vec![],
            vec![0, 0],
            vec![0, 0, 0, 8, b'{'],
            u32::MAX.to_be_bytes().to_vec(),
            framed(&"not an object"),
        ] {
            assert!(matches!(
                read::<std::collections::BTreeMap<String, String>>(&mut bytes.as_slice()),
                Err(CatalogError::Response(_))
            ));
        }
    }
}
