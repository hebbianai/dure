import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appWindowId, captureAppWindow } from "./lib/app-window-capture.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_CHAT_PROVIDER_EXIT_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
assert.ok(proof && evidence && stateRoot && home, "Run through chat-provider-exit-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");

const STATES = ["ended", "resuming", "did-not-restart", "refused"];
const PHASES = ["light", "dark"].flatMap((theme) => STATES.map((state) => `${state}-${theme}`));

function receipt(phase, timeoutMs = 240_000) {
  return waitForQaLogReceipt(`chat-provider-exit-${phase}`, proof, {
    timeoutMs, failedName: "chat-provider-exit-failed",
  });
}

/** One surface: the notice heads the composer's box above the input, with a
 * hairline below it and no ring or fill of its own. Colour only where the
 * action is: the copy is the input's foreground, the glyph and Resume wear
 * the same accent, and a Resume's outcome is muted. */
function verify(phase, facts) {
  const [state] = STATES.filter((name) => phase.startsWith(`${name}-`));
  const { borders, colors, tokens, expected } = facts;
  assert.equal(facts.dark, phase.endsWith("-dark"), `${phase}: wrong theme`);
  assert.equal(facts.insideComposerBox, true, `${phase}: the notice is not inside the composer's box`);
  assert.equal(facts.boxBorderTop, "1px", `${phase}: the composer's box lost its ring`);
  assert.deepEqual(borders, { top: "0px", right: "0px", bottom: "1px", left: "0px" },
    `${phase}: the notice is not a strip with one hairline below`);
  assert.equal(facts.background, "rgba(0, 0, 0, 0)", `${phase}: the notice has a fill of its own`);
  assert.equal(colors.ended, tokens.foreground, `${phase}: the notice's copy is not the foreground`);
  assert.equal(colors.glyph, tokens.attention, `${phase}: the glyph does not wear the attention accent`);
  assert.equal(colors.action, tokens.attention, `${phase}: Resume does not wear the attention accent`);
  assert.equal(facts.ended, `${expected.ended}exit 143`, `${phase}: wrong ended line`);
  assert.equal(facts.endedDetail, "exit 143", `${phase}: the exit reason is not its detail`);
  assert.equal(facts.draft, "Also update the README example.", `${phase}: the draft is gone`);
  const resuming = state === "resuming";
  assert.deepEqual(facts.action, { label: resuming ? expected.resuming : expected.resume, disabled: resuming },
    `${phase}: wrong Resume control`);
  const outcome = { "did-not-restart": expected.notRestarted, refused: `${expected.refused}agent_conversation_conflict` }[state];
  assert.equal(facts.outcome, outcome ?? null, `${phase}: wrong outcome line`);
  if (outcome) assert.equal(colors.outcome, tokens.muted, `${phase}: the outcome is not muted`);
}

// A cold worktree spends minutes in Vite dependency reloads; the window
// exists once the probe has started.
await receipt("started", 480_000);
const windowId = appWindowId();
const artifacts = process.env.DURE_QA_ARTIFACT_ROOT ?? "artifacts/qa";
const imageDir = join(artifacts, `chat-provider-exit-${proof}`);
mkdirSync(imageDir, { recursive: true });
const reports = {};
const images = [];
for (const phase of PHASES) {
  reports[phase] = await receipt(phase);
  const name = `${phase}.png`;
  // An off-screen WKWebView window composites after the DOM settles; a
  // theme switch can still be on its way to the window's backing store.
  await delay(1_000);
  captureAppWindow(windowId, join(evidence, name));
  copyFileSync(join(evidence, name), join(imageDir, name));
  images.push(name);
  writeFileSync(join(home, `chat-provider-exit-captured-${phase}`), "");
}
await receipt("done");

const failures = [];
for (const phase of PHASES) {
  try {
    verify(phase, reports[phase]);
  } catch (error) {
    failures.push(error.message);
  }
}
const report = { result: failures.length === 0 ? "passed" : "failed", failures, images, reports };
writeFileSync(join(evidence, "chat-provider-exit.json"), JSON.stringify(report, null, 2));
writeFileSync(join(imageDir, "chat-provider-exit.json"), JSON.stringify(report, null, 2));
assert.deepEqual(failures, [], JSON.stringify(failures));
console.log("PASS: the ended-session notice heads the composer as one surface, amber only on its glyph and Resume, in each Resume state in light and dark", { imageDir });
