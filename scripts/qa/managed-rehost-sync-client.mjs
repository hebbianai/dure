import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_REHOST_SYNC_PROOF;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!proof || !stateRoot) throw new Error("Run through managed-rehost-sync-smoke.sh");
const receipt = await waitForQaLogReceipt("managed-rehost-sync", proof);
fs.writeFileSync(path.join(stateRoot, "evidence", "managed-rehost-sync.json"), JSON.stringify(receipt, null, 2));
if (receipt.result !== "passed") throw new Error(JSON.stringify(receipt));
console.log("managed rehost sync: native duplicate/reversed delivery, durable-only invalidation, and WebView reload passed", receipt);
