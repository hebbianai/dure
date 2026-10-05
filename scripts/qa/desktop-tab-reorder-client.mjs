import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_TAB_REORDER_PROOF;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!proof || !stateRoot) throw new Error("Run through desktop-tab-reorder-smoke.sh");
const receipt = await waitForQaLogReceipt("desktop-tab-reorder", proof);
fs.writeFileSync(path.join(stateRoot, "evidence", "desktop-tab-reorder.json"), JSON.stringify(receipt, null, 2));
assert.equal(receipt.result, "passed", receipt.error);
assert.deepEqual(receipt.checks, ["release-position", "tab-gap", "strip-end"]);
assert.equal(receipt.input, "synthetic-dom-drag");
assert.equal(receipt.activeSpacePreserved, true);
console.log("Space tab reordering: release coordinates, gaps, strip end and unchanged selection passed in WKWebView");
