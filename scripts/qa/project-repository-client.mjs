import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_REPOSITORY_PROOF;
const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
assert.equal(fs.realpathSync(process.env.HOME), path.join(root, "home"));
assert.equal(fs.realpathSync(process.env.DURE_HOME), path.join(root, "home", ".dure"));
assert.equal(fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT), path.join(root, "hmux-discovery"));
const receipt = await waitForQaLogReceipt("project-repository", proof);
fs.writeFileSync(path.join(root, "evidence", "repository.json"), JSON.stringify(receipt, null, 2));
assert.equal(receipt.passed, true, JSON.stringify(receipt));
assert.match(receipt.userAgent, /AppleWebKit/);
assert.doesNotMatch(receipt.userAgent, /Chrome|Chromium/);
console.log("Native repository recheck, draft retention, persistence, retry and both agent forms verified", receipt);
