import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_QUICK_START_PROOF;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!proof || !stateRoot) throw new Error("Run through repository-quick-start-smoke.sh");
const deadline = Date.now() + 120_000;
let receipt;
while (!receipt && Date.now() < deadline) {
	let log = "";
	try {
		const descriptor = fs.openSync(resolveQaLogPath(), "r");
		try {
			const size = fs.fstatSync(descriptor).size;
			const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
			fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
			log = buffer.toString("utf8");
		} finally { fs.closeSync(descriptor); }
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	for (const line of log.split("\n")) {
		const start = line.indexOf("] ");
		if (start < 0) continue;
		let record;
		try { record = JSON.parse(line.slice(start + 2)); } catch { continue; }
		if (record[0] === "repository-quick-start" && record[1]?.proof === proof) receipt = record[1];
	}
	if (!receipt) await delay(500);
}
if (!receipt) throw new Error(`No repository quick-start receipt for ${proof}`);
if (receipt.result === "passed") {
  try {
    const presented = receipt.nativePresentation;
    if (!presented?.connected || !presented.presented || !presented.providerOutput || !presented.visible || presented.focused !== false || !(presented.columns > 0) || !(presented.rows > 0))
      throw new Error("Provider pane did not attach and present its output without OS focus");
    const captures = path.join(stateRoot, "provider-capture", "provider-sessions");
    const starts = fs.readdirSync(captures).filter((file) => file.endsWith(".json"));
    if (starts.length !== 1) throw new Error("Expected exactly one fake provider launch");
    const start = JSON.parse(fs.readFileSync(path.join(captures, starts[0]), "utf8"));
    if (start.schema !== 1 || start.provider !== "claude" || receipt.panes?.length !== 1)
      throw new Error("Corrected launch did not use one isolated fake Claude provider");
    receipt.fakeProvider = start;
  } catch (error) {
    receipt.result = "failed";
    receipt.error = String(error);
  }
}
fs.writeFileSync(path.join(stateRoot, "evidence", "repository-quick-start.json"), JSON.stringify(receipt, null, 2));
if (receipt.result !== "passed") throw new Error(JSON.stringify(receipt));
console.log("repository quick start: failure/retry/menu/terminal and one attached fake-provider pane with presented output passed", receipt);
