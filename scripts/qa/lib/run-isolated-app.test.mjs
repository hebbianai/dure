import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const runner = join(directory, "run-isolated-app.sh");

describe("isolated QA app environment", () => {
  it.skipIf(process.platform !== "darwin")("uses the owned login profile when an outer runner supplies ZDOTDIR", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "dure-qa-shell-profile-"));
    const home = join(root, "home");
    const outer = join(root, "outer-shell");
    fs.mkdirSync(home);
    fs.mkdirSync(outer);
    fs.writeFileSync(join(home, ".zprofile"), "export DURE_QA_PROFILE_SOURCE=owned\n");
    fs.writeFileSync(join(outer, ".zprofile"), "export DURE_QA_PROFILE_SOURCE=outer\n");
    try {
      const result = execFileSync("sh", [runner, "/bin/zsh", "-l", "-c", 'printf %s "$DURE_QA_PROFILE_SOURCE"'], {
        encoding: "utf8", env: { ...process.env, HOME: home, ZDOTDIR: outer },
      });
      assert.equal(result, "owned");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes inherited backend, orchestration and exact runtime identity before child execution", () => {
    const removed = [
      "DURE_CONTROL_PLANE_BIN",
      "DURE_CLAUDE_PROCESS_RELAY_BIN",
      "DURE_BACKEND_PROFILE",
      "DURE_BACKEND_IDENTITY_FILE",
      "DURE_BACKEND_KNOWN_HOSTS_FILE",
      "DURE_BACKEND_SSH_REFERENCE_PROFILE",
      "DURE_ORCHESTRATION_ENDPOINT",
      "DURE_ORCHESTRATION_AUTHORIZATION",
      "DURE_ORCHESTRATION_PARTICIPANT",
      "DURE_ORCHESTRATION_ENDPOINT_REF",
      "DURE_ORCHESTRATION_SESSION_IDENTITY",
      "DURE_ORCHESTRATION_GENERATION",
      "DURE_ORCHESTRATION_CHECKPOINT",
      "HMUX",
      "HMUX_SESSION_ID",
      "HMUX_SESSION_NAME",
      "HMUX_WORKSPACE_ID",
      "HMUX_RUNNER_PRINCIPAL",
      "HMUX_RUNNER_INSTANCE",
      "HMUX_CHANNEL_EPOCH",
      "HMUX_HOST_INSTANCE_ID",
      "HMUX_TERMINAL_EPOCH",
      "HEBBIAN_CWD",
      "BEADS_ACTOR",
      "CODEX_SESSION_ID",
      "CODEX_THREAD_ID",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_AGENT_SDK_VERSION",
      "CODEX_HOME",
      "CODEX_SQLITE_HOME",
      "CLAUDE_CONFIG_DIR",
      "KIMI_CODE_HOME",
      "HEBBIAN_HMUX_BIN",
      "HEBBIAN_HMUX_RUNTIME",
      "HMUX_RUNTIME",
    ];
    const retained = {
      DURE_QA_APP_CHANNEL: "qa-owned",
      DURE_HOME: "/fixture/qa/dure",
      HMUX_DISCOVERY_ROOT: "/fixture/qa/discovery",
      HMUX_INSTALL_ROOT: "/fixture/qa/install",
      DURE_HMUX_BIN: "/fixture/qa/bin/hmux",
      DURE_HMUX_RUNTIME_BIN: "/fixture/qa/bin/hmux-runtime",
    };
    const keys = [...removed, ...Object.keys(retained)];
    const output = execFileSync(
      "sh",
      [
        runner,
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries(removed.map((key) => [key, "fixture-live"])),
          ...retained,
        },
      },
    );
    assert.deepEqual(JSON.parse(output), retained);
  });

  it("replaces ambient app identity and removes pane/session context", () => {
    const inherited = {
      ...process.env,
      HEBBIAN_APP_CHANNEL: "dev-daily-driver",
      VITE_DURE_APP_CHANNEL: "dev-daily-driver",
      VITE_HEBBIAN_APP_CHANNEL: "dev-daily-driver",
      HEBBIAN_DEV_HOST: "localhost",
      DURE_DEV_PORT: "1437",
      HEBBIAN_DEV_PORT: "1420",
      HEBBIAN_SESSION: "agent-live",
      HEBBIAN_AGENT: "live-agent",
      HMUX_SESSION_ID: "managed-live",
      HEBBIAN_IDE_WINDOW: "main",
      HEBBIAN_IDE_PANEL: "agent:agent-live",
    };
    const keys = [
      "DURE_APP_CHANNEL",
      "VITE_DURE_APP_CHANNEL",
      "HEBBIAN_APP_CHANNEL",
      "VITE_HEBBIAN_APP_CHANNEL",
      "HEBBIAN_DEV_HOST",
      "DURE_DEV_PORT",
      "HEBBIAN_DEV_PORT",
      "HEBBIAN_SESSION",
      "HEBBIAN_AGENT",
      "HMUX_SESSION_ID",
      "HEBBIAN_IDE_WINDOW",
      "HEBBIAN_IDE_PANEL",
    ];
    const output = execFileSync(
      "sh",
      [
        runner,
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(
          keys,
        )}.map((key) => [key, process.env[key]]))))`,
      ],
      { encoding: "utf8", env: inherited },
    );

    assert.deepEqual(JSON.parse(output), {
      DURE_APP_CHANNEL: "stable",
      VITE_DURE_APP_CHANNEL: "stable",
    });
  });

  it("binds the app and CLI to the runner-provided isolated channel", () => {
    const output = execFileSync(
      "sh",
      [
        runner,
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({ dure: process.env.DURE_APP_CHANNEL, viteDure: process.env.VITE_DURE_APP_CHANNEL, hebbian: process.env.HEBBIAN_APP_CHANNEL, viteHebbian: process.env.VITE_HEBBIAN_APP_CHANNEL }))",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, DURE_QA_APP_CHANNEL: "qa-callback-a1b2c3d4" },
      },
    );

    assert.deepEqual(JSON.parse(output), {
      dure: "qa-callback-a1b2c3d4",
      viteDure: "qa-callback-a1b2c3d4",
    });
  });
});
