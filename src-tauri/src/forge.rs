//! Asking the code host about this branch, and opening a review on it.
//!
//! # Why `gh` and not an API client
//!
//! The alternative is holding a GitHub token: storing it, refreshing it,
//! scoping it, and being the thing that leaks it. `gh` already does all of
//! that, the person who uses this app already has it logged in, and when it is
//! not logged in the honest answer is its own sentence rather than a 401 this
//! code would have to interpret. Orca reached the same conclusion for the same
//! reason (`src/main/github/client.ts`), and its failure text is literally
//! "Check your gh login".
//!
//! # What the phone can cause
//!
//! Creating a pull request is the first thing in this feature that a phone can
//! make happen outside the laptop — it pushes a branch and opens a review other
//! people will see. So the argv is fixed here and the phone supplies three
//! values: a title, a body, and whether it is a draft. No ref, no repo, no
//! flags. The branch and base come from the worktree, which the phone never
//! names either — it names a session, and the window resolves it.
//!
//! The body travels in a file, not in argv. A pull request body has newlines
//! and quotes in it by nature, and an argv that carries one is an argv somebody
//! will eventually get to interpret.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long one host round trip may take. This one crosses the network, unlike
/// every other read in this file's neighbourhood.
const FORGE_TIMEOUT: Duration = Duration::from_secs(60);

/// What the host says about this branch.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// `OPEN` / `CLOSED` / `MERGED`, as the host names it.
    pub state: String,
    pub url: String,
    pub is_draft: bool,
    pub base_ref: String,
    /// 리뷰가 요청된 사람들의 로그인.
    ///
    /// 팀은 여기 없다. 시트가 고르는 것은 사람이고, 팀을 목록에 넣으면 고를 수
    /// 없는 줄이 생긴다 — 그리고 쓰기가 델타로만 오가므로, 목록에 없는 팀은
    /// 이 화면이 무엇을 하든 그대로 남는다.
    pub requested_reviewers: Vec<String>,
    /// 호스트의 리뷰 판정. `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`,
    /// 그리고 아무도 아직 안 본 PR 은 빈 문자열이다 — 호스트가 부르는 그대로.
    pub review_decision: String,
    /// What the host's checks say, when they could be asked.
    ///
    /// `None` is not "no checks". A repository with no CI answers with an
    /// empty run rather than silence, and a screen that folds the two together
    /// says "no checks configured" about a question that failed to go out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<ChecksSummary>,
}

/// How this review's checks stand. Figma 3050:81530's "체크 2/2 통과".
///
/// Counts rather than a verdict, because the verdict a person wants depends on
/// what they are about to do: 3/4 with one still running is a reason to wait,
/// and 3/4 with one failed is a reason to look.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksSummary {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    /// Still running, or queued. Neither passed nor failed yet.
    pub pending: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestRow {
    number: u64,
    title: String,
    state: String,
    url: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    base_ref_name: String,
    /// 리뷰가 요청된 사람들. 팀도 여기 들어오는데 팀에는 `login` 이 없어서
    /// 빈 문자열이 되고, 아래에서 걸러진다 — 시트가 고르는 것은 사람이다.
    #[serde(default)]
    review_requests: Vec<ReviewRequestRow>,
    /// 호스트의 리뷰 판정. 빈 문자열은 "아무도 아직 안 봤다" 다.
    #[serde(default)]
    review_decision: String,
}

#[derive(Deserialize)]
struct ReviewRequestRow {
    #[serde(default)]
    login: String,
}

/// Why the host could not be asked.
///
/// A closed set, because the screen branches on it: "log in" and "install it"
/// and "this is not a GitHub repository" send somebody to three different
/// places, and none of them is "try again".
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeUnavailable {
    /// `gh` is not on this computer.
    ReaderMissing,
    /// It is there and nobody is logged in.
    NotAuthenticated,
    /// The worktree has no GitHub remote this build can name.
    NotHosted,
    TimedOut,
    Failed,
}

/// The answer to "is there a review open on this branch".
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForgeReview {
    /// There is one. `None` inside is impossible here — the variant carries it.
    Open(PullRequest),
    /// The branch has no review yet. A fact, and the state the create button
    /// exists for — not a failure.
    None,
    Unavailable { reason: ForgeUnavailable },
}

