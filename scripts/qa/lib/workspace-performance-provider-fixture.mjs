import fs from "node:fs";
import path from "node:path";
import { nativeWorkspacePerformanceScenario } from "./workspace-performance-native.mjs";
import { workspacePerformanceProviderForCell } from "./workspace-performance-providers.mjs";

export function expectedWorkspacePerformanceProviderSessions(
  scenarioId = "baseline_15",
) {
  const scenario = nativeWorkspacePerformanceScenario(scenarioId);
  const sessions = [];
  for (let desktop = 1; desktop <= scenario.desktopCount; desktop += 1) {
    for (let pane = 1; pane <= scenario.panesPerDesktop; pane += 1) {
      const provider = workspacePerformanceProviderForCell(desktop, pane).id;
      sessions.push({
        provider,
        sessionId: `dure-perf-${provider}-d${desktop}-p${pane}`,
      });
    }
  }
  return sessions;
}

export function readWorkspacePerformanceProviderFixture(
  stateRoot,
  scenarioId = "baseline_15",
) {
  const root = path.resolve(stateRoot);
  const receiptRoot = path.join(root, "provider-capture", "provider-sessions");
  const expected = expectedWorkspacePerformanceProviderSessions(scenarioId);
  const missing = [];
  const invalid = [];
  const observed = [];

  for (const session of expected) {
    const receipt = path.join(receiptRoot, `${session.sessionId}.json`);
    let value;
    try {
      const metadata = fs.lstatSync(receipt);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        invalid.push(`${session.sessionId}: receipt is not a regular file`);
        continue;
      }
      if ((metadata.mode & 0o077) !== 0) {
        invalid.push(`${session.sessionId}: receipt is not owner-only`);
        continue;
      }
      value = JSON.parse(fs.readFileSync(receipt, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        missing.push(session.sessionId);
        continue;
      }
      invalid.push(`${session.sessionId}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (
      value?.schema !== 1 ||
      value?.provider !== session.provider ||
      value?.sessionId !== session.sessionId
    ) {
      invalid.push(`${session.sessionId}: identity mismatch`);
      continue;
    }
    observed.push(session);
  }

  return {
    ready: missing.length === 0 && invalid.length === 0,
    expected: expected.length,
    observed: observed.length,
    missing,
    invalid,
  };
}
