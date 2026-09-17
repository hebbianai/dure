use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Child Git commands must not inherit repository-routing variables from the
/// process that launched Dure. In particular, linked-worktree test runners can
/// carry a GIT_DIR for a completely different checkout. Remove the whole Git
/// namespace instead of maintaining an incomplete deny-list.
pub(crate) fn scrub_git_environment(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
}

/// Parse `git status --porcelain=v2 --branch` output.
/// Shared by local and remote (over ssh) status checks.
pub fn parse_porcelain_v2(s: &str) -> GitStatus {
    let mut st = GitStatus { is_repo: true, ..Default::default() };
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            st.branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    st.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    st.behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy = line.split_whitespace().nth(1).unwrap_or("..");
            let mut chars = xy.chars();
            let x = chars.next().unwrap_or('.');
            let y = chars.next().unwrap_or('.');
            if x != '.' {
                st.staged += 1;
            }
            if y != '.' {
                st.unstaged += 1;
            }
        } else if line.starts_with("? ") {
            st.untracked += 1;
        } else if line.starts_with("u ") {
            st.unstaged += 1;
        }
    }
    st
}

pub(crate) fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).args(args);
    scrub_git_environment(&mut command);
    let out = command
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn status(path: &str) -> GitStatus {
    // Observing status must not refresh/write the index or contend with agent writes.
    match run_git(path, &["--no-optional-locks", "status", "--porcelain=v2", "--branch"]) {
        Ok(out) => parse_porcelain_v2(&out),
        Err(_) => GitStatus::default(),
    }
}

