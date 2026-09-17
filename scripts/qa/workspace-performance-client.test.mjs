import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readWorkspacePerformanceDescriptor } from "./lib/workspace-performance-descriptor.mjs";

const client = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "workspace-performance-client.mjs",
);
const roots = [];
const servers = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe("workspace performance descriptor file boundary", () => {
  test("rejects a parent moved outside the state root before open", async () => {
    const fixture = await createFixture();
    const descriptorPath = fixtureDescriptorPath(fixture);
    writeDescriptor(descriptorPath, { port: 1, token: "original" });
    const originalOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((filename, flags, mode) => {
      const parent = path.dirname(descriptorPath);
      const movedParent = path.join(fixture.root, "moved-channel");
      fs.renameSync(parent, movedParent);
      fs.symlinkSync(movedParent, parent);
      return originalOpen(filename, flags, mode);
    });

    expect(() => readDescriptor(fixture, descriptorPath)).toThrow(
      "workspace performance server descriptor path contains a symlink",
    );
  });

  test("rejects a leaf inode replaced between admission and open", async () => {
    const fixture = await createFixture();
    const descriptorPath = fixtureDescriptorPath(fixture);
    const replacementPath = path.join(fixture.root, "replacement-server.json");
    writeDescriptor(descriptorPath, { port: 1, token: "original" });
    writeDescriptor(replacementPath, { port: 2, token: "replacement" });
    const originalOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((filename, flags, mode) => {
      fs.renameSync(descriptorPath, `${descriptorPath}.replaced`);
      fs.renameSync(replacementPath, descriptorPath);
      return originalOpen(filename, flags, mode);
    });

    expect(() => readDescriptor(fixture, descriptorPath)).toThrow(
      "workspace performance server descriptor changed before read",
    );
  });

  test("rejects a descriptor made group-readable before open", async () => {
    const fixture = await createFixture();
    const descriptorPath = fixtureDescriptorPath(fixture);
    writeDescriptor(descriptorPath, { port: 1, token: "original" });
    const originalOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((filename, flags, mode) => {
      fs.chmodSync(descriptorPath, 0o640);
      return originalOpen(filename, flags, mode);
    });

    expect(() => readDescriptor(fixture, descriptorPath)).toThrow(
      "server descriptor is not owner-only",
    );
  });

  test("rejects a descriptor leaf that is a symlink", async () => {
    const fixture = await createFixture();
    const descriptorPath = fixtureDescriptorPath(fixture);
    const outsideDescriptor = path.join(fixture.root, "outside-server.json");
    writeDescriptor(outsideDescriptor, { port: 1, token: "outside" });
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outsideDescriptor, descriptorPath);

    expect(() => readDescriptor(fixture, descriptorPath)).toThrow(
      "workspace performance server descriptor path contains a symlink",
    );
  });

  test("rejects a descriptor leaf that is not a regular file", async () => {
    const fixture = await createFixture();
    const descriptorPath = fixtureDescriptorPath(fixture);
    fs.mkdirSync(descriptorPath, { recursive: true, mode: 0o700 });

    expect(() => readDescriptor(fixture, descriptorPath)).toThrow(
      "workspace performance server descriptor is not a regular file",
    );
  });
});