fn run_gh(worktree: &Path, arguments: &[&str]) -> Result<String, ForgeUnavailable> {
    let mut command = Command::new("gh");
    command.current_dir(worktree);
    command.args(arguments);
    // A prompt would hang a request nobody is watching. `gh` reads this and
    // fails instead of asking.
    command.env("GH_PROMPT_DISABLED", "1");
    command.env("GH_NO_UPDATE_NOTIFIER", "1");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ForgeUnavailable::ReaderMissing);
        }
        Err(_) => return Err(ForgeUnavailable::Failed),
    };
    // 한 벽시계로 묶는다. 네트워크 왕복이라 멈춘 채로 영원히 기다릴 수 있고,
    // 그때 기다리는 것은 폰의 왕복 마감(20초)이 아니라 이 프로세스다.
    let deadline = std::time::Instant::now() + FORGE_TIMEOUT;
    let output = loop {
        match child.try_wait() {
            Ok(Some(_)) => break child.wait_with_output().map_err(|_| ForgeUnavailable::Failed)?,
            Ok(None) => {}
            Err(_) => return Err(ForgeUnavailable::Failed),
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ForgeUnavailable::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    // The three that send somebody somewhere different. Matching text is not
    // ideal, but `gh` gives one exit code for all of them and the difference is
    // exactly what the person needs.
    if stderr.contains("not logged into") || stderr.contains("authentication") {
        return Err(ForgeUnavailable::NotAuthenticated);
    }
    if stderr.contains("could not determine") || stderr.contains("no git remote") {
        return Err(ForgeUnavailable::NotHosted);
    }
    Err(ForgeUnavailable::Failed)
}

/// The review open on this worktree's branch, if there is one.
#[must_use]
pub fn review(worktree: &str, branch: &str) -> ForgeReview {
    let worktree = Path::new(worktree);
    let arguments = [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "number,title,state,url,isDraft,baseRefName,reviewRequests,reviewDecision",
    ];
    // `pr list` answers an empty array for "no review", where `pr view` exits
    // non-zero. The distinction between "none" and "could not ask" is the whole
    // point of this screen, so the shape that keeps it is the one to use.
    let output = match run_gh(worktree, &arguments) {
        Ok(output) => output,
        Err(reason) => return ForgeReview::Unavailable { reason },
    };
    let rows: Vec<PullRequestRow> = match serde_json::from_str(output.trim()) {
        Ok(rows) => rows,
        Err(_) => {
            return ForgeReview::Unavailable {
                reason: ForgeUnavailable::Failed,
            };
        }
    };
    match rows.into_iter().next() {
        Some(row) => ForgeReview::Open(PullRequest {
            number: row.number,
            title: row.title,
            state: row.state,
            url: row.url,
            is_draft: row.is_draft,
            base_ref: row.base_ref_name,
            // 팀은 `login` 이 없다. 빈 문자열을 로그인으로 실어 보내면 시트에
            // 이름 없는 줄이 서고, 그 줄은 아무것도 가리키지 않는다.
            requested_reviewers: row
                .review_requests
                .into_iter()
                .map(|request| request.login)
                .filter(|login| !login.is_empty())
                .collect(),
            review_decision: row.review_decision,
            // Asked here rather than by the caller, so one screen never shows a
            // review from one moment beside checks from another.
            checks: checks(worktree.to_str().unwrap_or_default(), branch),
        }),
        None => ForgeReview::None,
    }
}

/// 리뷰를 부탁할 수 있는 사람 하나.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    /// 호스트에서의 로그인. 이것이 신원이다.
    pub login: String,
    /// 사람이 쓰는 이름. 커밋이 들고 있는 값이라 로그인과 다를 수 있고,
    /// 없을 수도 있다 — 그때는 로그인만 그린다.
    pub name: String,
}

/// 커밋 목록이 답하는 모양의 한 줄.
#[derive(Deserialize)]
struct CommitAuthorRow {
    /// 호스트 계정. 호스트에 계정이 없는 사람이 쓴 커밋이면 `null` 이다.
    #[serde(default)]
    author: Option<CommitAuthorAccount>,
    #[serde(default)]
    commit: CommitAuthorName,
}

#[derive(Deserialize)]
struct CommitAuthorAccount {
    #[serde(default)]
    login: String,
}

#[derive(Default, Deserialize)]
struct CommitAuthorName {
    #[serde(default)]
    author: CommitAuthorNameInner,
}

#[derive(Default, Deserialize)]
struct CommitAuthorNameInner {
    #[serde(default)]
    name: String,
}

