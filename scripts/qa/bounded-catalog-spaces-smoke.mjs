import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSpaceQuery } from "../../cli/lib/space-query.mjs";
import { inspectionBackendFixture } from "./lib/session-inspection-backend.mjs";

// The Rust integration test publishes 160 manifests through DiscoveryRoot's
// typed publication API before invoking this bounded, disposable native proof.
const root = realpathSync(process.argv[2]);
assert.ok(basename(root).startsWith("dure-bounded-catalog-"));
const hmux = realpathSync(process.argv[3]);
const runtime = realpathSync(process.argv[4]);
const executable = realpathSync(process.argv[5]);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const discovery = join(root, "discovery");
const environment = {
  PATH: process.env.PATH, HOME: join(root, "home"), SHELL: "/bin/sh",
  DURE_HOME: join(root, "dure"), DURE_APP_CHANNEL: "stable",
  HMUX_DISCOVERY_ROOT: discovery, DURE_HMUX_BIN: hmux,
};
for (const directory of [environment.HOME, environment.DURE_HOME]) mkdirSync(directory, { mode: 0o700 });
const cli = join(repository, "cli/dure.mjs");
const captureLimit = 1024 * 1024;
const catalogLimit = 960 * 1024;
const registryPath = join(environment.DURE_HOME, "agents.json");

