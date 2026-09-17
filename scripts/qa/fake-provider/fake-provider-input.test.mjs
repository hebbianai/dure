import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(fixtureRoot, "probe-immediate-input.py");

function waitForOutput(state, marker, timeoutMs) {
  if (state.output.includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.listeners.delete(onOutput);
      reject(new Error(`timed out waiting for ${JSON.stringify(marker)}`));
    }, timeoutMs);
    const onOutput = () => {
      if (!state.output.includes(marker)) return;
      clearTimeout(timeout);
      state.listeners.delete(onOutput);
      resolve();
    };
    state.listeners.add(onOutput);
  });
}

async function captureCompleteInputLines(provider) {
  const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dure-fake-input-"));
  const sessionId = `capture-${provider}`;
  const child = spawn(path.join(fixtureRoot, provider), [], {
    env: {
      ...process.env,
      DURE_QA_CAPTURE_DIR: captureRoot,
      HEBBIAN_QA_CAPTURE_DIR: "",
      HEBBIAN_SESSION: "",
      HMUX_SESSION_ID: sessionId,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end("first line\nsecond line\n");
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (status !== 0) throw new Error(`${provider} exited ${status}: ${stderr}`);
    const inputRoot = path.join(captureRoot, "provider-inputs", sessionId);
    const names = fs.readdirSync(inputRoot).sort();
    return names.map((name) => fs.readFileSync(path.join(inputRoot, name), "utf8"));
  } finally {
    fs.rmSync(captureRoot, { recursive: true, force: true });
  }
}

async function observeImmediateCharacterEcho(provider) {
  const child = spawn("python3", [probe, path.join(fixtureRoot, provider)], {
    env: {
      ...process.env,
      DURE_QA_CAPTURE_DIR: "",
      HEBBIAN_QA_CAPTURE_DIR: "",
      HEBBIAN_SESSION: "",
      HMUX_SESSION_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = { output: "", listeners: new Set() };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.output += chunk;
    for (const listener of state.listeners) listener();
  });
  try {
    // Process startup is not the behavior under test and can contend with a
    // parallel Rust build. Keep the post-prompt character-paint SLO strict.
    await waitForOutput(state, "> ", 6_000);
    await waitForOutput(state, "> ~", 300);
    return state.output;
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

describe("workspace performance fake provider input", () => {
  test.each(["claude", "codex"])(
    "%s paints one character before line submission",
    async (provider) => {
      await expect(observeImmediateCharacterEcho(provider)).resolves.toContain(
        "> ~",
      );
    },
  );

  test.each(["claude", "codex"])(
    "%s records each complete submitted line once",
    async (provider) => {
      await expect(captureCompleteInputLines(provider)).resolves.toEqual([
        "first line",
        "second line",
      ]);
    },
  );
});
