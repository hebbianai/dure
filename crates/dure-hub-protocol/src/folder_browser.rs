//! The directory listing exchanged while the phone chooses a folder on a hub.
//!
//! Files are deliberately omitted. This screen only chooses an agent working
//! directory, and directory-only listings keep the frame bounded in large
//! folders.

use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

pub const HUB_FOLDER_BROWSER_VERSION: u16 = 1;
pub const MAX_FOLDER_BROWSER_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubFolderBrowserResult {
    pub hub_folder_browser_version: u16,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub entries: Vec<FolderEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl HubFolderBrowserResult {
    #[must_use]
    pub fn opened(path: impl Into<String>, entries: Vec<FolderEntry>) -> Self {
        Self {
            hub_folder_browser_version: HUB_FOLDER_BROWSER_VERSION,
            ok: true,
            path: Some(path.into()),
            entries,
            detail: None,
            code: None,
        }
    }

    #[must_use]
    pub fn refused(detail: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            hub_folder_browser_version: HUB_FOLDER_BROWSER_VERSION,
            ok: false,
            path: None,
            entries: Vec::new(),
            detail: Some(detail.into()),
            code: Some(code.into()),
        }
    }
}

pub fn encode(result: &HubFolderBrowserResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_FOLDER_BROWSER_BYTES)
}

pub fn read<R: Read>(reader: &mut R) -> Result<HubFolderBrowserResult, FolderBrowserError> {
    let payload = frame::read_bytes(reader, MAX_FOLDER_BROWSER_BYTES)?;
    let probe: VersionProbe = serde_json::from_slice(&payload)
        .map_err(|_| FolderBrowserError::Frame(FrameError::Malformed("판 번호가 없습니다")))?;
    if probe.hub_folder_browser_version != HUB_FOLDER_BROWSER_VERSION {
        return Err(FolderBrowserError::UnsupportedVersion {
            found: probe.hub_folder_browser_version,
        });
    }
    serde_json::from_slice(&payload).map_err(|_| {
        FolderBrowserError::Frame(FrameError::Malformed("폴더 목록을 읽지 못했습니다"))
    })
}

#[derive(Deserialize)]
struct VersionProbe {
    hub_folder_browser_version: u16,
}

#[derive(Debug)]
pub enum FolderBrowserError {
    Frame(FrameError),
    UnsupportedVersion { found: u16 },
}

impl From<FrameError> for FolderBrowserError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl std::fmt::Display for FolderBrowserError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 컴퓨터는 폴더 목록 {found}판을 말합니다. 한쪽을 갱신하세요"
            ),
        }
    }
}

impl std::error::Error for FolderBrowserError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_round_trips() {
        let result = HubFolderBrowserResult::opened(
            "/Users/me",
            vec![FolderEntry {
                name: "dev".to_string(),
                path: "/Users/me/dev".to_string(),
            }],
        );
        let framed = encode(&result).expect("encode");
        assert_eq!(read(&mut framed.as_slice()).expect("read"), result);
    }

    #[test]
    fn newer_document_is_refused() {
        let framed = frame::encode(
            &serde_json::json!({
                "hub_folder_browser_version": HUB_FOLDER_BROWSER_VERSION + 1
            }),
            MAX_FOLDER_BROWSER_BYTES,
        )
        .expect("encode");
        assert!(matches!(
            read(&mut framed.as_slice()),
            Err(FolderBrowserError::UnsupportedVersion { .. })
        ));
    }
}
