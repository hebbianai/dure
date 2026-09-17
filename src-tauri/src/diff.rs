//! Agent worktree diff vs fork-point (merge-base with the default branch).
//!
//! 핵심 불변식: 사용자의 실제 git index는 절대 변경하지 않는다. untracked
//! 파일을 diff에 포함시키기 위한 intent-to-add는 임시 index 사본
//! (GIT_INDEX_FILE)에만 적용한다.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;

use crate::gitx::run_git;

#[path = "diff_index.rs"]
mod index;
use index::DiffIndex;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileStat {
    pub path: String,
    /// rename 시 이전 경로.
    pub old_path: Option<String>,
    /// None = binary.
    pub added: Option<u32>,
    pub deleted: Option<u32>,
    /// git name-status 첫 글자: A/M/D/R/C/T/U. 알 수 없으면 "M".
    pub status: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffStat {
    pub base_ref: String,
    pub merge_base: String,
    /// fork-point..HEAD의 커밋된 branch patch.
    pub committed_files: Vec<DiffFileStat>,
    /// HEAD..working tree의 staged/unstaged/untracked patch.
    pub worktree_files: Vec<DiffFileStat>,
    /// HEAD에만 있는 commit 수.
    pub ahead: u32,
    /// base ref에만 있는 commit 수.
    pub behind: u32,
    /// fork-point..working tree의 기존 합산 view. Diff pane 호환 계약.
    pub files: Vec<DiffFileStat>,
}

/// 한 스냅샷(같은 DiffIndex)에서 나온 stat + full diff. 패널 새로고침용.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffReview {
    /// 호출자가 하위 디렉터리를 넘겨도 실제 Git worktree root로 정규화한다.
    pub worktree_path: String,
    pub base_ref: String,
    pub merge_base: String,
    pub files: Vec<DiffFileStat>,
    pub diff: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedReviewTarget {
    pub worktree_path: String,
    pub worktree_git_dir: String,
    pub base_ref: String,
    pub base_commit_sha: String,
    pub head_commit_sha: String,
}

/// session의 관측 cwd를 한 번 캡처해 넘길 수 있도록 실제 worktree root로
/// 정규화한다. 이후 diff 명령은 모두 root에서 실행되어 cwd가 하위 디렉터리여도
/// 저장소 전체의 tracked/untracked 변경을 빠뜨리지 않는다.
pub(crate) fn resolve_worktree_root(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("No working directory is available for the diff".to_string());
    }
    let root = run_git(path, &["rev-parse", "--path-format=absolute", "--show-toplevel"])?;
    let root = root.trim_end_matches(['\r', '\n']);
    if root.is_empty() {
        return Err("Could not find the Git worktree root".to_string());
    }
    Ok(root.to_string())
}

fn resolve_worktree_git_dir(worktree: &str) -> Result<String, String> {
    let git_dir = run_git(worktree, &["rev-parse", "--absolute-git-dir"])?;
    let git_dir = git_dir.trim_end_matches(['\r', '\n']);
    if git_dir.is_empty() {
        return Err("Could not find the Git worktree identity".to_string());
    }
    Ok(git_dir.to_string())
}

/// 리뷰를 처음 열 때만 움직이는 ref를 해석한다. 이후 조회는 저장된
/// `base_commit_sha`를 직접 사용하므로 main/origin/main 이동을 따라가지 않는다.
pub fn capture_review_target(path: &str) -> Result<CapturedReviewTarget, String> {
    let worktree_path = resolve_worktree_root(path)?;
    let worktree_git_dir = resolve_worktree_git_dir(&worktree_path)?;
    let (base_ref, base_commit_sha) = resolve_base(&worktree_path, None)?;
    let head_commit_sha = run_git(&worktree_path, &["rev-parse", "--verify", "HEAD^{commit}"])?
        .trim()
        .to_string();
    if head_commit_sha.is_empty() {
        return Err("Could not find the HEAD from the start of the review".to_string());
    }
    Ok(CapturedReviewTarget {
        worktree_path,
        worktree_git_dir,
        base_ref,
        base_commit_sha,
        head_commit_sha,
    })
}

fn validate_captured_worktree(
    worktree_path: &str,
    worktree_git_dir: &str,
) -> Result<(), String> {
    let current_root = resolve_worktree_root(worktree_path)
        .map_err(|error| format!("The review worktree is unavailable: {error}"))?;
    if current_root != worktree_path {
        return Err(format!(
            "The review worktree path changed: {worktree_path} → {current_root}"
        ));
    }
    let current_git_dir = resolve_worktree_git_dir(&current_root)
        .map_err(|error| format!("The review worktree is unavailable: {error}"))?;
    if current_git_dir != worktree_git_dir {
        return Err("The review worktree identity no longer matches".to_string());
    }
    Ok(())
}

/// 워크트리 브랜치의 diff 기준선이 될 기본 브랜치를 찾는다.
fn detect_base_ref(worktree: &str) -> Result<String, String> {
    if let Ok(head) = run_git(worktree, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]) {
        let head = head.trim();
        if let Some(short) = head.strip_prefix("refs/remotes/") {
            if !short.is_empty() {
                return Ok(short.to_string());
            }
        }
    }
    for cand in ["origin/main", "origin/master", "main", "master"] {
        let spec = format!("{cand}^{{commit}}");
        if run_git(worktree, &["rev-parse", "--verify", "--quiet", &spec]).is_ok() {
            return Ok(cand.to_string());
        }
    }
    Err("Could not find a base branch (origin/HEAD, main, and master are all missing)".to_string())
}

