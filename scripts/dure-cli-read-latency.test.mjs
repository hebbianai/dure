import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hmuxSession, writeRegistry } from "./lib/dure-session-test-fixture.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(mode) {
  const root = mkdtempSync(join(tmpdir(), "dure-read-latency-"));
  temporaryRoots.push(root);
  const appRoot = join(root, "app-home");
  const binRoot = join(root, "bin");
  const callsPath = join(root, "hmux-calls.jsonl");
  const activePath = join(root, "hmux-read-active");
  const overlapPath = join(root, "hmux-read-overlap");
  const hmuxPath = join(binRoot, "hmux");
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeRegistry(appRoot, [
    {
      id: "agent-managed",
      name: "managed-agent",
      project: "Dure",
      provider: "codex",
      sessionId: "session-managed",
      kind: "pty",
      runtimeBinding: {
        runtime: "hmux_managed_v1",
        source: "local",
        hostId: "local",
        sessionId: "session-managed",
        workspaceId: "workspace-managed",
      },
    },
  ]);
  writeFileSync(
    hmuxPath,
    `#!/usr/bin/env node
const { appendFileSync, closeSync, openSync, unlinkSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.DURE_READ_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "read" || (args[0] === "--json" && args[1] === "session" && args[2] === "show")) {
  if (process.env.DURE_READ_MODE === "delayed-success") {
    setTimeout(() => process.stdout.write("managed screen\\n"), 2800);
  } else if (process.env.DURE_READ_MODE === "native-deadline") {
    process.stderr.write("hmux: error: hmux_read_deadline_exceeded: stage=snapshot deadlineMs=2500\\n");
    process.exit(2);
  } else if (process.env.DURE_READ_MODE === "stall-read") {
    setTimeout(() => process.exit(4), 8000);
    setInterval(() => {}, 1000);
  } else if (process.env.DURE_READ_MODE === "failed-read") {
    process.stderr.write("managed read rejected\\n");
    process.exit(2);
  } else if (process.env.DURE_READ_MODE === "slow-follow") {
    let descriptor;
    try {
      descriptor = openSync(process.env.DURE_READ_ACTIVE, "wx");
    } catch {
      writeFileSync(process.env.DURE_READ_OVERLAP, "overlap");
      process.exit(5);
    }
    setTimeout(() => {
      closeSync(descriptor);
      unlinkSync(process.env.DURE_READ_ACTIVE);
      process.stdout.write(args[0] === "read" ? "managed frame\\n" : JSON.stringify(${JSON.stringify(hmuxSession(1, {
        session_id: "session-managed", workspace_id: "workspace-managed",
        providerConversationIdentity: null,
        agentRuntimeState: {
          terminal_epoch: "terminal-1", revision: "1", observed_through_output_seq: "12",
          lifecycle: "running", activity: "working", attention: "none", attention_id: null,
          source: "provider_event", turn_completed_count: "0",
        },
      }))}) + "\\n");
    }, 900);
  } else {
    process.stdout.write("managed screen\\n");
  }
} else if (args[0] === "capabilities") {
  setTimeout(() => process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    cliVersion: "0.1.4",
    capabilities: ["managed_screen_read_v1"],
  })), 2500);
} else if (args[0] === "--version") {
  setTimeout(() => process.stdout.write("hmux 0.1.4\\n"), 2500);
} else {
  process.stderr.write("unexpected hmux arguments: " + JSON.stringify(args));
  process.exitCode = 2;
}
`,
  );
  chmodSync(hmuxPath, 0o755);
  return {
    callsPath,
    environment: {
      ...process.env,
      DURE_APP_CHANNEL: "stable",
      DURE_HOME: appRoot,
      DURE_HMUX_BIN: hmuxPath,
      DURE_READ_CALLS: callsPath,
      DURE_READ_ACTIVE: activePath,
      DURE_READ_MODE: mode,
      DURE_READ_OVERLAP: overlapPath,
      HOME: root,
    },
    overlapPath,
  };
}

function runRead(environment, target = "managed-agent", options = []) {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [cliPath, "read", target, ...options],
    {
      encoding: "utf8",
      env: environment,
      timeout: 12_000,
    },
  );
  return { ...result, elapsedMs: Date.now() - startedAt };
}