/// 리뷰를 부탁할 만한 사람들, **최근 함께 일한 순**.
///
/// # 왜 협업자 목록이 아니라 커밋 작성자인가
///
/// 시안(3135:81548)이 이 목록에 붙인 부제가 "최근 함께 작업한 순" 이고, 그
/// 순서를 아는 값은 협업자 명단이 아니라 커밋 이력이다. 명단은 알파벳순이거나
/// 가입순이라 그 부제를 거짓말로 만든다.
///
/// 그리고 한 번의 요청으로 이름과 로그인을 **함께** 준다. 협업자 API 는 로그인만
/// 주므로 이름을 채우려면 사람 수만큼 요청이 더 필요하고, 시트 하나를 여는 데
/// 스무 번의 왕복이 붙는다.
///
/// 대신 한 번도 커밋하지 않은 협업자는 여기 없다. 그 사람에게 리뷰를 부탁하는
/// 일은 이 화면이 아니라 노트북에서 한다 — 폰의 빠른 동작이 답해야 하는 질문은
/// "같이 일하는 사람 중 누구" 이지 "이 저장소에 권한이 있는 모두" 가 아니다.
pub fn reviewer_candidates(worktree: &str) -> Option<Vec<Reviewer>> {
    // `{owner}` 와 `{repo}` 는 `gh` 가 이 디렉토리의 원격에서 채운다. 우리가
    // 원격 URL 을 파싱하면 그 파싱이 두 번째 의견이 되고, SSH/HTTPS/enterprise
    // 형태마다 갈린다.
    let output = run_gh(
        Path::new(worktree),
        &["api", "repos/{owner}/{repo}/commits?per_page=100"],
    )
    .ok()?;
    let rows: Vec<CommitAuthorRow> = serde_json::from_str(output.trim()).ok()?;

    let mut seen = std::collections::HashSet::new();
    let mut candidates = Vec::new();
    for row in rows {
        // 호스트 계정이 없는 커밋은 리뷰를 부탁할 수 없다. 이름만 들고 줄을
        // 그리면 눌렀을 때 아무에게도 가지 않는다.
        let Some(account) = row.author else { continue };
        if account.login.is_empty() || !seen.insert(account.login.clone()) {
            continue;
        }
        candidates.push(Reviewer {
            name: row.commit.author.name,
            login: account.login,
        });
    }
    Some(candidates)
}

/// 로그인이 argv 가 되어도 되는 모양인지.
///
/// # 왜 여기서는 문자 검사로 충분한가
///
/// 경로와 다르다. 경로는 문법이 없어서 저장소가 내놓은 목록에 있는지로만
/// 판정할 수 있지만, 호스트 로그인에는 좁고 알려진 문법이 있다 — 영숫자와
/// 하이픈, 39자 이하, 하이픈으로 시작하지 않음. 그 모양을 통과한 값은 플래그가
/// 될 수 없고(`-` 로 시작 못 함), 경로도 범위도 될 수 없다.
fn is_argv_safe_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && !login.starts_with('-')
        && !login.ends_with('-')
        && login
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// 이 리뷰의 리뷰어를 바꾼다. 더할 사람과 뺄 사람만.
///
/// # 왜 원하는 집합이 아니라 델타인가
///
/// `gh pr edit` 자체가 더하기와 빼기다. 집합을 받아 여기서 델타를 계산하면 그
/// 계산은 지금 요청된 사람들을 다시 읽어야 하고, 그 사이에 다른 사람이 팀을
/// 하나 붙였다면 이 화면은 그것을 지운다. 델타는 사용자가 화면에서 실제로 한
/// 일 그대로이고, 목록에 없던 것에는 손대지 않는다.
///
/// 번호로 고른다. `u64` 라 플래그가 될 수 없고, 그 번호는 이 노트북이 방금 읽은
/// 리뷰의 것이다.
pub fn set_reviewers(
    worktree: &str,
    number: u64,
    add: &[String],
    remove: &[String],
) -> Result<(), ForgeUnavailable> {
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }
    for login in add.iter().chain(remove.iter()) {
        if !is_argv_safe_login(login) {
            return Err(ForgeUnavailable::Failed);
        }
    }
    let number = number.to_string();
    let mut arguments: Vec<&str> = vec!["pr", "edit", &number];
    // 한 번의 호출로 더하고 뺀다. 두 번으로 나누면 첫 번째만 성공한 상태가
    // 만들어질 수 있고, 화면은 그것을 실패로 그린다.
    for login in add {
        arguments.push("--add-reviewer");
        arguments.push(login);
    }
    for login in remove {
        arguments.push("--remove-reviewer");
        arguments.push(login);
    }
    run_gh(Path::new(worktree), &arguments).map(|_| ())
}

/// One check run, as `gh pr checks --json` reports it.
#[derive(Deserialize)]
struct CheckRow {
    /// `pass` / `fail` / `pending` / `skipping` / `cancel`. `gh` buckets the
    /// host's many states into these, which is exactly the grouping a summary
    /// needs — doing it here from raw conclusions would be a second opinion.
    #[serde(default)]
    bucket: String,
}

