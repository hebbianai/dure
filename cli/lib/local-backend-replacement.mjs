import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readVerifiedDescriptorText } from "./fd-verified-read.mjs";
import {
  LOCAL_EXECUTABLE_IDENTITY_KEYS,
  parseLocalExecutableIdentity,
} from "./local-backend-executable-identity.mjs";

const INTENT_DIRECTORY = "replacement-intents";
const INTENT_KIND = "dure.local_backend_replacement_intent";
const MAX_INTENT_BYTES = 16 * 1024;
const GENERATION = /^local-v1-[a-f0-9]{32}$/;
const HMUX_IDENTITY_KEYS = [
  ...LOCAL_EXECUTABLE_IDENTITY_KEYS,
  "runtimeExecutablePath",
  "runtimeExecutableDevice",
  "runtimeExecutableInode",
  "runtimeExecutableSize",
  "runtimeExecutableModified",
  "runtimeExecutableSha256",
  "discoveryRoot",
  "discoveryDevice",
  "discoveryInode",
];
const DECIMAL_IDENTITY = /^[0-9]{1,64}$/;

const MESSAGES = Object.freeze({
  local_backend_replacement_downgrade:
    "the local backend replacement target is older than the running service",
  local_backend_replacement_intent_changed:
    "the local backend replacement intent changed while it was read",
  local_backend_replacement_intent_conflict:
    "a different local backend replacement intent already exists",
  local_backend_replacement_intent_invalid:
    "the local backend replacement intent is invalid",
  local_backend_replacement_intent_unavailable:
    "the local backend replacement intent is unavailable",
  local_backend_replacement_intent_unsafe:
    "the local backend replacement intent is not owner-only",
});

export class LocalBackendReplacementError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] ?? "the local backend replacement intent failed", options);
    this.code = code;
    this.name = "LocalBackendReplacementError";
  }
}

function fail(code, options) {
  throw new LocalBackendReplacementError(code, options);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function controlPlaneBuildSequence(buildId) {
  if (!boundedText(buildId, 160)) return null;
  const match =
    /^dure-control-plane\/v([1-9][0-9]*)-[a-zA-Z0-9._:/-]+$/.exec(buildId);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function assertReplacementDirection(sourceBuildId, targetBuildId) {
  const sourceSequence = controlPlaneBuildSequence(sourceBuildId);
  if (sourceSequence === null) return;
  const targetSequence = controlPlaneBuildSequence(targetBuildId);
  if (
    targetSequence === null ||
    targetSequence < sourceSequence ||
    (targetSequence === sourceSequence && targetBuildId !== sourceBuildId)
  ) {
    fail("local_backend_replacement_downgrade");
  }
}

function ownerDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    fail("local_backend_replacement_intent_unsafe");
  }
}

