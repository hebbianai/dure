//! 폰이 파일 **하나**의 패치 본문을 묻고 받는 왕복.
//!
//! # 왜 변경 목록과 같은 문서에 싣지 않나
//!
//! `git_status.rs` 머리말이 그 이유를 미리 적어 두었다: 파일별 통계는 프레임
//! 한도 안에 들지만 패치 본문은 아니다. 한 번의 리팩터가 수 메가바이트가 되고,
//! 목록을 여는 것만으로 그 값을 실어 보내면 아무도 열어 보지 않은 파일의
//! 본문까지 매번 건너간다.
//!
//! 그래서 이건 **줄 하나를 눌렀을 때만** 오가는 요청이다. 목록은 무엇이
//! 바뀌었는지 말하고, 이 문서는 그중 한 파일이 어떻게 바뀌었는지 말한다.
//!
//! # 무엇이 경로를 안전하게 만드나
//!
//! 이 요청에는 폰이 고른 경로가 실린다 — 이 저장소에서 폰의 값이 `git` 의
//! argv 에 닿는 첫 자리다. 그것을 안전하게 만드는 것은 문자열 검사가 아니라
//! **출처**다: 답하는 쪽이 먼저 자기 변경 목록을 읽고, 그 목록에 없는 경로는
//! 거절한다. 폰은 고르기만 하고, 무엇을 고를 수 있는지는 저장소가 정한다.
//!
//! `commit` 도 같은 규칙이다. 커밋 목록이 준 짧은 sha 를 그대로 돌려보내고,
//! 답하는 쪽은 그것이 16진수인지 확인한 뒤에야 argv 로 만든다 — 16진수는
//! 플래그가 될 수 없고 경로가 될 수도 없다.

use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// 이 빌드가 말하는 판.
pub const HUB_FILE_DIFF_VERSION: u16 = 1;

/// 패치 프레임 하나의 상한.
///
/// 목록 문서(1 MiB)보다 크다. 목록은 파일 **수**만큼 자라지만 이 문서는 파일
/// **하나**의 본문이라, 큰 생성 파일 하나가 목록 전체보다 크다. 상한이 남아
/// 있는 이유는 목록과 같다 — 폰은 상대가 자기 노트북인 것까지만 알지, 그 앱이
/// 정상인지는 모른다.
pub const MAX_FILE_DIFF_BYTES: usize = 4 * 1024 * 1024;

/// 본문 자체의 상한. 프레임 상한보다 작다 — 나머지 필드와 JSON 이스케이프가
/// 들어갈 자리를 남긴다.
///
/// 넘으면 잘라 보내고 [`HubFileDiffResult::truncated`] 가 그렇다고 말한다.
/// 조용히 자르면 화면은 파일의 끝을 본 줄 알고, 그건 이 화면이 답해야 하는
/// 질문("전부 봤나")에 틀린 답을 하는 것이다.
pub const MAX_PATCH_BYTES: usize = 1024 * 1024;