#[derive(Serialize, Clone)]
pub struct ExecOut {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Run an arbitrary git subcommand in `repo`, returning combined output +
/// exit code (never errors on non-zero — the caller shows stderr to the user).
pub fn exec(repo: &str, args: &[String]) -> ExecOut {
    match Command::new("git").arg("-C").arg(repo).args(args).output() {
        Ok(out) => ExecOut {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code().unwrap_or(-1),
        },
        Err(e) => ExecOut { stdout: String::new(), stderr: format!("git: {e}"), code: -1 },
    }
}

/// Bytes captured from a bounded git subcommand before it is force-killed.
/// Matches provider_preflight's login-shell/version probe budget — enough for
/// `fetch`/`rev-parse` output without letting a runaway command grow unbounded.
const BOUNDED_EXEC_OUTPUT_LIMIT: usize = 256 * 1024;

/// Like `exec`, but bounded by `timeout_ms` — for best-effort git subcommands
/// (e.g. a default-branch fetch/probe) that must never block the caller
/// indefinitely. On timeout the child's whole process group is killed by
/// `run_command` and this returns the fixed `git_exec_timeout` contract; on
/// spawn/inspection failure it reports the error instead (never errors on a
/// non-zero exit — same contract as `exec`).
pub(crate) fn exec_bounded(repo: &str, args: &[String], timeout_ms: u64) -> ExecOut {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).args(args);
    match crate::provider_preflight::run_command(
        &mut command,
        std::time::Duration::from_millis(timeout_ms),
        BOUNDED_EXEC_OUTPUT_LIMIT,
    ) {
        Ok(output) => ExecOut {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(-1),
        },
        Err(crate::provider_preflight::CommandFailure::Timeout) => {
            ExecOut { stdout: String::new(), stderr: "git_exec_timeout".to_string(), code: -1 }
        }
        Err(crate::provider_preflight::CommandFailure::Failed(e)) => {
            ExecOut { stdout: String::new(), stderr: format!("git: {e}"), code: -1 }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

// --- 브랜치 명시 워크트리 프로비저닝 (hebbian-frontend-qvu) ---
// 프론트의 순수 planner(src/lib/worktreePlan.ts)가 계획을 세우고, 백엔드가 그
// 계획을 실행한다. 경로 파생·sanitize 규칙은 planner와 바이트 단위로 일치한다.

/// 셸 인터폴레이션용 단일 인용 — `'` → `'\''`. SSH 명령 문자열에서 repo/경로/
/// 브랜치/base 모든 값에 적용한다(레거시 quote-strip보다 강함, H3 방지).
fn sh_squote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// planner의 `sanitizeSegment`와 동일 규칙 — is_alphanumeric()은 유니코드
/// Alphabetic ∪ Number라 planner의 `/[\p{Alphabetic}\p{N}_-]/u`와 일치한다.
fn sanitize_segment(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// 브랜치 이름 → 워크트리 디렉토리 이름(마지막 세그먼트, planner와 동일).
fn worktree_dir_name(branch: &str) -> String {
    let trimmed = branch.trim().trim_end_matches('/');
    let last = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let dir = sanitize_segment(last);
    if dir.is_empty() { sanitize_segment(trimmed) } else { dir }
}

/// 기본 워크트리 루트 — planner(worktreePlan.ts)와 같은 값이어야 한다.
const DEFAULT_WORKTREE_ROOT: &str = ".worktrees";

/// 사용자가 고른 워크트리 루트를 신뢰 가능한 형태로 정규화한다.
///
/// 클라이언트가 준 것은 "레포 기준 상대 디렉터리"뿐이고 전체 경로가 아니다 —
/// 경로 조립은 여전히 백엔드가 한다(worktreePath 바꿔치기 방지). 여기서는
/// 절대 경로와 `..`로 레포 밖 임의 지점까지 올라가는 입력을 잘라낸다.
/// `../` 한 겹(레포의 형제 디렉터리)은 허용된 선택지다.
fn normalize_worktree_root(root: Option<&str>) -> String {
    let raw = root.map(str::trim).filter(|r| !r.is_empty()).unwrap_or(DEFAULT_WORKTREE_ROOT);
    let portable = raw.replace('\\', "/");
    if portable.starts_with('/')
        || portable
            .as_bytes()
            .get(1)
            .is_some_and(|separator| *separator == b':')
    {
        return DEFAULT_WORKTREE_ROOT.to_string();
    }
    let mut depth: i32 = 0;
    let mut parts: Vec<&str> = Vec::new();
    for seg in portable.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                depth -= 1;
                // 레포 위로 두 겹 이상 올라가는 입력은 받지 않는다.
                if depth < -1 {
                    return DEFAULT_WORKTREE_ROOT.to_string();
                }
                parts.push("..");
            }
            other => {
                depth += 1;
                parts.push(other);
            }
        }
    }
    if parts.is_empty() { DEFAULT_WORKTREE_ROOT.to_string() } else { parts.join("/") }
}

/// 루트가 레포 안인가 — 밖이면 info/exclude에 넣을 대상이 아니다.
fn root_is_inside_repo(root: &str) -> bool {
    !root.split('/').next().is_some_and(|first| first == "..")
}

/// `<repo>/<root>/<dir>` — 백엔드가 권위적으로 파생한다(클라이언트가
/// worktreePath로 경로를 바꿔치기하지 못하게, create/checkout에서 재계산).
fn derived_worktree_path(repo: &str, branch: &str, root: Option<&str>) -> String {
    let base = repo.trim_end_matches('/');
    let root = normalize_worktree_root(root);
    let joined = format!("{base}/{root}/{}", worktree_dir_name(branch));
    // `..`를 문자 그대로 남기면 git이 만든 워크트리 경로(절대·정규화)와
    // 문자열 비교가 어긋난다 — 여기서 접어 준다.
    normalize_absolute_path(&joined)
}

/// Host-native path for local worktree operations. Remote SSH commands keep
/// using `derived_worktree_path`, whose output is intentionally POSIX.
fn derived_local_worktree_path(repo: &str, branch: &str, root: Option<&str>) -> String {
    local_worktree_root(repo, root)
        .join(worktree_dir_name(branch))
        .to_string_lossy()
        .into_owned()
}

fn local_worktree_root(repo: &str, root: Option<&str>) -> PathBuf {
    let mut path = PathBuf::from(repo);
    for segment in normalize_worktree_root(root).split('/') {
        if segment == ".." {
            path.pop();
        } else {
            path.push(segment);
        }
    }
    path
}

fn local_path_key(path: &str) -> String {
    let normalized = std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .replace('\\', "/");
    #[cfg(windows)]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

/// 절대 경로의 `.`/`..`를 문자열 수준에서 접는다(심링크는 따지지 않는다 —
/// git worktree list가 돌려주는 표기와 맞추는 것이 목적이다).
fn normalize_absolute_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    format!("/{}", out.join("/"))
}

/// 워크트리의 실제 체크아웃 브랜치(C1: 절대 추측하지 않는다). discover.rs와
/// 동일하게 detached는 "(detached)" 라벨.
fn worktree_actual_branch(wt_path: &str) -> String {
    run_git(wt_path, &["symbolic-ref", "--short", "HEAD"])
        .map(|b| b.trim().to_string())
        .unwrap_or_else(|_| "(detached)".to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub checked_out_at: Option<String>,
}

/// 로컬 저장소의 브랜치 목록 + 각 브랜치가 체크아웃된 워크트리 경로.
pub fn list_branches(repo: &str) -> Result<Vec<BranchInfo>, String> {
    let names = run_git(repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])?;
    let wt = run_git(repo, &["worktree", "list", "--porcelain"])?;
    let mut at: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut cur: Option<String> = None;
    for line in wt.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = &cur {
                at.insert(b.to_string(), p.clone());
            }
        }
    }
    Ok(names
        .lines()
        .filter(|l| !l.is_empty())
        .map(|n| BranchInfo { name: n.to_string(), checked_out_at: at.get(n).cloned() })
        .collect())
}

