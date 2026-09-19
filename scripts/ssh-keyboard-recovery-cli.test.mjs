// SPDX-License-Identifier: GPL-3.0-only

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const enableKeyboard = "\x1b[>3u";
const resetKeyboard = "\x1b[<999u\x1b[=0u";

describe("system SSH keyboard recovery", () => {
  it.each([
    { code: 0, stdinTty: true, stdoutTty: true, reset: true },
    { code: 255, stdinTty: true, stdoutTty: true, reset: true },
    { code: 255, stdinTty: false, stdoutTty: true, reset: false },
    { code: 255, stdinTty: true, stdoutTty: false, reset: false },
    { code: 0, stdinTty: false, stdoutTty: false, reset: false },
    { code: 255, stdinTty: true, stdoutTty: true, reset: false, closedTty: true },
    ...(process.platform === "win32" ? [] : [
      { signal: "SIGTERM", stdinTty: true, stdoutTty: true, reset: true },
    ]),
  ])("restores the interactive shell only after SSH exits: %j", async (testCase) => {
    const root = mkdtempSync(join(tmpdir(), "dure-ssh-keyboard-"));
    try {
      const hook = join(root, "ssh-hook.mjs");
      const exit = testCase.signal
        ? `process.kill(process.pid, ${JSON.stringify(testCase.signal)})`
        : `process.exit(${testCase.code})`;
      const peer = `process.stdout.write(${JSON.stringify(enableKeyboard)});
setTimeout(() => { process.stdout.write("SSH_EXIT"); ${exit}; }, 20);`;
      // Substitute only the SSH executable at the OS boundary. The CLI still
      // waits for a real child, inherits its output, and propagates its status.
      writeFileSync(hook, `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
Object.defineProperty(process.stdin, "isTTY", { value: ${testCase.stdinTty} });
Object.defineProperty(process.stdout, "isTTY", { value: ${testCase.stdoutTty} });
${testCase.closedTty ? 'fs.writeSync = () => { throw new Error("fixture closed terminal"); };' : ""}
cp.spawn = (command, argv, options) => {
  if (command !== "/usr/bin/ssh") throw new Error("unexpected process");
  return spawn(process.execPath, ["-e", ${JSON.stringify(peer)}], options);
};
syncBuiltinESMExports();
`);
      const result = await new Promise((resolveResult) => {
        execFile(process.execPath, ["--import", hook, resolve("cli/dure.mjs"), "__ssh", "-i", "fixture-key", "fixture.invalid"], {
          cwd: root,
          timeout: 5_000,
          env: { PATH: process.env.PATH, HOME: root, DURE_HOME: root },
        }, (error, stdout, stderr) => resolveResult({ error, stdout, stderr }));
      });
      if (testCase.signal) {
        expect(result.error?.signal).toBe(testCase.signal);
      } else {
        expect(result.error?.code ?? 0).toBe(testCase.code);
      }
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${enableKeyboard}SSH_EXIT${testCase.reset ? resetKeyboard : ""}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
