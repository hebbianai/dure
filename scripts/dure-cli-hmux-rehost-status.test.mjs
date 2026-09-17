import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const resolved = {
  schema: "hmux-managed-rehost-resolution-v1",
  schemaVersion: 1,
  state: "resolved",
  operationIds: ["operation-1"],
  sourceGeneration: { sessionId: "source-1", workspaceId: "workspace-1" },
  currentGeneration: { sessionId: "successor-1", workspaceId: "workspace-1" },
};

function fixture(response = resolved, operationOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "dure-rehost-status-"));
  roots.push(root);
  const binary = join(root, "hmux");
  const calls = join(root, "calls.jsonl");
  writeFileSync(
    binary,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(response))});
`,
  );
  chmodSync(binary, 0o700);
  const environment = {
    ...process.env,
    HOME: root,
    DURE_HOME: join(root, ".dure"),
    DURE_APP_CHANNEL: "stable",
    DURE_HMUX_BIN: binary,
    HMUX_DISCOVERY_ROOT: join(root, "discovery"),
  };
  delete environment.HEBBIAN_APP_CHANNEL;
  delete environment.HEBBIAN_HMUX_BIN;
  const run = (extra = []) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          cli,
          "hmux",
          "rehost",
          "status",
          ...(operationOnly ? [] : ["source-1", "--workspace", "workspace-1"]),
          "--operation-id",
          "operation-1",
          "--json",
          ...extra,
        ],
        { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (value) => {
        stdout += value;
      });
      child.stderr.on("data", (value) => {
        stderr += value;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  return { run, calls };
}

it("observes the original source by operation ID alone after discarded output", async () => {
  const { run, calls } = fixture(resolved, true);
  await run();
  const result = await run();
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(resolved);
  const expected = ["managed-rehost-resolve", "--operation-id", "operation-1", "--json"];
  expect(readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)).toEqual([expected, expected]);
});

it("observes the same exact rehost after lost output without an app descriptor or registry", async () => {
  const { run, calls } = fixture();
  await run(); // The caller loses the first response and restarts the CLI.
  const result = await run();
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(resolved);
  expect(
    readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse),
  ).toEqual([
    [
      "managed-rehost-resolve",
      "--session",
      "source-1",
      "--workspace",
      "workspace-1",
      "--operation-id",
      "operation-1",
      "--json",
    ],
    [
      "managed-rehost-resolve",
      "--session",
      "source-1",
      "--workspace",
      "workspace-1",
      "--operation-id",
      "operation-1",
      "--json",
    ],
  ]);
});

it.each(["not_found", "retry_required"])(
  "preserves %s without executing recovery",
  async (state) => {
    const response = {
      schema: resolved.schema,
      schemaVersion: 1,
      state,
      source: resolved.sourceGeneration,
      ...(state === "retry_required"
        ? {
            operationId: "operation-1",
            code: "hmux_managed_rehost_retry_required",
          }
        : {}),
    };
    const { run, calls } = fixture(response);
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(response);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
  },
);

it.each([["--backend", "remote-fixture"], ["--confirm-restart"], ["--fresh"]])(
  "does not send local status requests with unsupported intent: %j",
  async (...options) => {
    const { run, calls } = fixture();
    const result = await run(options);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "rehost_status_request_invalid" },
    });
    expect(existsSync(calls)).toBe(false);
  },
);
