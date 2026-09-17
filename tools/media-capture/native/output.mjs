import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot, transientOutputRoot } from "../paths.mjs";
import { verifiedNativeSourceSelection } from "./selected-source.mjs";

export const nativeOutputRoot = resolve(transientOutputRoot, "native-multi-window");

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function assertNoSymlinkChain(path) {
  const repository = await realpath(repoRoot);
  const relativePath = relative(repoRoot, path);
  if (relativePath.startsWith("..")) throw new Error("native output escaped the repository");
  let cursor = repoRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error(`native output path contains a symlink: ${relative(repoRoot, cursor)}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      break;
    }
  }
  const existing = await realpath(repoRoot);
  if (existing !== repository) throw new Error("repository root changed during output validation");
}

export async function createNativeRunDirectory({ proof, scenarioId }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(scenarioId)) {
    throw new Error("native output scenario id is invalid");
  }
  await assertNoSymlinkChain(nativeOutputRoot);
  const scenarioRoot = resolve(nativeOutputRoot, scenarioId);
  await mkdir(scenarioRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkChain(scenarioRoot);
  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${proof.slice(0, 12)}`;
  const runRoot = resolve(scenarioRoot, runId);
  await mkdir(runRoot, { mode: 0o700 });
  const [realNativeRoot, realRunRoot] = await Promise.all([
    realpath(nativeOutputRoot),
    realpath(runRoot),
  ]);
  if (!isWithin(realNativeRoot, realRunRoot) || realNativeRoot === realRunRoot) {
    throw new Error("native run directory escaped the ignored output root");
  }
  return { runId, runRoot };
}

export async function assertNativeRunDirectory(runRoot) {
  const [realNativeRoot, realRunRoot, metadata] = await Promise.all([
    realpath(nativeOutputRoot),
    realpath(runRoot),
    stat(runRoot),
  ]);
  if (
    !metadata.isDirectory() ||
    !isWithin(realNativeRoot, realRunRoot) ||
    realNativeRoot === realRunRoot
  ) {
    throw new Error("native capture output is not an owned run directory");
  }
  await assertNoSymlinkChain(runRoot);
  return realRunRoot;
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function pngFileFacts(path) {
  const bytes = await readFile(path);
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error("native composed still is not a PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== 1_920 || height !== 1_080) {
    throw new Error(`native composed still is ${width}x${height}, expected 1920x1080`);
  }
  return {
    bytes: bytes.length,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width,
  };
}

export async function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
}

function byteEvidence(bytes) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sameEvidence(left, right) {
  return left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

export async function publishVerifiedNativeSource({
  runId,
  runRoot,
  scenarioId,
}) {
  const resolvedRunRoot = await assertNativeRunDirectory(runRoot);
  const expectedRunRoot = resolve(nativeOutputRoot, scenarioId, runId);
  if (resolvedRunRoot !== expectedRunRoot) {
    throw new Error("native source selection run identity does not match its path");
  }
  const manifestPath = resolve(resolvedRunRoot, "manifest.json");
  const cleanupPath = resolve(resolvedRunRoot, "cleanup-receipt.json");
  const [manifestBytes, cleanupBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(cleanupPath),
  ]);
  const manifest = parseJson(manifestBytes, "native media manifest");
  const cleanup = parseJson(cleanupBytes, "native cleanup receipt");
  const manifestEvidence = byteEvidence(manifestBytes);
  const cleanupEvidence = byteEvidence(cleanupBytes);
  if (
    manifest.scenarioId !== scenarioId ||
    cleanup.scenarioId !== scenarioId ||
    cleanup.runId !== runId ||
    cleanup.cleanupVerified !== true ||
    cleanup.runnerExitCode !== 0 ||
    cleanup.appProcessFinalStatus !== "absent" ||
    !sameEvidence(manifestEvidence, cleanup.manifest)
  ) {
    throw new Error("native source selection requires verified runner cleanup");
  }
  if (manifest.applicationSource?.dirty !== false) {
    throw new Error("native source selection requires a clean application source");
  }
  const artifactName = manifest.recording?.video?.relativePath;
  if (artifactName !== `${scenarioId}.webm`) {
    throw new Error("native source selection manifest artifact is invalid");
  }
  const artifactEvidence = await sha256File(
    resolve(resolvedRunRoot, artifactName),
  );
  if (!sameEvidence(artifactEvidence, manifest.recording.video)) {
    throw new Error("native source selection artifact does not match its manifest");
  }
  const selection = verifiedNativeSourceSelection({
    artifact: { name: artifactName, ...artifactEvidence },
    cleanupReceipt: cleanupEvidence,
    manifest: manifestEvidence,
    runId,
    scenarioId,
  });
  const selectionPath = resolve(
    nativeOutputRoot,
    scenarioId,
    "selected-source.json",
  );
  await writeJsonAtomic(selectionPath, selection);
  return {
    path: selectionPath,
    selection,
    evidence: await sha256File(selectionPath),
  };
}

export function orderedFrameDigest(records) {
  const hash = createHash("sha256");
  hash.update("dure-native-window-frames-v1\0");
  for (const record of records) {
    hash.update(`${record.label}\0${record.frame}\0${record.sha256}\0${record.bytes}\0`);
  }
  return hash.digest("hex");
}
