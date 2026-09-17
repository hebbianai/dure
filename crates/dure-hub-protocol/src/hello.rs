//! 폰이 붙자마자 주고받는 것.
//!
//! 이 문서는 **TLS 안에서** 흐른다. 핸드셰이크 전에 보내면 평문이고, 폰이 지문
//! 고정을 끝내기 전에 자격증명을 넘기는 것이 된다. 그 순서를 강제하는 것은
//! 리스너(`src-tauri`)와 클라이언트(`mobile/src-tauri`) 각각이고, 이 모듈은
//! 두 쪽이 같은 바이트를 뜻하게만 한다.

use crate::frame::{self, FrameError, MAX_HELLO_BYTES};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// 이 빌드가 말하는 판.
pub const HUB_HELLO_VERSION: u16 = 2;

/// 폰이 보내는 것.
#[derive(Clone, Serialize, Deserialize)]
pub struct HubHello {
    /// 이 형식의 판. 모르는 판은 거부한다.
    pub hub_hello_version: u16,
    /// 기기 토큰. 페어링 때 받은 값.
    pub token: String,
    /// 이 연결이 원하는 일. 목록 요청은 필드를 생략하므로 목록이 기본이다.
    #[serde(default, skip_serializing_if = "HubRequest::is_catalog")]
    pub request: HubRequest,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HubRequest {
    /// Replaces this authenticated device's subscription. None disables push.
    UpdatePushSubscriptionV1 {
        subscription: Option<crate::push::PushSubscription>,
    },
    /// A version-closed operation: old hubs cannot reinterpret a file as another write.
    StageSessionFileV1 {
        session_id: String,
    },
    #[default]
    Catalog,
    Attach {
        writable: bool,
        box_id: String,
    },
    /// 폰이 세션 하나의 변경 파일을 묻는다.
    ///
    /// 카탈로그에 얹지 않고 물어보는 이유는 `git_status.rs` 머리말에 있다 —
    /// 이 값은 저장할 때마다 움직이고, 미는 길에 얹으면 아무도 폰을 보고 있지
    /// 않아도 IPC 가 계속 흐른다.
    GitStatus {
        /// 카탈로그가 준 hmux 세션 id. 폰이 지어낸 값이면 노트북이 못 찾는다.
        session_id: String,
        /// 화면이 지금 보고 있는 것. 없으면 변경 파일이다.
        ///
        /// 탭마다 따로 묻는다. 한 번에 다 읽으면 사용자가 열지도 않은 탭 때문에
        /// 매번 커밋 목록까지 읽게 되고, PR 은 네트워크 왕복이라 그 비용이
        /// 화면을 여는 것 자체에 붙는다.
        #[serde(default)]
        want: GitStatusWant,
    },
    /// 폰이 파일 **하나**의 패치 본문을 묻는다.
    ///
    /// 변경 목록과 따로 묻는 이유는 `file_diff.rs` 머리말에 있다 — 본문은
    /// 프레임 한도에 들지 않고, 목록을 여는 것만으로 아무도 안 열어 본 파일의
    /// 본문까지 건너간다.
    FileDiff {
        session_id: String,
        /// 목록이 이미 준 경로 하나.
        ///
        /// 이 저장소에서 폰의 값이 `git` 의 argv 에 닿는 첫 자리다. 그것을
        /// 안전하게 만드는 것은 문자열 검사가 아니라 출처다 — 답하는 쪽이 먼저
        /// 자기 목록을 읽고, 그 목록에 없는 경로는 거절한다.
        path: String,
        /// 이 커밋 안에서의 변경. 없으면 기준 ref 이후의 아직 안 올린 변경이다.
        ///
        /// 커밋 목록이 준 짧은 sha 를 그대로 돌려보낸다. 받는 쪽은 16진수인지
        /// 확인한 뒤에야 argv 로 만든다 — 16진수는 플래그도 경로도 될 수 없다.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
    },
    /// 폰이 이 브랜치에 리뷰를 열어 달라고 한다.
    ///
    /// 읽기와 한 요청에 섞지 않는다. 이것은 바깥으로 나가는 **쓰기**이고,
    /// 읽기와 같은 모양을 쓰면 언젠가 읽기의 재시도가 리뷰를 하나 더 만든다.
    CreatePullRequest {
        session_id: String,
        title: String,
        body: String,
        #[serde(default)]
        draft: bool,
    },
    /// 폰이 커밋 하나가 무엇을 했는지 묻는다.
    ///
    /// 목록의 `want` 로 두지 않는 이유는 `GitStatus` 문서에 적혀 있다 — 그
    /// 요청의 모양이 "리비전을 이름 짓지 않는다" 는 약속이고, 변경 탭이 아직
    /// 그 약속에 기대고 있다. 그래서 리비전을 싣는 질문은 자기 갈래를 갖는다.
    ///
    /// `commit` 은 커밋 목록이 내놓은 짧은 sha 다. 받는 쪽이 16진수인지 확인한
    /// 뒤에야 argv 가 된다 — 16진수는 플래그도 경로도 범위도 될 수 없다.
    CommitDetail {
        session_id: String,
        commit: String,
    },
    /// 폰이 이 리뷰의 리뷰어를 바꿔 달라고 한다.
    ///
    /// # 왜 `SourceControlWrite` 가 아닌가
    ///
    /// 저 갈래는 **저장소**를 바꾼다 — 커밋, 되돌리기, 브랜치. 리뷰어는 코드
    /// 호스트의 것이고, 성공했을 때 화면이 해야 하는 일도 다르다: 저장소를
    /// 바꾸면 고른 파일 목록이 의미를 잃지만, 리뷰어를 바꾸는 것은 그 선택에
    /// 아무 영향이 없다. 한 갈래에 넣으면 그 차이가 사라진다.
    ///
    /// # 왜 집합이 아니라 더할 사람과 뺄 사람인가
    ///
    /// 호스트의 명령 자체가 더하기와 빼기다. 원하는 집합을 보내면 받는 쪽이
    /// 지금 요청된 사람들을 다시 읽어 차이를 계산해야 하고, 그 사이에 누가 팀을
    /// 하나 붙였다면 이 화면이 그것을 지운다. 델타는 사용자가 화면에서 실제로
    /// 한 일 그대로이고, 목록에 없던 것에는 손대지 않는다.
    SetReviewers {
        session_id: String,
        /// 이 누름의 이름. 끊긴 답 뒤의 재시도가 같은 부탁인 줄 알게 한다.
        action_id: String,
        /// 어느 리뷰인지. 숫자라 플래그가 될 수 없고, 이 노트북이 방금 읽은
        /// 리뷰의 번호다.
        number: u64,
        /// 호스트의 로그인들. 받는 쪽이 모양을 확인한 뒤에야 argv 가 된다.
        add: Vec<String>,
        remove: Vec<String>,
    },
    /// 폰이 저장소를 **바꿔** 달라고 한다.
    ///
    /// # 왜 읽기와 다른 갈래인가
    ///
    /// `CreatePullRequest` 와 같은 이유다 — 읽기와 같은 모양을 쓰면 언젠가
    /// 읽기의 재시도가 커밋을 하나 더 만든다. 그리고 이쪽은 되돌릴 수 없는
    /// 것까지 담는다.
    ///
    /// # 왜 닫힌 갈래 하나인가
    ///
    /// 네 가지 일이 전부 "이 세션의 저장소를 이렇게 바꿔라" 이고, 노트북 쪽에서
    /// 같은 자리(어느 워크트리인지 아는 화면)가 처리한다. 갈래를 넷으로 나누면
    /// 그 배달과 대기 규칙이 네 곳에 생기고, 넷 다 틀렸을 때 조용한 규칙이다.
    ///
    /// 여기 **없는** 것이 요점의 절반이다: push 도, merge 도, rebase 도, reset
    /// 도, 강제 옵션도 없다. 다른 사람의 작업에 닿거나 되돌릴 수 없는 것들이라
    /// 폰의 한 번 누름이 일으킬 일이 아니다.
    SourceControlWrite {
        session_id: String,
        /// 이 **누름**의 이름. `StartAgent` 의 `action_id` 와 같은 값이고 같은
        /// 이유로 있다 — 답이 오는 길이 끊겨 폰이 다시 물었을 때, 노트북이 같은
        /// 누름인 줄 알아야 커밋이 둘 생기지 않는다.
        action_id: String,
        action: SourceControlAction,
    },
    /// 폰이 "새 에이전트" 폼을 열었다. 무엇을 고를 수 있는지 묻는다.
    ///
    /// 목록에 얹지 않고 물어보게 한 이유는 `launch_offer.rs` 머리말에 있다 —
    /// 이 값으로 할 수 있는 일은 켜져 있는 노트북에게 부탁하는 것뿐이라, 꺼진
    /// 노트북의 폴더 목록은 누를 수 없는 화면 하나로만 남는다.
    LaunchOffer,
    /// Read one folder and its immediate child directories on the hub.
    BrowseFolder {
        /// Absence starts at the home directory.
        #[serde(default)]
        path: Option<String>,
    },
    /// Create one immediate child of the current folder.
    CreateFolder {
        parent: String,
        name: String,
    },
    /// 폰이 에이전트를 하나 띄워 달라고 한다.
    StartAgent {
        /// 어느 자리에. `launch_offer` 가 준 값을 그대로 돌려보낸다.
        ///
        /// 폰이 스페이스와 폴더를 따로 들고 조합하지 않는 이유는 위
        /// `Answer` 와 같다 — 폰이 지어낸 이름은 아무 자리에도 닿지 않고, 그
        /// 실패는 "아무 일도 일어나지 않음" 으로만 나타난다.
        target_id: String,
        /// 어느 에이전트로. 역시 `launch_offer` 가 준 id 다.
        kind_id: String,
        /// 이 **누름**의 이름. 위 둘과 달리 폰이 짓는다.
        ///
        /// 규칙을 어기는 것이 아니다. 위 규칙이 막는 것은 폰이 *노트북이 가진
        /// 것*의 이름을 지어내는 일이고, 누름은 폰에서 일어난 사건이라 폰
        /// 말고는 이름 지을 쪽이 없다. 이 값이 필요한 이유는 재시도다: 답이
        /// 오는 길이 끊겨 폰이 다시 물었을 때, 노트북이 같은 누름인 줄 알아야
        /// 에이전트가 둘 뜨지 않는다.
        action_id: String,
        /// 새 worktree 에서 시작할 것인가.
        ///
        /// 기본이 참인 이유: 그것이 화면의 기본값이고, 이 값을 말하지 않는 폰은
        /// 그 화면을 아직 모르는 폰이다. 거짓을 기본으로 두면 그런 폰이 사람의
        /// 체크아웃 안에서 에이전트를 돌리게 되는데, 그건 조용한 쪽이 아니라
        /// 위험한 쪽이다.
        #[serde(default = "worktree_by_default")]
        use_worktree: bool,
        /// 그 worktree 의 브랜치. 없으면 노트북이 에이전트 이름에서 짓는다.
        ///
        /// 폰이 정하게 두는 것이 `target_id` 규칙과 어긋나지 않는 이유: 이것은
        /// 노트북이 **가진** 것의 이름이 아니라 앞으로 만들 것의 이름이고,
        /// 만들 것의 이름을 짓는 쪽은 그것을 주문한 사람이다.
        #[serde(default)]
        branch: Option<String>,
    },
    /// Start an agent in a local folder just selected outside the offer.
    ///
    /// This is not an optional `StartAgent` field: an old hub would ignore the
    /// field and start in the old registered folder, while an unknown variant
    /// is safely refused.
    StartAgentInFolder {
        /// An existing seat used only to identify the space.
        target_id: String,
        folder_path: String,
        kind_id: String,
        action_id: String,
        #[serde(default = "worktree_by_default")]
        use_worktree: bool,
        #[serde(default)]
        branch: Option<String>,
    },
    /// 이 노트북이 모르는 요청.
    ///
    /// # 왜 갈래가 하나 더 있는가
    ///
    /// 이것이 없으면 새 폰이 옛 노트북에 새 질문을 했을 때, 문서가 **깨진 것**
    /// 으로 읽혀 노트북이 한 바이트도 안 쓰고 끊는다. 폰은 그 침묵을 거절로
    /// 읽고 "이 기기가 컴퓨터에서 취소되었거나 등록되어 있지 않습니다. 다시
    /// 페어링하세요" 라고 말한다 — 사람을 책상까지 걸어가게 만드는 문장인데,
    /// 사실은 그 노트북이 아직 이 질문을 모른다는 것뿐이다.
    ///
    /// `serde(other)` 는 태그가 붙은 갈래에만 쓸 수 있고 자리를 갖지 못하므로,
    /// 무엇을 물었는지는 여기 남지 않는다. 그래도 된다 — 노트북이 할 수 있는
    /// 말은 어차피 "모른다" 하나다.
    #[serde(other)]
    Unsupported,
}

/// 폰이 부탁할 수 있는 저장소 변경, 전부.
///
/// 닫힌 갈래다. 문자열로 두면 노트북 쪽 어딘가에서 그 글자를 서브커맨드로
/// 옮기는 표가 생기고, 그 표에 한 줄을 더하는 것이 이 목록을 늘리는 것보다
/// 쉬워진다 — 그 쉬움이 바로 이 모양이 막으려는 것이다.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceControlAction {
    /// 고른 파일들만 커밋한다.
    Commit {
        /// 목록이 준 경로들. 받는 쪽이 자기 목록과 맞춰 보고, 하나라도 없으면
        /// 전부 거절한다.
        paths: Vec<String>,
        /// 사람이 쓴 메시지. 받는 쪽은 이것을 argv 가 아니라 stdin 으로 넘긴다.
        message: String,
    },
    /// 고른 파일들의 변경을 버린다. **되돌릴 수 없다** — 화면이 확인을 받은
    /// 뒤에만 보낸다.
    Discard { paths: Vec<String> },
    /// 이미 있는 브랜치로 갈아탄다.
    Checkout { branch: String },
    /// 지금 자리에서 브랜치를 새로 만들고 갈아탄다.
    CreateBranch { name: String },
    /// 지금 브랜치를 업스트림으로 올린다.
    ///
    /// 자리를 갖지 않는 이유: 무엇을 올릴지는 세션이 서 있는 워크트리가 이미
    /// 말한다. 브랜치 이름을 여기 실으면 폰이 고른 이름과 그 워크트리가 실제로
    /// 올라탄 브랜치가 갈릴 수 있고, 그 갈림은 남의 브랜치를 올리는 것으로만
    /// 드러난다.
    Push,
}

