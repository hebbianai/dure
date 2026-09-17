//! 폰이 "새 에이전트" 폼을 채우려면 알아야 하는 것들.
//!
//! # 왜 목록에 얹지 않고 물어보게 하나
//!
//! 목록(`catalog`)은 노트북이 **밀어 주는** 표다. 거기 얹는 값은 폰이 노트북과
//! 떨어져 있을 때도 쓸 수 있어야 한다는 뜻이고, 배치표가 거기 있는 이유가 정확히
//! 그것이다 — 꺼진 노트북의 세션도 목록에는 서 있어야 한다.
//!
//! 이 문서는 반대다. 여기 실린 목록으로 할 수 있는 일은 노트북에게 에이전트를
//! 띄워 달라고 하는 것뿐이고, 그건 노트북이 켜져 있어야만 되는 일이다. 꺼진
//! 노트북의 폴더 목록을 들고 있어 봐야 누를 수 없는 화면 하나가 남는다. 그래서
//! 폼을 열 때 묻는다 — `git_status` 가 같은 이유로 목록에 얹히지 않은 것처럼.
//!
//! # 왜 판 번호를 따로 갖나
//!
//! 목록의 판을 올리면 그 판을 모르는 폰은 **목록 전체**를 못 읽는다(`catalog` 의
//! 판 검사는 양방향 엄격 비교다). 이 문서가 자기 판을 가지면, 이 질문을 모르는
//! 노트북을 만난 폰은 이 화면 하나만 잃는다.

use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// 이 빌드가 말하는 판.
pub const HUB_LAUNCH_OFFER_VERSION: u16 = 1;

/// 이 문서 하나의 상한.
///
/// 인사 상한(8 KiB)이 아닌 이유는 `git_status` 와 같다: 이 문서는 등록된 폴더
/// 수만큼 자란다. 스페이스 열 개에 폴더 스무 개면 이백 줄이고, 그 순간 인코딩이
/// 조용히 실패해서 폰은 "노트북이 아무것도 안 보내고 끊었다" 를 본다.
pub const MAX_LAUNCH_OFFER_BYTES: usize = 256 * 1024;

/// Where installation eligibility is checked for this target.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderInstallation {
    Reported,
    CheckOnStart,
}

/// 에이전트를 띄울 수 있는 자리 하나 — 스페이스 하나 안의 폴더 하나.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LaunchTarget {
    /// 이 자리를 부르는 이름. **노트북이 지은 값이고 폰에게는 불투명하다.**
    ///
    /// 폰이 스페이스 id 와 폴더 id 를 따로 들고 다니며 조합하지 않는 이유는
    /// 다른 catalog-backed requests와 같은 이유다 — 폰이 지어낸 이름으로 물으면
    /// 그 요청은 아무 자리에도 닿지 않고, 실패는 "아무 일도 일어나지 않음" 으로만
    /// 나타난다.
    pub id: String,
    /// 사이드바에서 이 자리가 속한 스페이스의 이름.
    pub space_label: String,
    /// 폴더의 이름. 화면의 굵은 줄.
    pub folder_label: String,
    /// 어느 기계인가. 화면의 둘째 줄 앞부분.
    ///
    /// **비어 있으면 이 컴퓨터다.** 노트북이 자기 이름을 지어 보내지 않는 이유는,
    /// 폰이 이미 더 나은 이름을 들고 있기 때문이다 — 페어링할 때 사람이 직접
    /// 붙인 이름이다.
    #[serde(default)]
    pub box_label: String,
    /// 사람이 알아보는 경로. **이것으로 무엇을 열지 정하지 않는다** — 자리를
    /// 정하는 것은 `id` 이고, 이 값은 같은 이름 폴더 둘을 사람이 가르기 위한
    /// 것이다.
    pub path_hint: String,
    /// 지금 이 자리에 띄울 수 있는가.
    ///
    /// False when the target's project or host cannot be resolved.
    #[serde(default)]
    pub startable: bool,
    /// Older local-only offers omit this and retain their worktree support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_supported: Option<bool>,
    /// Missing means the existing laptop-wide `AgentKind.installed` report.
    /// CheckOnStart makes no installation claim; the target preflight decides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_installation: Option<ProviderInstallation>,
}

