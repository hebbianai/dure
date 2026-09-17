//! 폰이 눌러 본 파일 하나의 패치를, 그것을 아는 유일한 곳까지 나르고 결과를
//! 기다린다.
//!
//! # 왜 여기서 읽지 않나
//!
//! [`super::git_status`] 와 같은 이유다 — 폰이 보내는 것은 hmux 세션 id 이고,
//! 그 id 를 워크트리 경로로 옮기는 표는 화면이 들고 있다. 여기 한 벌을 더 두면
//! 두 벌이 갈리는 날 폰은 다른 저장소의 패치를 보게 되고, 그 화면은 정상으로
//! 보인다.
//!
//! # 경로는 폰이 고르고, 무엇을 고를 수 있는지는 저장소가 정한다
//!
//! 이 요청에는 폰이 고른 경로가 실린다. 그것을 안전하게 만드는 것은 여기서의
//! 문자열 검사가 아니라 답하는 쪽의 규칙이다: 화면이 먼저 그 워크트리의 변경
//! 목록을 읽고, 목록에 없는 경로는 거절한다(`fileDiffBridge.ts`). 이 모듈이
//! 하는 일은 배달과 대기뿐이다.

use dure_hub_protocol::HubFileDiffResult;
use serde::Serialize;

/// 폰이 물어본 내용 그대로.
#[derive(Clone, Debug, Serialize)]
pub struct FileDiffRequest {
    pub session_id: String,
    /// 목록이 이미 준 경로 하나.
    pub path: String,
    /// 이 커밋 안에서의 변경. 없으면 아직 커밋되지 않은 것과의 비교다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// 패치를 읽어 줄 수 있는 쪽에게 넘기고 결과를 기다리는 길.
pub trait FileDiffSink: Send + Sync {
    fn deliver(&self, request: FileDiffRequest) -> HubFileDiffResult;
}

/// 아직 화면의 답을 기다리는 왕복들. 규칙은 [`super::roundtrip`] 한 벌이다.
pub type PendingFileDiff = super::roundtrip::PendingRoundTrips<HubFileDiffResult>;

impl super::roundtrip::RoundTrip for HubFileDiffResult {
    const PREFIX: &'static str = "file-diff";
    const EVENT: &'static str = "hub://file-diff";

    fn undeliverable() -> Self {
        // 경로를 모른다 — 화면에 닿지도 못했으므로 요청이 무엇이었는지 이
        // 자리에서는 알 수 없다. 빈 경로는 폰이 자기 요청과 못 맞춘다는 뜻이고,
        // 그건 정확히 이 경우의 사실이다.
        Self::refused(String::new(), "Could not forward the request to the desktop client")
    }

    fn timed_out() -> Self {
        Self::refused(String::new(), "The desktop client did not return the patch")
    }
}