#[derive(Clone)]
struct BaseCache {
    base_ref: String,
    base_sha: String,
    head_sha: String,
    merge_base: String,
}

/// worktree별 base 탐지·merge-base 캐시. HEAD/base sha가 그대로면 재계산하지
/// 않는다 — 폴링 tier(A2)가 워크트리마다 주기 호출해도 스폰 수가 상수로
/// 남게. 락은 캐시 조회/갱신 동안만 잡고 git 스폰 중엔 풀어 둔다.
static BASE_CACHE: LazyLock<Mutex<HashMap<String, BaseCache>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// candidate base ref로 HEAD·base sha를 한 번의 스폰으로 읽고, 캐시가
/// 유효하면 merge-base 재계산을 건너뛴다.
fn resolve_with_ref(worktree: &str, base_ref: &str) -> Result<(String, String), String> {
    let spec = format!("{base_ref}^{{commit}}");
    let out = run_git(worktree, &["rev-parse", "HEAD", &spec])?;
    let mut lines = out.lines();
    let head_sha = lines.next().unwrap_or("").trim().to_string();
    let base_sha = lines.next().unwrap_or("").trim().to_string();
    if head_sha.is_empty() || base_sha.is_empty() {
        return Err(format!("rev-parse HEAD/{base_ref} returned an empty result"));
    }
    if let Some(e) = BASE_CACHE.lock().unwrap().get(worktree) {
        if e.base_ref == base_ref && e.head_sha == head_sha && e.base_sha == base_sha {
            return Ok((e.base_ref.clone(), e.merge_base.clone()));
        }
    }
    let merge_base = run_git(worktree, &["merge-base", &base_sha, &head_sha])?.trim().to_string();
    BASE_CACHE.lock().unwrap().insert(
        worktree.to_string(),
        BaseCache {
            base_ref: base_ref.to_string(),
            base_sha,
            head_sha,
            merge_base: merge_base.clone(),
        },
    );
    Ok((base_ref.to_string(), merge_base))
}

fn resolve_base(worktree: &str, base_ref: Option<&str>) -> Result<(String, String), String> {
    let explicit = base_ref.filter(|b| !b.trim().is_empty()).map(|b| b.trim().to_string());
    let candidate = match &explicit {
        Some(b) => b.clone(),
        None => match BASE_CACHE.lock().unwrap().get(worktree) {
            Some(e) => e.base_ref.clone(),
            None => detect_base_ref(worktree)?,
        },
    };
    match resolve_with_ref(worktree, &candidate) {
        Ok(v) => Ok(v),
        // 캐시된 ref가 사라졌을 수 있다(리모트 변경 등) — 한 번 재탐지.
        Err(e) if explicit.is_none() => {
            BASE_CACHE.lock().unwrap().remove(worktree);
            let fresh = detect_base_ref(worktree)?;
            if fresh == candidate {
                return Err(e);
            }
            resolve_with_ref(worktree, &fresh)
        }
        Err(e) => Err(e),
    }
}

#[derive(Debug, PartialEq)]
struct NumstatRow {
    added: Option<u32>,
    deleted: Option<u32>,
    old_path: Option<String>,
    path: String,
}

/// `git diff --raw --numstat -z` 한 번의 호출 출력 파싱. raw 블록이 먼저
/// (`:<modes> <shas> <status>\0PATH\0`, rename은 `R<score>\0OLD\0NEW\0`),
/// 이어서 numstat 블록(`ADD\tDEL\tPATH\0`, rename `ADD\tDEL\t\0OLD\0NEW\0`,
/// binary는 `-`). raw가 상태 문자를, numstat이 ±카운트를 준다.
fn parse_raw_numstat_z(s: &str) -> Vec<DiffFileStat> {
    let mut statuses: HashMap<String, String> = HashMap::new();
    let mut rows: Vec<NumstatRow> = Vec::new();
    let mut toks = s.split('\0');
    while let Some(tok) = toks.next() {
        if tok.is_empty() {
            continue;
        }
        if let Some(meta) = tok.strip_prefix(':') {
            let letter = meta
                .split_whitespace()
                .last()
                .and_then(|f| f.chars().next())
                .unwrap_or('M');
            if letter == 'R' || letter == 'C' {
                let _old = toks.next().unwrap_or("");
                let new = toks.next().unwrap_or("");
                statuses.insert(new.to_string(), letter.to_string());
            } else {
                let path = toks.next().unwrap_or("");
                statuses.insert(path.to_string(), letter.to_string());
            }
        } else {
            let mut parts = tok.splitn(3, '\t');
            let added = parts.next().unwrap_or("").trim().parse::<u32>().ok();
            let deleted = parts.next().unwrap_or("").trim().parse::<u32>().ok();
            let path = parts.next().unwrap_or("");
            if path.is_empty() {
                // rename: 다음 두 토큰이 old, new.
                let old = toks.next().unwrap_or("").to_string();
                let new = toks.next().unwrap_or("").to_string();
                if !new.is_empty() {
                    rows.push(NumstatRow { added, deleted, old_path: Some(old), path: new });
                }
            } else {
                rows.push(NumstatRow { added, deleted, old_path: None, path: path.to_string() });
            }
        }
    }
    rows.into_iter()
        .map(|row| DiffFileStat {
            status: statuses.get(&row.path).cloned().unwrap_or_else(|| "M".to_string()),
            path: row.path,
            old_path: row.old_path,
            added: row.added,
            deleted: row.deleted,
        })
        .collect()
}

fn stat_files(idx: &DiffIndex, worktree: &str, merge_base: &str) -> Result<Vec<DiffFileStat>, String> {
    let out = idx.git(worktree, &["diff", "--raw", "--numstat", "-z", "-M", merge_base])?;
    Ok(parse_raw_numstat_z(&out))
}

