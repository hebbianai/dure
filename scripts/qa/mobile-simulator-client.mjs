import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const receipt = await waitForQaLogReceipt("mobile-simulator", process.env.DURE_QA_MOBILE_DEVICE, { timeoutMs: 180_000 });
const screenshot = receipt.dataUrl ? Buffer.from(receipt.dataUrl.split(",")[1], "base64") : null;
delete receipt.dataUrl;
if (receipt.paneCapture) {
 writeFileSync(join(process.env.DURE_QA_EVIDENCE_DIR, "pane.png"), Buffer.from(receipt.paneCapture.pngB64, "base64"), { flag: "wx" });
 delete receipt.paneCapture.pngB64;
}
if (screenshot) writeFileSync(join(process.env.DURE_QA_EVIDENCE_DIR, "simulator.png"), screenshot, { flag: "wx" });
writeFileSync(join(process.env.DURE_QA_EVIDENCE_DIR, "mobile-simulator.json"), JSON.stringify(receipt, null, 2));
assert.equal(receipt.result, "passed", JSON.stringify(receipt));
assert.equal(receipt.profileRun, true);
assert.equal(receipt.agentCommands, true);
assert.match(receipt.userAgent, /AppleWebKit/u);
assert.equal(receipt.hiddenAndRestored, true);
assert.equal(receipt.restored.id, process.env.DURE_QA_MOBILE_DEVICE);

console.log("PASS: native mobile profile build/install/launch, controls, agent actions, PNG rendering and restoration", receipt);
