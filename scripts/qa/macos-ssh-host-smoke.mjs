#!/usr/bin/env node

// Real SSH into this Mac as an unprivileged account with a disposable HOME.
// What it cannot show is a second physical Mac; everything on the far side of
// the SSH connection is otherwise the shipped path.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoArtifact } from "./managed-provider-fixture.mjs";

const target = "aarch64-apple-darwin";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resourcesSource = join(repositoryRoot, "src-tauri/resources");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

assert(process.platform === "darwin" && process.arch === "arm64", "requires an Apple silicon Mac");

const binary = process.env.DURE_QA_MACOS_SSH_TAURI_TEST_BINARY ?? await cargoArtifact([
  "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--no-run",
], "agent_ide_lib", { kind: "qa" });

// sshd StrictModes checks every ancestor of the key file, which rules out /tmp.
const evidence = join(repositoryRoot, "artifacts", "qa");
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(evidence, "macos-ssh-host-"));
// Host sockets live under these and macOS caps a socket path at 104 bytes.
const shortRoot = mkdtempSync("/tmp/dure-macos-ssh.");
chmodSync(shortRoot, 0o700);
const home = join(shortRoot, "home");
const discovery = join(shortRoot, "discovery");
const temporary = join(shortRoot, "tmp");
const owner = join(root, "sshd-owner");
for (const directory of [home, discovery, temporary, owner]) mkdirSync(directory, { mode: 0o700 });

const resources = join(root, "app-resources/resources");
for (const name of ["hmux-remote", "remote-git-checkout-helper"]) {
  cpSync(join(resourcesSource, name, target), join(resources, name, target), { recursive: true });
}
copyFileSync(join(repositoryRoot, "scripts/install-hmux.sh"), join(resources, "install-hmux.sh"));

const run = (program, args, options = {}) =>
  execFileSync(program, args, { cwd: root, encoding: "utf8", timeout: 30_000, ...options });
for (const name of ["host-key", "identity"]) {
  run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, name)]);
}
writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "identity.pub")), { mode: 0o600 });
const fingerprint = run("/usr/bin/ssh-keygen", ["-lf", join(root, "host-key.pub")]).split(/\s+/)[1];

const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const { port } = socket.address();
await new Promise((done) => socket.close(done));

// The account's real HOME never reaches the far side of the connection.
const user = userInfo().username;
const gateway = join(root, "gateway");
writeFileSync(gateway, `#!/bin/sh\nexec /usr/bin/env -i HOME=${quote(home)} USER=${quote(user)} LOGNAME=${quote(user)} PATH=/usr/bin:/bin TMPDIR=${quote(temporary)} HMUX_DISCOVERY_ROOT=${quote(discovery)} /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
const config = join(root, "sshd.conf");
writeFileSync(config, `HostKey ${root}/host-key\nPidFile ${root}/sshd.pid\nListenAddress 127.0.0.1\nPort ${port}\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding no\nPermitTTY no\nForceCommand ${gateway}\nPrintMotd no\nLogLevel VERBOSE\n`, { mode: 0o600 });
const fixture = join(root, "fixture.json");
writeFileSync(fixture, JSON.stringify({
  ssh: { host: "127.0.0.1", port, user, auth: "key", keyPath: join(root, "identity"), hostKeyFingerprints: [fingerprint] },
  resourceDir: join(root, "app-resources"),
  home,
}), { mode: 0o600 });

const supervisor = spawn(process.execPath, [
  resolve(repositoryRoot, "scripts/qa/lib/bounded-owned-process-group.mjs"), "run", owner,
  "--timeout-seconds", "300", "--", "/usr/sbin/sshd", "-D", "-e", "-f", config,
], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
const exited = new Promise((done, fail) => {
  supervisor.once("error", fail);
  supervisor.once("exit", done);
});
let log = "";
function stopHosts() {
  // Only processes executing from this run's disposable HOME can match.
  try {
    execFileSync("/usr/bin/pkill", ["-KILL", "-f", `${home}/.local/share/hmux/`], { stdio: "ignore" });
  } catch {
    // pkill exits non-zero when nothing matched, which is the expected case.
  }
}
try {
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`SSH startup failed: ${log}`)), 10_000);
    supervisor.stderr.on("data", (chunk) => {
      log += chunk;
      if (log.includes(`Server listening on 127.0.0.1 port ${port}`)) {
        clearTimeout(timer);
        done();
      }
    });
    exited.then((code) => {
      clearTimeout(timer);
      fail(new Error(`SSH supervisor exited ${code}: ${log}`));
    }, fail);
  });
  const environment = {
    ...process.env,
    DURE_HOME: join(root, "desktop"),
    DURE_APP_CHANNEL: "qa-macos-ssh",
    HMUX_DISCOVERY_ROOT: discovery,
    DURE_QA_MACOS_SSH_HOST: fixture,
  };
  delete environment.HEBBIAN_APP_CHANNEL;
  delete environment.DURE_BACKEND_PROFILE;
  const output = run(resolve(binary), [
    "remote_hmux_install::macos_ssh_smoke::provisions_a_mac_and_keeps_a_managed_session_across_ssh_connections",
    "--ignored", "--exact", "--nocapture",
  ], { env: environment, timeout: 240_000, stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(output);
  assert.match(output, /1 passed; 0 failed/);
  assert.match(output, /Reattached to the same Host generation/);
} finally {
  stopHosts();
  writeFileSync(join(owner, "cancel"), "", { flag: "wx", mode: 0o600 });
  await exited;
  writeFileSync(join(root, "sshd.log"), log, { mode: 0o600 });
  assert.equal(JSON.parse(readFileSync(join(owner, "completion.json"), "utf8")).cleanup, "verified");
  rmSync(shortRoot, { recursive: true, force: true });
}
console.log(`macOS SSH host smoke passed; process cleanup verified. Evidence: ${root}`);
