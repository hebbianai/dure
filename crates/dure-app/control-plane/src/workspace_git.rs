use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use dure_app::{
    AgentSpawnBranchModeV1, AgentSpawnStageDispositionV1, AgentSpawnWorkspaceLeaseV1,
    AgentSpawnWorktreePolicyV1, GitCheckoutRegistrationV1, OperationIdV1, WorkspaceIdV1,
};
use hebbian_bounded_process::UnixDirectoryAnchor;
use sha2::{Digest, Sha256};

mod checkout;
mod destination;
mod existing_checkout;
mod process;
use checkout::{acquire_workspace, resolve_workspace};
#[cfg(test)]
use destination::dedicated_path;
use destination::{
    ensure_worktree_root, prepare_workspace_destination, resolve_workspace_destination,
};
pub(crate) use existing_checkout::capture_existing_checkout;
use process::{git_output, git_output_bound};

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceAcquireRequest {
    pub(crate) project_root: PathBuf,
    pub(crate) workspace_id: WorkspaceIdV1,
    pub(crate) registration_id: OperationIdV1,
    pub(crate) registration: Option<GitCheckoutRegistrationV1>,
    pub(crate) policy: AgentSpawnWorktreePolicyV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceHandle {
    pub(crate) root: PathBuf,
    pub(crate) disposition: AgentSpawnStageDispositionV1,
    pub(crate) lease: Option<AgentSpawnWorkspaceLeaseV1>,
    pub(crate) registration: Option<GitCheckoutRegistrationV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceFailure {
    pub(crate) code: String,
    pub(crate) detail: Option<String>,
}

impl WorkspaceFailure {
    fn new(code: &'static str) -> Self {
        Self {
            code: code.into(),
            detail: None,
        }
    }
    fn with_detail(code: &'static str, message: &str) -> Self {
        // The existing receipt accepts one line of evidence, at most 1024
        // UTF-8 bytes. Diagnostic prose never determines the machine code.
        let mut detail = String::new();
        for word in
            message.split(|character: char| character.is_whitespace() || character.is_control())
        {
            if word.is_empty() {
                continue;
            }
            if !detail.is_empty() && detail.len() < 1024 {
                detail.push(' ');
            }
            for character in word.chars() {
                if detail.len() + character.len_utf8() > 1024 {
                    return Self {
                        code: code.into(),
                        detail: Some(detail.trim_end().into()),
                    };
                }
                detail.push(character);
            }
        }
        Self {
            code: code.into(),
            detail: (!detail.is_empty()).then_some(detail),
        }
    }
}

pub(crate) type WorkspaceFuture =
    Pin<Box<dyn Future<Output = Result<WorkspaceHandle, WorkspaceFailure>> + Send + 'static>>;

pub(crate) trait WorkspaceAcquirer: Send + Sync {
    fn acquire(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture;
    fn resolve(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture;
}

#[derive(Clone, Default)]
pub(crate) struct GitWorkspaceAcquirer {}

impl WorkspaceAcquirer for GitWorkspaceAcquirer {
    fn acquire(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture {
        Box::pin(async move {
            let request = normalize_workspace_request(request)?;
            let registration_id = request.registration_id.clone();
            let registration = request.registration.clone();
            claim_workspace(
                acquire_workspace(request).await?,
                registration_id,
                registration,
            )
            .await
        })
    }

    fn resolve(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture {
        Box::pin(async move {
            let request = normalize_workspace_request(request)?;
            let registration_id = request.registration_id.clone();
            let registration = request.registration.clone();
            claim_workspace(
                resolve_workspace(request).await?,
                registration_id,
                registration,
            )
            .await
        })
    }
}

fn normalize_workspace_request(
    mut request: WorkspaceAcquireRequest,
) -> Result<WorkspaceAcquireRequest, WorkspaceFailure> {
    request.project_root = canonical_project_root(&request)?;
    if request.registration.is_none()
        && let AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } = &request.policy
    {
        request.registration = Some(GitCheckoutRegistrationV1 {
            repository_path: request.project_root.to_string_lossy().into_owned(),
            instance: instance.clone(),
        });
    }
    Ok(request)
}

async fn claim_workspace(
    mut handle: WorkspaceHandle,
    registration_id: OperationIdV1,
    registration: Option<GitCheckoutRegistrationV1>,
) -> Result<WorkspaceHandle, WorkspaceFailure> {
    tokio::task::spawn_blocking(move || {
        handle.registration = dure_git_checkout::claim_git_checkout_registration(
            &handle.root,
            &registration_id,
            registration.as_ref(),
        )
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?;
        Ok(handle)
    })
    .await
    .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WorktreeEntry {
    path: PathBuf,
    head: String,
    branch_ref: Option<String>,
}

pub(crate) async fn resolve_base_commit(
    project_root: &Path,
    requested: Option<&str>,
) -> Result<String, String> {
    let revision = requested.unwrap_or("HEAD");
    let object = format!("{revision}^{{commit}}");
    let output = git_output(
        project_root,
        ["rev-parse", "--verify", object.as_str()],
        None,
    )
    .await
    .map_err(|_| "agent_spawn_worktree_base_invalid".to_string())?;
    if !output.status.success() {
        return Err("agent_spawn_worktree_base_invalid".into());
    }
    let resolved = single_line(&output.stdout)
        .ok_or_else(|| "agent_spawn_worktree_base_invalid".to_string())?;
    if requested.is_some_and(|requested| requested != resolved) {
        return Err("agent_spawn_worktree_base_invalid".into());
    }
    Ok(resolved.into())
}

pub(crate) async fn resolve_branch_base(
    project_root: &Path,
    branch: &str,
) -> Result<String, String> {
    let commit = read_ref(project_root, &format!("refs/heads/{branch}"))
        .await
        .map_err(|failure| failure.code)?
        .ok_or_else(|| "agent_spawn_worktree_base_invalid".to_string())?;
    resolve_base_commit(project_root, Some(&commit)).await
}

pub(crate) async fn validate_preview_policy(
    project_root: &Path,
    policy: &AgentSpawnWorktreePolicyV1,
) -> Result<(), String> {
    let (base_commit_sha, branch) = match policy {
        AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha,
            branch,
            ..
        } => (base_commit_sha, branch),
        AgentSpawnWorktreePolicyV1::ProjectRoot
        | AgentSpawnWorktreePolicyV1::ExistingCheckout { .. }
        | AgentSpawnWorktreePolicyV1::ExistingWorkspace { .. } => return Ok(()),
    };
    validate_branch(project_root, branch)
        .await
        .map_err(|_| "agent_spawn_worktree_branch_invalid".to_string())?;
    resolve_base_commit(project_root, Some(base_commit_sha)).await?;
    Ok(())
}

fn canonical_project_root(request: &WorkspaceAcquireRequest) -> Result<PathBuf, WorkspaceFailure> {
    if !request.project_root.is_absolute()
        || !request.project_root.is_dir()
        || request.project_root.to_str().is_none()
    {
        return Err(WorkspaceFailure::new("workspace_project_root_invalid"));
    }
    std::fs::canonicalize(&request.project_root)
        .map_err(|_| WorkspaceFailure::new("workspace_project_root_invalid"))
}

fn project_root_handle(root: PathBuf) -> WorkspaceHandle {
    WorkspaceHandle {
        root,
        disposition: AgentSpawnStageDispositionV1::AdoptedExisting,
        lease: None,
        registration: None,
    }
}

fn dedicated_handle(root: PathBuf, lease: AgentSpawnWorkspaceLeaseV1) -> WorkspaceHandle {
    WorkspaceHandle {
        root,
        disposition: AgentSpawnStageDispositionV1::CreatedDureOwned,
        lease: Some(lease),
        registration: None,
    }
}

fn is_exact_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && std::fs::canonicalize(path).is_ok_and(|canonical| canonical == path)
    })
}

fn lease_ref(workspace_id: &WorkspaceIdV1) -> String {
    let digest = Sha256::digest(workspace_id.as_str().as_bytes());
    format!("refs/dure/workspaces/{digest:x}")
}

async fn validate_branch(project_root: &Path, branch: &str) -> Result<(), WorkspaceFailure> {
    let output = git_output(project_root, ["check-ref-format", "--branch", branch], None).await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(WorkspaceFailure::new("workspace_branch_invalid"))
    }
}

async fn read_ref(
    project_root: &Path,
    reference: &str,
) -> Result<Option<String>, WorkspaceFailure> {
    let object = format!("{reference}^{{commit}}");
    let output = git_output(
        project_root,
        ["rev-parse", "--verify", "--quiet", object.as_str()],
        None,
    )
    .await?;
    if output.status.success() {
        return single_line(&output.stdout)
            .map(str::to_string)
            .ok_or_else(|| WorkspaceFailure::new("workspace_repository_response_invalid"))
            .map(Some);
    }
    if output.status.code() == Some(1) && output.stdout.is_empty() {
        return Ok(None);
    }
    Err(WorkspaceFailure::new("workspace_repository_unavailable"))
}

async fn create_ownership_refs(
    project_root: &Path,
    lease_ref: &str,
    branch_ref: &str,
    base_commit_sha: &str,
    branch_mode: AgentSpawnBranchModeV1,
    anchors: &[UnixDirectoryAnchor<'_>],
) -> Result<(), WorkspaceFailure> {
    let branch_action = match branch_mode {
        AgentSpawnBranchModeV1::Create => "create",
        AgentSpawnBranchModeV1::Existing => "verify",
    };
    let transaction = format!(
        "start\ncreate {lease_ref} {base_commit_sha}\n{branch_action} {branch_ref} {base_commit_sha}\nprepare\ncommit\n"
    );
    let output = git_output_bound(
        project_root,
        ["update-ref", "--stdin"],
        Some(transaction.as_bytes()),
        anchors,
    )
    .await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(WorkspaceFailure::new("workspace_identity_conflict"))
    }
}

async fn list_worktrees(project_root: &Path) -> Result<Vec<WorktreeEntry>, WorkspaceFailure> {
    let output = git_output(
        project_root,
        ["worktree", "list", "--porcelain", "-z"],
        None,
    )
    .await?;
    if !output.status.success() {
        return Err(WorkspaceFailure::new("workspace_repository_unavailable"));
    }
    parse_worktrees(&output.stdout)
}

fn parse_worktrees(source: &[u8]) -> Result<Vec<WorktreeEntry>, WorkspaceFailure> {
    let mut entries = Vec::new();
    let mut path = None;
    let mut head = None;
    let mut branch_ref = None;
    for field in source.split(|byte| *byte == 0) {
        if field.is_empty() {
            if let Some(path) = path.take() {
                entries.push(WorktreeEntry {
                    path,
                    head: head.take().ok_or_else(|| {
                        WorkspaceFailure::new("workspace_repository_response_invalid")
                    })?,
                    branch_ref: branch_ref.take(),
                });
            }
            continue;
        }
        let field = std::str::from_utf8(field)
            .map_err(|_| WorkspaceFailure::new("workspace_repository_response_invalid"))?;
        if let Some(value) = field.strip_prefix("worktree ") {
            if path.is_some() {
                return Err(WorkspaceFailure::new(
                    "workspace_repository_response_invalid",
                ));
            }
            path = Some(PathBuf::from(value));
        } else if let Some(value) = field.strip_prefix("HEAD ") {
            head = Some(value.into());
        } else if let Some(value) = field.strip_prefix("branch ") {
            branch_ref = Some(value.into());
        }
    }
    if path.is_some() || head.is_some() || branch_ref.is_some() {
        return Err(WorkspaceFailure::new(
            "workspace_repository_response_invalid",
        ));
    }
    Ok(entries)
}

fn single_line(source: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(source)
        .ok()?
        .trim_end_matches(['\r', '\n']);
    (!text.is_empty() && !text.contains(['\r', '\n'])).then_some(text)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn checkout_failure_detail_remains_bounded_single_line_evidence() {
        let failure = WorkspaceFailure::with_detail(
            "worktree_git_failed",
            "\n fatal:\0\tunsupported\u{2028}format\r\n",
        );
        assert_eq!(failure.code, "worktree_git_failed");
        assert_eq!(failure.detail.as_deref(), Some("fatal: unsupported format"));
        let long = WorkspaceFailure::with_detail("worktree_git_failed", &"가".repeat(1024));
        assert_eq!(long.code, "worktree_git_failed");
        assert_eq!(long.detail.as_deref(), Some("가".repeat(341).as_str()));
        assert!(
            WorkspaceFailure::with_detail("worktree_git_failed", "\0\n\t")
                .detail
                .is_none()
        );
    }

    mod creation_recovery_tests;
    mod destination_tests;
    mod existing_branch_tests;
    pub(crate) mod existing_checkout_tests;
    mod lifecycle_tests;
    mod membership_tests;
    #[cfg(unix)]
    mod process_lifetime_tests;

    pub(crate) async fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for arguments in [
            vec!["init"],
            vec!["config", "user.email", "fixture@example.test"],
            vec!["config", "user.name", "Fixture"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.hooksPath", "/dev/null"],
        ] {
            assert!(
                git_output(root.path(), arguments, None)
                    .await
                    .unwrap()
                    .status
                    .success()
            );
        }
        std::fs::write(root.path().join("README.md"), "fixture\n").unwrap();
        for arguments in [vec!["add", "README.md"], vec!["commit", "-m", "fixture"]] {
            assert!(
                git_output(root.path(), arguments, None)
                    .await
                    .unwrap()
                    .status
                    .success()
            );
        }
        root
    }

    pub(crate) async fn branch_behind_head(root: &Path, branch: &str) -> String {
        let base = resolve_base_commit(root, None).await.unwrap();
        for arguments in [
            vec!["branch", branch, &base],
            vec!["commit", "--allow-empty", "-m", "advance primary checkout"],
        ] {
            assert!(
                git_output(root, arguments, None)
                    .await
                    .unwrap()
                    .status
                    .success()
            );
        }
        assert_ne!(resolve_base_commit(root, None).await.unwrap(), base);
        base
    }

    async fn request(root: &Path) -> WorkspaceAcquireRequest {
        WorkspaceAcquireRequest {
            project_root: root.to_path_buf(),
            workspace_id: WorkspaceIdV1::new("workspace-fixture").unwrap(),
            registration_id: OperationIdV1::new("spawn-fixture").unwrap(),
            registration: None,
            policy: AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha: resolve_base_commit(root, None).await.unwrap(),
                branch: "agent/feature-x".into(),
                branch_mode: Default::default(),
                checkout_path: None,
            },
        }
    }
}
