import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSshBackendProfile,
  lookupAppSshHost,
} from "../cli/lib/backend-profile-add.mjs";
import {
  BACKEND_PROFILES_KIND,
  loadBackendProfiles,
  selectBackendProfile,
} from "../cli/lib/backend-profiles.mjs";
import { resolveBackendSshReferencesFromEnvironment } from "../cli/lib/backend-ssh-references.mjs";
import { sshBackendProfile } from "./lib/dure-cli-ssh-fixture.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const GENERATION = "local-v1-0123456789abcdef0123456789abcdef";
const SOCKET_PATH = "/home/dure/.dure/backend/control-plane.sock";
const CAPABILITIES = [
  "backend.transport.ssh_gateway",
  "projects.list",
  "sessions.list",
];
const KNOWN_HOST = "vm.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfixture";
const HOST = {
  id: "host-vm1",
  name: "VM",
  host: "vm.example.test",
  port: 22,
  user: "dure",
  auth: "auto",
};

const sshKeygenAvailable = spawnSync("ssh-keygen", ["-?"]).error === undefined;

function ed25519PublicKey(fill) {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, fill),
  ]).toString("base64");
}

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function seededHome() {
  const root = mkdtempSync(join(tmpdir(), "dure-profile-add-"));
  roots.push(root);
  writeFileSync(
    join(root, "backend-profiles.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: BACKEND_PROFILES_KIND,
      profiles: [sshBackendProfile({ id: "other", defaultProfile: true })],
    })}\n`,
    { mode: 0o600 },
  );
  return root;
}

function success(text) {
  return { kind: "success", stdout: Buffer.from(text, "utf8") };
}

/** One SSH host: its shell reads a descriptor, its gateway answers a ping. */
function remoteHost({
  descriptor = {
    backendId: "dure-local",
    generation: GENERATION,
    socketPath: SOCKET_PATH,
  },
  answers = true,
} = {}) {
  const calls = [];
  const sshExchange = async (argv, input) => {
    calls.push(argv);
    if (argv.at(-1) === "/bin/sh -s") {
      return success(descriptor === null ? "absent\n" : JSON.stringify(descriptor));
    }
    if (!answers) return { kind: "exit", stdout: Buffer.alloc(0) };
    const request = JSON.parse(input.toString("utf8"));
    return success(
      JSON.stringify({
        schemaVersion: 1,
        apiVersion: "dure.backend-transport/v1",
        kind: "dure.backend.response",
        requestId: request.requestId,
        backend: {
          id: "dure-local",
          generation: GENERATION,
          protocol: { major: 1, minor: 0 },
          capabilities: CAPABILITIES,
          observedAtMs: Date.now(),
        },
        result: { schemaVersion: 1, status: "ready" },
      }),
    );
  };
  return { calls, sshExchange };
}

function dependencies(root, remote, overrides = {}) {
  const environment = { DURE_HOME: root };
  return {
    environment,
    loadCatalog: async () => loadBackendProfiles({ environment }),
    lookupHost: async () => HOST,
    readKnownHostKeys: () => [KNOWN_HOST],
    sshExchange: remote.sshExchange,
    ...overrides,
  };
}

function snapshot(root) {
  return {
    entries: readdirSync(root).sort(),
    catalog: readFileSync(join(root, "backend-profiles.json"), "utf8"),
  };
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the command to refuse");
}

function runCli(args, environment) {
  // A disposable HOME as well as DURE_HOME: never reach a live app or backend.
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: environment.DURE_HOME,
      DURE_BACKEND_PROFILE: "",
      ...environment,
    },
    timeout: 30_000,
  });
}

describe("dure profiles add", () => {
  it("reports a host with no Dure backend and leaves nothing behind", async () => {
    const root = seededHome();
    const before = snapshot(root);
    const remote = remoteHost({ descriptor: null });

    const error = await refusal(
      addSshBackendProfile(
        { profileId: "vm-1", hostId: HOST.id },
        dependencies(root, remote),
      ),
    );

    expect(error.code).toBe("backend_profiles_add_no_backend");
    expect(error.message).toContain("no Dure backend answered");
    expect(error.message).toContain("nothing was installed or written");
    expect(remote.calls).toHaveLength(1);
    expect(snapshot(root)).toEqual(before);
  });

  it("reports a backend that left a descriptor but does not answer", async () => {
    const root = seededHome();
    const before = snapshot(root);

    const error = await refusal(
      addSshBackendProfile(
        { profileId: "vm-1", hostId: HOST.id },
        dependencies(root, remoteHost({ answers: false })),
      ),
    );

    expect(error.code).toBe("backend_profiles_add_no_backend");
    expect(snapshot(root)).toEqual(before);
  });

  it("writes a pinned profile that dure profiles show reads back", async () => {
    const root = seededHome();
    const remote = remoteHost();

    const report = await addSshBackendProfile(
      { profileId: "vm-1", hostId: HOST.id },
      dependencies(root, remote),
    );

    const expected = {
      id: "vm-1",
      default: false,
      transport: {
        kind: "ssh",
        host: "vm.example.test",
        port: 22,
        user: "dure",
        endpoint: { kind: "unix_socket" },
        batchMode: true,
        strictHostKeyChecking: "yes",
        connectTimeoutMs: 5_000,
      },
      auth: { kind: "ssh_agent", referenceKind: null },
      trust: { kind: "known_hosts", referenceKind: "known_hosts_file" },
      expected: {
        backendId: "dure-local",
        generation: GENERATION,
        protocol: {
          minimum: { major: 1, minor: 0 },
          maximum: { major: 1, minor: 0 },
        },
        capabilities: CAPABILITIES,
      },
      deadlineMs: 185_000,
    };
    expect(report).toMatchObject({
      kind: "dure.backend_profiles.add",
      hostId: HOST.id,
      replaced: false,
      profile: expected,
    });

    const shown = runCli(["profiles", "show", "vm-1", "--json"], {
      DURE_HOME: root,
    });
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).profile).toEqual(report.profile);

    const written = loadBackendProfiles({ environment: { DURE_HOME: root } }).profiles.find(
      (profile) => profile.id === "vm-1",
    );
    expect(written.transport.endpoint).toEqual({
      kind: "unix_socket",
      path: SOCKET_PATH,
    });
    expect(statSync(join(root, "backend-profiles.json")).mode & 0o077).toBe(0);
    expect(statSync(join(root, "backend-ssh-references.json")).mode & 0o077).toBe(0);
    const material = resolveBackendSshReferencesFromEnvironment(
      {
        auth: { kind: "ssh_agent" },
        profileId: "vm-1",
        trust: {
          kind: "known_hosts",
          reference: "known-hosts-profile:vm-1",
        },
      },
      { DURE_HOME: root },
    ).pin();
    try {
      expect(readFileSync(material.knownHostsFile, "utf8")).toBe(`${KNOWN_HOST}\n`);
    } finally {
      material.dispose();
    }
    expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(readdirSync(root).filter((name) => name.includes("probe"))).toEqual([]);
  });

  it("connects with the host's registered key file", async () => {
    const root = seededHome();
    const keyPath = join(root, "id_vm");
    writeFileSync(keyPath, "private key fixture\n", { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const remote = remoteHost();

    const report = await addSshBackendProfile(
      { profileId: "vm-1", hostId: HOST.id },
      dependencies(root, remote, {
        lookupHost: async () => ({ ...HOST, auth: "key", keyPath }),
      }),
    );

    expect(report.profile.auth).toEqual({
      kind: "identity_file",
      referenceKind: "private_key_file",
    });
    const catalog = JSON.parse(
      readFileSync(join(root, "backend-ssh-references.json"), "utf8"),
    );
    expect(catalog.references).toContainEqual({
      reference: "credential-profile:vm-1",
      kind: "identity_file",
      path: keyPath,
    });
    expect(remote.calls[0].join(" ")).toContain("IdentitiesOnly=yes");
  });

  it("refuses a host key that is not already trusted, before connecting", async () => {
    const root = seededHome();
    const before = snapshot(root);
    const remote = remoteHost();

    const error = await refusal(
      addSshBackendProfile(
        { profileId: "vm-1", hostId: HOST.id },
        dependencies(root, remote, { readKnownHostKeys: () => [] }),
      ),
    );

    expect(error.code).toBe("backend_profiles_add_host_key_unknown");
    expect(remote.calls).toHaveLength(0);
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a password host, which the batch SSH transport cannot use", async () => {
    const root = seededHome();
    const remote = remoteHost();

    const error = await refusal(
      addSshBackendProfile(
        { profileId: "vm-1", hostId: HOST.id },
        dependencies(root, remote, {
          lookupHost: async () => ({ ...HOST, auth: "password" }),
        }),
      ),
    );

    expect(error.code).toBe("backend_profiles_add_password_auth");
    expect(remote.calls).toHaveLength(0);
  });

  it("does not take over a profile ID that points somewhere else", async () => {
    const root = seededHome();
    const before = snapshot(root);
    const remote = remoteHost();

    const error = await refusal(
      addSshBackendProfile(
        { profileId: "other", hostId: HOST.id },
        dependencies(root, remote),
      ),
    );

    expect(error.code).toBe("backend_profiles_add_profile_exists");
    expect(remote.calls).toHaveLength(0);
    expect(snapshot(root)).toEqual(before);
  });

  it("refreshes the pin when the same host is added again", async () => {
    const root = seededHome();
    const deps = dependencies(root, remoteHost());
    await addSshBackendProfile({ profileId: "vm-1", hostId: HOST.id }, deps);

    const report = await addSshBackendProfile(
      { profileId: "vm-1", hostId: HOST.id },
      deps,
    );

    expect(report.replaced).toBe(true);
    const profiles = loadBackendProfiles({ environment: { DURE_HOME: root } }).profiles;
    expect(profiles.map((profile) => profile.id)).toEqual(["other", "vm-1"]);
    expect(profiles[0].default).toBe(true);
  });

  it.skipIf(!sshKeygenAvailable)(
    "pins only the keys known_hosts already holds for that exact host and port",
    async () => {
      const root = seededHome();
      const trusted = `[vm.example.test]:2222 ssh-ed25519 ${ed25519PublicKey(1)}`;
      mkdirSync(join(root, ".ssh"), { mode: 0o700 });
      writeFileSync(
        join(root, ".ssh", "known_hosts"),
        [
          `other.example.test ssh-ed25519 ${ed25519PublicKey(2)}`,
          `vm.example.test ssh-ed25519 ${ed25519PublicKey(3)}`,
          trusted,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const { readKnownHostKeys: _injected, ...deps } = dependencies(root, remoteHost(), {
        homeDirectory: root,
        lookupHost: async () => ({ ...HOST, port: 2222 }),
      });

      await addSshBackendProfile({ profileId: "vm-1", hostId: HOST.id }, deps);

      expect(readFileSync(join(root, "backend-ssh", "vm-1.known_hosts"), "utf8")).toBe(
        `${trusted}\n`,
      );
    },
  );

  it("refuses a key file that SSH could not safely use", async () => {
    const root = seededHome();
    const keyPath = join(root, "id_shared");
    writeFileSync(keyPath, "private key fixture\n", { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    const remote = remoteHost();

    const error = await refusal(
      addSshBackendProfile(
        { profileId: "vm-1", hostId: HOST.id },
        dependencies(root, remote, {
          lookupHost: async () => ({ ...HOST, auth: "key", keyPath }),
        }),
      ),
    );

    expect(error.code).toBe("backend_profiles_add_key_unavailable");
    expect(remote.calls).toHaveLength(0);
  });

  it("explains its usage when --host is missing", () => {
    const root = seededHome();

    const result = runCli(["profiles", "add", "vm-1"], { DURE_HOME: root });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dure profiles add <ID> --host");
  });

  it("rejects an invalid profile ID before contacting anything", async () => {
    const root = seededHome();
    const remote = remoteHost();

    const error = await refusal(
      addSshBackendProfile(
        { profileId: "Not Valid", hostId: HOST.id },
        dependencies(root, remote),
      ),
    );

    expect(error.code).toBe("backend_profiles_profile_id_invalid");
    expect(remote.calls).toHaveLength(0);
  });
});

describe("dure profiles add from the command line", () => {
  const servers = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
  });

  /** A disposable machine: fake app on loopback, stub ssh, real ssh-keygen. */
  async function machine({ descriptor }) {
    const home = mkdtempSync(join(tmpdir(), "dure-profile-add-cli-"));
    roots.push(home);
    const root = join(home, ".dure");
    const bin = join(home, "bin");
    for (const directory of [root, bin, join(home, ".ssh")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeFileSync(
      join(root, "backend-profiles.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: BACKEND_PROFILES_KIND,
        profiles: [sshBackendProfile({ id: "other", defaultProfile: true })],
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, ".ssh", "known_hosts"),
      `vm.example.test ssh-ed25519 ${ed25519PublicKey(7)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(bin, "ssh"),
      `#!/usr/bin/env node
const input = require("node:fs").readFileSync(0, "utf8");
if (process.argv.at(-1) === "/bin/sh -s") {
  process.stdout.write(${JSON.stringify(descriptor)});
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-transport/v1",
  kind: "dure.backend.response",
  requestId: JSON.parse(input).requestId,
  backend: {
    id: "dure-local",
    generation: ${JSON.stringify(GENERATION)},
    protocol: { major: 1, minor: 0 },
    capabilities: ${JSON.stringify(CAPABILITIES)},
    observedAtMs: Date.now(),
  },
  result: { schemaVersion: 1, status: "ready" },
}));
`,
      { mode: 0o755 },
    );

    const requests = [];
    const server = createServer((incoming, response) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => {
        body += chunk;
      });
      incoming.on("end", () => {
        requests.push({ url: incoming.url, body: JSON.parse(body) });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, host: HOST }));
      });
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    writeFileSync(
      join(root, "server.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiVersion: 1,
        packageVersion: "0.1.4",
        buildId: "0.1.4+fixture",
        port: server.address().port,
        token: "client-control-token",
        channel: "stable",
        generation: "client-generation-1",
        capabilities: ["ssh_hosts.get_v1"],
        processId: 42,
      }),
    );

    const environment = {
      ...process.env,
      HOME: home,
      DURE_HOME: root,
      HMUX_DISCOVERY_ROOT: join(home, "hmux-discovery"),
      PATH: `${bin}${delimiter}${process.env.PATH}`,
    };
    for (const name of [
      "DURE_APP_CHANNEL",
      "HEBBIAN_APP_CHANNEL",
      "DURE_BACKEND_PROFILE",
      "DURE_ORCHESTRATION_HOME",
      "HMUX_SESSION_ID",
      "HMUX_WORKSPACE_ID",
    ]) {
      delete environment[name];
    }
    return { environment, requests, root };
  }

  /** Asynchronous so the fake app can answer while the CLI waits on it. */
  function run(args, environment) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it.skipIf(!sshKeygenAvailable)(
    "reads the host from the app, verifies it and leaves a usable profile",
    async () => {
      const { environment, requests, root } = await machine({
        descriptor: JSON.stringify({
          backendId: "dure-local",
          generation: GENERATION,
          socketPath: SOCKET_PATH,
        }),
      });

      const added = await run(
        ["profiles", "add", "vm-1", "--host", HOST.id, "--json"],
        environment,
      );

      expect(added.code).toBe(0);
      expect(JSON.parse(added.stdout)).toMatchObject({
        kind: "dure.backend_profiles.add",
        profile: { id: "vm-1", expected: { generation: GENERATION } },
      });
      expect(requests).toEqual([
        { url: "/ssh/hosts/get", body: { hostId: HOST.id } },
      ]);
      const tested = await run(["profiles", "test", "vm-1", "--json"], environment);
      expect(JSON.parse(tested.stdout)).toMatchObject({
        kind: "dure.backend_profiles.test",
        status: "ready",
      });
      expect(readFileSync(join(root, "backend-ssh", "vm-1.known_hosts"), "utf8")).toContain(
        "vm.example.test ssh-ed25519",
      );
    },
  );

  it.skipIf(!sshKeygenAvailable)(
    "prints why it stopped when the host has no Dure backend",
    async () => {
      const { environment, root } = await machine({ descriptor: "absent\n" });

      const added = await run(["profiles", "add", "vm-1", "--host", HOST.id], environment);

      expect(added.code).toBe(2);
      expect(added.stderr).toContain("backend_profiles_add_no_backend");
      expect(added.stderr).toContain("nothing was installed or written");
      expect(readdirSync(root)).not.toContain("backend-ssh-references.json");
    },
  );
});