fn stat_files_between(
    idx: &DiffIndex,
    worktree: &str,
    base: &str,
    head: &str,
) -> Result<Vec<DiffFileStat>, String> {
    let out = idx.git(
        worktree,
        &["diff", "--raw", "--numstat", "-z", "-M", base, head],
    )?;
    Ok(parse_raw_numstat_z(&out))
}

fn branch_divergence(worktree: &str, base_ref: &str) -> Result<(u32, u32), String> {
    let range = format!("HEAD...{base_ref}");
    let out = run_git(worktree, &["rev-list", "--left-right", "--count", &range])?;
    let mut counts = out.split_whitespace();
    let ahead = counts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "Could not read the ahead commit count".to_string())?;
    let behind = counts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "Could not read the behind commit count".to_string())?;
    if counts.next().is_some() {
        return Err("Invalid branch divergence result".to_string());
    }
    Ok((ahead, behind))
}

fn full_diff(idx: &DiffIndex, worktree: &str, merge_base: &str) -> Result<String, String> {
    idx.git(worktree, &["diff", "--no-color", "--no-ext-diff", "-M", merge_base])
}

/// Advisory fork-point statistics. Only untracked files need a private index;
/// every read observes current Git state rather than caching worktree results.
pub fn agent_diff_stat(worktree: &str, base_ref: Option<&str>) -> Result<AgentDiffStat, String> {
    let (base_ref, merge_base) = resolve_base(worktree, base_ref)?;
    let idx = DiffIndex::observe(worktree)?;
    let files = stat_files(&idx, worktree, &merge_base)?;
    let committed_files = stat_files_between(&idx, worktree, &merge_base, "HEAD")?;
    let worktree_files = stat_files(&idx, worktree, "HEAD")?;
    let (ahead, behind) = branch_divergence(worktree, &base_ref)?;
    Ok(AgentDiffStat {
        base_ref,
        merge_base,
        committed_files,
        worktree_files,
        ahead,
        behind,
        files,
    })
}

/// 커밋 하나. 폰의 커밋 탭이 한 줄로 그린다.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommit {
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    /// 사람이 읽는 상대 시각. 여기서 만들어 보내는 이유는 폰이 시계 차이와
    /// 시간대를 다시 계산하지 않게 하기 위해서다 — 같은 커밋이 두 화면에서
    /// 다른 시각으로 보이는 것이 이 값으로 막힌다.
    pub when: String,
}

/// 기준 브랜치 이후의 커밋들.
///
/// `agent_diff_stat` 과 같은 기준(기본 브랜치와의 merge-base)을 쓴다. 다른
/// 기준을 쓰면 "14개 변경" 과 "커밋 3개" 가 서로 다른 범위를 말하게 되고, 한
/// 화면에서 그 둘이 나란히 서 있다.
pub fn agent_commits(worktree: &str, base_ref: Option<&str>) -> Result<Vec<AgentCommit>, String> {
    let (_, merge_base) = resolve_base(worktree, base_ref)?;
    // 한 줄에 필드 넷, 단위 구분자로 나눈다 — 커밋 제목에 탭이나 파이프가 들어
    // 있어도 갈라지지 않는다.
    let out = run_git(
        worktree,
        &[
            "log",
            "--no-color",
            "--date=relative",
            "--max-count=200",
            "--format=%h\x1f%s\x1f%an\x1f%ad",
            &format!("{merge_base}..HEAD"),
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\x1f');
            let short_sha = fields.next()?.to_string();
            let subject = fields.next()?.to_string();
            let author = fields.next()?.to_string();
            let when = fields.next()?.to_string();
            if short_sha.is_empty() {
                return None;
            }
            Some(AgentCommit {
                short_sha,
                subject,
                author,
                when,
            })
        })
        .collect())
}

/// full unified diff (파일별 표시는 프론트의 splitUnifiedDiff가 담당한다 —
/// 한 스냅샷에서 나온 diff를 쪼개야 파일 목록과 내용이 항상 일치한다).
pub fn agent_diff(worktree: &str, base_ref: Option<&str>) -> Result<String, String> {
    let (_, merge_base) = resolve_base(worktree, base_ref)?;
    let idx = DiffIndex::create(worktree)?;
    full_diff(&idx, worktree, &merge_base)
}

/// 패널 새로고침용: 같은 DiffIndex에서 stat과 full diff를 함께 얻는다.
/// (두 git 호출이 연달아 도는 ms 단위 창에서 워킹트리가 바뀔 수는 있지만,
/// 별도 커맨드 두 번 대비 index 사본·base 해석·untracked 스캔이 한 번이고
/// 스냅샷 창이 훨씬 좁다.)
pub fn agent_diff_review(
    worktree: &str,
    base_ref: Option<&str>,
) -> Result<AgentDiffReview, String> {
    let worktree_path = resolve_worktree_root(worktree)?;
    let (base_ref, merge_base) = resolve_base(&worktree_path, base_ref)?;
    let idx = DiffIndex::create(&worktree_path)?;
    let files = stat_files(&idx, &worktree_path, &merge_base)?;
    let diff = full_diff(&idx, &worktree_path, &merge_base)?;
    Ok(AgentDiffReview { worktree_path, base_ref, merge_base, files, diff })
}

