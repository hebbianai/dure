import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const client = fileURLToPath(new URL("./spaces-pane-move-client.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function receipt() {
  const created = [0, 1, 2].map((index) => ({
    paneId: `pane-${index}`,
    sessionId: `session-${index}`,
    workspaceId: "workspace-1",
    terminalEpoch: `terminal-${index}`,
  }));
  return {
    proof: "spaces-proof",
    result: "passed",
    starts: 4, drops: 4, captureClears: 4, adds: 2, removes: 2, panes: 3,
    persisted: true, sameSpaceNoop: true, invalidNoop: true, returned: true,
    input: "synthetic-dom-drag",
    created,
    terminalGenerations: ["initial", "outward", "same-space", "invalid", "returned"].map((phase) => ({
      phase,
      sessions: created.map((session) => ({ ...session, lifecycle: "ready", health: "current_healthy" })),
    })),
  };
}

function run(report) {
  const root = mkdtempSync(path.join(tmpdir(), "dure-spaces-client-"));
  roots.push(root);
  mkdirSync(path.join(root, "evidence"));
  writeFileSync(path.join(root, "qa.log"), `[time] ${JSON.stringify(["spaces-pane-move", report])}\n`);
  const child = spawnSync(process.execPath, [client], {
    cwd: root,
    env: { ...process.env, DURE_QA_SPACES_MOVE_PROOF: "spaces-proof", DURE_QA_STATE_ROOT: root },
    encoding: "utf8",
    timeout: 4_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  return {
    status: child.status,
    saved: JSON.parse(readFileSync(path.join(root, "evidence", "spaces-pane-move.json"), "utf8")),
  };
}

it("accepts five exact native terminal observations for the moved pane and both siblings", () => {
  const report = receipt();
  expect(run(report)).toEqual({ status: 0, saved: report });
});

it.each([
  ["missing native observations", (report) => { delete report.terminalGenerations; }],
  ["missing creation receipts", (report) => { delete report.created; }],
  ["missing final observation", (report) => { report.terminalGenerations.pop(); }],
  ["reordered phases", (report) => { report.terminalGenerations.reverse(); }],
  ["missing sibling", (report) => { report.terminalGenerations[1].sessions.pop(); }],
  ["replaced terminal epoch", (report) => { report.terminalGenerations[1].sessions[0].terminalEpoch = "replacement"; }],
  ["sibling runtime replacement", (report) => { report.terminalGenerations[3].sessions[2].terminalEpoch = "replacement"; }],
  ["changed workspace", (report) => { report.terminalGenerations[2].sessions[0].workspaceId = "other"; }],
  ["changed session", (report) => { report.terminalGenerations[2].sessions[0].sessionId = "other"; }],
  ["changed pane", (report) => { report.terminalGenerations[2].sessions[0].paneId = "pane-other"; }],
  ["unobserved native health", (report) => { report.terminalGenerations[1].sessions[1].health = "unprobed"; }],
  ["exited runtime", (report) => { report.terminalGenerations[4].sessions[0].lifecycle = "exited"; }],
  ["duplicate original pane", (report) => {
    report.created[1].paneId = report.created[0].paneId;
    for (const phase of report.terminalGenerations) phase.sessions[1].paneId = phase.sessions[0].paneId;
  }],
  ["duplicate original session", (report) => {
    report.created[1].sessionId = report.created[0].sessionId;
    for (const phase of report.terminalGenerations) phase.sessions[1].sessionId = phase.sessions[0].sessionId;
  }],
  ["missing original epoch", (report) => {
    report.created[0].terminalEpoch = "";
    for (const phase of report.terminalGenerations) phase.sessions[0].terminalEpoch = "";
  }],
])("rejects and retains %s even when the WebView reports passed", (_name, mutate) => {
  const report = receipt();
  mutate(report);
  const result = run(report);
  expect(result.status).toBe(1);
  expect(result.saved).toMatchObject({ ...report, result: "failed", error: expect.any(String) });
});

it.each(["starts", "drops", "captureClears", "adds", "removes", "panes", "persisted", "sameSpaceNoop", "invalidNoop", "returned", "input"])(
  "keeps the existing %s acceptance condition",
  (field) => {
    const report = receipt();
    delete report[field];
    expect(run(report)).toMatchObject({ status: 1, saved: { result: "failed" } });
  },
);

it("preserves an explicit failed report and its partial observations", () => {
  const report = { ...receipt(), result: "failed", error: "Drop changed the runtime" };
  report.terminalGenerations.pop();
  expect(run(report)).toEqual({ status: 1, saved: report });
});
