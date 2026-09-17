import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

const WIP_REF_ROOT = "refs/hebbian-wip";
const WIP_SUBJECT = "HebbianIDE worktree WIP";
const WIP_SCHEMA = 1;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export class WorktreeWipError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "WorktreeWipError";
    this.code = code;
    this.details = details;
  }
}

function runGitRaw(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...withoutLocalGitOverrides(),
      ...options.environment,
    },
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

function gitFailure(result) {
  if (result.error) return result.error.message;
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return output || `git exited with status ${result.status ?? "unknown"}`;
}

function requireGit(cwd, args, description, options = {}) {
  const result = runGitRaw(cwd, args, options);
  if (result.status !== 0) {
    throw new WorktreeWipError(
      "worktree_wip_git_failed",
      `${description}: ${gitFailure(result)}`,
      { args, status: result.status },
    );
  }
  return result.stdout.trim();
}

function canonicalWorktree(cwd) {
  const root = requireGit(cwd, ["rev-parse", "--show-toplevel"], "locate worktree");
  return fs.realpathSync(root);
}

function worktreeOwner(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function operationId(now = new Date()) {
  const timestamp = now.toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14);
  return `${timestamp}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function wipRef(root, id) {
  return `${WIP_REF_ROOT}/${worktreeOwner(root)}/${id}`;
}

function commitIdentityEnvironment() {
  return {
    GIT_AUTHOR_EMAIL: "wip@hebbian.local",
    GIT_AUTHOR_NAME: "HebbianIDE WIP",
    GIT_COMMITTER_EMAIL: "wip@hebbian.local",
    GIT_COMMITTER_NAME: "HebbianIDE WIP",
  };
}

function commitTree(cwd, tree, parents, message) {
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  return requireGit(cwd, args, "write WIP commit", {
    environment: commitIdentityEnvironment(),
    input: `${message}\n`,
  });
}

function parseObjectShape(cwd, object) {
  const output = requireGit(
    cwd,
    ["show", "-s", "--format=%T%n%P", object],
    "inspect WIP object",
  );
  const [tree, parentLine = ""] = output.split("\n");
  return {
    parents: parentLine.split(" ").filter(Boolean),
    tree,
  };
}

function listUntrackedPaths(root) {
  const output = requireGit(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "list untracked files",
  );
  if (!output) return [];
  return output.split("\0").filter(Boolean);
}

function absoluteUntrackedPath(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new WorktreeWipError(
      "worktree_wip_unsafe_path",
      `refusing untracked path outside the worktree: ${relativePath}`,
    );
  }
  return absolute;
}

function validateUntrackedPaths(root, paths) {
  for (const relativePath of paths) {
    const absolute = absoluteUntrackedPath(root, relativePath);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new WorktreeWipError(
        "worktree_wip_unsupported_untracked",
        `untracked path must be a file or symlink: ${relativePath}`,
      );
    }
  }
}

function captureUntrackedCommit(root, paths, message) {
  if (paths.length === 0) return null;

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "hebbian-worktree-wip-index-"),
  );
  const indexFile = path.join(temporary, "index");
  const environment = { GIT_INDEX_FILE: indexFile };
  try {
    requireGit(root, ["read-tree", "--empty"], "initialize untracked WIP index", {
      environment,
    });
    requireGit(
      root,
      ["update-index", "--add", "--remove", "-z", "--stdin"],
      "index untracked WIP",
      {
        environment,
        input: `${paths.join("\0")}\0`,
      },
    );
    const tree = requireGit(
      root,
      ["write-tree"],
      "write untracked WIP tree",
      { environment },
    );
    return commitTree(root, tree, [], `untracked files for ${message}`);
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
}

function statusPorcelain(root) {
  return requireGit(
    root,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    "read worktree status",
  );
}

function assertNoGitOperation(root) {
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
  ]) {
    const markerPath = requireGit(
      root,
      ["rev-parse", "--git-path", marker],
      `locate ${marker}`,
    );
    if (fs.existsSync(path.resolve(root, markerPath))) {
      throw new WorktreeWipError(
        "worktree_wip_operation_in_progress",
        `finish the current Git operation before checkpointing (${marker})`,
      );
    }
  }

  const unmerged = requireGit(
    root,
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    "check unmerged paths",
  );
  if (unmerged) {
    throw new WorktreeWipError(
      "worktree_wip_unmerged",
      "resolve unmerged paths before checkpointing",
    );
  }
}

function removeCapturedUntracked(root, paths) {
  const parents = new Set();
  for (const relativePath of paths) {
    const absolute = absoluteUntrackedPath(root, relativePath);
    try {
      fs.unlinkSync(absolute);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let parent = path.dirname(absolute);
    while (parent !== root && parent.startsWith(`${root}${path.sep}`)) {
      parents.add(parent);
      parent = path.dirname(parent);
    }
  }

  for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(parent);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    }
  }
}

function metadataMessage(metadata) {
  return `${WIP_SUBJECT}\n\n${JSON.stringify(metadata)}`;
}

function readMetadata(root, ref) {
  const message = requireGit(
    root,
    ["show", "-s", "--format=%B", ref],
    "read WIP metadata",
  );
  const separator = message.indexOf("\n\n");
  if (separator < 0 || message.slice(0, separator) !== WIP_SUBJECT) {
    throw new WorktreeWipError(
      "worktree_wip_invalid_metadata",
      `${ref} is not a HebbianIDE WIP checkpoint`,
      { ref },
    );
  }

  let metadata;
  try {
    metadata = JSON.parse(message.slice(separator + 2).trim());
  } catch (error) {
    throw new WorktreeWipError(
      "worktree_wip_invalid_metadata",
      `${ref} metadata is malformed: ${error.message}`,
      { ref },
    );
  }
  if (
    metadata?.schema !== WIP_SCHEMA ||
    typeof metadata.worktree !== "string" ||
    typeof metadata.base !== "string" ||
    typeof metadata.operationId !== "string"
  ) {
    throw new WorktreeWipError(
      "worktree_wip_invalid_metadata",
      `${ref} metadata does not match schema ${WIP_SCHEMA}`,
      { ref },
    );
  }
  return metadata;
}

function validateWipRef(ref) {
  if (!/^refs\/hebbian-wip\/[0-9a-f]{16}\/[0-9A-Za-z._-]+$/.test(ref)) {
    throw new WorktreeWipError(
      "worktree_wip_invalid_ref",
      `expected an owner-scoped ${WIP_REF_ROOT} ref, received: ${ref}`,
      { ref },
    );
  }
}

function resolveOwnedCheckpoint(cwd, ref) {
  validateWipRef(ref);
  const root = canonicalWorktree(cwd);
  const object = requireGit(
    root,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    "resolve WIP checkpoint",
  );
  const metadata = readMetadata(root, ref);
  const expectedPrefix = `${WIP_REF_ROOT}/${worktreeOwner(root)}/`;
  const expectedRef = `${expectedPrefix}${metadata.operationId}`;
  if (metadata.worktree !== root || !ref.startsWith(expectedPrefix)) {
    throw new WorktreeWipError(
      "worktree_wip_owner_mismatch",
      `${ref} belongs to ${metadata.worktree}, not ${root}`,
      { object, owner: metadata.worktree, ref, worktree: root },
    );
  }
  if (ref !== expectedRef) {
    throw new WorktreeWipError(
      "worktree_wip_invalid_metadata",
      `${ref} does not match checkpoint operation ${metadata.operationId}`,
      { object, ref },
    );
  }

  const shape = parseObjectShape(root, object);
  if (
    shape.parents.length < 2 ||
    shape.parents.length > 3 ||
    shape.parents[0] !== metadata.base
  ) {
    throw new WorktreeWipError(
      "worktree_wip_invalid_shape",
      `${ref} is not a stash-shaped commit rooted at ${metadata.base}`,
      { object, ref },
    );
  }
  return { metadata, object, ref, root };
}

export function inspectOwnedWorktreeCheckpoint(cwd, ref) {
  return resolveOwnedCheckpoint(cwd, ref);
}

export function checkpointWorktree(cwd = process.cwd()) {
  const root = canonicalWorktree(cwd);
  assertNoGitOperation(root);
  if (!statusPorcelain(root)) return null;

  const untrackedPaths = listUntrackedPaths(root);
  validateUntrackedPaths(root, untrackedPaths);

  const base = requireGit(root, ["rev-parse", "HEAD"], "resolve WIP base");
  const id = operationId();
  const ref = wipRef(root, id);
  const metadata = {
    base,
    createdAt: new Date().toISOString(),
    operationId: id,
    schema: WIP_SCHEMA,
    worktree: root,
  };
  const message = metadataMessage(metadata);
  const trackedObject = requireGit(
    root,
    ["stash", "create", message],
    "capture tracked WIP",
  );
  const untrackedObject = captureUntrackedCommit(root, untrackedPaths, message);

  let tree;
  let parents;
  if (trackedObject) {
    const shape = parseObjectShape(root, trackedObject);
    if (shape.parents.length !== 2) {
      throw new WorktreeWipError(
        "worktree_wip_invalid_shape",
        `git stash create returned ${shape.parents.length} parents; expected 2`,
      );
    }
    ({ tree, parents } = shape);
  } else {
    tree = requireGit(root, ["write-tree"], "write clean tracked WIP tree");
    const indexObject = commitTree(
      root,
      tree,
      [base],
      `index for ${message}`,
    );
    parents = [base, indexObject];
  }
  if (untrackedObject) parents.push(untrackedObject);

  const object = commitTree(root, tree, parents, message);
  requireGit(
    root,
    ["update-ref", ref, object, ""],
    "pin owner-scoped WIP checkpoint",
  );

  try {
    requireGit(root, ["reset", "--hard", "HEAD"], "clean tracked WIP");
    removeCapturedUntracked(root, untrackedPaths);
    const remaining = statusPorcelain(root);
    if (remaining) {
      throw new WorktreeWipError(
        "worktree_wip_cleanup_incomplete",
        `checkpoint is pinned at ${ref}, but the worktree is still dirty`,
        { object, ref },
      );
    }
  } catch (error) {
    if (error instanceof WorktreeWipError) throw error;
    throw new WorktreeWipError(
      "worktree_wip_cleanup_failed",
      `checkpoint is pinned at ${ref}, but cleanup failed: ${error.message}`,
      { object, ref },
    );
  }

  return {
    base,
    object,
    ref,
    untrackedPaths,
    worktree: root,
  };
}

export function restoreWorktree(cwd, ref) {
  const checkpoint = resolveOwnedCheckpoint(cwd, ref);
  if (statusPorcelain(checkpoint.root)) {
    throw new WorktreeWipError(
      "worktree_wip_restore_dirty",
      `refusing to overlay ${ref} onto a dirty worktree`,
      { object: checkpoint.object, ref },
    );
  }

  const result = runGitRaw(checkpoint.root, [
    "stash",
    "apply",
    "--index",
    ref,
  ]);
  if (result.status !== 0) {
    throw new WorktreeWipError(
      "worktree_wip_restore_failed",
      `${gitFailure(result)}; checkpoint retained at ${ref}`,
      { object: checkpoint.object, ref, status: result.status },
    );
  }

  const release = runGitRaw(checkpoint.root, [
    "update-ref",
    "-d",
    ref,
    checkpoint.object,
  ]);
  if (release.status !== 0) {
    throw new WorktreeWipError(
      "worktree_wip_release_failed",
      `WIP was restored, but ${ref} could not be released: ${gitFailure(release)}`,
      { object: checkpoint.object, ref, status: release.status },
    );
  }

  return checkpoint;
}

export function releaseWorktreeCheckpoint(cwd, ref) {
  const checkpoint = resolveOwnedCheckpoint(cwd, ref);
  requireGit(
    checkpoint.root,
    ["update-ref", "-d", ref, checkpoint.object],
    "release WIP checkpoint",
  );
  return checkpoint;
}

function validateRevision(value, description) {
  if (!value || value.startsWith("-") || value.includes("\0")) {
    throw new WorktreeWipError(
      "worktree_sync_invalid_revision",
      `invalid ${description}: ${value ?? ""}`,
    );
  }
  return value;
}

function restoreAfterPreRebaseFailure(checkpoint) {
  if (!checkpoint) return null;
  try {
    restoreWorktree(checkpoint.worktree, checkpoint.ref);
    return null;
  } catch (error) {
    return error;
  }
}

export async function syncWorktree(options = {}) {
  const root = canonicalWorktree(options.cwd ?? process.cwd());
  const remote = validateRevision(options.remote ?? "origin", "remote");
  const branch = validateRevision(options.branch ?? "main", "branch");
  const target = validateRevision(
    options.target ?? `${remote}/${branch}`,
    "rebase target",
  );
  const checkpoint = checkpointWorktree(root);

  try {
    await (options.afterCheckpoint ?? (() => {}))(checkpoint);
  } catch (error) {
    const restoreError = restoreAfterPreRebaseFailure(checkpoint);
    if (restoreError) {
      throw new WorktreeWipError(
        "worktree_sync_hook_failed",
        `${error.message}; restore also failed: ${restoreError.message}`,
        { ref: checkpoint?.ref },
      );
    }
    throw error;
  }

  if (options.fetch !== false) {
    const fetch = runGitRaw(root, ["fetch", remote, branch]);
    if (fetch.status !== 0) {
      const restoreError = restoreAfterPreRebaseFailure(checkpoint);
      const restoreSuffix = restoreError
        ? `; restore also failed: ${restoreError.message}`
        : checkpoint
          ? "; original WIP restored"
          : "";
      throw new WorktreeWipError(
        "worktree_sync_fetch_failed",
        `${gitFailure(fetch)}${restoreSuffix}`,
        { ref: restoreError ? checkpoint?.ref : undefined },
      );
    }
  }

  const rebase = runGitRaw(root, [
    "-c",
    "commit.gpgsign=false",
    "rebase",
    target,
  ]);
  if (rebase.status !== 0) {
    throw new WorktreeWipError(
      "worktree_sync_rebase_failed",
      `${gitFailure(rebase)}${
        checkpoint ? `; WIP checkpoint retained at ${checkpoint.ref}` : ""
      }`,
      { ref: checkpoint?.ref, status: rebase.status },
    );
  }

  const restored = checkpoint
    ? restoreWorktree(root, checkpoint.ref)
    : null;
  return {
    checkpoint: restored,
    head: requireGit(root, ["rev-parse", "HEAD"], "resolve synced HEAD"),
    target,
    worktree: root,
  };
}
