import fs, { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { findQaLogReceipt, resolveQaLogPath, waitForQaLogReceipt } from "./qa-log-receipt.mjs";

const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function logFixture() {
  const root = mkdtempSync(join(tmpdir(), "dure-qa-receipt-"));
  roots.push(root);
  return join(root, "qa.log");
}
const line = (name, proof) => `[time] ${JSON.stringify([name, { proof, result: "passed" }])}\n`;

it("preserves non-isolated developer logs and explicit reader paths", async () => {
  const logPath = logFixture();
  expect(resolveQaLogPath({ stateRoot: "", worktreeRoot: join(logPath, "..") })).toBe(logPath);
  vi.stubEnv("DURE_QA_STATE_ROOT", `${logPath}.other-run`);
  writeFileSync(logPath, line("pane-conversion", "explicit"));
  expect(await waitForQaLogReceipt("pane-conversion", "explicit", { logPath, timeoutMs: 100 }))
    .toEqual({ proof: "explicit", result: "passed" });
});

it("does not fall back to a checkout log when an isolated log is absent", async () => {
  const rootLog = logFixture();
  const read = vi.spyOn(fs, "openSync");
  vi.stubEnv("DURE_QA_STATE_ROOT", join(rootLog, ".."));
  try {
    await expect(waitForQaLogReceipt("pane-conversion", "missing", { timeoutMs: 1 })).rejects.toThrow("No pane-conversion receipt");
    expect(read).toHaveBeenCalled();
    expect(read.mock.calls.every(([file]) => file === rootLog)).toBe(true);
  } finally { read.mockRestore(); }
});

it("reads its runner-owned receipt when the process cwd is the source worktree", async () => {
  const logPath = logFixture();
  vi.stubEnv("DURE_QA_STATE_ROOT", join(logPath, ".."));
  writeFileSync(logPath, line("pane-conversion", "owned"));
  expect(await waitForQaLogReceipt("pane-conversion", "owned", { timeoutMs: 100 }))
    .toEqual({ proof: "owned", result: "passed" });
});

it("selects only this scenario and proof amid unrelated and partial log entries", () => {
  const log = `partial\n[time] null\n${line("other", "ours")}${line("storage", "peer")}[time] [invalid\n${line("storage", "ours")}`;
  expect(findQaLogReceipt(log, "storage", "ours")).toEqual({ proof: "ours", result: "passed" });
  expect(findQaLogReceipt(log, "storage", "missing")).toBeUndefined();
  expect(findQaLogReceipt(`${log}[time] ["storage",{"proof":"ours","result":"failed"}]\n`, "storage", "ours")).toEqual({ proof: "ours", result: "failed" });
});

it("reads a late receipt shared by independent scenario waiters without truncating the log", async () => {
  const logPath = logFixture();
  const first = waitForQaLogReceipt("storage", "ours", { logPath });
  const second = waitForQaLogReceipt("rehost", "theirs", { logPath });
  writeFileSync(logPath, "x".repeat(1024 * 1024 + 32));
  appendFileSync(logPath, `\n${line("storage", "ours")}${line("rehost", "theirs")}`);
  expect(await first).toEqual({ proof: "ours", result: "passed" });
  expect(await second).toEqual({ proof: "theirs", result: "passed" });
});

it("reports an observation deadline without accepting another run", async () => {
  const logPath = logFixture();
  writeFileSync(logPath, line("storage", "peer"));
  await expect(waitForQaLogReceipt("storage", "ours", { logPath, timeoutMs: 1 })).rejects.toThrow("No storage receipt for ours");
});
