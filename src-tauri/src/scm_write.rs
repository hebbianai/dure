//! 폰이 부탁한 저장소 **변경**. 커밋, 되돌리기, 브랜치 전환과 생성.
//!
//! # 왜 `git_exec` 를 쓰지 않나
//!
//! 화면에는 이미 임의의 git 서브커맨드를 도는 길이 있다(`gitx::exec`). 그것은
//! **이 컴퓨터 앞에 앉은 사람**의 것이고, 그 사람은 터미널도 열 수 있다.
//! 폰은 다르다 — 페어링된 기기가 보낸 값이 argv 가 되는 순간, 그 기기를 가진
//! 누구든 이 컴퓨터에서 프로그램을 고를 수 있게 된다.
//!
//! 그래서 이 모듈의 모든 프로그램 이름과 플래그와 서브커맨드는 여기 적힌
//! 리터럴이다. 폰이 정하는 것은 **무엇에** 적용할지뿐이고, 그것도 저장소가
//! 방금 내놓은 목록 안에서만 고를 수 있다.
//!
//! # 무엇이 값을 안전하게 만드나
//!
//! - **경로**: 먼저 같은 스냅샷의 변경 목록을 읽고, 그 목록에 없는 경로는
//!   거절한다. `diff.rs` 의 `agent_file_diff` 와 같은 규칙이다 — 폰은 저장소가
//!   내놓은 것 중에서 고른다.
//! - **브랜치 이름**: `git check-ref-format` 이 판정한다. 우리가 정규식을
//!   짓지 않는 이유는, 그 규칙의 주인이 git 이고 우리가 쓴 사본은 언젠가
//!   갈리기 때문이다. 옵션 주입은 그 앞에서 따로 막는다 — `-` 로 시작하는
//!   이름은 실제로 만들 수 있고, `git checkout -oops` 는 그것을 플래그로 읽는다.
//! - **커밋 메시지**: argv 가 아니라 **stdin** 으로 간다(`-F -`). 메시지는
//!   사람이 쓴 자유 문장이라 길이도 내용도 제한할 수 없고, `-m` 으로 넘기면
//!   `--` 뒤가 아닌 자리에 사용자 문자열이 놓인다.
//!
//! # 무엇이 여기 없나
//!
//! merge, rebase, reset, cherry-pick, 그리고 **강제 옵션 일체**. 되돌릴 수 없고
//! 다른 사람의 작업에 닿는 것들이라, 폰의 한 번 누름이 일으킬 일이 아니다.
//!
//! push 는 한동안 이 목록에 있었는데, 그건 세 가지를 한 낱말로 묶은 것이었다:
//! 원격에 없던 브랜치를 올리는 것, 자기 브랜치를 fast-forward 로 올리는 것,
//! 그리고 히스토리를 덮어쓰는 것. 마지막 하나만 되돌릴 수 없다. 앞의 둘을 같이
//! 막은 대가는 컸다 — 리뷰를 여는 것은 그 브랜치가 원격에 있어야 가능해서,
//! push 를 막은 것이 "PR 만들기" 를 조용히 못 쓰게 만들고 있었다.
//! [`push`] 가 무엇을 여전히 막는지는 그 함수에 있다.

use std::io::Write as _;
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::diff;
use crate::gitx::run_git;

/// 폰이 부탁할 수 있는 변경, 전부.
///
/// 프로토콜의 `SourceControlAction` 을 그대로 링크하지 않고 한 벌 더 쓴다.
/// 이유는 `HubGitStatusReply` 와 같다 — 약속과 화면은 따로 움직이고, 한쪽
/// 필드 이름을 바꾸는 것이 다른 쪽 파싱을 조용히 깨뜨려서는 안 된다. 두 벌이
/// 갈리면 `serde` 가 경계에서 거절한다.
#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Commit { paths: Vec<String>, message: String },
    Discard { paths: Vec<String> },
    Checkout { branch: String },
    CreateBranch { name: String },
    /// 지금 브랜치를 원격에 올린다. 강제는 없다.
    Push,
}

/// 무엇이 일어났는지. 갈래마다 할 말이 다르다.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Receipt {
    Commit(CommitReceipt),
    Discard(DiscardReceipt),
    /// 체크아웃과 브랜치 생성은 셀 것이 없다. 성공했다는 사실이 전부다.
    Branch { name: String },
    Push(PushReceipt),
}

/// 무엇을 어디로 올렸는지.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushReceipt {
    pub branch: String,
    pub remote: String,
    /// 이번에 원격에 처음 생긴 브랜치인가. 화면이 "올림" 과 "새로 만듦" 을
    /// 갈라 말할 수 있게 한다 — 뒤쪽은 다른 사람에게 처음 보이는 순간이다.
    pub published: bool,
}

/// 하나를 적용한다. 어느 갈래인지 여기서 한 번만 가른다.
pub fn apply(worktree: &str, action: &Action) -> Result<Receipt, String> {
    match action {
        Action::Commit { paths, message } => commit(worktree, paths, message).map(Receipt::Commit),
        Action::Discard { paths } => discard(worktree, paths).map(Receipt::Discard),
        Action::Checkout { branch } => checkout(worktree, branch).map(|()| Receipt::Branch {
            name: branch.trim().to_string(),
        }),
        Action::CreateBranch { name } => create_branch(worktree, name).map(|()| Receipt::Branch {
            name: name.trim().to_string(),
        }),
        Action::Push => push(worktree).map(Receipt::Push),
    }
}

/// 커밋 하나의 결과. 무엇이 만들어졌는지 화면이 말할 수 있게.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitReceipt {
    /// 만들어진 커밋의 짧은 sha.
    pub short_sha: String,
    /// 실제로 커밋된 파일 수. 폰이 보낸 수가 아니라 저장소가 센 수다.
    pub files: u32,
}

