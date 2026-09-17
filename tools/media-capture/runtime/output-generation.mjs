import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const PROMOTION_SCHEMA_VERSION = 1;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

async function pathExists(path) {
  try {
    const handle = await open(path, "r");
    await handle.close();
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
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

async function writeDurableJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.partial`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
}

async function readRegularFileWithoutFollowingLinks(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new Error(`capture promotion journal is not a regular file: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export function capturePromotionJournalPath(outputRoot, scenarioId) {
  return resolve(outputRoot, `.${scenarioId}.promotion.json`);
}

function promotionPath(outputRoot, name, label) {
  if (
    typeof name !== "string" ||
    basename(name) !== name ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`capture promotion ${label} is not a safe basename`);
  }
  return resolve(outputRoot, name);
}

function generationEntryPath(outputRoot, scenarioId, name, suffix, label) {
  const path = promotionPath(outputRoot, name, label);
  const escapedScenario = scenarioId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownedName = new RegExp(
    `^\\.${escapedScenario}\\.[1-9][0-9]*\\.${UUID_PATTERN}\\.${suffix}$`,
  );
  if (!ownedName.test(name)) {
    throw new Error(`capture promotion ${label} is not owned by ${scenarioId}`);
  }
  return path;
}

function decodePromotionJournal(outputRoot, scenarioId, value) {
  if (
    value?.schemaVersion !== PROMOTION_SCHEMA_VERSION ||
    value?.scenarioId !== scenarioId ||
    value?.finalName !== scenarioId
  ) {
    throw new Error(`capture promotion journal is invalid for ${scenarioId}`);
  }
  return {
    finalDirectory: promotionPath(outputRoot, value.finalName, "finalName"),
    stagingDirectory: generationEntryPath(
      outputRoot,
      scenarioId,
      value.stagingName,
      "partial",
      "stagingName",
    ),
    backupDirectory: generationEntryPath(
      outputRoot,
      scenarioId,
      value.backupName,
      "previous",
      "backupName",
    ),
  };
}

async function removeJournal(journalPath) {
  await rm(journalPath, { force: true });
  await syncDirectory(dirname(journalPath));
}

export async function recoverCapturePromotion(outputRoot, scenarioId) {
  const journalPath = capturePromotionJournalPath(outputRoot, scenarioId);
  let encoded;
  try {
    encoded = JSON.parse(await readRegularFileWithoutFollowingLinks(journalPath));
  } catch (error) {
    if (error?.code === "ENOENT") return { recovered: false };
    throw error;
  }
  const { finalDirectory, stagingDirectory, backupDirectory } =
    decodePromotionJournal(outputRoot, scenarioId, encoded);
  const [finalExists, stagingExists, backupExists] = await Promise.all([
    pathExists(finalDirectory),
    pathExists(stagingDirectory),
    pathExists(backupDirectory),
  ]);

  let outcome;
  if (!finalExists && backupExists) {
    await rename(backupDirectory, finalDirectory);
    outcome = "previous-restored";
  } else if (!finalExists && !backupExists && stagingExists) {
    await rename(stagingDirectory, finalDirectory);
    outcome = "first-generation-committed";
  } else if (finalExists) {
    outcome = backupExists ? "committed-backup-cleaned" : "previous-preserved";
  } else {
    throw new Error(
      `capture promotion journal has no recoverable generation for ${scenarioId}`,
    );
  }

  if (await pathExists(backupDirectory)) {
    await rm(backupDirectory, { recursive: true, force: true });
  }
  if (await pathExists(stagingDirectory)) {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  await removeJournal(journalPath);
  return { recovered: true, outcome };
}

export async function createCaptureGeneration(outputRoot, scenarioId) {
  await recoverCapturePromotion(outputRoot, scenarioId);
  const stagingDirectory = resolve(
    outputRoot,
    `.${scenarioId}.${process.pid}.${randomUUID()}.partial`,
  );
  await mkdir(stagingDirectory, { recursive: false });
  return {
    finalDirectory: resolve(outputRoot, scenarioId),
    stagingDirectory,
  };
}

export async function discardCaptureGeneration(stagingDirectory) {
  await rm(stagingDirectory, { recursive: true, force: true });
}

export async function promoteCaptureGeneration({
  finalDirectory,
  stagingDirectory,
}) {
  const outputRoot = dirname(finalDirectory);
  const scenarioId = basename(finalDirectory);
  const backupDirectory = resolve(
    outputRoot,
    `.${scenarioId}.${process.pid}.${randomUUID()}.previous`,
  );
  const journalPath = capturePromotionJournalPath(outputRoot, scenarioId);
  await writeDurableJson(journalPath, {
    schemaVersion: PROMOTION_SCHEMA_VERSION,
    scenarioId,
    finalName: scenarioId,
    stagingName: basename(stagingDirectory),
    backupName: basename(backupDirectory),
  });

  let backedUp = false;
  try {
    await rename(finalDirectory, backupDirectory);
    backedUp = true;
    await syncDirectory(outputRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagingDirectory, finalDirectory);
    await syncDirectory(outputRoot);
  } catch (error) {
    if (backedUp) {
      try {
        await rename(backupDirectory, finalDirectory);
        await syncDirectory(outputRoot);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `capture generation promotion and rollback both failed for ${finalDirectory}`,
        );
      }
    }
    await removeJournal(journalPath).catch(() => {});
    throw error;
  }

  let cleanupPending = false;
  try {
    if (backedUp) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
    await removeJournal(journalPath);
  } catch {
    cleanupPending = true;
  }
  return { committed: true, cleanupPending };
}