function command(file, args, expectedStatus = 0, maxBuffer = captureLimit) {
  const result = spawnSync(file, args, {
    cwd: root, env: environment, encoding: "utf8", timeout: 15_000, maxBuffer,
  });
  assert.equal(result.error, undefined, "native QA command completed within its bounds");
  assert.equal(result.status, expectedStatus, `${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function readCli(args, expectedStatus = 0) {
  return JSON.parse(command(process.execPath, [cli, ...args, "--json"], expectedStatus));
}

function registry(profile, bound = true) {
  const pane = (index) => ({
    id: `term:${index}`, type: "terminal", component: "terminal", title: `Fixture ${index}`, agentId: null,
    binding: { schemaVersion: 1, runtime: "hmux_managed_v1", source: profile === "qa-ssh" ? "ssh" : "local",
      hostId: profile === "qa-ssh" ? profile : "local", workspaceId: "workspace", sessionId: `session-${index}` },
  });
  return { version: 3, updatedAt: Date.now(), agents: [], clientPresentation: {
    schemaVersion: 3, complete: true,
    spaces: [{ id: "desk-catalog", name: "Catalog", kind: "desktop", windowLabel: "main", panes: bound ? [pane(159), pane(158)] : [] }],
    limits: { maxSpaces: 64, maxPanesPerSpace: 128, maxTotalPanes: 512 },
    truncation: { spaces: false, panes: false, omittedSpaceCount: 0, omittedPaneCount: 0 },
  } };
}

function writeRegistry(profile, bound = true) {
  const value = registry(profile, bound);
  writeFileSync(registryPath, JSON.stringify(value), { mode: 0o600 });
  return value;
}

function manifestWitness() {
  const manifests = [];
  const visit = (path, depth) => {
    assert.ok(depth <= 8, "bounded fixture directory depth");
    const entries = readdirSync(path, { withFileTypes: true });
    assert.ok(entries.length <= 1024, "bounded fixture directory width");
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.name === "manifest.json") {
        const bytes = readFileSync(child);
        assert.ok(bytes.length <= 64 * 1024);
        manifests.push([child, createHash("sha256").update(bytes).digest("hex")]);
        assert.ok(manifests.length <= 160);
      }
    }
  };
  visit(discovery, 0);
  assert.equal(manifests.length, 160);
  return manifests.sort(([left], [right]) => left.localeCompare(right));
}

function assertBounded(report) {
  assert.equal(report.kind, "dure.sessions.list");
  assert.equal(report.complete, true);
  assert.equal(report.partial, true);
  assert.equal(report.truncation.items, true);
  assert.ok(report.sessions.length > 0 && report.sessions.length <= 128);
  assert.equal(report.truncation.omittedCount, 160 - report.sessions.length);
  const identities = report.sessions.map((session) => `${session.workspaceId}/${session.sessionId}`);
  assert.equal(new Set(identities).size, identities.length);
  return identities;
}

// Keep the executable immutable after the backend records its identity. A
// fixture flag recreates only the old unbounded producer invocation; stdout
// still streams from the real native Hmux into the real 1 MiB backend capture.
const unboundedFlag = join(root, "legacy-unbounded");
const wrapper = join(root, "hmux-fixture");
const wrapperModule = join(root, "hmux-fixture.mjs");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(wrapperModule)} "$@"\n`, { mode: 0o700 });
writeFileSync(wrapperModule, `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const args = process.argv.slice(2);
const index = args.indexOf('--catalog-query-json');
if (index >= 0 && existsSync(${JSON.stringify(unboundedFlag)})) args.splice(index, 2);
const child = spawn(${JSON.stringify(hmux)}, args, { stdio: 'inherit' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
`, { mode: 0o600 });
const backend = inspectionBackendFixture({ root, environment, executable, hmux: wrapper, runtime });
const before = manifestWitness();
const results = [];
let passed = false;
try {
  const full = command(hmux, ["--discovery-root", discovery, "--json", "session", "list", "--no-probe"], 0, 4 * captureLimit);
  assert.equal(JSON.parse(full).length, 160);
  assert.ok(Buffer.byteLength(full) > captureLimit, "actual catalog exceeds the original capture cap");
  await backend.start();
  // Exercise the negotiated bounded-catalog contract, including priorities.
  // The shared inspection fixture otherwise requests only basic list/show.
  const profilesPath = join(environment.DURE_HOME, "backend-profiles.json");
  const profiles = JSON.parse(readFileSync(profilesPath, "utf8"));
  for (const profile of profiles.profiles) profile.expected.capabilities.push(
    "sessions.list.bounded_catalog_v1", "sessions.list.pagination_v1",
  );
  writeFileSync(profilesPath, JSON.stringify(profiles), { mode: 0o600 });
  writeRegistry("qa-local");
  writeFileSync(unboundedFlag, "QA only", { mode: 0o600 });
  const red = readCli(["spaces", "list", "--backend", "qa-local"], 2);
  assert.equal(red.error.code, "backend_transport_remote_error");
  assert.equal(red.error.remoteCode, "hmux_session_query_output_limit");
  results.push({ phase: "red", path: "backend-local spaces list", fullBytes: Buffer.byteLength(full), error: red.error.remoteCode });
  unlinkSync(unboundedFlag);

  const query = { schemaVersion: 1, maxItems: 128, maxOutputBytes: catalogLimit,
    prioritized: [{ workspaceId: "workspace", sessionId: "session-159" }, { workspaceId: "workspace", sessionId: "session-158" }] };
  const raw = command(hmux, ["--discovery-root", discovery, "--json", "session", "list", "--no-probe", "--catalog-query-json", JSON.stringify(query)]);
  const catalog = JSON.parse(raw);
  assert.ok(Buffer.byteLength(raw) <= catalogLimit);
  assert.equal(catalog.prioritizedItems, 2);
  assert.deepEqual(catalog.sessions.slice(0, 2).map((row) => row.session_id), ["session-159", "session-158"]);

  for (const profile of [null, "qa-local", "qa-ssh"]) {
    const args = profile ? ["--backend", profile] : [];
    writeRegistry(profile);
    const saved = readFileSync(registryPath);
    let expected;
    for (let repetition = 0; repetition < 3; repetition += 1) {
      const report = readCli(["sessions", "list", ...args]);
      const identities = assertBounded(report);
      assert.deepEqual(identities.slice(0, 2).sort(), ["workspace/session-158", "workspace/session-159"]);
      if (expected) assert.deepEqual(identities, expected, "deterministic selection across repetitions");
      expected = identities;
      const list = readCli(["spaces", "list", ...args]);
      assert.equal(list.kind, "dure.spaces.list");
      assert.equal(list.partial, true);
      assert.equal(list.truncation.runtimeSessions.omittedCount, report.truncation.omittedCount);
      const show = readCli(["spaces", "show", "desk-catalog", ...args]);
      assert.deepEqual(show.space.panes.map((pane) => pane.runtime.session.sessionId), ["session-159", "session-158"]);
      assert.deepEqual(readFileSync(registryPath), saved, "inspection does not rewrite pane membership");
    }

    // A complete census can be a partial projection. A new pane may bind after
    // that projection was acquired: consume the real native snapshot as-is.
    writeRegistry(profile, false);
    const snapshot = readCli(["sessions", "list", ...args]);
    assertBounded(snapshot);
    assert.ok(!snapshot.sessions.some((session) => session.sessionId === "session-159"));
    const savedRegistry = writeRegistry(profile);
    const paged = [];
    let cursor = "start";
    for (let page = 0; cursor !== null && page < 10; page += 1) {
      const report = readCli(["ls", "--cursor", cursor, ...args]);
      paged.push(...report.sessions.map((session) => `${session.workspaceId}/${session.sessionId}`));
      assert.equal(report.truncation.omittedCount, 160 - paged.length);
      assert.equal(report.inventoryComplete, report.pagination.nextCursor === null);
      cursor = report.pagination.nextCursor;
    }
    assert.equal(cursor, null);
    assert.deepEqual(paged, Array.from({ length: 160 }, (_, index) =>
      `workspace/session-${String(index).padStart(3, "0")}`));
    const late = await collectSpaceQuery({ action: "show", spaceId: "desk-catalog",
      registry: { state: "available", clientId: "qa-client", updatedAtMs: savedRegistry.updatedAt,
        clientPresentation: savedRegistry.clientPresentation }, collectSessions: async () => snapshot });
    assert.deepEqual(late.space.panes.map((pane) => [pane.runtime.state, pane.runtime.reason]), [
      ["unavailable", "runtime_snapshot_partial"], ["unavailable", "runtime_snapshot_partial"],
    ]);
    results.push({ phase: "green", path: profile ?? "direct", repetitions: 3,
      returned: expected.length, omitted: 160 - expected.length, paged: paged.length,
      lateBindingState: "runtime_snapshot_partial" });
  }
  const exact = JSON.parse(command(hmux, ["--discovery-root", discovery, "--json", "session", "show", "session-159", "--workspace", "workspace"]));
  assert.equal(exact.session_id, "session-159");
  assert.deepEqual(manifestWitness(), before, "partial projection and reads do not retire or mutate discovery records");
  console.log(JSON.stringify({ scenario: "bounded native catalog to Spaces", catalogBytes: Buffer.byteLength(raw), results }));
  passed = true;
} finally {
  await backend.stop();
  if (!passed) console.error(readFileSync(join(root, "backend-fixture-diagnostics.json"), "utf8"));
  writeFileSync(join(root, "native-processes-stopped"), "owned backend and sshd exited", { mode: 0o600 });
}
