import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { providerFixtureRoot } from "../paths.mjs";
import {
  exactProcessGenerationStatus,
  observeProcessGeneration,
} from "./process-generation.mjs";

const SCHEMA_VERSION = 1;
const OWNER_MARKER_NAME = ".dure-media-owner.json";
const MAX_LEDGER_BYTES = 1024 * 1024;
const ledgerRoot = resolve(providerFixtureRoot, ".cleanup-ledgers");

function assertBelow(parent, child, label) {
  const pathFromParent = relative(parent, child);
  if (
    pathFromParent === "" ||
    pathFromParent.startsWith("..") ||
    resolve(parent, pathFromParent) !== resolve(child)
  ) {
    throw new Error(`${label} must stay below ${parent}`);
  }
}

async function assertCanonicalDirectory(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if ((await realpath(path)) !== resolve(path)) {
    throw new Error(`${label} must not traverse a symlink`);
  }
}

async function assertCanonicalFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real file`);
  }
  if ((await realpath(path)) !== resolve(path)) {
    throw new Error(`${label} must not traverse a symlink`);
  }
  return metadata;
}

function validateFixturePaths(fixture) {
  assertBelow(providerFixtureRoot, fixture?.root, "provider fixture root");
  assertBelow(fixture.root, fixture?.repo, "provider demo repo");
  assertBelow(fixture.root, fixture?.discoveryRoot, "hmux discovery root");
  if (resolve(fixture.root) === ledgerRoot) {
    throw new Error("provider fixture cannot use the cleanup-ledger directory");
  }
}

async function assertCanonicalFixtureDirectories(fixture) {
  validateFixturePaths(fixture);
  await assertCanonicalDirectory(providerFixtureRoot, "provider fixture parent");
  await Promise.all([
    assertCanonicalDirectory(fixture.root, "provider fixture root"),
    assertCanonicalDirectory(fixture.repo, "provider demo repo"),
    assertCanonicalDirectory(fixture.discoveryRoot, "hmux discovery root"),
  ]);
}

function ledgerNamePrefix(fixture) {
  if (
    typeof fixture?.runId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(fixture.runId)
  ) {
    throw new Error("provider fixture has no valid cleanup run identity");
  }
  return `${basename(fixture.root)}-${fixture.runId}`;
}

function ledgerPathForFixture(fixture) {
  return resolve(ledgerRoot, `${ledgerNamePrefix(fixture)}.json`);
}

function markerPath(fixture) {
  return resolve(fixture.root, OWNER_MARKER_NAME);
}

async function readOwnershipMarker(fixture) {
  const path = markerPath(fixture);
  await assertCanonicalFile(path, "provider fixture ownership marker");
  const marker = JSON.parse(await readFile(path, "utf8"));
  if (
    marker?.schemaVersion !== SCHEMA_VERSION ||
    marker.runId !== fixture.runId ||
    marker.root !== resolve(fixture.root) ||
    marker.repo !== resolve(fixture.repo) ||
    marker.discoveryRoot !== resolve(fixture.discoveryRoot)
  ) {
    throw new Error("provider fixture ownership marker does not match its ledger");
  }
  return marker;
}

export async function assertOwnedProviderFixture(fixture, ledgerPath) {
  await assertCanonicalFixtureDirectories(fixture);
  await readOwnershipMarker(fixture);
  if (ledgerPath) {
    await assertCanonicalDirectory(ledgerRoot, "cleanup ledger directory");
    assertBelow(ledgerRoot, ledgerPath, "cleanup ledger");
    if (!basename(ledgerPath).startsWith(ledgerNamePrefix(fixture))) {
      throw new Error("cleanup ledger filename is not bound to its fixture owner");
    }
  }
}

async function initializeFixtureOwnership(fixture) {
  await assertCanonicalFixtureDirectories(fixture);
  if (!fixture.runId) fixture.runId = randomUUID();
  const marker = {
    schemaVersion: SCHEMA_VERSION,
    runId: fixture.runId,
    root: resolve(fixture.root),
    repo: resolve(fixture.repo),
    discoveryRoot: resolve(fixture.discoveryRoot),
  };
  try {
    await writeFile(markerPath(fixture), `${JSON.stringify(marker, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertOwnedProviderFixture(fixture);
}

function sessionReceipt(session) {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    record: session.record ?? null,
  };
}

