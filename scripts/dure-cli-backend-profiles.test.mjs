import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKEND_PROFILES_FILE,
  BACKEND_PROFILES_KIND,
  DEFAULT_BACKEND_PROFILE_DEADLINE_MS,
  MAX_BACKEND_PROFILE_DEADLINE_MS,
  MAX_BACKEND_PROFILES,
  MAX_BACKEND_PROFILES_BYTES,
  BackendProfileError,
  loadBackendProfiles,
  parseBackendProfiles,
  projectBackendProfile,
  requireBackendProfileNoFollowFlag,
  resolveBackendProfilesPath,
  selectBackendProfile,
} from "../cli/lib/backend-profiles.mjs";
import {
  identityFileAuth,
  sshBackendProfile,
} from "./lib/dure-cli-ssh-fixture.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const modulePath = fileURLToPath(
  new URL("../cli/lib/backend-profiles.mjs", import.meta.url),
);
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-backend-profiles-"));
  temporaryRoots.push(root);
  return root;
}

describe("backend profile home cutover", () => {
  it("selects the canonical root for a fresh user without creating it", () => {
    const home = temporaryRoot();
    mkdirSync(join(home, ".hebbian"), { mode: 0o700 });

    expect(resolveBackendProfilesPath({ environment: {}, homeDirectory: home })).toBe(
      join(home, ".dure", BACKEND_PROFILES_FILE),
    );
    expect(existsSync(join(home, ".dure"))).toBe(false);
  });

  it("does not fall back when .dure is unsafe and keeps DURE_HOME explicit", () => {
    const home = temporaryRoot();
    writeFileSync(join(home, ".dure"), "not-a-directory");
    expect(resolveBackendProfilesPath({ environment: {}, homeDirectory: home })).toBe(
      join(home, ".dure", BACKEND_PROFILES_FILE),
    );
    rmSync(join(home, ".dure"));
    mkdirSync(join(home, ".dure"), { mode: 0o700 });
    expect(resolveBackendProfilesPath({ environment: {}, homeDirectory: home })).toBe(
      join(home, ".dure", BACKEND_PROFILES_FILE),
    );
    expect(
      resolveBackendProfilesPath({
        environment: { DURE_HOME: join(home, "portable") },
        homeDirectory: home,
      }),
    ).toBe(join(home, "portable", BACKEND_PROFILES_FILE));
  });
});

function localProfile(overrides = {}) {
  return {
    id: "local-primary",
    default: true,
    transport: {
      kind: "local",
      endpoint: { kind: "unix_socket", path: "/run/dure/backend.sock" },
    },
    auth: { kind: "peer" },
    trust: { kind: "local_peer" },
    expected: {
      backendId: "local-backend",
      generation: "generation-local-1",
      protocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 3 },
      },
      capabilities: ["sessions.read", "sessions.list"],
    },
    deadlineMs: 3_000,
    ...overrides,
  };
}

function remoteProfile(overrides = {}) {
  return {
    ...sshBackendProfile({
      host: "build.example.test",
      user: "dure_runner",
      endpointPort: 4681,
      connectTimeoutMs: 750,
      auth: identityFileAuth("remote-build"),
      generation: "generation-remote-7",
      protocol: {
        minimum: { major: 1, minor: 1 },
        maximum: { major: 2, minor: 0 },
      },
      capabilities: ["sessions.read", "sessions.list", "sessions.attach"],
      deadlineMs: 2_000,
    }),
    ...overrides,
  };
}

function catalog(profiles = [remoteProfile(), localProfile()]) {
  return {
    schemaVersion: 1,
    kind: BACKEND_PROFILES_KIND,
    profiles,
  };
}

function writeCatalog(root, value = catalog(), mode = 0o600) {
  mkdirSync(root, { recursive: true });
  const configPath = join(root, BACKEND_PROFILES_FILE);
  writeFileSync(configPath, JSON.stringify(value), { mode });
  chmodSync(configPath, mode);
  return configPath;
}