function syncDirectory(path) {
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_CLOEXEC ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function intentDirectory(root, { create = true } = {}) {
  const backendRoot = join(root, "backend");
  try {
    ownerDirectory(backendRoot);
    const directory = join(backendRoot, INTENT_DIRECTORY);
    if (create) {
      mkdirSync(directory, { mode: 0o700 });
      syncDirectory(backendRoot);
    }
    ownerDirectory(directory);
    return directory;
  } catch (error) {
    if (error instanceof LocalBackendReplacementError) throw error;
    if (error?.code === "ENOENT" && !create) return null;
    if (error?.code === "EEXIST") {
      const directory = join(backendRoot, INTENT_DIRECTORY);
      ownerDirectory(directory);
      return directory;
    }
    fail("local_backend_replacement_intent_unavailable", { cause: error });
  }
}

function intentPath(root, sourceGeneration, options) {
  if (!GENERATION.test(sourceGeneration)) {
    fail("local_backend_replacement_intent_invalid");
  }
  const directory = intentDirectory(root, options);
  return directory === null ? null : join(directory, `${sourceGeneration}.json`);
}

function readOwnerSource(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_CLOEXEC ?? 0),
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_INTENT_BYTES) ||
      (before.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid()))
    ) {
      fail("local_backend_replacement_intent_unsafe");
    }
    const text = readVerifiedDescriptorText(descriptor, before);
    if (text === null) {
      fail("local_backend_replacement_intent_changed");
    }
    return text;
  } catch (error) {
    if (error instanceof LocalBackendReplacementError) throw error;
    if (error?.code === "ENOENT") return null;
    fail("local_backend_replacement_intent_unavailable", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseExecutableIdentity(value) {
  const identity = parseLocalExecutableIdentity(value);
  if (identity === null) {
    fail("local_backend_replacement_intent_invalid");
  }
  return identity;
}

function parseHmuxIdentity(value) {
  if (
    !exactKeys(value, HMUX_IDENTITY_KEYS) ||
    !boundedText(value.discoveryRoot, 4_096) ||
    !isAbsolute(value.discoveryRoot) ||
    !DECIMAL_IDENTITY.test(value.discoveryDevice) ||
    !DECIMAL_IDENTITY.test(value.discoveryInode)
  ) {
    fail("local_backend_replacement_intent_invalid");
  }
  const runtime = parseExecutableIdentity({
    executablePath: value.runtimeExecutablePath,
    executableDevice: value.runtimeExecutableDevice,
    executableInode: value.runtimeExecutableInode,
    executableSize: value.runtimeExecutableSize,
    executableModified: value.runtimeExecutableModified,
    executableSha256: value.runtimeExecutableSha256,
  });
  return {
    ...parseExecutableIdentity(
      Object.fromEntries(
        LOCAL_EXECUTABLE_IDENTITY_KEYS.map((key) => [key, value[key]]),
      ),
    ),
    runtimeExecutablePath: runtime.executablePath,
    runtimeExecutableDevice: runtime.executableDevice,
    runtimeExecutableInode: runtime.executableInode,
    runtimeExecutableSize: runtime.executableSize,
    runtimeExecutableModified: runtime.executableModified,
    runtimeExecutableSha256: runtime.executableSha256,
    discoveryRoot: value.discoveryRoot,
    discoveryDevice: value.discoveryDevice,
    discoveryInode: value.discoveryInode,
  };
}

function parseSourceEndpoint(value) {
  if (
    !exactKeys(value, ["generation", "buildId", "hmuxIdentity"]) ||
    !GENERATION.test(value.generation) ||
    !(boundedText(value.buildId, 256) || value.buildId === null)
  ) {
    fail("local_backend_replacement_intent_invalid");
  }
  return {
    generation: value.generation,
    buildId: value.buildId,
    hmuxIdentity:
      value.hmuxIdentity === null ? null : parseHmuxIdentity(value.hmuxIdentity),
  };
}

function parseTargetEndpoint(value) {
  if (
    !exactKeys(value, [
      "generation",
      "buildId",
      "controlPlaneIdentity",
      "hmuxIdentity",
    ]) ||
    !GENERATION.test(value.generation) ||
    !boundedText(value.buildId, 256)
  ) {
    fail("local_backend_replacement_intent_invalid");
  }
  return {
    generation: value.generation,
    buildId: value.buildId,
    controlPlaneIdentity: parseExecutableIdentity(value.controlPlaneIdentity),
    hmuxIdentity: parseHmuxIdentity(value.hmuxIdentity),
  };
}

function parseIntent(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("local_backend_replacement_intent_invalid");
  }
  if (
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "source",
      "target",
      "createdAtMs",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== INTENT_KIND ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0
  ) {
    fail("local_backend_replacement_intent_invalid");
  }
  const intent = {
    schemaVersion: 1,
    kind: INTENT_KIND,
    source: parseSourceEndpoint(value.source),
    target: parseTargetEndpoint(value.target),
    createdAtMs: value.createdAtMs,
  };
  if (intent.source.generation === intent.target.generation) {
    fail("local_backend_replacement_intent_invalid");
  }
  return intent;
}

export function descriptorHmuxIdentity(descriptor) {
  if (
    descriptor.hmuxExecutablePath === undefined ||
    descriptor.hmuxRuntimeExecutablePath === undefined
  ) {
    return null;
  }
  return {
    executablePath: descriptor.hmuxExecutablePath,
    executableDevice: descriptor.hmuxExecutableDevice,
    executableInode: descriptor.hmuxExecutableInode,
    executableSize: descriptor.hmuxExecutableSize,
    executableModified: descriptor.hmuxExecutableModified,
    executableSha256: descriptor.hmuxExecutableSha256,
    runtimeExecutablePath: descriptor.hmuxRuntimeExecutablePath,
    runtimeExecutableDevice: descriptor.hmuxRuntimeExecutableDevice,
    runtimeExecutableInode: descriptor.hmuxRuntimeExecutableInode,
    runtimeExecutableSize: descriptor.hmuxRuntimeExecutableSize,
    runtimeExecutableModified: descriptor.hmuxRuntimeExecutableModified,
    runtimeExecutableSha256: descriptor.hmuxRuntimeExecutableSha256,
    discoveryRoot: descriptor.hmuxDiscoveryRoot,
    discoveryDevice: descriptor.hmuxDiscoveryDevice,
    discoveryInode: descriptor.hmuxDiscoveryInode,
  };
}

function descriptorControlPlaneIdentityMatches(descriptor, identity) {
  return (
    descriptor.controlPlaneIdentity === undefined ||
    same(descriptor.controlPlaneIdentity, identity)
  );
}

function sourceEndpoint(descriptor) {
  return {
    generation: descriptor.generation,
    buildId: descriptor.buildId ?? null,
    hmuxIdentity: descriptorHmuxIdentity(descriptor),
  };
}

function targetEndpoint(
  sourceGeneration,
  buildId,
  controlPlaneIdentity,
  hmuxIdentity,
) {
  const targetIdentity = {
    buildId,
    controlPlaneIdentity: parseExecutableIdentity(controlPlaneIdentity),
    hmuxIdentity: parseHmuxIdentity(hmuxIdentity),
  };
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        sourceGeneration,
        target: targetIdentity,
      }),
    )
    .digest("hex");
  return {
    generation: `local-v1-${digest.slice(0, 32)}`,
    ...targetIdentity,
  };
}