/// 판을 모르는 폰이 보내지 않은 `use_worktree` 의 기본값.
fn worktree_by_default() -> bool {
    true
}

/// 소스 컨트롤 화면의 어느 탭이 물었나.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitStatusWant {
    /// 바뀐 파일들. 화면을 열면 처음 보이는 것이라 기본값이다.
    #[default]
    Changes,
    /// 기준 브랜치 이후의 커밋들.
    Commits,
    /// 이 브랜치에 열린 리뷰.
    PullRequest,
    /// 리뷰를 부탁할 만한 사람들. 리뷰어 시트가 열릴 때만 묻는다.
    ///
    /// 브랜치와 같은 이유로 목록에 얹지 않는다 — 이 값은 호스트에 네트워크로
    /// 물어야 하고, PR 탭을 여는 것만으로 그 왕복이 붙어서는 안 된다.
    Reviewers,
    /// 이 저장소의 브랜치들. 전환 시트가 열릴 때만 묻는다.
    ///
    /// 목록과 달리 이 값은 체크아웃할 때만 움직인다. 그래서 화면을 여는 것에는
    /// 얹지 않고, 시트를 여는 그 순간에만 읽는다.
    Branches,
}

impl HubRequest {
    fn is_catalog(&self) -> bool {
        matches!(self, Self::Catalog)
    }
}

