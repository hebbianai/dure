import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LOCK_SCHEMA_VERSION = 1;
const MAXIMUM_LOCK_RECORD_BYTES = 512;
const MAXIMUM_LOCK_ACQUISITION_ATTEMPTS = 3;
const SAFE_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;

function fsyncDirectory(fileSystem, directory) {
  const descriptor = fileSystem.openSync(directory, "r");
  try {
    fileSystem.fsyncSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularFile(stat, pathname, description) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${description} must be a regular file: ${pathname}`);
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function defaultGetProcessIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const bootId = fs
        .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
        .trim();
      const processStat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = processStat
        .slice(processStat.lastIndexOf(") ") + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      if (!bootId || !startTime) return null;
      return `linux:${bootId}:${startTime}`;
    }

    const startTime = execFileSync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LANG: "C",
          LC_ALL: "C",
          TZ: "UTC",
        },
      },
    ).trim();
    return startTime ? `${process.platform}:${startTime}` : null;
  } catch {
    return null;
  }
}

function lockOwnerPath(lockPath, owner) {
  return `${lockPath}.${owner.pid}.${owner.token}.owner`;
}

function parseLockRecord(fileSystem, lockPath) {
  const stat = fileSystem.lstatSync(lockPath);
  assertRegularFile(stat, lockPath, "architecture baseline publication lock");
  if (stat.size > MAXIMUM_LOCK_RECORD_BYTES) {
    throw new Error(
      `architecture baseline publication lock is too large: ${lockPath}`,
    );
  }

  const source = fileSystem.readFileSync(lockPath, "utf8");
  let owner;
  try {
    owner = JSON.parse(source);
  } catch {
    throw new Error(
      `architecture baseline publication lock is malformed: ${lockPath}`,
    );
  }
  if (
    owner?.schemaVersion !== LOCK_SCHEMA_VERSION ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== "string" ||
    !SAFE_TOKEN.test(owner.token) ||
    typeof owner.processIdentity !== "string" ||
    owner.processIdentity.length === 0 ||
    owner.processIdentity.length > 256
  ) {
    throw new Error(
      `architecture baseline publication lock has an invalid owner: ${lockPath}`,
    );
  }
  return { owner, source, stat };
}

function reclaimStaleLock({
  fileSystem,
  lockPath,
  isProcessAlive,
  getProcessIdentity,
}) {
  let lock;
  try {
    lock = parseLockRecord(fileSystem, lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (
    isProcessAlive(lock.owner.pid) &&
    (getProcessIdentity(lock.owner.pid) ?? lock.owner.processIdentity) ===
      lock.owner.processIdentity
  ) {
    throw new Error(
      `another architecture baseline ratchet holds the publication lock: ${lockPath}`,
    );
  }

  const ownerPath = lockOwnerPath(lockPath, lock.owner);
  const ownerStat = fileSystem.lstatSync(ownerPath);
  assertRegularFile(
    ownerStat,
    ownerPath,
    "architecture baseline publication lock owner",
  );
  if (
    !isSameFile(lock.stat, ownerStat) ||
    fileSystem.readFileSync(ownerPath, "utf8") !== lock.source
  ) {
    throw new Error(
      `architecture baseline publication lock owner does not match: ${lockPath}`,
    );
  }

  const currentLock = parseLockRecord(fileSystem, lockPath);
  const currentOwnerStat = fileSystem.lstatSync(ownerPath);
  if (
    !isSameFile(lock.stat, currentLock.stat) ||
    currentLock.source !== lock.source ||
    !isSameFile(currentLock.stat, currentOwnerStat) ||
    fileSystem.readFileSync(ownerPath, "utf8") !== lock.source
  ) {
    throw new Error(
      `architecture baseline publication lock changed during recovery: ${lockPath}`,
    );
  }

  fileSystem.unlinkSync(lockPath);
  fileSystem.rmSync(ownerPath, { force: true });
  fsyncDirectory(fileSystem, path.dirname(lockPath));
}

function acquirePublicationLock({
  fileSystem,
  lockPath,
  temporaryToken,
  isProcessAlive,
  getProcessIdentity,
}) {
  if (!SAFE_TOKEN.test(temporaryToken)) {
    throw new Error("architecture baseline publication token is invalid");
  }
  const processIdentity = getProcessIdentity(process.pid);
  if (!processIdentity) {
    throw new Error(
      "cannot determine the architecture baseline ratchet process identity",
    );
  }
  const owner = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    token: temporaryToken,
    processIdentity,
  };
  const source = `${JSON.stringify(owner)}\n`;
  const ownerPath = lockOwnerPath(lockPath, owner);
  let ownsOwnerPath = false;
  let linkedLockStat;

  try {
    const descriptor = fileSystem.openSync(ownerPath, "wx", 0o600);
    ownsOwnerPath = true;
    try {
      fileSystem.fchmodSync(descriptor, 0o600);
      fileSystem.writeFileSync(descriptor, source);
      fileSystem.fsyncSync(descriptor);
    } finally {
      fileSystem.closeSync(descriptor);
    }

    for (
      let attempt = 0;
      attempt < MAXIMUM_LOCK_ACQUISITION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        fileSystem.linkSync(ownerPath, lockPath);
        linkedLockStat = fileSystem.lstatSync(lockPath);
        fsyncDirectory(fileSystem, path.dirname(lockPath));
        return { lockPath, ownerPath, source, stat: linkedLockStat };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        reclaimStaleLock({
          fileSystem,
          lockPath,
          isProcessAlive,
          getProcessIdentity,
        });
      }
    }
    throw new Error(
      `architecture baseline publication lock remained contended: ${lockPath}`,
    );
  } catch (error) {
    if (linkedLockStat) {
      try {
        const currentLockStat = fileSystem.lstatSync(lockPath);
        if (isSameFile(linkedLockStat, currentLockStat)) {
          fileSystem.unlinkSync(lockPath);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
    }
    if (ownsOwnerPath) fileSystem.rmSync(ownerPath, { force: true });
    throw error;
  }
}

function releasePublicationLock(fileSystem, lock) {
  const currentLock = parseLockRecord(fileSystem, lock.lockPath);
  const currentOwnerStat = fileSystem.lstatSync(lock.ownerPath);
  if (
    !isSameFile(lock.stat, currentLock.stat) ||
    currentLock.source !== lock.source ||
    !isSameFile(currentLock.stat, currentOwnerStat) ||
    fileSystem.readFileSync(lock.ownerPath, "utf8") !== lock.source
  ) {
    throw new Error(
      `architecture baseline publication lock ownership changed: ${lock.lockPath}`,
    );
  }

  fileSystem.unlinkSync(lock.lockPath);
  fileSystem.rmSync(lock.ownerPath, { force: true });
  fsyncDirectory(fileSystem, path.dirname(lock.lockPath));
}

export function publishArchitectureBaseline({
  root,
  expectedSource,
  baseline,
  fileSystem = fs,
  temporaryToken = randomBytes(6).toString("hex"),
  isProcessAlive = defaultIsProcessAlive,
  getProcessIdentity = defaultGetProcessIdentity,
}) {
  const baselinePath = path.join(
    root,
    "scripts/architecture-fitness-baseline.json",
  );
  const lock = acquirePublicationLock({
    fileSystem,
    lockPath: `${baselinePath}.ratchet.lock`,
    temporaryToken,
    isProcessAlive,
    getProcessIdentity,
  });
  try {
    const stat = fileSystem.lstatSync(baselinePath);
    assertRegularFile(stat, baselinePath, "architecture baseline");
    if (fileSystem.readFileSync(baselinePath, "utf8") !== expectedSource) {
      throw new Error("architecture baseline changed while ratchet was planning");
    }

    const nextSource = `${JSON.stringify(baseline, null, 2)}\n`;
    if (nextSource === expectedSource) return false;

    const temporaryPath =
      `${baselinePath}.${process.pid}.${temporaryToken}.tmp`;
    let published = false;
    try {
      const descriptor = fileSystem.openSync(
        temporaryPath,
        "wx",
        stat.mode & 0o777,
      );
      try {
        fileSystem.fchmodSync(descriptor, stat.mode & 0o777);
        fileSystem.writeFileSync(descriptor, nextSource);
        fileSystem.fsyncSync(descriptor);
      } finally {
        fileSystem.closeSync(descriptor);
      }

      if (fileSystem.readFileSync(baselinePath, "utf8") !== expectedSource) {
        throw new Error(
          "architecture baseline changed before ratchet publication",
        );
      }
      fileSystem.renameSync(temporaryPath, baselinePath);
      published = true;
      fsyncDirectory(fileSystem, path.dirname(baselinePath));
      return true;
    } finally {
      if (!published) fileSystem.rmSync(temporaryPath, { force: true });
    }
  } finally {
    releasePublicationLock(fileSystem, lock);
  }
}