/// 띄울 수 있는 에이전트 한 종류.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentKind {
    /// 제공자 id. 노트북이 아는 이름 그대로.
    pub id: String,
    /// 칩에 적히는 이름.
    pub label: String,
    /// 이 노트북에 실제로 설치돼 있는가.
    ///
    /// 없는 것을 목록에서 빼지 않고 실어 보내는 이유는 위와 같다 — 화면은 그것을
    /// 흐리게 그리고, 사람은 "그 에이전트는 이 컴퓨터에 없다" 를 읽는다. 빼
    /// 버리면 왜 안 보이는지 알 길이 없다.
    #[serde(default)]
    pub installed: bool,
}

/// 노트북이 지금 내놓을 수 있는 자리와 종류.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubLaunchOffer {
    pub hub_launch_offer_version: u16,
    /// 화면이 이 표를 한 번이라도 내려보냈는가.
    ///
    /// 빈 목록과 갈라 두는 이유: 노트북이 방금 켜져 화면이 아직 아무것도 안
    /// 보냈을 때와, 정말로 등록된 폴더가 없을 때는 사람이 할 일이 다르다.
    /// 전자는 기다리면 되고, 후자는 노트북에서 폴더를 등록해야 한다.
    #[serde(default)]
    pub published: bool,
    #[serde(default)]
    pub targets: Vec<LaunchTarget>,
    #[serde(default)]
    pub kinds: Vec<AgentKind>,
}

impl HubLaunchOffer {
    /// 화면이 아직 아무것도 안 보냈다.
    #[must_use]
    pub fn unpublished() -> Self {
        Self {
            hub_launch_offer_version: HUB_LAUNCH_OFFER_VERSION,
            published: false,
            targets: Vec::new(),
            kinds: Vec::new(),
        }
    }

    #[must_use]
    pub fn published(targets: Vec<LaunchTarget>, kinds: Vec<AgentKind>) -> Self {
        Self {
            hub_launch_offer_version: HUB_LAUNCH_OFFER_VERSION,
            published: true,
            targets,
            kinds,
        }
    }
}

/// 허브 쪽: 문서 하나를 프레임으로.
///
/// # Errors
/// 직렬화가 실패하거나 문서가 프레임 한도를 넘으면.
pub fn encode(offer: &HubLaunchOffer) -> Result<Vec<u8>, FrameError> {
    frame::encode(offer, MAX_LAUNCH_OFFER_BYTES)
}

/// 폰 쪽: 문서를 읽는다. 모르는 판은 거부한다.
///
/// # Errors
/// 프레임이 깨졌거나, 판이 다르거나, 문서를 읽지 못하면.
pub fn read<R: Read>(reader: &mut R) -> Result<HubLaunchOffer, LaunchOfferError> {
    let payload = frame::read_bytes(reader, MAX_LAUNCH_OFFER_BYTES)?;
    // 두 번 읽는다. 느슨한 탐침이 먼저 판을 본다 — 엄격한 파싱을 먼저 하면 판이
    // 다른 문서가 "형식 오류" 로 보이고, 그건 사람에게 다른 조치를 뜻한다.
    let probe: VersionProbe = serde_json::from_slice(&payload)
        .map_err(|_| LaunchOfferError::Frame(FrameError::Malformed("판 번호가 없습니다")))?;
    if probe.hub_launch_offer_version != HUB_LAUNCH_OFFER_VERSION {
        return Err(LaunchOfferError::UnsupportedVersion {
            found: probe.hub_launch_offer_version,
        });
    }
    serde_json::from_slice(&payload)
        .map_err(|_| LaunchOfferError::Frame(FrameError::Malformed("자리 목록을 읽지 못했습니다")))
}