/// 파일 하나의 패치.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubFileDiffResult {
    pub hub_file_diff_version: u16,
    /// 읽어냈는가. 실패했으면 `patch` 가 없고 `detail` 이 이유를 말한다.
    pub read: bool,
    /// 물어본 경로 그대로. 화면이 답과 줄을 맞출 수 있게 되돌려 준다.
    #[serde(default)]
    pub path: String,
    /// 통합 diff 본문. `git diff` 가 낸 그대로 — `diff --git` 머리와 `@@` 조각이
    /// 다 들어 있다.
    ///
    /// 이진 파일이면 없다. 빈 문자열이 아니다: 빈 본문은 "바뀐 게 없다" 이고,
    /// 이진 파일은 "본문으로 말할 수 없다" 다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    /// 본문이 상한에 걸려 잘렸나.
    #[serde(default)]
    pub truncated: bool,
    /// 이진 파일인가. 참이면 `patch` 는 없고, 그것은 실패가 아니다.
    #[serde(default)]
    pub binary: bool,
    /// 더해진/지워진 줄. 목록이 이미 말했지만, 이 화면은 목록 없이도 열릴 수
    /// 있다(커밋 상세에서 온 경우). 모르면 없다 — 0 이 아니다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<u32>,
    /// 거절의 종류. 사람이 읽는 `detail` 과 달리 **분기할 수 있는** 값이다.
    /// `git_status.rs` 의 `code` 와 같은 뜻이고 같은 낱말을 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 읽지 못한 이유. 사람이 읽는 문장이고 폰은 그대로 보여준다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HubFileDiffResult {
    /// 본문을 실어 보내는 답. 상한을 넘으면 여기서 자른다.
    ///
    /// 자르는 자리는 줄 경계다. `@@` 조각 한가운데를 자르면 화면은 반쪽 줄을
    /// 그리고, 그 줄은 저장소에 없는 내용이 된다.
    #[must_use]
    pub fn read(path: impl Into<String>, patch: String) -> Self {
        let (patch, truncated) = truncate_on_line_boundary(patch);
        Self {
            hub_file_diff_version: HUB_FILE_DIFF_VERSION,
            read: true,
            path: path.into(),
            patch: Some(patch),
            truncated,
            ..Self::default()
        }
    }

    /// 이진 파일. 읽기는 성공했고, 본문으로 말할 것이 없다.
    #[must_use]
    pub fn binary(path: impl Into<String>) -> Self {
        Self {
            hub_file_diff_version: HUB_FILE_DIFF_VERSION,
            read: true,
            path: path.into(),
            binary: true,
            ..Self::default()
        }
    }

    /// ± 줄 수를 붙인다. 모르면 부르지 않는다.
    #[must_use]
    pub fn with_counts(mut self, added: Option<u32>, deleted: Option<u32>) -> Self {
        self.added = added;
        self.deleted = deleted;
        self
    }

    #[must_use]
    pub fn refused(path: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            hub_file_diff_version: HUB_FILE_DIFF_VERSION,
            read: false,
            path: path.into(),
            detail: Some(detail.into()),
            ..Self::default()
        }
    }

    /// 거절에 분기할 수 있는 종류를 붙인다.
    #[must_use]
    pub fn refused_with_code(
        path: impl Into<String>,
        detail: impl Into<String>,
        code: impl Into<String>,
    ) -> Self {
        Self {
            code: Some(code.into()),
            ..Self::refused(path, detail)
        }
    }
}

/// 상한까지 자르되 줄 한가운데를 끊지 않는다.
///
/// 한 줄이 통째로 상한보다 긴 경우(축소된 번들 한 줄)에는 자를 줄 경계가 없다.
/// 그때는 바이트 경계로 자르고 — 문자 경계는 지킨다 — `truncated` 가 사실을
/// 말한다. UTF-8 한가운데를 자르면 문자열이 아니게 되고, 그건 프레임을 통째로
/// 못 읽게 만든다.
fn truncate_on_line_boundary(patch: String) -> (String, bool) {
    if patch.len() <= MAX_PATCH_BYTES {
        return (patch, false);
    }
    let mut end = MAX_PATCH_BYTES;
    while end > 0 && !patch.is_char_boundary(end) {
        end -= 1;
    }
    let cut = patch[..end].rfind('\n').map_or(end, |index| index + 1);
    (patch[..cut].to_string(), true)
}

/// 허브 쪽: 결과 하나를 프레임으로.
///
/// # Errors
/// 직렬화가 실패하거나 결과가 프레임 한도를 넘으면.
pub fn encode(result: &HubFileDiffResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_FILE_DIFF_BYTES)
}

/// 폰 쪽: 결과를 읽는다. 모르는 판은 거부한다.
///
/// # Errors
/// 프레임이 깨졌거나, 판이 다르거나, 문서를 읽지 못하면.
pub fn read<R: Read>(reader: &mut R) -> Result<HubFileDiffResult, FileDiffError> {
    let payload = frame::read_bytes(reader, MAX_FILE_DIFF_BYTES)?;
    // 두 번 읽는다. 이유는 `git_status.rs` 와 같다 — 판이 다른 문서를 "형식
    // 오류" 로 보이게 하면 사람이 할 일이 달라진다.
    let probe: VersionProbe = serde_json::from_slice(&payload)
        .map_err(|_| FileDiffError::Frame(FrameError::Malformed("판 번호가 없습니다")))?;
    if probe.hub_file_diff_version != HUB_FILE_DIFF_VERSION {
        return Err(FileDiffError::UnsupportedVersion {
            found: probe.hub_file_diff_version,
        });
    }
    serde_json::from_slice(&payload)
        .map_err(|_| FileDiffError::Frame(FrameError::Malformed("패치를 읽지 못했습니다")))
}

#[derive(Deserialize)]
struct VersionProbe {
    hub_file_diff_version: u16,
}

#[derive(Debug)]
pub enum FileDiffError {
    Frame(FrameError),
    UnsupportedVersion { found: u16 },
}

impl From<FrameError> for FileDiffError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl std::fmt::Display for FileDiffError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 폰이 모르는 패치 판입니다 (기대 {HUB_FILE_DIFF_VERSION}, 받음 {found}). \
                 컴퓨터와 폰 중 한쪽이 낡았습니다"
            ),
        }
    }
}

