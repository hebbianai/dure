import { realpathSync } from "node:fs";

export function resolveLiveDevWorktree({
  explicitPath,
  environment = process.env,
} = {}) {
  const liveWorktree = explicitPath || environment.DURE_DEV_LIVE_WORKTREE;
  if (!liveWorktree && environment.HEBBIAN_DEV_WORKTREE) {
    throw new Error(
      "HEBBIAN_DEV_WORKTREE is ambiguous; set DURE_DEV_LIVE_WORKTREE to the checkout hosting the running daily driver",
    );
  }
  if (!liveWorktree) {
    throw new Error(
      "live dev worktree is required: pass --live-worktree <path> or set DURE_DEV_LIVE_WORKTREE",
    );
  }
  return realpathSync(liveWorktree);
}
