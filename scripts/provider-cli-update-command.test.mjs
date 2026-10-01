import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProviderCliUpdatePlan } from "../src/lib/agents/providerCliChannels.ts";

const exec = promisify(execFile);
const guardianRoot = process.env.DURE_HMUX_TEST_STATE_ROOT;

describe.skipIf(process.platform === "win32")("standalone update shell environment", () => {
  let root;
  let accountHome;
  let installHome;
  let executable;
  beforeEach(async () => {
    root = await mkdtemp(join(guardianRoot ?? tmpdir(), "codex-update-shell-"));
    accountHome = join(root, "accounts", "work");
    // These are literal path characters, never shell substitutions.
    installHome = join(root, "Codex user's `$HOME` $(touch injected)", ".codex");
    executable = join(installHome, "packages/standalone/releases/0.157.1-target/bin/codex");
    await mkdir(dirname(executable), { recursive: true });
    await mkdir(accountHome, { recursive: true });
    await writeFile(join(accountHome, "config.toml"), "# account settings stay unchanged\n");
    await writeFile(executable, [
      "#!/bin/sh",
      'printf "%s\\n" "$CODEX_HOME" "$@"',
      'exit "${FIXTURE_UPDATE_EXIT:-0}"',
      "",
    ].join("\n"), { mode: 0o755 });
  });
  afterEach(async () => {
    if (root && !guardianRoot) await rm(root, { recursive: true, force: true });
  });

  it.each([0, 53])("uses the install home only for the updater and preserves exit %s", async (exitCode) => {
    const plan = buildProviderCliUpdatePlan({
      provider: "codex",
      preflight: { resolvedPath: executable, symlinkChain: [] },
      npmGlobalPrefix: null,
      platform: process.platform === "darwin" ? "macos" : "linux",
    });
    expect(plan?.channel).toBe("codex-standalone");
    let result;
    try {
      result = { ...(await exec("/bin/sh", ["-c", [
        plan.command,
        "_dure_update_exit=$?",
        'printf "%s\\n" "$CODEX_HOME"',
        'exit "$_dure_update_exit"',
      ].join("\n")], {
        cwd: root,
        env: {
          HOME: root,
          DURE_HOME: join(root, ".dure"),
          HMUX_DISCOVERY_ROOT: join(root, "discovery"),
          CODEX_HOME: accountHome,
          PATH: "/usr/bin:/bin",
          FIXTURE_UPDATE_EXIT: String(exitCode),
        },
        timeout: 5_000,
      })), code: 0 };
    } catch (error) {
      if (typeof error.code !== "number" || error.killed) throw error;
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    expect(result).toEqual({
      code: exitCode,
      stdout: `${installHome}\nupdate\n${accountHome}\n`,
      stderr: "",
    });
    expect(await readFile(join(accountHome, "config.toml"), "utf8"))
      .toBe("# account settings stay unchanged\n");
    await expect(readFile(join(root, "injected")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
