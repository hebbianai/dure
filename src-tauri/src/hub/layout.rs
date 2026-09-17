//! 사이드바가 만든 묶음을, 폰이 같은 모양으로 그릴 수 있게 들고 있는 자리.
//!
//! # 왜 이것이 hmux 에서 오지 않나
//!
//! 데스크탑("Workspace", "Onchain", "Artrooms")은 **사용자가 앱에서 만든 것**이다.
//! hmux 는 그런 것을 모르고, 알아서도 안 된다 — IDE 의 표현 상태는 `src/` 의 store
//! 에만 산다는 것이 이 저장소의 불변식이다(AGENTS.md). 그래서 카탈로그를 만드는
//! Rust 쪽에는 그 정보가 없었고, 폰은 세션을 상자 이름으로밖에 묶을 수 없었다.
//!
//! 그 구조는 웹뷰의 localStorage 안에 있으므로 Rust 가 읽을 방법도 없다. 그래서
//! **화면이 내려보낸다.** 그것이 이 모듈이다.
//!
//! 이것이 불변식을 어기지 않는 이유: 여기 실리는 값은 hmux 프로토콜이 아니라 **이
//! 앱의 허브 프로토콜**로 나간다. 그 프로토콜은 이미 `box_label` 같은 앱 수준의
//! 값을 나르고 있고, 폰은 hmux 의 클라이언트가 아니라 **이 앱의 클라이언트**다.
//!
//! # 왜 폰이 이것을 저장하는가
//!
//! 노트북이 꺼지면 허브에 닿을 수 없고, 그러면 이 구조도 못 받는다. 그런데 폰이
//! 붙을 수 있는 세션이 그때도 남아 있다 — SSH 로 등록한 서버의 세션은 노트북을
//! 거치지 않는다. 구조를 폰이 캐시해 두면 노트북이 꺼진 동안에도 목록이 사용자가
//! 만든 모양 그대로 서 있고, 닿지 못하는 줄만 비활성이 된다.
//!
//! # 분류가 없는 세션은 나가지 않는다
//!
//! 사이드바에 없는 세션은 이 표에도 없다. 폰은 그런 세션을 **그리지 않는다** —
//! 소유자 결정이다. 억지로 "분류 없음" 묶음을 만들면 사용자가 정리한 적 없는
//! 것들이 화면 아래에 쌓이고, 그건 사이드바를 정리한 사람이 보려던 화면이 아니다.

use dure_hub_protocol::catalog::{CatalogLayout, SessionPlacement as WirePlacement};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// 사이드바 한 줄이 속한 자리.
///
/// 세션 id 로 키를 잡는다. 그 값이 허브 카탈로그와 폰의 SSH 인구조사 **양쪽에서
/// 같은 세션을 가리키는 유일한 값**이라, 폰이 두 목록을 이어 붙일 수 있는 근거가
/// 된다.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionPlacement {
    /// 사용자가 만든 최상위 묶음의 이름. 사이드바의 "Workspace" 같은 것.
    pub desktop: String,
    /// 그 안의 저장소/프로젝트 이름. 사이드바의 "agent-ide" 같은 것.
    pub project: String,
    pub title: String,
    /// 화면에서의 순서. 사이드바가 보이는 순서 그대로 폰에 서게 한다.
    pub order: u32,
    /// 이 세션이 올라앉은 git 브랜치. 프론트가 모르면 실어 보내지 않는다.
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub presentation: Option<dure_hub_protocol::catalog::SessionPresentation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: String,
    pub secret_id: Option<String>,
    pub key_path: Option<String>,
}

/// 화면이 내려보낸 배치 전체.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct SidebarLayout {
    /// 세션 id → 그 세션이 사이드바에서 앉아 있는 자리.
    pub placements: HashMap<String, SessionPlacement>,
    /// 데스크탑이 사이드바에 선 순서. 이름만으로는 순서를 알 수 없다.
    pub desktop_order: Vec<String>,
    #[serde(default)]
    pub remote_hosts: Vec<RemoteHost>,
}

impl SidebarLayout {
    /// Overlay UI observations without changing the catalog's runtime identity.
    pub fn present(&self, entry: &mut dure_hub_protocol::catalog::HubCatalogEntry) {
        if let Some(seat) = self.placements.get(&entry.session_id) {
            entry.display_title = Some(seat.title.clone());
            entry.presentation = seat.presentation.clone();
        }
    }
}

/// 지금 배치. Tauri 상태로 관리된다.
///
/// 디스크에 쓰지 않는다. 진실은 화면의 store 에 있고 그쪽이 이미 영속화한다 —
/// 여기서 한 벌 더 저장하면 두 파일이 갈리는 날이 오고, 그때 어느 쪽이 맞는지
/// 아무도 모른다. 앱이 다시 뜨면 화면이 다시 내려보낸다.
#[derive(Default)]
pub struct LayoutState {
    layout: Mutex<SidebarLayout>,
}

