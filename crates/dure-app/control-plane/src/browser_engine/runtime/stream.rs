//! Bounded readback for completed PDF and recording streams on their owner session.

use super::{BrowserCdp, capture::MAX_ARTIFACT_BYTES};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

#[derive(Debug)]
pub(super) enum StreamError {
    Transport(&'static str),
    Invalid,
    Limit,
    Stalled,
}

pub(super) async fn read(
    cdp: &mut BrowserCdp,
    session: &str,
    handle: &str,
) -> Result<Vec<u8>, StreamError> {
    let mut bytes = Vec::new();
    append(cdp, session, handle, &mut bytes).await?;
    Ok(bytes)
}

/// Active recording streams report EOF at their current tail, not at the end
/// of the interval. The caller retains this cursor and requests finish once.
pub(super) async fn append(
    cdp: &mut BrowserCdp,
    session: &str,
    handle: &str,
    bytes: &mut Vec<u8>,
) -> Result<(), StreamError> {
    loop {
        let part = cdp
            .request(
                "IO.read",
                json!({"handle":handle,"size":64*1024}),
                Some(session),
            )
            .await
            .map_err(StreamError::Transport)?;
        let data = part["data"].as_str().ok_or(StreamError::Invalid)?;
        if data.len() > 87384 {
            return Err(StreamError::Invalid);
        }
        let data = if part["base64Encoded"] == true {
            STANDARD.decode(data).map_err(|_| StreamError::Invalid)?
        } else {
            data.as_bytes().to_vec()
        };
        if data.len() > 64 * 1024 {
            return Err(StreamError::Invalid);
        }
        if bytes.len() + data.len() > MAX_ARTIFACT_BYTES {
            return Err(StreamError::Limit);
        }
        let progressed = !data.is_empty();
        bytes.extend(data);
        if part["eof"] == true {
            return Ok(());
        }
        if !progressed {
            return Err(StreamError::Stalled);
        }
    }
}
