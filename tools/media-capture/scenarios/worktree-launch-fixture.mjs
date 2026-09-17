const REPO_PATH = "/workspace/dure";
const AGENT_NAME = "isolation-audit";

export const WORKTREE_LAUNCH_RECEIPT_ID = "sp_media_isolation_audit_01";
export const WORKTREE_LAUNCH_PROVIDER_SESSION_ID =
  "media-worktree-codex-source";

export function createWorktreeLaunchFixture() {
  return {
    schemaVersion: 1,
    receiptId: WORKTREE_LAUNCH_RECEIPT_ID,
    desktopId: "desk-launch",
    request: {
      project: "dure",
      name: AGENT_NAME,
      provider: "codex",
      runtime: "hmux",
      useWorktree: true,
    },
    worktree: {
      schemaVersion: 1,
      repo: REPO_PATH,
      name: AGENT_NAME,
      path: `${REPO_PATH}/.worktrees/${AGENT_NAME}`,
      branch: `agent/${AGENT_NAME}`,
      preExisting: false,
      gitStatus: {
        isRepo: true,
        branch: `agent/${AGENT_NAME}`,
        ahead: 2,
        behind: 0,
        staged: 1,
        unstaged: 2,
        untracked: 0,
      },
    },
    providerTarget: {
      agentId: "media-worktree-isolation-audit",
      sessionId: WORKTREE_LAUNCH_PROVIDER_SESSION_ID,
      sessionKind: "pty",
      provider: "codex",
    },
  };
}
