//! 폰이 알아도 되는 것의 **허용 목록**.
//!
//! `SessionDescriptor` 를 통째로 직렬화하지 않고 필드를 하나씩 옮겨 적는다.
//! 그 옮겨 적는 함수(`entry_from`)는 hmux 를 아는 쪽(`src-tauri`)에 남고, 여기에는
//! **나가는 문서의 모양**만 있다 — 폰도 같은 모양을 읽어야 하고, 폰은 hmux 의
//! 서술자 타입을 링크하지 않는다.
//!
//! 나가지 않는 것: `capability_token`, 소켓 경로, pid. 그 셋이 여기 없는 것이
//! 이 파일의 요점이다.

use crate::frame::{self, FrameError, MAX_CATALOG_BYTES};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// 이 문서의 판. 폰은 모르는 판을 거부한다.
///
/// 필드를 더할 때 올린다. 올리지 않으면 옛 폰이 모르는 필드를 무시한 채 그리고,
/// 그 화면은 "이 기능이 없는 것" 과 "이 폰이 낡은 것" 을 구별하지 못한다.
///
/// 2 판에서 더해진 것: `layout` — 사용자가 앱에서 만든 묶음 전체. `Option` 이라
/// 1 판을 읽던 폰이 깨지지는 않지만, 그 폰은 묶음 없이 그린다는 사실을 화면이
/// 알아야 하므로 판을 올린다.
///
/// 3 판에서 더해진 것: `display_title` — 노트북 사이드바에 보이는 세션 이름.
///
/// 5 판에서 더해진 것: `SessionPlacement.branch` — 그 세션이 올라앉은 git 브랜치.
/// hmux 세션 서술자에도 `branch` 자리는 있지만 생산 지점 두 곳이 모두 `None` 을
/// 넣는다(`unix_runtime.rs`, `windows_runtime.rs`) — 거기 실으면 모든 폰에 `null`
/// 이 간다. 브랜치를 아는 것은 노트북 앱이고, 그 앱이 이미 데스크탑·프로젝트를
/// 이 길로 밀어넣고 있으므로 같은 길에 얹는다.
pub const HUB_CATALOG_VERSION: u16 = 5;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubCatalogEntry {
    pub session_id: String,
    pub session_name: Option<String>,
    #[serde(default)]
    pub display_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<SessionPresentation>,
    pub workspace_id: String,
    /// hmux 가 붙인 직렬화 이름을 그대로 담는다. 이름을 정하는 곳이 hmux 하나로
    /// 남아야 하므로 여기서 열거형으로 좁히지 않는다.
    pub session_class: String,
    pub lifecycle: String,
    pub provider_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
    pub capabilities: Vec<String>,
    /// 이 세션이 무엇을 실행하도록 띄워졌는지, 이름만.
    ///
    /// 인자는 담지 않는다 — 명령줄에는 비밀이 산다. 그리고 *띄워질 때*의
    /// 사실이라, 셸로 시작해 나중에 ssh 를 친 세션은 여전히 셸로 읽힌다.
    #[serde(default)]
    pub launch_program: Option<String>,
    /// 이 세션이 어느 상자에 있는지. 허브가 여러 상자를 합쳐 보여주므로, 폰은
    /// 같은 목록에서 노트북 세션과 서버 세션을 구별할 수 있어야 한다.
    pub box_id: String,
    pub box_label: String,
}

/// Desktop-owned display observations. Kept out of the persisted placement
/// cache; absence means the desktop has not observed that field.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPresentation {
    /// Optional display metadata: older catalogs omit it and older clients
    /// ignore it without changing session identity or attach compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<SessionGitSummary>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGitSummary {
    pub ahead: u32,
    pub behind: u32,
    pub committed: u32,
    pub worktree: u32,
}

/// 세션 하나가 사이드바에서 앉아 있는 자리.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionPlacement {
    /// 사용자가 앱에서 만든 최상위 묶음 — 사이드바의 "Workspace" 같은 것.
    pub desktop: String,
    /// 그 안의 저장소/프로젝트 — 사이드바의 "agent-ide" 같은 것.
    pub project: String,
    /// 사이드바에서의 순서. 폰이 같은 순서로 세울 수 있게.
    pub order: u32,
    /// 이 세션이 올라앉은 git 브랜치. 노트북이 모르면 `None` — 폰은 그때 아무
    /// 것도 그리지 않는다. 빈 문자열이나 대시로 채우지 않는 이유는, 브랜치를
    /// 모르는 것과 브랜치가 없는 것이 다른 사실이기 때문이다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// 사용자가 앱에서 만든 묶음 전체.