/// 커밋 하나가 무엇을 했는지. 커밋 목록의 한 줄을 눌렀을 때 오는 질문의 답.
///
/// 목록의 값(제목·사람·시각)을 여기서 다시 싣지 않는다 — 화면이 이미 그것을
/// 들고 이 화면을 열었고, 두 사본을 두면 갈리는 날이 온다. 이 문서가 더하는
/// 것은 목록에 없던 둘이다: 메시지의 **본문**과 바뀐 파일들.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommitDetail {
    /// git 이 정규화한 짧은 sha. 폰이 보낸 값이 아니라 저장소가 확인한 값이다.
    pub short_sha: String,
    /// 메시지의 첫 줄 뒤 전부. 없으면 없다 — 빈 문자열이 아니다: 본문 없는
    /// 커밋과 "아직 안 읽었다" 는 화면에서 다른 모양이어야 한다.
    pub body: Option<String>,
    /// 이 커밋이 바꾼 파일들, 그 커밋 안에서의 ± 와 함께.
    pub files: Vec<DiffFileStat>,
}

/// 커밋 하나의 본문과 바뀐 파일들.
///
/// `commit` 은 커밋 목록이 내놓은 짧은 sha 다. [`is_argv_safe_sha`] 가 16진수인
/// 것을 증명한 뒤에야 argv 가 된다 — 16진수는 플래그도 경로도 범위도 될 수 없다.
pub fn agent_commit_detail(worktree: &str, commit: &str) -> Result<AgentCommitDetail, String> {
    let worktree_path = resolve_worktree_root(worktree)?;
    if !is_argv_safe_sha(commit) {
        return Err("Invalid commit identifier".to_string());
    }
    // 이 저장소에 정말 있는 커밋인지 git 이 판정한다. 없으면 아래 두 읽기가
    // 각각 다른 실패를 내는데, 사람에게는 한 사실("그 커밋이 없다")이다.
    let short_sha = run_git(
        &worktree_path,
        &["rev-parse", "--short", "--verify", "--quiet", &format!("{commit}^{{commit}}")],
    )
    .map_err(|_| "Could not find that commit".to_string())?
    .trim()
    .to_string();

    let body = run_git(&worktree_path, &["log", "-1", "--no-color", "--format=%b", &short_sha])?;
    let body = body.trim_end();
    let files = parse_raw_numstat_z(&run_git(
        &worktree_path,
        &[
            "show",
            "--format=",
            "--raw",
            "--numstat",
            "-z",
            "-M",
            "--no-ext-diff",
            &short_sha,
        ],
    )?);
    Ok(AgentCommitDetail {
        short_sha,
        body: if body.is_empty() {
            None
        } else {
            Some(body.to_string())
        },
        files,
    })
}

/// 파일 하나의 패치. 폰이 목록에서 한 줄을 눌렀을 때 오는 질문의 답.
///
/// 전체 diff(`agent_diff`)를 보내고 프론트에서 쪼개지 않는 이유는 그 길이
/// 화면 하나에 수 MB 를 태우기 때문이다 — 데스크탑 패널은 한 번 열 때 그
/// 비용을 치르지만, 폰은 줄마다 한 번씩 누른다.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileDiff {
    /// 목록이 준 경로 그대로. 부르는 쪽이 답과 줄을 맞춘다.
    pub path: String,
    /// 통합 diff 본문. 이진 파일이면 없다 — 빈 문자열이 아니다. 빈 본문은
    /// "이 파일에서 바뀐 게 없다" 라는 다른 답이다.
    pub patch: Option<String>,
    /// 목록이 센 값 그대로. 이진 파일이면 없다(0 이 아니다).
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

/// 짧은 sha 가 argv 가 되어도 되는 모양인지.
///
/// 16진수 하나뿐이다. 그 성질이 이 값을 받아도 되게 만든다 — 16진수는 `-` 로
/// 시작할 수 없어 플래그가 못 되고, `/` 나 `..` 를 담을 수 없어 경로나 범위가
/// 못 되며, 브랜치 이름이 될 수도 없다. 길이는 git 자신의 범위다.
fn is_argv_safe_sha(revision: &str) -> bool {
    (4..=40).contains(&revision.len()) && revision.chars().all(|c| c.is_ascii_hexdigit())
}

/// 목록에 있는 파일 하나의 패치를 읽는다.
///
/// # 왜 경로를 여기서 거르나
///
/// 이 경로는 폰이 고른 값이고, 이 함수 아래에서 argv 가 된다. 안전하게 만드는
/// 것은 문자 검사가 아니라 **출처**다: 먼저 같은 스냅샷의 목록을 읽고, 그
/// 목록에 없는 경로는 여기서 끝난다. 폰은 저장소가 내놓은 것 중에서 고르기만
/// 한다. 거르는 자리는 저장소 옆 한 곳이어야 해서, 부르는 쪽에 한 벌 더 두지
/// 않는다.
pub fn agent_file_diff(
    worktree: &str,
    base_ref: Option<&str>,
    path: &str,
    commit: Option<&str>,
) -> Result<AgentFileDiff, String> {
    let worktree_path = resolve_worktree_root(worktree)?;
    let Some(commit) = commit else {
        let (_, merge_base) = resolve_base(&worktree_path, base_ref)?;
        // 목록과 본문이 같은 임시 index 에서 나온다. 두 번 만들면 그 사이에
        // 저장된 파일이 목록에는 없고 본문에는 있는 상태가 만들어진다.
        let idx = DiffIndex::create(&worktree_path)?;
        let file = pick_listed(stat_files(&idx, &worktree_path, &merge_base)?, path)?;
        let Some(file) = file else {
            return Ok(binary_file_diff(path));
        };
        let mut args = vec![
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-M",
            merge_base.as_str(),
            "--",
            file.path.as_str(),
        ];
        // 옮겨진 파일의 패치는 두 이름 아래에 있다. 새 이름만 물으면 무엇이
        // 움직였다고 말하는 바로 그 줄이 빈 본문을 받는다.
        if let Some(old) = file.old_path.as_deref() {
            args.push(old);
        }
        let patch = idx.git(&worktree_path, &args)?;
        return Ok(AgentFileDiff {
            path: file.path,
            patch: Some(patch),
            added: file.added,
            deleted: file.deleted,
        });
    };
    if !is_argv_safe_sha(commit) {
        return Err("Invalid commit identifier".to_string());
    }
    // 커밋 하나 안의 변경. `--format=` 은 메시지를 본문 밖에 둔다 — 화면은
    // 이미 목록에서 그것을 받았고, 여기 실으면 코드로 그려지는 자리 맨 위에
    // 저장소의 산문이 놓인다.
    let listed = parse_raw_numstat_z(&run_git(
        &worktree_path,
        &[
            "show",
            "--format=",
            "--raw",
            "--numstat",
            "-z",
            "-M",
            "--no-ext-diff",
            commit,
        ],
    )?);
    let Some(file) = pick_listed(listed, path)? else {
        return Ok(binary_file_diff(path));
    };
    let mut args = vec![
        "show",
        "--format=",
        "--no-color",
        "--no-ext-diff",
        "-M",
        commit,
        "--",
        file.path.as_str(),
    ];
    if let Some(old) = file.old_path.as_deref() {
        args.push(old);
    }
    let patch = run_git(&worktree_path, &args)?;
    Ok(AgentFileDiff {
        path: file.path,
        patch: Some(patch),
        added: file.added,
        deleted: file.deleted,
    })
}

