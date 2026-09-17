//! 폰이 물어본 변경 파일을, 그것을 아는 유일한 곳까지 나르고 결과를 기다린다.
//!
//! # 왜 여기서 읽지 않나
//!
//! Rust 쪽에 `git status` 를 부를 수단은 있다. 그런데 폰이 보내는 것은 **hmux
//! 세션 id** 이고, 그 id 를 워크트리 경로로 옮기는 표는 화면이 들고 있다 —
//! 에이전트·프로젝트·space 는 전부 앱의 개념이다. 같은 대응을 Rust 에 한 벌 더
//! 만들면 두 벌이 갈리는 날 폰은 **다른 저장소의 변경 목록**을 보게 되고, 그
//! 화면은 정상으로 보인다.
//!
//! 그래서 이 모듈은 화면까지 배달하고 결과를 기다린다. 어느
//! 저장소인지 아는 것은 화면의 몫이다.

use dure_hub_protocol::HubGitStatusResult;
use serde::Serialize;

/// 폰이 물어본 내용 그대로.
#[derive(Clone, Debug, Serialize)]
pub struct GitStatusRequest {
    pub session_id: String,
    /// 어느 탭이 물었나. 화면이 그에 맞는 읽기만 한다.
    pub want: dure_hub_protocol::hello::GitStatusWant,
    /// 읽기인가, 아니면 무엇을 바꿔 달라는 것인가.
    #[serde(flatten)]
    pub intent: GitStatusIntent,
}

/// 이 왕복이 실제로 부탁하는 일.
///
/// 갈래 하나로 두는 이유: 예전에는 `create: Option<..>` 하나가 "리뷰를 열어라"
/// 를 뜻했고, 쓰기가 늘어날 때마다 그런 선택 필드가 하나씩 늘 예정이었다.
/// 그러면 두 개가 함께 채워진 문서가 타입상 가능해지고, 그때 무슨 일이
/// 일어나는지는 아무 곳에도 적혀 있지 않다.
///
/// 왕복 표는 여전히 하나다 — 답이 전부 [`HubGitStatusResult`] 이기 때문이다.
/// 쓰기의 답은 **바뀐 뒤의 상태**이고, 그래야 화면이 한 번 더 묻지 않는다.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "intent", rename_all = "snake_case")]
pub enum GitStatusIntent {
    /// 그냥 읽는다.
    Read,
    /// 이 브랜치에 리뷰를 연다. 바깥으로 나가는 유일한 쓰기다.
    CreateReview { title: String, body: String, draft: bool },
    /// 커밋 하나가 무엇을 했는지 읽는다. 목록에 없던 본문과 파일들.
    CommitDetail { commit: String },
    /// 이 리뷰의 리뷰어를 바꾼다. 더할 사람과 뺄 사람만.
    ///
    /// 저장소를 바꾸는 `Write` 와 나뉘어 있는 이유는 `hello.rs` 의
    /// `SetReviewers` 에 있다 — 성공했을 때 화면이 해야 하는 일이 다르다.
    SetReviewers {
        action_id: String,
        number: u64,
        add: Vec<String>,
        remove: Vec<String>,
    },
    /// 저장소를 바꾼다. 무엇을 바꾸는지는 닫힌 갈래가 말한다.
    Write {
        /// 이 누름의 이름. 끊긴 답 뒤의 재시도가 커밋을 둘 만들지 않게 한다.
        action_id: String,
        action: dure_hub_protocol::hello::SourceControlAction,
    },
}

/// 변경 목록을 읽어 줄 수 있는 쪽에게 넘기고, 결과를 기다리는 길.
///
/// 트레이트인 이유는 리스너를 Tauri 없이
/// 시험할 수 있어야 하고, 이 왕복의 실패 경로(응답 없음)를 시험이 직접 만들 수
/// 있어야 한다.
pub trait GitStatusSink: Send + Sync {
    fn deliver(&self, request: GitStatusRequest) -> HubGitStatusResult;
}

/// 아직 화면의 답을 기다리는 왕복들. 규칙은 [`super::roundtrip`] 한 벌이다.
pub type PendingGitStatus = super::roundtrip::PendingRoundTrips<HubGitStatusResult>;

impl super::roundtrip::RoundTrip for HubGitStatusResult {
    const PREFIX: &'static str = "git-status";
    const EVENT: &'static str = "hub://git-status";

    fn undeliverable() -> Self {
        Self::refused("Could not forward the request to the desktop client")
    }

    fn timed_out() -> Self {
        Self::refused("The desktop client did not return the change list")
    }
}
