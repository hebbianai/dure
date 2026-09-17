import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerInstallCommand,
  providerInstallExecutionCommand,
} from "../src/lib/agents/providerInstallCommand.ts";
import * as i18n from "../src/lib/i18n.ts";
import { hmuxTestBinaries } from "./run-hmux-tests.mjs";

const exec = promisify(execFile);
const guide = "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/";
const windows = process.platform === "win32";
const platform = windows ? "windows" : "linux";
const guardianRoot = process.env.DURE_HMUX_TEST_STATE_ROOT;
const downloadFailures = ["claude", "codex", "kimi", "hermes"].flatMap((provider) => [
  { provider, state: "failed download", script: "", downloadExit: 22, exitCode: 22, output: "download-failed" },
  {
    provider,
    state: "partial download",
    script: 'printf "partial-installer-ran\\n"\nprintf "partial-installer-ran\\n" > "$HOME/partial-installer-ran"\n',
    downloadExit: 28,
    exitCode: 28,
    output: "download-failed",
  },
]);
const scriptData = 'script data: "$HOME" `printf injected` $(printf injected) %s';
const kimiLauncherScript = [
  '/bin/mkdir -p "${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin"',
  `printf '%s\\n' '#!/bin/sh' 'printf "native-kimi:%s\\n" "$*"' 'printf "verified\\n" >> "$HOME/kimi-verifications"' 'exit "\${FIXTURE_KIMI_LAUNCH_EXIT:-0}"' > "\${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin/kimi"`,
  '/bin/chmod +x "${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin/kimi"',
].join("\n");
const kimiInstallations = [
  { state: "native installed", fixture: {}, exitCode: 0, output: "native-kimi:--version", verified: true },
  { state: "custom directory installed", fixture: { customDirectory: true }, exitCode: 0, output: "native-kimi:--version", verified: true },
  { state: "empty directory override", fixture: { emptyDirectory: true }, exitCode: 0, output: "native-kimi:--version", verified: true },
  { state: "native launcher missing", fixture: { launcher: false }, exitCode: 127, output: ".kimi-code/bin/kimi", verified: false },
  { state: "custom launcher missing", fixture: { customDirectory: true, launcher: false }, exitCode: 127, output: "bin/kimi", verified: false },
  { state: "native launcher not executable", fixture: { executable: false }, exitCode: 126, output: ".kimi-code/bin/kimi", verified: false },
  { state: "native launcher failed", fixture: { launcherExit: 71 }, exitCode: 71, output: "native-installer", verified: true },
  { state: "installer failed before verification", fixture: { installExit: 53 }, exitCode: 53, output: "native-installer", verified: false },
].map((entry) => ({ ...entry, provider: "kimi" }));
const hermesLauncherScript = [
  '_fixture_hermes_launcher="${FIXTURE_HERMES_LAUNCHER:-$HOME/.local/bin/hermes}"',
  '/bin/mkdir -p "${_fixture_hermes_launcher%/*}"',
  `printf '%s\\n' '#!/bin/sh' 'printf "native-hermes:%s\\n" "$*"' 'printf "verified\\n" >> "$HOME/hermes-verifications"' 'exit "\${FIXTURE_HERMES_LAUNCH_EXIT:-0}"' > "$_fixture_hermes_launcher"`,
  '/bin/chmod +x "$_fixture_hermes_launcher"',
].join("\n");
const hermesInstallations = [
  { state: "Linux user", fixture: {}, target: "user" },
  { state: "macOS root", fixture: { os: "Darwin", uid: 0 }, target: "user" },
  { state: "Linux root FHS", fixture: { uid: 0 }, target: "system" },
  { state: "Linux root empty override", fixture: { uid: 0, installDirectory: "" }, target: "system" },
  { state: "Linux root explicit code directory", fixture: { uid: 0, installDirectory: "custom code" }, target: "user" },
  { state: "Linux root legacy", fixture: { uid: 0, legacy: true }, target: "user" },
  { state: "Linux root legacy custom data", fixture: { uid: 0, legacy: true, dataDirectory: "custom data" }, target: "user" },
  { state: "Linux root custom data without legacy", fixture: { uid: 0, dataDirectory: "custom data" }, target: "system" },
  { state: "Termux prefix", fixture: { uid: 0, prefix: "com.termux/files/usr" }, target: "prefix" },
  { state: "Termux version custom prefix", fixture: { uid: 0, termux: true, prefix: 'Hermes\'s "$HOME" $(printf injected) `printf injected`' }, target: "prefix" },
  { state: "Termux version without prefix", fixture: { uid: 0, termux: true }, target: "user" },
  { state: "missing user launcher", fixture: { launcher: false }, target: "user", exitCode: 127 },
  { state: "missing FHS launcher", fixture: { uid: 0, launcher: false }, target: "system", exitCode: 127 },
  { state: "non-executable launcher", fixture: { executable: false }, target: "user", exitCode: 126 },
  { state: "launcher failed", fixture: { launcherExit: 71 }, target: "user", exitCode: 71, verified: true },
  { state: "installer failed", fixture: { installExit: 53 }, target: "user", exitCode: 53 },
  { state: "OS lookup failed", fixture: { osExit: 17 }, target: "user", exitCode: 17 },
  { state: "UID lookup failed", fixture: { uidExit: 19 }, target: "user", exitCode: 19 },
].map((entry) => ({
  provider: "hermes",
  exitCode: 0,
  verified: entry.exitCode === undefined,
  output: entry.exitCode === undefined ? "native-hermes:--version" : "hermes-installer",
  ...entry,
}));
const scriptInstallations = [
  ["codex", "sh", "https://chatgpt.com/codex/install.sh"],
  ["kimi", "bash", "https://code.kimi.com/kimi-code/install.sh"],
  ["hermes", "bash", "https://hermes-agent.nousresearch.com/install.sh"],
].flatMap(([provider, interpreter, url]) => [0, 53].map((exitCode) => ({
  provider,
  state: exitCode === 0 ? "script installed" : "script failed",
  script: `printf 'interpreter:%s\\n' "$0"\nprintf '%s\\n' '${scriptData}'\n${exitCode === 0 ? ({ kimi: kimiLauncherScript, hermes: hermesLauncherScript }[provider] ?? "") : ""}\nexit ${exitCode}\n`,
  environment: provider === "hermes" ? { HERMES_INSTALL_DIR: "fixture-hermes-code" } : {},
  verificationOutput: exitCode === 0 && provider !== "codex" ? `native-${provider}:--version\n` : "",
  exitCode,
  output: `interpreter:${interpreter}`,
  url,
})));