/// 커밋한다. 고른 파일만.
///
/// # 왜 `--only` 인가
///
/// 이 워크트리의 index 는 이 컴퓨터 앞의 사람 것이기도 하다. 폰이 고른 파일을
/// `git add` 해서 커밋하면, 사람이 따로 스테이징해 둔 것이 같이 실려 나가거나
/// 반대로 폰의 선택이 그 index 를 덮어쓴다. `--only` 는 명령줄에 적힌 경로의
/// **워크트리 내용만** 커밋하고 나머지 스테이징은 건드리지 않는다.
///
/// 추적되지 않은 파일은 `--only` 가 알지 못하므로 먼저 의도만 기록한다
/// (`add --intent-to-add`). 내용은 여전히 `--only` 가 워크트리에서 가져간다.
pub fn commit(
    worktree: &str,
    paths: &[String],
    message: &str,
) -> Result<CommitReceipt, String> {
    let worktree = diff::resolve_worktree_root(worktree)?;
    if message.trim().is_empty() {
        return Err("The commit message is empty".to_string());
    }
    let listed = admit_paths(&worktree, paths)?;
    // git 이 한 번도 본 적 없는 파일은 `--only` 의 pathspec 에 걸리지 않는다.
    // 의도만 먼저 기록하면 걸리고, 내용은 워크트리에서 온다.
    let untracked: Vec<&str> = listed
        .iter()
        .filter(|file| file.status == "A" || file.status == "?")
        .map(|file| file.path.as_str())
        .collect();
    if !untracked.is_empty() {
        let mut argv = vec!["add", "--intent-to-add", "--"];
        argv.extend(untracked);
        run_git(&worktree, &argv)?;
    }

    let mut argv = vec!["commit", "--only", "--no-verify", "--file", "-", "--"];
    let selected: Vec<&str> = listed.iter().map(|file| file.path.as_str()).collect();
    argv.extend(selected.iter().copied());
    commit_with_message(&worktree, &argv, message)?;

    let short_sha = run_git(&worktree, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string();
    Ok(CommitReceipt {
        short_sha,
        files: u32::try_from(listed.len()).unwrap_or(u32::MAX),
    })
}

/// 메시지를 stdin 으로 넘겨 커밋을 만든다.
///
/// `-m` 이 아닌 이유는 이 모듈 머리말에 있다. `--no-verify` 는 훅을 끄는데,
/// 폰의 한 번 누름이 이 컴퓨터에서 임의의 훅 스크립트를 돌리게 두지 않기
/// 위해서다 — 그 훅은 저장소가 들고 온 것이고, 저장소를 클론한 사람은 폰의
/// 주인이 아닐 수 있다.
fn commit_with_message(worktree: &str, argv: &[&str], message: &str) -> Result<(), String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(worktree).args(argv);
    crate::gitx::scrub_git_environment(&mut command);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("git: {error}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "Could not pass the message to Git".to_string())?
        .write_all(message.as_bytes())
        .map_err(|error| format!("git: {error}"))?;
    // 닫아야 git 이 메시지의 끝을 안다. 드롭에 맡기면 아래에서 기다리는 동안
    // 파이프가 열려 있어 서로를 기다린다.
    drop(child.stdin.take());
    let out = child
        .wait_with_output()
        .map_err(|error| format!("git: {error}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// 고른 파일의 변경을 버린다.
///
/// # 되돌릴 수 없다
///
/// 추적되는 파일은 HEAD 의 내용으로 덮어쓰고, 추적되지 않는 파일은 **지운다**.
/// 어느 쪽도 git 이 되돌려 주지 않는다. 화면이 먼저 확인을 받는 이유이고, 이
/// 함수가 무엇을 지웠는지 세어 돌려주는 이유이기도 하다 — 사람이 방금 무슨
/// 일이 일어났는지 알아야 한다.
pub fn discard(worktree: &str, paths: &[String]) -> Result<DiscardReceipt, String> {
    let worktree = diff::resolve_worktree_root(worktree)?;
    let listed = admit_paths(&worktree, paths)?;
    let (untracked, tracked): (Vec<_>, Vec<_>) = listed
        .iter()
        .partition(|file| file.status == "A" || file.status == "?");

    if !tracked.is_empty() {
        let mut argv = vec!["checkout", "--"];
        argv.extend(tracked.iter().map(|file| file.path.as_str()));
        run_git(&worktree, &argv)?;
    }
    // `git clean` 이 아니라 이름 붙인 파일만 지운다. `clean` 은 pathspec 을
    // 받지만 그 뒤에 디렉토리 재귀가 붙고, 폰이 고른 것은 파일 하나하나다.
    let mut deleted = 0_u32;
    for file in &untracked {
        let target = std::path::Path::new(&worktree).join(&file.path);
        // 목록이 준 경로라 저장소 안이지만, 지우기 전에 그 사실을 다시 확인한다.
        // 이 한 줄이 막는 것은 심볼릭 링크로 저장소 밖을 가리키는 경우다.
        if !target.starts_with(&worktree) {
            continue;
        }
        match std::fs::remove_file(&target) {
            Ok(()) => deleted += 1,
            // 이미 없는 것은 실패가 아니다 — 원하는 상태가 이미 그 상태다.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", file.path)),
        }
    }
    Ok(DiscardReceipt {
        restored: u32::try_from(tracked.len()).unwrap_or(u32::MAX),
        deleted,
    })
}

/// 무엇이 일어났는지. 되돌리기가 두 가지 다른 일을 하기 때문에 둘로 센다.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscardReceipt {
    /// HEAD 의 내용으로 되돌린 파일 수.
    pub restored: u32,
    /// 지운 파일 수. 이쪽은 git 이 되돌려 주지 않는다.
    pub deleted: u32,
}

/// 브랜치를 갈아탄다. 이미 있는 브랜치로만.
///
/// 포함되지 않은 변경은 그대로 따라간다 — git 의 기본 동작이고, 시안
/// (3044:33291)이 "포함되지 않은 변경 14개는 그대로 따라갑니다" 로 말하는 것이
/// 그것이다. 충돌하면 git 이 거절하고, 그 문장이 그대로 화면에 간다.
pub fn checkout(worktree: &str, branch: &str) -> Result<(), String> {
    let worktree = diff::resolve_worktree_root(worktree)?;
    let branch = admit_branch(&worktree, branch)?;
    // 이미 존재하는 이름만 받는다. `checkout <이름>` 은 원격에 같은 이름이
    // 있으면 추적 브랜치를 새로 만드는데, 그건 사용자가 고른 목록에 없던 일이다.
    run_git(&worktree, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .map_err(|_| "No branch with that name exists".to_string())?;
    run_git(&worktree, &["checkout", &branch]).map(|_| ())
}

/// 지금 자리에서 브랜치를 새로 만들고 갈아탄다.
///
/// 시안(3051:81829)의 힌트가 "main에서 분기" 라고 말하지만, 실제로 분기하는
/// 자리는 **지금 HEAD** 다. 기준을 여기서 골라 주면 사용자가 방금 만든 커밋이
/// 새 브랜치에 없게 되고, 그 사실은 화면 어디에도 나타나지 않는다.
pub fn create_branch(worktree: &str, name: &str) -> Result<(), String> {
    let worktree = diff::resolve_worktree_root(worktree)?;
    let name = admit_branch(&worktree, name)?;
    if run_git(
        &worktree,
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")],
    )
    .is_ok()
    {
        return Err("A branch with that name already exists".to_string());
    }
    run_git(&worktree, &["checkout", "-b", &name]).map(|_| ())
}

/// 지금 브랜치를 원격에 올린다.
///
/// # 무엇을 여전히 막는가
///
/// - **강제는 없다.** `--force` 도 `--force-with-lease` 도 없다. 그래서 이
///   함수가 원격의 히스토리를 덮어쓸 방법은 없고, fast-forward 가 아니면 거절
///   하는 것은 우리가 아니라 git 이다 — 우리가 쓴 검사가 아니라 git 자신의
///   규칙이라 갈릴 일이 없다.
/// - **폰은 아무 값도 보내지 않는다.** 브랜치도 원격도 refspec 도 저장소에서
///   읽는다. 셋 중 하나라도 요청에서 오면 그건 push 가 아니라 임의의 ref 쓰기다.
/// - **detached HEAD 는 거절한다.** 올릴 브랜치가 없다.
/// - **훅을 돌리지 않는다.** `--no-verify` 를 쓰는 이유는 [`commit`] 과 같다 —
///   pre-push 훅은 저장소가 들고 온 스크립트이고, 저장소를 클론한 사람이 폰의
///   주인이 아닐 수 있다. 이 저장소에도 `.githooks/pre-push` 가 있다.
///
/// # 왜 원격을 우리가 고르나
///
/// `git push` 만 부르면 `push.default` 와 `remote.pushDefault` 가 무엇을 어디로
/// 보낼지 정한다. 그 값은 사용자 설정이라, 같은 누름이 기계마다 다른 일을 한다.
/// 여기서는 이 브랜치의 upstream 이 있으면 그 원격, 없으면 원격이 정확히 하나일
/// 때 그것, 그 외에는 거절이다 — 두 원격 중 어느 쪽인지는 사람이 정할 일이다.
pub fn push(worktree: &str) -> Result<PushReceipt, String> {
    let worktree = diff::resolve_worktree_root(worktree)?;
    let branch = run_git(&worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| "There is no current branch (detached HEAD)".to_string())?
        .trim()
        .to_string();
    // 저장소가 준 이름이지만 argv 가 되므로 같은 문을 지난다. `-` 로 시작하는
    // ref 는 실제로 만들 수 있고, `git push origin -oops` 는 플래그로 읽힌다.
    let branch = admit_branch(&worktree, &branch)?;
    let remote = push_remote(&worktree, &branch)?;

    // 이번에 처음 생기는 브랜치인가. 올린 뒤에는 알 수 없으니 먼저 본다.
    let published = run_git(
        &worktree,
        &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}/{branch}")],
    )
    .is_err();

    // **완전히 수식한 refspec**이어야 한다. 브랜치 이름만 주면 아직 설정이
    // 목적지를 정할 자리가 남는다 — 실측(git 2.55.0): `push.default=upstream`
    // 에 `branch.feature.merge=refs/heads/main` 이 있으면
    // `git push -u origin feature` 는 `feature -> main` 으로 간다. 남의 main 이
    // 이쪽 브랜치의 내용으로 덮인다는 뜻이고, exit 0 이다.
    //
    // 양쪽을 다 적으면 남는 자리가 없다: `remote.<name>.push` 도
    // (`+refs/heads/*:refs/heads/*` 한 줄이면 모든 브랜치를 강제로 덮어쓰는)
    // 그 설정도, `push.default` 도 명령줄 refspec 앞에서는 보이지 않는다.
    // `--set-upstream` 은 그때 오히려 잘못 심긴 `merge` 설정을 바로잡는다.
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let mut argv = vec!["push", "--no-verify"];
    // upstream 은 **설정이 아예 없을 때만** 심는다.
    //
    // 원격 브랜치가 없다는 것과 upstream 설정이 없다는 것은 다른 사실이다 —
    // 이 저장소에서는 46개 브랜치가 원격에 자기 이름이 없는 채로
    // `refs/heads/main` 을 upstream 으로 두고 있다(그게 이 저장소의 작업
    // 방식이다). 앞의 것으로 판단하면 그 설정을 말없이 다시 가리키게 되고,
    // 그 순간 데스크탑의 앞뒤 수가 다른 질문에 답하기 시작한다.
    let tracks_something = run_git(
        &worktree,
        &["rev-parse", "--verify", "--quiet", &format!("{branch}@{{upstream}}")],
    )
    .is_ok()
        || run_git(
            &worktree,
            &["config", "--get", &format!("branch.{branch}.merge")],
        )
        .is_ok();
    if !tracks_something {
        argv.push("--set-upstream");
    }
    argv.push(&remote);
    argv.push(&refspec);
    run_git(&worktree, &argv)?;
    Ok(PushReceipt {
        branch,
        remote,
        published,
    })
}

/// 이 브랜치를 어디로 올려야 하나.
///
/// 설정된 upstream 이 첫 번째 답이다. 없으면 원격이 정확히 하나일 때만 그것을
/// 쓴다 — 둘 중 어느 쪽인지는 사람이 정할 일이고, 우리가 `origin` 을 고르면
/// fork 로 일하는 사람의 코드가 상류로 간다.
fn push_remote(worktree: &str, branch: &str) -> Result<String, String> {
    if let Ok(configured) = run_git(
        worktree,
        &["config", "--get", &format!("branch.{branch}.remote")],
    ) {
        let configured = configured.trim();
        if !configured.is_empty() {
            return Ok(configured.to_string());
        }
    }
    let listed = run_git(worktree, &["remote"])?;
    let mut remotes = listed.lines().map(str::trim).filter(|line| !line.is_empty());
    let (Some(only), None) = (remotes.next(), remotes.next()) else {
        return Err("No push remote has been selected".to_string());
    };
    Ok(only.to_string())
}

/// 이 저장소의 브랜치들, 시안의 전환 시트가 그리는 모양으로.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchRow {
    pub name: String,
    /// 지금 이 워크트리가 올라앉은 브랜치.
    pub current: bool,
    /// 다른 워크트리가 이 브랜치를 쓰고 있으면 그 경로. git 은 그런 브랜치로의
    /// 체크아웃을 거절하므로, 화면이 미리 알아야 누를 수 없게 그릴 수 있다.
    pub checked_out_at: Option<String>,
    /// 기준 브랜치 이후 이 브랜치의 커밋 수. 시안의 "2 commits".
    pub commits: Option<u32>,
    /// 마지막 커밋이 언제였는지, 사람이 읽는 말로. 시안의 "3분".
    pub when: Option<String>,
}

/// 브랜치 목록. 전환 시트가 열릴 때 한 번 읽는다.
pub fn branches(worktree: &str) -> Result<Vec<BranchRow>, String> {
    let worktree = diff::resolve_worktree_root(worktree)?;
    let current = run_git(&worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|head| head.trim().to_string())
        .unwrap_or_default();
    let occupied = worktree_branches(&worktree);
    // 한 번의 읽기로 이름과 시각을 함께 가져온다. 브랜치마다 `git log` 를 돌면
    // 브랜치가 100 개인 저장소에서 시트 하나에 100 번의 spawn 이 붙는다.
    let listed = run_git(
        &worktree,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)\x1f%(committerdate:relative)",
            "refs/heads",
        ],
    )?;
    Ok(listed
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let when = parts.next().unwrap_or_default().trim();
            Some(BranchRow {
                current: name == current,
                checked_out_at: occupied.get(name).cloned(),
                // 개수는 여기서 세지 않는다. 브랜치마다 `rev-list` 한 번씩이고,
                // 그 값은 시트를 여는 것만으로는 필요하지 않다. 없는 것은
                // 화면에서 없는 대로 그려진다 — 0 으로 채우면 거짓말이 된다.
                commits: None,
                when: if when.is_empty() {
                    None
                } else {
                    Some(when.to_string())
                },
                name: name.to_string(),
            })
        })
        .collect())
}