function calls(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readCalls(path) {
  try {
    return calls(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

describe("dure managed read latency", () => {
  it("honors the caller's read deadline instead of killing a healthy delayed read at 2500ms", () => {
    const { environment } = fixture("delayed-success");
    const result = runRead(environment, "managed-agent", ["--deadline-ms", "4000"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("managed screen\n");
  }, 10000);

  it("preserves a native deadline phase without starting compatibility probes", () => {
    const { environment, callsPath } = fixture("native-deadline");
    const result = runRead(environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stage=snapshot");
    expect(calls(callsPath).map((argv) => argv[0])).toEqual(["read"]);
  });

  it("passes an explicit workspace and deadline for an unregistered session", () => {
    const { environment, callsPath } = fixture("direct-session");
    const result = runRead(environment, "session-external", ["--workspace", "workspace-external", "--deadline-ms", "900"]);
    expect(result.status, result.stderr).toBe(0);
    const args = calls(callsPath)[0];
    expect(args[args.indexOf("--workspace") + 1]).toBe("workspace-external");
    expect(args[args.indexOf("--deadline-ms") + 1]).toBe("900");
  });

  it.each(["0", "10001", "NaN", "1.5"])("rejects invalid deadline %s before spawning a reader", (deadline) => {
    const { callsPath, environment } = fixture("direct-session");
    const result = runRead(environment, "managed-agent", ["--deadline-ms", deadline]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--deadline-ms must be an integer");
    expect(existsSync(callsPath)).toBe(false);
  });

  it("does not redirect a selected Agent to a different workspace", () => {
    const { callsPath, environment } = fixture("direct-session");
    const result = runRead(environment, "managed-agent", ["--workspace", "workspace-other"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--workspace does not match");
    expect(existsSync(callsPath)).toBe(false);
  });

  it("reads an exact general Hmux session without an Agent registration", () => {
    const { callsPath, environment } = fixture("direct-session");
    unlinkSync(join(environment.DURE_HOME, "agents.json"));

    const result = runRead(environment, "term-WoXCR2g1", ["-n", "30"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("managed screen\n");
    expect(calls(callsPath)).toEqual([
      ["read", "term-WoXCR2g1", "--lines", "30", "--deadline-ms", "2500"],
    ]);
  });

  it(
    "uses a successful exact read without waiting for compatibility preflight",
    () => {
      const { callsPath, environment } = fixture("slow-preflight");

      const result = runRead(environment);

      expect(result.status, result.stderr).toBe(0);
      expect(result.elapsedMs).toBeLessThan(1_500);
      expect(result.stdout).toBe("managed screen\n");
      expect(calls(callsPath)).toEqual([
        [
          "read",
          "session-managed",
          "--workspace",
          "workspace-managed",
          "--lines",
          "20",
          "--deadline-ms",
          "2500",
        ],
      ]);
    },
    15_000,
  );

  it(
    "reaps a wedged read process after the native budget and settlement grace",
    () => {
      const { environment } = fixture("stall-read");

      const result = runRead(environment);

      expect(result.status).not.toBe(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(3_500);
      expect(result.elapsedMs).toBeLessThan(4_500);
      expect(result.stderr).toContain("timed out");
      expect(result.stderr).toContain("stage=process_watchdog");
    },
    15_000,
  );

  it(
    "bounds compatibility diagnostics after an actual read failure",
    () => {
      const { callsPath, environment } = fixture("failed-read");

      const result = runRead(environment);

      expect(result.status).not.toBe(0);
      expect(result.elapsedMs).toBeLessThan(4_000);
      expect(result.stderr).toContain("managed read rejected");
      expect(result.stderr).toContain("capability probe timed out");
      expect(calls(callsPath).map((argv) => argv[0]).sort()).toEqual([
        "--version",
        "capabilities",
        "read",
      ]);
    },
    15_000,
  );

  it("keeps a missing Hmux binary actionable", () => {
    const { environment } = fixture("missing-binary");
    environment.DURE_HMUX_BIN = join(environment.HOME, "missing-hmux");

    const result = runRead(environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain("pnpm hmux:install");
  });

  it.each([
    {
      args: ["read", "managed-agent", "--follow"],
      command: "read --follow",
      observationPrefix: ["read"],
      interruptedCode: 0,
    },
    {
      args: ["wait", "managed-agent", "--timeout", "10"],
      command: "wait",
      observationPrefix: ["--json", "session", "show"],
      interruptedCode: 130,
    },
  ])(
    "keeps $command observations sequential and stops observing on Ctrl-C",
    async ({ args, observationPrefix, interruptedCode }) => {
      const { callsPath, environment, overlapPath } = fixture("slow-follow");
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closed = new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });

      const isObservation = (argv) => observationPrefix.every((part, index) => argv[index] === part);
      try {
        await waitFor(
          () => readCalls(callsPath).filter(isObservation).length >= 2,
          "two sequential observations",
        );
        expect(readCalls(callsPath).every(isObservation)).toBe(true);
        expect(existsSync(overlapPath)).toBe(false);

        const interruptedAt = Date.now();
        child.kill("SIGINT");
        const outcome = await closed;

        expect(outcome, stderr).toEqual({ code: interruptedCode, signal: null });
        expect(Date.now() - interruptedAt).toBeLessThan(1_000);
        expect(existsSync(overlapPath)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGINT");
          await closed;
        }
      }
    },
    15_000,
  );
});
