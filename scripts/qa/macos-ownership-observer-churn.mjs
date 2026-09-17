#!/usr/bin/env node

import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMacosProcessIdentity } from "../lib/process-identity.mjs";
import { macosProcessMarkerCompileArguments } from "./lib/owned-process-group.mjs";

export const RECEIPT_SCHEMA = "dure-macos-ownership-observer-churn/v1";
export const DEFAULT_DURATION_MS = 60_000;
export const DEFAULT_ITERATIONS = 1_000;
const MAX_DURATION_MS = 120_000;
const MAX_ITERATIONS = 10_000;
const EVENT_TO_LEDGER_P99_BUDGET_MS = 20;
const OBSERVER_CPU_BUDGET_PERCENT = 5;
let externalPsPolls = 0;

function recordExternalProcess(command) {
  if (path.basename(String(command)) === "ps") externalPsPolls += 1;
}

function spawnTracked(command, arguments_, options) {
  recordExternalProcess(command);
  return nodeSpawn(command, arguments_, options);
}

function spawnSyncTracked(command, arguments_, options) {
  recordExternalProcess(command);
  return nodeSpawnSync(command, arguments_, options);
}

const LEADER_SOURCE = String.raw`
const { spawn } = require("node:child_process");

const children = new Map();
let spawned = 0;
let spawnErrors = 0;
let startedAt = 0;
let durationMs = 0;
let target = 0;
let completed = false;

function stopChildren() {
  for (const child of children.values()) {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function shutdown() {
  stopChildren();
  const deadline = Date.now() + 2000;
  const wait = () => {
    if (children.size === 0 || Date.now() >= deadline) process.exit(0);
    setTimeout(wait, 10);
  };
  wait();
}

function maybeComplete() {
  if (completed || spawned < target || children.size !== 0) return false;
  completed = true;
  process.send?.({ kind: "complete", spawnErrors, spawned, survivors: 0 });
  return true;
}

function tick() {
  if (completed) return;
  const elapsed = Date.now() - startedAt;
  const desired = Math.min(
    target,
    Math.max(1, Math.floor((elapsed * target) / durationMs)),
  );
  while (spawned < desired && children.size < 16) {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 20)"],
      { detached: true, stdio: "ignore" },
    );
    spawned += 1;
    if (!Number.isSafeInteger(child.pid) || child.pid <= 1) spawnErrors += 1;
    else children.set(child.pid, child);
    child.once("error", () => {
      spawnErrors += 1;
      if (child.pid) children.delete(child.pid);
    });
    child.once("exit", () => {
      if (child.pid) children.delete(child.pid);
      maybeComplete();
    });
  }
  if (elapsed >= durationMs && spawned < target) {
    setTimeout(tick, 1);
    return;
  }
  if (!maybeComplete()) setTimeout(tick, 1);
}

process.on("message", (message) => {
  if (message?.kind === "start") {
    durationMs = message.durationMs;
    target = message.iterations;
    startedAt = Date.now();
    tick();
  } else if (message?.kind === "shutdown") {
    shutdown();
  }
});
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);
process.send?.({ kind: "ready" });
`;

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((innerResolve, innerReject) => {
    reject = innerReject;
    resolve = innerResolve;
  });
  return { promise, reject, resolve };
}

function boundedInteger(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--duration-ms") {
      options.durationMs = arguments_[index + 1];
      index += 1;
    } else if (argument === "--iterations") {
      options.iterations = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return {
    durationMs: boundedInteger(
      options.durationMs,
      DEFAULT_DURATION_MS,
      MAX_DURATION_MS,
      "duration",
    ),
    iterations: boundedInteger(
      options.iterations,
      DEFAULT_ITERATIONS,
      MAX_ITERATIONS,
      "iterations",
    ),
  };
}

function waitForClose(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ signal: child.signalCode, status: child.exitCode });
      return;
    }
    child.once("close", (status, signal) => resolve({ signal, status }));
  });
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function writeLedgerDelta(ledgerRoot, sequence, record) {
  const destination = path.join(
    ledgerRoot,
    `${String(sequence).padStart(8, "0")}.json`,
  );
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ process: record, schema: "dure-owned-process-ledger-delta/v1" })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  fs.renameSync(temporary, destination);
}

