/**
 * Observe host process state at one boundary and map each CWD to its longest
 * registered worktree prefix. A selected scope narrows only the stable
 * projection, never the ownership registry. Consumers may trust only a
 * complete, stable observation; an incomplete boundary never becomes an empty
 * idle snapshot.
 */
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { debugAppRootFromCommand } from "./app-executable.mjs";
import { isHebbianAppProcess, parseProcessRows } from "./daily-driver.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import { processMemberSnapshots } from "./process-identity.mjs";

const GIT_WORKTREE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
// Large worktree registries can take several seconds to read under disk load.
const GIT_WORKTREE_TIMEOUT_MS = 30_000;
const CENSUS_SAMPLE_LIMIT = 3;
const ROLE_ORDER = ["building", "app", "live"];
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function worktreeSourceBytes(source) {
  if (typeof source === "string") return Buffer.from(source, "utf8");
  if (Buffer.isBuffer(source)) return source;
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  }
  throw new Error("Git worktree census returned unsupported output");
}

function optionalReason(field, name) {
  if (field === name) return null;
  return field.startsWith(`${name} `) ? field.slice(name.length + 1) : undefined;
}

function parseWorktreeRecord(source) {
  const fields = source.split("\0");
  const pathField = fields.shift();
  if (!pathField?.startsWith("worktree ")) {
    throw new Error("Git worktree census record has no path");
  }
  const path = pathField.slice("worktree ".length);
  if (!path || !isAbsolute(path)) {
    throw new Error("Git worktree census returned a non-absolute path");
  }

  let locked = undefined;
  let prunable = undefined;
  for (const field of fields) {
    if (field.startsWith("worktree ")) {
      throw new Error("Git worktree census record has two paths");
    }
    const lockedReason = optionalReason(field, "locked");
    if (locked === undefined && lockedReason !== undefined) {
      locked = lockedReason;
      continue;
    }
    const prunableReason = optionalReason(field, "prunable");
    if (prunable === undefined && prunableReason !== undefined) {
      prunable = prunableReason;
    }
  }

  return Object.freeze({
    path,
    locked: locked === undefined ? null : Object.freeze({ reason: locked }),
    prunable:
      prunable === undefined ? null : Object.freeze({ reason: prunable }),
  });
}

/** Parse the exact NUL-delimited boundary emitted by Git once. Consumers use
 * typed records and never reinterpret porcelain fields themselves. */
export function parseGitWorktreePorcelain(source) {
  const bytes = worktreeSourceBytes(source);
  if (bytes.length >= GIT_WORKTREE_OUTPUT_LIMIT_BYTES) {
    throw new Error("Git worktree census exceeded its byte limit");
  }
  if (bytes.length === 0) {
    throw new Error("Git worktree census returned no records");
  }
  const decoded = UTF8.decode(bytes);
  if (!decoded.endsWith("\0\0")) {
    throw new Error("Git worktree census ended inside a record");
  }
  const body = decoded.slice(0, -2);
  if (!body) throw new Error("Git worktree census returned no records");
  const entries = body.split("\0\0").map(parseWorktreeRecord);
  const paths = new Set();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new Error("Git worktree census returned a duplicate path");
    }
    paths.add(entry.path);
  }
  return Object.freeze(entries);
}

export function readGitWorktreeInventory(
  cwd,
  { environment = process.env, execute = execFileSync } = {},
) {
  const source = execute(
    "git",
    ["-C", cwd, "worktree", "list", "--porcelain", "-z"],
    {
      env: withoutLocalGitOverrides(environment),
      killSignal: "SIGKILL",
      maxBuffer: GIT_WORKTREE_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_WORKTREE_TIMEOUT_MS,
    },
  );
  return parseGitWorktreePorcelain(source);
}

function uniquePids(pids) {
  if (
    !Array.isArray(pids) ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  ) {
    throw new Error("process IDs must be positive integers");
  }
  return [...new Set(pids)].sort((left, right) => left - right);
}

function incomplete(reason, missingPids = []) {
  return {
    status: "incomplete",
    reason,
    missingPids: [...missingPids],
  };
}