function same(left, right) {
  return isDeepStrictEqual(left, right);
}

function writeIntent(root, intent) {
  const directory = intentDirectory(root);
  const path = join(directory, `${intent.source.generation}.json`);
  const source = `${JSON.stringify(intent, null, 2)}\n`;
  const temporary = join(directory, `.replacement-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, source);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, path);
      syncDirectory(directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } catch (error) {
    if (error instanceof LocalBackendReplacementError) throw error;
    fail("local_backend_replacement_intent_unavailable", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        fail("local_backend_replacement_intent_unavailable", { cause: error });
      }
    }
  }
  const persisted = parseIntent(readOwnerSource(path));
  if (!same(persisted.source, intent.source) || !same(persisted.target, intent.target)) {
    fail("local_backend_replacement_intent_conflict");
  }
  return persisted;
}

function retireObservedDowngradeIntent(root, desired) {
  const path = intentPath(root, desired.source.generation, { create: false });
  if (path === null) return;
  const source = readOwnerSource(path);
  if (source === null) return;
  const persisted = parseIntent(source);
  if (same(persisted.source, desired.source) && same(persisted.target, desired.target)) {
    return;
  }
  const sourceSequence = controlPlaneBuildSequence(persisted.source.buildId);
  const persistedTargetSequence = controlPlaneBuildSequence(
    persisted.target.buildId,
  );
  const desiredTargetSequence = controlPlaneBuildSequence(desired.target.buildId);
  if (
    !same(persisted.source, desired.source) ||
    sourceSequence === null ||
    persistedTargetSequence === null ||
    desiredTargetSequence === null ||
    persistedTargetSequence >= sourceSequence ||
    desiredTargetSequence < sourceSequence
  ) {
    return;
  }
  removeLocalBackendReplacementIntent(
    root,
    persisted.source.generation,
    persisted.target.generation,
  );
}

export function ensureLocalBackendReplacementIntent({
  root,
  sourceDescriptor,
  sourceGeneration,
  sourceObservation = null,
  targetBuildId,
  targetControlPlaneIdentity,
  targetHmuxIdentity,
  now = Date.now,
}) {
  if (sourceDescriptor.generation !== sourceGeneration) {
    fail("local_backend_replacement_intent_conflict");
  }
  assertReplacementDirection(sourceDescriptor.buildId ?? null, targetBuildId);
  const target = targetEndpoint(
    sourceGeneration,
    targetBuildId,
    targetControlPlaneIdentity,
    targetHmuxIdentity,
  );
  const intent = parseIntent(
    JSON.stringify({
      schemaVersion: 1,
      kind: INTENT_KIND,
      source: sourceEndpoint(sourceDescriptor),
      target,
      createdAtMs: now(),
    }),
  );
  if (sourceObservation !== null) {
    if (
      !record(sourceObservation) ||
      sourceObservation.id !== sourceDescriptor.backendId ||
      sourceObservation.generation !== sourceGeneration
    ) {
      fail("local_backend_replacement_intent_conflict");
    }
    retireObservedDowngradeIntent(root, intent);
  }
  return writeIntent(root, intent);
}

export function replacementIntentForDescriptor({
  root,
  sourceGeneration,
  targetDescriptor,
  targetBuildId,
  targetControlPlaneIdentity,
  targetHmuxIdentity,
}) {
  const expectedTarget = targetEndpoint(
    sourceGeneration,
    targetBuildId,
    targetControlPlaneIdentity,
    targetHmuxIdentity,
  );
  if (targetDescriptor.generation !== expectedTarget.generation) return null;
  const path = intentPath(root, sourceGeneration, { create: false });
  if (path === null) return null;
  const source = readOwnerSource(path);
  if (source === null) return null;
  const intent = parseIntent(source);
  if (
    intent.source.generation !== sourceGeneration ||
    !same(intent.target, expectedTarget) ||
    targetDescriptor.buildId !== intent.target.buildId ||
    !descriptorControlPlaneIdentityMatches(
      targetDescriptor,
      intent.target.controlPlaneIdentity,
    ) ||
    !same(descriptorHmuxIdentity(targetDescriptor), intent.target.hmuxIdentity)
  ) {
    return null;
  }
  return intent;
}

function persistedReplacementIntentForDescriptor({
  root,
  sourceGeneration,
  targetDescriptor,
}) {
  const path = intentPath(root, sourceGeneration, { create: false });
  if (path === null) return null;
  const source = readOwnerSource(path);
  if (source === null) return null;
  const intent = parseIntent(source);
  if (
    intent.source.generation !== sourceGeneration ||
    intent.target.generation !== targetDescriptor.generation ||
    !descriptorControlPlaneIdentityMatches(
      targetDescriptor,
      intent.target.controlPlaneIdentity,
    ) ||
    !same(descriptorHmuxIdentity(targetDescriptor), intent.target.hmuxIdentity)
  ) {
    return null;
  }
  return intent;
}

export function localBackendReplacementIntentExists(root, sourceGeneration) {
  const path = intentPath(root, sourceGeneration, { create: false });
  return path !== null && readOwnerSource(path) !== null;
}

export function replacementIntentForVerifiedDescriptor({
  root,
  sourceGeneration,
  targetDescriptor,
  observedTargetBuildId,
}) {
  const intent = persistedReplacementIntentForDescriptor({
    root,
    sourceGeneration,
    targetDescriptor,
  });
  if (
    !intent ||
    intent.source.generation !== sourceGeneration ||
    intent.target.buildId === observedTargetBuildId ||
    targetDescriptor.buildId !== observedTargetBuildId
  ) {
    return null;
  }
  return intent;
}

export function replacementConfirmationForDescriptor({
  root,
  sourceGeneration,
  targetDescriptor,
  targetBuildId,
  targetControlPlaneIdentity,
  targetHmuxIdentity,
}) {
  const persistedIntent = persistedReplacementIntentForDescriptor({
    root,
    sourceGeneration,
    targetDescriptor,
  });
  if (
    persistedIntent &&
    targetDescriptor.buildId === persistedIntent.target.buildId
  ) {
    return {
      intent: persistedIntent,
      observedTargetBuildId: targetDescriptor.buildId,
    };
  }
  const intent = replacementIntentForDescriptor({
    root,
    sourceGeneration,
    targetDescriptor,
    targetBuildId,
    targetControlPlaneIdentity,
    targetHmuxIdentity,
  });
  if (intent) {
    return { intent, observedTargetBuildId: targetDescriptor.buildId };
  }
  const verifiedIntent = replacementIntentForVerifiedDescriptor({
    root,
    sourceGeneration,
    targetDescriptor,
    observedTargetBuildId: targetDescriptor.buildId,
  });
  if (
    !verifiedIntent ||
    targetDescriptor.buildId !== targetBuildId ||
    !same(
      verifiedIntent.target.controlPlaneIdentity,
      targetControlPlaneIdentity,
    ) ||
    !same(verifiedIntent.target.hmuxIdentity, targetHmuxIdentity)
  ) {
    return null;
  }
  return {
    intent: verifiedIntent,
    observedTargetBuildId: targetDescriptor.buildId,
  };
}

export function removeLocalBackendReplacementIntent(
  root,
  sourceGeneration,
  targetGeneration,
) {
  const path = intentPath(root, sourceGeneration, { create: false });
  if (path === null) return;
  const source = readOwnerSource(path);
  if (source === null) return;
  const intent = parseIntent(source);
  if (
    intent.source.generation !== sourceGeneration ||
    intent.target.generation !== targetGeneration
  ) {
    return;
  }
  try {
    unlinkSync(path);
    const directory = intentDirectory(root, { create: false });
    if (directory !== null) syncDirectory(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail("local_backend_replacement_intent_unavailable", { cause: error });
    }
  }
}
