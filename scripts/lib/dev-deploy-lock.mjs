import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appRoot } from "./dure-home.mjs";
import {
  isProcessAlive,
  processIdentity,
  processLiveness,
} from "./process-identity.mjs";

export const DEV_DEPLOY_LOCK_SCHEMA_VERSION = 1;
export const DEV_DEPLOY_HMR_STATUS_PATH = "/__dure_dev_deploy_hmr_status";
export const DEV_DEPLOY_HMR_QUIET_MS = 500;
const DEV_DEPLOY_LOCK_FILE = "dev-deploy.lock";
const UNKNOWN_OWNER_MAX_AGE_MS = 60 * 60 * 1_000;
const MALFORMED_LOCK_GRACE_MS = 5_000;

export function devDeployLockPath(root = appRoot()) {
  return join(root, DEV_DEPLOY_LOCK_FILE);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new Error(`invalid dev deploy lock ${field}`);
  }
  return value;
}

export function parseDevDeployLock(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid dev deploy lock JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid dev deploy lock object");
  }
  if (value.schemaVersion !== DEV_DEPLOY_LOCK_SCHEMA_VERSION) {
    throw new Error("unsupported dev deploy lock schema");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("invalid dev deploy lock pid");
  }
  if (!Number.isSafeInteger(value.acquiredAtUnixMs) || value.acquiredAtUnixMs <= 0) {
    throw new Error("invalid dev deploy lock acquisition time");
  }
  if (typeof value.suppressHmr !== "boolean") {
    throw new Error("invalid dev deploy lock HMR mode");
  }
  return {
    schemaVersion: DEV_DEPLOY_LOCK_SCHEMA_VERSION,
    generation: requiredString(value.generation, "generation"),
    token: requiredString(value.token, "token"),
    pid: value.pid,
    processIdentity: requiredString(value.processIdentity, "process identity"),
    worktreeRoot: requiredString(value.worktreeRoot, "worktree root"),
    channel: requiredString(value.channel, "channel"),
    suppressHmr: value.suppressHmr,
    acquiredAtUnixMs: value.acquiredAtUnixMs,
  };
}

function freshRecord({ pid, worktreeRoot, channel, suppressHmr, nowMs }) {
  const ownerIdentity = processIdentity(pid);
  if (!ownerIdentity) {
    throw new Error("dev deploy lock requires an exact process identity");
  }
  return {
    schemaVersion: DEV_DEPLOY_LOCK_SCHEMA_VERSION,
    generation: randomBytes(16).toString("hex"),
    token: randomBytes(32).toString("hex"),
    pid,
    processIdentity: ownerIdentity,
    worktreeRoot,
    channel,
    suppressHmr,
    acquiredAtUnixMs: nowMs,
  };
}

function legacyOwner(source) {
  const trimmed = source.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : null;
}

function existingLockLiveness(source, pathname, nowMs) {
  try {
    const lock = parseDevDeployLock(source);
    return processLiveness(lock, isProcessAlive, processIdentity);
  } catch {
    const pid = legacyOwner(source);
    if (pid === null) {
      try {
        const stat = lstatSync(pathname);
        if (stat.isSymbolicLink() || !stat.isFile()) return "unknown";
        return nowMs - stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS
          ? "stale"
          : "unknown";
      } catch {
        return "unknown";
      }
    }
    return isProcessAlive(pid) ? "active" : "stale";
  }
}

function releaseExact(pathname, record) {
  let current;
  try {
    current = parseDevDeployLock(readFileSync(pathname, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
  if (
    current.generation !== record.generation ||
    current.token !== record.token ||
    current.pid !== record.pid ||
    current.processIdentity !== record.processIdentity
  ) {
    return false;
  }
  try {
    unlinkSync(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function acquireDevDeployLock({
  pathname = devDeployLockPath(),
  worktreeRoot,
  channel,
  suppressHmr,
  pid = process.pid,
  nowMs = Date.now(),
}) {
  requiredString(worktreeRoot, "worktree root");
  requiredString(channel, "channel");
  if (typeof suppressHmr !== "boolean") {
    throw new Error("dev deploy lock requires an explicit HMR mode");
  }
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
  const record = freshRecord({ pid, worktreeRoot, channel, suppressHmr, nowMs });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(pathname, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let source;
      try {
        source = readFileSync(pathname, "utf8");
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        return null;
      }
      if (existingLockLiveness(source, pathname, nowMs) !== "stale") return null;
      try {
        unlinkSync(pathname);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") return null;
      }
      continue;
    }

    let writeError;
    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      fsyncSync(descriptor);
    } catch (error) {
      writeError = error;
    } finally {
      closeSync(descriptor);
    }
    if (writeError) {
      try {
        unlinkSync(pathname);
      } catch {}
      throw writeError;
    }
    return {
      record,
      release: () => releaseExact(pathname, record),
    };
  }
  return null;
}

export function readOwnedDevDeployLock({
  pathname = devDeployLockPath(),
  worktreeRoot,
  channel,
  nowMs = Date.now(),
  alive = isProcessAlive,
  identity = processIdentity,
}) {
  let record;
  try {
    record = parseDevDeployLock(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
  if (
    record.worktreeRoot !== worktreeRoot ||
    record.channel !== channel
  ) {
    return null;
  }
  const liveness = processLiveness(record, alive, identity);
  if (liveness === "stale") return null;
  if (
    liveness === "unknown" &&
    nowMs - record.acquiredAtUnixMs > UNKNOWN_OWNER_MAX_AGE_MS
  ) {
    return null;
  }
  return record;
}

export function readActiveDevDeployLock(options) {
  const record = readOwnedDevDeployLock(options);
  return record?.suppressHmr ? record : null;
}

export function devDeployLockAuthorizes(record, authorization) {
  if (!record || typeof authorization !== "string") return false;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const received = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(record.token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createDevDeployLockProbe(options, cacheMs = 100) {
  let checkedAtMs = Number.NEGATIVE_INFINITY;
  let cached = null;
  return ({ force = false, nowMs = Date.now() } = {}) => {
    // A cached absence must never bridge lock acquisition. A cached presence
    // may skip the comparatively expensive process-generation probe only while
    // the exact on-disk generation still exists.
    if (!force && cached && nowMs - checkedAtMs < cacheMs) {
      try {
        const current = parseDevDeployLock(readFileSync(options.pathname, "utf8"));
        if (
          current.generation === cached.generation &&
          current.token === cached.token
        ) {
          return cached;
        }
      } catch {}
    }
    checkedAtMs = nowMs;
    cached = readActiveDevDeployLock({ ...options, nowMs });
    return cached;
  };
}

export function devDeployHmrStatusReady(
  status,
  record,
  { nowMs = Date.now(), deployedAtMs, quietMs = DEV_DEPLOY_HMR_QUIET_MS } = {},
) {
  if (
    !status ||
    status.schemaVersion !== 1 ||
    status.fenced !== true ||
    status.generation !== record?.generation ||
    !Number.isSafeInteger(status.observedAtUnixMs) ||
    !Number.isSafeInteger(deployedAtMs)
  ) {
    return false;
  }
  const lastEvent = Number.isSafeInteger(status.lastSuppressedAtUnixMs)
    ? status.lastSuppressedAtUnixMs
    : deployedAtMs;
  return nowMs - Math.max(deployedAtMs, lastEvent) >= quietMs;
}
