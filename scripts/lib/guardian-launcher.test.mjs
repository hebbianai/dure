import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  launchDetachedGuardian,
  SIGNAL_EXIT_CODES,
  waitForChild,
} from "./guardian-launcher.mjs";

const temporaryDirectories = [];
const signalListenerSnapshots = new Map();

function temporaryDirectory() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "guardian-launcher-test."),
  );
  temporaryDirectories.push(root);
  return root;
}

function writeGuardianFixture(root, source) {
  const fixture = path.join(root, "guardian-fixture.mjs");
  fs.writeFileSync(fixture, source);
  return pathToFileURL(fixture);
}

beforeEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    signalListenerSnapshots.set(signal, new Set(process.listeners(signal)));
  }
});

afterEach(() => {
  // The launcher intentionally leaves its forwarding listeners installed for
  // the lifetime of a CLI process; detach the ones added during each test so
  // they cannot leak across the suite.
  for (const [signal, snapshot] of signalListenerSnapshots) {
    for (const listener of process.listeners(signal)) {
      if (!snapshot.has(listener)) process.removeListener(signal, listener);
    }
  }
  signalListenerSnapshots.clear();
  for (const root of temporaryDirectories.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("guardian launcher", () => {
  test("maps forwarded termination signals to shell-conventional codes", () => {
    expect(SIGNAL_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143 });
  });

  test("waitForChild resolves with the child's close code and signal", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await expect(waitForChild(child)).resolves.toEqual({
      code: 7,
      signal: null,
    });
  });

  test("waitForChild rejects when the child cannot be spawned", async () => {
    const child = spawn(path.join(temporaryDirectory(), "missing-binary"), {
      stdio: "ignore",
    });
    await expect(waitForChild(child)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("re-invokes the script as a guardian and returns its exit code", async () => {
    const root = temporaryDirectory();
    const capture = path.join(root, "guardian-argv.json");
    const scriptUrl = writeGuardianFixture(
      root,
      'import fs from "node:fs";\n' +
        "fs.writeFileSync(process.env.GUARDIAN_CAPTURE, JSON.stringify({\n" +
        "  argv: process.argv.slice(2),\n" +
        "  gitDir: process.env.GIT_DIR ?? null,\n" +
        "}));\n" +
        "process.exit(23);\n",
    );
    const previousCapture = process.env.GUARDIAN_CAPTURE;
    const previousGitDir = process.env.GIT_DIR;
    process.env.GUARDIAN_CAPTURE = capture;
    process.env.GIT_DIR = path.join(root, "not-a-repository/.git");
    try {
      const status = await launchDetachedGuardian({
        command: ["cargo", "test", "--locked"],
        guardianArgument: "--internal-fixture-guardian-v1",
        scriptUrl,
      });
      expect(status).toBe(23);
      expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
        argv: ["--internal-fixture-guardian-v1", "--", "cargo", "test", "--locked"],
        // Repository-local Git pointers must not leak into the guardian.
        gitDir: null,
      });
    } finally {
      if (previousCapture === undefined) delete process.env.GUARDIAN_CAPTURE;
      else process.env.GUARDIAN_CAPTURE = previousCapture;
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  test("a signal-terminated guardian maps to its conventional exit code", async () => {
    const root = temporaryDirectory();
    const scriptUrl = writeGuardianFixture(
      root,
      'process.kill(process.pid, "SIGTERM");\n' +
        "setInterval(() => {}, 1_000);\n",
    );
    const status = await launchDetachedGuardian({
      command: ["ignored"],
      guardianArgument: "--internal-fixture-guardian-v1",
      scriptUrl,
    });
    expect(status).toBe(143);
  });

  test("passes prepared runtime paths to the guardian without leaking Git pointers", async () => {
    const root = temporaryDirectory();
    const capture = path.join(root, "environment.json");
    const scriptUrl = writeGuardianFixture(root,
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  runtime: process.env.DURE_QA_HMUX_RUNTIME,
  gitDir: process.env.GIT_DIR ?? null,
}));`,
    );
    const environment = {
      ...process.env,
      DURE_QA_HMUX_RUNTIME: path.join(root, "prepared-runtime"),
      GIT_DIR: path.join(root, "wrong-git"),
    };
    expect(await launchDetachedGuardian({
      command: ["fixture"], guardianArgument: "--guardian", scriptUrl, environment,
    })).toBe(0);
    expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
      runtime: environment.DURE_QA_HMUX_RUNTIME, gitDir: null,
    });
    expect(environment.GIT_DIR).toBe(path.join(root, "wrong-git"));
  });
});
