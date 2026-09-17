import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runEventCanaryCommand } from "../cli/lib/orchestration-event-canary.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const cliRoot = fileURLToPath(new URL("../cli/", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const session = {
  sessionId: "session-qa",
  workspaceId: "workspace-qa",
  providerId: "provider.codex",
  runnerPrincipal: "runner-qa",
  runnerInstance: "instance-qa",
  channelEpoch: "channel-qa",
  hostInstanceId: "host-qa",
  terminalEpoch: "terminal-qa",
};
const receipt = {
  schemaVersion: 1,
  apiVersion: "dure.orchestration-event-observation/v1",
  kind: "dure.orchestration_event_observation",
  backendBuildId: "dure-control-plane/v99-fixture",
  backendGeneration: "backend-qa",
  sessionIdentity: "identity-qa",
  dispatchId: "dispatch-qa",
  generation: 1,
  after: 0,
  nextCursor: 1,
  eventCount: 1,
  deliveryStates: { queued: 1, observed: 0, acknowledged: 0 },
  observation: "events_available",
};
const envelope = (value = receipt) => ({
  schemaVersion: 1,
  apiVersion: "dure.orchestration/v1",
  method: "events.inspect.exact-session",
  receipt: structuredClone(value),
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-event-canary-"));
  roots.push(root);
  const file = path.join(root, "session.json");
  fs.writeFileSync(file, JSON.stringify(session));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "cursor.json"), "original-checkpoint");
  const environment = scriptTestEnvironment({
    HOME: home,
    DURE_HOME: path.join(home, ".dure"),
    HMUX_DISCOVERY_ROOT: path.join(home, "discovery"),
    DURE_ORCHESTRATION_CHECKPOINT: path.join(home, "cursor.json"),
  });
  const args = ["--session-file", file, "--backend", "qa", "--json"];
  return { root, file, home, environment, args };
}