/// 토큰을 찍지 않는다.
///
/// `#[derive(Debug)]` 였다면 이 구조체를 로그에 넣는 순간 기기 토큰이 함께
/// 나간다 — 그 값을 가진 쪽은 이 폰인 척할 수 있다. `HubCertificate` 가 개인키에
/// 대해 같은 것을 하는 이유와 같다.
impl std::fmt::Debug for HubHello {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HubHello")
            .field("hub_hello_version", &self.hub_hello_version)
            .field("token", &"<가려짐>")
            .field("request", &self.request)
            .finish()
    }
}

/// 허브가 돌려주는 것. 받아들였을 때만 보낸다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubHelloAck {
    pub hub_hello_version: u16,
    /// 붙은 기기의 id. 폰이 자기가 누구로 인식됐는지 확인할 수 있게.
    pub device_id: String,
    pub device_label: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HelloError {
    Frame(FrameError),
    /// 상대가 이 빌드가 모르는 판을 말한다.
    UnsupportedVersion {
        found: u16,
    },
}

impl std::fmt::Display for HelloError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 빌드가 말하지 않는 판입니다: {found} (이 빌드는 {HUB_HELLO_VERSION})"
            ),
        }
    }
}

impl std::error::Error for HelloError {}

impl From<FrameError> for HelloError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

