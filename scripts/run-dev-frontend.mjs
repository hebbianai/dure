#!/usr/bin/env node

import { createServer } from "vite";
import { resolveAppChannel } from "./lib/app-channel.mjs";
import {
  DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION,
  DEV_LAUNCH_FRONTEND_GENERATION_ENV,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  parseDevLaunchFrontendActivation,
  parseDevLaunchGeneration,
} from "./lib/dev-launch-contract.mjs";
import {
  PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
  requireProcessGroupSupport,
} from "./lib/process-group-authority.mjs";
import { spawnProcessGroupWitness } from "./lib/process-group-witness.mjs";

function parseArguments(input) {
  let check = false;
  let host;
  let port;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--host" && host === undefined) {
      host = input[(index += 1)];
      continue;
    }
    if (argument === "--port" && port === undefined) {
      const raw = input[(index += 1)];
      if (!/^[0-9]+$/.test(raw ?? "")) {
        throw new Error("dev frontend port must be an integer");
      }
      port = Number(raw);
      continue;
    }
    throw new Error(`unsupported dev frontend argument: ${argument}`);
  }
  if (
    (host !== "localhost" && host !== "127.0.0.1") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("dev frontend requires an exact loopback host and TCP port");
  }
  return { check, host, port };
}

async function main() {
  let server;
  let witness;
  let channel;
  let generation;
  try {
    const { check, host, port } = parseArguments(process.argv.slice(2));
    requireProcessGroupSupport();
    if (check) {
      server = await createServer({
        clearScreen: false,
        server: { host, port, strictPort: true },
      });
      await server.close();
      return;
    }

    if (typeof process.send !== "function") {
      throw new Error("dev frontend readiness requires supervisor IPC");
    }
    generation = parseDevLaunchGeneration(
      process.env[DEV_LAUNCH_FRONTEND_GENERATION_ENV],
      "frontend process generation",
    );
    channel = resolveAppChannel(process.env);
    witness = await spawnProcessGroupWitness();
    process.send({
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
      type: "process_group_witness_ready",
      channel,
      generation,
      pid: witness.pid,
    });
    server = await createServer({
      clearScreen: false,
      server: { host, port, strictPort: true },
    });
    let activated = false;
    let closing = false;
    const close = async (code = 0) => {
      if (closing) return;
      closing = true;
      try {
        await server.close();
      } finally {
        process.exit(code);
      }
    };
    process.once("message", async (message) => {
      try {
        parseDevLaunchFrontendActivation(message, {
          type: "frontend_activate",
          channel,
          generation,
        });
        await witness.retain();
      } catch (error) {
        await witness.retire();
        process.stderr.write(`dev frontend: ${error.message}\n`);
        void close(1);
        return;
      }
      activated = true;
      process.send(
        {
          schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
          type: "frontend_activated",
          channel,
          generation,
        },
        (error) => {
          if (error) void close(1);
        },
      );
    });
    process.once("disconnect", async () => {
      if (!activated) {
        await witness.retire();
        void close(1);
      }
    });
    await server.listen();
    process.send({
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION,
      type: "frontend_ready",
      channel,
      generation,
    });
    server.printUrls();

    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    process.once("SIGHUP", () => void close());
  } catch (error) {
    if (
      typeof process.send === "function" &&
      process.connected &&
      channel !== undefined &&
      generation !== undefined &&
      (error?.code === "EADDRINUSE" ||
        /port .* is already in use/i.test(error?.message ?? ""))
    ) {
      await new Promise((resolve) => {
        process.send(
          {
            schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
            protocolVersion: DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION,
            type: "frontend_unavailable",
            reason: "port_conflict",
            channel,
            generation,
          },
          resolve,
        );
      });
    }
    if (server) {
      try {
        await server.close();
      } catch {}
    }
    await witness?.retire();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`dev frontend: ${error.message}\n`);
  process.exit(1);
});