/// SSH용 — 위와 동일 정보를 안정적인 라인 포맷(`B <name>` / `C <path>\t<branch>`)
/// 으로 찍는 셸 명령. parse_branches로 파싱한다.
pub fn list_branches_command(repo: &str) -> String {
    let repo_q = sh_squote(repo);
    format!(
        r#"git -C {repo_q} for-each-ref --format='B %(refname:short)' refs/heads 2>/dev/null
git -C {repo_q} worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    "worktree "*) p="${{line#worktree }}" ;;
    "branch refs/heads/"*) printf 'C %s\t%s\n' "$p" "${{line#branch refs/heads/}}" ;;
  esac
done
true"#
    )
}

pub fn parse_branches(output: &str) -> Vec<BranchInfo> {
    let mut names = Vec::new();
    let mut at: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in output.lines() {
        if let Some(b) = line.strip_prefix("B ") {
            names.push(b.to_string());
        } else if let Some(rest) = line.strip_prefix("C ") {
            if let Some((path, branch)) = rest.split_once('\t') {
                at.insert(branch.to_string(), path.to_string());
            }
        }
    }
    names
        .into_iter()
        .map(|name| {
            let checked_out_at = at.get(&name).cloned();
            BranchInfo { name, checked_out_at }
        })
        .collect()
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum WorktreeAction {
    CreateNewBranch,
    CheckoutExistingBranch,
    AdoptWorktree,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProvisionPlan {
    pub repo: String,
    pub branch: String,
    /// adopt에서만 신뢰(검증 후) — create/checkout는 백엔드가 경로를 재계산한다.
    pub worktree_path: String,
    pub action: WorktreeAction,
    pub base_ref: Option<String>,
    /// 워크트리를 담을 레포 기준 상대 디렉터리(예: `.worktrees/`, `../`).
    /// 전체 경로가 아니라 루트만 받는다 — 조립은 백엔드가 계속 맡는다.
    pub worktree_root: Option<String>,
}

/// 워크트리 루트 스캐폴드 + .git/info/exclude 등록(best-effort).
///
/// 루트가 레포 밖(`../`)이면 exclude 등록은 하지 않는다 — 레포가 추적하지 않는
/// 경로라 무시 규칙을 넣을 대상이 아니다. 디렉터리 생성은 양쪽 다 한다.
fn ensure_worktrees_scaffold(repo: &str, worktree_root: Option<&str>) {
    let root = normalize_worktree_root(worktree_root);
    let _ = std::fs::create_dir_all(local_worktree_root(repo, Some(&root)));
    if !root_is_inside_repo(&root) {
        return;
    }
    let entry = format!("{}/", root.trim_end_matches('/'));
    if let Ok(rel) = run_git(repo, &["rev-parse", "--git-path", "info/exclude"]) {
        let rel = rel.trim();
        if rel.is_empty() {
            return;
        }
        let p = if Path::new(rel).is_absolute() {
            PathBuf::from(rel)
        } else {
            PathBuf::from(repo).join(rel)
        };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let has = std::fs::read_to_string(&p)
            .map(|c| c.lines().any(|l| l == entry))
            .unwrap_or(false);
        if !has {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
                let _ = writeln!(f, "{entry}");
            }
        }
    }
}

/// adopt 대상이 실제로 등록된 워크트리인지 확인(C2/H2: 아무 폴더나 재사용 금지).
fn validate_registered_worktree(repo: &str, wt_path: &str) -> Result<(), String> {
    let out = run_git(repo, &["worktree", "list", "--porcelain"])?;
    let expected = local_path_key(wt_path);
    if out
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .any(|path| local_path_key(path) == expected)
    {
        Ok(())
    } else {
        Err(format!("The adoption target is not a registered worktree: {wt_path}"))
    }
}

/// 계획을 실행한다(로컬). create/checkout는 argv(run_git)라 셸 주입이 불가능하고,
/// 반환 브랜치는 항상 실제 체크아웃 값이다(C1).
pub fn provision_worktree(plan: &WorktreeProvisionPlan) -> Result<WorktreeInfo, String> {
    let repo = plan.repo.as_str();
    match plan.action {
        WorktreeAction::CreateNewBranch => {
            let wt = derived_local_worktree_path(repo, &plan.branch, plan.worktree_root.as_deref());
            ensure_worktrees_scaffold(repo, plan.worktree_root.as_deref());
            let _ = run_git(repo, &["worktree", "prune"]);
            let base = plan.base_ref.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if let Some(b) = base {
                let spec = format!("{b}^{{commit}}");
                run_git(repo, &["rev-parse", "--verify", "--quiet", &spec])
                    .map_err(|_| format!("The base ref is invalid: {b}"))?;
            }
            let mut args = vec!["worktree", "add", wt.as_str(), "-b", plan.branch.as_str()];
            if let Some(b) = base {
                args.push(b);
            }
            run_git(repo, &args)?;
            Ok(WorktreeInfo { branch: worktree_actual_branch(&wt), path: wt })
        }
        WorktreeAction::CheckoutExistingBranch => {
            let wt = derived_local_worktree_path(repo, &plan.branch, plan.worktree_root.as_deref());
            ensure_worktrees_scaffold(repo, plan.worktree_root.as_deref());
            let _ = run_git(repo, &["worktree", "prune"]);
            run_git(repo, &["worktree", "add", wt.as_str(), plan.branch.as_str()])?;
            Ok(WorktreeInfo { branch: worktree_actual_branch(&wt), path: wt })
        }
        WorktreeAction::AdoptWorktree => {
            validate_registered_worktree(repo, &plan.worktree_path)?;
            Ok(WorktreeInfo {
                branch: worktree_actual_branch(&plan.worktree_path),
                path: plan.worktree_path.clone(),
            })
        }
    }
}

/// SSH용 — provision_worktree와 동일 의미의 셸 명령 + wt 경로를 돌려준다. 실제
/// 브랜치는 stdout의 `worktree-branch <b>` 트레일러로 전달한다(git add 진행은
/// stderr로 감). 모든 인터폴레이션은 sh_squote로 감싼다(H3).
pub fn provision_worktree_command(plan: &WorktreeProvisionPlan) -> (String, String) {
    let repo_q = sh_squote(&plan.repo);
    let root = normalize_worktree_root(plan.worktree_root.as_deref());
    let root_q = sh_squote(&root);
    // 레포 밖(`../`) 루트는 무시 규칙을 넣을 대상이 아니다 — 디렉터리만 만든다.
    let exclude = if root_is_inside_repo(&root) {
        let entry_q = sh_squote(&format!("{}/", root.trim_end_matches('/')));
        format!(
            "{{ excl=\"$(git rev-parse --git-path info/exclude 2>/dev/null)\"; \
               if [ -n \"$excl\" ]; then mkdir -p \"$(dirname \"$excl\")\"; \
               grep -qxF {entry_q} \"$excl\" 2>/dev/null || echo {entry_q} >> \"$excl\"; fi; }} ; "
        )
    } else {
        String::new()
    };
    let scaffold =
        format!("cd {repo_q} && mkdir -p {root_q} && {exclude}git worktree prune");
    match plan.action {
        WorktreeAction::CreateNewBranch => {
            let wt = derived_worktree_path(&plan.repo, &plan.branch, plan.worktree_root.as_deref());
            let (wt_q, branch_q) = (sh_squote(&wt), sh_squote(&plan.branch));
            let base = plan.base_ref.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let base_arg = base.map(|b| format!(" {}", sh_squote(b))).unwrap_or_default();
            (
                format!(
                    "{scaffold} && git worktree add {wt_q} -b {branch_q}{base_arg} && \
                     printf 'worktree-branch %s\\n' \"$(git -C {wt_q} symbolic-ref --short HEAD 2>/dev/null || echo '(detached)')\""
                ),
                wt,
            )
        }
        WorktreeAction::CheckoutExistingBranch => {
            let wt = derived_worktree_path(&plan.repo, &plan.branch, plan.worktree_root.as_deref());
            let (wt_q, branch_q) = (sh_squote(&wt), sh_squote(&plan.branch));
            (
                format!(
                    "{scaffold} && git worktree add {wt_q} {branch_q} && \
                     printf 'worktree-branch %s\\n' \"$(git -C {wt_q} symbolic-ref --short HEAD 2>/dev/null || echo '(detached)')\""
                ),
                wt,
            )
        }
        WorktreeAction::AdoptWorktree => {
            let wt = plan.worktree_path.clone();
            let (wt_q, line_q) = (sh_squote(&wt), sh_squote(&format!("worktree {wt}")));
            (
                format!(
                    "git -C {repo_q} worktree list --porcelain | grep -qxF {line_q} && \
                     printf 'worktree-branch %s\\n' \"$(git -C {wt_q} symbolic-ref --short HEAD 2>/dev/null || echo '(detached)')\""
                ),
                wt,
            )
        }
    }
}

/// The shell command used to create an agent worktree. Built here so the
/// exact same command can be executed remotely over ssh.
/// `from`: 새 브랜치를 딸 기준 ref (포크용, 없으면 HEAD).
pub fn worktree_command(repo: &str, name: &str, from: Option<&str>) -> (String, String, String) {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let wt_path = format!("{repo}/.worktrees/{safe}");
    let branch = format!("agent/{safe}");
    let from_ref: String = from
        .map(|f| f.chars().filter(|c| *c != '\'').collect::<String>())
        .filter(|f| !f.is_empty())
        .map(|f| format!(" '{f}'"))
        .unwrap_or_default();
    // .git이 파일인 경우(워크트리/서브모듈)나 info/ 폴더가 없을 수 있으므로
    // rev-parse로 실제 exclude 경로를 구하고, 이 단계는 실패해도 무시(best-effort).
    let cmd = format!(
        "cd '{repo}' && mkdir -p .worktrees && \
         {{ excl=\"$(git rev-parse --git-path info/exclude 2>/dev/null)\"; \
            if [ -n \"$excl\" ]; then mkdir -p \"$(dirname \"$excl\")\"; \
            grep -qxF '.worktrees/' \"$excl\" 2>/dev/null || echo '.worktrees/' >> \"$excl\"; fi; }} ; \
         git worktree prune && \
         if [ -d '{wt_path}' ]; then echo 'reusing existing worktree'; \
         else git worktree add '{wt_path}' -b '{branch}'{from_ref} 2>&1 || git worktree add '{wt_path}' '{branch}' 2>&1; fi"
    );
    (cmd, wt_path, branch)
}

pub fn create_worktree(repo: &str, name: &str, from: Option<&str>) -> Result<WorktreeInfo, String> {
    let safe = sanitize_segment(name);
    let branch = format!("agent/{safe}");
    let wt_path = derived_local_worktree_path(repo, &branch, None);
    ensure_worktrees_scaffold(repo, None);
    let _ = run_git(repo, &["worktree", "prune"]);
    if Path::new(&wt_path).is_dir() {
        validate_registered_worktree(repo, &wt_path)?;
    } else {
        let mut args = vec!["worktree", "add", wt_path.as_str(), "-b", branch.as_str()];
        if let Some(base) = from.map(str::trim).filter(|value| !value.is_empty()) {
            args.push(base);
        }
        if run_git(repo, &args).is_err() {
            run_git(repo, &["worktree", "add", wt_path.as_str(), branch.as_str()])?;
        }
    }
    // C1: 재사용 경로에서 추측한 agent/<name> 대신 실제 체크아웃 브랜치를 돌려준다.
    // fork/spawnSaga는 항상 새 고유 이름을 만들어 재사용에 걸리지 않으므로 무해.
    let real = worktree_actual_branch(&wt_path);
    let branch = if real == "(detached)" { branch } else { real };
    Ok(WorktreeInfo { path: wt_path, branch })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_repo: bool,
    /// True when .gitignore (or any git exclude rule) matches this entry.
    /// Only filled when the caller asks for it — see `list_dir`.
    pub ignored: bool,
}

/// Names that git considers ignored inside `dir`, asked in one batch.
///
/// `git check-ignore` exits 1 when nothing matched, which is not a failure —
/// only a spawn error is. Anything unexpected (no git, not a repo, weird
/// locale) yields an empty set, so the tree shows more rather than hiding a
/// file the user has: a listing that silently drops entries is worse than one
/// that shows an ignored build artifact.
fn ignored_names(dir: &str, names: &[String]) -> std::collections::HashSet<String> {
    use std::io::Write;
    if names.is_empty() {
        return std::collections::HashSet::new();
    }
    let mut child = match Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["check-ignore", "--stdin", "-z"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return std::collections::HashSet::new(),
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let mut payload = Vec::new();
        for name in names {
            payload.extend_from_slice(name.as_bytes());
            payload.push(0);
        }
        // 파이프가 먼저 닫혀도(엄청 큰 디렉터리) 이미 쓴 만큼은 판정된다.
        let _ = stdin.write_all(&payload);
    }
    // stdin은 여기서 드롭돼 EOF를 보낸다 — 안 닫으면 git이 계속 기다린다.
    drop(child.stdin.take());
    match child.wait_with_output() {
        Ok(out) => parse_check_ignore(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => std::collections::HashSet::new(),
    }
}

/// NUL로 나뉜 `check-ignore -z` 출력 → 이름 집합.
fn parse_check_ignore(stdout: &str) -> std::collections::HashSet<String> {
    stdout
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
        .collect()
}

/// `mark_ignored`가 참일 때만 git에 물어본다 — 무시된 파일을 그대로 보여 주는
/// 기본 설정에서는 목록마다 프로세스를 띄울 이유가 없다.
pub fn list_dir(
    path: &str,
    include_hidden: bool,
    mark_ignored: bool,
) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    for e in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let e = e.map_err(|err| err.to_string())?;
        let name = e.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let p = e.path();
        let is_dir = p.is_dir();
        let is_repo = is_dir && p.join(".git").exists();
        entries.push(DirEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir,
            is_repo,
            ignored: false,
        });
    }
    if mark_ignored {
        let names: Vec<String> = entries.iter().map(|entry| entry.name.clone()).collect();
        let ignored = ignored_names(path, &names);
        for entry in entries.iter_mut() {
            entry.ignored = ignored.contains(&entry.name);
        }
    }
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