/// What this branch's checks say.
///
/// A separate call from [`review`] because it is a separate question and a
/// separate cost: `pr list` answers from one API read, and checks walk every
/// run on the head commit. The pull-request tab asks for both because it draws
/// both, and neither failing takes the other down.
///
/// `None` when the checks could not be asked at all. It is deliberately not an
/// empty summary: a repository with no CI answers with zero runs, and the two
/// facts send a person to different places.
pub fn checks(worktree: &str, branch: &str) -> Option<ChecksSummary> {
    let output = run_gh(
        Path::new(worktree),
        &["pr", "checks", branch, "--json", "bucket"],
    );
    // `gh pr checks` exits non-zero when a check has failed — that is an answer,
    // not a failure to ask, and `run_gh` cannot tell the two apart. So a refusal
    // here only means the summary is absent, which is what the screen draws.
    let rows: Vec<CheckRow> = serde_json::from_str(output.ok()?.trim()).ok()?;
    let mut summary = ChecksSummary {
        total: u32::try_from(rows.len()).unwrap_or(u32::MAX),
        ..ChecksSummary::default()
    };
    for row in rows {
        match row.bucket.as_str() {
            "pass" => summary.passed += 1,
            "fail" => summary.failed += 1,
            // `skipping` and `cancel` are neither. Counting them as passed
            // would put "4/4 통과" over a run that never executed.
            "pending" => summary.pending += 1,
            _ => {}
        }
    }
    Some(summary)
}

/// Open a review on this worktree's branch.
///
/// Creating one is not idempotent, and a phone on a slow link retries by
/// nature. So a failure is followed by asking whether one exists now: a second
/// press must find the first press's review rather than a second review or an
/// error about one.
pub fn create_review(
    worktree: &str,
    branch: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> ForgeReview {
    let path = Path::new(worktree);
    let title = title.trim();
    if title.is_empty() {
        return ForgeReview::Unavailable {
            reason: ForgeUnavailable::Failed,
        };
    }
    let directory = match tempfile::tempdir() {
        Ok(directory) => directory,
        Err(_) => {
            return ForgeReview::Unavailable {
                reason: ForgeUnavailable::Failed,
            };
        }
    };
    let body_path = directory.path().join("body.md");
    if std::fs::File::create(&body_path)
        .and_then(|mut file| file.write_all(body.as_bytes()))
        .is_err()
    {
        return ForgeReview::Unavailable {
            reason: ForgeUnavailable::Failed,
        };
    }
    let body_argument = body_path.to_string_lossy().into_owned();
    let mut arguments = vec![
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        title,
        "--body-file",
        &body_argument,
    ];
    if draft {
        arguments.push("--draft");
    }
    match run_gh(path, &arguments) {
        Ok(_) => review(worktree, branch),
        // The press may have succeeded and the answer been lost, or an earlier
        // press may already have opened one. Either way the branch's review is
        // the truth, and reporting the error over an existing review would tell
        // somebody to do again what is already done.
        Err(reason) => match review(worktree, branch) {
            ForgeReview::Open(existing) => ForgeReview::Open(existing),
            _ => ForgeReview::Unavailable { reason },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 로그인은 argv 가 된다. 이 함수가 그 앞의 유일한 문지기다.
    ///
    /// 경로와 달리 문자 검사로 충분한 이유는 [`is_argv_safe_login`] 에 적혀
    /// 있다 — 호스트 로그인에는 좁고 알려진 문법이 있다.
    #[test]
    fn a_login_that_could_become_a_flag_is_refused() {
        for candidate in [
            "--add-reviewer",
            "-f",
            "-",
            "",
            // 경로가 될 수 있는 것들.
            "../etc/passwd",
            "org/team",
            "a b",
            // 하이픈으로 끝나는 이름은 GitHub 도 만들지 않는다.
            "trailing-",
            // 39자를 넘는 이름도 없다.
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(
                !is_argv_safe_login(candidate),
                "{candidate:?} 를 로그인으로 받아들였다"
            );
        }
    }

    #[test]
    fn ordinary_logins_pass() {
        for candidate in ["kattpish", "jay-hong", "a", "dana-l", "komojini", "a1-b2-c3"] {
            assert!(is_argv_safe_login(candidate), "{candidate:?} 를 거절했다");
        }
    }

    /// 더할 것도 뺄 것도 없으면 아무 프로세스도 안 띄운다.
    ///
    /// 존재하지 않는 워크트리를 주고도 성공해야 그 사실이 증명된다 — `gh` 가
    /// 돌았다면 그 디렉토리에서 실패했을 것이다.
    #[test]
    fn an_empty_delta_runs_nothing() {
        assert!(set_reviewers("/nonexistent-worktree", 1, &[], &[]).is_ok());
    }

    /// 하나라도 모양이 아니면 **아무것도** 보내지 않는다. 걸러 내고 나머지만
    /// 보내면 사람이 고른 것과 실제로 부탁한 것이 달라진다.
    #[test]
    fn one_bad_login_refuses_the_whole_delta() {
        let refused = set_reviewers(
            "/nonexistent-worktree",
            1,
            &["kattpish".to_string(), "--add-reviewer".to_string()],
            &[],
        );

        assert_eq!(refused, Err(ForgeUnavailable::Failed));
    }
}