function percentile99(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.99) - 1)];
}

function parseNativeMetrics(stderr) {
  const match = stderr.match(
    /^dure_observer_metrics_v1 wall_ns=(\d+) cpu_us=(\d+) emitted=(\d+)$/mu,
  );
  if (!match) throw new Error("native observer metrics receipt is missing");
  const wallNs = Number(match[1]);
  const cpuUs = Number(match[2]);
  const emitted = Number(match[3]);
  if (
    !Number.isSafeInteger(wallNs) ||
    wallNs <= 0 ||
    !Number.isSafeInteger(cpuUs) ||
    cpuUs < 0 ||
    !Number.isSafeInteger(emitted) ||
    emitted < 0
  ) {
    throw new Error("native observer metrics receipt is malformed");
  }
  return {
    cpuPercent: (cpuUs * 100_000) / wallNs,
    emitted,
    wallMs: wallNs / 1_000_000,
  };
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS ownership observer churn requires darwin");
  }
  const { durationMs, iterations } = parseArguments(process.argv.slice(2));
  const fixtureRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "dure-observer-churn-"),
  );
  const executable = path.join(fixtureRoot, "ownership-observer");
  const ledgerRoot = path.join(fixtureRoot, "ledger-deltas");
  fs.mkdirSync(ledgerRoot, { mode: 0o700 });
  let leader;
  let observer;
  try {
    const compile = spawnSyncTracked(
      "cc",
      macosProcessMarkerCompileArguments(executable),
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    if (compile.status !== 0) {
      throw new Error(`observer compile failed: ${compile.stderr}`);
    }

    const leaderReady = deferred();
    const churnComplete = deferred();
    leader = spawnTracked(process.execPath, ["-e", LEADER_SOURCE], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    leader.on("message", (message) => {
      if (message?.kind === "ready") leaderReady.resolve();
      if (message?.kind === "complete") churnComplete.resolve(message);
    });
    const leaderClose = waitForClose(leader);
    await withTimeout(
      Promise.race([
        leaderReady.promise,
        leaderClose.then(() => {
          throw new Error("churn leader exited before readiness");
        }),
      ]),
      5_000,
      "churn leader readiness",
    );

    const identity = spawnSyncTracked(executable, ["read", String(leader.pid)], {
      encoding: "utf8",
    });
    const leaderIdentity = parseMacosProcessIdentity(identity.stdout.trim());
    if (identity.status !== 0 || !leaderIdentity) {
      throw new Error("could not resolve churn leader identity");
    }

    const observerReady = deferred();
    const barrierComplete = deferred();
    const eventToLedgerMs = [];
    let stdout = "";
    let stderr = "";
    let protocolFailure;
    observer = spawnTracked(
      executable,
      [
        "watch",
        String(leader.pid),
        leaderIdentity.bootSession,
        leaderIdentity.uniqueId,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    observer.stderr.setEncoding("utf8");
    observer.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    observer.stdout.setEncoding("utf8");
    observer.stdout.on("data", (chunk) => {
      if (protocolFailure) return;
      stdout += chunk;
      try {
        for (;;) {
          const newline = stdout.indexOf("\n");
          if (newline === -1) break;
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          const fields = line.trim().split(/\s+/u);
          if (fields[0] === "R" && fields[1] === "1") {
            observerReady.resolve();
            continue;
          }
          if (fields[0] === "B" && fields[1] === "1") {
            barrierComplete.resolve();
            continue;
          }
          if (fields[0] !== "P" || fields.length !== 10) {
            throw new Error(`unexpected observer frame: ${line}`);
          }
          const emittedAtNs = BigInt(fields[9]);
          const record = {
            groupId: Number(fields[6]),
            kernelStartMarker:
              `kernel-start-v3:macos:${leaderIdentity.bootSession}:${fields[2]}`,
            parentPid: Number(fields[5]),
            pid: Number(fields[1]),
            sessionId: Number(fields[7]),
            startMarker: `epoch-seconds:${fields[8]}`,
          };
          writeLedgerDelta(ledgerRoot, eventToLedgerMs.length + 1, record);
          const latencyNs = BigInt(Date.now()) * 1_000_000n - emittedAtNs;
          if (latencyNs < -1_000_000n) {
            throw new Error("observer and ledger realtime clocks diverged");
          }
          eventToLedgerMs.push(
            Number(latencyNs < 0n ? 0n : latencyNs) / 1_000_000,
          );
        }
      } catch (error) {
        protocolFailure = error;
        observerReady.reject(error);
        observer.kill("SIGTERM");
      }
    });
    const observerClose = waitForClose(observer);
    const ensureObserverAliveUntil = (promise, label) =>
      Promise.race([
        promise,
        observerClose.then(({ signal, status }) => {
          if (protocolFailure) throw protocolFailure;
          throw new Error(
            `observer exited before ${label} status=${status} signal=${signal}`,
          );
        }),
      ]);
    await withTimeout(
      ensureObserverAliveUntil(observerReady.promise, "readiness"),
      10_000,
      "observer readiness",
    );

    leader.send({ durationMs, iterations, kind: "start" });
    const churn = await withTimeout(
      ensureObserverAliveUntil(churnComplete.promise, "churn completion"),
      durationMs + 30_000,
      "observer churn",
    );
    observer.stdin.write("barrier 1\n");
    await withTimeout(
      ensureObserverAliveUntil(barrierComplete.promise, "final barrier"),
      10_000,
      "observer final barrier",
    );
    observer.stdin.end("stop\n");
    const observerResult = await withTimeout(
      observerClose,
      10_000,
      "observer stop",
    );
    if (observerResult.status !== 0 || observerResult.signal !== null) {
      throw new Error(
        `observer failed status=${observerResult.status} signal=${observerResult.signal}`,
      );
    }

    leader.send({ kind: "shutdown" });
    const leaderResult = await withTimeout(leaderClose, 5_000, "leader stop");
    if (leaderResult.status !== 0 || leaderResult.signal !== null) {
      throw new Error(
        `leader failed status=${leaderResult.status} signal=${leaderResult.signal}`,
      );
    }
    if (protocolFailure) throw protocolFailure;

    const nativeMetrics = parseNativeMetrics(stderr);
    const eventToLedgerP99Ms = percentile99(eventToLedgerMs);
    const receipt = {
      durationMs,
      eventToLedgerP99Ms,
      externalPsPolls,
      iterations,
      nativeObserverCpuPercent: nativeMetrics.cpuPercent,
      nativeObserverEmittedProcesses: nativeMetrics.emitted,
      observedLedgerWrites: eventToLedgerMs.length,
      schema: RECEIPT_SCHEMA,
      spawnErrors: churn.spawnErrors,
      spawned: churn.spawned,
      survivors: churn.survivors,
    };
    if (
      churn.spawned !== iterations ||
      churn.spawnErrors !== 0 ||
      churn.survivors !== 0 ||
      externalPsPolls !== 0 ||
      eventToLedgerP99Ms === null ||
      eventToLedgerP99Ms >= EVENT_TO_LEDGER_P99_BUDGET_MS ||
      nativeMetrics.cpuPercent >= OBSERVER_CPU_BUDGET_PERCENT ||
      nativeMetrics.emitted !== eventToLedgerMs.length
    ) {
      throw new Error(`observer churn budget failed: ${JSON.stringify(receipt)}`);
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    const cleanup = [];
    if (observer && observer.exitCode === null && observer.signalCode === null) {
      observer.kill("SIGTERM");
      cleanup.push(
        withTimeout(waitForClose(observer), 5_000, "observer cleanup"),
      );
    }
    if (leader && leader.exitCode === null && leader.signalCode === null) {
      if (leader.connected) leader.send({ kind: "shutdown" });
      leader.kill("SIGTERM");
      cleanup.push(
        withTimeout(waitForClose(leader), 5_000, "leader cleanup"),
      );
    }
    const cleanupResults = await Promise.allSettled(cleanup);
    const cleanupFailures = cleanupResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        `observer churn cleanup failed; fixture preserved at ${fixtureRoot}`,
      );
    }
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