/// 폰 쪽: 인사 하나를 프레임으로.
pub fn encode_hello(token: &str) -> Result<Vec<u8>, FrameError> {
    encode_hello_for(token, HubRequest::Catalog)
}

pub fn encode_hello_for(token: &str, request: HubRequest) -> Result<Vec<u8>, FrameError> {
    frame::encode(
        &HubHello {
            hub_hello_version: HUB_HELLO_VERSION,
            token: token.to_string(),
            request,
        },
        MAX_HELLO_BYTES,
    )
}

/// 허브 쪽: 인사를 읽는다. **토큰을 검사하지는 않는다** — 그 판단은 등록된
/// 기기 목록을 아는 쪽의 것이고, 이 크레이트는 그 목록을 모른다.
pub fn read_hello<R: Read>(reader: &mut R) -> Result<HubHello, HelloError> {
    let payload = frame::read_bytes(reader, MAX_HELLO_BYTES)?;
    decode_versioned(&payload, |probe: &VersionProbe| probe.hub_hello_version)
}

/// 판만 먼저 읽는 조각.
///
/// 이름 없는 필드는 무시된다(serde 기본값). 그래서 이 구조체는 **어떤 판의
/// 문서에서도** 판 번호를 꺼낼 수 있고, 그것이 요점이다 — 엄격한 역직렬화가
/// 먼저 오면 필드가 바뀐 판은 "JSON 이 아닙니다" 로 떨어지고, 판 번호를 둔
/// 이유가 사라진다.
#[derive(Deserialize)]
struct VersionProbe {
    hub_hello_version: u16,
}

