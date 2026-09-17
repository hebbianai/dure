import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function report(status = "healthy") {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  return {
    schemaVersion: 1,
    apiVersion: "dure.orchestration/v1",
    kind: "dure.orchestration.status",
    view: "status",
    status,
    reasonCodes: [],
    partial: false,
    observedAt: new Date(now).toISOString(),
    observedAtMs: now,
    sourceAgeMs: 0,
    durationMs: 12,
    target: { kind: "repository", transport: "local_process" },
    github: {
      available: true,
      observedAtMs: now,
      sourceAgeMs: 0,
      ci: { queuedRuns: 0 },
    },
    host: {
      available: true,
      observedAtMs: now,
      sourceAgeMs: 0,
      worktrees: { orphanRegistrations: 0 },
    },
    health: { reasons: [], verdict: status },
    sources: [],
  };
}

function fixtureRepository({ hangs = false, status = "healthy" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-orch-status-cli-"));
  roots.push(root);
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  const source = hangs
    ? "setInterval(() => {}, 60_000);\n"
    : `import fs from "node:fs";
const counter = new URL("../counter", import.meta.url);
let count = 0;
try { count = Number(fs.readFileSync(counter, "utf8")); } catch {}
fs.writeFileSync(counter, String(count + 1));
process.stdout.write(${JSON.stringify(`${JSON.stringify(report(status))}\n`)});
`;
  fs.writeFileSync(path.join(scripts, "dure-orchestration-status.mjs"), source);
  return root;
}

function run(root, subcommand, extra = []) {
  const appHome = path.join(root, "empty-app-home");
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "orch",
      subcommand,
      "--json",
      "--repo",
      root,
      ...extra,
    ],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        DURE_APP_CHANNEL: "stable",
        DURE_HOME: appHome,
      },
      timeout: 5_000,
    },
  );
  return { appHome, elapsedMs: performance.now() - started, result };
}

describe("Dure orchestration status CLI", () => {
  test("runs status without an app registry", () => {
    const root = fixtureRepository();
    const { appHome, result } = run(root, "status", ["--cache-ms", "0"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      apiVersion: "dure.orchestration/v1",
      cache: { state: "miss" },
      status: "healthy",
    });
    expect(fs.existsSync(path.join(appHome, "agents.json"))).toBe(false);
  });

  test("preserves the health verdict exit code", () => {
    const root = fixtureRepository({ status: "degraded" });
    const { result } = run(root, "health", ["--cache-ms", "0"]);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "degraded",
      view: "health",
    });
  });

  test("shares a bounded cache across repeated CLI processes", () => {
    const root = fixtureRepository();
    const first = run(root, "status", ["--cache-ms", "60000"]);
    const hits = Array.from({ length: 3 }, () =>
      run(root, "status", ["--cache-ms", "60000"]),
    );
    expect(first.result.status, first.result.stderr).toBe(0);
    expect(JSON.parse(first.result.stdout).cache.state).toBe("miss");
    for (const hit of hits) {
      expect(hit.result.status, hit.result.stderr).toBe(0);
      expect(JSON.parse(hit.result.stdout).cache.state).toBe("hit");
    }
    expect(fs.readFileSync(path.join(root, "counter"), "utf8")).toBe("1");
    expect(
      Math.min(...hits.map(({ elapsedMs }) => elapsedMs)),
      `cache-hit wall times: ${hits.map(({ elapsedMs }) => elapsedMs.toFixed(1)).join(", ")}ms`,
    ).toBeLessThan(250);

    const cacheDirectory = path.join(
      first.appHome,
      "cache",
      "orchestration-status",
    );
    const cacheEntries = fs.readdirSync(cacheDirectory);
    expect(cacheEntries).toHaveLength(1);
    const cachePath = path.join(cacheDirectory, cacheEntries[0]);
    const cacheDocument = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    fs.writeFileSync(
      cachePath,
      `${JSON.stringify({ ...cacheDocument, recordedAtMs: 0 })}\n`,
    );

    const expired = run(root, "status", ["--cache-ms", "60000"]);
    expect(expired.result.status, expired.result.stderr).toBe(0);
    expect(JSON.parse(expired.result.stdout).cache.state).toBe("miss");
    expect(fs.readFileSync(path.join(root, "counter"), "utf8")).toBe("2");
  });

  test("turns a census deadline into typed unknown JSON", () => {
    const root = fixtureRepository({ hangs: true });
    const { elapsedMs, result } = run(root, "health", [
      "--cache-ms",
      "0",
      "--timeout-ms",
      "50",
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unknown",
      reasonCodes: ["orchestration_status_timeout"],
    });
  });

  test("does not silently fall back to local state for a remote backend profile", () => {
    const root = fixtureRepository();
    const { result } = run(root, "health", ["--backend", "remote-a"]);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unknown",
      reasonCodes: ["orchestration_profile_transport_not_deployed"],
      target: {
        id: "remote-a",
        kind: "backend_profile",
        transport: "unavailable",
      },
    });
    expect(fs.existsSync(path.join(root, "counter"))).toBe(false);
  });
});
