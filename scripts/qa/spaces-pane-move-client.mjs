import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_SPACES_MOVE_PROOF;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!proof || !stateRoot) throw new Error("Run through spaces-pane-move-smoke.sh");
const receipt = await waitForQaLogReceipt("spaces-pane-move", proof);
if (receipt.result === "passed") {
  try {
    for (const [field, expected] of Object.entries({
      starts: 4, drops: 4, captureClears: 4, adds: 2, removes: 2, panes: 3,
      persisted: true, sameSpaceNoop: true, invalidNoop: true, returned: true,
      input: "synthetic-dom-drag",
    })) assert.equal(receipt[field], expected, `Incomplete Spaces move evidence: ${field}`);
    assert.equal(receipt.created?.length, 3, "Missing original terminal identities");
    for (const session of receipt.created) {
      for (const field of ["paneId", "sessionId", "workspaceId", "terminalEpoch"]) {
        assert.equal(typeof session[field], "string", `Missing original ${field}`);
        assert.notEqual(session[field], "", `Empty original ${field}`);
      }
      assert.ok(session.paneId.startsWith("pane-"), "New pane ID is not neutral");
    }
    assert.equal(new Set(receipt.created.map((session) => session.paneId)).size, 3, "Duplicate original pane");
    assert.equal(new Set(receipt.created.map((session) => JSON.stringify([session.workspaceId, session.sessionId]))).size, 3, "Duplicate original session");
    assert.deepEqual(
      receipt.terminalGenerations,
      ["initial", "outward", "same-space", "invalid", "returned"].map((phase) => ({
        phase,
        sessions: receipt.created.map((session) => ({ ...session, lifecycle: "ready", health: "current_healthy" })),
      })),
      "Missing or changed native terminal generation observations",
    );
  } catch (error) {
    receipt.result = "failed";
    receipt.error = error.message;
  }
}
fs.writeFileSync(path.join(stateRoot, "evidence", "spaces-pane-move.json"), JSON.stringify(receipt, null, 2));
if (receipt.result !== "passed") throw new Error(JSON.stringify(receipt));
console.log("Spaces move: WKWebView capture cleanup, outward/return layout, no-op, persistence and exact terminal epochs passed", receipt);
