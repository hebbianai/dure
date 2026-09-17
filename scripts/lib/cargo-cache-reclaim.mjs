import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { directoryIdentity } from "./atomic-directory-move.mjs";
import {
  availableBytes, discoverBuildOutputs, listWorktrees, repositoryRoots,
} from "./disk-reclaim.mjs";
import { DiskGcScopeError, selectRegisteredWorktrees } from "./disk-gc-scope.mjs";
import { DEFAULT_FLOOR_BYTES, DEFAULT_GOAL_BYTES, planReclaim, reclaimNeed } from "./disk-space.mjs";
import { observeWorktreeProcesses } from "./worktree-inventory.mjs";

const helper = fileURLToPath(new URL("../native/cargo-cache-reclaim.py", import.meta.url));
// Cargo skips locking on NFS. Never infer exclusive access there, even when
// this host's flock happens to succeed. Unknown filesystems remain read-only.
const localTypes = new Set(process.platform === "darwin"
  ? [17, 26] // HFS, APFS
  : process.platform === "linux"
    ? [0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x794c7630]
    : []); // ext, btrfs, XFS, tmpfs, overlay

function directDirectory(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function profiles(target) {
  const found = [];
  let visited = 0;
  const walk = (path, depth) => {
    if (++visited > 10_000) throw new Error("Cargo cache discovery exceeded its directory bound");
    if ([".cargo-lock", ".cargo-build-lock"].some(name => existsSync(join(path, name)))) {
      found.push(path);
      return;
    }
    if (depth === 0) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(join(path, entry.name), depth - 1);
    }
  };
  // Dev and remote tool builds use versioned Cargo roots inside target/.
  // Native validation requires CACHEDIR.TAG for these deeper profile paths.
  walk(target, 5);
  return found;
}

function operate(entry, operation) {
  const result = spawnSync("python3", ["-I", "-S", helper], {
    input: JSON.stringify({
      operation, root: entry.worktree, profile: relative(entry.worktree, entry.path),
      rootIdentity: entry.rootIdentity, profileIdentity: entry.profileIdentity,
    }),
    encoding: "utf8", maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { state: "refused", reason: result.error?.message || result.stderr || "cache-helper-failed" };
  }
  try {
    const value = JSON.parse(result.stdout);
    if (!["available", "removed", "refused", "busy"].includes(value.state)) throw new Error();
    return value;
  } catch {
    return { state: "refused", reason: "invalid-cache-helper-receipt" };
  }
}

/** Explicit compiler-cache disposal is separate from whole-target lifecycle GC.
 * Cargo owns exclusion; cache classes, not a pane's presence, own disposability. */
export function reclaimCargoCaches({
  cwd = process.cwd(), worktree = null, apply = false, all = false,
  floorBytes = DEFAULT_FLOOR_BYTES, goalBytes = DEFAULT_GOAL_BYTES,
} = {}) {
  if (worktree === null) {
    throw new DiskGcScopeError("cache-worktree-scope-required", "--cache-only requires one explicit --worktree");
  }
  const { mainRoot, currentWorktree } = repositoryRoots(cwd);
  const registered = listWorktrees(cwd);
  selectRegisteredWorktrees(registered, worktree);
  const before = availableBytes(mainRoot);
  const need = reclaimNeed({ availBytes: before, floorBytes, goalBytes });
  const skipped = [];
  const candidates = [];
  const rootIdentity = directoryIdentity(worktree);
  for (const target of discoverBuildOutputs(worktree)) {
    if (!existsSync(join(dirname(target), "Cargo.toml"))) continue;
    if (!localTypes.has(statfsSync(target).type)) {
      skipped.push({ path: target, worktree, reason: "unsupported-cache-filesystem" });
      continue;
    }
    for (const path of profiles(target)) {
      if (!directDirectory(path)) continue;
      const entry = { path, worktree, rootIdentity, profileIdentity: directoryIdentity(path), tier: "cache-only", kind: "compiler-cache" };
      const observed = operate(entry, "inspect");
      if (observed.state !== "available") {
        skipped.push({ path, worktree, reason: observed.reason });
      } else if (observed.bytes > 0 || observed.files > 0) {
        candidates.push({ ...entry, bytes: observed.bytes });
      }
    }
  }
  const plan = planReclaim(candidates, all ? null : need.needBytes);
  const removed = [];
  const refused = [];
  if (apply && !need.unknown) {
    for (const entry of plan.selected) {
      // Earlier profiles or another reclaimer may already have met the goal.
      if (!all && availableBytes(mainRoot) >= goalBytes) break;
      // This also retains orphan/direct compiler work not holding a Cargo lock.
      // Pane/provider processes alone do not make compiler caches live.
      const processes = observeWorktreeProcesses(registered, { selectedWorktrees: [worktree] });
      const processReason = processes.status !== "complete"
        ? "process-observation-incomplete"
        : processes.worktrees.some(item => item.roles.includes("building")) ? "building" : null;
      if (processReason) {
        refused.push({ path: entry.path, worktree, reason: processReason });
        continue;
      }
      const outcome = operate(entry, "apply");
      if (outcome.state === "removed") removed.push({ ...entry, bytes: outcome.bytes });
      else {
        if (outcome.removedBytes > 0) removed.push({ ...entry, bytes: outcome.removedBytes });
        refused.push({ path: entry.path, worktree, reason: outcome.reason });
      }
    }
  } else if (apply) {
    refused.push({ worktree, reason: "free-space-observation-unavailable" });
  }
  const after = availableBytes(mainRoot);
  const removedBytes = removed.reduce((total, entry) => total + entry.bytes, 0);
  const totalCacheBytes = candidates.reduce((total, entry) => total + entry.bytes, 0);
  return {
    mode: "cache-only", mainRoot, currentWorktree, scope: { kind: "worktree", path: worktree },
    availableBefore: before, availableAfter: after, floorBytes, goalBytes,
    cacheBudgetBytes: null, totalCacheBytes, totalCacheAfter: Math.max(0, totalCacheBytes - removedBytes),
    cacheExcessBytes: 0, overCacheBudget: false, belowFloor: need.belowFloor,
    needBytes: need.needBytes, unknownSpace: need.unknown, candidateCount: candidates.length,
    plan, removedBytes, removed, refused, skipped, applied: apply,
    satisfied: after !== null && after >= goalBytes && refused.length === 0,
  };
}