describe("app SSH host lookup", () => {
  const descriptor = (capabilities) => ({
    port: 4242,
    token: "control-token",
    capabilities,
  });

  it("needs an app that can read registered hosts", async () => {
    const error = await refusal(
      lookupAppSshHost(HOST.id, { descriptor: descriptor([]) }),
    );

    expect(error.code).toBe("client_capability_missing");
    expect(error.message).toContain("ssh_hosts.get_v1");
  });

  it("asks the app for exactly that host", async () => {
    const requests = [];
    const host = await lookupAppSshHost(HOST.id, {
      descriptor: descriptor(["ssh_hosts.get_v1"]),
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, host: HOST }));
      },
    });

    expect(host).toEqual(HOST);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4242/ssh/hosts/get",
        body: { hostId: HOST.id },
      },
    ]);
  });
});

describe("the next command for an app SSH host", () => {
  const catalog = { profiles: [] };

  function selectionError(explicitId) {
    try {
      selectBackendProfile(catalog, { explicitId, environment: {} });
    } catch (error) {
      return error;
    }
    throw new Error("expected selection to fail");
  }

  it("names the exact command when --backend is an app host ID", () => {
    const error = selectionError("host-ssh-config-6162");

    expect(error.code).toBe("backend_profiles_selection_not_found");
    expect(error.message).toContain(
      "dure profiles add host-ssh-config-6162 --host host-ssh-config-6162",
    );
  });

  it("offers a valid profile ID for a generated host ID", () => {
    const error = selectionError("host-aB_3xY9-");

    expect(error.code).toBe("backend_profiles_selector_invalid");
    expect(error.message).toContain(
      "dure profiles add host-ab_3xy9 --host host-aB_3xY9-",
    );
  });

  it("keeps the plain message for any other unknown profile", () => {
    const error = selectionError("staging");

    expect(error.code).toBe("backend_profiles_selection_not_found");
    expect(error.message).not.toContain("dure profiles add");
  });

  it("prints that command from dure runs list", () => {
    const root = seededHome();

    const result = runCli(["runs", "list", "--backend", "host-vm1"], {
      DURE_HOME: root,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "dure profiles add host-vm1 --host host-vm1",
    );
  });
});
