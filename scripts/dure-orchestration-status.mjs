#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dureOrchestrationHealthExitCode,
  evaluateDureOrchestrationHealth,
} from "./lib/dure-orchestration-health-core.mjs";
import {
  observeGithubDureOrchestration,
  observeLocalDureOrchestrationHost,
} from "./lib/dure-orchestration-observers.mjs";

export const DURE_ORCHESTRATION_STATUS_SCHEMA_VERSION = 1;

export async function collectDureOrchestrationStatus({
  cwd = process.cwd(),
  now = () => Date.now(),
  observeGithub = observeGithubDureOrchestration,
  observeHost = observeLocalDureOrchestrationHost,
  view = "status",
} = {}) {
  const started = process.hrtime.bigint();
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error("orchestration status now must be an integer timestamp");
  }
  const githubPromise = Promise.resolve(observeGithub({ cwd, nowMs }));
  const host = observeHost({ cwd, nowMs });
  const github = await githubPromise;
  const base = {
    schemaVersion: DURE_ORCHESTRATION_STATUS_SCHEMA_VERSION,
    apiVersion: "dure.orchestration/v1",
    kind: "dure.orchestration.status",
    view,
    observedAt: new Date(nowMs).toISOString(),
    observedAtMs: nowMs,
    sourceAgeMs: 0,
    durationMs: 0,
    partial: !github.available || !host.available,
    target: {
      kind: "repository",
      transport: "local_process",
    },
    github,
    host,
  };
  const health = evaluateDureOrchestrationHealth(base, { nowMs });
  const report = {
    ...base,
    status: health.verdict,
    reasonCodes: health.reasons.map(({ code }) => code).sort(),
    health,
    sources: [
      {
        name: "github_actions",
        state: github.available ? github.state : "unavailable",
        observedAtMs: github.observedAtMs,
        sourceAgeMs: github.sourceAgeMs,
        reasonCode: github.error?.code ?? null,
      },
      {
        name: "local_host",
        state: host.available ? host.state : "unavailable",
        observedAtMs: host.observedAtMs,
        sourceAgeMs: host.sourceAgeMs,
        reasonCode: host.error?.code ?? null,
      },
    ],
  };
  report.durationMs = Math.round(
    Number(process.hrtime.bigint() - started) / 1_000_000,
  );
  return report;
}

function line(label, value) {
  return `${label.padEnd(22)} ${value}`;
}

export function formatDureOrchestrationStatus(snapshot) {
  const lines = [`Dure orchestration: ${snapshot.status.toUpperCase()}`];
  if (snapshot.github.available) {
    lines.push(
      line(
        "GitHub CI",
        `${snapshot.github.ci.queuedRuns} queued · ${snapshot.github.ci.inProgressRuns} running`,
      ),
    );
  } else {
    lines.push(line("GitHub", `unavailable · ${snapshot.github.error?.code ?? "unknown"}`));
  }
  if (snapshot.host.available) {
    lines.push(
      line(
        "Orphan worktrees",
        `${snapshot.host.worktrees.orphanRegistrations} (${snapshot.host.worktrees.scope})`,
      ),
    );
  } else {
    lines.push(line("Host", `unavailable · ${snapshot.host.error?.code ?? "unknown"}`));
  }
  lines.push(line("Observation", `${snapshot.durationMs}ms${snapshot.partial ? " · partial" : ""}`));
  if (snapshot.health.reasons.length > 0) {
    lines.push("", "Health reasons:");
    for (const reason of snapshot.health.reasons) {
      lines.push(`- [${reason.severity}] ${reason.code}: ${reason.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseArguments(args) {
  let json = false;
  let mode = "status";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--mode") {
      mode = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown orchestration status argument: ${argument}`);
  }
  if (mode !== "status" && mode !== "health") {
    throw new Error("orchestration status mode must be status or health");
  }
  return { json, mode };
}

export async function runDureOrchestrationStatusCommand({
  args = process.argv.slice(2),
  collect = collectDureOrchestrationStatus,
  cwd = process.cwd(),
  output = (source) => process.stdout.write(source),
} = {}) {
  const options = parseArguments(args);
  const snapshot = await collect({ cwd, view: options.mode });
  output(
    options.json
      ? `${JSON.stringify(snapshot)}\n`
      : formatDureOrchestrationStatus(snapshot),
  );
  return options.mode === "health"
    ? dureOrchestrationHealthExitCode(snapshot.health.verdict)
    : 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = await runDureOrchestrationStatusCommand();
  } catch (error) {
    process.stderr.write(
      `dure-orchestration-status: ${(error instanceof Error ? error.message : String(error)).slice(0, 2_048)}\n`,
    );
    process.exitCode = 2;
  }
}
