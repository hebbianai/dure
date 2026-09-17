import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const receipt = {
  schema: "hmux-managed-rehost-v1",
  schemaVersion: 1,
  operationId: "operation-1",
  replayed: true,
  sourceStopReceipt: { sessionId: "source-1", workspaceId: "workspace-1" },
  replacementReceipt: { sessionId: "target-1", workspaceId: "workspace-1" },
};

function fixture({ result = receipt, failure, action = "retry", operationOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-rehost-retry-"));
  roots.push(root);
  const binary = join(root, "hmux");
  const calls = join(root, "calls.jsonl");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
${
  failure
    ? `process.stderr.write(${JSON.stringify(failure)}); process.exitCode = 1;`
    : `process.stdout.write(${JSON.stringify(JSON.stringify(result))});`
}
`,
  );
  chmodSync(binary, 0o700);
  const environment = {
    ...process.env,
    HOME: root,
    DURE_HOME: join(root, ".dure"),
    DURE_APP_CHANNEL: "stable",
    HMUX_DISCOVERY_ROOT: join(root, "discovery"),
    DURE_HMUX_BIN: binary,
  };
  delete environment.HEBBIAN_APP_CHANNEL;
  return {
    calls,
    run: async (extra = []) => {
      try {
        const result = await execute(
          process.execPath,
          [
            cli,
            "hmux",
            "rehost",
            action,
            ...(operationOnly ? [] : ["source-1", "--workspace", "workspace-1"]),
            "--operation-id",
            "operation-1",
            "--confirm-restart",
            "--json",
            ...extra,
          ],
          { cwd: root, env: environment, timeout: 10_000 },
        );
        return { ...result, code: 0 };
      } catch (error) {
        return error;
      }
    },
  };
}

it("retries from only the retained operation without resolving a name or current source", async () => {
  const { run, calls } = fixture({ operationOnly: true });
  await run(); // Discard the reply, then start a new CLI process.
  const result = await run();
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(receipt);
  const expected = ["managed-rehost-reconcile", "--operation-id", "operation-1", "--confirm-restart", "--json"];
  expect(readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)).toEqual([expected, expected]);
});

it("still requires an explicit source for a new start", async () => {
  const { run, calls } = fixture({ action: "start", operationOnly: true });
  const result = await run();
  expect(result.code).toBe(1);
  expect(existsSync(calls)).toBe(false);
});

it.each(["retry", "start"])(
  "%s preserves the original operation after discarded output without an app or registry",
  async (action) => {
    const { run, calls } = fixture({ action });
    const lost = await run();
    expect(lost.code, lost.stderr).toBe(0);
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(receipt);
    const expected = [
      action === "start" ? "managed-rehost-start" : "managed-rehost-reconcile",
      "--session",
      "source-1",
      "--workspace",
      "workspace-1",
      "--operation-id",
      "operation-1",
      "--confirm-restart",
      "--json",
    ];
    expect(
      readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse),
    ).toEqual([expected, expected]);
  },
);

it("start preserves an uncertain native outcome without submitting another command", async () => {
  const { run, calls } = fixture({
    action: "start",
    failure: "hmux_managed_rehost_outcome_unknown",
  });
  const result = await run();
  expect(result.code).toBe(1);
  const report = JSON.parse(result.stderr);
  expect(report).toMatchObject({ ok: false, operationId: "operation-1" });
  expect(report.error.message).toContain("hmux_managed_rehost_outcome_unknown");
  expect(report.error.message).not.toContain(
    "no fresh operation was submitted",
  );
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
});

it.each([
  "hmux_managed_rehost_intent_not_found",
  "hmux_recovery_busy",
  "hmux_managed_rehost_outcome_unknown",
])("preserves %s without a new operation or app fallback", async (failure) => {
  const { run, calls } = fixture({ failure });
  const result = await run();
  expect(result.code).toBe(1);
  const report = JSON.parse(result.stderr);
  expect(report).toMatchObject({ ok: false, operationId: "operation-1" });
  expect(report.error.message).toContain(failure);
  expect(report.error.message).toContain("unknown");
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
});

it.each(
  ["start", "retry"].flatMap((action) =>
    [
      ["--fresh"],
      ["--backend", "remote"],
      ["--conversation-id", "other"],
      ["--credential-reference", "other"],
    ].map((extra) => [action, extra]),
  ),
)("%s refuses replacement/routing options: %j", async (action, extra) => {
  const { run, calls } = fixture({ action });
  const result = await run(extra);
  expect(result.code).toBe(1);
  expect(existsSync(calls)).toBe(false);
});

it("does not report another operation's receipt as this retry's success", async () => {
  const { run } = fixture({
    result: { ...receipt, operationId: "other-operation" },
  });
  const result = await run();
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe(
    "rehost_retry_response_invalid",
  );
});
