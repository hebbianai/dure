//! 폰이 세션 하나의 변경 파일을 묻고 받는 왕복.
//!
//! # 왜 카탈로그가 아니라 물어보는 길인가
//!
//! 카탈로그는 노트북이 **바뀔 때 미는** 표다. 브랜치는 체크아웃할 때만 움직이니
//! 거기 얹혀 있지만(`catalog.rs` 5판), 변경 파일과 ±줄 수는 저장할 때마다
//! 움직인다. 그것을 미는 길에 얹으면 사람이 파일 하나 저장할 때마다 IPC 한 번과
//! 폰의 파일 쓰기 한 번이 따라온다 — 아무도 폰을 보고 있지 않아도.
//!
//! 그래서 이건 **화면을 열었을 때만** 오가는 요청이다.
//!
//! # 왜 문서가 얇은가
//!
//! 브랜치명을 여기 다시 싣지 않는다. 카탈로그가 이미 말했고, 두 사본을 두면
//! 갈리는 날이 온다 — 그때 폰은 어느 쪽을 믿어야 하는지 모른다. 이 문서는
//! **그 순간의 변경 목록** 하나만 말한다.
//!
//! # 왜 패치 본문이 없는가
//!
//! 파일별 통계는 프레임 한도 안에 든다. 패치 본문은 아니다 — 한 번의 리팩터가
//! 수 메가바이트가 되고, 그건 이 왕복이 감당할 모양이 아니다. 폰이 실제로 diff
//! 를 읽어야 할 때가 오면 그것은 페이지 단위의 별도 왕복이지, 이 문서의 필드가
//! 아니다.

use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// 이 빌드가 말하는 판.
pub const HUB_GIT_STATUS_VERSION: u16 = 1;

/// 변경 목록 프레임 하나의 상한.
///
/// 인사 상한(8 KiB)을 쓰면 안 된다. 그것은 인증 전에 읽는 유일한 프레임을 위한
/// 값이고, 토큰 하나가 들어갈 만큼만 크다. 이 문서는 파일 수만큼 자란다 —
/// 며칠 된 에이전트 브랜치면 100 개를 쉽게 넘고, 그 순간 인코딩이 조용히
/// 실패해서 폰은 "노트북이 아무것도 안 보내고 끊었다"(= 거절의 모양)를 본다.
/// 목록 상한과 같은 이유로 상한 자체는 남는다: 폰은 지문으로 상대가 자기
/// 노트북인 것까지만 알지, 그 앱이 정상인지는 모른다.
pub const MAX_GIT_STATUS_BYTES: usize = 1024 * 1024;

/// 파일 하나의 변경.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitFileChange {
    /// 저장소 뿌리에서의 경로.
    pub path: String,
    /// `git name-status` 의 첫 글자 — A/M/D/R/C/T/U. 모르면 노트북이 "M" 을 준다.
    pub status: String,
    /// 옮겨진 파일의 원래 경로. `R`/`C` 가 아니면 없다.
    ///
    /// 이것 없이 `R` 만 그리면 화면에는 목적지 경로 하나만 남아 추가와 구별되지
    /// 않는다 — 무엇이 어디서 왔는지가 그 줄의 전부인데.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// 더해진 줄. 이진 파일이면 없다 — 0 이 아니라 없음이다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    /// 지워진 줄. 이진 파일이면 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<u32>,
    /// 아직 커밋되지 않은 변경이 이 파일에 있나.
    ///
    /// **`None` 은 거짓이 아니다.** 이 목록은 기준 브랜치와의 비교라, 이미
    /// 커밋된 파일도 계속 들어 있다 — 이 브랜치가 무엇을 바꿨는지에 답하는
    /// 목록이기 때문이다. 커밋하거나 되돌릴 수 있는지는 HEAD 와의 비교가
    /// 답하는 다른 질문이고, 답한 쪽이 그 비교를 하지 않았으면 아무 말도 하지
    /// 않는다.
    ///
    /// 거짓으로 접으면 그 노트북의 모든 줄이 "커밋할 것 없음" 으로 그려지고,
    /// 참으로 접으면 고를 수 없는 것을 고르게 해서 선택 전체가 거절된다.
    /// 그래서 셋을 가른다: 있다 / 없다 / 안 물어봤다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncommitted: Option<bool>,
}