function normalizedWorktrees(worktrees) {
  if (
    !Array.isArray(worktrees) ||
    worktrees.length === 0 ||
    worktrees.some((worktree) => typeof worktree !== "string" || !worktree)
  ) {
    throw new Error("worktrees must be non-empty paths");
  }
  return [...new Set(worktrees.map((worktree) => resolve(worktree)))];
}

function selectedRegisteredWorktrees(registeredPaths, selectedWorktrees) {
  if (selectedWorktrees === undefined) return registeredPaths;
  const selectedPaths = normalizedWorktrees(selectedWorktrees);
  const registered = new Set(registeredPaths);
  if (selectedPaths.some((path) => !registered.has(path))) {
    throw new Error("process scope must contain only registered worktrees");
  }
  return selectedPaths;
}

function worktreePathKey(path) {
  // Preserve node:path.relative's Windows case-insensitive comparison.
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function matchWorktree(worktreesByPath, path) {
  if (typeof path !== "string" || !path) return null;
  let candidate = worktreePathKey(resolve(path));
  for (;;) {
    const worktree = worktreesByPath.get(candidate);
    if (worktree !== undefined) return worktree;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

export function isBuildCommand(command) {
  if (typeof command !== "string") return false;
  return command
    .split(/&&|\|\||[;|]|\s-c\s/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? "")
    .some((executable) => {
      const name = executable.split("/").pop() ?? "";
      return name === "cargo" || name === "rustc";
    });
}

function defaultPs() {
  // The reclaimer owns this user's build output. Other-user processes cannot
  // be inspected reliably, while zombies have no CWD and hold no files.
  const source = execFileSync(
    "ps",
    ["-Ao", "uid=,pid=,ppid=,stat=,command="],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const owner = typeof process.getuid === "function" ? process.getuid() : null;
  return source
    .split("\n")
    .map((line) =>
      line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/),
    )
    .filter(
      (match) =>
        match &&
        (owner === null || Number(match[1]) === owner) &&
        !match[4].startsWith("Z"),
    )
    .map((match) => `${match[2]} ${match[3]} ${match[5]}`)
    .join("\n");
}

function normalizeMemberObservation(observation, requestedPids) {
  const expectedScope = uniquePids(requestedPids);
  const observedScope = observation?.scope?.requestedPids;
  if (
    observation?.status !== "complete" ||
    observation.scope?.kind !== "point" ||
    !Array.isArray(observedScope) ||
    observedScope.length !== expectedScope.length ||
    observedScope.some((pid, index) => pid !== expectedScope[index]) ||
    !Array.isArray(observation.members)
  ) {
    return incomplete("process-identity-unavailable", requestedPids);
  }
  const requested = new Set(requestedPids);
  const seen = new Set();
  const members = [];
  for (const member of observation.members) {
    if (
      !Number.isSafeInteger(member?.pid) ||
      !requested.has(member.pid) ||
      seen.has(member.pid) ||
      typeof member.processIdentity !== "string" ||
      !["live", "stopped", "zombie"].includes(member.state)
    ) {
      return incomplete("process-identity-malformed", requestedPids);
    }
    seen.add(member.pid);
    if (member.state !== "zombie") members.push(member);
  }
  const missingCwds = members.filter(
    (member) => typeof member.cwd !== "string" || !isAbsolute(member.cwd),
  );
  return missingCwds.length > 0
    ? incomplete("process-cwd-missing", missingCwds.map((member) => member.pid))
    : { status: "complete", members };
}

function observeRelevantProcesses(
  matchingPaths,
  { psRunner, memberRunner },
) {
  let rows;
  try {
    rows = parseProcessRows(psRunner());
  } catch {
    return incomplete("process-list-unavailable");
  }
  const requestedPids = rows.map((row) => row.pid);
  let rawMembers;
  try {
    rawMembers = memberRunner(requestedPids);
  } catch {
    return incomplete("process-identity-unavailable", requestedPids);
  }
  const memberObservation = normalizeMemberObservation(
    rawMembers,
    requestedPids,
  );
  if (memberObservation.status !== "complete") return memberObservation;

  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
  const processes = [];
  for (const member of memberObservation.members) {
    const row = rowsByPid.get(member.pid);
    const cwd = member.cwd;
    const assignments = new Map();
    const addRoles = (path, roles) => {
      if (!path) return;
      const assigned = assignments.get(path) ?? new Set();
      for (const role of roles) assigned.add(role);
      assignments.set(path, assigned);
    };
    const cwdWorktree = matchWorktree(matchingPaths, cwd);
    addRoles(
      cwdWorktree,
      isBuildCommand(row.command) ? ["live", "building"] : ["live"],
    );
    if (isHebbianAppProcess(row.command)) {
      const appWorktree =
        matchWorktree(matchingPaths, debugAppRootFromCommand(row.command)) ??
        cwdWorktree;
      addRoles(appWorktree, ["app"]);
    }
    if (assignments.size === 0) continue;
    processes.push({
      pid: member.pid,
      processIdentity: member.processIdentity,
      command: row.command,
      cwd,
      assignments: [...assignments]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, roles]) => ({
          path,
          roles: ROLE_ORDER.filter((role) => roles.has(role)),
        })),
    });
  }
  return {
    status: "complete",
    processes: processes.sort((left, right) => left.pid - right.pid),
  };
}

