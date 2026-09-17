import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_BUILD_ID,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_IDENTITY_API_VERSION,
  CONTROL_PLANE_IDENTITY_KIND,
} from "../cli/lib/control-plane-contract.mjs";
import {
  resolveHmuxToolchainIdentity,
  selectBackendProfileForRequest,
} from "../cli/lib/local-backend.mjs";

const cleanups = [];
const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture({
  capabilities = [...CONTROL_PLANE_CAPABILITIES, "future.operation"],
  protocol = { major: 1, minor: 0 },
  status = "ready",
  reportedGeneration,
  onRequest,
  sameBuild = false,
  differentClientExecutable = false,
} = {}) {
  const root = realpathSync(mkdtempSync("/tmp/dure-bc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const backend = join(root, "backend");
  const discovery = join(root, "discovery");
  mkdirSync(backend, { mode: 0o700 });
  mkdirSync(discovery, { mode: 0o700 });
  const hmux = join(root, "hmux");
  writeFileSync(hmux, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const controlPlane = join(root, "control-plane");
  const environment = {
    HOME: root,
    DURE_HOME: root,
    HMUX_DISCOVERY_ROOT: discovery,
    DURE_HMUX_BIN: hmux,
    DURE_HMUX_RUNTIME_BIN: hmux,
    DURE_CONTROL_PLANE_BIN: controlPlane,
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
  };
  const hmuxIdentity = resolveHmuxToolchainIdentity(environment);
  const log = join(root, "commands.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    controlPlane,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const receipts = ${JSON.stringify({
      identity: {
        schemaVersion: 1,
        apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
        kind: CONTROL_PLANE_IDENTITY_KIND,
        buildId: CONTROL_PLANE_BUILD_ID,
        capabilities: CONTROL_PLANE_CAPABILITIES,
      },
      preflight: {
        schemaVersion: 1,
        kind: "dure.control_plane.preflight",
        buildId: CONTROL_PLANE_BUILD_ID,
        descriptorSchemaVersion: 5,
        hmuxIdentity,
      },
    })};
console.log(JSON.stringify(receipts[process.argv[2]]));
process.exit(receipts[process.argv[2]] ? 0 : 9);
`,
    { mode: 0o700 },
  );
  // Node treats the executable without an extension as ESM through this fixture's package.
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const controlPlaneIdentity = Object.fromEntries(
    Object.entries(
      resolveHmuxToolchainIdentity({
        ...environment,
        DURE_HMUX_BIN: controlPlane,
      }),
    ).filter(([key]) => key.startsWith("executable")),
  );
  const generation = "local-v1-11111111111111111111111111111111";
  const socketPath = join(
    backend,
    `cp.${createHash("sha256").update(generation).digest("hex").slice(0, 32)}.sock`,
  );
  const descriptor = {
    schemaVersion: 4,
    backendId: "dure-local",
    buildId: sameBuild ? CONTROL_PLANE_BUILD_ID : CONTROL_PLANE_BUILD_ID.replace(
      /\/v(\d+)-/,
      (_, sequence) => `/v${Number(sequence) + 1}-`,
    ),
    generation,
    socketPath,
    databasePath: join(backend, "application-state.sqlite3"),
    controlPlaneIdentity,
    ...Object.fromEntries(
      Object.entries(hmuxIdentity).map(([key, value]) => [
        `hmux${key[0].toUpperCase()}${key.slice(1)}`,
        value,
      ]),
    ),
    processId: process.pid,
    observedAtMs: Date.now(),
  };
  const descriptorPath = join(backend, "control-plane.json");
  const writeDescriptor = () =>
    writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  writeDescriptor();
  const requests = [];
  const server = createServer((socket) => {
    let source = "";
    socket.on("data", (chunk) => {
      source += chunk.toString();
      if (!source.includes("\n")) return;
      const request = JSON.parse(source.trim());
      requests.push(request);
      if (onRequest?.({ descriptor, writeDescriptor, socket }) === false) return;
      socket.end(
        `${JSON.stringify({
          schemaVersion: 1,
          apiVersion: "dure.backend-transport/v1",
          kind: "dure.backend.response",
          requestId: request.requestId,
          backend: {
            id: "dure-local",
            generation: reportedGeneration ?? generation,
            protocol,
            capabilities,
            observedAtMs: Date.now(),
          },
          result: { schemaVersion: 1, status },
        })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  if (differentClientExecutable) {
    environment.DURE_CONTROL_PLANE_BIN = join(root, "client-control-plane");
    writeFileSync(
      environment.DURE_CONTROL_PLANE_BIN,
      `${readFileSync(controlPlane, "utf8")}\n// Another verified bundle's payload.\n`,
      { mode: 0o700 },
    );
  }
  return {
    root,
    descriptor,
    descriptorPath,
    writeDescriptor,
    environment,
    requests,
    log,
    closeBackend: () => new Promise((resolve) => server.close(resolve)),
    runCli: (command) => execFileAsync(process.execPath, [cliPath, "backend", command, "--json"], {
      env: environment,
      timeout: 10_000,
    }),
    select: (activateCurrentBundle = false) =>
      selectBackendProfileForRequest({
        cliScriptPath: join(root, "dure.mjs"),
        environment,
        activateCurrentBundle,
      }),
  };
}

describe("older CLI joining a newer local backend", () => {
  it("uses a ready compatible generation without running the older binary or rewriting its descriptor", async () => {
    const state = await fixture();
    const before = readFileSync(state.descriptorPath);
    const selection = await state.select();
    expect(selection.managedLocal).toBe(true);
    expect(selection.profile.expected.generation).toBe(state.descriptor.generation);
    expect(new Set(state.requests.map((request) => request.operation))).toEqual(
      new Set(["backend.ping"]),
    );
    expect(readFileSync(state.log, "utf8")).toBe("");
    expect(readFileSync(state.descriptorPath)).toEqual(before);
  });

  it("preserves a newer owner's catalog capability superset", async () => {
    const state = await fixture();
    await state.select();
    const catalogPath = join(state.root, "backend-profiles.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.profiles[0].expected.capabilities.push("future.operation");
    writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    const before = readFileSync(catalogPath);
    expect((await state.select()).managedLocal).toBe(true);
    expect(readFileSync(catalogPath)).toEqual(before);
  });

  it.each([
    [
      { capabilities: CONTROL_PLANE_CAPABILITIES.slice(1) },
      "backend_transport_capability_missing",
    ],
    [{ protocol: { major: 2, minor: 0 } }, "backend_transport_protocol_incompatible"],
    [
      { reportedGeneration: "local-v1-22222222222222222222222222222222" },
      "backend_transport_generation_mismatch",
    ],
    [{ status: "recovering" }, "local_backend_unavailable"],
  ])(
    "refuses an incompatible or unready service without invoking the older binary (%j)",
    async (options, code) => {
      const state = await fixture(options);
      const before = readFileSync(state.descriptorPath);
      await expect(state.select()).rejects.toMatchObject({ code });
      expect(readFileSync(state.log, "utf8")).toBe("");
      expect(readFileSync(state.descriptorPath)).toEqual(before);
    },
  );

  it("refuses a generation descriptor changed during the handshake", async () => {
    const state = await fixture({
      onRequest: ({ descriptor, writeDescriptor }) => {
        descriptor.processId += 1;
        writeDescriptor();
      },
    });
    await expect(state.select()).rejects.toMatchObject({
      code: "local_backend_descriptor_changed",
    });
    expect(readFileSync(state.log, "utf8")).toBe("");
  });

  it("refuses a changed executable before connecting", async () => {
    const state = await fixture();
    state.descriptor.controlPlaneIdentity.executableSha256 = "0".repeat(64);
    state.writeDescriptor();
    await expect(state.select()).rejects.toMatchObject({
      code: "local_backend_executable_changed",
    });
    expect(state.requests).toEqual([]);
  });

  it("refuses a legacy descriptor without executable identity", async () => {
    const state = await fixture();
    state.descriptor.schemaVersion = 3;
    delete state.descriptor.controlPlaneIdentity;
    state.writeDescriptor();
    await expect(state.select()).rejects.toMatchObject({ code: "cli_update_required" });
    expect(state.requests).toEqual([]);
  });

  it("refuses a descriptor that is not owner-only", async () => {
    const state = await fixture();
    chmodSync(state.descriptorPath, 0o644);
    await expect(state.select()).rejects.toMatchObject({
      code: "local_backend_descriptor_unsafe",
    });
    expect(state.requests).toEqual([]);
    expect(readFileSync(state.log, "utf8")).toBe("");
  });

  it("refuses malformed local state at the lifecycle boundary", async () => {
    const state = await fixture();
    writeFileSync(state.descriptorPath, "{}");
    await expect(state.select()).rejects.toMatchObject({
      code: "local_backend_descriptor_invalid",
    });
    expect(state.requests).toEqual([]);
    expect(readFileSync(state.log, "utf8")).toBe("");
  });

  it("does not launch the older binary when the newer endpoint is absent", async () => {
    const state = await fixture();
    await state.closeBackend();
    const before = readFileSync(state.descriptorPath);
    await expect(state.select()).rejects.toMatchObject({
      code: "backend_transport_unavailable",
    });
    expect(readFileSync(state.log, "utf8")).toBe("");
    expect(readFileSync(state.descriptorPath)).toEqual(before);
  });

  it("refuses a different discovery root before connecting", async () => {
    const state = await fixture();
    const otherRoot = join(state.root, "other-discovery");
    mkdirSync(otherRoot, { mode: 0o700 });
    state.environment.HMUX_DISCOVERY_ROOT = otherRoot;
    await expect(state.select()).rejects.toMatchObject({
      code: "local_backend_executable_changed",
    });
    expect(state.requests).toEqual([]);
  });

  it("leaves an unfinished activation to its newer lifecycle owner", async () => {
    const state = await fixture();
    state.descriptor.activationSourceGeneration =
      "local-v1-22222222222222222222222222222222";
    state.writeDescriptor();
    const intentRoot = join(state.root, "backend", "replacement-intents");
    mkdirSync(intentRoot, { mode: 0o700 });
    writeFileSync(
      join(intentRoot, `${state.descriptor.activationSourceGeneration}.json`),
      "{}",
      { mode: 0o600 },
    );
    await expect(state.select()).rejects.toMatchObject({ code: "recovering" });
    expect(state.requests).toEqual([]);
  });
});

describe("compatible same-build backend reuse", () => {
  it.each([false, true])(
    "keeps the healthy generation without running bundle executables (different payload: %s)",
    async (differentClientExecutable) => {
      const state = await fixture({
        sameBuild: true,
        differentClientExecutable,
        capabilities: CONTROL_PLANE_CAPABILITIES,
      });
      const before = readFileSync(state.descriptorPath);
      const selected = await state.select();
      expect(selected.profile.expected.generation).toBe(state.descriptor.generation);
      expect(state.requests.map((request) => request.operation)).toEqual(["backend.ping"]);
      expect(readFileSync(state.descriptorPath)).toEqual(before);
      expect(readFileSync(state.log, "utf8")).toBe("");
      expect(existsSync(join(state.root, "backend", "replacement-intents"))).toBe(false);
    },
    10_000,
  );

  it("still stages an explicitly requested verified payload activation", async () => {
    const state = await fixture({
      sameBuild: true,
      differentClientExecutable: true,
      capabilities: CONTROL_PLANE_CAPABILITIES,
    });
    const before = readFileSync(state.descriptorPath);
    // The bounded executable records serve and exits; it never runs a real service.
    await expect(state.runCli("activate")).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('"code":"recovering"'),
    });
    const commands = readFileSync(state.log, "utf8").trim().split("\n").map(JSON.parse);
    const launches = commands.filter((args) => args[0] === "serve");
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain("--staged");
    expect(launches[0]).toContain(state.descriptor.generation);
    const intent = JSON.parse(readFileSync(join(
      state.root, "backend", "replacement-intents", `${state.descriptor.generation}.json`,
    ), "utf8"));
    expect(intent.source.buildId).toBe(CONTROL_PLANE_BUILD_ID);
    expect(intent.target.buildId).toBe(CONTROL_PLANE_BUILD_ID);
    expect(intent.target.controlPlaneIdentity.executablePath).toBe(state.environment.DURE_CONTROL_PLANE_BIN);
    expect(readFileSync(state.descriptorPath)).toEqual(before);
  }, 10_000);

  it("does not accept a shared socket just because the build is compatible", async () => {
    const state = await fixture({ sameBuild: true, differentClientExecutable: true });
    chmodSync(state.descriptor.socketPath, 0o660);
    await expect(state.select()).rejects.toMatchObject({ code: "backend_transport_peer_untrusted" });
    expect(readFileSync(state.log, "utf8")).toBe("");
  }, 10_000);

  it("refuses activation of a default external profile before touching a local owner", async () => {
    const state = await fixture({ sameBuild: true, differentClientExecutable: true });
    await state.select();
    const catalogPath = join(state.root, "backend-profiles.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const managed = catalog.profiles[0];
    managed.default = false;
    catalog.profiles.push({
      ...structuredClone(managed), id: "external", default: true,
      expected: { ...managed.expected, backendId: "external" },
    });
    writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    const requestsBefore = state.requests.length;
    await expect(state.select(true)).rejects.toMatchObject({ code: "local_backend_activation_not_managed" });
    expect(state.requests).toHaveLength(requestsBefore);
    expect(readFileSync(state.log, "utf8")).toBe("");
  });

  it("reconciles from the real CLI without activating another same-build payload", async () => {
    const state = await fixture({ sameBuild: true, differentClientExecutable: true });
    const before = readFileSync(state.descriptorPath);
    const result = await state.runCli("reconcile");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready", authority: { generation: state.descriptor.generation },
    });
    expect(readFileSync(state.descriptorPath)).toEqual(before);
    expect(readFileSync(state.log, "utf8")).toBe("");
  });

  it("does not replace or replay on an incomplete response, and a later request can reconnect", async () => {
    let interrupted = false;
    const state = await fixture({
      sameBuild: true,
      differentClientExecutable: true,
      capabilities: CONTROL_PLANE_CAPABILITIES,
      onRequest: ({ socket }) => {
        if (interrupted) return;
        interrupted = true;
        socket.destroy();
        return false;
      },
    });
    const before = readFileSync(state.descriptorPath);
    await expect(state.select()).rejects.toMatchObject({ code: "backend_transport_malformed_response" });
    expect(state.requests).toHaveLength(1);
    expect(readFileSync(state.log, "utf8")).toBe("");
    expect((await state.select()).profile.expected.generation).toBe(state.descriptor.generation);
    expect(readFileSync(state.descriptorPath)).toEqual(before);
    const commands = readFileSync(state.log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    expect(commands.filter((args) => args[0] === "serve")).toEqual([]);
  });

  it("keeps exact-generation restart when the matching endpoint is unavailable", async () => {
    const state = await fixture({ sameBuild: true, capabilities: CONTROL_PLANE_CAPABILITIES });
    await state.closeBackend();
    await expect(state.select()).rejects.toMatchObject({ code: "recovering" });
    const commands = readFileSync(state.log, "utf8").trim().split("\n").map(JSON.parse);
    const launches = commands.filter((args) => args[0] === "serve");
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain(state.descriptor.generation);
    expect(launches[0]).not.toContain("--staged");
  }, 10_000);

  it.each([
    [{ capabilities: CONTROL_PLANE_CAPABILITIES.slice(1) }, "backend_transport_capability_missing"],
    [{ protocol: { major: 2, minor: 0 } }, "backend_transport_protocol_incompatible"],
    [{ status: "recovering" }, "local_backend_unavailable"],
  ])("refuses a same-build owner whose handshake is not compatible (%j)", async (options, code) => {
    const state = await fixture({ ...options, sameBuild: true, differentClientExecutable: true });
    await expect(state.select()).rejects.toMatchObject({ code });
    expect(readFileSync(state.log, "utf8")).toBe("");
  });
});
