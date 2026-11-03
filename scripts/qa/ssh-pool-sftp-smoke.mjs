#!/usr/bin/env node
// Real loopback SSH: SFTP work on the desktop's pooled sessions after the
// parked connection went away (a restarted tunnel, an idle drop).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const repositoryRoot = process.cwd();
let binary = process.argv[2];
if (!binary) {
  execFileSync("sh", ["scripts/stage-hmux-runtime.sh", "debug"], { cwd: repositoryRoot, stdio: "inherit", timeout: 1_200_000 });
  const build = execFileSync("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--no-run", "--message-format=json"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });
  binary = build.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.reason === "compiler-artifact" && row.target?.name === "agent_ide_lib" && row.profile?.test && row.executable)?.executable;
}
assert.ok(binary, "cargo did not publish the desktop library test executable");
const sftpServer = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server"].find((path) => existsSync(path));
assert.ok(sftpServer, "an OpenSSH sftp-server is required");
// sshd StrictModes checks every ancestor; the shared /tmp directory is rejected.
const evidence = join(repositoryRoot, "artifacts", "qa");
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const root = realpathSync(mkdtempSync(join(evidence, "ssh-pool-sftp-")));
const home = join(root, "remote-home");
const repository = join(home, "repo");
const owner = join(root, "sshd-owner");
for (const directory of [home, owner, repository, join(root, "desktop"), join(root, "discovery")]) mkdirSync(directory, { mode: 0o700 });
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, encoding: "utf8", timeout: 30_000, ...options });
for (const name of ["host-key", "identity"]) run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, name)]);
writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "identity.pub")), { mode: 0o600 });
const fingerprint = run("/usr/bin/ssh-keygen", ["-lf", join(root, "host-key.pub")]).split(/\s+/)[1];
run("git", ["-C", repository, "init", "-q"], { env: withoutLocalGitOverrides(process.env) });
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
// Commands and the sftp-server subsystem both run with a private HOME.
const gateway = join(root, "gateway");
writeFileSync(gateway, `#!/bin/sh\nexec /usr/bin/env -i HOME=${quote(home)} PATH=/usr/bin:/bin USER=${quote(userInfo().username)} /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
const config = join(root, "sshd.conf");
writeFileSync(config, `HostKey ${root}/host-key\nPidFile ${root}/sshd.pid\nListenAddress 127.0.0.1\nPort ${port}\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding no\nPermitTTY no\nSubsystem sftp ${sftpServer}\nForceCommand ${gateway}\nPrintMotd no\nLogLevel VERBOSE\n`, { mode: 0o600 });
const supervisor = spawn(process.execPath, [resolve("scripts/qa/lib/bounded-owned-process-group.mjs"), "run", owner, "--timeout-seconds", "180", "--", "/usr/sbin/sshd", "-D", "-e", "-f", config], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
const exited = new Promise((resolve, reject) => { supervisor.once("error", reject); supervisor.once("exit", (code) => resolve(code)); });
let log = "";
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`SSH startup failed: ${log}`)), 10_000);
    supervisor.stderr.on("data", (chunk) => {
      log += chunk;
      if (log.includes(`Server listening on 127.0.0.1 port ${port}`)) { clearTimeout(timeout); resolve(); }
    });
    exited.then((code) => { clearTimeout(timeout); reject(new Error(`SSH supervisor exited ${code}: ${log}`)); }, reject);
  });
  const environment = { ...process.env, HOME: join(root, "desktop"), DURE_HOME: join(root, "desktop"), DURE_APP_CHANNEL: "qa-ssh-pool-sftp", HMUX_DISCOVERY_ROOT: join(root, "discovery"), DURE_SSH_POOL_QA_REPOSITORY: repository, DURE_SSH_POOL_QA_SSH: JSON.stringify({ host: "127.0.0.1", port, user: userInfo().username, auth: "key", keyPath: join(root, "identity"), hostKeyFingerprints: [fingerprint] }) };
  delete environment.HEBBIAN_APP_CHANNEL;
  delete environment.DURE_BACKEND_PROFILE;
  const output = run(resolve(binary), ["ssh::sftp_pool_tests::sftp_work_replaces_a_parked_connection_that_went_away", "--ignored", "--exact", "--nocapture"], { env: environment, timeout: 120_000, stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(output);
  assert.match(output, /1 passed; 0 failed/);
  assert.match(output, /SSH pool SFTP: dead parked sessions were replaced/);
} finally {
  writeFileSync(join(owner, "cancel"), "", { flag: "wx", mode: 0o600 });
  await exited;
  assert.equal(JSON.parse(readFileSync(join(owner, "completion.json"), "utf8")).cleanup, "verified");
  writeFileSync(join(root, "sshd.log"), log, { mode: 0o600 });
}
console.log(`SSH pool SFTP smoke passed; process cleanup verified. Evidence: ${root}`);
