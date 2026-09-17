#!/usr/bin/env node

import { observeProcessGroupId, observeProcessMembers } from "./lib/process-identity.mjs";
import {
  PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
  processGroupWitnessCanRetire,
  requireProcessGroupSupport,
} from "./lib/process-group-authority.mjs";

function parseGroupId(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error("process group witness requires an exact group id");
  }
  const groupId = Number(value);
  if (!Number.isSafeInteger(groupId)) {
    throw new Error("process group witness id is out of range");
  }
  return groupId;
}

async function main() {
  requireProcessGroupSupport();
  if (typeof process.send !== "function" || !process.channel) {
    throw new Error("process group witness requires an IPC owner");
  }
  const groupId = parseGroupId(process.argv[2]);
  if (await observeProcessGroupId(process.pid) !== groupId) {
    throw new Error("process group witness joined an unexpected group");
  }

  let retained = false;
  let retiring = false;
  let keepalive;
  const observeRetirement = async () => {
    if (!retiring) return;
    try {
      const members = await observeProcessMembers({
        kind: "group_census",
        groupId,
      });
      if (processGroupWitnessCanRetire(members, {
        groupId,
        witnessPid: process.pid,
      })) {
        process.exit(0);
      }
    } catch {
      // A later complete census is the only authority that may retire us.
    }
    setTimeout(() => void observeRetirement(), 100);
  };
  const retire = () => {
    if (retiring) return;
    retiring = true;
    if (keepalive) clearInterval(keepalive);
    void observeRetirement();
  };

  process.on("message", (message) => {
    if (
      retained &&
      message?.protocolVersion === PROCESS_GROUP_WITNESS_PROTOCOL_VERSION &&
      message.type === "process_group_witness_retire" &&
      message.groupId === groupId
    ) {
      process.send({
        protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
        type: "process_group_witness_retiring",
        groupId,
      });
      retire();
      return;
    }
    if (
      retained ||
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      message.protocolVersion !== PROCESS_GROUP_WITNESS_PROTOCOL_VERSION ||
      message.type !== "process_group_witness_retain" ||
      message.groupId !== groupId
    ) {
      retire();
      return;
    }
    retained = true;
    keepalive = setInterval(() => {}, 1_000);
    process.send({
      protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
      type: "process_group_witness_retained",
      groupId,
    });
  });
  process.once("disconnect", retire);
  process.once("SIGINT", retire);
  process.once("SIGTERM", retire);
  process.once("SIGHUP", retire);
  process.send({
    protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
    type: "process_group_witness_ready",
    groupId,
    pid: process.pid,
  });
}

try {
  await main();
} catch (error) {
  process.stderr.write(`process group witness: ${error.message}\n`);
  process.exitCode = 1;
}