#[cfg(test)]
#[path = "gitx_status_tests.rs"]
mod status_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_check_ignore_reads_nul_separated_names() {
        let set = parse_check_ignore("target\0node_modules\0");
        assert_eq!(set.len(), 2);
        assert!(set.contains("target"));
        assert!(set.contains("node_modules"));
    }

    #[test]
    fn parse_check_ignore_of_empty_output_marks_nothing() {
        assert!(parse_check_ignore("").is_empty());
    }

    #[test]
    fn parse_branches_maps_checkout_paths() {
        let out = "B main\nB agent/x\nC /srv/app\tmain\n";
        let branches = parse_branches(out);
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].name, "main");
        assert_eq!(branches[0].checked_out_at.as_deref(), Some("/srv/app"));
        assert_eq!(branches[1].name, "agent/x");
        assert_eq!(branches[1].checked_out_at, None);
    }

    #[test]
    fn worktree_dir_name_takes_last_segment() {
        assert_eq!(worktree_dir_name("agent/refactor-auth"), "refactor-auth");
        assert_eq!(worktree_dir_name("feature/x/"), "x");
        assert_eq!(worktree_dir_name("한글/브랜치"), "브랜치");
        assert_eq!(worktree_dir_name("weird name!"), "weird-name-");
        assert_eq!(worktree_dir_name("main"), "main");
    }

    #[test]
    fn sh_squote_escapes_apostrophes() {
        // o'brien → 'o'\''brien'
        assert_eq!(sh_squote("o'brien"), "'o'\\''brien'");
        assert_eq!(sh_squote("plain"), "'plain'");
    }

    #[test]
    fn derived_worktree_path_strips_trailing_slash() {
        assert_eq!(derived_worktree_path("/r/", "agent/a", None), "/r/.worktrees/a");
        assert_eq!(derived_worktree_path("/r", "feature/b/c", None), "/r/.worktrees/c");
    }

    /// 고급의 '워크트리 위치'가 실제 생성 경로에 닿는지 — 예전에는 백엔드가
    /// `.worktrees/`를 하드코딩해 무엇을 골라도 같은 곳에 만들어졌다.
    #[test]
    fn derived_worktree_path_honors_chosen_root() {
        assert_eq!(
            derived_worktree_path("/r", "feature", Some(".claude/worktrees/")),
            "/r/.claude/worktrees/feature"
        );
    }

    #[test]
    fn local_worktree_path_uses_native_separators() {
        let repo = std::env::temp_dir().join("dure-native-worktree-path");
        assert_eq!(
            PathBuf::from(derived_local_worktree_path(
                &repo.to_string_lossy(),
                "feature/x",
                Some(".claude/worktrees/"),
            )),
            repo.join(".claude").join("worktrees").join("x"),
        );
    }

    /// `../`는 레포의 형제 디렉터리다. 문자 그대로 두면 git이 돌려주는 정규화된
    /// 경로와 문자열 비교가 어긋나 경로 충돌 검사가 새 나간다.
    #[test]
    fn parent_root_is_folded_to_a_sibling_path() {
        assert_eq!(derived_worktree_path("/home/u/repo", "feature", Some("../")), "/home/u/feature");
    }

    #[test]
    fn absolute_or_escaping_roots_fall_back_to_default() {
        // 클라이언트가 절대 경로나 두 겹 이상 상위를 보내도 레포 밖 임의 지점에
        // 워크트리를 만들지 않는다.
        assert_eq!(normalize_worktree_root(Some("/etc")), ".worktrees");
        assert_eq!(normalize_worktree_root(Some(r"C:\\Windows")), ".worktrees");
        assert_eq!(normalize_worktree_root(Some("../../elsewhere")), ".worktrees");
        assert_eq!(normalize_worktree_root(Some(r"..\\..\\elsewhere")), ".worktrees");
        assert_eq!(normalize_worktree_root(Some("")), ".worktrees");
        assert_eq!(normalize_worktree_root(None), ".worktrees");
    }

    #[test]
    fn only_roots_inside_the_repo_are_excluded() {
        assert!(root_is_inside_repo(".worktrees"));
        assert!(root_is_inside_repo(".claude/worktrees"));
        assert!(!root_is_inside_repo(".."));
    }

    /// SSH 명령도 같은 루트를 따라야 한다 — 예전에는 `mkdir -p .worktrees`가
    /// 박혀 있어 원격에서는 선택이 통째로 무시됐다.
    #[test]
    fn ssh_command_uses_the_chosen_root() {
        let plan = WorktreeProvisionPlan {
            repo: "/srv/repo".into(),
            branch: "feature".into(),
            worktree_path: String::new(),
            action: WorktreeAction::CreateNewBranch,
            base_ref: None,
            worktree_root: Some(".claude/worktrees/".into()),
        };
        let (cmd, wt) = provision_worktree_command(&plan);
        assert_eq!(wt, "/srv/repo/.claude/worktrees/feature");
        assert!(cmd.contains("mkdir -p '.claude/worktrees'"), "{cmd}");
        assert!(cmd.contains("'.claude/worktrees/'"), "{cmd}");
        assert!(!cmd.contains("mkdir -p '.worktrees'"), "{cmd}");
    }

    /// 진짜 git 저장소에 워크트리를 만들어 본다 — 파생 문자열이 맞는 것과
    /// "그 자리에 실제로 생긴다"는 다르다(예전에는 백엔드가 경로를 재계산해
    /// 무엇을 골라도 .worktrees/ 아래에 만들어졌다).
    #[test]
    fn provisions_into_the_chosen_root_on_disk() {
        let repo = std::env::temp_dir().join(format!("dure-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run_git(&repo_s, &["init", "-q", "-b", "main"]).unwrap();
        run_git(&repo_s, &["config", "user.email", "t@t"]).unwrap();
        run_git(&repo_s, &["config", "user.name", "t"]).unwrap();
        run_git(&repo_s, &["config", "commit.gpgSign", "false"]).unwrap();
        run_git(&repo_s, &["commit", "-q", "--allow-empty", "-m", "init"]).unwrap();

        let plan = WorktreeProvisionPlan {
            repo: repo_s.clone(),
            branch: "feature".into(),
            worktree_path: String::new(),
            action: WorktreeAction::CreateNewBranch,
            base_ref: None,
            worktree_root: Some(".claude/worktrees/".into()),
        };
        let info = provision_worktree(&plan).unwrap();

        assert_eq!(
            PathBuf::from(&info.path),
            repo.join(".claude").join("worktrees").join("feature"),
        );
        assert!(Path::new(&info.path).is_dir(), "워크트리 디렉터리가 없다: {}", info.path);
        assert_eq!(info.branch, "feature");
        // 기본 루트에는 아무것도 만들어지지 않아야 한다.
        assert!(!repo.join(".worktrees").join("feature").exists());
        // 고른 루트가 info/exclude에 등록된다(.worktrees/가 아니라).
        let excl = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default();
        assert!(excl.lines().any(|l| l == ".claude/worktrees/"), "{excl}");

        let _ = std::fs::remove_dir_all(&repo);
    }

    /// 레포 밖 루트는 무시 규칙을 넣을 대상이 아니다.
    #[test]
    fn ssh_command_skips_exclude_for_roots_outside_the_repo() {
        let plan = WorktreeProvisionPlan {
            repo: "/srv/repo".into(),
            branch: "feature".into(),
            worktree_path: String::new(),
            action: WorktreeAction::CreateNewBranch,
            base_ref: None,
            worktree_root: Some("../".into()),
        };
        let (cmd, wt) = provision_worktree_command(&plan);
        assert_eq!(wt, "/srv/feature");
        assert!(!cmd.contains("info/exclude"), "{cmd}");
    }
}
