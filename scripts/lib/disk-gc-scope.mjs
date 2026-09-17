import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export class DiskGcScopeError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = "DiskGcScopeError";
    this.code = code;
    this.path = path;
  }
}

/** Parse and canonicalize the destructive scope once at the CLI boundary. */
export function parseWorktreeScope(
  arguments_,
  { canonicalize = realpathSync } = {},
) {
  let requested = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    let value;
    if (argument === "--worktree") {
      value = arguments_[index + 1];
      index += 1;
    } else if (argument.startsWith("--worktree=")) {
      value = argument.slice("--worktree=".length);
    } else {
      continue;
    }
    if (requested !== null) {
      throw new DiskGcScopeError(
        "duplicate-worktree-scope",
        "--worktree may be provided only once",
        value ?? null,
      );
    }
    if (!value || !isAbsolute(value)) {
      throw new DiskGcScopeError(
        "invalid-worktree-scope",
        "--worktree requires one absolute path",
        value ?? null,
      );
    }
    requested = value;
  }
  if (requested === null) return null;
  try {
    return canonicalize(requested);
  } catch {
    throw new DiskGcScopeError(
      "unavailable-worktree-scope",
      `--worktree path is unavailable: ${requested}`,
      requested,
    );
  }
}

/** Exact registration is the authority; a prefix or sibling never matches. */
export function selectRegisteredWorktrees(worktrees, scopedWorktree) {
  if (scopedWorktree === null) return [...worktrees];
  const selected = worktrees.filter((worktree) => worktree === scopedWorktree);
  if (selected.length !== 1) {
    throw new DiskGcScopeError(
      "unregistered-worktree-scope",
      `--worktree is not an exact registered worktree: ${scopedWorktree}`,
      scopedWorktree,
    );
  }
  return selected;
}
