//! 폰이 띄워 달라고 한 에이전트를, 띄울 수 있는 유일한 곳까지 나르고 결과를
//! 기다린다.
//!
//! # 왜 여기서 띄우지 않나
//!
//! [`super::git_status`] 와 같은 이유이고, 여기서는 더 강하다. 에이전트를 띄우는
//! 길은 화면이 들고 있는 저널과 스폰 사가다 — 요청을 디스크에 먼저 적고, 그
//! 영수증으로 실행하고, 워크트리를 확보하고, 판을 등록한다. Rust 에 그 절차를 한
//! 벌 더 만들면 두 벌이 갈리는 날 사람은 **에이전트 둘**을 얻는다.
//!
//! # 왜 이 왕복만 누름의 이름을 나르나
//!
//! 다른 왕복은 읽기다. 이것은 쓰기라서, 답이 오는 길이 끊겼을 때 폰이 다시 묻는
//! 것과 사람이 한 번 더 누른 것을 갈라야 한다. 그 이름이 `action_id` 이고, 그것을
//! 짓는 쪽은 폰이다 — 누름은 폰에서 일어난 사건이라 다른 쪽은 이름 지을 수 없다.

use dure_hub_protocol::start_agent::HubStartAgentResult;
use serde::Serialize;

/// 폰이 물어본 내용 그대로.
#[derive(Clone, Debug, Serialize)]
pub struct StartAgentRequest {
    /// 어느 자리에. `launch_offer` 가 준 값이다.
    pub target_id: String,
    /// 어느 에이전트로. 역시 `launch_offer` 가 준 값이다.
    pub kind_id: String,
    /// 이 누름의 이름. 재시도를 같은 누름으로 알아보는 데 쓴다.
    pub action_id: String,
    /// 새 worktree 에서 시작할 것인가.
    pub use_worktree: bool,
    /// 그 worktree 의 브랜치. 없으면 화면이 에이전트 이름에서 짓는다.
    pub branch: Option<String>,
    /// A local folder just selected outside the offer; absent uses `target_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
}

/// 에이전트를 띄워 줄 수 있는 쪽에게 넘기고, 결과를 기다리는 길.
pub trait StartAgentSink: Send + Sync {
    fn deliver(&self, request: StartAgentRequest) -> HubStartAgentResult;
}

/// 아직 화면의 답을 기다리는 왕복들. 규칙은 [`super::roundtrip`] 한 벌이다.
pub type PendingStartAgent = super::roundtrip::PendingRoundTrips<HubStartAgentResult>;

impl super::roundtrip::RoundTrip for HubStartAgentResult {
    const PREFIX: &'static str = "start-agent";
    const EVENT: &'static str = "hub://start-agent";

    fn undeliverable() -> Self {
        Self::refused_with_code(
            "Could not forward the request to the desktop client",
            "screen_unreachable",
        )
    }

    /// # 왜 마감이 실패인가, 그리고 왜 그 코드가 따로인가
    ///
    /// 이 왕복은 다른 것들보다 오래 걸린다 — 기준 커밋을 읽고, 백엔드에 프로젝트를
    /// 등록하고, 그제야 띄운다. 마감을 넘겼다는 것은 **안 떴다는 뜻이 아니라 모른다는
    /// 뜻**이고, 그 둘은 사람이 할 일이 다르다: 안 떴으면 다시 누르면 되고, 모르면
    /// 목록을 보고 확인해야 한다. 폰이 이 코드를 보고 같은 `action_id` 로 다시
    /// 물으면, 화면은 그것이 같은 누름인 줄 알아본다.
    fn timed_out() -> Self {
        Self::refused_with_code(
            "The desktop client did not respond in time. Check the list",
            "screen_silent",
        )
    }
}

/// 화면이 내려보낸 "지금 띄울 수 있는 자리와 종류".
///
/// [`super::layout::LayoutState`] 와 같은 모양이고 같은 이유다 — 화면이 통째로
/// 갈아 끼우고, 허브는 물어보는 그 순간의 사본을 읽는다. 합치려 들면 목록에서
/// 지운 폴더를 폰에서 지울 방법이 없어진다.
///
/// 처음에는 **아직 안 보냄** 이다. 빈 목록과 갈라 두는 이유는
/// `launch_offer::HubLaunchOffer::published` 에 있다: 방금 켜진 노트북과 폴더가
/// 하나도 없는 노트북은 사람이 할 일이 다르다.
#[derive(Default)]
pub struct LaunchOfferState {
    offer: std::sync::Mutex<Option<dure_hub_protocol::launch_offer::HubLaunchOffer>>,
}

impl LaunchOfferState {
    pub fn set(&self, offer: dure_hub_protocol::launch_offer::HubLaunchOffer) {
        if let Ok(mut current) = self.offer.lock() {
            *current = Some(offer);
        }
    }

    #[must_use]
    pub fn get(&self) -> dure_hub_protocol::launch_offer::HubLaunchOffer {
        self.offer
            .lock()
            .ok()
            .and_then(|offer| offer.clone())
            .unwrap_or_else(dure_hub_protocol::launch_offer::HubLaunchOffer::unpublished)
    }
}
