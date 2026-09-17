import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const base = new URL("../../", import.meta.url);
const native = process.argv.slice(2);
if (native.length > 1 || (native.length === 1 && native[0] !== "--tauri")) {
  throw new Error("usage: backend-ssh-profile-isolation-smoke.mjs [--tauri]");
}
const capabilities = [
  "sessions.list",
  "client_view.authority.read",
  "backend.connection.persistent",
];
const { resolveBackendSshReferencesFromEnvironment: resolve } = await import(
  new URL("cli/lib/backend-ssh-references.mjs", base)
);
const { performBackendProfileRequest: perform } = await import(
  new URL("cli/lib/backend-transport.mjs", base)
);
const { sshBackendProfile, identityFileAuth } = await import(
  new URL("scripts/lib/dure-cli-ssh-fixture.mjs", base)
);
const root = mkdtempSync(join(tmpdir(), "dure-ssh-profile-qa-"));
chmodSync(root, 0o700);
process.env.SSH_AUTH_SOCK = join(root, "no-agent");
const children = [];
const servers = [];
const sockets = new Set();
const observations = [];
const refs = [];
const profiles = [];
const diagnostics = [];
function key(path) {
  const p = spawnSync("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path,
  ]);
  assert.equal(p.status, 0, "fixture key generation");
}
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
let failure;
try {
  for (const suffix of ["a", "b"]) {
    const id = `remote-${suffix}`;
    const hostKey = join(root, `host-${suffix}`);
    const identity = join(root, `identity-${suffix}`);
    key(hostKey);
    key(identity);
    const authorized = join(root, `authorized-${suffix}`);
    writeFileSync(authorized, readFileSync(`${identity}.pub`), { mode: 0o600 });
    const backend = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 256 * 1024) {
          socket.destroy();
          return;
        }
        if (!buffer.includes("\n")) return;
        const boundary = buffer.indexOf("\n");
        let request;
        try {
          request = JSON.parse(buffer.slice(0, boundary));
        } catch {
          socket.destroy();
          return;
        }
        buffer = buffer.slice(boundary + 1);
        observations.push({ backend: id, requestId: request.requestId });
        socket.write(
          JSON.stringify({
            schemaVersion: 1,
            apiVersion: "dure.backend-transport/v1",
            kind: "dure.backend.response",
            requestId: request.requestId,
            backend: {
              id,
              generation: `generation-${suffix}`,
              protocol: { major: 1, minor: 0 },
              capabilities,
              observedAtMs: Date.now(),
            },
            result: { selectedBackend: id },
          }) + "\n",
        );
      });
    });
    servers.push(backend);
    await new Promise((resolve, reject) => {
      backend.once("error", reject);
      backend.listen(0, "127.0.0.1", resolve);
    });
    const sshPort = await port();
    const config = join(root, `sshd-${suffix}.conf`);
    writeFileSync(
      config,
      `HostKey ${hostKey}\nPidFile ${root}/pid-${suffix}\nListenAddress 127.0.0.1\nPort ${sshPort}\nAuthorizedKeysFile ${authorized}\nStrictModes yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding yes\nPrintMotd no\nLogLevel VERBOSE\n`,
    );
    const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("owned sshd startup timeout")),
        3000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`owned sshd exited ${code}`));
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        diagnostics.push(text);
        if (text.includes("Server listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const known = join(root, `known-${suffix}`);
    writeFileSync(
      known,
      `[127.0.0.1]:${sshPort} ${readFileSync(`${hostKey}.pub`, "utf8")}`,
      { mode: 0o600 },
    );
    refs.push(
      {
        reference: `credential-profile:${id}`,
        kind: "identity_file",
        path: identity,
      },
      {
        reference: `known-hosts-profile:${id}`,
        kind: "known_hosts_file",
        path: known,
      },
    );
    const profile = sshBackendProfile({
      id,
      host: "127.0.0.1",
      user: userInfo().username,
      endpointPort: backend.address().port,
      auth: identityFileAuth(id),
      backendId: id,
      generation: `generation-${suffix}`,
      capabilities,
    });
    profile.transport.port = sshPort;
    profiles.push(profile);
  }
  writeFileSync(
    join(root, "backend-ssh-references.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_ssh_references",
      references: refs,
    }),
    { mode: 0o600 },
  );
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const profile of profiles) {
      const result = await perform(
        profile,
        {
          body: {},
          operation: "sessions.list",
          requestId: `request-${profile.id}-${repetition}`,
        },
        {
          sshCommand: "/usr/bin/ssh",
          resolveSshReferences: (input) => resolve(input, { DURE_HOME: root }),
        },
      );
      assert.equal(result.result.selectedBackend, profile.id);
    }
  }
  assert.equal(observations.length, 6);
  // Both servers accept only their own fixture key. Crossed references must
  // fail before a backend receives a request.
  for (const kind of ["auth", "trust"]) {
    const crossed = structuredClone(profiles[1]);
    crossed[kind].reference = profiles[0][kind].reference;
    await assert.rejects(
      perform(
        crossed,
        { body: {}, operation: "sessions.list" },
        {
          sshCommand: "/usr/bin/ssh",
          resolveSshReferences: (input) => resolve(input, { DURE_HOME: root }),
        },
      ),
      { code: "backend_transport_ssh_failed" },
    );
  }
  assert.equal(observations.length, 6);
  if (native[0] === "--tauri") {
    writeFileSync(
      join(root, "backend-profiles.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "dure.backend_profiles",
        profiles,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("scripts/run-with-build-storage.mjs", base)),
        "full",
        "--",
        "cargo",
        "+1.97.1",
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--lib",
        "dure_backend_transport::ssh_references::tests::real_ssh_profiles_keep_native_authority_isolated",
        "--",
        "--ignored",
        "--exact",
      ],
      {
        cwd: fileURLToPath(base),
        stdio: "inherit",
        env: { ...process.env, DURE_QA_BACKEND_SSH_ROOT: root },
      },
    );
    children.push(child);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, "Tauri native adapter fixture");
    assert.equal(observations.length, 12);
  }
} catch (error) {
  failure = { code: error.code, message: error.message };
} finally {
  for (const socket of sockets) socket.destroy();
  for (const server of servers)
    await new Promise((resolve) => server.close(resolve));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await closed;
    }
  }
  const receipt = {
    kind: "dure.qa.ssh-profile-isolation",
    clients: native.length ? ["node", "tauri-native"] : ["node"],
    observations,
    failure,
    childrenReaped: children.every(
      (c) => c.exitCode !== null || c.signalCode !== null,
    ),
  };
  if (failure) process.stderr.write(diagnostics.join(""));
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(receipt));
  if (failure) process.exitCode = 1;
}