/// 어떤 브랜치가 어느 워크트리에 매여 있는지.
fn worktree_branches(worktree: &str) -> std::collections::HashMap<String, String> {
    let mut occupied = std::collections::HashMap::new();
    let Ok(listing) = run_git(worktree, &["worktree", "list", "--porcelain"]) else {
        return occupied;
    };
    let mut path: Option<String> = None;
    for line in listing.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(rest.to_string());
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(path) = &path {
                occupied.insert(branch.to_string(), path.clone());
            }
        }
    }
    occupied
}

/// 폰이 고른 경로들을, 저장소가 방금 내놓은 **미커밋** 목록과 맞춰 본다.
///
/// # 왜 기준 브랜치 목록이 아니라 HEAD 대비인가
///
/// 화면의 목록은 기준 브랜치와의 비교라, 방금 커밋한 파일도 계속 들어 있다.
/// 그건 이 브랜치가 무엇을 바꿨는지에 답하는 목록이고, "무엇을 커밋할 수
/// 있는가" 는 다른 질문이다 — 이미 커밋된 파일에는 커밋할 것이 없고,
/// 되돌릴 것도 없다.
///
/// 그 둘을 같은 목록으로 보면 사용자가 고를 수 있는 것과 실제로 일어날 수
/// 있는 일이 어긋나고, `git commit --only` 는 선택 전체를 거절한다.
///
/// 하나라도 목록에 없으면 전부 거절한다. 걸러 내고 나머지만 하면, 사람이 세
/// 파일을 골랐는데 두 개만 커밋되고 화면은 성공이라고 말하게 된다.
fn admit_paths(worktree: &str, paths: &[String]) -> Result<Vec<diff::DiffFileStat>, String> {
    if paths.is_empty() {
        return Err("No files are selected".to_string());
    }
    let stat = diff::agent_diff_stat(worktree, None)?;
    let mut admitted = Vec::with_capacity(paths.len());
    for path in paths {
        let Some(file) = stat.worktree_files.iter().find(|file| &file.path == path) else {
            return Err(
                "Some selected files no longer have uncommitted changes. Refresh the list"
                    .to_string(),
            );
        };
        admitted.push(file.clone());
    }
    Ok(admitted)
}

