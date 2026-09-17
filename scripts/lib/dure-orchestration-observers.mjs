import { execFile, execFileSync } from "node:child_process";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import { readGitWorktreeInventory } from "./worktree-inventory.mjs";

const MAX_GITHUB_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REPOSITORY_ROOT_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_GITHUB_CALL_TIMEOUT_MS = 7_500;
const QUEUED_RUN_STATES = new Set([
  "pending",
  "queued",
  "requested",
  "waiting",
]);

function typedError(code, error, source) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: (stderr || message).slice(0, 2_048),
    source,
  };
}

function timestampMs(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizeRun(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error("GitHub workflow run must be an object");
  }
  const createdAt = timestampMs(run.createdAt);
  const updatedAt = timestampMs(run.updatedAt);
  if (
    !Number.isSafeInteger(run.databaseId) ||
    createdAt === null ||
    updatedAt === null ||
    typeof run.status !== "string"
  ) {
    throw new Error("GitHub workflow run is malformed");
  }
  return {
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    createdAt: new Date(createdAt).toISOString(),
    databaseId: run.databaseId,
    event: typeof run.event === "string" ? run.event : null,
    headSha: typeof run.headSha === "string" ? run.headSha : null,
    startedAt:
      timestampMs(run.startedAt) === null
        ? null
        : new Date(timestampMs(run.startedAt)).toISOString(),
    status: run.status,
    updatedAt: new Date(updatedAt).toISOString(),
    url: typeof run.url === "string" ? run.url : null,
  };
}

function defaultGithubExecute(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function readGithubRuns(workflow, { cwd, environment, execute, timeoutMs }) {
  const startedAtMs = Date.now();
  const args = [
    "run",
    "list",
    "--workflow",
    workflow,
    "--limit",
    "100",
    "--json",
    "databaseId,status,conclusion,event,createdAt,startedAt,updatedAt,headSha,url",
  ];
  const executeOnce = (attemptTimeoutMs) =>
    execute("gh", args, {
      cwd,
      encoding: "utf8",
      env: withoutLocalGitOverrides(environment),
      killSignal: "SIGKILL",
      maxBuffer: MAX_GITHUB_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: attemptTimeoutMs,
    });
  let source = await executeOnce(timeoutMs);
  if (Buffer.byteLength(source) >= MAX_GITHUB_OUTPUT_BYTES) {
    throw new Error(`GitHub ${workflow} status exceeded its byte limit`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const remainingMs = timeoutMs - (Date.now() - startedAtMs);
    if (!(error instanceof SyntaxError) || remainingMs <= 0) throw error;
    source = await executeOnce(remainingMs);
    if (Buffer.byteLength(source) >= MAX_GITHUB_OUTPUT_BYTES) {
      throw new Error(`GitHub ${workflow} status exceeded its byte limit`);
    }
    parsed = JSON.parse(source);
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error(`GitHub ${workflow} status must be a bounded array`);
  }
  return parsed
    .map(normalizeRun)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function summarizeCiRuns(runs, nowMs) {
  const queued = runs.filter((run) => QUEUED_RUN_STATES.has(run.status));
  const oldestQueuedAtMs = queued.reduce((oldest, run) => {
    const createdAt = Date.parse(run.createdAt);
    return oldest === null ? createdAt : Math.min(oldest, createdAt);
  }, null);
  return {
    state: "ready",
    observedAtMs: nowMs,
    sourceAgeMs: 0,
    inProgressRuns: runs.filter((run) => run.status === "in_progress").length,
    oldestQueuedAgeMs:
      oldestQueuedAtMs === null ? null : Math.max(0, nowMs - oldestQueuedAtMs),
    oldestQueuedAt:
      oldestQueuedAtMs === null
        ? null
        : new Date(oldestQueuedAtMs).toISOString(),
    queuedRuns: queued.length,
  };
}

export async function observeGithubDureOrchestration({
  cwd = process.cwd(),
  environment = process.env,
  execute = defaultGithubExecute,
  nowMs = Date.now(),
  timeoutMs = DEFAULT_GITHUB_CALL_TIMEOUT_MS,
} = {}) {
  try {
    const ciRuns = await readGithubRuns("ci.yml", {
      cwd,
      environment,
      execute,
      timeoutMs,
    });
    return {
      available: true,
      state: "ready",
      ci: summarizeCiRuns(ciRuns, nowMs),
      observedAt: new Date(nowMs).toISOString(),
      observedAtMs: nowMs,
      sourceAgeMs: 0,
    };
  } catch (error) {
    return {
      available: false,
      state: "unavailable",
      error: typedError("github_snapshot_unavailable", error, "github_actions"),
      observedAt: new Date(nowMs).toISOString(),
      observedAtMs: nowMs,
      sourceAgeMs: 0,
    };
  }
}

function resolveRepositoryWorktree(cwd, environment, execute) {
  const source = execute(
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      env: withoutLocalGitOverrides(environment),
      killSignal: "SIGKILL",
      maxBuffer: MAX_REPOSITORY_ROOT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1_000,
    },
  );
  if (Buffer.byteLength(source) >= MAX_REPOSITORY_ROOT_OUTPUT_BYTES) {
    throw new Error("Git repository root lookup exceeded its byte limit");
  }
  const worktree = source.trim();
  if (worktree.length === 0) {
    throw new Error("Git repository root lookup returned no path");
  }
  return worktree;
}

function inspectWorktrees(cwd, environment, execute, nowMs) {
  const entries = readGitWorktreeInventory(cwd, { environment, execute });
  return {
    state: "ready",
    observedAtMs: nowMs,
    sourceAgeMs: 0,
    orphanRegistrations: entries.filter((entry) => entry.prunable !== null)
      .length,
    scope: "git-prunable-registrations",
    total: entries.length,
  };
}

export function observeLocalDureOrchestrationHost({
  cwd = process.cwd(),
  environment = process.env,
  execute = execFileSync,
  nowMs = Date.now(),
} = {}) {
  try {
    const worktree = resolveRepositoryWorktree(cwd, environment, execute);
    return {
      available: true,
      state: "ready",
      observedAt: new Date(nowMs).toISOString(),
      observedAtMs: nowMs,
      sourceAgeMs: 0,
      worktrees: inspectWorktrees(worktree, environment, execute, nowMs),
    };
  } catch (error) {
    return {
      available: false,
      state: "unavailable",
      error: typedError("host_snapshot_unavailable", error, "local_host"),
      observedAt: new Date(nowMs).toISOString(),
      observedAtMs: nowMs,
      sourceAgeMs: 0,
    };
  }
}