impl std::error::Error for FileDiffError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_patch_round_trips() {
        let result = HubFileDiffResult::read(
            "src/app.ts",
            "@@ -1,3 +1,4 @@\n context\n+added\n".to_string(),
        )
        .with_counts(Some(1), Some(0));
        let bytes = encode(&result).expect("encode");
        let mut cursor = std::io::Cursor::new(bytes);

        assert_eq!(read(&mut cursor).expect("read"), result);
    }

    /// 이진 파일은 실패가 아니다. 본문이 없다는 것과 못 읽었다는 것은 화면에서
    /// 다른 문장이어야 한다.
    #[test]
    fn a_binary_file_is_read_without_a_body() {
        let result = HubFileDiffResult::binary("logo.png");

        assert!(result.read);
        assert!(result.binary);
        assert!(result.patch.is_none());
        assert!(result.detail.is_none());
    }

    /// 바뀐 게 없는 파일은 **빈 본문**이다. 이진 파일과 같은 값이 되면 화면은
    /// 둘을 갈라 그릴 수 없다.
    #[test]
    fn an_empty_patch_is_not_a_binary_file() {
        let empty = HubFileDiffResult::read("src/app.ts", String::new());

        assert_eq!(empty.patch.as_deref(), Some(""));
        assert!(!empty.binary);
    }

    /// 상한을 넘는 본문은 잘리고, 잘렸다고 말한다. 조용히 자르면 화면은 파일의
    /// 끝을 본 줄 안다.
    #[test]
    fn an_oversized_patch_is_cut_and_says_so() {
        let line = "+ 한 줄의 내용이 여기 있습니다\n";
        let body = line.repeat(MAX_PATCH_BYTES / line.len() + 64);
        assert!(body.len() > MAX_PATCH_BYTES, "시험이 상한을 못 넘었다");

        let result = HubFileDiffResult::read("src/big.ts", body);

        assert!(result.truncated);
        let patch = result.patch.expect("본문");
        assert!(patch.len() <= MAX_PATCH_BYTES);
        // 줄 경계에서 잘렸다 — 반쪽 줄은 저장소에 없는 내용이다.
        assert!(patch.ends_with('\n'), "줄 한가운데서 잘렸다");
    }

    /// 한 줄이 통째로 상한보다 긴 파일(축소된 번들)에도 답이 있어야 한다.
    /// 잘라 낼 줄 경계가 없다고 프레임 전체를 못 만들면, 그 파일만 영영 안 열린다.
    #[test]
    fn a_single_line_longer_than_the_ceiling_still_encodes() {
        let body = "가".repeat(MAX_PATCH_BYTES);
        assert!(body.len() > MAX_PATCH_BYTES, "시험이 상한을 못 넘었다");

        let result = HubFileDiffResult::read("dist/bundle.js", body);

        assert!(result.truncated);
        // 문자 경계를 지켰다 — 어겼으면 이 값은 애초에 String 이 아니다.
        assert!(result.patch.as_deref().expect("본문").len() <= MAX_PATCH_BYTES);
        encode(&result).expect("잘린 본문은 프레임에 들어가야 한다");
    }

    #[test]
    fn an_unknown_version_is_refused_before_the_body_is_trusted() {
        let mut result = HubFileDiffResult::read("src/app.ts", String::new());
        result.hub_file_diff_version = HUB_FILE_DIFF_VERSION + 1;
        let bytes = encode(&result).expect("encode");
        let mut cursor = std::io::Cursor::new(bytes);

        assert!(matches!(
            read(&mut cursor),
            Err(FileDiffError::UnsupportedVersion { found })
                if found == HUB_FILE_DIFF_VERSION + 1
        ));
    }

    /// 큰 파일 하나의 패치는 목록 상한(1 MiB)을 넘는다. 프레임 상한이 그것보다
    /// 작으면 인코딩이 조용히 실패하고, 폰은 그 침묵을 거절로 읽는다.
    #[test]
    fn a_patch_at_the_body_ceiling_still_fits_in_one_frame() {
        let body = "+".repeat(MAX_PATCH_BYTES);
        let result = HubFileDiffResult::read("dist/bundle.js", body);

        let bytes = encode(&result).expect("상한만큼의 본문은 프레임에 들어가야 한다");
        assert!(bytes.len() > crate::git_status::MAX_GIT_STATUS_BYTES);
        let mut cursor = std::io::Cursor::new(bytes);
        assert_eq!(read(&mut cursor).expect("read"), result);
    }
}