/// 브랜치 이름이 argv 가 되어도 되는지 git 에게 묻는다.
///
/// 규칙의 주인이 git 이라 git 이 판정한다. 그 앞에서 우리가 막는 것은 하나,
/// `-` 로 시작하는 이름이다 — git 은 그런 ref 를 만들 수 있지만, 그것이
/// `checkout` 의 argv 에 들어가면 플래그로 읽힌다.
fn admit_branch(worktree: &str, branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("The branch name is empty".to_string());
    }
    if branch.starts_with('-') {
        return Err("Branch names cannot start with -".to_string());
    }
    if branch.len() > 255 {
        return Err("The branch name is too long".to_string());
    }
    run_git(worktree, &["check-ref-format", "--branch", branch])
        .map_err(|_| "Invalid branch name".to_string())?;
    Ok(branch.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn git(repo: &Path, args: &[&str]) {
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
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// main 에 한 커밋, feature 에서 커밋된 수정 + 미커밋 수정 + untracked 새 파일.
    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git(p, &["init", "-b", "main"]);
        fs::write(p.join("a.txt"), "one\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "base"]);
        git(p, &["checkout", "-b", "feature"]);
        fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(p.join("new.txt"), "hello\n").unwrap();
        dir
    }

    fn path(dir: &tempfile::TempDir) -> &str {
        dir.path().to_str().unwrap()
    }

    /// 폰이 실제로 보내는 JSON 이 이 갈래로 읽혀야 한다.
    ///
    /// 이 이름들은 네 곳에서 같은 철자여야 한다: 폰의 TS, 폰의 Rust, 약속
    /// 크레이트, 그리고 여기. 하나만 바꾸면 `serde` 가 경계에서 거절하는데,
    /// 그 거절은 폰에서 한 문장으로만 보인다 — 여기서 빌드 시각에 잡는다.
    #[test]
    fn the_wire_words_are_the_ones_the_phone_sends() {
        let parse = |json: &str| serde_json::from_str::<Action>(json).expect(json);

        assert_eq!(
            parse(r#"{"kind":"commit","paths":["a.txt"],"message":"m"}"#),
            Action::Commit {
                paths: vec!["a.txt".to_string()],
                message: "m".to_string()
            }
        );
        assert_eq!(
            parse(r#"{"kind":"discard","paths":["a.txt"]}"#),
            Action::Discard {
                paths: vec!["a.txt".to_string()]
            }
        );
        assert_eq!(
            parse(r#"{"kind":"checkout","branch":"main"}"#),
            Action::Checkout {
                branch: "main".to_string()
            }
        );
        assert_eq!(
            parse(r#"{"kind":"create_branch","name":"fix/x"}"#),
            Action::CreateBranch {
                name: "fix/x".to_string()
            }
        );
    }

    /// 그리고 약속 크레이트의 갈래가 같은 철자를 쓴다. 두 벌을 두는 이유는
    /// 화면과 약속이 따로 움직이기 때문이고, 갈리면 여기서 드러난다.
    #[test]
    fn the_protocol_enum_spells_them_the_same_way() {
        use dure_hub_protocol::hello::SourceControlAction as Wire;

        for (wire, ours) in [
            (
                Wire::Commit {
                    paths: vec!["a.txt".to_string()],
                    message: "m".to_string(),
                },
                r#"{"kind":"commit","paths":["a.txt"],"message":"m"}"#,
            ),
            (
                Wire::Discard {
                    paths: vec!["a.txt".to_string()],
                },
                r#"{"kind":"discard","paths":["a.txt"]}"#,
            ),
            (
                Wire::Checkout {
                    branch: "main".to_string(),
                },
                r#"{"kind":"checkout","branch":"main"}"#,
            ),
            (
                Wire::CreateBranch {
                    name: "fix/x".to_string(),
                },
                r#"{"kind":"create_branch","name":"fix/x"}"#,
            ),
            (Wire::Push, r#"{"kind":"push"}"#),
        ] {
            let encoded = serde_json::to_string(&wire).expect("encode");
            serde_json::from_str::<Action>(&encoded).expect(&encoded);
            serde_json::from_str::<Action>(ours).expect(ours);
        }
    }

    #[test]
    fn commit_records_only_the_chosen_files() {
        let repo = repository();

        let receipt = commit(path(&repo), &["a.txt".to_string()], "just a.txt").expect("commit");

        assert_eq!(receipt.files, 1);
        assert!(!receipt.short_sha.is_empty());
        // 안 고른 파일은 미커밋으로 남고, 고른 파일은 아니다.
        //
        // `files` 가 아니라 `worktree_files` 로 본다: 목록은 기준 브랜치와의
        // 비교라 방금 커밋한 파일도 계속 들어 있다. 커밋할 것이 있는지는 HEAD
        // 와의 비교가 답하는 다른 질문이고, 체크박스가 서는 자리도 그쪽이다.
        let stat = diff::agent_diff_stat(path(&repo), None).expect("stat");
        let uncommitted = &stat.worktree_files;
        assert!(uncommitted.iter().any(|file| file.path == "new.txt"));
        assert!(!uncommitted.iter().any(|file| file.path == "a.txt"));
        assert!(
            stat.files.iter().any(|file| file.path == "a.txt"),
            "기준 브랜치 대비 목록에서는 방금 커밋한 파일도 계속 보인다"
        );
    }

    /// git 이 한 번도 본 적 없는 파일도 고를 수 있다. `--only` 만으로는 그
    /// 경로가 pathspec 에 안 걸려 커밋이 통째로 실패한다.
    #[test]
    fn commit_can_include_an_untracked_file() {
        let repo = repository();

        commit(path(&repo), &["new.txt".to_string()], "add new.txt").expect("commit");

        let committed = run_git(path(&repo), &["show", "--name-only", "--format=", "HEAD"])
            .expect("show");
        assert!(committed.contains("new.txt"), "{committed}");
    }

    /// 사람이 따로 스테이징해 둔 것이 폰의 커밋에 실려 나가면 안 된다.
    /// 이 워크트리의 index 는 이 컴퓨터 앞의 사람 것이기도 하다.
    #[test]
    fn commit_leaves_someone_elses_staged_work_staged() {
        let repo = repository();
        fs::write(repo.path().join("staged.txt"), "theirs\n").unwrap();
        git(repo.path(), &["add", "staged.txt"]);

        commit(path(&repo), &["a.txt".to_string()], "just a.txt").expect("commit");

        let staged = run_git(path(&repo), &["diff", "--cached", "--name-only"]).expect("diff");
        assert!(staged.contains("staged.txt"), "스테이징이 사라졌다: {staged:?}");
        let committed = run_git(path(&repo), &["show", "--name-only", "--format=", "HEAD"])
            .expect("show");
        assert!(!committed.contains("staged.txt"), "남의 스테이징이 실려 나갔다");
    }

    /// 메시지는 argv 가 아니라 stdin 으로 간다. 그래서 플래그처럼 생긴 메시지도
    /// 그냥 메시지다.
    #[test]
    fn a_message_that_looks_like_a_flag_is_still_a_message() {
        let repo = repository();

        commit(path(&repo), &["a.txt".to_string()], "--amend --author=someone").expect("commit");

        let subject = run_git(path(&repo), &["log", "-1", "--format=%s"]).expect("log");
        assert_eq!(subject.trim(), "--amend --author=someone");
        // 그리고 그것이 amend 가 아니었다는 것 — 커밋이 둘이다.
        let count = run_git(path(&repo), &["rev-list", "--count", "HEAD"]).expect("count");
        assert_eq!(count.trim(), "2");
    }

    #[test]
    fn commit_refuses_an_empty_message_and_an_empty_selection() {
        let repo = repository();

        assert!(commit(path(&repo), &["a.txt".to_string()], "  \n ").is_err());
        assert!(commit(path(&repo), &[], "message").is_err());
    }

    /// 목록에 없는 경로는 전부 거절한다. 걸러 내고 나머지만 하면 사람이 고른
    /// 것과 커밋된 것이 달라지고, 화면은 성공이라고 말한다.
    #[test]
    fn commit_refuses_the_whole_selection_when_one_path_is_unknown() {
        let repo = repository();

        let refused = commit(
            path(&repo),
            &["a.txt".to_string(), "../../etc/passwd".to_string()],
            "message",
        );

        assert!(refused.is_err());
        // 그리고 아무것도 커밋되지 않았다.
        let count = run_git(path(&repo), &["rev-list", "--count", "HEAD"]).expect("count");
        assert_eq!(count.trim(), "1");
    }

    /// 이미 커밋된 파일은 고를 수 없다.
    ///
    /// 화면의 목록은 기준 브랜치와의 비교라 방금 커밋한 파일도 계속 들어 있다.
    /// 그것을 그대로 받아들이면 `git commit --only` 가 선택 **전체**를 거절하고,
    /// 사람은 자기가 고른 나머지 파일까지 커밋되지 않은 이유를 알 수 없다.
    #[test]
    fn a_file_with_nothing_uncommitted_cannot_be_committed_or_discarded() {
        let repo = repository();
        commit(path(&repo), &["a.txt".to_string()], "committed").expect("commit");

        // 기준 브랜치 대비 목록에는 아직 있다 — 그게 이 시험의 전제다.
        let stat = diff::agent_diff_stat(path(&repo), None).expect("stat");
        assert!(stat.files.iter().any(|file| file.path == "a.txt"));

        assert!(commit(path(&repo), &["a.txt".to_string()], "again").is_err());
        assert!(discard(path(&repo), &["a.txt".to_string()]).is_err());
        // 그리고 파일은 그대로다 — 거절이 무언가를 되돌리지 않았다.
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn discard_restores_a_tracked_file_and_deletes_an_untracked_one() {
        let repo = repository();

        let receipt = discard(
            path(&repo),
            &["a.txt".to_string(), "new.txt".to_string()],
        )
        .expect("discard");

        assert_eq!(receipt, DiscardReceipt { restored: 1, deleted: 1 });
        assert_eq!(fs::read_to_string(repo.path().join("a.txt")).unwrap(), "one\n");
        assert!(!repo.path().join("new.txt").exists());
    }

    #[test]
    fn discard_refuses_a_path_the_listing_did_not_produce() {
        let repo = repository();

        assert!(discard(path(&repo), &["../../etc/hosts".to_string()]).is_err());
        assert!(repo.path().join("a.txt").exists());
    }

    /// 원격에 없던 브랜치를 처음 올린다. 그리고 그 사실을 말한다 — 다른
    /// 사람에게 처음 보이는 순간이라, "올림" 과 다른 일이다.
    #[test]
    fn push_publishes_a_branch_that_was_only_here() {
        let repo = repository();
        let remote = tempfile::tempdir().expect("tempdir");
        git(repo.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        Command::new("git")
            .args(["init", "--bare", "-b", "main"])
            .arg(remote.path())
            .output()
            .expect("bare");

        let receipt = push(path(&repo)).expect("push");

        assert_eq!(
            receipt,
            PushReceipt {
                branch: "feature".to_string(),
                remote: "origin".to_string(),
                published: true,
            }
        );
        // 두 번째는 새로 만드는 것이 아니다.
        commit(path(&repo), &["a.txt".to_string()], "more").expect("commit");
        assert!(!push(path(&repo)).expect("push again").published);
    }

    /// fast-forward 가 아니면 거절하는 것은 우리가 아니라 git 이다. 강제 옵션이
    /// 없으므로 이 함수가 원격 히스토리를 덮어쓸 방법은 없다.
    #[test]
    fn push_cannot_overwrite_what_is_already_there() {
        let repo = repository();
        let remote = tempfile::tempdir().expect("tempdir");
        Command::new("git")
            .args(["init", "--bare", "-b", "main"])
            .arg(remote.path())
            .output()
            .expect("bare");
        git(repo.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        push(path(&repo)).expect("first push");
        let published = run_git(path(&repo), &["rev-parse", "HEAD"]).expect("sha");

        // 다른 사람이 그 브랜치를 앞으로 옮겨 두었다. 이쪽은 그것을 모른다.
        let other = tempfile::tempdir().expect("tempdir");
        let other_path = other.path().to_str().unwrap();
        Command::new("git")
            .args(["clone", remote.path().to_str().unwrap(), other_path])
            .output()
            .expect("clone");
        git(other.path(), &["checkout", "-q", "feature"]);
        fs::write(other.path().join("theirs.txt"), "theirs\n").unwrap();
        git(other.path(), &["add", "."]);
        git(other.path(), &["commit", "-m", "theirs"]);
        git(other.path(), &["push", "origin", "feature"]);

        // 이쪽에서 갈라진 커밋을 만들고 올리려 한다.
        fs::write(repo.path().join("a.txt"), "diverged\n").unwrap();
        commit(path(&repo), &["a.txt".to_string()], "mine").expect("commit");

        assert!(push(path(&repo)).is_err(), "갈라진 push 가 통과했다");
        // 그리고 그 사람의 커밋은 원격에 그대로 있다.
        let remote_head = run_git(other_path, &["rev-parse", "origin/feature"]).expect("sha");
        assert_ne!(remote_head.trim(), published.trim());
    }

    /// 저장소 설정이 push 를 강제로 만들 수 있다. 이 시험이 그것을 막는다.
    ///
    /// `remote.<name>.push = +refs/heads/*:refs/heads/*` 는 한 줄짜리 설정이고
    /// (개인 미러, 복사해 온 config, 클론해 온 저장소), `git push` 만 부르면
    /// **모든 브랜치를 강제로** 덮어쓴다 — `+` 접두사가 플래그 없는
    /// `--force` 다. exit 0 으로 끝나고, bare 저장소에는 reflog 도 없다.
    ///
    /// 명령줄에 refspec 을 주면 git 은 그 설정을 보지 않는다. 그것이 이
    /// 함수가 원격과 브랜치를 **언제나** 명시하는 이유다.
    #[test]
    fn a_forcing_refspec_in_config_cannot_reach_through_this_push() {
        let repo = repository();
        let remote = tempfile::tempdir().expect("tempdir");
        Command::new("git")
            .args(["init", "--bare", "-b", "main"])
            .arg(remote.path())
            .output()
            .expect("bare");
        git(repo.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        // main 을 원격에 올려 두고, 다른 사람의 커밋이 그 위에 있게 한다.
        git(repo.path(), &["push", "origin", "main"]);
        let other = tempfile::tempdir().expect("tempdir");
        let other_path = other.path().to_str().unwrap();
        Command::new("git")
            .args(["clone", remote.path().to_str().unwrap(), other_path])
            .output()
            .expect("clone");
        fs::write(other.path().join("theirs.txt"), "theirs\n").unwrap();
        git(other.path(), &["add", "."]);
        git(other.path(), &["commit", "-m", "theirs"]);
        git(other.path(), &["push", "origin", "main"]);
        let theirs = run_git(other_path, &["rev-parse", "origin/main"]).expect("sha");

        // 그리고 저장소에 강제 refspec 이 심겨 있다.
        git(
            repo.path(),
            &["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"],
        );
        // `feature` 는 main 과 갈라져 있으므로, 이 설정이 닿으면 main 이
        // 강제로 되감긴다.
        push(path(&repo)).expect("feature 는 올라가야 한다");

        let after = run_git(remote.path().to_str().unwrap(), &["rev-parse", "main"])
            .expect("원격 main");
        assert_eq!(
            after.trim(),
            theirs.trim(),
            "설정의 강제 refspec 이 남의 main 을 덮어썼다"
        );
    }

    /// `push.default` 도 마찬가지다. `upstream` 이면 브랜치의 `merge` 설정이
    /// 가리키는 곳으로 가고, `matching` 이면 이름이 같은 모든 브랜치가 간다.
    /// 둘 다 명령줄 refspec 앞에서는 아무 일도 하지 않는다.
    #[test]
    fn push_default_cannot_redirect_this_push() {
        for mode in ["matching", "upstream", "current", "nothing", "tracking"] {
            let repo = repository();
            let remote = tempfile::tempdir().expect("tempdir");
            Command::new("git")
                .args(["init", "--bare", "-b", "main"])
                .arg(remote.path())
                .output()
                .expect("bare");
            git(repo.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
            git(repo.path(), &["push", "origin", "main"]);
            let main_before =
                run_git(remote.path().to_str().unwrap(), &["rev-parse", "main"]).expect("sha");

            git(repo.path(), &["config", "push.default", mode]);
            // `upstream`/`tracking` 이 가리킬 자리를 main 으로 심어 둔다 — 이
            // 설정이 닿으면 feature 의 커밋이 main 으로 간다.
            git(repo.path(), &["config", "branch.feature.merge", "refs/heads/main"]);
            git(repo.path(), &["config", "branch.feature.remote", "origin"]);

            push(path(&repo)).unwrap_or_else(|error| panic!("{mode}: {error}"));

            let main_after =
                run_git(remote.path().to_str().unwrap(), &["rev-parse", "main"]).expect("sha");
            assert_eq!(
                main_before.trim(),
                main_after.trim(),
                "push.default={mode} 이 main 을 움직였다"
            );
            let feature = run_git(remote.path().to_str().unwrap(), &["rev-parse", "feature"]);
            assert!(feature.is_ok(), "push.default={mode} 에서 feature 가 안 올라갔다");
        }
    }

    /// 이 저장소 자신의 설정으로 재현한 시험.
    ///
    /// 여기서는 46개 로컬 브랜치가 `branch.<name>.merge = refs/heads/main` 을
    /// 두고 있다 — 오설정이 아니라 이 저장소의 작업 방식이다(AGENTS.md: PR 없이
    /// `git push origin HEAD:main`). 그래서 "내 브랜치를 upstream 으로
    /// fast-forward" 는 이 저장소에서 **"검토 안 한 작업 브랜치를 공유
    /// main 으로 만들기"** 와 같은 말이 된다.
    ///
    /// 완전히 수식한 refspec 만이 그것을 막는다. 이 시험이 없으면, 브랜치
    /// 이름만 넘기는 "명백해 보이는" 구현으로 언제든 되돌아갈 수 있다.
    #[test]
    fn this_repositorys_own_upstream_convention_cannot_redirect_a_push() {
        let repo = repository();
        let remote = tempfile::tempdir().expect("tempdir");
        Command::new("git")
            .args(["init", "--bare", "-b", "main"])
            .arg(remote.path())
            .output()
            .expect("bare");
        git(repo.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        git(repo.path(), &["push", "origin", "main"]);
        let main_before =
            run_git(remote.path().to_str().unwrap(), &["rev-parse", "main"]).expect("sha");

        // 이 워크트리가 실제로 들고 있는 설정 그대로.
        git(repo.path(), &["config", "branch.feature.remote", "origin"]);
        git(repo.path(), &["config", "branch.feature.merge", "refs/heads/main"]);

        push(path(&repo)).expect("push");

        let main_after =
            run_git(remote.path().to_str().unwrap(), &["rev-parse", "main"]).expect("sha");
        assert_eq!(
            main_before.trim(),
            main_after.trim(),
            "작업 브랜치가 공유 main 위로 올라갔다"
        );
        assert!(
            run_git(remote.path().to_str().unwrap(), &["rev-parse", "feature"]).is_ok(),
            "feature 가 자기 이름으로 안 올라갔다"
        );
        // 그리고 이미 있던 upstream 설정은 건드리지 않는다 — 데스크탑의 앞뒤
        // 수가 답하는 질문이 말없이 바뀌면 안 된다.
        assert_eq!(
            run_git(path(&repo), &["config", "--get", "branch.feature.merge"])
                .expect("merge 설정")
                .trim(),
            "refs/heads/main"
        );
    }

    /// 원격이 둘이면 어느 쪽인지는 사람이 정할 일이다. `origin` 을 골라 주면
    /// fork 로 일하는 사람의 코드가 상류로 간다.
    #[test]
    fn push_refuses_when_it_cannot_tell_which_remote() {
        let repo = repository();

        // 원격이 아예 없을 때.
        assert!(push(path(&repo)).is_err());

        let a = tempfile::tempdir().expect("tempdir");
        let b = tempfile::tempdir().expect("tempdir");
        git(repo.path(), &["remote", "add", "origin", a.path().to_str().unwrap()]);
        git(repo.path(), &["remote", "add", "upstream", b.path().to_str().unwrap()]);

        assert!(push(path(&repo)).is_err(), "원격 둘 중 하나를 골랐다");
    }

    /// detached HEAD 에는 올릴 브랜치가 없다.
    #[test]
    fn push_refuses_a_detached_head() {
        let repo = repository();
        let remote = tempfile::tempdir().expect("tempdir");
        git(repo.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        let head = run_git(path(&repo), &["rev-parse", "HEAD"]).expect("sha");
        git(repo.path(), &["checkout", "-q", "--detach", head.trim()]);

        assert!(push(path(&repo)).is_err());
    }

    #[test]
    fn checkout_moves_to_an_existing_branch() {
        let repo = repository();

        checkout(path(&repo), "main").expect("checkout");

        let head = run_git(path(&repo), &["symbolic-ref", "--short", "HEAD"]).expect("head");
        assert_eq!(head.trim(), "main");
    }

    /// 없는 이름으로는 못 간다. `checkout <이름>` 은 원격에 같은 이름이 있으면
    /// 브랜치를 새로 만드는데, 그건 사용자가 고른 목록에 없던 일이다.
    #[test]
    fn checkout_refuses_a_branch_that_does_not_exist() {
        let repo = repository();

        assert!(checkout(path(&repo), "does-not-exist").is_err());
        let head = run_git(path(&repo), &["symbolic-ref", "--short", "HEAD"]).expect("head");
        assert_eq!(head.trim(), "feature");
    }

    /// 이름이 플래그가 되지 못한다. git 은 `-oops` 라는 ref 를 실제로 만들 수
    /// 있고, `git checkout -oops` 는 그것을 플래그로 읽는다.
    #[test]
    fn a_branch_name_that_looks_like_a_flag_is_refused() {
        let repo = repository();

        for candidate in ["-f", "--orphan", "-", "  "] {
            assert!(
                checkout(path(&repo), candidate).is_err(),
                "{candidate} 를 받아들였다"
            );
            assert!(create_branch(path(&repo), candidate).is_err());
        }
    }

    /// 규칙의 주인은 git 이다. 우리가 쓴 사본이 아니라 git 이 판정한다.
    #[test]
    fn git_decides_which_branch_names_are_writable() {
        let repo = repository();

        for candidate in ["a b", "a..b", "a~1", "refs/heads/x/", "x.lock"] {
            assert!(
                create_branch(path(&repo), candidate).is_err(),
                "{candidate} 를 받아들였다"
            );
        }
        create_branch(path(&repo), "fix/payment-retry").expect("valid name");
    }

    /// 새 브랜치는 **지금 HEAD** 에서 갈라진다. 기준을 대신 골라 주면 방금 만든
    /// 커밋이 새 브랜치에 없게 되고, 그 사실은 화면에 안 나온다.
    #[test]
    fn a_new_branch_starts_where_the_worktree_is_standing() {
        let repo = repository();
        commit(path(&repo), &["a.txt".to_string()], "on feature").expect("commit");
        let head = run_git(path(&repo), &["rev-parse", "HEAD"]).expect("head");

        create_branch(path(&repo), "fix/from-here").expect("create");

        assert_eq!(
            run_git(path(&repo), &["rev-parse", "HEAD"]).expect("head"),
            head
        );
        assert_eq!(
            run_git(path(&repo), &["symbolic-ref", "--short", "HEAD"])
                .expect("branch")
                .trim(),
            "fix/from-here"
        );
    }

    #[test]
    fn creating_a_branch_that_exists_says_so_rather_than_moving() {
        let repo = repository();

        assert!(create_branch(path(&repo), "main").is_err());
        assert_eq!(
            run_git(path(&repo), &["symbolic-ref", "--short", "HEAD"])
                .expect("branch")
                .trim(),
            "feature"
        );
    }

    #[test]
    fn branches_marks_the_current_one_and_orders_by_recency() {
        let repo = repository();

        let rows = branches(path(&repo)).expect("branches");

        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, vec!["feature", "main"]);
        assert!(rows[0].current);
        assert!(!rows[1].current);
        // 시안의 "3분" 자리. 없으면 안 그린다 — 0 으로 채우면 거짓말이 된다.
        assert!(rows[0].when.is_some());
    }
}
