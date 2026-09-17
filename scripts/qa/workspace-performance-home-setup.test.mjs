import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "workspace-performance-home-setup.mjs",
);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe("workspace performance isolated home setup", () => {
  test("installs fake providers without modifying product launch policy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-perf-home-"));
    roots.push(root);
    const home = path.join(root, "home");
    const capture = path.join(root, "provider-capture");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(capture, { mode: 0o700 });

    const setup = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, DURE_QA_STATE_ROOT: root, HOME: home },
    });
    expect(setup.status, setup.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, ".zprofile"), "utf8")).toBe(
      'PATH="$HOME/.local/bin:$PATH"\nexport PATH\n',
    );
    // A Dure terminal exports ZDOTDIR (command bridge); if it leaks into the
    // fixture shell, zsh reads the bridge dotfiles instead of the fixture
    // HOME's .zprofile and the .local/bin prepend never happens.
    const { ZDOTDIR: _bridgeZdotdir, ...ambientEnvironment } = process.env;
    const loginShell = spawnSync(
      "/bin/zsh",
      ["-lc", "command -v claude; command -v codex"],
      { encoding: "utf8", env: { ...ambientEnvironment, HOME: home } },
    );
    expect(loginShell.status, loginShell.stderr).toBe(0);
    expect(loginShell.stdout.trim().split("\n")).toEqual([
      path.join(home, ".local", "bin", "claude"),
      path.join(home, ".local", "bin", "codex"),
    ]);

    for (const provider of ["claude", "codex"]) {
      const sessionId = `dure-perf-${provider}-d1-p1`;
      const invoked = spawnSync(path.join(home, ".local", "bin", provider), [], {
        encoding: "utf8",
        input: "ok\n",
        timeout: 5_000,
        env: {
          ...process.env,
          DURE_QA_CAPTURE_DIR: capture,
          HMUX_SESSION_ID: sessionId,
          HOME: home,
        },
      });
      expect(invoked.status, invoked.stderr).toBe(0);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(capture, "provider-sessions", `${sessionId}.json`),
            "utf8",
          ),
        ),
      ).toEqual({ schema: 1, provider, sessionId });
    }
  });
});