function expectCode(operation, code) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BackendProfileError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function installSideEffectFence(root) {
  const marker = join(root, "side-effects.jsonl");
  const preload = join(root, "block-side-effects.cjs");
  writeFileSync(
    preload,
    `const fs = require("node:fs");
const childProcess = require("node:child_process");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { syncBuiltinESMExports } = require("node:module");
const marker = process.env.DURE_PROFILE_SIDE_EFFECT_MARKER;
function blocked(kind) {
  return (...args) => {
    fs.appendFileSync(marker, JSON.stringify({ kind, arguments: args.length }) + "\\n");
    throw new Error("blocked profile side effect: " + kind);
  };
}
for (const name of ["spawn", "spawnSync", "exec", "execFile", "fork"]) {
  childProcess[name] = blocked("child_process." + name);
}
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  dns[name] = blocked("dns." + name);
}
for (const [module, name] of [[http, "http"], [https, "https"]]) {
  module.request = blocked(name + ".request");
  module.get = blocked(name + ".get");
}
net.connect = blocked("net.connect");
net.createConnection = blocked("net.createConnection");
tls.connect = blocked("tls.connect");
global.fetch = blocked("fetch");
syncBuiltinESMExports();
`,
  );
  return { marker, preload };
}

function runCli(root, args, environment = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DURE_APP_CHANNEL: "stable",
      DURE_HOME: root,
      ...environment,
    },
  });
}

function runCliAsync(root, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        DURE_APP_CHANNEL: "stable",
        DURE_HOME: root,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stderr, stdout }),
    );
  });
}

function namedRemoteProfile(
  id,
  { defaultProfile = false, deadlineMs = 2_000 } = {},
) {
  return sshBackendProfile({
    id,
    defaultProfile,
    host: `${id}.example.test`,
    user: "dure_runner",
    endpointPort: 4681,
    connectTimeoutMs: Math.min(50, deadlineMs),
    auth: identityFileAuth(id),
    backendId: `${id}-backend`,
    generation: `${id}-generation-1`,
    capabilities: ["sessions.read"],
    deadlineMs,
  });
}

function writeSshReferenceCatalog(root, profileIds) {
  const references = [];
  const paths = {};
  for (const profileId of profileIds) {
    const knownHostsFile = join(root, `${profileId}-known-hosts`);
    const identityFile = join(root, `${profileId}-identity`);
    writeFileSync(
      knownHostsFile,
      `${profileId}.example.test ssh-ed25519 fixture-${profileId}\n`,
      { mode: 0o600 },
    );
    writeFileSync(identityFile, `private-fixture-${profileId}\n`, {
      mode: 0o600,
    });
    references.push(
      {
        reference: `known-hosts-profile:${profileId}`,
        kind: "known_hosts_file",
        path: knownHostsFile,
      },
      {
        reference: `credential-profile:${profileId}`,
        kind: "identity_file",
        path: identityFile,
      },
    );
    paths[profileId] = { identityFile, knownHostsFile };
  }
  writeFileSync(
    join(root, "backend-ssh-references.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_ssh_references",
      references,
    }),
    { mode: 0o600 },
  );
  return paths;
}

