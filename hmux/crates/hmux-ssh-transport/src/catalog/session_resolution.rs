//! Read-only successor lookup over the existing authenticated gateway channel.

use super::{CatalogError, GatewayRequest, RemoteCatalogSession, encode_request, read_answer};
use crate::{SshExecConfig, SshExecDialer};
use hmux_session_protocol::transport::FrameWriter;
use hmux_session_protocol::{FrameBody, FrameLimits, SessionFence, WireFrame};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::Read;
use std::time::{Duration, Instant};

pub const GATEWAY_REQUEST_VERSION: u16 = 11;
pub const RESPONSE_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionResolutionRequest {
    pub expected_fence: SessionFence,
}

/// The gateway borrows its catalog allow-list; clients decode their owned catalog type.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionResolutionDocument<T = RemoteCatalogSession> {
    pub gateway_session_resolution_version: u16,
    pub source_fence: SessionFence,
    #[serde(flatten)]
    pub outcome: SessionResolution<T>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SessionResolution<T = RemoteCatalogSession> {
    Resolved { session: T },
    Pending,
    Unknown,
}

pub fn request(source: &SessionFence) -> Result<Vec<u8>, CatalogError> {
    encode_request(GatewayRequest::ResolveSession(SessionResolutionRequest {
        expected_fence: source.clone(),
    }))
}

/// Decode the same bounded, source-correlated answer on SSH and Hub TLS.
pub fn read<T: DeserializeOwned>(
    reader: &mut impl Read,
    source: &SessionFence,
) -> Result<SessionResolution<T>, CatalogError> {
    let payload = super::response::read_document(reader, FrameLimits::default().max_frame_bytes)?;
    decode(payload, source)
}

fn decode<T: DeserializeOwned>(
    payload: Option<Vec<u8>>,
    source: &SessionFence,
) -> Result<SessionResolution<T>, CatalogError> {
    let payload = payload.ok_or_else(|| {
        CatalogError::Response("the gateway returned no session resolution".into())
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
    let document: SessionResolutionDocument<T> =
        serde_json::from_slice(&payload).map_err(|error| {
            CatalogError::Response(format!("unreadable session resolution: {error}"))
        })?;
    if document.gateway_session_resolution_version != RESPONSE_VERSION {
        return Err(CatalogError::Response(
            "unsupported session resolution version".into(),
        ));
    }
    source
        .ensure_matches(&document.source_fence)
        .map_err(|error| CatalogError::Response(error.to_string()))?;
    Ok(document.outcome)
}

pub fn over_ssh<T: DeserializeOwned>(
    mut config: SshExecConfig,
    source: &SessionFence,
    timeout: Duration,
) -> Result<SessionResolution<T>, CatalogError> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| CatalogError::Request("session resolution timeout overflowed".into()))?;
    config.connect_timeout = config.connect_timeout.min(timeout);
    let encoded = request(source)?;
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
    let payload = read_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?;
    decode(payload, source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_session_protocol::{ErrorCode, ErrorFrame, PROTOCOL_V1, RetryPosture};

    fn source() -> SessionFence {
        SessionFence {
            session_id: "source".into(),
            workspace_id: "workspace".into(),
            runner_principal: "account".into(),
            runner_instance: "runner".into(),
            channel_epoch: u64::MAX,
            host_instance_id: "host".into(),
            terminal_epoch: "epoch".into(),
        }
    }

    fn encoded<T: Serialize>(value: &T) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend(payload);
        bytes
    }

    #[test]
    fn resolution_states_are_source_correlated_and_generation_is_lossless() {
        let source = source();
        let request = request(&source).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&request[4..]).unwrap();
        assert_eq!(parsed["gateway_request_version"], GATEWAY_REQUEST_VERSION);
        assert_eq!(
            parsed["request"]["resolve_session"]["expected_fence"]["channel_epoch"],
            u64::MAX.to_string()
        );
        for outcome in [
            SessionResolution::Pending,
            SessionResolution::Unknown,
            SessionResolution::Resolved {
                session: "authoritative-target".to_string(),
            },
        ] {
            let mut document = SessionResolutionDocument {
                gateway_session_resolution_version: RESPONSE_VERSION,
                source_fence: source.clone(),
                outcome: outcome.clone(),
            };
            assert_eq!(
                read::<String>(&mut encoded(&document).as_slice(), &source).unwrap(),
                outcome
            );
            document.source_fence.runner_principal = "another-account".into();
            assert!(read::<String>(&mut encoded(&document).as_slice(), &source).is_err());
            document.source_fence = source.clone();
            document.gateway_session_resolution_version += 1;
            assert!(read::<String>(&mut encoded(&document).as_slice(), &source).is_err());
        }
    }

    #[test]
    fn missing_partial_and_oversized_responses_are_not_unknown_sessions() {
        for bytes in [
            vec![],
            vec![0, 0],
            vec![0, 0, 0, 8, b'{'],
            u32::MAX.to_be_bytes().to_vec(),
        ] {
            assert!(matches!(
                read::<String>(&mut bytes.as_slice(), &source()),
                Err(CatalogError::Response(_))
            ));
        }
    }

    #[test]
    fn an_old_gateway_retains_its_actionable_version_error() {
        let refused = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::Error(ErrorFrame {
                origin_code: None,
                code: ErrorCode::UnsupportedProtocolVersion,
                message: "gateway request version 11 is not supported".into(),
                retry: RetryPosture::Never,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: None,
            }),
        };
        let error = read::<String>(&mut encoded(&refused).as_slice(), &source()).unwrap_err();
        assert_eq!(error.code(), "hmux_protocol_version_unsupported");
    }
}