describe("workspace performance client descriptor authority", () => {
  test("contacts the isolated descriptor exported by the app runner", async () => {
    const fixture = await createFixture();
    const trap = await createEndpoint("stable trap");
    const selected = await createEndpoint("selected channel");
    const stableDescriptor = path.join(fixture.home, ".dure", "server.json");
    const selectedDescriptor = path.join(
      fixture.home,
      ".dure",
      "channels",
      "qa-test",
      "server.json",
    );
    writeDescriptor(stableDescriptor, trap);
    writeDescriptor(selectedDescriptor, selected);

    const result = await runClient(fixture, selectedDescriptor);

    expect({
      code: result.code,
      signal: result.signal,
      stableTrapRequests: trap.requests.length,
      selectedChannelRequests: selected.requests.length,
      stderr: result.stderr,
    }).toEqual({
      code: 1,
      signal: null,
      stableTrapRequests: 0,
      selectedChannelRequests: 1,
      stderr: expect.stringContaining("selected channel endpoint observed"),
    });
  });

  test("preserves sibling performance evidence from the server receipt", async () => {
    const fixture = await createFixture();
    const multiWindow = {
      complete: true,
      missingWindowLabels: [],
      windows: [
        {
          eventLoopLag: {
            recentMaxMs: 9,
            recentP95Ms: 4,
            sampleCount: 64,
            visible: true,
          },
          windowLabel: "main",
        },
      ],
    };
    const selected = await createEndpoint("multi-window", {
      multiWindow,
    });
    const selectedDescriptor = fixtureDescriptorPath(fixture);
    writeDescriptor(selectedDescriptor, selected);

    const result = await runClient(fixture, selectedDescriptor);
    const evidence = JSON.parse(
      fs.readFileSync(path.join(fixture.evidence, "last-status.json"), "utf8"),
    );

    expect({ code: result.code, signal: result.signal }).toEqual({
      code: 1,
      signal: null,
    });
    expect(evidence.report.multiWindow).toEqual(multiWindow);
  });

  test("rejects a descriptor outside the isolated Dure state before network access", async () => {
    const fixture = await createFixture();
    const trap = await createEndpoint("outside trap");
    const outsideDescriptor = path.join(fixture.root, "outside", "server.json");
    writeDescriptor(path.join(fixture.home, ".dure", "server.json"), trap);
    writeDescriptor(outsideDescriptor, trap);

    const result = await runClient(fixture, outsideDescriptor);

    expect({ code: result.code, signal: result.signal }).toEqual({
      code: 1,
      signal: null,
    });
    expect(result.stderr).toContain(
      "workspace performance server descriptor escaped its isolated Dure state",
    );
    expect(trap.requests).toEqual([]);
  });

  test("rejects a descriptor reached through a symlink before network access", async () => {
    const fixture = await createFixture();
    const trap = await createEndpoint("symlink trap");
    const outsideRoot = path.join(fixture.root, "outside");
    const outsideDescriptor = path.join(outsideRoot, "server.json");
    writeDescriptor(path.join(fixture.home, ".dure", "server.json"), trap);
    writeDescriptor(outsideDescriptor, trap);
    fs.symlinkSync(outsideRoot, path.join(fixture.home, ".dure", "linked"));

    const result = await runClient(
      fixture,
      path.join(fixture.home, ".dure", "linked", "server.json"),
    );

    expect({ code: result.code, signal: result.signal }).toEqual({
      code: 1,
      signal: null,
    });
    expect(result.stderr).toContain(
      "workspace performance server descriptor path contains a symlink",
    );
    expect(trap.requests).toEqual([]);
  });

  test("fails closed when the app runner descriptor authority is absent", async () => {
    const fixture = await createFixture();
    const trap = await createEndpoint("stable fallback trap");
    writeDescriptor(path.join(fixture.home, ".dure", "server.json"), trap);

    const result = await runClient(fixture);

    expect({ code: result.code, signal: result.signal }).toEqual({
      code: 1,
      signal: null,
    });
    expect(result.stderr).toContain("DURE_QA_SERVER_DESCRIPTOR is required");
    expect(trap.requests).toEqual([]);
  });
});

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-perf-descriptor-"));
  roots.push(root);
  const home = path.join(root, "home");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(path.join(home, ".dure"), { recursive: true, mode: 0o700 });
  return { evidence, home, root };
}

async function createEndpoint(label, receipt = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        ...receipt,
        qaStatus: {
          state: "failed",
          phase: "descriptor_authority",
          error: `${label} endpoint observed`,
        },
        report: {},
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return {
    port: server.address().port,
    requests,
    token: `${label}-token`,
  };
}

function writeDescriptor(filename, endpoint) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    filename,
    `${JSON.stringify({ port: endpoint.port, token: endpoint.token })}\n`,
    { mode: 0o600 },
  );
}

function fixtureDescriptorPath(fixture) {
  return path.join(
    fixture.home,
    ".dure",
    "channels",
    "qa-test",
    "server.json",
  );
}

function readDescriptor(fixture, descriptorPath) {
  return readWorkspacePerformanceDescriptor({
    descriptorPath,
    home: fixture.home,
    stateRoot: fixture.root,
  });
}

async function runClient(fixture, descriptorPath) {
  const child = spawn(process.execPath, [client], {
    env: {
      ...process.env,
      DURE_QA_EVIDENCE_DIR: fixture.evidence,
      DURE_QA_STATE_ROOT: fixture.root,
      HOME: fixture.home,
      ...(descriptorPath
        ? { DURE_QA_SERVER_DESCRIPTOR: descriptorPath }
        : { DURE_QA_SERVER_DESCRIPTOR: "" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (closedCode, closedSignal) =>
      resolve({ code: closedCode, signal: closedSignal }),
    );
  });
  return { code, signal, stderr, stdout };
}