#[derive(Deserialize)]
struct VersionProbe {
    hub_launch_offer_version: u16,
}

#[derive(Debug)]
pub enum LaunchOfferError {
    Frame(FrameError),
    UnsupportedVersion { found: u16 },
}

impl From<FrameError> for LaunchOfferError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl std::fmt::Display for LaunchOfferError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 컴퓨터는 자리 목록 {found}판을 말합니다. 한쪽을 갱신하세요"
            ),
        }
    }
}

impl std::error::Error for LaunchOfferError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_capabilities_survive_the_wire_without_claiming_remote_installation() {
        let target: LaunchTarget = serde_json::from_value(serde_json::json!({
            "id": "space remote-project",
            "space_label": "QA",
            "folder_label": "Repo",
            "box_label": "AWS",
            "path_hint": "/srv/qa",
            "startable": true,
            "worktree_supported": false,
            "provider_installation": "check_on_start"
        }))
        .unwrap();
        let frame = encode(&HubLaunchOffer::published(vec![target], Vec::new())).unwrap();
        let received = read(&mut frame.as_slice()).unwrap();
        let projected = serde_json::to_value(&received.targets[0]).unwrap();
        assert_eq!(projected["worktree_supported"], false);
        assert_eq!(projected["provider_installation"], "check_on_start");
    }

    #[test]
    fn older_local_targets_leave_capabilities_unspecified() {
        let target: LaunchTarget = serde_json::from_value(serde_json::json!({
            "id": "space local-project",
            "space_label": "QA",
            "folder_label": "Repo",
            "path_hint": "/srv/qa",
            "startable": true
        }))
        .unwrap();
        let projected = serde_json::to_value(target).unwrap();
        assert!(projected.get("worktree_supported").is_none());
        assert!(projected.get("provider_installation").is_none());
    }

    /// 아직 안 보낸 것과 정말로 없는 것은 다른 사실이다.
    #[test]
    fn nothing_published_yet_is_not_an_empty_list() {
        let waiting = HubLaunchOffer::unpublished();
        let empty = HubLaunchOffer::published(Vec::new(), Vec::new());

        assert!(!waiting.published);
        assert!(empty.published);
        assert_eq!(waiting.targets, empty.targets);
    }

    /// 이 문서는 폴더 수만큼 자란다. 인사 상한이었다면 여기서 조용히 실패하고,
    /// 폰은 그것을 거절로 읽는다.
    #[test]
    fn a_desk_full_of_folders_still_fits_in_one_frame() {
        let targets = (0..200)
            .map(|index| LaunchTarget {
                id: format!("t-{index}"),
                space_label: "Workspace".to_string(),
                folder_label: format!("some-repository-with-a-long-name-{index}"),
                box_label: "mac-mini".to_string(),
                path_hint: format!("~/dev/some/reasonably/deep/path/repo-{index}"),
                startable: true,
                worktree_supported: Some(true),
                provider_installation: Some(ProviderInstallation::Reported),
            })
            .collect();

        let framed = encode(&HubLaunchOffer::published(targets, Vec::new()))
            .expect("이백 개도 한 프레임에 들어간다");
        let read = read(&mut framed.as_slice()).expect("read");
        assert_eq!(read.targets.len(), 200);
    }

    #[test]
    fn a_newer_document_is_refused_rather_than_guessed() {
        let framed = frame::encode(
            &serde_json::json!({ "hub_launch_offer_version": HUB_LAUNCH_OFFER_VERSION + 1 }),
            MAX_LAUNCH_OFFER_BYTES,
        )
        .expect("encode");

        assert!(matches!(
            read(&mut framed.as_slice()),
            Err(LaunchOfferError::UnsupportedVersion { .. })
        ));
    }
}