/// 목록에서 그 경로를 찾는다. 없으면 거절, 이진 파일이면 `None`.
fn pick_listed(listed: Vec<DiffFileStat>, path: &str) -> Result<Option<DiffFileStat>, String> {
    let Some(file) = listed.into_iter().find(|file| file.path == path) else {
        return Err("That path is not present in this comparison".to_string());
    };
    // numstat 이 양쪽 다 세지 못한 파일이 이진 파일이다. 본문을 물어 봐야
    // 같은 말을 듣는다.
    if file.added.is_none() && file.deleted.is_none() {
        return Ok(None);
    }
    Ok(Some(file))
}

fn binary_file_diff(path: &str) -> AgentFileDiff {
    AgentFileDiff {
        path: path.to_string(),
        patch: None,
        added: None,
        deleted: None,
    }
}

/// durable review target 조회용. 저장된 worktree identity와 baseline commit을
/// 검증하고, branch ref나 현재 merge-base를 다시 계산하지 않는다.
pub fn agent_diff_review_at_target(
    worktree_path: &str,
    worktree_git_dir: &str,
    base_ref: &str,
    base_commit_sha: &str,
) -> Result<AgentDiffReview, String> {
    validate_captured_worktree(worktree_path, worktree_git_dir)?;
    let base_spec = format!("{base_commit_sha}^{{commit}}");
    let resolved_base = run_git(
        worktree_path,
        &["rev-parse", "--verify", "--quiet", &base_spec],
    )
    .map_err(|_| "Could no longer find the review base commit".to_string())?
    .trim()
    .to_string();
    if resolved_base != base_commit_sha {
        return Err("The review base commit identity does not match".to_string());
    }

    let idx = DiffIndex::create(worktree_path)?;
    let files = stat_files(&idx, worktree_path, base_commit_sha)?;
    let diff = full_diff(&idx, worktree_path, base_commit_sha)?;
    Ok(AgentDiffReview {
        worktree_path: worktree_path.to_string(),
        base_ref: base_ref.to_string(),
        merge_base: base_commit_sha.to_string(),
        files,
        diff,
    })
}

