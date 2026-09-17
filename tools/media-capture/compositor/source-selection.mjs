import { validateTourInput } from "./tour-motion.mjs";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { sha256FileEvidence } from "./file-digest.mjs";
import {
  probeCanonicalSourceMedia,
  validateCanonicalSourceMedia,
} from "./source-media.mjs";
import { assertVerifiedNativeSourceSelection } from "../native/selected-source.mjs";

function assertContained(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    resolve(root, pathFromRoot) !== candidate
  ) {
    throw new Error(`${label} escapes the capture root`);
  }
}

function capturePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function resolveSourceFile(root, path, label) {
  const candidate = resolve(path);
  assertContained(root, candidate, label);
  const resolved = await realpath(candidate);
  assertContained(root, resolved, label);
  return resolved;
}

async function readJsonFile(root, path, label) {
  const resolvedPath = await resolveSourceFile(root, path, label);
  const bytes = await readFile(resolvedPath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
  return {
    evidence: {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    path: resolvedPath,
    value,
  };
}

function sourceFileIdentity(root, file) {
  return {
    capturePath: capturePath(root, file.path),
    ...file.evidence,
  };
}

function verifiedSourceHandle({
  applicationBuild,
  artifactEvidence,
  artifactPath,
  captureProof,
  cleanupFile,
  manifest,
  manifestFile,
  media,
  root,
  selectionFile,
  source,
  terminalGeometry,
}) {
  if (
    source.proofProfile !== undefined &&
    captureProof?.profile !== source.proofProfile
  ) {
    throw new Error(`source ${source.id} proof profile does not match`);
  }
  return {
    id: source.id,
    kind: source.kind,
    scenario: source.scenario,
    capturePath: capturePath(root, artifactPath),
    artifact: artifactEvidence,
    manifest: {
      ...sourceFileIdentity(root, manifestFile),
      schemaVersion: manifest.schemaVersion,
    },
    ...(selectionFile
      ? { selection: sourceFileIdentity(root, selectionFile) }
      : {}),
    ...(cleanupFile
      ? { cleanupReceipt: sourceFileIdentity(root, cleanupFile) }
      : {}),
    applicationBuild,
    ...(manifest.recording?.encoding?.input ? { input: validateTourInput(manifest.recording.encoding.input, media.durationMs) } : {}),
    captureProof,
    proofProfile: source.proofProfile ?? null,
    terminalGeometry,
    requestedDurationMs: requestedDuration(manifest, source),
    media,
    durationMs: media.durationMs,
  };
}

function assertEvidence(actual, expected, label) {
  if (
    !expected ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} bytes do not match its selection receipt`);
  }
}

function requestedDuration(manifest, source) {
  const durationMs = manifest.recording?.requestedDurationMs;
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error(`source ${source.id} has no canonical recording duration`);
  }
  return durationMs;
}

async function probeVerifiedArtifact({
  artifactEvidence,
  artifactPath,
  probeSourceMedia,
  source,
}) {
  const media = validateCanonicalSourceMedia(
    await probeSourceMedia({ artifactPath, sourceId: source.id }),
  );
  const afterProbe = await sha256FileEvidence(artifactPath);
  if (
    afterProbe.bytes !== artifactEvidence.bytes ||
    afterProbe.sha256 !== artifactEvidence.sha256
  ) {
    throw new Error(`source ${source.id} changed while its media was probed`);
  }
  return media;
}

async function loadBrowserCapture(source, root, probeSourceMedia) {
  const scenarioDirectory = resolve(root, "media", source.scenario);
  assertContained(root, scenarioDirectory, `source ${source.id}`);
  const [manifestFile, artifactPath] = await Promise.all([
    readJsonFile(
      root,
      resolve(scenarioDirectory, "manifest.json"),
      `source ${source.id} manifest`,
    ),
    resolveSourceFile(
      root,
      resolve(scenarioDirectory, source.artifact),
      `source ${source.id} artifact`,
    ),
  ]);
  const manifest = manifestFile.value;
  if (manifest.scenario !== source.scenario) {
    throw new Error(`source ${source.id} manifest scenario does not match`);
  }
  if (manifest.applicationBuild?.dirty !== false) {
    throw new Error(`source ${source.id} was not captured from a clean build`);
  }
  const declaredArtifact = (manifest.artifacts ?? []).find(
    (candidate) => basename(candidate.path ?? "") === source.artifact,
  );
  if (!declaredArtifact) {
    throw new Error(`source ${source.id} is missing from its capture manifest`);
  }
  const artifactEvidence = await sha256FileEvidence(artifactPath);
  if (
    artifactEvidence.bytes !== declaredArtifact.bytes ||
    artifactEvidence.sha256 !== declaredArtifact.sha256
  ) {
    throw new Error(`source ${source.id} bytes do not match its capture manifest`);
  }
  const media = await probeVerifiedArtifact({
    artifactEvidence,
    artifactPath,
    probeSourceMedia,
    source,
  });
  return verifiedSourceHandle({
    applicationBuild: manifest.applicationBuild,
    captureProof: manifest.captureProof ?? null,
    artifactEvidence,
    artifactPath,
    manifest,
    manifestFile,
    media,
    root,
    source,
    terminalGeometry: manifest.terminalGeometry?.webm ?? {},
  });
}

async function loadNativeSelection(source, root, probeSourceMedia) {
  const scenarioDirectory = resolve(
    root,
    "native-multi-window",
    source.scenario,
  );
  assertContained(root, scenarioDirectory, `source ${source.id}`);
  const selectionFile = await readJsonFile(
    root,
    resolve(scenarioDirectory, "selected-source.json"),
    `source ${source.id} selection`,
  );
  let selection;
  try {
    selection = assertVerifiedNativeSourceSelection(selectionFile.value, {
      artifact: source.artifact,
      scenarioId: source.scenario,
    });
  } catch (error) {
    throw new Error(`source ${source.id} has an invalid native selection receipt`, {
      cause: error,
    });
  }
  const runDirectory = resolve(scenarioDirectory, selection.runId);
  assertContained(root, runDirectory, `source ${source.id} selected run`);
  const [manifestFile, cleanupFile, artifactPath] = await Promise.all([
    readJsonFile(
      root,
      resolve(runDirectory, "manifest.json"),
      `source ${source.id} manifest`,
    ),
    readJsonFile(
      root,
      resolve(runDirectory, "cleanup-receipt.json"),
      `source ${source.id} cleanup receipt`,
    ),
    resolveSourceFile(
      root,
      resolve(runDirectory, source.artifact),
      `source ${source.id} artifact`,
    ),
  ]);
  assertEvidence(
    manifestFile.evidence,
    selection.files?.manifest,
    `source ${source.id} manifest`,
  );
  assertEvidence(
    cleanupFile.evidence,
    selection.files?.cleanupReceipt,
    `source ${source.id} cleanup receipt`,
  );
  const manifest = manifestFile.value;
  const cleanup = cleanupFile.value;
  if (
    manifest.scenarioId !== source.scenario ||
    cleanup.scenarioId !== source.scenario ||
    cleanup.runId !== selection.runId
  ) {
    throw new Error(`source ${source.id} native run identity does not match`);
  }
  if (
    cleanup.cleanupVerified !== true ||
    cleanup.runnerExitCode !== 0 ||
    cleanup.appProcessFinalStatus !== "absent"
  ) {
    throw new Error(`source ${source.id} native cleanup was not verified`);
  }
  assertEvidence(
    manifestFile.evidence,
    cleanup.manifest,
    `source ${source.id} cleanup manifest`,
  );
  if (manifest.applicationSource?.dirty !== false) {
    throw new Error(`source ${source.id} was not captured from a clean build`);
  }
  if (manifest.recording?.video?.relativePath !== source.artifact) {
    throw new Error(`source ${source.id} native manifest artifact does not match`);
  }
  const artifactEvidence = await sha256FileEvidence(artifactPath);
  assertEvidence(
    artifactEvidence,
    selection.files?.artifact,
    `source ${source.id} artifact`,
  );
  if (
    artifactEvidence.bytes !== manifest.recording.video.bytes ||
    artifactEvidence.sha256 !== manifest.recording.video.sha256
  ) {
    throw new Error(`source ${source.id} bytes do not match its capture manifest`);
  }
  const media = await probeVerifiedArtifact({
    artifactEvidence,
    artifactPath,
    probeSourceMedia,
    source,
  });
  return verifiedSourceHandle({
    applicationBuild: {
      buildId: manifest.descriptor?.buildId,
      packageVersion: manifest.descriptor?.packageVersion,
      sourceRevision: manifest.applicationSource.sourceRevision,
      dirty: manifest.applicationSource.dirty,
      workingTreeFingerprint:
        manifest.applicationSource.workingTreeFingerprint,
    },
    artifactEvidence,
    artifactPath,
    captureProof: manifest.captureProof ?? null,
    cleanupFile,
    manifest,
    manifestFile,
    media,
    root,
    selectionFile,
    source,
    terminalGeometry: {},
  });
}

export async function loadVerifiedStoryboardSource({
  source,
  captureRoot,
  probeSourceMedia = probeCanonicalSourceMedia,
}) {
  if (source.kind === "browser-capture") {
    return loadBrowserCapture(source, captureRoot, probeSourceMedia);
  }
  if (source.kind === "native-selection") {
    return loadNativeSelection(source, captureRoot, probeSourceMedia);
  }
  throw new Error(`source ${source.id} has an unsupported capture kind`);
}
