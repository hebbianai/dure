import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_LAUNCH_CHILD_GENERATION_ENV, DEV_LAUNCH_FRONTEND_GENERATION_ENV,
  DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION, DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  parseDevLaunchFrontendActivation,
} from "../../lib/dev-launch-contract.mjs";
import { observeProcessMembers } from "../../lib/process-identity.mjs";
import { spawnProcessGroupWitness } from "../../lib/process-group-witness.mjs";
import { PROCESS_GROUP_WITNESS_PROTOCOL_VERSION } from "../../lib/process-group-authority.mjs";

const [role, root] = process.argv.slice(2);
const fixture = fileURLToPath(import.meta.url);
const releasePath = join(root, "release");
const treePath = join(root, role === "preparation" ? "preparation-tree.json" :
  role === "frontend" ? "frontend-tree.json" : "tree.json");
const channel = "dev-tree-fixture";

function hold() {
  // Cooperative cleanup and a final deadline belong to this fixture only.
  setInterval(() => {
    if (existsSync(releasePath)) process.exit(0);
  }, 20);
  setTimeout(() => process.exit(70), 90_000);
}

async function childTree(childRole) {
  const child = spawn(process.execPath, [fixture, childRole, root], {
    // Windows background workers must not rely on libuv's direct-child Job cleanup.
    detached: process.platform === "win32",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("fixture child exited before readiness")));
  });
}

async function observe(pids) {
  const observation = await observeProcessMembers({ kind: "point", pids });
  assert.equal(observation.status, "complete");
  return observation.members;
}

async function main() {
  if (role === "supervisor") {
    const { superviseDevLaunch } = await import(process.argv[4] ?? "../../lib/dev-launch-supervisor.mjs");
    const spawnOptions = { cwd: root, env: process.env, stdio: "inherit" };
    const outcome = await superviseDevLaunch({
      home: root,
      worktreeRoot: root,
      channel,
      command: process.execPath,
      args: [fixture, "app", root],
      spawnOptions,
      prepareLaunch: {
        command: process.execPath, args: [fixture, "preparation", root], spawnOptions, timeoutMs: 20_000,
      },
      frontend: {
        command: process.execPath, args: [fixture, "frontend", root],
        spawnOptions: { ...spawnOptions, stdio: ["ignore", "inherit", "inherit", "ipc"] },
        probe: (identity) => readFileSync(join(root, "frontend-active"), "utf8") === identity.generation,
      },
    });
    process.exitCode = outcome.code ?? 0;
    return;
  }
  const witness = role === "frontend" ? await spawnProcessGroupWitness() : null;
  const members = await observe([process.pid]);
  assert.equal(members.length, 1);
  writeFileSync(join(root, `member-${process.pid}.json`), JSON.stringify(members[0]));
  if (existsSync(releasePath)) return;
  if (role === "leaf") {
    hold();
    process.send([process.pid]);
    return;
  }
  if (role === "branch") {
    hold();
    process.send([process.pid, ...await childTree("leaf")]);
    return;
  }
  assert.ok(["app", "legacy", "frontend", "preparation"].includes(role));
  hold();
  let predecessor;
  try {
    predecessor = JSON.parse(readFileSync(treePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (predecessor) {
    const current = await observe(predecessor.members.map(({ pid }) => pid));
    const overlap = current.filter((member) => member.state !== "zombie" &&
      predecessor.members.some((old) => old.processIdentity === member.processIdentity));
    assert.deepEqual(overlap, [], "successor started while predecessor descendants were live");
  }
  if (role === "app") {
    const preparation = JSON.parse(readFileSync(join(root, "preparation-tree.json"), "utf8"));
    const live = await observe(preparation.members.map(({ pid }) => pid));
    assert.deepEqual(live.filter((member) => member.state !== "zombie" &&
      preparation.members.some((old) => old.processIdentity === member.processIdentity)), [],
    "application started while prerequisite descendants were live");
  }
  const pids = [process.pid, ...await childTree("branch")];
  const treeMembers = await observe(pids);
  assert.equal(treeMembers.length, 3);
  writeFileSync(treePath, JSON.stringify({
    generation: role === "legacy" ? "legacy" : process.env[
      role === "frontend" ? DEV_LAUNCH_FRONTEND_GENERATION_ENV : DEV_LAUNCH_CHILD_GENERATION_ENV],
    members: treeMembers,
    predecessorRetired: Boolean(predecessor),
  }));
  if (role === "preparation") process.exit(0);
  if (role === "frontend") {
    const generation = process.env[DEV_LAUNCH_FRONTEND_GENERATION_ENV];
    let activated = false;
    process.once("message", async (message) => {
      parseDevLaunchFrontendActivation(message, { type: "frontend_activate", channel, generation });
      await witness.retain();
      activated = true;
      writeFileSync(join(root, "frontend-active"), generation);
      process.send({ schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION, type: "frontend_activated", channel, generation });
    });
    process.once("disconnect", async () => {
      if (!activated) { await witness.retire(); process.exit(1); }
    });
    process.send({ schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION, type: "process_group_witness_ready",
      channel, generation, pid: witness.pid });
    process.send({ schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION, type: "frontend_ready", channel, generation });
  }
  if (role === "legacy") {
    setInterval(() => {
      if (existsSync(join(root, "exit-leader"))) process.exit(0);
    }, 20);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