///
/// # 왜 줄마다가 아니라 여기 통째로 실리나
///
/// 이 카탈로그는 노트북 로컬 세션과 노트북이 닿는 원격 세션을 함께 나른다.
/// 폰이 직접 SSH로 조사한 목록만 남은 때도 같은 자리를 복원해야 한다.
///
/// 자리를 줄마다 붙이면 지금 카탈로그에 없는 세션의 자리는 폰에 가지 않는다.
/// 그러면 노트북이 꺼졌을 때 직접 SSH 세션을 같은 구조로 복원할 수 없다.
///
/// 그래서 표 전체가 온다. 폰은 이것을 저장해 두고, 허브 목록이든 자기 SSH
/// 인구조사든 세션 id 로 자리를 찾는다.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogLayout {
    /// hmux 세션 id → 자리. 이 카탈로그가 나르지 않는 세션의 자리도 들어 있다.
    pub placements: std::collections::HashMap<String, SessionPlacement>,
    /// 데스크탑이 사이드바에 선 순서. 이름만으로는 순서를 알 수 없다.
    pub desktop_order: Vec<String>,
}

/// 대답하지 못한 상자와 그 이유.
///
/// 목록에서 조용히 빼지 않는다 — 사라진 상자는 없는 상자로 읽히고, 주인이 폰을
/// 꺼낸 이유가 그 상자일 수 있다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnreachableBox {
    pub box_id: String,
    pub box_label: String,
    pub detail: String,
}

/// 목록 한 번의 답.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubCatalog {
    pub hub_catalog_version: u16,
    pub sessions: Vec<HubCatalogEntry>,
    pub unreachable: Vec<UnreachableBox>,
    /// 사용자가 앱에서 만든 묶음. 화면이 아직 안 보냈으면 없다.
    ///
    /// `Option` 인 것이 정보다: **비어 있는 표**(사이드바에 아무것도 없다)와
    /// **아직 못 받았다**(화면이 뜨기 전이다)는 다른 사실이고, 폰이 그 둘을 같은
    /// 빈 화면으로 그리면 사용자는 자기가 정리한 것이 사라졌다고 읽는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<CatalogLayout>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CatalogError {
    Frame(FrameError),
    /// 폰이 모르는 판. 무시하고 그리지 않는다.
    UnsupportedVersion {
        found: u16,
    },
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 앱이 읽지 못하는 목록 판입니다: {found} (이 빌드는 \
                 {HUB_CATALOG_VERSION}). 컴퓨터와 폰 중 한쪽이 낡았습니다"
            ),
        }
    }
}

impl std::error::Error for CatalogError {}

impl From<FrameError> for CatalogError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

/// 허브 쪽: 목록을 프레임으로.
pub fn encode(catalog: &HubCatalog) -> Result<Vec<u8>, FrameError> {
    frame::encode(catalog, MAX_CATALOG_BYTES)
}

/// 폰 쪽: 목록을 읽는다.
pub fn read<R: Read>(reader: &mut R) -> Result<HubCatalog, CatalogError> {
    let payload = frame::read_bytes(reader, MAX_CATALOG_BYTES)?;
    // 판을 **엄격한 역직렬화보다 먼저** 읽는다. 순서가 반대면, 판이 실제로
    // 갈린 날 — 필드 이름이 바뀌거나 사라진 날 — 옛 폰은 "이 판의 JSON 이
    // 아닙니다" 를 받는다. 판 번호를 둔 이유가 그때 "한쪽이 낡았습니다" 를
    // 말하는 것인데, 정작 그때 말하지 못하게 된다.
    let probe: VersionProbe = serde_json::from_slice(&payload)
        .map_err(|_| CatalogError::Frame(FrameError::Malformed("판 번호가 없습니다")))?;
    if probe.hub_catalog_version != HUB_CATALOG_VERSION {
        return Err(CatalogError::UnsupportedVersion {
            found: probe.hub_catalog_version,
        });
    }
    serde_json::from_slice(&payload)
        .map_err(|_| CatalogError::Frame(FrameError::Malformed("이 판의 JSON 이 아닙니다")))
}

