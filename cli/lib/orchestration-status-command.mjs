import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_ORCHESTRATION_STATUS_TIMEOUT_MS = 10_000;
export const MAX_ORCHESTRATION_STATUS_TIMEOUT_MS = 10_000;
export const DEFAULT_ORCHESTRATION_STATUS_CACHE_MS = 5_000;
export const MAX_ORCHESTRATION_STATUS_CACHE_MS = 60_000;

const STATUS_SCRIPT = path.join("scripts", "dure-orchestration-status.mjs");
const CACHE_SCHEMA = "dure-orchestration-status-cache/v1";
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;

function ownerOnly(stat) {
  return (
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o077) === 0
  );
}

function resolveDureHome(environment) {
  if (environment.DURE_HOME) return path.resolve(environment.DURE_HOME);
  return path.join(homedir(), ".dure");
}

function cachePath(repository, environment) {
  const digest = createHash("sha256").update(repository).digest("hex");
  return path.join(
    resolveDureHome(environment),
    "cache",
    "orchestration-status",
    `${digest}.json`,
  );
}

function ensureCacheDirectory(pathname) {
  const cacheRoot = path.dirname(pathname);
  const dureHome = path.dirname(cacheRoot);
  for (const directory of [dureHome, cacheRoot, pathname]) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownerOnly(stat)) {
      throw new Error("Dure orchestration cache directory is unsafe");
    }
  }
}

function readCache(pathname, { maximumAgeMs, nowMs }) {
  if (maximumAgeMs === 0) return null;
  try {
    const stat = fs.lstatSync(pathname);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > MAX_CACHE_BYTES ||
      !ownerOnly(stat)
    ) {
      return null;
    }
    const document = JSON.parse(fs.readFileSync(pathname, "utf8"));
    if (
      document?.schema !== CACHE_SCHEMA ||
      !Number.isSafeInteger(document.recordedAtMs) ||
      nowMs < document.recordedAtMs ||
      nowMs - document.recordedAtMs > maximumAgeMs ||
      document.report?.apiVersion !== "dure.orchestration/v1"
    ) {
      return null;
    }
    return {
      ageMs: nowMs - document.recordedAtMs,
      report: document.report,
    };
  } catch {
    return null;
  }
}