describe("provider installer shell behavior", () => {
  let root;
  let shell;
  let environment;
  beforeEach(async () => {
    i18n.setLang("en");
    root = await mkdtemp(join(guardianRoot ?? tmpdir(), "dure-npm-install-"));
    if (windows) {
      const system = join(process.env.SystemRoot, "System32");
      shell = join(system, "cmd.exe");
      environment = {
        SystemRoot: process.env.SystemRoot,
        ComSpec: shell,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        PATH: [root, system, join(system, "WindowsPowerShell", "v1.0")].join(";"),
        USERPROFILE: root,
        TEMP: root,
        TMP: root,
      };
    } else {
      shell = "/bin/sh";
      environment = { HOME: root, PATH: root };
      await symlink("/bin/sh", join(root, "sh"));
      await symlink("/bin/sleep", join(root, "sleep"));
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // The Hmux guardian owns process reconciliation and root retirement.
    if (!guardianRoot) await rm(root, { recursive: true, force: true });
  });

  async function tool(name, { output, exitCode = 0, args = false } = {}) {
    const body = windows
      ? `@echo off\r\n${output ? `echo ${output}>&2\r\n` : ""}${args ? "echo npm-args:%*\r\n" : ""}exit /B ${exitCode}\r\n`
      : `#!/bin/sh\n${output ? `printf '%s\\n' '${output}' >&2\n` : ""}${args ? 'printf "npm-args:%s\\n" "$*"\n' : ""}exit ${exitCode}\n`;
    await writeFile(join(root, `${name}${windows ? ".cmd" : ""}`), body, { mode: 0o755 });
  }

  async function run(provider, targetPlatform = platform) {
    const command = providerInstallExecutionCommand(
      provider,
      providerInstallCommand(provider, targetPlatform),
      targetPlatform,
    );
    const options = {
      cwd: root,
      env: environment,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      windowsVerbatimArguments: windows,
    };
    let result;
    try {
      result = { ...(await exec(shell, windows ? ["/D", "/Q", "/C", command] : ["-c", command], options)), code: 0 };
    } catch (error) {
      if (typeof error.code !== "number" || error.killed) throw error;
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    return { ...result, stdout: result.stdout.replaceAll("\r\n", "\n"), stderr: result.stderr.replaceAll("\r\n", "\n") };
  }

  async function downloadedScriptFixture(script, downloadExit = 0) {
    await writeFile(join(root, "installer-fixture.sh"), script);
    await writeFile(join(root, "curl"), [
      "#!/bin/sh",
      'printf "download-attempt\\n" >> "$HOME/download-attempts"',
      'printf "%s\\n" "$@" > "$HOME/download-arguments"',
      '/bin/cat "$HOME/installer-fixture.sh"',
      ...(downloadExit ? ['printf "download-failed\\n" >&2'] : []),
      `exit ${downloadExit}`,
    ].join("\n"), { mode: 0o755 });
  }

  it.skipIf(windows).each(downloadFailures)("rejects $provider $state without executing its script", async ({ provider, script, exitCode }) => {
    if (provider !== "codex") await symlink("/bin/bash", join(root, "bash"));
    await downloadedScriptFixture(script, exitCode);
    const result = await run(provider);
    expect(result).toEqual({ code: exitCode, stdout: "", stderr: "download-failed\n" });
    expect(await readFile(join(root, "download-attempts"), "utf8")).toBe("download-attempt\n");
    await expect(readFile(join(root, "partial-installer-ran"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(windows).each(["claude", "codex", "kimi", "hermes"])(
    "rejects %s installation when curl is unavailable",
    async (provider) => {
      if (provider !== "codex") await symlink("/bin/bash", join(root, "bash"));
      const result = await run(provider);
      expect(result.code).toBe(127);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("curl");
    },
  );

  async function nativeClaudeFixture({ downloadExit = 0, installExit = 0, launcher = true } = {}) {
    await symlink("/bin/bash", join(root, "bash"));
    const installer = [
      'printf "native-installer\\n"',
      ...(launcher && installExit === 0 ? [
        '/bin/mkdir -p "$HOME/.local/bin"',
        `printf '%s\\n' '#!/bin/sh' 'printf "native-claude:%s\\n" "$*"' > "$HOME/.local/bin/claude"`,
        '/bin/chmod +x "$HOME/.local/bin/claude"',
      ] : []),
      `exit ${installExit}`,
    ].join("\n");
    await downloadedScriptFixture(downloadExit ? "" : installer, downloadExit);
  }

  async function nativeKimiFixture({ customDirectory = false, emptyDirectory = false, launcher = true, executable = true, installExit = 0, launcherExit = 0 }) {
    await symlink("/bin/bash", join(root, "bash"));
    environment.KIMI_CODE_HOME = join(root, "conversation data");
    environment.FIXTURE_KIMI_LAUNCH_EXIT = String(launcherExit);
    if (customDirectory) environment.KIMI_INSTALL_DIR = join(root, 'Kimi\'s "$HOME" $(printf injected) `printf injected`');
    if (emptyDirectory) environment.KIMI_INSTALL_DIR = "";
    await tool("kimi", { output: "stale-path-kimi" });
    const staleDirectories = [environment.KIMI_CODE_HOME];
    if (customDirectory) staleDirectories.push(join(root, ".kimi-code"));
    for (const directory of staleDirectories) {
      await mkdir(join(directory, "bin"), { recursive: true });
      await writeFile(join(directory, "bin/kimi"), '#!/bin/sh\nprintf "stale-kimi\\n"\n', { mode: 0o755 });
    }
    // Even a failed installer can leave a usable launcher. Its failure still wins.
    await downloadedScriptFixture([
      'printf "native-installer\\n"',
      ...(launcher ? [kimiLauncherScript] : []),
      ...(launcher && !executable ? ['/bin/chmod -x "${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin/kimi"'] : []),
      `exit ${installExit}`,
    ].join("\n"));
  }

  async function expectNativeVerification(provider, verified) {
    if (verified) {
      expect(await readFile(join(root, `${provider}-verifications`), "utf8")).toBe("verified\n");
    } else {
      await expect(readFile(join(root, `${provider}-verifications`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  }

  it.skipIf(windows).each(kimiInstallations.flatMap((entry) => ["macos", "linux"].map((targetPlatform) => ({ ...entry, targetPlatform }))))(
    "verifies Kimi $state on $targetPlatform at its installed launcher",
    async ({ fixture, exitCode, output, verified, targetPlatform }) => {
      await nativeKimiFixture(fixture);
      const result = await run("kimi", targetPlatform);
      expect(result.code).toBe(exitCode);
      expect(result.stdout + result.stderr).toContain(output);
      expect(result.stdout + result.stderr).not.toContain("stale-");
      await expectNativeVerification("kimi", verified);
      expect(await readFile(join(root, "download-attempts"), "utf8")).toBe("download-attempt\n");
    },
  );

  async function nativeHermesFixture({ os = "Linux", uid = 1000, installDirectory, dataDirectory, prefix, termux = false, legacy = false, launcher = true, executable = true, installExit = 0, launcherExit = 0, osExit = 0, uidExit = 0 }, target) {
    await symlink("/bin/bash", join(root, "bash"));
    await writeFile(join(root, "uname"), `#!/bin/sh\nprintf '%s\\n' '${os}'\nexit ${osExit}\n`, { mode: 0o755 });
    await writeFile(join(root, "id"), `#!/bin/sh\nprintf '%s\\n' '${uid}'\nexit ${uidExit}\n`, { mode: 0o755 });
    if (installDirectory !== undefined) environment.HERMES_INSTALL_DIR = installDirectory ? join(root, installDirectory) : "";
    if (dataDirectory) environment.HERMES_HOME = join(root, dataDirectory);
    if (prefix) environment.PREFIX = join(root, prefix);
    if (termux) environment.TERMUX_VERSION = "fixture";
    const data = environment.HERMES_HOME ?? join(root, ".hermes");
    if (legacy) await mkdir(join(data, "hermes-agent/.git"), { recursive: true });
    const launchers = {
      user: join(root, ".local/bin/hermes"),
      system: join(root, "system/bin/hermes"),
      prefix: join(environment.PREFIX ?? root, "bin/hermes"),
    };
    environment.FIXTURE_HERMES_LAUNCHER = launchers[target];
    environment.FIXTURE_HERMES_LAUNCH_EXIT = String(launcherExit);
    await tool("hermes", { output: "stale-path-hermes" });
    const staleLaunchers = new Set([...Object.values(launchers), join(data, "bin/hermes"), join(environment.HERMES_INSTALL_DIR || root, "bin/hermes")]);
    staleLaunchers.delete(launchers[target]);
    for (const stale of staleLaunchers) {
      await mkdir(join(stale, ".."), { recursive: true });
      await writeFile(stale, '#!/bin/sh\nprintf "stale-hermes\\n"\n', { mode: 0o755 });
    }
    // Intercept the absolute FHS command before entering POSIX mode. Tests must
    // never touch or execute a real system-wide Hermes installation.
    const shim = join(root, "shell-shim");
    await mkdir(shim);
    await writeFile(join(shim, "sh"), [
      "#!/bin/bash",
      'function /usr/local/bin/hermes { "$HOME/system/bin/hermes" "$@"; }',
      "set -o posix",
      '[ "$#" = 2 ] && [ "$1" = -c ] || exit 64',
      'eval "$2"',
    ].join("\n"), { mode: 0o755 });
    environment.PATH = `${shim}:${root}`;
    await downloadedScriptFixture([
      'printf "hermes-installer\\n"',
      ...(launcher ? [hermesLauncherScript] : []),
      ...(launcher && !executable ? ['/bin/chmod -x "$FIXTURE_HERMES_LAUNCHER"'] : []),
      `exit ${installExit}`,
    ].join("\n"));
  }

  it.skipIf(windows).each(hermesInstallations)("verifies Hermes $state using its designated $target launcher", async ({ fixture, target, exitCode, output, verified }) => {
    await nativeHermesFixture(fixture, target);
    const result = await run("hermes", fixture.os === "Darwin" ? "macos" : "linux");
    expect(result.code).toBe(exitCode);
    expect(result.stdout + result.stderr).toContain(output);
    expect(result.stdout + result.stderr).not.toContain("stale-");
    await expectNativeVerification("hermes", verified);
    expect(await readFile(join(root, "download-attempts"), "utf8")).toBe("download-attempt\n");
  });

  it.skipIf(windows)("installs native Claude without Node.js or npm and verifies the native launcher outside PATH", async () => {
    await nativeClaudeFixture();
    expect(await run("claude")).toEqual({
      code: 0,
      stdout: "native-installer\nnative-claude:--version\n",
      stderr: "",
    });
  });

  it.skipIf(windows).each([
    [{ downloadExit: 22 }, 22, "download-failed"],
    [{ installExit: 53 }, 53, "native-installer"],
    [{ launcher: false }, 127, ".local/bin/claude"],
  ])("preserves native Claude failure %# without closing it as successful", async (fixture, code, output) => {
    await nativeClaudeFixture(fixture);
    const result = await run("claude");
    expect(result.code).toBe(code);
    expect(result.stdout + result.stderr).toContain(output);
    expect(result.stdout).not.toContain("native-claude:--version");
  });

  it.each([
    ["node", "gemini"],
    ["npm", "gemini"],
    ["both", "pi"],
    ["both", "qwen-code"],
  ])("explains missing %s without running the %s installer", async (missing, provider) => {
    if (missing !== "node" && missing !== "both") await tool("node");
    if (missing !== "npm" && missing !== "both") {
      await tool("npm", { output: "installer-ran" });
    }
    const result = await run(provider);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("Node.js");
    expect(result.stderr).toContain(guide);
    expect(result.stderr).not.toContain("installer-ran");
  });

  it("runs a later explicit install once after npm becomes available", async () => {
    await tool("node");
    const missing = await run("pi");
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain(guide);
    await tool("npm", { args: true });
    const installed = await run("pi");
    expect(installed).toEqual({
      code: 0,
      stdout: "npm-args:install -g @earendil-works/pi-coding-agent\n",
      stderr: "",
    });
  });

  it("preserves npm failures without misreporting a missing prerequisite or retrying", async () => {
    await tool("node");
    await tool("npm", { output: "registry-unavailable", exitCode: 53 });
    expect(await run("gemini")).toEqual({
      code: 53,
      stdout: "",
      stderr: "registry-unavailable\n",
    });
  });

  it.skipIf(windows).each(scriptInstallations)("preserves $provider $state interpreter, data and status without adding prerequisites", async ({ provider, script, exitCode, output, url, environment: overrides, verificationOutput }) => {
    Object.assign(environment, overrides);
    if (provider !== "codex") await symlink("/bin/bash", join(root, "bash"));
    await downloadedScriptFixture(script);
    expect(await run(provider)).toEqual({
      code: exitCode,
      stdout: `${output}\n${scriptData}\n${verificationOutput}`,
      stderr: "",
    });
    expect(await readFile(join(root, "download-attempts"), "utf8")).toBe("download-attempt\n");
    expect(await readFile(join(root, "download-arguments"), "utf8")).toBe(`-fsSL\n${url}\n`);
  });

  it("prints localized guidance as data, including quotes and shell metacharacters", async () => {
    const message = `未安装 npm — l'outil "$PATH" %PATH% !PATH! & | $(printf injected) \`printf injected\``;
    vi.spyOn(i18n, "t").mockReturnValue(message);
    expect(await run("qwen-code")).toEqual({
      code: 127,
      stdout: "",
      stderr: `${message}\n`,
    });
  });

  it.skipIf(!guardianRoot || windows).each([
    { provider: "pi", state: "missing", exitCode: 127, output: "Node.js" },
    { provider: "pi", state: "installed", exitCode: 0, output: "npm-args:install -g @earendil-works/pi-coding-agent" },
    { provider: "pi", state: "failed", exitCode: 53, output: "registry-unavailable" },
    { provider: "claude", state: "installed", fixture: {}, exitCode: 0, output: "native-claude:--version" },
    { provider: "claude", state: "download failed", fixture: { downloadExit: 22 }, exitCode: 22, output: "download-failed" },
    { provider: "claude", state: "installer failed", fixture: { installExit: 53 }, exitCode: 53, output: "native-installer" },
    { provider: "claude", state: "launcher missing", fixture: { launcher: false }, exitCode: 127, output: ".local/bin/claude" },
    ...downloadFailures,
    ...scriptInstallations,
    ...kimiInstallations,
    ...hermesInstallations,
  ])("retains $provider $state output and exit code through the actual Host", async ({ provider, state, fixture, target, script, downloadExit = 0, exitCode, output, verified, environment: overrides }) => {
    const { hmuxCli, hmuxRuntime } = hmuxTestBinaries(process.env);
    const discovery = join(root, "discovery");
    Object.assign(environment, overrides);
    if (script !== undefined) {
      if (provider !== "codex") await symlink("/bin/bash", join(root, "bash"));
      await downloadedScriptFixture(script, downloadExit);
    } else if (provider === "claude") {
      await nativeClaudeFixture(fixture);
    } else if (provider === "kimi") {
      await nativeKimiFixture(fixture);
    } else if (provider === "hermes") {
      await nativeHermesFixture(fixture, target);
    } else if (state !== "missing") {
      await tool("node");
      await tool("npm", state === "installed" ? { args: true } : { output, exitCode });
    }
    const command = providerInstallExecutionCommand(provider, providerInstallCommand(provider, platform), platform);
    const cli = (args) => exec(hmuxCli, ["--discovery-root", discovery, "--json", ...args], {
      cwd: root,
      env: { ...environment, TMPDIR: process.env.TMPDIR, HMUX_DISCOVERY_ROOT: discovery },
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const created = JSON.parse((await cli(["new", "--runtime", hmuxRuntime, "--", "/bin/sh", "-c", command])).stdout);
    const workspaces = (await readdir(discovery)).filter((name) => name.startsWith("w_"));
    expect(workspaces).toHaveLength(1);
    const workspace = join(discovery, workspaces[0]);
    const sessions = (await readdir(workspace)).filter((name) => name.startsWith("s_"));
    expect(sessions).toHaveLength(1);
    let visibleText = "";
    await vi.waitFor(async () => {
      const manifest = JSON.parse(await readFile(join(workspace, sessions[0], "manifest.json"), "utf8"));
      if (!visibleText.includes(output) && manifest.lifecycle !== "exited") {
        const visible = JSON.parse((await cli(["read", created.sessionId, "--workspace", created.workspaceId])).stdout);
        // Screen rows may wrap a launcher path. Verification output can arrive
        // after the installer's first frame, within the same command lifetime.
        visibleText = visible.lines.join("");
      }
      expect(manifest.lifecycle).toBe("exited");
      expect(manifest.manifest.tombstone.exit.exit_code).toBe(exitCode);
      expect(visibleText).toContain(output);
    }, { timeout: 5_000, interval: 50 });
    if ((provider === "kimi" || provider === "hermes") && fixture) {
      await expectNativeVerification(provider, verified);
      expect(await readFile(join(root, "download-attempts"), "utf8")).toBe("download-attempt\n");
    }
    if (script !== undefined) {
      expect(await readFile(join(root, "download-attempts"), "utf8")).toBe("download-attempt\n");
      await expect(readFile(join(root, "partial-installer-ran"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
