import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function resolveQaLogPath({ stateRoot = process.env.DURE_QA_STATE_ROOT, worktreeRoot = process.cwd() } = {}) {
  return path.resolve(stateRoot?.trim() || worktreeRoot, "qa.log");
}

export function findQaLogReceipt(log, name, proof) {
  let receipt;
  for (const line of log.split("\n")) {
    const start = line.indexOf("] ");
    if (start < 0) continue;
    let record;
    try { record = JSON.parse(line.slice(start + 2)); } catch { continue; }
    if (record?.[0] === name && record[1]?.proof === proof) receipt = record[1];
  }
  return receipt;
}

/** Read only a bounded tail of the run's QA log and select its exact receipt. */
export async function waitForQaLogReceipt(name, proof, { logPath = resolveQaLogPath(), timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let log = "";
    try {
      const descriptor = fs.openSync(logPath, "r");
      try {
        const size = fs.fstatSync(descriptor).size;
        const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
        fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
        log = buffer.toString("utf8");
      } finally { fs.closeSync(descriptor); }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const receipt = findQaLogReceipt(log, name, proof);
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`No ${name} receipt for ${proof}`);
}