#[cfg(test)]
#[path = "diff_observation_tests.rs"]
mod observation_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .output()
            .expect("git spawn");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// main에 1커밋 → feature 브랜치에서 커밋된 수정 + 미커밋 수정 +
    /// untracked 새 파일이 있는 저장소.
    fn test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git(p, &["init", "-b", "main"]);
        fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "base"]);
        git(p, &["checkout", "-b", "feature"]);
        fs::write(p.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(p, &["commit", "-am", "committed change"]);
        fs::write(p.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        fs::write(p.join("new.txt"), "hello new file\n").unwrap();
        dir
    }

    fn wt(dir: &tempfile::TempDir) -> &str {
        dir.path().to_str().unwrap()
    }

    /// 커밋 하나가 무엇을 했는지. 목록에 없던 둘을 더한다.
    #[test]
    fn commit_detail_reads_the_body_and_the_files() {
        let repo = test_repo();
        let p = repo.path();
        fs::write(p.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        fs::write(p.join("second.txt"), "hi\n").unwrap();
        git(p, &["add", "."]);
        git(
            p,
            &[
                "commit",
                "-m",
                "기존 설치 데이터베이스 호환 유지\n\n스키마 3→4 마이그레이션에서 기존 테이블을 보존한다.",
            ],
        );
        let head = run_git(wt(&repo), &["rev-parse", "--short", "HEAD"]).expect("sha");

        let detail = agent_commit_detail(wt(&repo), head.trim()).expect("detail");

        assert_eq!(detail.short_sha, head.trim());
        // 제목은 목록이 이미 들고 있다. 이 문서가 더하는 것은 그 뒤의 본문이다.
        assert_eq!(
            detail.body.as_deref(),
            Some("스키마 3→4 마이그레이션에서 기존 테이블을 보존한다.")
        );
        let names: Vec<&str> = detail.files.iter().map(|file| file.path.as_str()).collect();
        assert!(names.contains(&"a.txt"), "{names:?}");
        assert!(names.contains(&"second.txt"), "{names:?}");
    }

    /// 본문 없는 커밋은 흔하다. 빈 문자열이 아니라 없음이어야, 화면이
    /// "본문이 없다" 와 "아직 안 읽었다" 를 갈라 그릴 수 있다.
    #[test]
    fn a_commit_with_no_body_says_none_rather_than_empty() {
        let repo = test_repo();
        git(repo.path(), &["commit", "-am", "subject only"]);
        let head = run_git(wt(&repo), &["rev-parse", "--short", "HEAD"]).expect("sha");

        let detail = agent_commit_detail(wt(&repo), head.trim()).expect("detail");

        assert_eq!(detail.body, None);
    }

    /// 16진수가 아닌 값도, 이 저장소에 없는 커밋도 argv 가 되기 전에 멈춘다.
    #[test]
    fn commit_detail_refuses_anything_that_is_not_a_commit_here() {
        let repo = test_repo();

        for candidate in ["--output=/tmp/x", "HEAD", "main..HEAD", "abc", "deadbeef"] {
            assert!(
                agent_commit_detail(wt(&repo), candidate).is_err(),
                "{candidate} 를 받아들였다"
            );
        }
    }

    /// 목록에 있는 파일 하나의 본문. 이 화면이 존재하는 이유 자체다.
    #[test]
    fn file_diff_returns_one_files_patch() {
        let repo = test_repo();
        let read = agent_file_diff(wt(&repo), None, "a.txt", None).expect("patch");

        let patch = read.patch.expect("본문");
        assert!(patch.contains("+three"), "커밋된 변경이 빠졌다:\n{patch}");
        assert!(patch.contains("+four"), "미커밋 변경이 빠졌다:\n{patch}");
        // 다른 파일의 본문이 섞이면 화면은 제목과 내용이 다른 파일이 된다.
        assert!(!patch.contains("hello new file"), "다른 파일이 섞였다:\n{patch}");
        assert_eq!(read.added, Some(2));
        assert_eq!(read.deleted, Some(0));
    }

    /// git 이 한 번도 본 적 없는 파일도 목록에 있고, 그 줄을 누를 수 있다.
    /// 임시 index 의 intent-to-add 가 없으면 여기서 빈 본문이 나온다.
    #[test]
    fn file_diff_covers_an_untracked_file() {
        let repo = test_repo();
        let read = agent_file_diff(wt(&repo), None, "new.txt", None).expect("patch");

        assert!(
            read.patch.expect("본문").contains("+hello new file"),
            "untracked 파일의 본문이 비었다"
        );
    }

    /// 목록에 없는 경로는 여기서 끝난다. 폰이 고른 값이 argv 가 되는 자리라,
    /// 거르는 곳이 저장소 옆 한 곳이어야 한다.
    #[test]
    fn file_diff_refuses_a_path_the_listing_did_not_produce() {
        let repo = test_repo();

        assert!(agent_file_diff(wt(&repo), None, "../../etc/passwd", None).is_err());
        assert!(agent_file_diff(wt(&repo), None, "a.txt.orig", None).is_err());
    }

    /// 16진수가 아닌 커밋 식별자는 argv 가 되기 전에 멈춘다.
    #[test]
    fn file_diff_refuses_a_commit_that_is_not_hexadecimal() {
        let repo = test_repo();

        for candidate in ["--output=/tmp/x", "HEAD", "main..HEAD", "abc"] {
            assert!(
                agent_file_diff(wt(&repo), None, "a.txt", Some(candidate)).is_err(),
                "{candidate} 를 커밋으로 받아들였다"
            );
        }
    }

    /// 커밋 하나 안의 변경. 워크트리의 미커밋 변경은 여기 없어야 한다 —
    /// 커밋에서 연 파일이 지금 디스크의 내용을 보여주면 다른 시점을 그린다.
    #[test]
    fn file_diff_of_a_commit_excludes_the_worktree() {
        let repo = test_repo();
        let head = run_git(wt(&repo), &["rev-parse", "--short", "HEAD"]).expect("sha");
        let head = head.trim();

        let read = agent_file_diff(wt(&repo), None, "a.txt", Some(head)).expect("patch");

        let patch = read.patch.expect("본문");
        assert!(patch.contains("+three"), "커밋의 변경이 빠졌다:\n{patch}");
        assert!(!patch.contains("+four"), "미커밋 변경이 섞였다:\n{patch}");
    }

    /// 이진 파일은 실패가 아니라 본문 없는 답이다.
    #[test]
    fn file_diff_reports_a_binary_file_without_a_body() {
        let repo = test_repo();
        // NUL 이 들어간 파일을 git 은 이진으로 본다.
        fs::write(repo.path().join("logo.png"), [0_u8, 1, 2, 0, 3]).unwrap();

        let read = agent_file_diff(wt(&repo), None, "logo.png", None).expect("answer");

        assert!(read.patch.is_none(), "이진 파일에 본문이 실렸다");
        // 0 이 아니라 없음이다 — `+0 −0` 은 "안 바뀜" 으로 읽힌다.
        assert_eq!(read.added, None);
        assert_eq!(read.deleted, None);
    }

    /// 옮겨진 파일의 본문은 두 이름 아래에 있다. 새 이름만 물으면 무엇이
    /// 움직였다고 말하는 바로 그 줄이 빈 본문을 받는다.
    #[test]
    fn file_diff_of_a_rename_has_a_body() {
        let repo = test_repo();
        let p = repo.path();
        git(p, &["checkout", "--", "a.txt"]);
        fs::remove_file(p.join("new.txt")).unwrap();
        git(p, &["mv", "a.txt", "b.txt"]);
        fs::write(p.join("b.txt"), "one\ntwo\nthree\nfour\n").unwrap();

        let read = agent_file_diff(wt(&repo), None, "b.txt", None).expect("patch");

        assert!(
            read.patch.expect("본문").contains("+four"),
            "옮겨진 파일의 본문이 비었다"
        );
    }

    #[test]
    fn stat_includes_committed_uncommitted_and_untracked() {
        let repo = test_repo();
        let stat = agent_diff_stat(wt(&repo), None).expect("stat");
        assert_eq!(stat.base_ref, "main");
        assert!(!stat.merge_base.is_empty());
        assert_eq!(stat.ahead, 1);
        assert_eq!(stat.behind, 0);
        let a = stat.files.iter().find(|f| f.path == "a.txt").expect("a.txt in stat");
        // 커밋된 three + 미커밋 four = +2.
        assert_eq!(a.added, Some(2));
        assert_eq!(a.deleted, Some(0));
        assert_eq!(a.status, "M");
        let n = stat.files.iter().find(|f| f.path == "new.txt").expect("untracked new.txt in stat");
        assert_eq!(n.added, Some(1));
        assert_eq!(n.status, "A");
        let committed = stat
            .committed_files
            .iter()
            .find(|f| f.path == "a.txt")
            .expect("a.txt in committed patch");
        assert_eq!(committed.added, Some(1));
        assert_eq!(stat.committed_files.len(), 1);
        let working = stat
            .worktree_files
            .iter()
            .find(|f| f.path == "a.txt")
            .expect("a.txt in worktree patch");
        assert_eq!(working.added, Some(1));
        assert!(stat.worktree_files.iter().any(|f| f.path == "new.txt"));
    }

    #[test]
    fn stat_separates_task_patch_worktree_and_upstream_drift() {
        let repo = test_repo();
        let p = repo.path();
        git(p, &["stash", "--include-untracked"]);
        git(p, &["checkout", "-q", "main"]);
        fs::write(p.join("upstream.txt"), "upstream\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "advance main"]);
        git(p, &["checkout", "-q", "feature"]);
        git(p, &["stash", "pop"]);

        let stat = agent_diff_stat(wt(&repo), None).expect("separated stat");
        assert_eq!(stat.ahead, 1);
        assert_eq!(stat.behind, 1);
        assert_eq!(stat.committed_files.len(), 1);
        assert_eq!(stat.committed_files[0].path, "a.txt");
        assert!(stat.worktree_files.iter().any(|f| f.path == "a.txt"));
        assert!(stat.worktree_files.iter().any(|f| f.path == "new.txt"));
        assert!(!stat.files.iter().any(|f| f.path == "upstream.txt"));
    }

    #[test]
    fn full_diff_covers_worktree_and_untracked() {
        let repo = test_repo();
        let diff = agent_diff(wt(&repo), None).expect("diff");
        assert!(diff.contains("+three"), "committed change missing:\n{diff}");
        assert!(diff.contains("+four"), "uncommitted change missing:\n{diff}");
        assert!(diff.contains("+hello new file"), "untracked content missing:\n{diff}");
    }

    #[test]
    fn non_ascii_paths_stay_raw_in_headers() {
        // core.quotepath 고정 검증 — 한글 경로가 octal-escape되면 프론트의
        // 섹션 키(numstat raw 경로)와 어긋나 파일 선택이 빈 diff를 보여준다.
        let repo = test_repo();
        fs::write(repo.path().join("한글파일.md"), "안녕\n").unwrap();
        let stat = agent_diff_stat(wt(&repo), None).expect("stat");
        assert!(stat.files.iter().any(|f| f.path == "한글파일.md"), "{:?}", stat.files);
        let diff = agent_diff(wt(&repo), None).expect("diff");
        assert!(diff.contains("b/한글파일.md"), "escaped path in header:\n{diff}");
        assert!(!diff.contains("\\355"), "octal-escaped path leaked:\n{diff}");
    }

    #[test]
    fn user_index_and_status_are_untouched() {
        let repo = test_repo();
        let p = repo.path();
        let index_path = p.join(".git/index");
        let index_before = fs::read(&index_path).expect("index before");
        let status_before = git(p, &["status", "--porcelain=v2"]);
        assert!(status_before.contains("? new.txt"), "precondition: new.txt untracked");

        agent_diff_stat(wt(&repo), None).expect("stat");
        agent_diff(wt(&repo), None).expect("diff");

        let index_after = fs::read(&index_path).expect("index after");
        let status_after = git(p, &["status", "--porcelain=v2"]);
        assert_eq!(index_before, index_after, "git index bytes changed");
        assert_eq!(status_before, status_after, "git status changed");
        assert!(status_after.contains("? new.txt"), "new.txt no longer untracked");
    }

    #[test]
    fn explicit_base_ref_is_used() {
        let repo = test_repo();
        let stat = agent_diff_stat(wt(&repo), Some("main")).expect("stat");
        assert_eq!(stat.base_ref, "main");
    }

    #[test]
    fn parse_raw_numstat_handles_plain_binary_and_rename() {
        // 실제 `git diff --raw --numstat -z -M` 출력 형태: raw 블록 후 numstat 블록.
        let s = ":100644 100644 422c2b7 de98044 M\x00src/a.rs\x00\
                 :100644 100644 1111111 2222222 A\x00assets/logo.png\x00\
                 :100644 100644 587be6b b77b4eb R050\x00old/name.rs\x00new/name.rs\x00\
                 3\t1\tsrc/a.rs\x00-\t-\tassets/logo.png\x005\t0\t\x00old/name.rs\x00new/name.rs\x00";
        let files = parse_raw_numstat_z(s);
        assert_eq!(files.len(), 3);
        assert_eq!(
            files[0],
            DiffFileStat {
                path: "src/a.rs".to_string(),
                old_path: None,
                added: Some(3),
                deleted: Some(1),
                status: "M".to_string(),
            }
        );
        assert_eq!(
            files[1],
            DiffFileStat {
                path: "assets/logo.png".to_string(),
                old_path: None,
                added: None,
                deleted: None,
                status: "A".to_string(),
            }
        );
        assert_eq!(
            files[2],
            DiffFileStat {
                path: "new/name.rs".to_string(),
                old_path: Some("old/name.rs".to_string()),
                added: Some(5),
                deleted: Some(0),
                status: "R".to_string(),
            }
        );
    }

    #[test]
    fn review_returns_stat_and_diff_from_one_snapshot() {
        let repo = test_repo();
        let review = agent_diff_review(wt(&repo), None).expect("review");
        assert_eq!(
            Path::new(&review.worktree_path),
            fs::canonicalize(repo.path()).unwrap()
        );
        assert_eq!(review.base_ref, "main");
        assert!(review.files.iter().any(|f| f.path == "a.txt"));
        assert!(review.files.iter().any(|f| f.path == "new.txt"));
        // stat에 있는 모든 파일이 diff 텍스트에도 등장해야 한다.
        for f in &review.files {
            assert!(review.diff.contains(&f.path), "{} missing in diff", f.path);
        }
        assert!(review.diff.contains("+four"));
    }

    #[test]
    fn review_resolves_nested_cwd_to_the_whole_worktree() {
        let repo = test_repo();
        let nested = repo.path().join("nested/deep");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("inside.txt"), "inside\n").unwrap();

        let review =
            agent_diff_review(nested.to_str().unwrap(), None).expect("review from nested cwd");

        assert_eq!(
            Path::new(&review.worktree_path),
            fs::canonicalize(repo.path()).unwrap()
        );
        assert!(
            review.files.iter().any(|file| file.path == "new.txt"),
            "root-level untracked file was omitted: {:?}",
            review.files
        );
        assert!(
            review.files.iter().any(|file| file.path == "nested/deep/inside.txt"),
            "nested untracked file was omitted: {:?}",
            review.files
        );
    }

    #[test]
    fn captured_review_keeps_its_baseline_when_main_and_head_move() {
        let repo = test_repo();
        let p = repo.path();
        let captured = capture_review_target(wt(&repo)).expect("capture");
        let original_base = git(p, &["rev-parse", "main"]).trim().to_string();
        assert_eq!(captured.base_commit_sha, original_base);

        git(p, &["stash", "--include-untracked"]);
        git(p, &["checkout", "-q", "main"]);
        fs::write(p.join("main-only.txt"), "m\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "advance main"]);
        git(p, &["checkout", "-q", "feature"]);
        git(p, &["rebase", "main"]);
        git(p, &["stash", "pop"]);

        let current = agent_diff_review(wt(&repo), None).expect("moving review");
        assert_ne!(current.merge_base, captured.base_commit_sha);
        let fixed = agent_diff_review_at_target(
            &captured.worktree_path,
            &captured.worktree_git_dir,
            &captured.base_ref,
            &captured.base_commit_sha,
        )
        .expect("fixed review");
        assert_eq!(fixed.merge_base, captured.base_commit_sha);
        assert!(fixed.files.iter().any(|file| file.path == "main-only.txt"));
    }

    #[test]
    fn captured_review_fails_closed_when_worktree_identity_changes_or_disappears() {
        let repo = test_repo();
        let captured = capture_review_target(wt(&repo)).expect("capture");
        let identity_error = agent_diff_review_at_target(
            &captured.worktree_path,
            "/different/git/dir",
            &captured.base_ref,
            &captured.base_commit_sha,
        )
        .unwrap_err();
        assert!(identity_error.contains("identity"));

        fs::remove_dir_all(repo.path()).unwrap();
        assert!(agent_diff_review_at_target(
            &captured.worktree_path,
            &captured.worktree_git_dir,
            &captured.base_ref,
            &captured.base_commit_sha,
        )
        .is_err());
    }

    #[test]
    fn review_rejects_non_git_and_empty_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(agent_diff_review(dir.path().to_str().unwrap(), None).is_err());
        assert!(agent_diff_review("  ", None).is_err());
    }

    #[test]
    fn merge_base_cache_follows_rebase() {
        let repo = test_repo();
        let p = repo.path();
        let first = agent_diff_stat(wt(&repo), None).expect("stat 1");
        // main을 전진시키고 feature를 그 위로 rebase → merge-base가 바뀐다.
        // (미커밋 변경·untracked는 stash로 보존했다가 rebase 후 복원)
        git(p, &["stash", "--include-untracked"]);
        git(p, &["checkout", "-q", "main"]);
        fs::write(p.join("main-only.txt"), "m\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "advance main"]);
        git(p, &["checkout", "-q", "feature"]);
        git(p, &["rebase", "main"]);
        git(p, &["stash", "pop"]);
        let second = agent_diff_stat(wt(&repo), None).expect("stat 2");
        let new_main = git(p, &["rev-parse", "main"]).trim().to_string();
        assert_ne!(first.merge_base, second.merge_base, "cache served a stale merge-base");
        assert_eq!(second.merge_base, new_main);
        // rebase 후에도 변경 내용은 그대로 보인다.
        assert!(second.files.iter().any(|f| f.path == "a.txt"));
    }
}
