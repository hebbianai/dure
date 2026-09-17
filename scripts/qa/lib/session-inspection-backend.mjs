import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performBackendProfileRequest } from "../../../cli/lib/backend-transport.mjs";
import { sshBackendProfile, identityFileAuth } from "../../lib/dure-cli-ssh-fixture.mjs";
import { processIdentity } from "../../lib/process-identity.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// All native processes, keys and backend state belong to the caller's disposable
// QA root. The loopback sshd invokes the real native gateway and backend.
export function inspectionBackendFixture({ root, environment, executable, hmux, runtime }) {
  const children = [];
  let descriptor;
  let localProfile;
  const descriptorPath = join(environment.DURE_HOME, "backend/control-plane.json");
  function recordOwnership() {
    writeFileSync(join(root, "owned-backend-processes.json"), JSON.stringify(children.map(({ child, executable, cwd, identity }) => ({
      pid: child.pid, executable, cwd, identity,
    }))), { mode: 0o600 });
  }
  function launch(file, args) {
    const child = spawn(file, args, { cwd: root, env: environment, stdio: ["ignore", "ignore", "pipe"] });
    const entry = { child, executable: file, cwd: root, identity: null, diagnostic: "" };
    children.push(entry);
    child.on("error", (error) => { entry.error = error; });
    child.stderr.on("data", (bytes) => { entry.diagnostic = (entry.diagnostic + bytes.toString()).slice(-4096); });
    if (Number.isSafeInteger(child.pid)) entry.identity = processIdentity(child.pid);
    recordOwnership();
    return entry;
  }
  async function ready(entry, predicate) {
    const deadline = performance.now() + 10_000;
    while (!predicate()) {
      if (entry.error) throw entry.error;
      assert.ok(entry.child.exitCode === null && entry.child.signalCode === null,
        `owned fixture exited: ${entry.diagnostic}`);
      assert.ok(performance.now() < deadline, `owned fixture startup timeout: ${entry.diagnostic}`);
      await delay(50);
    }
    entry.identity = processIdentity(entry.child.pid);
    assert.ok(entry.identity, "owned fixture process generation is observable");
  }
  function observeDescriptor(backend) {
    descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    assert.equal(descriptor.processId, backend.child.pid);
    const capabilities = ["sessions.show", "sessions.list", "backend.transport.ssh_gateway"];
    localProfile = {
      id: "qa-local", transport: { kind: "local", endpoint: { kind: "unix_socket", path: descriptor.socketPath } },
      auth: { kind: "peer" }, trust: { kind: "local_peer" },
      expected: { backendId: descriptor.backendId, generation: descriptor.generation,
        protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } }, capabilities },
      deadlineMs: 10_000,
    };
  }
  return {
    async start() {
      const backend = launch(executable, ["serve", "--home", environment.DURE_HOME,
        "--hmux-bin", hmux, "--hmux-runtime-bin", runtime,
        "--hmux-discovery-root", environment.HMUX_DISCOVERY_ROOT]);
      await ready(backend, () => existsSync(descriptorPath));
      observeDescriptor(backend);
      const hostKey = join(root, "ssh-host-key");
      const identity = join(root, "ssh-identity");
      for (const path of [hostKey, identity]) {
        const result = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path],
          { cwd: root, env: environment, timeout: 5000 });
        assert.equal(result.status, 0, "fixture key generation");
      }
      const authorized = join(root, "ssh-authorized");
      writeFileSync(authorized, readFileSync(`${identity}.pub`), { mode: 0o600 });
      const listener = createServer();
      await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
      const port = listener.address().port;
      await new Promise((resolve) => listener.close(resolve));
      const socketHex = Buffer.from(descriptor.socketPath).toString("hex");
      const gatewayArgs = ["gateway", "--socket-hex", socketHex, "--expected-generation", descriptor.generation];
      const expectedCommand = ["~/.local/bin/dure-control-plane", ...gatewayArgs].join(" ");
      const gateway = join(root, "ssh-gateway.sh");
      writeFileSync(gateway, `#!/bin/sh\n[ "$SSH_ORIGINAL_COMMAND" = ${quote(expectedCommand)} ] || exit 64\nexport HOME=${quote(environment.HOME)}\nexport DURE_HOME=${quote(environment.DURE_HOME)}\nexec ${[executable, ...gatewayArgs].map(quote).join(" ")}\n`, { mode: 0o700 });
      const config = join(root, "sshd.conf");
      writeFileSync(config, `HostKey ${hostKey}\nPidFile ${root}/sshd.pid\nListenAddress 127.0.0.1\nPort ${port}\nAuthorizedKeysFile ${authorized}\nStrictModes yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding no\nPrintMotd no\nLogLevel VERBOSE\nForceCommand /bin/sh ${gateway}\n`, { mode: 0o600 });
      const sshd = launch("/usr/sbin/sshd", ["-D", "-e", "-f", config]);
      await ready(sshd, () => sshd.diagnostic.includes("Server listening"));
      const known = join(root, "ssh-known-hosts");
      writeFileSync(known, `[127.0.0.1]:${port} ${readFileSync(`${hostKey}.pub`, "utf8")}`, { mode: 0o600 });
      const capabilities = localProfile.expected.capabilities;
      const remoteProfile = sshBackendProfile({ id: "qa-ssh", host: "127.0.0.1", user: userInfo().username,
        auth: identityFileAuth("qa-ssh"), backendId: descriptor.backendId, generation: descriptor.generation, capabilities });
      remoteProfile.transport.port = port;
      remoteProfile.transport.endpoint = localProfile.transport.endpoint;
      writeFileSync(join(environment.DURE_HOME, "backend-profiles.json"), JSON.stringify({
        schemaVersion: 1, kind: "dure.backend_profiles", profiles: [localProfile, remoteProfile],
      }), { mode: 0o600 });
      writeFileSync(join(environment.DURE_HOME, "backend-ssh-references.json"), JSON.stringify({
        schemaVersion: 1, kind: "dure.backend_ssh_references", references: [
          { reference: "credential-profile:qa-ssh", kind: "identity_file", path: identity },
          { reference: "known-hosts-profile:qa-ssh", kind: "known_hosts_file", path: known },
        ],
      }), { mode: 0o600 });
      recordOwnership();
      return ["qa-local", "qa-ssh"];
    },
    async stop() {
      const errors = [];
      // A startup failure can race publication of the descriptor. Resolve the
      // exact owned backend for cleanup without converting that failure to a pass.
      const backend = children[0];
      if (!localProfile && backend && backend.child.exitCode === null && backend.child.signalCode === null) {
        try {
          await ready(backend, () => existsSync(descriptorPath));
          observeDescriptor(backend);
        } catch (error) { errors.push(error); }
      }
      if (localProfile) {
        try {
          const response = await performBackendProfileRequest(localProfile, {
            operation: "backend.shutdown", body: { schemaVersion: 2, mode: "stop" },
          });
          assert.equal(response.result.status, "stopping");
        } catch (error) { errors.push(error); }
      }
      for (const entry of children) {
        try {
          if (entry.child.exitCode === null && entry.child.signalCode === null && entry.executable === "/usr/sbin/sshd") {
            assert.ok(entry.identity, "sshd cleanup requires the recorded generation");
            assert.equal(processIdentity(entry.child.pid), entry.identity, "sshd generation still matches");
            entry.child.kill("SIGTERM");
          }
          const deadline = performance.now() + 10_000;
          while (processIdentity(entry.child.pid) !== null) {
            assert.ok(performance.now() < deadline, `owned backend cleanup incomplete; retain ${root}`);
            await delay(50);
          }
        } catch (error) { errors.push(error); }
      }
      writeFileSync(join(root, "backend-fixture-diagnostics.json"), JSON.stringify(children.map(({ executable, diagnostic }) => ({ executable, diagnostic }))), { mode: 0o600 });
      if (errors.length) throw new AggregateError(errors, `QA backend cleanup failed; retain ${root}`);
      if (descriptor) {
        const alias = dirname(descriptor.socketPath);
        assert.equal(readlinkSync(alias), join(environment.DURE_HOME, "backend"));
        unlinkSync(alias);
      }
    },
  };
}