/// 저장소 하나에 대한 이름 붙은 사실들.
///
/// 네 값을 자리로 늘어놓으면 `ahead`/`behind` 와 `base_ref`/`branch` 가 각각 같은
/// 타입이라, 바꿔 넣어도 컴파일이 통과하고 폰에는 2 앞선 브랜치가
/// "0 ahead, 2 behind" 로 뜬다. 이름을 붙여 그 실수를 못 하게 한다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BranchFacts {
    pub branch: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub base_ref: Option<String>,
}

/// 커밋 하나. 화면이 한 줄로 그린다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitCommit {
    /// 짧은 sha. 사람이 알아보는 자리이고, 긴 것은 화면에 안 들어간다.
    pub short_sha: String,
    /// 커밋 메시지의 첫 줄.
    pub subject: String,
    pub author: String,
    /// 사람이 읽는 상대 시각(`git log --date=relative`). 폰이 시계 차이를
    /// 계산하지 않아도 되도록 노트북이 이미 사람 말로 만든 값이다.
    pub when: String,
}

/// 리뷰를 부탁할 수 있는 사람 하나.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitReviewer {
    /// 호스트에서의 로그인. 이것이 신원이다.
    pub login: String,
    /// 사람이 쓰는 이름. 로그인과 다를 수 있고, 없을 수도 있다 — 그때는
    /// 화면이 로그인만 그린다.
    #[serde(default)]
    pub name: String,
}

/// 브랜치 하나. 전환 시트가 한 줄로 그린다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitBranch {
    pub name: String,
    /// 이 워크트리가 지금 올라앉은 브랜치.
    #[serde(default)]
    pub current: bool,
    /// 다른 워크트리가 이 브랜치를 쓰고 있으면 그 경로.
    ///
    /// git 은 같은 브랜치의 두 번째 체크아웃을 거절한다. 화면이 미리 알아야
    /// 누를 수 없게 그릴 수 있고, 어느 워크트리인지 말해야 "고장 났다" 가
    /// "저쪽을 먼저 닫아라" 가 된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_out_at: Option<String>,
    /// 마지막 커밋이 언제였는지, 사람이 읽는 말로. 모르면 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

/// 이 브랜치에 열린 리뷰.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitReview {
    pub number: u64,
    pub title: String,
    /// 호스트가 부르는 그대로 — `OPEN` / `CLOSED` / `MERGED`.
    pub state: String,
    pub url: String,
    #[serde(default)]
    pub is_draft: bool,
    #[serde(default)]
    pub base_ref: String,
    /// 리뷰가 요청된 사람들의 로그인.
    ///
    /// 팀은 여기 없다 — 시트가 고르는 것은 사람이고, 쓰기가 델타로만 오가므로
    /// 목록에 없는 팀은 이 화면이 무엇을 하든 그대로 남는다.
    #[serde(default)]
    pub requested_reviewers: Vec<String>,
    /// 호스트의 리뷰 판정. `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`,
    /// 그리고 아무도 아직 안 본 리뷰는 빈 문자열이다 — 호스트가 부르는 그대로다.
    #[serde(default)]
    pub review_decision: String,
    /// 호스트의 체크가 어떻게 서 있나. 물어보지 못했으면 없다.
    ///
    /// **없음은 "체크가 없음" 이 아니다.** CI 가 없는 저장소는 0개짜리 요약으로
    /// 답하고, 둘을 접으면 못 물어본 질문에 대해 "체크 없음" 이라고 말하게 된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<GitChecks>,
}

/// 리뷰의 체크 요약. 시안(3050:81530)의 "체크 2/2 통과".
///
/// 판정이 아니라 수다. 사람이 원하는 판정은 그가 무엇을 하려는지에 달렸다 —
/// 하나가 아직 도는 3/4 는 기다릴 이유이고, 하나가 실패한 3/4 는 볼 이유다.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitChecks {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    /// 아직 도는 것. 통과도 실패도 아니다.
    #[serde(default)]
    pub pending: u32,
}

