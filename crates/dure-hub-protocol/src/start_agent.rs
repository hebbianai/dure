//! 폰이 에이전트를 띄워 달라고 했을 때, 실제로 떴는지.
//!
//! # 왜 답이 있어야 하나
//!
//! 띄우는 것은 노트북 **화면**이다. 그 화면만이 저널과 스폰 사가를 들고 있고,
//! 폰의 요청은 허브를 거쳐 거기까지 가야 한다. 중간에 어디서든 멈출 수 있다 —
//! 화면이 방금 닫혔거나, 그 자리가 사라졌거나, 그 에이전트가 이 컴퓨터에
//! 설치돼 있지 않거나.
//!
//! "보냈다" 만 돌려주면 폰은 그 셋을 성공과 구별하지 못한다. 그러면 사람은
//! 시작을 눌렀고 아무 일도 일어나지 않은 채, 성공한 화면을 보게 된다 —
//! `answer` 가 같은 이유로 얇은 답을 갖는다.
//!
//! # 왜 코드와 문장을 함께 싣나
//!
//! 문장은 사람이 읽고, 코드는 화면이 갈라 쓴다. 설치되지 않은 에이전트와 사라진
//! 폴더는 사람이 할 일이 다르다 — 하나는 노트북에서 설치하는 것이고 하나는
//! 목록을 새로 받는 것이다. 문장으로만 주면 화면은 그 둘을 가를 수 없고,
//! 문장을 다듬는 순간 그 분기가 조용히 사라진다.

use crate::frame::{self, FrameError, MAX_HELLO_BYTES};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// 이 빌드가 말하는 판.
pub const HUB_START_AGENT_VERSION: u16 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubStartAgentResult {
    pub hub_start_agent_version: u16,
    /// 노트북이 실제로 **띄웠는가**. 요청을 받았는가가 아니다.
    pub started: bool,
    /// 생긴 에이전트의 id. 못 띄웠으면 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// 그 에이전트의 hmux 세션 id — 폰이 바로 열 수 있는 값.
    ///
    /// 띄웠는데도 없을 수 있다: 제공자에 따라 세션 id 가 나중에야 생긴다. 없음을
    /// 실패로 접으면 잘 뜬 에이전트가 실패로 보이므로, 화면은 `started` 로
    /// 성패를 읽고 이 값으로는 "지금 열 수 있는가" 만 읽는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 못 띄운 이유. 사람이 읽는 문장이다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 그 이유의 종류. 화면이 문장이 아니라 이 값으로 갈라 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl HubStartAgentResult {
    #[must_use]
    pub fn started(agent_id: impl Into<String>, session_id: Option<String>) -> Self {
        Self {
            hub_start_agent_version: HUB_START_AGENT_VERSION,
            started: true,
            agent_id: Some(agent_id.into()),
            session_id,
            detail: None,
            code: None,
        }
    }

    #[must_use]
    pub fn refused_with_code(detail: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            hub_start_agent_version: HUB_START_AGENT_VERSION,
            started: false,
            agent_id: None,
            session_id: None,
            detail: Some(detail.into()),
            code: Some(code.into()),
        }
    }
}

/// 허브 쪽: 결과 하나를 프레임으로.
///
/// # Errors
/// 직렬화가 실패하거나 결과가 프레임 한도를 넘으면.
pub fn encode(result: &HubStartAgentResult) -> Result<Vec<u8>, FrameError> {
    // 짧은 문자열 몇 개뿐이라 인사 상한으로 충분하다 — `launch_offer` 와 달리
    // 이 문서는 등록된 폴더 수에 따라 자라지 않는다.
    frame::encode(result, MAX_HELLO_BYTES)
}

/// 폰 쪽: 결과를 읽는다. 모르는 판은 거부한다.
///
/// # Errors
/// 프레임이 깨졌거나, 판이 다르거나, 문서를 읽지 못하면.
pub fn read<R: Read>(reader: &mut R) -> Result<HubStartAgentResult, StartAgentError> {
    let payload = frame::read_bytes(reader, MAX_HELLO_BYTES)?;
    let probe: VersionProbe = serde_json::from_slice(&payload)
        .map_err(|_| StartAgentError::Frame(FrameError::Malformed("판 번호가 없습니다")))?;
    if probe.hub_start_agent_version != HUB_START_AGENT_VERSION {
        return Err(StartAgentError::UnsupportedVersion {
            found: probe.hub_start_agent_version,
        });
    }
    serde_json::from_slice(&payload)
        .map_err(|_| StartAgentError::Frame(FrameError::Malformed("시작 결과를 읽지 못했습니다")))
}

#[derive(Deserialize)]
struct VersionProbe {
    hub_start_agent_version: u16,
}

#[derive(Debug)]
pub enum StartAgentError {
    Frame(FrameError),
    UnsupportedVersion { found: u16 },
}

impl From<FrameError> for StartAgentError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl std::fmt::Display for StartAgentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 컴퓨터는 시작 결과 {found}판을 말합니다. 한쪽을 갱신하세요"
            ),
        }
    }
}

impl std::error::Error for StartAgentError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// 세션 id 가 없는 성공은 실패가 아니다. 접으면 잘 뜬 에이전트가 실패로
    /// 보이고, 사람은 같은 것을 한 번 더 띄운다.
    #[test]
    fn a_start_without_a_session_id_is_still_a_start() {
        let result = HubStartAgentResult::started("agent-1", None);

        assert!(result.started);
        assert_eq!(result.agent_id.as_deref(), Some("agent-1"));
        assert!(result.session_id.is_none());
        assert!(result.code.is_none());
    }

    /// 이유의 종류는 문장과 함께 간다 — 화면이 갈라 써야 하는 것은 종류다.
    #[test]
    fn a_refusal_carries_a_kind_the_screen_can_branch_on() {
        let framed = encode(&HubStartAgentResult::refused_with_code(
            "이 컴퓨터에 그 에이전트가 설치되어 있지 않습니다",
            "kind_not_installed",
        ))
        .expect("encode");

        let read = read(&mut framed.as_slice()).expect("read");
        assert!(!read.started);
        assert_eq!(read.code.as_deref(), Some("kind_not_installed"));
        assert!(read.detail.is_some());
    }

    #[test]
    fn a_newer_document_is_refused_rather_than_guessed() {
        let framed = frame::encode(
            &serde_json::json!({ "hub_start_agent_version": HUB_START_AGENT_VERSION + 1 }),
            MAX_HELLO_BYTES,
        )
        .expect("encode");

        assert!(matches!(
            read(&mut framed.as_slice()),
            Err(StartAgentError::UnsupportedVersion { .. })
        ));
    }
}
