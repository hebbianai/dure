import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_AGENT_PLACEMENT_PROOF;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!proof || !stateRoot)
	throw new Error("Run through agent-pane-placement-smoke.sh");
const root = fs.realpathSync(stateRoot);
assert.equal(fs.realpathSync(process.env.HOME), path.join(root, "home"));
assert.equal(
	fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT),
	path.join(root, "hmux-discovery"),
);
const receipt = await waitForQaLogReceipt("agent-pane-placement", proof);
fs.writeFileSync(
	path.join(root, "evidence", "placement.json"),
	JSON.stringify(receipt, null, 2),
);
assert.match(receipt.userAgent, /AppleWebKit/);
assert.doesNotMatch(receipt.userAgent, /Chrome|Chromium/);
assert.equal(receipt.passed, true, JSON.stringify(receipt));
console.log(
	"Native WebView: four readable panes, invoking-pane preference, identity and layout persistence verified",
	receipt,
);
