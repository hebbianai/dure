import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_CHAT_DRAFT_PROOF;
const root = process.env.DURE_QA_STATE_ROOT;
assert.ok(proof && root, "Run through chat-draft-windows-smoke.sh");
const receipt = await waitForQaLogReceipt("chat-draft-windows", proof, { timeoutMs: 150_000 });
if (receipt.result === "passed") {
  try {
    verifyReceipt(receipt);
  } catch (error) {
    receipt.result = "failed";
    receipt.error = error.message;
  }
}
fs.writeFileSync(path.join(root, "evidence", "chat-draft-windows.json"), JSON.stringify(receipt, null, 2));
const artifacts = process.env.DURE_QA_ARTIFACT_ROOT ?? "artifacts/qa";
fs.mkdirSync(artifacts, { recursive: true });
fs.writeFileSync(path.join(artifacts, `chat-draft-windows-${proof}.json`), JSON.stringify(receipt, null, 2), { flag: "wx" });
assert.equal(receipt.result, "passed", JSON.stringify(receipt));
console.log("Native two-WebView pane/Agent identity, draft/image migration, replay and return: PASS", { proof, imageDigest: receipt.imageDigest, observations: receipt.observations.length });

function verifyReceipt(report) {
  const { createdPane, original, appended, editedText, observations } = report;
  const nonempty = (value, label) => assert.ok(typeof value === "string" && value.length > 0, `Missing ${label}`);
  nonempty(createdPane?.id, "creation pane ID");
  assert.equal(createdPane.component, "agent");
  nonempty(createdPane.params?.agentRef?.agentId, "creation Agent reference");
  const [source, peer] = observations;
  for (const window of [source, peer]) {
    nonempty(window?.label, "window label");
    nonempty(window.generation, "window generation");
  }
  assert.notEqual(source.label, peer.label);
  assert.notEqual(source.generation, peer.generation);
  assert.equal(peer.panes?.length, 1, "Missing original destination sibling");
  const [sibling] = peer.panes;
  nonempty(sibling.id, "sibling ID");
  assert.notEqual(sibling.id, createdPane.id);
  const profile = source.interactionProfile;
  assert.equal(profile?.kind, "structured_protocol");
  nonempty(profile.backendProfileId, "backend identity");
  nonempty(profile.interactionSessionId, "conversation identity");
  assert.equal(appended.text, `${original.text}\n\nAdditional capture`);
  assert.deepEqual(appended.attachments, [...original.attachments, ...original.attachments]);
  const edited = { ...appended, text: editedText };
  const phases = [
    ["source-ready", source, [createdPane], original],
    ["ready", peer, [sibling], null],
    ["drop", peer, [sibling, createdPane], original],
    ["source-released", source, [], null],
    ["appended", peer, [sibling, createdPane], appended],
    ["edit", peer, [sibling, createdPane], edited],
    ["replayed", peer, [sibling, createdPane], edited],
    ["return", peer, [sibling], null],
    ["returned", source, [createdPane], edited],
  ];
  assert.deepEqual(observations.map(({ phase }) => phase), phases.map(([phase]) => phase));
  const targets = (panes) => panes.map(({ id, component, params }) => ({ id, component, agentRef: params?.agentRef }))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const [index, [name, window, panes, draft]] of phases.entries()) {
    const observed = observations[index];
    assert.equal(observed.proof, proof, `Wrong run at ${name}`);
    assert.equal(observed.label, window.label, `Wrong window at ${name}`);
    assert.equal(observed.generation, window.generation, `Window replaced at ${name}`);
    assert.match(observed.userAgent, /AppleWebKit/u);
    assert.doesNotMatch(observed.userAgent, /Chrom(?:e|ium)/u);
    assert.deepEqual(targets(observed.panes), targets(panes), `Pane/Agent targeting changed at ${name}`);
    assert.deepEqual([...observed.paneIds].sort(), panes.map(({ id }) => id).sort(), `Mounted pane IDs changed at ${name}`);
    assert.deepEqual(observed.interactionProfile, profile, `Conversation changed at ${name}`);
    assert.deepEqual(observed.draft, draft, `Draft changed at ${name}`);
    if (draft) assert.equal(observed.composerText, draft.text, `Composer changed at ${name}`);
    assert.equal(observed.submissions, 0, `Provider submission at ${name}`);
  }
  assert.deepEqual(observations[6].layout, observations[5].layout, "Replay reverted native layout edits");
  assert.equal(report.submissions, 0);
}