function installSshPreflightFixture(root) {
  const bin = join(root, "bin");
  const logPath = join(root, "ssh-preflight.jsonl");
  mkdirSync(bin, { recursive: true });
  const sshPath = join(bin, "ssh");
  writeFileSync(
    sshPath,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const request = JSON.parse(readFileSync(0, "utf8"));
const expectedProfile = request.expected.backendId.replace(/-backend$/, "");
const knownHostsFile = argv.find(value => value.startsWith("UserKnownHostsFile=")).slice("UserKnownHostsFile=".length);
const identityFile = argv.find(value => value.startsWith("IdentityFile=")).slice("IdentityFile=".length);
const matchedMaterial =
  readFileSync(knownHostsFile, "utf8") === expectedProfile + ".example.test ssh-ed25519 fixture-" + expectedProfile + "\\n" &&
  readFileSync(identityFile, "utf8") === "private-fixture-" + expectedProfile + "\\n";
appendFileSync(process.env.DURE_PROFILE_TEST_LOG, JSON.stringify({ argv, request, knownHostsFile, identityFile, matchedMaterial }) + "\\n");
const mode = process.env.DURE_PROFILE_TEST_MODE || "ready";
if (mode === "timeout") {
  setTimeout(() => process.exit(0), 2000);
} else if (mode === "nonzero" || mode === "host_key_rejected") {
  process.stderr.write(process.env.DURE_PROFILE_TEST_SECRET || "ssh failed");
  process.exit(29);
} else if (mode === "oversize") {
  process.stdout.on("error", () => process.exit(0));
  process.stdout.write("x".repeat(2 * 1024 * 1024));
} else {
  const backend = {
    id: mode === "wrong_backend" ? "wrong-backend" : request.expected.backendId,
    generation: mode === "wrong_generation" ? "wrong-generation" : request.expected.generation,
    protocol: mode === "wrong_protocol" ? { major: 9, minor: 0 } : { major: 1, minor: 0 },
    capabilities: mode === "missing_capability" ? [] : ["sessions.read"],
    observedAtMs: Date.now(),
  };
  const result = mode === "invalid_result"
    ? { schemaVersion: 1, status: "warming" }
    : { schemaVersion: 1, status: "ready" };
  const response = JSON.stringify({
    schemaVersion: 1,
    apiVersion: "dure.backend-transport/v1",
    kind: "dure.backend.response",
    requestId: request.requestId,
    backend,
    result,
  });
  process.stdout.write(mode === "banner" ? "untrusted banner\\n" + response : response);
}
`,
    { mode: 0o755 },
  );
  chmodSync(sshPath, 0o755);
  return { bin, logPath };
}

async function listen(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

describe("Dure backend profiles", () => {
  it("loads two local/remote profiles and projects only stable redacted posture", () => {
    const root = temporaryRoot();
    const configPath = writeCatalog(root);
    const parsed = loadBackendProfiles({ configPath });

    expect(parsed.profiles.map((profile) => profile.id)).toEqual([
      "local-primary",
      "remote-build",
    ]);
    expect(parsed.profiles[0].expected.capabilities).toEqual([
      "sessions.list",
      "sessions.read",
    ]);

    const projected = parsed.profiles.map(projectBackendProfile);
    const output = JSON.stringify(projected);
    expect(projected[1]).toMatchObject({
      transport: {
        kind: "ssh",
        host: "build.example.test",
        port: 22,
        user: "dure_runner",
        endpoint: { kind: "tcp" },
        batchMode: true,
        strictHostKeyChecking: "yes",
        connectTimeoutMs: 750,
      },
      auth: { kind: "identity_file", referenceKind: "private_key_file" },
      trust: { kind: "known_hosts", referenceKind: "known_hosts_file" },
      deadlineMs: 2_000,
    });
    expect(projected[0].transport.endpoint.id).toMatch(/^e_[a-f0-9]{16}$/);
    expect(projected[1].transport.endpoint.id).toMatch(/^e_[a-f0-9]{16}$/);
    expect(output).not.toContain("/run/dure/backend.sock");
    expect(output).not.toContain("credential-profile:remote-build");
    expect(output).not.toContain("known-hosts-profile:remote-build");
    expect(output).not.toMatch(/\b(?:pane|layout|focus|token)\b/i);
  });

  it("selects explicit CLI id, then DURE_BACKEND_PROFILE, then unique default", () => {
    const parsed = parseBackendProfiles(JSON.stringify(catalog()));

    expect(
      selectBackendProfile(parsed, {
        explicitId: "local-primary",
        environment: { DURE_BACKEND_PROFILE: "remote-build" },
      }),
    ).toMatchObject({ profile: { id: "local-primary" }, source: "cli" });
    expect(
      selectBackendProfile(parsed, {
        environment: { DURE_BACKEND_PROFILE: "remote-build" },
      }),
    ).toMatchObject({ profile: { id: "remote-build" }, source: "environment" });
    expect(selectBackendProfile(parsed, { environment: {} })).toMatchObject({
      profile: { id: "local-primary" },
      source: "default",
    });

    expectCode(
      () =>
        selectBackendProfile(
          parseBackendProfiles(
            JSON.stringify(
              catalog([
                localProfile({ default: false }),
                remoteProfile({ default: false }),
              ]),
            ),
          ),
          { environment: {} },
        ),
      "backend_profiles_selection_missing",
    );
    expectCode(
      () => selectBackendProfile(parsed, { explicitId: "absent", environment: {} }),
      "backend_profiles_selection_not_found",
    );
    expectCode(
      () => selectBackendProfile(parsed, { explicitId: "Bad Selector", environment: {} }),
      "backend_profiles_selector_invalid",
    );
  });

  it("reconciles the selected backend without treating an external profile as local process authority", () => {
    const root = temporaryRoot();
    const configPath = writeCatalog(root);
    const originalCatalog = readFileSync(configPath, "utf8");

    const result = runCli(root, [
      "backend",
      "reconcile",
      "--backend",
      "remote-build",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      apiVersion: "dure.backend-reconcile/v1",
      kind: "dure.backend.reconcile",
      status: "external",
      profile: {
        id: "remote-build",
        source: "cli",
        transportKind: "ssh",
      },
      authority: {
        backendId: "remote-backend",
        generation: "generation-remote-7",
      },
    });
    expect(readFileSync(configPath, "utf8")).toBe(originalCatalog);
    expect(existsSync(join(root, "backend"))).toBe(false);
  });

  it("refuses local bundle activation for an external backend", () => {
    const root = temporaryRoot();
    const configPath = writeCatalog(root);
    const before = readFileSync(configPath);
    const result = runCli(root, ["backend", "activate", "--backend", "remote-build", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe("local_backend_activation_not_managed");
    expect(readFileSync(configPath)).toEqual(before);
    expect(existsSync(join(root, "backend"))).toBe(false);
  });

  it.each([
    ["unknown root field", (value) => (value.extra = true), "backend_profiles_unknown_field"],
    [
      "unknown profile field",
      (value) => (value.profiles[0].credential = "forbidden"),
      "backend_profiles_unknown_field",
    ],
    [
      "duplicate profile id",
      (value) => (value.profiles[1].id = value.profiles[0].id),
      "backend_profiles_profile_id_duplicate",
    ],
    [
      "duplicate defaults",
      (value) => (value.profiles[0].default = true),
      "backend_profiles_default_ambiguous",
    ],
    ["invalid id", (value) => (value.profiles[0].id = "INVALID ID"), "backend_profiles_profile_id_invalid"],
    [
      "invalid transport",
      (value) => (value.profiles[0].transport.kind = "https"),
      "backend_profiles_transport_invalid",
    ],
    [
      "relative endpoint",
      (value) => (value.profiles[1].transport.endpoint.path = "relative.sock"),
      "backend_profiles_endpoint_invalid",
    ],
    [
      "local tcp without a transport authentication contract",
      (value) =>
        (value.profiles[1].transport.endpoint = {
          kind: "tcp",
          host: "127.0.0.1",
          port: 4681,
        }),
      "backend_profiles_transport_invalid",
    ],
    [
      "transport/auth mismatch",
      (value) => (value.profiles[1].auth = { kind: "ssh_agent" }),
      "backend_profiles_auth_invalid",
    ],
    [
      "transport/trust mismatch",
      (value) =>
        (value.profiles[1].trust = {
          kind: "known_hosts",
          reference: "known-hosts-profile:local-primary",
        }),
      "backend_profiles_trust_invalid",
    ],
    [
      "interactive SSH authentication",
      (value) => (value.profiles[0].transport.batchMode = false),
      "backend_profiles_transport_invalid",
    ],
    [
      "permissive SSH host checking",
      (value) => (value.profiles[0].transport.strictHostKeyChecking = "accept-new"),
      "backend_profiles_transport_invalid",
    ],
    [
      "SSH connect timeout beyond the profile deadline",
      (value) => (value.profiles[0].transport.connectTimeoutMs = 2_001),
      "backend_profiles_transport_invalid",
    ],
    [
      "profile deadline beyond the global bound",
      (value) => (value.profiles[0].deadlineMs = MAX_BACKEND_PROFILE_DEADLINE_MS + 1),
      "backend_profiles_profile_invalid",
    ],
    [
      "inverted protocol range",
      (value) => {
        value.profiles[0].expected.protocol.minimum = { major: 3, minor: 0 };
        value.profiles[0].expected.protocol.maximum = { major: 2, minor: 9 };
      },
      "backend_profiles_protocol_invalid",
    ],
    [
      "duplicate capability",
      (value) => value.profiles[0].expected.capabilities.push("sessions.read"),
      "backend_profiles_capabilities_invalid",
    ],
    [
      "oversized string",
      (value) => (value.profiles[0].expected.generation = "x".repeat(129)),
      "backend_profiles_expected_invalid",
    ],
    ["empty profile list", (value) => (value.profiles = []), "backend_profiles_profile_count_invalid"],
    [
      "oversized profile list",
      (value) => {
        value.profiles = Array.from({ length: MAX_BACKEND_PROFILES + 1 }, (_, index) =>
          localProfile({ id: `profile-${index}`, default: index === 0 }),
        );
      },
      "backend_profiles_profile_count_invalid",
    ],
  ])("rejects %s with a typed code", (_name, mutate, code) => {
    const value = catalog();
    mutate(value);
    expectCode(() => parseBackendProfiles(JSON.stringify(value)), code);
  });

  it.each([
    [
      "absolute credential path",
      (value) => (value.profiles[0].auth.reference = "/Users/fixture/.ssh/id_dure"),
      "backend_profiles_auth_invalid",
    ],
    [
      "raw bearer-like credential",
      (value) =>
        (value.profiles[0].auth.reference =
          "eyJhbGciOiJIUzI1NiJ9.payload.signature"),
      "backend_profiles_auth_invalid",
    ],
    [
      "credential/trust namespace mixup",
      (value) =>
        (value.profiles[0].auth.reference =
          "known-hosts-profile:remote-build"),
      "backend_profiles_auth_invalid",
    ],
    [
      "absolute known-hosts path",
      (value) =>
        (value.profiles[0].trust.reference =
          "/Users/fixture/.ssh/known_hosts"),
      "backend_profiles_trust_invalid",
    ],
    [
      "trust/credential namespace mixup",
      (value) =>
        (value.profiles[0].trust.reference =
          "credential-profile:remote-build"),
      "backend_profiles_trust_invalid",
    ],
  ])(
    "rejects %s instead of treating it as profile authority",
    (_name, mutate, code) => {
      const value = catalog();
      mutate(value);
      expectCode(() => parseBackendProfiles(JSON.stringify(value)), code);
    },
  );

  it("applies bounded non-interactive SSH defaults to compatible v1 profiles", () => {
    const value = remoteProfile({
      deadlineMs: undefined,
      transport: {
        kind: "ssh",
        host: "build.example.test",
        port: 22,
        user: "dure_runner",
        endpoint: { kind: "tcp", host: "127.0.0.1", port: 4681 },
      },
    });
    delete value.deadlineMs;
    const parsed = parseBackendProfiles(JSON.stringify(catalog([value])));

    expect(parsed.profiles[0]).toMatchObject({
      deadlineMs: DEFAULT_BACKEND_PROFILE_DEADLINE_MS,
      transport: {
        batchMode: true,
        strictHostKeyChecking: "yes",
        connectTimeoutMs: 5_000,
      },
    });
  });

  it("rejects missing, symlinked, non-owner-readable, and oversized files", () => {
    const root = temporaryRoot();
    const missingPath = join(root, "missing.json");
    expectCode(
      () => loadBackendProfiles({ configPath: missingPath }),
      "backend_profiles_config_missing",
    );

    const configPath = writeCatalog(root);
    chmodSync(configPath, 0o644);
    expectCode(
      () => loadBackendProfiles({ configPath }),
      "backend_profiles_config_unsafe",
    );

    chmodSync(configPath, 0o600);
    const linkPath = join(root, "profiles-link.json");
    symlinkSync(configPath, linkPath);
    expectCode(
      () => loadBackendProfiles({ configPath: linkPath }),
      "backend_profiles_config_unsafe",
    );

    writeFileSync(configPath, "x".repeat(MAX_BACKEND_PROFILES_BYTES + 1), {
      mode: 0o600,
    });
    chmodSync(configPath, 0o600);
    expectCode(
      () => loadBackendProfiles({ configPath }),
      "backend_profiles_config_too_large",
    );
  });

  it("fails closed when the platform cannot provide no-follow opens", () => {
    expectCode(
      () => requireBackendProfileNoFollowFlag(0),
      "backend_profiles_config_untrusted_platform",
    );
  });

  it("rejects malformed UTF-8 before parsing JSON", () => {
    const root = temporaryRoot();
    const configPath = writeCatalog(root);
    writeFileSync(configPath, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), {
      mode: 0o600,
    });
    chmodSync(configPath, 0o600);

    expectCode(
      () => loadBackendProfiles({ configPath }),
      "backend_profiles_utf8_invalid",
    );
  });

  it("lists, shows, and resolves without app state, child processes, or network", () => {
    const root = temporaryRoot();
    writeCatalog(root);
    writeFileSync(join(root, "agents.json"), "not valid app registry json", {
      mode: 0o000,
    });
    expect(existsSync(join(root, "server.json"))).toBe(false);
    const { marker, preload } = installSideEffectFence(root);
    const fencedEnvironment = {
      DURE_PROFILE_SIDE_EFFECT_MARKER: marker,
      NODE_OPTIONS: `--require=${preload}`,
    };

    const firstList = runCli(root, ["profiles", "list", "--json"], fencedEnvironment);
    const secondList = runCli(root, ["profiles", "list", "--json"], fencedEnvironment);
    expect(firstList.status, firstList.stderr).toBe(0);
    expect(secondList.status, secondList.stderr).toBe(0);
    expect(secondList.stdout).toBe(firstList.stdout);
    expect(JSON.parse(firstList.stdout)).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.backend-profiles/v1",
      kind: "dure.backend_profiles.list",
      profiles: [{ id: "local-primary" }, { id: "remote-build" }],
    });

    const shown = runCli(
      root,
      ["profiles", "show", "remote-build", "--json"],
      fencedEnvironment,
    );
    expect(shown.status, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      kind: "dure.backend_profiles.show",
      selection: { source: "cli", id: "remote-build" },
      profile: { id: "remote-build", transport: { kind: "ssh" } },
    });

    const resolved = runCli(
      root,
      ["profiles", "resolve", "--backend", "local-primary", "--json"],
      { ...fencedEnvironment, DURE_BACKEND_PROFILE: "remote-build" },
    );
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      kind: "dure.backend_profiles.resolve",
      selection: { source: "cli", id: "local-primary" },
    });
    expect(resolved.stdout).not.toContain("credential-profile:remote-build");
    expect(resolved.stdout).not.toContain("known-hosts-profile:remote-build");
    expect(existsSync(marker)).toBe(false);
  });

  it("returns versioned typed CLI errors without leaking the config path", () => {
    const root = temporaryRoot();
    const configPath = writeCatalog(
      root,
      catalog([
        localProfile({ default: false }),
        remoteProfile({ default: false }),
      ]),
    );
    const result = runCli(root, ["profiles", "resolve", "--json"], {
      DURE_BACKEND_PROFILE: "",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      apiVersion: "dure.backend-profiles/v1",
      kind: "dure.backend_profiles.error",
      error: {
        code: "backend_profiles_selection_missing",
        message: "no backend profile selector or unique default is available",
      },
    });
    expect(result.stdout).not.toContain(configPath);
  });

  it("tests exactly one remote profile with its isolated SSH references", () => {
    const root = temporaryRoot();
    writeCatalog(
      root,
      catalog([
        namedRemoteProfile("remote-a", { defaultProfile: true }),
        namedRemoteProfile("remote-b"),
      ]),
    );
    const paths = writeSshReferenceCatalog(root, ["remote-a", "remote-b"]);
    const remote = installSshPreflightFixture(root);
    writeFileSync(join(root, "agents.json"), "untrusted app registry", {
      mode: 0o000,
    });

    const result = runCli(
      root,
      ["profiles", "test", "--backend", "remote-b", "--json"],
      {
        DURE_PROFILE_TEST_LOG: remote.logPath,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.backend-profiles/v1",
      kind: "dure.backend_profiles.test",
      status: "ready",
      selection: { source: "cli", id: "remote-b" },
      profile: { id: "remote-b", transport: { kind: "ssh" } },
      backend: {
        id: "remote-b-backend",
        generation: "remote-b-generation-1",
        protocol: { major: 1, minor: 0 },
        capabilities: ["sessions.read"],
      },
    });
    const observations = readFileSync(remote.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations).toHaveLength(1);
    expect(observations[0].request).toMatchObject({
      operation: "backend.ping",
      expected: {
        backendId: "remote-b-backend",
        generation: "remote-b-generation-1",
      },
      body: { schemaVersion: 1 },
    });
    expect(observations[0].matchedMaterial).toBe(true);
    for (const name of ["knownHostsFile", "identityFile"]) {
      expect(observations[0][name]).not.toBe(paths["remote-b"][name]);
      expect(existsSync(observations[0][name])).toBe(false);
      expect(existsSync(paths["remote-b"][name])).toBe(true);
    }
    expect(JSON.stringify(observations[0].argv)).not.toContain(
      paths["remote-a"].knownHostsFile,
    );
    expect(JSON.stringify(observations[0].argv)).not.toContain(
      paths["remote-a"].identityFile,
    );
    expect(result.stdout).not.toContain(paths["remote-b"].knownHostsFile);
    expect(result.stdout).not.toContain(paths["remote-b"].identityFile);
    expect(result.stdout).not.toContain("known-hosts-profile:remote-b");
    expect(result.stdout).not.toContain("credential-profile:remote-b");
    expect(existsSync(join(root, "server.json"))).toBe(false);
  });

  it("tests a local socket profile without app or backend bootstrap", async () => {
    const root = temporaryRoot();
    const socketPath = join(root, "profile-test.sock");
    const profile = localProfile({
      transport: {
        kind: "local",
        endpoint: { kind: "unix_socket", path: socketPath },
      },
      expected: {
        backendId: "local-backend",
        generation: "generation-local-1",
        protocol: {
          minimum: { major: 1, minor: 0 },
          maximum: { major: 1, minor: 0 },
        },
        capabilities: ["sessions.read"],
      },
      deadlineMs: 500,
    });
    writeCatalog(root, catalog([profile]));
    let observedRequest;
    const server = createServer((socket) => {
      let source = "";
      socket.on("data", (chunk) => {
        source += chunk.toString("utf8");
        if (!source.includes("\n")) return;
        observedRequest = JSON.parse(source.trim());
        socket.end(
          JSON.stringify({
            schemaVersion: 1,
            apiVersion: "dure.backend-transport/v1",
            kind: "dure.backend.response",
            requestId: observedRequest.requestId,
            backend: {
              id: "local-backend",
              generation: "generation-local-1",
              protocol: { major: 1, minor: 0 },
              capabilities: ["sessions.read"],
              observedAtMs: Date.now(),
            },
            result: { schemaVersion: 1, status: "ready" },
          }) + "\n",
        );
      });
    });
    await listen(server, socketPath);

    try {
      const result = await runCliAsync(root, [
        "profiles",
        "test",
        "local-primary",
        "--json",
      ]);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "dure.backend_profiles.test",
        status: "ready",
        profile: { id: "local-primary", transport: { kind: "local" } },
        backend: { id: "local-backend", generation: "generation-local-1" },
      });
      expect(observedRequest).toMatchObject({
        operation: "backend.ping",
        body: { schemaVersion: 1 },
      });
      expect(existsSync(join(root, "server.json"))).toBe(false);
      expect(existsSync(join(root, "agents.json"))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    ["wrong_backend", "backend_transport_backend_mismatch"],
    ["wrong_generation", "backend_transport_generation_mismatch"],
    ["wrong_protocol", "backend_transport_protocol_incompatible"],
    ["missing_capability", "backend_transport_capability_missing"],
    ["host_key_rejected", "backend_transport_ssh_failed"],
    ["nonzero", "backend_transport_ssh_failed"],
    ["timeout", "backend_transport_timeout"],
    ["banner", "backend_transport_malformed_response"],
    ["oversize", "backend_transport_output_limit"],
    ["invalid_result", "backend_transport_malformed_response"],
  ])("redacts the %s preflight failure as %s", (mode, code) => {
    const root = temporaryRoot();
    writeCatalog(
      root,
      catalog([
        namedRemoteProfile("remote-a", {
          defaultProfile: true,
          deadlineMs: mode === "timeout" ? 75 : 10_000,
        }),
      ]),
    );
    const paths = writeSshReferenceCatalog(root, ["remote-a"]);
    const remote = installSshPreflightFixture(root);
    const secret = `${paths["remote-a"].identityFile}: untrusted ssh stderr`;
    const result = runCli(root, ["profiles", "test", "remote-a", "--json"], {
      DURE_PROFILE_TEST_LOG: remote.logPath,
      DURE_PROFILE_TEST_MODE: mode,
      DURE_PROFILE_TEST_SECRET: secret,
      PATH: `${remote.bin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.backend-profiles/v1",
      kind: "dure.backend_profiles.test_error",
      status: "failed",
      profile: { id: "remote-a", transport: "ssh" },
      error: { code },
    });
    expect(result.stdout).not.toContain(paths["remote-a"].identityFile);
    expect(result.stdout).not.toContain(paths["remote-a"].knownHostsFile);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain("untrusted banner");
  });

  it("fails closed on unresolved references, selectors, and missing config", () => {
    const root = temporaryRoot();
    writeCatalog(
      root,
      catalog([namedRemoteProfile("remote-a", { defaultProfile: true })]),
    );
    const remote = installSshPreflightFixture(root);
    const unresolved = runCli(
      root,
      ["profiles", "test", "remote-a", "--json"],
      {
        DURE_PROFILE_TEST_LOG: remote.logPath,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );
    expect(unresolved.status).toBe(2);
    expect(JSON.parse(unresolved.stdout)).toMatchObject({
      kind: "dure.backend_profiles.test_error",
      error: { code: "backend_transport_reference_unavailable" },
    });
    expect(existsSync(remote.logPath)).toBe(false);

    const absent = runCli(root, ["profiles", "test", "absent", "--json"]);
    expect(absent.status).toBe(2);
    expect(JSON.parse(absent.stdout)).toMatchObject({
      kind: "dure.backend_profiles.error",
      error: { code: "backend_profiles_selection_not_found" },
    });

    const emptyRoot = temporaryRoot();
    const missing = runCli(emptyRoot, ["profiles", "test", "--json"]);
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      kind: "dure.backend_profiles.error",
      error: { code: "backend_profiles_config_missing" },
    });
    expect(existsSync(join(emptyRoot, "backend-profiles.json"))).toBe(false);
    expect(existsSync(join(emptyRoot, "server.json"))).toBe(false);
  });

  it("documents the preflight command without touching profile state", () => {
    const root = temporaryRoot();
    const help = runCli(root, ["profiles", "help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("<list|show|resolve|test>");
    expect(existsSync(join(root, "backend-profiles.json"))).toBe(false);
    expect(existsSync(join(root, "server.json"))).toBe(false);
  });

  it("keeps the pure profile module free of legacy names and execution imports", () => {
    const source = readFileSync(modulePath, "utf8");
    expect(source).not.toMatch(/HEBBIAN_/);
    expect(source).not.toMatch(
      /node:(?:child_process|cluster|dgram|dns|http|https|net|tls|worker_threads)/,
    );
    expect(source).not.toMatch(/\b(?:fetch|spawn|execFile|createConnection)\s*\(/);
  });
});
