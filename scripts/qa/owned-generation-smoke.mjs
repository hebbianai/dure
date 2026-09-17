import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { processMemberSnapshots, signalProcessGenerationSync } from "../lib/process-identity.mjs";
import {
  exactOwnedProcessIdentity, freezeOwnedProcessTree, terminateFrozenOwnedProcessTree,
} from "./lib/owned-process-group.mjs";
import { persistedOwnedProcessV1 } from "./lib/owned-process-persistence-v1.mjs";

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("native zombie fixture timed out");
    await setTimeout(20);
  }
}

export async function runOwnedGenerationSmoke() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dure-native-zombie-"));
  const owned = spawn("python3", [fileURLToPath(
    new URL("./fixtures/owned-zombie-child.py", import.meta.url),
  )], { cwd: root, detached: true, stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  let closed = false;
  let startupError;
  owned.stdout.setEncoding("utf8");
  owned.stdout.on("data", (chunk) => { output += chunk; });
  owned.on("error", (error) => { startupError = error; });
  owned.on("close", () => { closed = true; });
  let leader;
  try {
    await waitFor(() => {
      if (startupError) throw startupError;
      return output.includes("\n");
    });
    const pids = JSON.parse(output.trim());
    assert.equal(pids.leader, owned.pid);
    const initial = processMemberSnapshots([pids.leader, pids.child, process.pid]);
    assert.equal(initial.status, "complete");
    leader = persistedOwnedProcessV1(initial.members.find(({ pid }) => pid === pids.leader));
    const child = persistedOwnedProcessV1(initial.members.find(({ pid }) => pid === pids.child));
    const supervisor = persistedOwnedProcessV1(initial.members.find(({ pid }) => pid === process.pid));
    owned.stdin.end("exit\n");
    let childState;
    await waitFor(() => {
      const observation = processMemberSnapshots([child.pid]);
      assert.equal(observation.status, "complete");
      childState = observation.members[0]?.state ?? "absent";
      return childState === "zombie" || childState === "absent";
    });
    if (process.platform === "linux") assert.equal(childState, "zombie");

    const descriptor = {
      descriptorPath: join(root, "group.json"),
      groupId: leader.groupId,
      leaderKernelStartMarker: leader.kernelStartMarker,
      leaderPid: leader.pid,
      leaderStartMarker: leader.startMarker,
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: supervisor.kernelStartMarker,
      supervisorPid: supervisor.pid,
      supervisorStartMarker: supervisor.startMarker,
      terminateDetachedOwnedGenerations: false,
    };
    const frozen = await freezeOwnedProcessTree(descriptor, {
      readLedger: () => [leader, child],
    });
    assert.deepEqual(frozen.processes.map(({ pid }) => pid), [leader.pid, child.pid].sort((a, b) => a - b));
    await terminateFrozenOwnedProcessTree(descriptor, frozen);
    await waitFor(() => closed);
    assert.equal(owned.signalCode, "SIGKILL");
    return { schemaVersion: 1, platform: process.platform, childState, cleanup: "verified" };
  } finally {
    if (leader && !closed) {
      signalProcessGenerationSync(exactOwnedProcessIdentity(leader), "SIGKILL");
    }
    if (!closed) owned.stdin.end();
    await waitFor(() => closed);
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runOwnedGenerationSmoke()));
}