impl LayoutState {
    pub fn set(&self, layout: SidebarLayout) {
        if let Ok(mut current) = self.layout.lock() {
            *current = layout;
        }
    }

    #[must_use]
    pub fn get(&self) -> SidebarLayout {
        self.layout
            .lock()
            .map(|layout| layout.clone())
            .unwrap_or_default()
    }

    /// 이 세션이 사이드바 어디에 있는지. 없으면 사이드바에 없는 세션이다.
    #[must_use]
    pub fn placement_of(&self, session_id: &str) -> Option<SessionPlacement> {
        self.layout
            .lock()
            .ok()
            .and_then(|layout| layout.placements.get(session_id).cloned())
    }

    #[must_use]
    pub fn remote_hosts(&self) -> Vec<RemoteHost> {
        self.layout
            .lock()
            .map(|layout| layout.remote_hosts.clone())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn remote_host(&self, box_id: &str) -> Option<RemoteHost> {
        self.layout
            .lock()
            .ok()
            .and_then(|layout| layout.remote_hosts.iter().find(|host| host.id == box_id).cloned())
    }

    /// 카탈로그에 실을 모양으로.
    ///
    /// 화면이 아직 아무것도 안 보냈으면 `None` 이다. **비어 있는 표와 다른
    /// 사실이고**, 폰이 그 둘을 같은 빈 화면으로 그리면 사용자는 자기가 정리한
    /// 것이 사라졌다고 읽는다.
    #[must_use]
    pub fn to_catalog_layout(&self) -> Option<CatalogLayout> {
        let layout = self.layout.lock().ok()?;
        if layout.placements.is_empty() && layout.desktop_order.is_empty() {
            return None;
        }
        Some(CatalogLayout {
            placements: layout
                .placements
                .iter()
                .map(|(session, seat)| {
                    (
                        session.clone(),
                        WirePlacement {
                            desktop: seat.desktop.clone(),
                            project: seat.project.clone(),
                            order: seat.order,
                            branch: seat.branch.clone(),
                        },
                    )
                })
                .collect(),
            desktop_order: layout.desktop_order.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_observations_do_not_change_the_persisted_layout_projection() {
        let state = LayoutState::default();
        let mut seat = placement("Dure", "repo", 0);
        let mut layout = SidebarLayout {
            placements: HashMap::from([("session".into(), seat.clone())]),
            desktop_order: vec!["Dure".into()],
            ..Default::default()
        };
        state.set(layout.clone());
        let before = state.to_catalog_layout();
        seat.presentation = Some(dure_hub_protocol::catalog::SessionPresentation {
            activity_at: Some(1_700_000_000_000),
            ..Default::default()
        });
        layout.placements.insert("session".into(), seat);
        state.set(layout);
        assert_eq!(state.to_catalog_layout(), before);
        assert!(state.placement_of("session").unwrap().presentation.is_some());
    }

    fn placement(desktop: &str, project: &str, order: u32) -> SessionPlacement {
        SessionPlacement {
            desktop: desktop.to_string(),
            project: project.to_string(),
            title: "mobile".to_string(),
            order,
            branch: None,
            presentation: None,
        }
    }

    #[test]
    fn a_session_the_sidebar_placed_is_found_by_id() {
        let state = LayoutState::default();
        state.set(SidebarLayout {
            placements: HashMap::from([("s-1".to_string(), placement("Workspace", "agent-ide", 0))]),
            desktop_order: vec!["Workspace".to_string()],
            remote_hosts: Vec::new(),
        });
        assert_eq!(
            state.placement_of("s-1"),
            Some(placement("Workspace", "agent-ide", 0))
        );
    }

    /// 사이드바에 없는 세션은 자리가 없다. 폰은 그것을 그리지 않는다 — 억지로
    /// 어딘가에 넣으면 정리한 적 없는 것들이 화면 아래에 쌓인다.
    #[test]
    fn a_session_the_sidebar_never_placed_has_no_seat() {
        let state = LayoutState::default();
        state.set(SidebarLayout::default());
        assert_eq!(state.placement_of("s-unknown"), None);
    }

    /// 화면이 다시 내려보내면 통째로 갈린다. 합치지 않는 이유: 사이드바에서 지운
    /// 세션이 합치기 때문에 폰에 남으면, 지운 사람이 그것을 다시 지울 방법이 없다.
    #[test]
    fn a_new_layout_replaces_the_old_one_entirely() {
        let state = LayoutState::default();
        state.set(SidebarLayout {
            placements: HashMap::from([("s-1".to_string(), placement("Workspace", "agent-ide", 0))]),
            desktop_order: vec!["Workspace".to_string()],
            remote_hosts: Vec::new(),
        });
        state.set(SidebarLayout {
            placements: HashMap::from([("s-2".to_string(), placement("Onchain", "Gate1", 0))]),
            desktop_order: vec!["Onchain".to_string()],
            remote_hosts: Vec::new(),
        });
        assert_eq!(state.placement_of("s-1"), None);
        assert_eq!(state.get().desktop_order, vec!["Onchain".to_string()]);
    }
}