/// 세션 하나의 변경 상태.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubGitStatusResult {
    pub hub_git_status_version: u16,
    /// 읽어냈는가. 실패했으면 `files` 는 비어 있고 `detail` 이 이유를 말한다.
    pub read: bool,
    /// 지금 올라앉은 브랜치. 저장소가 아니거나 detached 면 없다.
    ///
    /// 배치표(layout)에도 브랜치가 실리지만 그것은 **캐시**다 — 에이전트 id 로
    /// 색인되어 터미널 pane 을 담지 못하고, 기존 체크아웃에서 만든 에이전트에는
    /// 비어 있으며, 나머지는 만든 시각의 스냅샷이다. 이 값은 파일 목록을 읽은
    /// 그 순간의 git 이다. 물어본 화면은 이쪽을 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// 거절의 종류. 사람이 읽는 `detail` 과 달리 **분기할 수 있는** 값이다.
    ///
    /// 특히 `session_elsewhere`: 이 노트북은 그 세션이 무엇인지 알지만 다른
    /// 컴퓨터에서 돌아서 읽을 수 없다는 뜻이고, 폰에게는 "포기하라" 가 아니라
    /// "그 컴퓨터에 직접 물어라" 라는 뜻이다. 문장으로 판단하면 다음에 문구를
    /// 다듬는 순간 그 폴백이 조용히 사라진다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 변경된 파일들. 저장소인데 깨끗하면 빈 목록이다 — 그것도 답이다.
    #[serde(default)]
    pub files: Vec<GitFileChange>,
    /// 파일 목록을 실제로 물어봤나.
    ///
    /// 탭마다 다른 읽기라, 커밋 탭과 PR 탭의 답은 파일을 싣지 않는다. 그
    /// 빈 목록을 "깨끗하다" 로 읽으면 브랜치 카드가 더러운 워크트리 위에
    /// "0 changed" 라고 쓴다 — 물어보지도 않은 것에 대한 주장이다.
    /// `commits_read`/`review_read` 와 같은 이유로 있다.
    #[serde(default)]
    pub files_read: bool,
    /// 이 브랜치에 열린 리뷰. Pull Request 탭이 물었을 때만 본다.
    ///
    /// **`None` 은 두 가지를 뜻하지 않는다.** 리뷰가 없다는 사실은
    /// `review_read: true` 와 함께 오고, 못 물어봤다는 것은 `detail` 과 함께
    /// 온다 — 그 둘을 한 값으로 접으면 "PR 없음" 이 "gh 로그인 하세요" 를 덮는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<GitReview>,
    /// 리뷰를 실제로 물어봤고 답을 얻었나. `review` 가 없어도 이것이 참이면
    /// "아직 리뷰가 없다" 는 뜻이다.
    #[serde(default)]
    pub review_read: bool,
    /// 기준 브랜치 이후의 커밋들. 커밋 탭이 물었을 때만 채워진다.
    ///
    /// 선택 필드라 판 번호를 올리지 않는다 — 이 값을 모르는 노트북은 빈 목록을
    /// 보내고, 그 사실은 `commits_read` 가 말한다.
    #[serde(default)]
    pub commits: Vec<GitCommit>,
    /// 커밋을 실제로 물어봤고 답을 얻었나. `commits` 가 비어 있어도 이것이
    /// 참이면 "기준 브랜치 이후 커밋이 없다" 는 뜻이다.
    ///
    /// `review_read` 와 같은 이유로 있다. 빈 목록 하나로 두 사실을 나르면,
    /// base 에 그대로 앉은 워크트리(여기서 가장 흔한 상태)가 "노트북이 아직
    /// 안 보냅니다" 로 보인다. 판 번호를 올리지 않는 것도 같은 이유다 — 이
    /// 값을 모르는 노트북은 `false` 를 보내고, 그건 정확히 그 노트북의 사실이다.
    #[serde(default)]
    pub commits_read: bool,
    /// 리뷰를 부탁할 만한 사람들. 리뷰어 시트가 물었을 때만 채워진다.
    #[serde(default)]
    pub reviewers: Vec<GitReviewer>,
    /// 사람 목록을 실제로 물어봤고 답을 얻었나.
    ///
    /// `commits_read` / `branches_read` 와 같은 이유로 있다. 빈 목록은
    /// "함께 커밋한 사람이 없다"(새 저장소에서 실제로 있는 상태)이고,
    /// 못 물어본 것과 다른 사실이다.
    #[serde(default)]
    pub reviewers_read: bool,
    /// 커밋 하나의 메시지 본문. 커밋 상세가 물었을 때만, 그리고 본문이 있을
    /// 때만 온다 — 본문 없는 커밋은 흔하고, 빈 문자열로 접으면 화면이 "본문이
    /// 없다" 와 "아직 안 읽었다" 를 갈라 그릴 수 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_body: Option<String>,
    /// 이 저장소의 브랜치들. 전환 시트가 물었을 때만 채워진다.
    #[serde(default)]
    pub branches: Vec<GitBranch>,
    /// 브랜치를 실제로 물어봤고 답을 얻었나.
    ///
    /// `commits_read` / `review_read` 와 같은 이유로 있다 — 빈 목록 하나로
    /// "브랜치가 없다"(있을 수 없는 상태)와 "이 노트북은 아직 안 보낸다"
    /// 를 함께 나를 수 없다.
    #[serde(default)]
    pub branches_read: bool,
    /// 기준 ref 대비 앞선/뒤진 커밋 수. 노트북이 모르면 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind: Option<u32>,
    /// 어디서 갈라져 나왔는지. 시안의 "main에서 분기".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    /// 읽지 못한 이유. 읽었으면 없다.
    ///
    /// 사람이 읽는 문장이다 — 폰은 그대로 보여준다. 코드로 갈라 화면이 다시
    /// 문장을 짓게 하면 새 실패가 생길 때마다 폰이 낡는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HubGitStatusResult {
    /// 리뷰만 실어 보내는 답.
    ///
    /// `review` 가 없어도 `review_read` 는 참이다 — 물어봤고, 없다는 답을 얻었다.
    #[must_use]
    pub fn read_review(review: Option<GitReview>, facts: BranchFacts) -> Self {
        Self {
            review,
            review_read: true,
            files_read: false,
            ..Self::read(Vec::new(), facts)
        }
    }

    /// 사람 목록만 실어 보내는 답. 파일 목록은 이 질문이 아니다.
    ///
    /// 목록이 비어도 `reviewers_read` 는 참이다 — 물어봤고, 함께 커밋한 사람이
    /// 없다는 답을 얻었다.
    #[must_use]
    pub fn read_reviewers(reviewers: Vec<GitReviewer>, facts: BranchFacts) -> Self {
        Self {
            reviewers,
            reviewers_read: true,
            files_read: false,
            ..Self::read(Vec::new(), facts)
        }
    }

    /// 커밋만 실어 보내는 답. 파일 목록은 이 탭의 질문이 아니다.
    ///
    /// `commits` 가 비어 있어도 `commits_read` 는 참이다 — 물어봤고, 없다는
    /// 답을 얻었다.
    #[must_use]
    pub fn read_commits(commits: Vec<GitCommit>, facts: BranchFacts) -> Self {
        Self {
            commits,
            commits_read: true,
            files_read: false,
            ..Self::read(Vec::new(), facts)
        }
    }

    /// 브랜치만 실어 보내는 답. 파일 목록은 이 질문이 아니다.
    #[must_use]
    pub fn read_branches(branches: Vec<GitBranch>, facts: BranchFacts) -> Self {
        Self {
            branches,
            branches_read: true,
            files_read: false,
            ..Self::read(Vec::new(), facts)
        }
    }

    pub fn read(files: Vec<GitFileChange>, facts: BranchFacts) -> Self {
        Self {
            hub_git_status_version: HUB_GIT_STATUS_VERSION,
            read: true,
            branch: facts.branch,
            code: None,
            review: None,
            review_read: false,
            commits: Vec::new(),
            commits_read: false,
            commit_body: None,
            branches: Vec::new(),
            branches_read: false,
            reviewers: Vec::new(),
            reviewers_read: false,
            files,
            files_read: true,
            ahead: facts.ahead,
            behind: facts.behind,
            base_ref: facts.base_ref,
            detail: None,
        }
    }

    #[must_use]
    pub fn refused(detail: impl Into<String>) -> Self {
        Self {
            commits: Vec::new(),
            commits_read: false,
            commit_body: None,
            branches: Vec::new(),
            branches_read: false,
            reviewers: Vec::new(),
            reviewers_read: false,
            files_read: false,
            review: None,
            review_read: false,
            code: None,
            hub_git_status_version: HUB_GIT_STATUS_VERSION,
            read: false,
            branch: None,
            files: Vec::new(),
            ahead: None,
            behind: None,
            base_ref: None,
            detail: Some(detail.into()),
        }
    }

    /// 목록은 못 읽었지만 브랜치는 읽은 경우.
    ///
    /// 두 읽기는 서로 다른 질문이다 — `git status` 는 지금 어느 브랜치인지,
    /// diffstat 은 무엇이 바뀌었는지. 하나가 실패했다고 다른 하나를 버리면,
    /// 화면은 방금 읽어낸 사실을 들고 있으면서 "브랜치를 아직 받지
    /// 못했습니다" 라고 말하게 된다.
    #[must_use]
    pub fn refused_knowing(detail: impl Into<String>, branch: Option<String>) -> Self {
        Self {
            branch,
            ..Self::refused(detail)
        }
    }

    /// 거절에 분기할 수 있는 종류를 붙인다.
    #[must_use]
    pub fn refused_with_code(
        detail: impl Into<String>,
        code: impl Into<String>,
        branch: Option<String>,
    ) -> Self {
        Self {
            code: Some(code.into()),
            ..Self::refused_knowing(detail, branch)
        }
    }
}