function writeCache(pathname, report, nowMs) {
  const directory = path.dirname(pathname);
  ensureCacheDirectory(directory);
  const source = `${JSON.stringify({
    schema: CACHE_SCHEMA,
    recordedAtMs: nowMs,
    report,
  })}\n`;
  if (Buffer.byteLength(source) > MAX_CACHE_BYTES) return;
  const temporary = path.join(
    directory,
    `.${path.basename(pathname)}.${process.pid}.${randomBytes(8).toString("hex")}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, source, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, pathname);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function refreshSourceAges(value, nowMs) {
  if (!value || typeof value !== "object") return;
  if (Number.isSafeInteger(value.observedAtMs) && "sourceAgeMs" in value) {
    value.sourceAgeMs = Math.max(0, nowMs - value.observedAtMs);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    refreshSourceAges(child, nowMs);
  }
}

function cachedReport(report, { ageMs, maximumAgeMs, nowMs, state }) {
  const projected = structuredClone(report);
  refreshSourceAges(projected, nowMs);
  projected.cache = {
    state,
    maximumAgeMs,
    observedAtMs: nowMs,
    sourceAgeMs: ageMs,
  };
  return projected;
}

function unavailableReport({ code, message, nowMs, view }) {
  return {
    schemaVersion: 1,
    apiVersion: "dure.orchestration/v1",
    kind: "dure.orchestration.status",
    view,
    status: "unknown",
    reasonCodes: [code],
    partial: true,
    observedAt: new Date(nowMs).toISOString(),
    observedAtMs: nowMs,
    sourceAgeMs: 0,
    durationMs: 0,
    target: { kind: "repository", transport: "local_process" },
    health: {
      checkedAt: new Date(nowMs).toISOString(),
      observedAtMs: nowMs,
      reasons: [{ code, message, severity: "unknown", source: "status_process" }],
      verdict: "unknown",
    },
    sources: [{
      name: "status_process",
      state: "unavailable",
      observedAtMs: nowMs,
      sourceAgeMs: 0,
      reasonCode: code,
    }],
  };
}

function formatOrchestrationStatusFromCli(report) {
  const lines = [`Dure orchestration: ${report.status.toUpperCase()}`];
  lines.push(
    `  CI waits: ${report.github?.ci?.queuedRuns ?? "-"}`,
    `  orphan worktrees: ${report.host?.worktrees?.orphanRegistrations ?? "-"}`,
    `  observation: ${report.durationMs}ms · cache ${report.cache?.state ?? "none"}`,
  );
  if (report.health?.reasons?.length > 0) {
    lines.push("", "Health reasons:");
    for (const reason of report.health.reasons) {
      lines.push(`- [${reason.severity}] ${reason.code}: ${reason.message}`);
    }
  }
  return lines.join("\n");
}

function resolveRepository(candidate) {
  const root = fs.realpathSync(path.resolve(candidate));
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) {
    throw new Error("Dure orchestration repository is not a directory");
  }
  const script = path.join(root, STATUS_SCRIPT);
  const scriptStat = fs.lstatSync(script);
  if (scriptStat.isSymbolicLink() || !scriptStat.isFile()) {
    throw new Error(`Dure orchestration status script is unsafe: ${script}`);
  }
  return { root, script };
}

function exitCode(report, mode) {
  if (mode !== "health") return 0;
  if (report.status === "healthy") return 0;
  if (report.status === "unknown") return 2;
  return 1;
}

export function runOrchestrationStatusFromCli({
  backend,
  cacheMs = DEFAULT_ORCHESTRATION_STATUS_CACHE_MS,
  cwd = process.cwd(),
  environment = process.env,
  execute = spawnSync,
  json = false,
  mode = "status",
  now = () => Date.now(),
  output = (source) => process.stdout.write(source),
  repository,
  timeoutMs = DEFAULT_ORCHESTRATION_STATUS_TIMEOUT_MS,
} = {}) {
  const started = process.hrtime.bigint();
  const nowMs = now();
  let report;
  try {
    if (backend !== undefined) {
      if (
        typeof backend !== "string" ||
        !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(backend)
      ) {
        throw Object.assign(new Error("backend profile selector is invalid"), {
          code: "backend_profiles_selector_invalid",
        });
      }
      throw Object.assign(
        new Error(
          "orchestration status transport is not deployed for backend profiles",
        ),
        { code: "orchestration_profile_transport_not_deployed" },
      );
    }
    const { root, script } = resolveRepository(repository ?? cwd);
    const pathname = cachePath(root, environment);
    const cached = readCache(pathname, { maximumAgeMs: cacheMs, nowMs });
    if (cached) {
      report = cachedReport(cached.report, {
        ageMs: cached.ageMs,
        maximumAgeMs: cacheMs,
        nowMs,
        state: "hit",
      });
    } else {
      const result = execute(process.execPath, [script, "--mode", mode, "--json"], {
        cwd: root,
        encoding: "utf8",
        env: environment,
        killSignal: "SIGKILL",
        maxBuffer: MAX_STATUS_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      });
      if (result.error?.code === "ETIMEDOUT") {
        throw Object.assign(new Error("orchestration status exceeded its deadline"), {
          code: "orchestration_status_timeout",
        });
      }
      if (result.error?.code === "ENOBUFS") {
        throw Object.assign(new Error("orchestration status exceeded its output bound"), {
          code: "orchestration_status_output_limit",
        });
      }
      if (result.error || result.status !== 0 && result.status !== 1 && result.status !== 2) {
        throw Object.assign(
          new Error(result.stderr?.trim() || "orchestration status process failed"),
          { code: "orchestration_status_process_failed" },
        );
      }
      report = JSON.parse(result.stdout);
      if (report?.apiVersion !== "dure.orchestration/v1") {
        throw Object.assign(new Error("orchestration status schema is incompatible"), {
          code: "orchestration_status_schema_incompatible",
        });
      }
      let cacheWriteError = null;
      if (cacheMs > 0) {
        try {
          writeCache(pathname, report, nowMs);
        } catch (error) {
          cacheWriteError = error;
        }
      }
      report = cachedReport(report, {
        ageMs: 0,
        maximumAgeMs: cacheMs,
        nowMs,
        state: cacheWriteError ? "bypass" : "miss",
      });
      if (cacheWriteError) {
        report.cache.reasonCode = "orchestration_status_cache_unavailable";
      }
    }
  } catch (error) {
    report = unavailableReport({
      code: error?.code ?? "orchestration_status_unavailable",
      message: error instanceof Error ? error.message : String(error),
      nowMs,
      view: mode,
    });
    report.cache = {
      state: "unavailable",
      maximumAgeMs: cacheMs,
      observedAtMs: nowMs,
      sourceAgeMs: 0,
    };
  }
  if (backend !== undefined) {
    report.target = {
      id: typeof backend === "string" ? backend : null,
      kind: "backend_profile",
      transport: "unavailable",
    };
  }
  report.view = mode;
  report.durationMs = Math.round(
    Number(process.hrtime.bigint() - started) / 1_000_000,
  );
  output(json ? `${JSON.stringify(report)}\n` : `${formatOrchestrationStatusFromCli(report)}\n`);
  return exitCode(report, mode);
}