fn decode_versioned<T: serde::de::DeserializeOwned>(
    payload: &[u8],
    version_of: impl Fn(&VersionProbe) -> u16,
) -> Result<T, HelloError> {
    let probe: VersionProbe = serde_json::from_slice(payload)
        .map_err(|_| HelloError::Frame(FrameError::Malformed("판 번호가 없습니다")))?;
    let found = version_of(&probe);
    if found != HUB_HELLO_VERSION {
        return Err(HelloError::UnsupportedVersion { found });
    }
    serde_json::from_slice(payload)
        .map_err(|_| HelloError::Frame(FrameError::Malformed("이 판의 JSON 이 아닙니다")))
}

/// 허브 쪽: 받아들였다고 답한다.
pub fn encode_ack(device_id: &str, device_label: &str) -> Result<Vec<u8>, FrameError> {
    frame::encode(
        &HubHelloAck {
            hub_hello_version: HUB_HELLO_VERSION,
            device_id: device_id.to_string(),
            device_label: device_label.to_string(),
        },
        MAX_HELLO_BYTES,
    )
}

/// 폰 쪽: 답을 읽는다.
pub fn read_ack<R: Read>(reader: &mut R) -> Result<HubHelloAck, HelloError> {
    let payload = frame::read_bytes(reader, MAX_HELLO_BYTES)?;
    decode_versioned(&payload, |probe: &VersionProbe| probe.hub_hello_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trips_between_the_two_halves() {
        let framed = encode_hello("token-1").expect("encodes");
        let hello = read_hello(&mut framed.as_slice()).expect("reads");
        assert_eq!(hello.token, "token-1");
        assert_eq!(hello.hub_hello_version, HUB_HELLO_VERSION);
        assert_eq!(hello.request, HubRequest::Catalog);
    }

    #[test]
    fn attach_request_round_trips_without_changing_the_auth_boundary() {
        let request = HubRequest::Attach {
            writable: true,
            box_id: "gate1".to_string(),
        };
        let framed = encode_hello_for("token-1", request.clone()).expect("encodes");
        let hello = read_hello(&mut framed.as_slice()).expect("reads");
        assert_eq!(hello.token, "token-1");
        assert_eq!(hello.request, request);
    }

    #[test]
    fn a_browsed_folder_launch_is_not_an_old_launch_with_ignored_fields() {
        let request = HubRequest::StartAgentInFolder {
            target_id: "space old-folder".to_string(),
            folder_path: "/Users/me/new-folder".to_string(),
            kind_id: "claude".to_string(),
            action_id: "press-1".to_string(),
            use_worktree: true,
            branch: Some("agent/new-folder".to_string()),
        };
        let framed = encode_hello_for("token-1", request.clone()).expect("encodes");
        let hello = read_hello(&mut framed.as_slice()).expect("reads");

        assert_eq!(hello.request, request);
    }

    #[test]
    fn ack_round_trips_between_the_two_halves() {
        let framed = encode_ack("device-1", "내 아이폰").expect("encodes");
        let ack = read_ack(&mut framed.as_slice()).expect("reads");
        assert_eq!(
            ack,
            HubHelloAck {
                hub_hello_version: HUB_HELLO_VERSION,
                device_id: "device-1".to_string(),
                device_label: "내 아이폰".to_string(),
            }
        );
    }

    #[test]
    fn rejects_a_version_this_build_does_not_speak() {
        let framed = frame::encode(
            &HubHello {
                hub_hello_version: HUB_HELLO_VERSION + 1,
                token: "token-1".to_string(),
                request: HubRequest::Catalog,
            },
            MAX_HELLO_BYTES,
        )
        .expect("encodes");
        assert_eq!(
            read_hello(&mut framed.as_slice()).expect_err("unsupported"),
            HelloError::UnsupportedVersion {
                found: HUB_HELLO_VERSION + 1
            }
        );
    }

    #[test]
    fn ack_rejects_a_version_this_build_does_not_speak() {
        let framed = frame::encode(
            &HubHelloAck {
                hub_hello_version: HUB_HELLO_VERSION + 1,
                device_id: "device-1".to_string(),
                device_label: "내 아이폰".to_string(),
            },
            MAX_HELLO_BYTES,
        )
        .expect("encodes");
        assert!(matches!(
            read_ack(&mut framed.as_slice()),
            Err(HelloError::UnsupportedVersion { .. })
        ));
    }

    /// 토큰이 `Debug` 로 새지 않는다는 것.
    #[test]
    fn debug_withholds_the_token() {
        let hello = HubHello {
            hub_hello_version: HUB_HELLO_VERSION,
            token: "s3cret-token".to_string(),
            request: HubRequest::Attach {
                writable: true,
                box_id: "this-laptop".to_string(),
            },
        };
        let rendered = format!("{hello:?}");
        assert!(!rendered.contains("s3cret-token"), "{rendered}");
    }

    /// 모르는 질문은 깨진 문서가 아니다.
    ///
    /// 이 갈래가 없던 동안, 새 폰이 옛 노트북에 새 질문을 하면 문서가 깨진
    /// 것으로 읽혀 노트북이 한 바이트도 안 쓰고 끊었고, 폰은 그 침묵을 거절로
    /// 읽어 "다시 페어링하세요" 라고 말했다 — 사람을 책상까지 걸어가게 만드는
    /// 문장인데 사실은 그 노트북이 아직 그 질문을 모른다는 것뿐이다.
    #[test]
    fn a_question_this_build_does_not_know_is_read_as_unsupported() {
        let hello: HubHello = serde_json::from_value(serde_json::json!({
            "hub_hello_version": HUB_HELLO_VERSION,
            "device": { "device_id": "d-1", "device_label": "폰", "public_key": "k" },
            "token": "t",
            // 이 빌드가 모르는 이름이어야 한다. 언젠가 배울 이름을 쓰면, 그
            // 이름을 배우는 날 이 시험은 "모르는 질문" 을 시험하지 않게 된다.
            "request": { "kind": "a_question_from_a_later_build", "whatever": true },
        }))
        .expect("모르는 질문도 문서는 읽힌다");

        assert_eq!(hello.request, HubRequest::Unsupported);
    }

    /// 아는 질문은 그대로 읽힌다 — 위의 갈래가 모든 것을 삼키면 안 된다.
    #[test]
    fn a_question_this_build_knows_is_still_itself() {
        let hello: HubHello = serde_json::from_value(serde_json::json!({
            "hub_hello_version": HUB_HELLO_VERSION,
            "device": { "device_id": "d-1", "device_label": "폰", "public_key": "k" },
            "token": "t",
            "request": { "kind": "attach", "writable": true, "box_id": "b-1" },
        }))
        .expect("아는 질문");

        assert_eq!(
            hello.request,
            HubRequest::Attach {
                writable: true,
                box_id: "b-1".to_string()
            }
        );
    }
}
