#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import { resolveAppChannel } from "./lib/app-channel.mjs";
import {
  DEV_LAUNCH_CHILD_GENERATION_ENV,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  parseDevLaunchChildActivation,
  parseDevLaunchGeneration,
} from "./lib/dev-launch-contract.mjs";
import { requireDevLaunchAdmission } from "./lib/dev-launch-admission.mjs";
import {
  PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
} from "./lib/process-group-authority.mjs";
import { spawnProcessGroupWitness } from "./lib/process-group-witness.mjs";

function resolveExecutable(command) {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`development app executable is unavailable: ${command}`);
}

function parseCommand(serialized) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`invalid development app command JSON: ${error.message}`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    !Array.isArray(value.args) ||
    value.args.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("invalid development app command");
  }
  return {
    executable: resolveExecutable(value.command),
    args: value.args,
  };
}

async function main() {
  if (process.argv[2] === "--check") {
    await requireDevLaunchAdmission();
    return;
  }
  if (typeof process.send !== "function" || !process.channel) {
    throw new Error("development app activation requires an IPC authority");
  }
  const generation = parseDevLaunchGeneration(
    process.env[DEV_LAUNCH_CHILD_GENERATION_ENV],
    "app candidate generation",
  );
  const channel = resolveAppChannel(process.env);
  const command = parseCommand(process.argv[2]);
  const witness = await spawnProcessGroupWitness();
  let activating = false;
  process.once("message", async (message) => {
    try {
      parseDevLaunchChildActivation(message, {
        channel,
        generation,
      });
      activating = true;
      await witness.retain();
      if (process.platform === "win32") {
        const child = spawn(command.executable, command.args, { stdio: "inherit", env: process.env });
        child.once("exit", (code) => process.exit(code ?? 1));
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        process.disconnect();
        return;
      }
      process.execve(
        command.executable,
        [command.executable, ...command.args],
        process.env,
      );
    } catch {
      activating = false;
      await witness.retire();
      process.send(
        {
          schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
          type: "launch_activation_failed",
          channel,
          generation,
        },
        () => process.exit(1),
      );
    }
  });
  process.once("disconnect", async () => {
    if (!activating) {
      await witness.retire();
      process.exit(1);
    }
  });
  process.send({
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
    type: "process_group_witness_ready",
    channel,
    generation,
    pid: witness.pid,
  });
  process.send({
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type: "launch_candidate_ready",
    channel,
    generation,
  });
}

main().catch((error) => {
  process.stderr.write(`app:dev child: ${error.message}\n`);
  process.exit(1);
});