function spawnIntentReceipt(intent) {
  return {
    intentId: intent.intentId,
    provider: intent.provider,
    sessionName: intent.sessionName ?? null,
    sessionId: intent.sessionId ?? null,
    state: intent.state,
  };
}

function currentOwnerGeneration() {
  const startMarker = observeProcessGeneration(process.pid);
  if (!startMarker) {
    throw new Error("cannot record the media-capture owner process generation");
  }
  return { processId: process.pid, startMarker };
}

async function writeLedgerAt(path, payload) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function writeCleanupLedger(fixture, sessions, spawnIntents = []) {
  await mkdir(ledgerRoot, { recursive: true, mode: 0o700 });
  await initializeFixtureOwnership(fixture);
  const path = ledgerPathForFixture(fixture);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    owner: currentOwnerGeneration(),
    fixture,
    sessions: sessions.map(sessionReceipt),
    spawnIntents: spawnIntents.map(spawnIntentReceipt),
  };
  await writeLedgerAt(path, payload);
  await assertOwnedProviderFixture(fixture, path);
  return path;
}

export async function readCleanupLedger(path) {
  assertBelow(ledgerRoot, path, "cleanup ledger");
  const metadata = await assertCanonicalFile(path, "cleanup ledger");
  if (metadata.size > MAX_LEDGER_BYTES) {
    throw new Error(`provider cleanup ledger is too large: ${path}`);
  }
  const payload = JSON.parse(await readFile(path, "utf8"));
  if (
    payload?.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(payload.sessions) ||
    !Array.isArray(payload.spawnIntents) ||
    !Number.isSafeInteger(payload?.owner?.processId) ||
    typeof payload?.owner?.startMarker !== "string"
  ) {
    throw new Error(`unsupported provider cleanup ledger ${path}`);
  }
  await assertOwnedProviderFixture(payload.fixture, path);
  return { path, ...payload };
}

export async function recoverableCleanupLedgers() {
  let names;
  try {
    names = await readdir(ledgerRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { ledgers: [], errors: [] };
    throw error;
  }
  const ledgers = [];
  const errors = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const path = resolve(ledgerRoot, name);
    try {
      const ledger = await readCleanupLedger(path);
      if (exactProcessGenerationStatus(ledger.owner) === "live") continue;
      ledgers.push(ledger);
    } catch (error) {
      errors.push(error);
    }
  }
  return { ledgers, errors };
}

export async function claimCleanupLedger(ledger) {
  if (exactProcessGenerationStatus(ledger.owner) === "live") return null;
  const claimedPath = ledger.path.replace(
    /\.json$/u,
    `.recovering-${process.pid}-${randomUUID()}.json`,
  );
  try {
    await rename(ledger.path, claimedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const claimed = {
    ...ledger,
    path: claimedPath,
    owner: currentOwnerGeneration(),
    recovery: {
      claimedAt: new Date().toISOString(),
      priorOwner: ledger.owner,
    },
  };
  await writeLedgerAt(claimedPath, {
    schemaVersion: claimed.schemaVersion,
    owner: claimed.owner,
    fixture: claimed.fixture,
    sessions: claimed.sessions,
    spawnIntents: claimed.spawnIntents,
    recovery: claimed.recovery,
  });
  await assertOwnedProviderFixture(claimed.fixture, claimedPath);
  return claimed;
}

export async function removeCleanupLedger(path) {
  assertBelow(ledgerRoot, path, "cleanup ledger");
  await rm(path, { force: true });
}
