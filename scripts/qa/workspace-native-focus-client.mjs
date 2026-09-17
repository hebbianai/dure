import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMacosProcessIdentity, processMemberSnapshots } from "../lib/process-identity.mjs";
import { armExclusiveNativeInput } from "./lib/exclusive-native-input.mjs";
import { readWorkspacePerformanceDescriptor } from "./lib/workspace-performance-descriptor.mjs";
import { nativeWorkspacePerformanceScenario } from "./lib/workspace-performance-native.mjs";
import { readWorkspacePerformanceProviderFixture } from "./lib/workspace-performance-provider-fixture.mjs";

export function assertNativePaneFocusEvidence(report, expected, posts) {
  const samples = report?.qaStatus?.nativeFocus?.samples;
  if (report?.qaStatus?.state !== "complete" || !Array.isArray(samples) || samples.length !== expected || posts !== expected) {
    throw new Error("native pane focus evidence is incomplete");
  }
  for (const sample of samples) {
    if (sample.pointerDowns !== 1 || sample.keyDowns !== 1 || sample.inputEvents !== 1 || sample.text !== "x" ||
        sample.trusted !== true || !Number.isFinite(sample.focusMs) || sample.focusMs < 0 ||
        !Number.isFinite(sample.inputMs) || sample.inputMs < sample.focusMs ||
        sample.focusedAfterInput !== true || typeof sample.surfaceId !== "string" || !sample.surfaceId ||
        sample.trace?.terminalId !== sample.surfaceId ||
        sample.trace?.source !== "keydown" || sample.trace?.outcome !== "complete" ||
        !Number.isFinite(sample.trace.hostReceiptMs) || sample.trace.hostReceiptMs < 0 ||
        !Number.isFinite(sample.trace.echoPaintMs) || sample.trace.echoPaintMs < sample.trace.hostReceiptMs) {
      throw new Error("native pane focus requires one trusted click and first key with Host receipt and paint");
    }
  }
  return samples;
}

export async function readNativePaneFocusReport(response) {
  const receipt = await response.json();
  if (!response.ok || receipt.ok !== true) {
    throw new Error(`perf report returned ${response.status}: ${receipt.error?.code ?? "unknown"}: ${receipt.error?.message ?? "report unavailable"}`, {
      cause: { status: response.status, receipt },
    });
  }
  return { ...receipt.report, qaStatus: receipt.qaStatus };
}

export function writeNativePaneFocusEvidence(directory, value) {
  fs.writeFileSync(path.join(directory, "last-status.json"), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
  const evidence = fs.realpathSync(process.env.DURE_QA_EVIDENCE_DIR);
  if (fs.realpathSync(process.env.HOME) !== path.join(root, "home") || evidence !== path.join(root, "evidence")) throw new Error("native focus QA isolation is incomplete");
  const scenarioId = process.env.DURE_QA_PERFORMANCE_SCENARIO;
  const expected = nativeWorkspacePerformanceScenario(scenarioId).focusInputSamples;
  const binary = path.join(root, "native-pane-focus-input");
  execFileSync(process.env.DURE_QA_SWIFTC_BIN ?? "/usr/bin/swiftc", [path.resolve("scripts/qa/hmux-input-latency-keydown.swift"), "-o", binary], { timeout: 60_000 });
  const posts = [];
  let admitted = false;
  let report;
  let failure;
  let appGeneration;
  const deadline = Date.now() + 180_000;
  const save = () => writeNativePaneFocusEvidence(evidence, { posts, report, failure });
  try {
    while (Date.now() < deadline) {
      const descriptor = readWorkspacePerformanceDescriptor({ stateRoot: root, home: process.env.HOME, descriptorPath: process.env.DURE_QA_SERVER_DESCRIPTOR });
      if (descriptor) {
        const observedGeneration = `${descriptor.processId}:${descriptor.generation}`;
        if (!descriptor.generation || (appGeneration && appGeneration !== observedGeneration)) throw new Error("native focus app generation changed");
        appGeneration = observedGeneration;
        const response = await fetch(`http://127.0.0.1:${descriptor.port}/perf/report`, {
          method: "POST", headers: { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" },
          body: "{}", signal: AbortSignal.timeout(20_000),
        });
        report = await readNativePaneFocusReport(response);
        save();
        if (report.qaStatus?.state === "failed") throw new Error(`native focus workload failed: ${report.qaStatus.error}`);
        if (report.qaStatus?.state === "complete") {
          if (!readWorkspacePerformanceProviderFixture(root, scenarioId).ready) throw new Error("native focus fake-provider fixture incomplete");
          const samples = assertNativePaneFocusEvidence(report, expected, posts.length);
          console.log(`native pane click-to-first-input: PASS ${JSON.stringify(samples)}`);
          return;
        }
        const target = report.qaStatus?.nativeFocus?.target;
        if (target && target.ordinal > posts.length) {
          if (target.ordinal !== posts.length + 1 || !Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error("native click target sequence invalid");
          if (!admitted) {
            await armExclusiveNativeInput({ stateRoot: root, requestPath: process.env.DURE_QA_EXCLUSIVE_INPUT_REQUEST, acknowledgementPath: process.env.DURE_QA_EXCLUSIVE_INPUT_ACK });
            admitted = true;
          }
          const observed = processMemberSnapshots([descriptor.processId]);
          const member = observed.status === "complete" ? observed.members.find((value) => value.pid === descriptor.processId) : undefined;
          const identity = parseMacosProcessIdentity(member?.processIdentity);
          const group = Number(process.env.DURE_QA_ROOT_PID);
          if (!identity || member?.state !== "live" || member.groupId !== group) throw new Error("isolated app generation unavailable");
          const post = JSON.parse(execFileSync(binary, [String(descriptor.processId), String(group), identity.uniqueId,
            process.env.DURE_QA_WINDOW_TITLE, "", process.env.HEBBIAN_QA_EXCLUSIVE_MIN_IDLE_MS ?? "15000", String(target.x), String(target.y)], { encoding: "utf8", timeout: 10_000 }));
          if (post.postedEventCount !== 4 || post.postedClickCount !== 1 || post.processId !== descriptor.processId || post.processGroupId !== group) throw new Error("native click input receipt mismatch");
          posts.push({ ordinal: target.ordinal, ...post });
          save();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("native pane focus timed out");
  } catch (error) {
    failure = { message: String(error), response: error.cause };
    throw error;
  } finally { save(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
