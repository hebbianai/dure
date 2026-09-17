import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  capturePromotionJournalPath,
  createCaptureGeneration,
  discardCaptureGeneration,
  promoteCaptureGeneration,
} from "../runtime/output-generation.mjs";
import {
  assertDirectoryFence,
  assertRegularDirectoryTree,
  captureDirectoryFence,
  ensureSafeOutputDirectory,
  lstatIfExists,
} from "./secure-output.mjs";

const LOCK_SCHEMA_VERSION = 1;
const PROMOTION_SCHEMA_VERSION = 1;
const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_VALUE_PATTERN = new RegExp(`^${UUID_PATTERN}$`);

function assertTargetId(targetId) {
  if (!TARGET_ID_PATTERN.test(targetId)) {
    throw new Error(`storyboard target id is unsafe: ${targetId}`);
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function lockDirectoryFor(outputParent, targetId) {
  return resolve(outputParent, `.${targetId}.generation.lock`);
}

function validateLockOwner(value, label) {
  if (
    value?.schemaVersion !== LOCK_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !UUID_VALUE_PATTERN.test(value.token)
  ) {
    throw new Error(`${label} has invalid owner metadata`);
  }
  return { pid: value.pid, token: value.token };
}

async function readLockOwner(lockDirectory, label) {
  const lockStatus = await lstatIfExists(lockDirectory);
  if (!lockStatus) return undefined;
  if (lockStatus.isSymbolicLink() || !lockStatus.isDirectory()) {
    throw new Error(`${label} is not a safe lock directory`);
  }
  const ownerPath = resolve(lockDirectory, "owner.json");
  const ownerStatus = await lstatIfExists(ownerPath);
  if (!ownerStatus || ownerStatus.isSymbolicLink() || !ownerStatus.isFile()) {
    throw new Error(`${label} has no safe owner metadata`);
  }
  let encoded;
  const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStatus = await handle.stat();
    if (
      !openedStatus.isFile() ||
      openedStatus.dev !== ownerStatus.dev ||
      openedStatus.ino !== ownerStatus.ino
    ) {
      throw new Error(`${label} owner metadata changed before it was opened`);
    }
    encoded = JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    throw new Error(`${label} owner metadata is unreadable`, { cause: error });
  } finally {
    await handle.close();
  }
  return validateLockOwner(encoded, label);
}

async function readJsonFileWithoutFollowingLinks(path, expectedStatus, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStatus = await handle.stat();
    if (
      !openedStatus.isFile() ||
      openedStatus.dev !== expectedStatus.dev ||
      openedStatus.ino !== expectedStatus.ino
    ) {
      throw new Error(`${label} changed before it was opened`);
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable`, { cause: error });
  } finally {
    await handle.close();
  }
}

async function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new Error(`cannot prove whether generation lock pid ${pid} is dead`, {
      cause: error,
    });
  }
}

async function writeLockOwner(lockDirectory, owner) {
  const ownerPath = resolve(lockDirectory, "owner.json");
  const handle = await open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: LOCK_SCHEMA_VERSION, ...owner })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(lockDirectory);
}

function sameOwner(left, right) {
  return left?.pid === right?.pid && left?.token === right?.token;
}

export async function acquireStoryboardGenerationLock({
  allowedRoot,
  outputParent,
  targetId,
  isProcessAlive = defaultIsProcessAlive,
}) {
  assertTargetId(targetId);
  const safeOutput = await ensureSafeOutputDirectory({
    allowedRoot,
    directory: outputParent,
    label: `storyboard ${targetId} output parent`,
  });
  const verifiedParent = safeOutput.outputDirectory;
  const lockDirectory = lockDirectoryFor(verifiedParent, targetId);

  for (;;) {
    const owner = { pid: process.pid, token: randomUUID() };
    const claimDirectory = `${lockDirectory}.claim.${owner.pid}.${owner.token}`;
    await mkdir(claimDirectory, { mode: 0o700 });
    try {
      await writeLockOwner(claimDirectory, owner);
      await syncDirectory(verifiedParent);
      await rename(claimDirectory, lockDirectory);
      await syncDirectory(verifiedParent);
      return Object.freeze({
        allowedRoot: safeOutput.canonicalRoot,
        lockDirectory,
        lockFence: await captureDirectoryFence(
          lockDirectory,
          `storyboard ${targetId} generation lock`,
        ),
        outputParent: verifiedParent,
        outputParentFence: await captureDirectoryFence(
          verifiedParent,
          `storyboard ${targetId} output parent`,
        ),
        owner,
        targetId,
      });
    } catch (error) {
      await rm(claimDirectory, { recursive: true, force: true }).catch(() => {});
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
    }

    const observedOwner = await readLockOwner(
      lockDirectory,
      `storyboard ${targetId} generation lock`,
    );
    if (!observedOwner) continue;
    let alive;
    try {
      alive = await isProcessAlive(observedOwner.pid);
    } catch (error) {
      throw new Error(
        `storyboard ${targetId} generation lock liveness is unknown`,
        { cause: error },
      );
    }
    if (alive !== false) {
      throw new Error(
        `storyboard ${targetId} generation is already owned by pid ${observedOwner.pid}`,
      );
    }

    const reclaimedDirectory = `${lockDirectory}.reclaim.${randomUUID()}`;
    try {
      await rename(lockDirectory, reclaimedDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const movedOwner = await readLockOwner(
      reclaimedDirectory,
      `storyboard ${targetId} reclaimed generation lock`,
    );
    if (!sameOwner(observedOwner, movedOwner)) {
      try {
        await rename(reclaimedDirectory, lockDirectory);
      } catch {
        // Preserve both generations for inspection rather than deleting an
        // ownership record that changed while it was being reclaimed.
      }
      throw new Error(
        `storyboard ${targetId} generation lock owner changed during reclaim`,
      );
    }
    await rm(reclaimedDirectory, { recursive: true });
    await syncDirectory(verifiedParent);
  }
}

export async function releaseStoryboardGenerationLock(lock) {
  await assertDirectoryFence(
    lock.outputParentFence,
    `storyboard ${lock.targetId} output parent`,
  );
  await assertDirectoryFence(
    lock.lockFence,
    `storyboard ${lock.targetId} generation lock`,
  );
  const observedOwner = await readLockOwner(
    lock.lockDirectory,
    `storyboard ${lock.targetId} generation lock`,
  );
  if (!sameOwner(lock.owner, observedOwner)) {
    throw new Error(
      `storyboard ${lock.targetId} generation lock is owned by another process`,
    );
  }
  const releasedDirectory = `${lock.lockDirectory}.release.${lock.owner.token}`;
  await rename(lock.lockDirectory, releasedDirectory);
  const movedOwner = await readLockOwner(
    releasedDirectory,
    `storyboard ${lock.targetId} released generation lock`,
  );
  if (!sameOwner(lock.owner, movedOwner)) {
    try {
      await rename(releasedDirectory, lock.lockDirectory);
    } catch {
      // Keep the mismatched ownership record instead of removing it.
    }
    throw new Error(
      `storyboard ${lock.targetId} generation lock owner changed during release`,
    );
  }
  await rm(releasedDirectory, { recursive: true });
  await syncDirectory(lock.outputParent);
}

function generationNamePattern(targetId, suffix) {
  const escapedTarget = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\.${escapedTarget}\\.[1-9][0-9]*\\.${UUID_PATTERN}\\.${suffix}$`,
  );
}

async function assertSafePromotionState(outputParent, targetId) {
  const finalDirectory = resolve(outputParent, targetId);
  const finalStatus = await lstatIfExists(finalDirectory);
  if (
    finalStatus &&
    (finalStatus.isSymbolicLink() || !finalStatus.isDirectory())
  ) {
    throw new Error(`storyboard ${targetId} final generation is not a directory`);
  }

  const partialPattern = generationNamePattern(targetId, "partial");
  const previousPattern = generationNamePattern(targetId, "previous");
  for (const name of await readdir(outputParent)) {
    if (!partialPattern.test(name) && !previousPattern.test(name)) continue;
    const status = await lstatIfExists(resolve(outputParent, name));
    if (status && (status.isSymbolicLink() || !status.isDirectory())) {
      throw new Error(`storyboard ${targetId} promotion entry is unsafe: ${name}`);
    }
  }

  const journalPath = capturePromotionJournalPath(outputParent, targetId);
  const journalStatus = await lstatIfExists(journalPath);
  if (!journalStatus) return;
  if (journalStatus.isSymbolicLink() || !journalStatus.isFile()) {
    throw new Error(`storyboard ${targetId} promotion journal is unsafe`);
  }
  let journal;
  journal = await readJsonFileWithoutFollowingLinks(
    journalPath,
    journalStatus,
    `storyboard ${targetId} promotion journal`,
  );
  if (
    journal?.schemaVersion !== PROMOTION_SCHEMA_VERSION ||
    journal?.scenarioId !== targetId ||
    journal?.finalName !== targetId ||
    !partialPattern.test(journal?.stagingName ?? "") ||
    !previousPattern.test(journal?.backupName ?? "")
  ) {
    throw new Error(`storyboard ${targetId} promotion journal is invalid`);
  }
}

async function copyDirectoryEntriesSafely(sourceDirectory, destinationDirectory) {
  await assertRegularDirectoryTree(sourceDirectory, "storyboard seed generation");
  const pending = [[sourceDirectory, destinationDirectory]];
  while (pending.length > 0) {
    const [sourceParent, destinationParent] = pending.pop();
    for (const name of await readdir(sourceParent)) {
      const sourcePath = resolve(sourceParent, name);
      const destinationPath = resolve(destinationParent, name);
      const status = await lstatIfExists(sourcePath);
      if (!status || status.isSymbolicLink()) {
        throw new Error(`storyboard seed entry changed or is a symbolic link: ${sourcePath}`);
      }
      if (status.isDirectory()) {
        await mkdir(destinationPath, { mode: status.mode & 0o777 });
        pending.push([sourcePath, destinationPath]);
      } else if (status.isFile()) {
        await copyRegularFileWithoutFollowingLinks(
          sourcePath,
          destinationPath,
          status.mode,
          status,
        );
      } else {
        throw new Error(`storyboard seed entry is not a regular file: ${sourcePath}`);
      }
    }
  }
}

async function copyRegularFileWithoutFollowingLinks(
  sourcePath,
  destinationPath,
  mode,
  expectedStatus,
) {
  const source = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let destination;
  try {
    const sourceStatus = await source.stat();
    if (!sourceStatus.isFile()) {
      throw new Error(`storyboard seed entry is not a regular file: ${sourcePath}`);
    }
    if (
      expectedStatus &&
      (sourceStatus.dev !== expectedStatus.dev ||
        sourceStatus.ino !== expectedStatus.ino)
    ) {
      throw new Error(`storyboard seed entry changed before it was opened: ${sourcePath}`);
    }
    destination = await open(destinationPath, "wx", mode & 0o777);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let readPosition = 0;
    for (;;) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.length,
        readPosition,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          readPosition + written,
        );
        if (result.bytesWritten === 0) {
          throw new Error(`storyboard seed copy made no progress: ${sourcePath}`);
        }
        written += result.bytesWritten;
      }
      readPosition += bytesRead;
    }
    await destination.sync();
  } catch (error) {
    await destination?.close().catch(() => {});
    destination = undefined;
    await rm(destinationPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await source.close();
    await destination?.close();
  }
}

