use super::{
    AgentSpawnContractErrorV1, AgentSpawnExistingWorkspaceAuthorityV1, MAX_BRANCH_BYTES,
    invalid_plan,
};
use crate::GitCheckoutInstanceV1;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSpawnBranchModeV1 {
    #[default]
    Create,
    Existing,
}

impl AgentSpawnBranchModeV1 {
    fn is_create(&self) -> bool {
        *self == Self::Create
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentSpawnWorktreePolicyV1 {
    ProjectRoot,
    Dedicated {
        base_commit_sha: String,
        branch: String,
        #[serde(default, skip_serializing_if = "AgentSpawnBranchModeV1::is_create")]
        branch_mode: AgentSpawnBranchModeV1,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkout_path: Option<String>,
    },
    ExistingWorkspace {
        source: Box<AgentSpawnExistingWorkspaceAuthorityV1>,
    },
    ExistingCheckout {
        instance: GitCheckoutInstanceV1,
        branch: String,
        base_commit_sha: String,
    },
}

pub(super) fn validate_worktree(
    worktree: &AgentSpawnWorktreePolicyV1,
) -> Result<(), AgentSpawnContractErrorV1> {
    if let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        checkout_path,
        ..
    } = worktree
    {
        validate_base_commit(base_commit_sha)?;
        if let Some(path) = checkout_path {
            if !std::path::Path::new(path).is_absolute()
                || path.len() > 4096
                || path.chars().any(char::is_control)
            {
                return Err(invalid_plan(
                    "checkoutPath",
                    "must be a bounded absolute path",
                ));
            }
        }
        if branch.is_empty()
            || branch.len() > MAX_BRANCH_BYTES
            || branch.starts_with(['-', '/'])
            || branch.ends_with(['.', '/'])
            || branch.ends_with(".lock")
            || branch == "@"
            || branch.contains("..")
            || branch.contains("@{")
            || branch.contains("//")
            || branch.split('/').any(|component| {
                component.is_empty() || component.starts_with('.') || component.ends_with(".lock")
            })
            || branch.bytes().any(|byte| {
                byte.is_ascii_control()
                    || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
            })
        {
            return Err(invalid_plan("branch", "is not a safe bounded Git ref name"));
        }
    }
    if let AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } = worktree {
        source.validate()?;
    }
    if let AgentSpawnWorktreePolicyV1::ExistingCheckout {
        base_commit_sha, ..
    } = worktree
    {
        validate_base_commit(base_commit_sha)?;
    }
    Ok(())
}

fn validate_base_commit(base_commit_sha: &str) -> Result<(), AgentSpawnContractErrorV1> {
    if !matches!(base_commit_sha.len(), 40 | 64)
        || !base_commit_sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_plan(
            "baseCommitSha",
            "must be a full lowercase SHA-1 or SHA-256 object id",
        ));
    }
    Ok(())
}

pub(super) fn hash_worktree(hash: &mut Sha256, worktree: &AgentSpawnWorktreePolicyV1) {
    use super::hash_field;
    match worktree {
        AgentSpawnWorktreePolicyV1::ProjectRoot => {
            hash_field(hash, "worktree", "project_root");
        }
        AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha,
            branch,
            branch_mode,
            checkout_path,
        } => {
            hash_field(hash, "worktree", "dedicated");
            hash_field(hash, "base_commit", base_commit_sha);
            hash_field(hash, "branch", branch);
            if *branch_mode == AgentSpawnBranchModeV1::Existing {
                hash_field(hash, "branch_mode", "existing");
            }
            if let Some(path) = checkout_path {
                hash_field(hash, "checkout_path", path);
            }
        }
        AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } => {
            hash_field(hash, "worktree", "existing_workspace");
            let source = serde_json::to_string(source)
                .expect("spawn source authority has an infallible wire representation");
            hash_field(hash, "source_authority", &source);
        }
        AgentSpawnWorktreePolicyV1::ExistingCheckout {
            instance,
            branch,
            base_commit_sha,
        } => {
            hash_field(hash, "worktree", "existing_checkout");
            let instance = serde_json::to_string(instance)
                .expect("checkout instance has an infallible wire representation");
            hash_field(hash, "checkout_instance", &instance);
            hash_field(hash, "branch", branch);
            hash_field(hash, "base_commit", base_commit_sha);
        }
    }
}

pub fn worktree_directory_name(branch: &str) -> String {
    let trimmed = branch.trim().trim_end_matches('/');
    let last = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let directory: String = last
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    if directory.is_empty() {
        trimmed
            .chars()
            .map(|character| {
                if character.is_alphanumeric() || matches!(character, '-' | '_') {
                    character
                } else {
                    '-'
                }
            })
            .collect()
    } else {
        directory
    }
}