/// 허브 쪽: 결과 하나를 프레임으로.
///
/// # Errors
/// 직렬화가 실패하거나 결과가 프레임 한도를 넘으면.
pub fn encode(result: &HubGitStatusResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_GIT_STATUS_BYTES)
}

/// 폰 쪽: 결과를 읽는다. 모르는 판은 거부한다.
///
/// # Errors
/// 프레임이 깨졌거나, 판이 다르거나, 문서를 읽지 못하면.
pub fn read<R: Read>(reader: &mut R) -> Result<HubGitStatusResult, GitStatusError> {
    let payload = frame::read_bytes(reader, MAX_GIT_STATUS_BYTES)?;
    // 두 번 읽는다. 느슨한 탐침이 먼저 판을 본다 — 엄격한 파싱을 먼저 하면
    // 판이 다른 문서는 "형식 오류" 로 보이고, 그건 사람에게 다른 조치를
    // 뜻한다(한쪽을 갱신하라 vs 버그 신고).
    let probe: VersionProbe = serde_json::from_slice(&payload)
        .map_err(|_| GitStatusError::Frame(FrameError::Malformed("판 번호가 없습니다")))?;
    if probe.hub_git_status_version != HUB_GIT_STATUS_VERSION {
        return Err(GitStatusError::UnsupportedVersion {
            found: probe.hub_git_status_version,
        });
    }
    serde_json::from_slice(&payload)
        .map_err(|_| GitStatusError::Frame(FrameError::Malformed("변경 목록을 읽지 못했습니다")))
}

