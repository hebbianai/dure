import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const client = fileURLToPath(new URL("./chat-draft-windows-client.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function receipt() {
  const createdPane = { id: "pane:opaque-slot", component: "agent", params: { agentRef: { agentId: "agent-target" } } };
  const reference = { id: "reference-slot", component: "agent", params: { agentRef: null } };
  const restoredInput = "Recovered instruction";
  const queuedInput = "Previously queued instruction";
  const original = { text: `${restoredInput}\nDraft`, attachments: [{ fileName: "image.png", dataB64: "image-bytes" }] };
  const appended = { text: `${original.text}\n\nAdditional capture`, attachments: [...original.attachments, ...original.attachments] };
  const editedText = "Edited after move";
  const edited = { ...appended, text: editedText };
  const recovered = { ...edited, text: `${editedText}\n${queuedInput}` };
  const phases = [
    ["source-ready", "source", [createdPane], original],
    ["ready", "peer", [reference], null],
    ["drop", "peer", [reference, createdPane], original],
    ["source-released", "source", [], null],
    ["appended", "peer", [reference, createdPane], appended],
    ["edit", "peer", [reference, createdPane], edited],
    ["replayed", "peer", [reference, createdPane], edited],
    ["return", "peer", [reference], null],
    ["returned", "source", [createdPane], edited],
    ["queued-drop", "peer", [reference, createdPane], edited],
    ["queued-edit", "peer", [reference, createdPane], recovered],
    ["queued-return", "peer", [reference], null],
    ["queued-returned", "source", [createdPane], recovered],
  ];
  return structuredClone({
    proof: "draft-proof", result: "passed", createdPane, original, appended, editedText, submissions: 0,
    restoredInput, queuedInput, recoveryRetiredAfterMove: true, queuedEditRestored: true,
    observations: phases.map(([phase, label, panes, draft], index) => structuredClone({
      proof: "draft-proof", phase, label, generation: `${label}-generation`,
      userAgent: "AppleWebKit/605.1.15", panes, paneIds: panes.map(({ id }) => id),
      layout: { panels: Object.fromEntries(panes.map((pane) => [pane.id, { ...pane, contentComponent: pane.component }])) },
      draft, composerText: draft?.text ?? null, submissions: 0,
      queuedCancellations: index >= 10 ? 1 : 0,
      interactionProfile: { schemaVersion: 1, kind: "structured_protocol", backendProfileId: "local", interactionSessionId: "conversation-1" },
    })),
  });
}

function run(report) {
  const root = mkdtempSync(path.join(tmpdir(), "dure-chat-draft-client-"));
  roots.push(root);
  mkdirSync(path.join(root, "evidence"));
  const artifacts = path.join(root, "artifacts");
  writeFileSync(path.join(root, "qa.log"), `[time] ${JSON.stringify(["chat-draft-windows", report])}\n`);
  const child = spawnSync(process.execPath, [client], {
    cwd: root,
    env: { ...process.env, DURE_QA_CHAT_DRAFT_PROOF: "draft-proof", DURE_QA_STATE_ROOT: root, DURE_QA_ARTIFACT_ROOT: artifacts },
    encoding: "utf8", timeout: 4_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const saved = JSON.parse(readFileSync(path.join(root, "evidence", "chat-draft-windows.json"), "utf8"));
  expect(JSON.parse(readFileSync(path.join(artifacts, "chat-draft-windows-draft-proof.json"), "utf8"))).toEqual(saved);
  return { status: child.status, saved };
}

it("accepts unchanged pane/Agent targeting and drafts through two native windows", () => {
  const report = receipt();
  expect(run(report)).toEqual({ status: 0, saved: report });
});

it.each([
  ["recovery record retired too early", (report) => { report.recoveryRetiredAfterMove = false; }],
  ["lost recovered input", (report) => { report.original.text = "Draft"; }],
  ["unfinished queued edit", (report) => { report.queuedEditRestored = false; }],
  ["lost queued edit after return", (report) => { report.observations[12].draft.text = report.editedText; }],
  ["queued edit never canceled", (report) => { report.observations[10].queuedCancellations = 0; }],
  ["queued edit canceled twice", (report) => { report.observations[12].queuedCancellations = 2; }],
  ["missing creation reference", (report) => { delete report.createdPane; }],
  ["missing explicit original Agent", (report) => { report.createdPane.params.agentRef = null; }],
  ["missing pane observations", (report) => { delete report.observations[2].panes; }],
  ["replaced pane ID", (report) => { report.observations[2].panes[1].id = "replacement"; }],
  ["changed content", (report) => { report.observations[4].panes[1].component = "terminal"; }],
  ["retargeted Agent", (report) => { report.observations[4].panes[1].params.agentRef.agentId = "other-agent"; }],
  ["invalid explicit Agent", (report) => { report.observations[4].panes[1].params.agentRef = null; }],
  ["changed sibling", (report) => { report.observations[2].panes[0].id = "replacement-sibling"; }],
  ["missing sibling", (report) => { report.observations[2].panes.shift(); }],
  ["duplicate pane", (report) => { report.observations[2].panes.push(report.createdPane); }],
  ["unreleased source pane", (report) => { report.observations[3].panes.push(report.createdPane); }],
  ["unreleased return pane", (report) => { report.observations[7].panes.push(report.createdPane); }],
  ["missing returned pane", (report) => { report.observations[8].panes = []; }],
  ["contradictory mounted pane IDs", (report) => { report.observations[2].paneIds = []; }],
  ["changed peer generation", (report) => { report.observations[4].generation = "replacement"; }],
  ["changed source generation", (report) => { report.observations[8].generation = "replacement"; }],
  ["wrong window", (report) => { report.observations[4].label = "source"; }],
  ["another run's observation", (report) => { report.observations[4].proof = "other-proof"; }],
  ["missing original generation", (report) => { report.observations[0].generation = ""; }],
  ["same native window", (report) => { report.observations[1].label = "source"; }],
  ["reordered phases", (report) => { report.observations.reverse(); }],
  ["missing edit observation", (report) => { report.observations.splice(5, 1); }],
  ["duplicate phase", (report) => { report.observations.push(report.observations[0]); }],
  ["retargeted conversation", (report) => { report.observations[4].interactionProfile.interactionSessionId = "other-conversation"; }],
  ["unreported peer submission", (report) => { report.observations[4].submissions = 1; }],
  ["replayed image loss", (report) => { report.observations[6].draft.attachments = []; }],
  ["changed source draft", (report) => { report.observations[0].draft.text = "other"; }],
  ["missing final observation", (report) => { report.observations.pop(); }],
  ["lost original draft bytes", (report) => { report.observations[2].draft.text = "other"; }],
  ["hidden source draft", (report) => { report.observations[3].draft = report.original; }],
  ["lost appended draft bytes", (report) => { report.observations[4].draft.text = "other"; }],
  ["lost composer text", (report) => { report.observations[8].composerText = "other"; }],
  ["lost return attachments", (report) => { report.observations[8].draft.attachments = []; }],
  ["changed layout after replay", (report) => { report.observations[6].layout = {}; }],
  ["provider submission", (report) => { report.submissions = 1; }],
  ["non-native browser", (report) => { report.observations[1].userAgent = "Chrome AppleWebKit"; }],
])("rejects and retains %s despite a claimed pass", (_name, mutate) => {
  const report = receipt();
  mutate(report);
  const result = run(report);
  expect(result.status).toBe(1);
  expect(result.saved).toMatchObject({ ...report, result: "failed", error: expect.any(String) });
});

it("preserves an explicit native failure and partial observations", () => {
  const report = { ...receipt(), result: "failed", error: "Native peer failed" };
  report.observations.pop();
  expect(run(report)).toEqual({ status: 1, saved: report });
});