/// 판만 먼저 읽는 조각. 모르는 필드는 무시되므로 **어떤 판의 문서에서도**
/// 판 번호를 꺼낼 수 있다.
#[derive(Deserialize)]
struct VersionProbe {
    hub_catalog_version: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_presentation_roundtrips_and_old_catalogs_keep_it_absent() {
        let mut current = catalog();
        current.sessions[0].presentation = Some(SessionPresentation {
            pinned: Some(true),
            activity_at: Some(1_700_000_000_000),
            detail: Some("Working on the session list".into()),
            git: Some(SessionGitSummary {
                committed: 2,
                worktree: 51,
                ahead: 0,
                behind: 6,
            }),
            ..Default::default()
        });
        let encoded = encode(&current).unwrap();
        assert_eq!(read(&mut encoded.as_slice()).unwrap(), current);
        let old = encode(&catalog()).unwrap();
        assert!(
            read(&mut old.as_slice()).unwrap().sessions[0]
                .presentation
                .is_none()
        );
        let old_presentation: SessionPresentation =
            serde_json::from_str(r#"{"activityAt":1700000000000}"#).unwrap();
        assert_eq!(old_presentation.pinned, None);
        assert!(
            serde_json::to_value(old_presentation)
                .unwrap()
                .get("pinned")
                .is_none()
        );
    }

    /// 구조체 리터럴인 것이 의도다: 매니페스트에 필드가 늘면 컴파일이 깨져
    /// 허용 목록을 다시 보게 된다.
    fn entry() -> HubCatalogEntry {
        HubCatalogEntry {
            session_id: "session-1".to_string(),
            session_name: Some("잉? 다시 어두워짐".to_string()),
            display_title: Some("mobile".to_string()),
            presentation: None,
            workspace_id: "workspace-1".to_string(),
            session_class: "agent".to_string(),
            lifecycle: "running".to_string(),
            provider_id: "claude".to_string(),
            runner_principal: "principal-1".to_string(),
            runner_instance: "instance-1".to_string(),
            channel_epoch: "epoch-1".to_string(),
            host_instance_id: "host-1".to_string(),
            terminal_epoch: "terminal-1".to_string(),
            capabilities: vec!["terminal_stream".to_string()],
            launch_program: Some("zsh".to_string()),
            box_id: "box-1".to_string(),
            box_label: "노트북".to_string(),
        }
    }

    fn catalog() -> HubCatalog {
        HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: vec![entry()],
            unreachable: vec![UnreachableBox {
                box_id: "box-2".to_string(),
                box_label: "gate1".to_string(),
                detail: "시간이 초과되었습니다".to_string(),
            }],
        }
    }

    #[test]
    fn round_trips_between_the_two_halves() {
        let framed = encode(&catalog()).expect("encodes");
        assert_eq!(read(&mut framed.as_slice()).expect("reads"), catalog());
        assert_eq!(
            catalog().sessions[0].display_title.as_deref(),
            Some("mobile")
        );
    }

    #[test]
    fn rejects_a_version_this_build_does_not_read() {
        let mut future = catalog();
        future.hub_catalog_version = HUB_CATALOG_VERSION + 1;
        let framed = frame::encode(&future, MAX_CATALOG_BYTES).expect("encodes");
        assert_eq!(
            read(&mut framed.as_slice()).expect_err("unsupported"),
            CatalogError::UnsupportedVersion {
                found: HUB_CATALOG_VERSION + 1
            }
        );
    }

    /// 대답하지 못한 상자가 목록에서 사라지지 않는다는 것.
    #[test]
    fn carries_unreachable_boxes_across_the_wire() {
        let framed = encode(&catalog()).expect("encodes");
        let decoded = read(&mut framed.as_slice()).expect("reads");
        assert_eq!(decoded.unreachable.len(), 1);
        assert_eq!(decoded.unreachable[0].box_label, "gate1");
    }

    /// `launch_program` 이 없는 옛 문서도 읽힌다는 것 — `#[serde(default)]` 가
    /// 그 자리에 있는 이유이고, 없으면 옛 노트북에 붙은 폰이 목록을 통째로
    /// 못 읽는다.
    #[test]
    fn tolerates_a_document_without_launch_program() {
        let mut value = serde_json::to_value(catalog()).expect("to value");
        value["sessions"][0]
            .as_object_mut()
            .expect("object")
            .remove("launch_program");
        let body = serde_json::to_vec(&value).expect("to vec");
        let mut framed = u32::try_from(body.len())
            .expect("fits")
            .to_be_bytes()
            .to_vec();
        framed.extend_from_slice(&body);

        let decoded = read(&mut framed.as_slice()).expect("reads");
        assert_eq!(decoded.sessions[0].launch_program, None);
    }

    /// 세션의 capability token 이 이 문서의 모양에 아예 없다는 것.
    ///
    /// 이름으로 검사하는 이유: 누군가 필드를 더할 때 이 시험이 먼저 깨져야
    /// 하고, 타입으로는 "없음" 을 표현할 수 없다.
    #[test]
    fn the_document_has_no_field_that_could_carry_a_capability_token() {
        let value = serde_json::to_value(entry()).expect("to value");
        let fields: Vec<&String> = value.as_object().expect("object").keys().collect();
        for forbidden in ["capability_token", "socket_path", "pid"] {
            assert!(
                !fields.iter().any(|name| name.as_str() == forbidden),
                "{forbidden} 이 폰으로 나가는 문서에 들어왔습니다: {fields:?}"
            );
        }
    }
}
