import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const client = fileURLToPath(new URL("./chat-large-window-client.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function receipt() {
  const typed = "Sent from the large window";
  const observation = (phase, patch = {}) => ({
    proof: "large-proof", phase, label: "win-session-agent", toolbar: true, viewControl: true,
    viewEnabled: true, composer: true, sent: [], agentView: "chat", ...patch,
  });
  return structuredClone({
    proof: "large-proof", result: "passed", label: "main", largeLabel: "win-session-agent", typed,
    proxyShown: true, sourceSent: 0, switchRequests: [{ sourceStopPolicy: "preserve" }],
    userAgent: "AppleWebKit/605.1.15",
    observations: [
      observation("ready"),
      observation("send", { sent: [typed] }),
      observation("view-terminal", { sent: [typed] }),
      observation("terminal-followed", { sent: [typed], composer: false, agentView: "terminal" }),
      observation("chat-followed", { sent: [typed] }),
    ],
  });
}

function run(report) {
  const root = mkdtempSync(path.join(tmpdir(), "dure-chat-large-window-client-"));
  roots.push(root);
  mkdirSync(path.join(root, "evidence"));
  const artifacts = path.join(root, "artifacts");
  writeFileSync(path.join(root, "qa.log"), `[time] ${JSON.stringify(["chat-large-window", report])}\n`);
  const child = spawnSync(process.execPath, [client], {
    cwd: root,
    env: { ...process.env, DURE_QA_CHAT_LARGE_WINDOW_PROOF: "large-proof", DURE_QA_STATE_ROOT: root, DURE_QA_ARTIFACT_ROOT: artifacts },
    encoding: "utf8", timeout: 4_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const saved = JSON.parse(readFileSync(path.join(root, "evidence", "chat-large-window.json"), "utf8"));
  expect(JSON.parse(readFileSync(path.join(artifacts, "chat-large-window-large-proof.json"), "utf8"))).toEqual(saved);
  return { status: child.status, saved };
}

it("accepts the large window's toolbar, send, proxy and View round trip", () => {
  const report = receipt();
  expect(run(report)).toEqual({ status: 0, saved: report });
});

it.each([
  ["source pane kept its composer", (report) => { report.proxyShown = false; }],
  ["message never reached the session", (report) => { report.observations[1].sent = []; }],
  ["source pane sent the message", (report) => { report.sourceSent = 1; }],
  ["View switch skipped the source pane", (report) => { report.switchRequests = []; }],
  ["window kept the Chat after the switch", (report) => { report.observations[3].composer = true; }],
  ["window never returned to Chat", (report) => { report.observations[4].agentView = "terminal"; }],
  ["steps from another window", (report) => { report.observations[2].label = "main"; }],
])("rejects a run where the %s", (_name, corrupt) => {
  const report = receipt();
  corrupt(report);
  const { status, saved } = run(report);
  expect(status).not.toBe(0);
  expect(saved.result).toBe("failed");
});