describe("orchestration event canary", () => {
  it("does not bootstrap a missing backend profile from the real CLI", () => {
    const { root, args, environment, home } = fixture();
    const result = spawnSync(
      process.env.DURE_CLI_TEST_NODE || process.execPath,
      [
        path.join(cliRoot, "dure.mjs"),
        "orchestration",
        "events-canary",
        ...args,
      ],
      {
        cwd: root,
        env: { ...environment, PATH: path.join(root, "no-executables") },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      observation: "unavailable",
      error: { code: "backend_profiles_config_missing" },
    });
    expect(fs.readdirSync(home)).toEqual(["cursor.json"]);
  });

  it("aborts a stalled request within its observation budget without retry", async () => {
    const { args, environment, home } = fixture();
    let calls = 0;
    let output;
    const result = await runEventCanaryCommand(
      [...args, "--timeout-ms", "10"],
      path.join(cliRoot, "dure.mjs"),
      {
        environment,
        output: (text) => {
          output = JSON.parse(text);
        },
        request: (_endpoint, _payload, { signal }) => {
          calls++;
          return new Promise((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
          });
        },
      },
    );
    expect(result).toBe(2);
    expect(calls).toBe(1);
    expect(output.observation).toBe("unavailable");
    expect(fs.readdirSync(home)).toEqual(["cursor.json"]);
  });

  it("uses only the exact read-only method and never advances the checkpoint", async () => {
    const { args, home, environment } = fixture();
    const calls = [];
    const outputs = [];
    const status = await runEventCanaryCommand(
      args,
      path.join(cliRoot, "dure.mjs"),
      {
        environment,
        output: (text) => outputs.push(JSON.parse(text)),
        request: async (...call) => {
          calls.push(call);
          return envelope();
        },
      },
    );
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("backend-profile:qa");
    expect(calls[0][1]).toEqual({
      apiVersion: "dure.orchestration/v1",
      method: "events.inspect.exact-session",
      body: { schemaVersion: 1, session, after: 0, limit: 10 },
    });
    expect(calls[0][2].signal).toBeInstanceOf(AbortSignal);
    expect(outputs[0]).toMatchObject({
      ...receipt,
      cli: { installation: "source" },
    });
    expect(fs.readdirSync(home)).toEqual(["cursor.json"]);
    expect(fs.readFileSync(path.join(home, "cursor.json"), "utf8")).toBe(
      "original-checkpoint",
    );
  });

  it.each([
    "orchestration_method_unsupported",
    "orchestration_record_not_found",
    "orchestration_generation_conflict",
  ])("reports %s without enrolment, repair or retry", async (code) => {
    const { args, environment, home } = fixture();
    let calls = 0;
    let output;
    const status = await runEventCanaryCommand(
      args,
      path.join(cliRoot, "dure.mjs"),
      {
        environment,
        output: (text) => {
          output = JSON.parse(text);
        },
        request: async () => {
          calls++;
          throw new BackendTransportError("backend_transport_remote_error", {
            details: {
              code,
              disposition: "stale_generation",
              secret: "must-not-leak",
            },
          });
        },
      },
    );
    expect(status).toBe(2);
    expect(calls).toBe(1);
    expect(output).toMatchObject({
      observation: "unavailable",
      error: {
        code: "backend_transport_remote_error",
        reasonCode: code,
        disposition: "stale_generation",
      },
    });
    expect(JSON.stringify(output)).not.toContain("must-not-leak");
    expect(fs.readdirSync(home)).toEqual(["cursor.json"]);
  });

  it.each([
    ["--ack", "1"],
    ["--limit", "0"],
    ["--limit", "129"],
    ["--after", "-1"],
    ["--after", "9007199254740992"],
    ["--timeout-ms", "30001"],
    ["--json"],
  ])(
    "refuses invalid options %j before contacting a backend",
    async (...extra) => {
      const { args, environment } = fixture();
      let calls = 0;
      let output;
      expect(
        await runEventCanaryCommand(
          [...args, ...extra],
          path.join(cliRoot, "dure.mjs"),
          {
            environment,
            output: (text) => {
              output = JSON.parse(text);
            },
            request: async () => {
              calls++;
              return envelope();
            },
          },
        ),
      ).toBe(2);
      expect(calls).toBe(0);
      expect(output.error.code).toBe("event_canary_arguments_invalid");
    },
  );

  it.each([
    "{invalid",
    "x".repeat(16385),
    JSON.stringify({ ...session, acknowledgement: "forbidden" }),
    JSON.stringify({ ...session, hostInstanceId: "" }),
  ])("refuses malformed or oversized session files", async (source) => {
    const { args, file, environment } = fixture();
    fs.writeFileSync(file, source);
    let calls = 0;
    let output;
    expect(
      await runEventCanaryCommand(args, path.join(cliRoot, "dure.mjs"), {
        environment,
        output: (text) => {
          output = JSON.parse(text);
        },
        request: async () => {
          calls++;
          return envelope();
        },
      }),
    ).toBe(2);
    expect(calls).toBe(0);
    expect(output.error.code).toBe("event_canary_session_invalid");
  });

  it("bounds and verifies an empty cursor window without certifying lifecycle success", async () => {
    const { args, environment } = fixture();
    let output;
    expect(
      await runEventCanaryCommand(
        [...args, "--after", "1", "--limit", "1"],
        path.join(cliRoot, "dure.mjs"),
        {
          environment,
          output: (text) => {
            output = JSON.parse(text);
          },
          request: async () =>
            envelope({
              ...receipt,
              after: 1,
              nextCursor: 1,
              eventCount: 0,
              deliveryStates: { queued: 0, observed: 0, acknowledged: 0 },
              observation: "empty",
            }),
        },
      ),
    ).toBe(0);
    expect(output.observation).toBe("empty");
    expect(output).not.toHaveProperty("certification");
  });

  it.each([
    { eventCount: 129 },
    { observation: "certified" },
    { events: [{ secret: "payload-must-not-leak" }] },
    { nextCursor: 0 },
    { apiVersion: "dure.orchestration-event-observation/v2" },
  ])("rejects skewed or unsafe backend receipts", async (override) => {
    const { args, environment } = fixture();
    let output;
    expect(
      await runEventCanaryCommand(args, path.join(cliRoot, "dure.mjs"), {
        environment,
        output: (text) => {
          output = JSON.parse(text);
        },
        request: async () => envelope({ ...receipt, ...override }),
      }),
    ).toBe(2);
    expect(output.error.code).toBe("event_canary_receipt_invalid");
    expect(JSON.stringify(output)).not.toContain("payload-must-not-leak");
  });

  it.each([false, true])(
    "runs the real CLI without runtime bootstrap or checkpoint writes (packaged=%s)",
    (packaged) => {
      const { root, file, home, environment } = fixture();
      const packageRoot = packaged ? path.join(root, "package") : cliRoot;
      if (packaged) {
        fs.mkdirSync(packageRoot);
        for (const name of ["dure.mjs", "package.json", "lib"])
          fs.cpSync(path.join(cliRoot, name), path.join(packageRoot, name), {
            recursive: true,
          });
      }
      const calls = path.join(root, "requests.jsonl");
      const preload = path.join(root, "transport.cjs");
      fs.writeFileSync(
        preload,
        `
      const fs = require('node:fs');
      globalThis.fetch = async (endpoint, options) => {
        fs.appendFileSync(${JSON.stringify(calls)}, options.body + '\\n');
        return { ok: true, json: async () => (${JSON.stringify(envelope())}) };
      };
      const child = require('node:child_process');
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) child[name] = () => { throw new Error('runtime bootstrap forbidden'); };
      require('node:module').syncBuiltinESMExports();
    `,
      );
      const result = spawnSync(
        process.env.DURE_CLI_TEST_NODE || process.execPath,
        [
          "--require",
          preload,
          path.join(packageRoot, "dure.mjs"),
          "orchestration",
          "events-canary",
          "--session-file",
          file,
          "--json",
        ],
        {
          cwd: root,
          env: {
            ...environment,
            DURE_ORCHESTRATION_ENDPOINT:
              "https://fixture.invalid/orchestration",
            DURE_ORCHESTRATION_AUTHORIZATION: "Bearer fixture",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(receipt);
      expect(
        fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse),
      ).toEqual([
        {
          apiVersion: "dure.orchestration/v1",
          method: "events.inspect.exact-session",
          body: { schemaVersion: 1, session, after: 0, limit: 10 },
        },
      ]);
      expect(fs.readdirSync(home)).toEqual(["cursor.json"]);
      expect(fs.readFileSync(path.join(home, "cursor.json"), "utf8")).toBe(
        "original-checkpoint",
      );
    },
  );
});
