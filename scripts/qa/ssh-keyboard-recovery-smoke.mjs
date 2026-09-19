// SPDX-License-Identifier: GPL-3.0-only
// Run through scripts/run-hmux-tests.mjs with DURE_QA_HMUX_BIN and
// DURE_QA_HMUX_RUNTIME pointing to prepared native Hmux executables.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const stateRoot = process.env.DURE_HMUX_TEST_STATE_ROOT;
const discoveryRoot = process.env.HMUX_DISCOVERY_ROOT;
assert(stateRoot && discoveryRoot, "run through scripts/run-hmux-tests.mjs");
assert.equal(discoveryRoot, path.join(stateRoot, "hmux-discovery"));
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const root = path.join(stateRoot, "ssh-keyboard");
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const environment = {
  HOME: home,
  DURE_HOME: path.join(home, ".dure"),
  HMUX_DISCOVERY_ROOT: discoveryRoot,
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  TERM: "xterm-256color",
  PS1: "QA_PROMPT> ",
  TMPDIR: root,
};
const sourceCli = fileURLToPath(new URL("../../cli/dure.mjs", import.meta.url));
const hook = path.join(root, "ssh-hook.mjs");
const capturedKey = path.join(root, "ssh-key.hex");
// The native PTY and Hmux input encoder are real. Replace the network child
// with a peer that enables Kitty mode and exits without restoring it.
const peer = `
import { writeFileSync } from "node:fs";
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[>3uSSH_KEYBOARD_READY\\r\\n");
process.stdin.once("data", (bytes) => {
  writeFileSync(${JSON.stringify(capturedKey)}, bytes.toString("hex"));
  process.stdin.setRawMode(false);
  process.exit(Number(process.argv[1]));
});
`;
fs.writeFileSync(hook, `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = (command, argv, options) => {
  if (command !== "/usr/bin/ssh") throw new Error("unexpected process");
  return spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(peer)}, argv.at(-1)], options);
};
syncBuiltinESMExports();
`);
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const command = async (args) => {
  const { stdout } = await execute(cli, ["--json", ...args], {
    cwd: root, env: environment, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
};
async function waitFor(observe, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`missing ${label}`);
}

const shells = [
  { name: "bash", executable: "/bin/bash", arguments: ["--noprofile", "--norc", "-i"] },
  ...(fs.existsSync("/bin/zsh") ? [{ name: "zsh", executable: "/bin/zsh", arguments: ["-f", "-i"] }] : []),
];
for (const { shell, code } of shells.flatMap((shell) => [255, 0].map((code) => ({ shell, code })))) {
  let session;
  try {
    const name = `ssh-keyboard-${shell.name}-${code}`;
    await command(["new", "--name", name, "--runtime", runtime,
      "--", shell.executable, ...shell.arguments]);
    [session] = (await command(["ls"])).filter((entry) => entry.session_name === name);
    assert(session);
    const exact = ["--target", session.session_id, "--workspace", session.workspace_id];
    const screen = async () => (await command(["read", session.session_id,
      "--workspace", session.workspace_id, "-n", "5"])).lines.join("\n").trimEnd();
    await waitFor(async () => (await screen()).endsWith("QA_PROMPT>"), "shell prompt");
    const launch = [process.execPath, "--import", hook, sourceCli,
      "__ssh", "-i", "fixture-key", "fixture.invalid", String(code)].map(quote).join(" ");
    const shellSetup = path.join(root, "shell-setup");
    fs.writeFileSync(shellSetup, `HISTSIZE=1000\nssh_fixture() { ${launch}; result=$?; printf '\\nSSH_EXIT:%s\\n' "$result"; }\nprintf 'SHELL_SETUP_READY\\n'\n`);
    await command(["command-input", ...exact, "--text", `source ${quote(shellSetup)}`, "--submit"]);
    await waitFor(async () => {
      const text = await screen();
      return text.includes("SHELL_SETUP_READY") && text.endsWith("QA_PROMPT>");
    }, "shell fixture setup");
    await command(["command-input", ...exact, "--text", "ssh_fixture", "--submit"]);
    await waitFor(async () => (await screen()).includes("SSH_KEYBOARD_READY"), "SSH keyboard mode");
    await command(["command-input", ...exact, "--key", "Up"]);
    await waitFor(() => fs.existsSync(capturedKey), "SSH input capture");
    assert.equal(fs.readFileSync(capturedKey, "utf8"), "1b5b313b313a3141",
      "a running SSH child must keep its requested Kitty event encoding");
    await waitFor(async () => {
      const text = await screen();
      return text.includes(`SSH_EXIT:${code}`) && text.endsWith("QA_PROMPT>");
    }, "SSH exit and local shell prompt");
    await command(["command-input", ...exact, "--key", "Up"]);
    let recalled;
    await waitFor(async () => {
      recalled = await screen();
      assert(!recalled.endsWith(":1A"),
        `Up inserted an escape fragment: ${JSON.stringify(recalled)}`);
      return recalled.endsWith("QA_PROMPT> ssh_fixture");
    }, "Up recalling shell history").catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify(recalled)}`);
    });
    await command(["command-input", ...exact, "--key", "Down"]);
    await waitFor(async () => (await screen()).endsWith("QA_PROMPT>"), "Down restoring the empty draft");
    console.log(JSON.stringify({ shell: shell.name, sshExit: code, activeKittyKey: "preserved", shellHistory: "up/down restored" }));
  } finally {
    if (session) await command(["kill", session.session_id, "--workspace", session.workspace_id]);
    fs.rmSync(capturedKey, { force: true });
  }
}
