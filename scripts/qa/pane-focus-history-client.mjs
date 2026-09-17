import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";
import { fileURLToPath } from "node:url";
import { parseMacosProcessIdentity, processMemberSnapshots } from "../lib/process-identity.mjs";
import { armExclusiveNativeInput } from "./lib/exclusive-native-input.mjs";
import { readWorkspacePerformanceDescriptor } from "./lib/workspace-performance-descriptor.mjs";

export function parsePaneFocusHistoryReport(line, runId) {
  const start = line.indexOf("] ");
  if (start < 0) return undefined;
  let payload;
  try { payload = JSON.parse(line.slice(start + 2)); } catch { return undefined; }
  if (!Array.isArray(payload) || payload[0] !== "pane-focus-history" || payload[1]?.runId !== runId) return undefined;
  const report = payload[1];
  if (report.pass !== true) throw new Error(`pane focus history failed: ${report.error ?? "missing success evidence"}`);
  if (report.schemaVersion !== 1 || report.nativeWindowLabel !== "main" ||
      report.keyboardSource !== "synthetic-dom" || report.nativeFocusChecks !== 22 ||
      !Array.isArray(report.observations) || report.observations.length !== 21 ||
      !report.observations.every((value) => value.focusInsidePane === true) ||
      report.activation?.focusRequests !== 1 || report.activation.firstInput !== "x" ||
      report.activation.trustedInput !== true || !Number.isFinite(report.activation.focusMs) ||
      report.activation.focusMs < 0) {
    throw new Error("pane focus history returned incomplete evidence");
  }
  return report;
}

async function main() {
  const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
  if (fs.realpathSync(process.env.HOME) !== path.join(root, "home")) throw new Error("pane focus QA HOME escaped isolation");
  const evidence = fs.realpathSync(process.env.DURE_QA_EVIDENCE_DIR);
  if (evidence !== path.join(root, "evidence")) throw new Error("pane focus QA evidence escaped isolation");
  const runId = process.env.VITE_DURE_PANE_FOCUS_HISTORY_QA_RUN_ID;
  if (!/^[a-f0-9-]{36}$/.test(runId ?? "")) throw new Error("missing pane focus QA run identity");
  const flag = path.join(root, "qa.autorun");
  if (fs.lstatSync(flag).isSymbolicLink() || fs.readFileSync(flag, "utf8") !== "") throw new Error("pane focus QA admission flag is not pristine");
  const nativeBinary = path.join(root, "pane-focus-keydown");
  execFileSync(process.env.DURE_QA_SWIFTC_BIN ?? "/usr/bin/swiftc", [
    path.resolve("scripts/qa/hmux-input-latency-keydown.swift"), "-o", nativeBinary,
  ], { encoding: "utf8", timeout: 60_000 });
  let nativeInputPosted = false;
  const log = resolveQaLogPath();
  let offset = fs.existsSync(log) ? fs.statSync(log).size : 0;
  let remainder = "";
  let bytesRead = 0;
  const deadline = Date.now() + 180_000;
  fs.writeFileSync(flag, `pane-focus-history:${runId}`);
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(log)) {
        const size = fs.statSync(log).size;
        if (size < offset) throw new Error("QA log was replaced during pane focus execution");
        if (size > offset) {
          if (bytesRead + size - offset > 256 * 1024) throw new Error("pane focus QA log budget exceeded");
          const handle = fs.openSync(log, "r");
          const buffer = Buffer.alloc(size - offset);
          try { offset += fs.readSync(handle, buffer, 0, buffer.length, offset); } finally { fs.closeSync(handle); }
          bytesRead += buffer.length;
          const lines = (remainder + buffer.toString("utf8")).split("\n");
          remainder = lines.pop();
          for (const line of lines) {
            const start = line.indexOf("] ");
            let payload;
            try { payload = JSON.parse(line.slice(start + 2)); } catch {}
            if (payload?.[0] === "pane-focus-activation-ready" && payload[1]?.runId === runId) {
              if (nativeInputPosted) throw new Error("activation requested a second native input");
              await armExclusiveNativeInput({ stateRoot: root,
                requestPath: process.env.DURE_QA_EXCLUSIVE_INPUT_REQUEST,
                acknowledgementPath: process.env.DURE_QA_EXCLUSIVE_INPUT_ACK });
              const descriptor = readWorkspacePerformanceDescriptor({ stateRoot: root, home: process.env.HOME,
                descriptorPath: process.env.DURE_QA_SERVER_DESCRIPTOR });
              if (!descriptor) throw new Error("isolated app descriptor unavailable");
              const observed = processMemberSnapshots([descriptor.processId]);
              const member = observed.status === "complete" ? observed.members.find((value) => value.pid === descriptor.processId) : undefined;
              const identity = parseMacosProcessIdentity(member?.processIdentity);
              const group = Number(process.env.DURE_QA_ROOT_PID);
              if (!identity || member?.state !== "live" || member.groupId !== group) throw new Error("isolated app generation unavailable");
              const nativeReceipt = JSON.parse(execFileSync(nativeBinary, [String(descriptor.processId), String(group), identity.uniqueId,
                "Dure pane focus history QA", "Dure pane focus sibling QA", process.env.HEBBIAN_QA_EXCLUSIVE_MIN_IDLE_MS ?? "15000"],
              { encoding: "utf8", timeout: 10_000 }));
              if (nativeReceipt.postedEventCount !== 2 || nativeReceipt.processId !== descriptor.processId || nativeReceipt.processGroupId !== group) throw new Error("native input receipt mismatch");
              fs.writeFileSync(path.join(evidence, "pane-focus-native-input.json"), `${JSON.stringify(nativeReceipt, null, 2)}\n`, { mode: 0o600 });
              nativeInputPosted = true;
              continue;
            }
            const report = parsePaneFocusHistoryReport(line, runId);
            if (!report) continue;
            if (!nativeInputPosted) throw new Error("native first input was never posted");
            fs.writeFileSync(path.join(evidence, "pane-focus-history.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
            console.log(`native pane focus history: PASS (${report.observations.length} observations; native first input after one activation, ${report.activation.focusMs}ms focus)`);
            return;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("timed out waiting for the exact native pane focus history run");
  } finally {
    fs.writeFileSync(flag, "");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