function projectProcesses(processes, selectedPaths) {
  const selected = new Set(selectedPaths);
  return processes.flatMap((process) => {
    const assignments = process.assignments.filter((assignment) =>
      selected.has(assignment.path),
    );
    return assignments.length > 0 ? [{ ...process, assignments }] : [];
  });
}

function worktreeMembers(pids) {
  return processMemberSnapshots(pids, process.platform, { includeCwd: true });
}

export function observeWorktreeProcesses(
  worktrees,
  {
    selectedWorktrees,
    psRunner = defaultPs,
    memberRunner = worktreeMembers,
  } = {},
) {
  const registeredPaths = normalizedWorktrees(worktrees);
  const paths = selectedRegisteredWorktrees(
    registeredPaths,
    selectedWorktrees,
  );
  const matchingPaths = new Map();
  for (const path of registeredPaths) {
    const key = worktreePathKey(path);
    if (!matchingPaths.has(key)) matchingPaths.set(key, path);
  }
  const dependencies = { psRunner, memberRunner };
  let previousSignature = null;
  let stable = null;
  for (let sample = 0; sample < CENSUS_SAMPLE_LIMIT; sample += 1) {
    const observed = observeRelevantProcesses(matchingPaths, dependencies);
    if (observed.status !== "complete") return observed;
    const current = {
      ...observed,
      processes: projectProcesses(observed.processes, paths),
    };
    const signature = JSON.stringify(current.processes);
    if (signature === previousSignature) {
      stable = current;
      break;
    }
    previousSignature = signature;
  }
  if (!stable) return incomplete("process-census-changed");

  const records = new Map(
    paths.map((path) => [path, { path, pids: new Set(), roles: new Set() }]),
  );
  for (const process of stable.processes) {
    for (const assignment of process.assignments) {
      const record = records.get(assignment.path);
      if (!record) continue;
      record.pids.add(process.pid);
      for (const role of assignment.roles) record.roles.add(role);
    }
  }

  return {
    status: "complete",
    scope: paths,
    worktrees: [...records.values()].map((record) => ({
      path: record.path,
      pids: [...record.pids].sort((left, right) => left - right),
      roles: ROLE_ORDER.filter((role) => record.roles.has(role)),
    })),
  };
}

export function worktreeProcessReason(observation, worktree) {
  if (observation?.status !== "complete") {
    return "process-observation-incomplete";
  }
  const path = resolve(worktree);
  if (!Array.isArray(observation.scope) || !observation.scope.includes(path)) {
    return "process-observation-incomplete";
  }
  const record = observation.worktrees.find((entry) => entry.path === path);
  if (!record) return "process-observation-incomplete";
  if (record?.roles.includes("building")) return "building";
  if (record?.roles.includes("app")) return "protected";
  if (record?.roles.includes("live")) return "live-process";
  return null;
}