export async function withAtomicStoryboardGeneration(
  {
    allowedRoot,
    outputParent,
    targetId,
    seedExisting = false,
    isProcessAlive,
  },
  buildGeneration,
) {
  const lock = await acquireStoryboardGenerationLock({
    allowedRoot,
    outputParent,
    targetId,
    isProcessAlive,
  });
  let generation;
  let stagingFence;
  try {
    await assertDirectoryFence(
      lock.outputParentFence,
      `storyboard ${targetId} output parent`,
    );
    await assertSafePromotionState(lock.outputParent, targetId);
    generation = await createCaptureGeneration(lock.outputParent, targetId);
    try {
      await assertDirectoryFence(
        lock.outputParentFence,
        `storyboard ${targetId} output parent`,
      );
      const stagingStatus = await lstatIfExists(generation.stagingDirectory);
      if (!stagingStatus?.isDirectory() || stagingStatus.isSymbolicLink()) {
        throw new Error(`storyboard ${targetId} staging generation is unsafe`);
      }
      stagingFence = await captureDirectoryFence(
        generation.stagingDirectory,
        `storyboard ${targetId} staging generation`,
      );

      if (seedExisting) {
        const finalStatus = await lstatIfExists(generation.finalDirectory);
        if (finalStatus) {
          await copyDirectoryEntriesSafely(
            generation.finalDirectory,
            generation.stagingDirectory,
          );
        }
      }

      await assertDirectoryFence(
        lock.outputParentFence,
        `storyboard ${targetId} output parent`,
      );
      await assertDirectoryFence(
        stagingFence,
        `storyboard ${targetId} staging generation`,
      );

      const value = await buildGeneration({ ...generation, targetId });
      await assertDirectoryFence(
        lock.outputParentFence,
        `storyboard ${targetId} output parent`,
      );
      await assertDirectoryFence(
        stagingFence,
        `storyboard ${targetId} staging generation`,
      );
      await assertRegularDirectoryTree(
        generation.stagingDirectory,
        `storyboard ${targetId} staging generation`,
      );
      await assertSafePromotionState(lock.outputParent, targetId);
      const promotion = await promoteCaptureGeneration(generation);
      await assertDirectoryFence(
        lock.outputParentFence,
        `storyboard ${targetId} output parent`,
      );
      return Object.freeze({
        finalDirectory: generation.finalDirectory,
        promotion,
        value,
      });
    } catch (error) {
      try {
        await assertDirectoryFence(
          lock.outputParentFence,
          `storyboard ${targetId} output parent`,
        );
        if (!stagingFence) throw new Error("staging ownership was not established");
        await assertDirectoryFence(
          stagingFence,
          `storyboard ${targetId} staging generation`,
        );
        await discardCaptureGeneration(generation.stagingDirectory);
      } catch {
        // A replaced directory is retained for diagnosis. Never recursively
        // delete through a path whose exact inode identity is no longer ours.
      }
      throw error;
    }
  } finally {
    await releaseStoryboardGenerationLock(lock);
  }
}
