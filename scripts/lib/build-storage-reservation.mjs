import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, parse as parsePath, resolve } from "node:path";
import { appRootUnder } from "./dure-home.mjs";
import { writeExclusiveFile } from "./durable-file.mjs";
import {
  processIdentity,
  processLivenessFromObservation,
  processMemberSnapshots,
} from "./process-identity.mjs";

export const BUILD_STORAGE_RESERVATION_SCHEMA_VERSION = 1;
export const BUILD_STORAGE_RESERVATION_ENV =
  "DURE_BUILD_STORAGE_RESERVATION_V1";

const RESERVATION_DIRECTORY = "build-storage-reservations-v1";
const RESERVATION_FILE_PATTERN = /^lease-([0-9a-f]{32})\.json$/u;
const MAX_RECORD_BYTES = 8 * 1024;
const MALFORMED_PUBLICATION_GRACE_MS = 5_000;
const DEFAULT_UNKNOWN_OWNER_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_CONTENTION_RETRIES = 3;
const CONTENTION_WAIT = new Int32Array(new SharedArrayBuffer(4));

function requiredString(value, field, maximum = 4_096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`invalid build storage reservation ${field}`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid build storage reservation ${field}`);
  }
  return value;
}

function ownerOnly(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function ownerOnlyMode(stat) {
  return process.platform === "win32" || (stat.mode & 0o077) === 0;
}

function safeLstat(pathname) {
  try {
    return lstatSync(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertOwnerOnlyDirectory(pathname) {
  mkdirSync(pathname, { recursive: true, mode: 0o700 });
  const stat = safeLstat(pathname);
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    !ownerOnly(stat) ||
    !ownerOnlyMode(stat)
  ) {
    throw new Error(`build storage reservation directory is unsafe: ${pathname}`);
  }
}

function reservationFile(pathname) {
  const stat = lstatSync(pathname);
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    !ownerOnly(stat) ||
    !ownerOnlyMode(stat) ||
    stat.size > MAX_RECORD_BYTES
  ) {
    throw new Error(`build storage reservation file is unsafe: ${pathname}`);
  }
  return stat;
}

export function buildStorageReservationRoot(
  accountHome = userInfo().homedir,
) {
  return join(appRootUnder(accountHome), RESERVATION_DIRECTORY);
}

export function storageVolumeId(pathname) {
  const absolute = resolve(pathname);
  const device = statSync(absolute, { bigint: true }).dev.toString(10);
  const root = Buffer.from(parsePath(absolute).root).toString("hex");
  return `${process.platform}-${device}-${root}`;
}

function volumeDirectory(reservationRoot, volumeId) {
  requiredString(volumeId, "volume identity", 256);
  if (!/^[a-z0-9-]+$/u.test(volumeId)) {
    throw new Error("invalid build storage reservation volume identity");
  }
  return join(reservationRoot, `volume-${volumeId}`);
}

export function parseBuildStorageReservation(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid build storage reservation JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid build storage reservation object");
  }
  if (value.schemaVersion !== BUILD_STORAGE_RESERVATION_SCHEMA_VERSION) {
    throw new Error("unsupported build storage reservation schema");
  }
  return Object.freeze({
    schemaVersion: BUILD_STORAGE_RESERVATION_SCHEMA_VERSION,
    generation: requiredString(value.generation, "generation", 64),
    token: requiredString(value.token, "token", 128),
    pid: positiveInteger(value.pid, "pid"),
    processIdentity: requiredString(value.processIdentity, "process identity"),
    requestedBytes: positiveInteger(value.requestedBytes, "requested bytes"),
    acquiredAtUnixMs: positiveInteger(
      value.acquiredAtUnixMs,
      "acquisition time",
    ),
    expiresAtUnixMs: positiveInteger(value.expiresAtUnixMs, "expiry time"),
    volumeId: requiredString(value.volumeId, "volume identity", 256),
    label: requiredString(value.label, "label", 256),
    cwd: requiredString(value.cwd, "working directory"),
  });
}

function readReservation(pathname) {
  reservationFile(pathname);
  return parseBuildStorageReservation(readFileSync(pathname, "utf8"));
}

function sameReservation(left, right) {
  return (
    left.generation === right.generation &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity
  );
}

function removeExact(pathname, expected) {
  let current;
  try {
    current = readReservation(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
  if (!sameReservation(current, expected)) return false;
  try {
    unlinkSync(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sameFileGeneration(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function removeMalformed(pathname, observed) {
  const current = safeLstat(pathname);
  if (!current || !sameFileGeneration(current, observed)) return false;
  try {
    unlinkSync(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

function reservationPaths(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => RESERVATION_FILE_PATTERN.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function observeReservationSet({
  directory,
  volumeId,
  nowMs,
  observeProcesses,
  reclaimStale,
}) {
  const records = [];
  const invalid = [];
  for (const pathname of reservationPaths(directory)) {
    let record;
    let stat;
    try {
      stat = reservationFile(pathname);
      record = parseBuildStorageReservation(readFileSync(pathname, "utf8"));
      if (record.volumeId !== volumeId) {
        throw new Error("reservation volume does not match its directory");
      }
      records.push({ pathname, record });
    } catch (error) {
      // A peer can withdraw after enumeration, before either read completes.
      if (error?.code === "ENOENT") continue;
      stat ??= safeLstat(pathname);
      const oldEnough =
        stat && nowMs - stat.mtimeMs >= MALFORMED_PUBLICATION_GRACE_MS;
      if (reclaimStale && oldEnough && removeMalformed(pathname, stat)) continue;
      invalid.push({ pathname, reason: error.message });
    }
  }

  const observation =
    records.length === 0
      ? {
          status: "complete",
          scope: { kind: "point", requestedPids: [] },
          members: [],
        }
      : observeProcesses(records.map(({ record }) => record.pid));
  const active = [];
  const reclaimed = [];
  for (const entry of records) {
    const liveness = processLivenessFromObservation(entry.record, observation);
    const expiredUnknown =
      liveness === "unknown" && nowMs >= entry.record.expiresAtUnixMs;
    if (liveness === "stale" || expiredUnknown) {
      if (reclaimStale && removeExact(entry.pathname, entry.record)) {
        reclaimed.push(entry.record);
      }
      continue;
    }
    active.push({ ...entry, liveness });
  }
  return {
    active,
    invalid,
    observationStatus: observation.status,
    reclaimed,
    reservedBytes: active.reduce(
      (total, { record }) => total + record.requestedBytes,
      0,
    ),
  };
}

export function inspectBuildStorageReservations({
  cwd = process.cwd(),
  reservationRoot = buildStorageReservationRoot(),
  nowMs = Date.now(),
  observeProcesses = processMemberSnapshots,
  reclaimStale = false,
} = {}) {
  const volumeId = storageVolumeId(cwd);
  const directory = volumeDirectory(reservationRoot, volumeId);
  if (!safeLstat(directory) && !reclaimStale) {
    return {
      active: [],
      directory,
      invalid: [],
      observationStatus: "complete",
      reclaimed: [],
      reservedBytes: 0,
      volumeId,
    };
  }
  if (reclaimStale) assertOwnerOnlyDirectory(directory);
  else {
    const stat = safeLstat(directory);
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      !ownerOnly(stat) ||
      !ownerOnlyMode(stat)
    ) {
      throw new Error(`build storage reservation directory is unsafe: ${directory}`);
    }
  }
  return {
    directory,
    volumeId,
    ...observeReservationSet({
      directory,
      volumeId,
      nowMs,
      observeProcesses,
      reclaimStale,
    }),
  };
}

function freshReservation({
  cwd,
  label,
  nowMs,
  ownerIdentity,
  pid,
  requestedBytes,
  ttlMs,
  volumeId,
}) {
  return Object.freeze({
    schemaVersion: BUILD_STORAGE_RESERVATION_SCHEMA_VERSION,
    generation: randomBytes(16).toString("hex"),
    token: randomBytes(32).toString("hex"),
    pid,
    processIdentity: ownerIdentity,
    requestedBytes,
    acquiredAtUnixMs: nowMs,
    expiresAtUnixMs: nowMs + ttlMs,
    volumeId,
    label,
    cwd: resolve(cwd),
  });
}

function reservationCapability(pathname, record) {
  return JSON.stringify({
    schemaVersion: BUILD_STORAGE_RESERVATION_SCHEMA_VERSION,
    pathname,
    generation: record.generation,
    token: record.token,
    volumeId: record.volumeId,
    requestedBytes: record.requestedBytes,
  });
}

function contentionDelay(record, attempt) {
  const jitter = Number.parseInt(record.generation.slice(0, 2), 16) % 20;
  return 5 + jitter + attempt * 20;
}

function parseReservationCapability(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 4_096) {
    return null;
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== BUILD_STORAGE_RESERVATION_SCHEMA_VERSION ||
    typeof value.pathname !== "string" ||
    typeof value.generation !== "string" ||
    typeof value.token !== "string" ||
    typeof value.volumeId !== "string" ||
    !Number.isSafeInteger(value.requestedBytes) ||
    value.requestedBytes <= 0
  ) {
    return null;
  }
  return value;
}

export function adoptBuildStorageReservation({
  capability,
  cwd = process.cwd(),
  requestedBytes,
  reservationRoot = buildStorageReservationRoot(),
  pid = process.pid,
  ownerIdentity = processIdentity(pid),
  observeProcesses = processMemberSnapshots,
  nowMs = Date.now(),
} = {}) {
  const parsed = parseReservationCapability(capability);
  if (!parsed || !Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
    return null;
  }
  const volumeId = storageVolumeId(cwd);
  const directory = volumeDirectory(reservationRoot, volumeId);
  if (
    parsed.volumeId !== volumeId ||
    parsed.requestedBytes < requestedBytes ||
    resolve(dirname(parsed.pathname)) !== resolve(directory) ||
    !RESERVATION_FILE_PATTERN.test(basename(parsed.pathname))
  ) {
    return null;
  }

  let record;
  try {
    record = readReservation(parsed.pathname);
  } catch {
    return null;
  }
  if (
    record.generation !== parsed.generation ||
    record.token !== parsed.token ||
    record.volumeId !== volumeId ||
    record.requestedBytes !== parsed.requestedBytes
  ) {
    return null;
  }
  const observation = observeProcesses([record.pid]);
  const liveness = processLivenessFromObservation(record, observation);
  if (
    liveness === "stale" ||
    (liveness === "unknown" && nowMs >= record.expiresAtUnixMs)
  ) {
    return null;
  }
  const owns =
    record.pid === pid &&
    typeof ownerIdentity === "string" &&
    record.processIdentity === ownerIdentity;
  return Object.freeze({
    capability,
    owned: owns,
    pathname: parsed.pathname,
    record,
    release: owns ? () => removeExact(parsed.pathname, record) : () => false,
  });
}

export function exposeBuildStorageReservation(
  reservation,
  environment = process.env,
) {
  if (!reservation?.capability) return () => {};
  const previous = environment[BUILD_STORAGE_RESERVATION_ENV];
  environment[BUILD_STORAGE_RESERVATION_ENV] = reservation.capability;
  return () => {
    if (
      environment[BUILD_STORAGE_RESERVATION_ENV] !== reservation.capability
    ) {
      return;
    }
    if (previous === undefined) delete environment[BUILD_STORAGE_RESERVATION_ENV];
    else environment[BUILD_STORAGE_RESERVATION_ENV] = previous;
  };
}

export function reserveBuildStorage({
  availableBytes,
  cwd = process.cwd(),
  floorBytes,
  requestedBytes,
  label = "build",
  reservationRoot = buildStorageReservationRoot(),
  nowMs = Date.now(),
  pid = process.pid,
  ownerIdentity = processIdentity(pid),
  observeProcesses = processMemberSnapshots,
  ttlMs = DEFAULT_UNKNOWN_OWNER_TTL_MS,
  contentionAttempt = 0,
} = {}) {
  positiveInteger(requestedBytes, "requested bytes");
  if (!Number.isSafeInteger(floorBytes) || floorBytes < 0) {
    throw new Error("invalid build storage reservation floor");
  }
  positiveInteger(pid, "pid");
  requiredString(ownerIdentity, "process identity");
  requiredString(label, "label", 256);
  positiveInteger(ttlMs, "TTL");
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    return {
      ok: false,
      reason: "available_space_unknown",
      reservation: null,
      reservedBytes: null,
    };
  }

  const volumeId = storageVolumeId(cwd);
  const directory = volumeDirectory(reservationRoot, volumeId);
  assertOwnerOnlyDirectory(directory);
  const record = freshReservation({
    cwd,
    label,
    nowMs,
    ownerIdentity,
    pid,
    requestedBytes,
    ttlMs,
    volumeId,
  });
  const pathname = join(directory, `lease-${record.generation}.json`);
  // Publish before observing. For two contenders to miss one another, each
  // observation would have to happen before the other's publication while
  // also happening after its own publication, which is an impossible order.
  // This avoids a second lock lifecycle: every visible live request counts,
  // and any request that sees an overbooked set withdraws itself.
  writeExclusiveFile(pathname, `${JSON.stringify(record)}\n`);

  const release = () => removeExact(pathname, record);
  let observed;
  try {
    observed = observeReservationSet({
      directory,
      volumeId,
      nowMs,
      observeProcesses,
      reclaimStale: true,
    });
  } catch (error) {
    release();
    throw error;
  }

  const remainingBytes = availableBytes - observed.reservedBytes;
  const current = observed.active.find(
    (entry) => sameReservation(entry.record, record),
  );
  const ok =
    Boolean(current) &&
    observed.invalid.length === 0 &&
    remainingBytes >= floorBytes;
  if (!ok) {
    release();
    const hasPeer = observed.active.some(
      (entry) => !sameReservation(entry.record, record),
    );
    if (
      current &&
      observed.invalid.length === 0 &&
      hasPeer &&
      contentionAttempt < MAX_CONTENTION_RETRIES
    ) {
      const delayMs = contentionDelay(record, contentionAttempt);
      Atomics.wait(CONTENTION_WAIT, 0, 0, delayMs);
      return reserveBuildStorage({
        availableBytes,
        contentionAttempt: contentionAttempt + 1,
        cwd,
        floorBytes,
        label,
        nowMs: nowMs + delayMs,
        observeProcesses,
        ownerIdentity,
        pid,
        requestedBytes,
        reservationRoot,
        ttlMs,
      });
    }
    return {
      ok: false,
      reason: observed.invalid.length > 0
        ? "reservation_state_invalid"
        : current
          ? "insufficient_unreserved_space"
          : "reservation_liveness_unavailable",
      reservation: null,
      reservedBytes: observed.reservedBytes - (current ? requestedBytes : 0),
      remainingBytes,
      invalid: observed.invalid,
      reclaimed: observed.reclaimed,
    };
  }

  return {
    ok: true,
    reason: null,
    reservedBytes: observed.reservedBytes,
    remainingBytes,
    reclaimed: observed.reclaimed,
    reservation: Object.freeze({
      capability: reservationCapability(pathname, record),
      owned: true,
      pathname,
      record,
      release,
    }),
  };
}