#[derive(Deserialize)]
struct VersionProbe {
    hub_git_status_version: u16,
}

#[derive(Debug)]
pub enum GitStatusError {
    Frame(FrameError),
    UnsupportedVersion { found: u16 },
}

impl From<FrameError> for GitStatusError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl std::fmt::Display for GitStatusError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 폰이 모르는 변경 목록 판입니다 (기대 {HUB_GIT_STATUS_VERSION}, 받음 {found}). \
                 컴퓨터와 폰 중 한쪽이 낡았습니다"
            ),
        }
    }
}

impl std::error::Error for GitStatusError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_status_round_trips() {
        let result = HubGitStatusResult::read(
            vec![GitFileChange {
                path: "src/app.ts".to_string(),
                status: "M".to_string(),
                old_path: None,
                added: Some(14),
                deleted: Some(3),
                uncommitted: Some(true),
            }],
            BranchFacts {
                branch: Some("fix/payment-retry".to_string()),
                ahead: Some(2),
                behind: Some(0),
                base_ref: Some("main".to_string()),
            },
        );
        let bytes = encode(&result).expect("encode");
        let mut cursor = std::io::Cursor::new(bytes);

        assert_eq!(read(&mut cursor).expect("read"), result);
    }

    /// 깨끗한 저장소는 빈 목록이다 — 못 읽은 것과 다른 사실이다.
    #[test]
    fn a_clean_repository_is_an_empty_list_not_a_refusal() {
        let clean = HubGitStatusResult::read(
            Vec::new(),
            BranchFacts {
                ahead: Some(0),
                behind: Some(0),
                ..BranchFacts::default()
            },
        );

        assert!(clean.read);
        assert!(clean.files.is_empty());
        assert!(clean.detail.is_none());
    }

    /// 이진 파일은 0 줄이 아니라 **모르는** 줄이다.
    #[test]
    fn a_binary_file_has_no_line_counts_rather_than_zero() {
        let result = HubGitStatusResult::read(
            vec![GitFileChange {
                path: "logo.png".to_string(),
                status: "M".to_string(),
                old_path: None,
                added: None,
                deleted: None,
                uncommitted: None,
            }],
            BranchFacts::default(),
        );
        // 봉투의 길이 접두 4바이트는 텍스트가 아니다. 그것까지 UTF-8 로 읽으면
        // 본문이 128바이트를 넘는 순간 접두의 상위 바이트가 비-UTF8 이 되어,
        // 필드 하나를 늘린 것만으로 이 시험이 무너진다.
        let framed = encode(&result).expect("encode");
        let text = String::from_utf8(framed[4..].to_vec()).expect("utf8");

        assert!(
            !text.contains("\"added\""),
            "이진 파일에 줄 수가 실렸다: {text}"
        );
    }

    /// 며칠 된 브랜치의 목록은 인사 상한(8 KiB)을 넘는다. 넘겨서 인코딩이
    /// 실패하면 노트북은 아무것도 안 쓰고 끊고, 폰은 그것을 **거절**로 읽는다 —
    /// 큰 브랜치일 뿐인데.
    #[test]
    fn a_branch_with_hundreds_of_files_still_fits_in_one_frame() {
        let files = (0..400)
            .map(|index| GitFileChange {
                path: format!("src/lib/some/reasonably/deep/path/module-{index}.ts"),
                status: "M".to_string(),
                old_path: None,
                added: Some(120),
                deleted: Some(34),
                uncommitted: Some(true),
            })
            .collect::<Vec<_>>();
        let result = HubGitStatusResult::read(
            files,
            BranchFacts {
                ahead: Some(9),
                behind: Some(0),
                base_ref: Some("main".to_string()),
                ..BranchFacts::default()
            },
        );
        let bytes = encode(&result).expect("큰 목록도 프레임에 들어가야 한다");
        assert!(
            bytes.len() > crate::frame::MAX_HELLO_BYTES,
            "시험이 상한을 못 넘었다"
        );
        let mut cursor = std::io::Cursor::new(bytes);

        assert_eq!(read(&mut cursor).expect("read"), result);
    }

    /// 옮긴 파일은 어디서 왔는지가 그 줄의 전부다.
    #[test]
    fn a_rename_carries_the_path_it_came_from() {
        let result = HubGitStatusResult::read(
            vec![GitFileChange {
                path: "src/lib/hub/gitStatus.ts".to_string(),
                status: "R".to_string(),
                old_path: Some("src/gitStatus.ts".to_string()),
                added: Some(2),
                deleted: Some(0),
                uncommitted: Some(true),
            }],
            BranchFacts::default(),
        );
        let bytes = encode(&result).expect("encode");
        let mut cursor = std::io::Cursor::new(bytes);

        assert_eq!(
            read(&mut cursor).expect("read").files[0]
                .old_path
                .as_deref(),
            Some("src/gitStatus.ts")
        );
    }

    #[test]
    fn an_unknown_version_is_refused_before_the_body_is_trusted() {
        let mut result = HubGitStatusResult::read(Vec::new(), BranchFacts::default());
        result.hub_git_status_version = HUB_GIT_STATUS_VERSION + 1;
        let bytes = encode(&result).expect("encode");
        let mut cursor = std::io::Cursor::new(bytes);

        assert!(matches!(
            read(&mut cursor),
            Err(GitStatusError::UnsupportedVersion { found })
                if found == HUB_GIT_STATUS_VERSION + 1
        ));
    }
}
