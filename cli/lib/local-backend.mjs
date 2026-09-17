import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BACKEND_PROFILES_FILE,
  BACKEND_PROFILES_KIND,
  BACKEND_PROFILES_SCHEMA_VERSION,
  MAX_BACKEND_PROFILES_BYTES,
  BackendProfileError,
  loadBackendProfiles,
  parseBackendProfiles,
  resolveBackendProfilesPath,
  selectBackendProfile,
} from "./backend-profiles.mjs";
import {
  BackendTransportError,
  performBackendProfileRequest,
} from "./backend-transport.mjs";
import {
  ClaudeStructuredRuntimeBundleError,
  claudeStructuredRuntimeArguments,
  resolveBundledClaudeStructuredRuntime,
} from "./claude-structured-runtime.mjs";
import {
  CONTROL_PLANE_BUILD_ID,
  CONTROL_PLANE_CAPABILITIES as LOCAL_CAPABILITIES,
  ControlPlaneContractError,
  currentControlPlaneBundleIdentity,
} from "./control-plane-contract.mjs";
import { readVerifiedDescriptorText } from "./fd-verified-read.mjs";
import { localBackendServiceEnvironment } from "./local-backend-environment.mjs";
import { parseLocalExecutableIdentity } from "./local-backend-executable-identity.mjs";
import {
  LocalBackendReplacementError,
  controlPlaneBuildSequence,
  descriptorHmuxIdentity,
  ensureLocalBackendReplacementIntent,
  localBackendReplacementIntentExists,
  removeLocalBackendReplacementIntent,
  replacementConfirmationForDescriptor,
} from "./local-backend-replacement.mjs";

const LOCAL_PROFILE_ID = "local";
const LOCAL_BACKEND_ID = "dure-local";
const DESCRIPTOR_FILE = "control-plane.json";
const SERVICE_READY_TIMEOUT_MS = 4_000;
const SERVICE_POLL_MS = 40;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const CURRENT_DESCRIPTOR_SCHEMA_VERSION = 5;
const GENERATION_SOCKET_DESCRIPTOR_SCHEMA_VERSION = 3;
const EXECUTABLE_IDENTITY_DESCRIPTOR_SCHEMA_VERSION = 4;

const MESSAGES = Object.freeze({
  local_backend_login_environment_unavailable:
    "could not resolve the login-shell provider PATH; review shell startup and retry",
  local_backend_binding_receipt_invalid:
    "the local backend returned an invalid binding receipt",
  local_backend_binding_receipt_mismatch:
    "the local backend binding receipt does not match the selected agent",
  local_backend_descriptor_changed:
    "the local backend descriptor changed while it was read",
  local_backend_descriptor_invalid: "the local backend descriptor is invalid",
  local_backend_descriptor_unavailable:
    "the local backend descriptor is unavailable",
  local_backend_descriptor_unsafe:
    "the local backend descriptor is not an owner-only regular file",
  local_backend_catalog_changed:
    "the backend profile catalog changed during local backend upgrade",
  local_backend_control_plane_build_mismatch:
    "the installed control-plane build does not match this CLI",
  local_backend_control_plane_capabilities_mismatch:
    "the installed control-plane capabilities do not match this CLI",
  local_backend_control_plane_identity_invalid:
    "the installed control-plane identity receipt is invalid",
  local_backend_executable_invalid:
    "the local backend executable path must be absolute",
  local_backend_executable_changed:
    "the local backend executable changed during replacement",
  local_backend_executable_missing:
    "the installed local backend executable is missing",
  local_backend_hmux_binding_unavailable:
    "the selected agent has no exact managed Hmux binding",
  local_backend_hmux_discovery_root_invalid:
    "the Hmux discovery root must be an existing absolute directory",
  local_backend_hmux_executable_invalid:
    "the Hmux executable must resolve to an executable regular file",
  local_backend_hmux_runtime_executable_invalid:
    "the Hmux runtime executable must resolve to an executable regular file",
  local_backend_root_unsafe:
    "the local backend root must be an owner-only directory",
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
  local_backend_replacement_downgrade:
    "the local backend replacement target is older than the running service",
  cli_update_required:
    "update Dure App, then run `dure install --global` to refresh the verified CLI bundle",
  recovering: "the local backend is switching to a verified generation; retry this operation",
  local_backend_upgrade_rejected:
    "the owned local backend could not be upgraded safely",
  local_backend_unavailable: "the local backend is unavailable",
  local_backend_activation_not_managed:
    "only the canonical managed local backend can activate this CLI bundle",
});

function generationSocketName(generation) {
  const key = createHash("sha256").update(String(generation)).digest("hex").slice(0, 32);
  return `cp.${key}.sock`;
}

function legacyGenerationSocketPath(root, generation) {
  return join(root, "backend", generationSocketName(generation));
}

function backendRuntimeRoot(root) {
  const effectiveUserId = process.geteuid?.() ?? process.getuid?.();
  if (!Number.isSafeInteger(effectiveUserId) || effectiveUserId < 0) {
    fail("local_backend_root_unsafe");
  }
  const durableRoot = join(root, "backend");
  const key = createHash("sha256")
    .update(durableRoot)
    .digest("hex")
    .slice(0, 16);
  return join("/tmp", `d.${effectiveUserId}`, `b.${key}`);
}

function generationSocketPath(root, generation) {
  return join(backendRuntimeRoot(root), generationSocketName(generation));
}

function descriptorSocketPath(root, generation, schemaVersion) {
  if (schemaVersion <= 2) return join(root, "backend", "control-plane.sock");
  if (schemaVersion <= EXECUTABLE_IDENTITY_DESCRIPTOR_SCHEMA_VERSION) {
    return legacyGenerationSocketPath(root, generation);
  }
  return generationSocketPath(root, generation);
}

function descriptorDatabasePath(root) {
  return join(root, "backend", "application-state.sqlite3");
}

function candidateDescriptorPath(root, generation) {
  return join(
    root,
    "backend",
    `control-plane.${generation}.candidate.json`,
  );
}

function managedLocalSocketPath(root, socketPath, generation) {
  return [
    join(root, "backend", "control-plane.sock"),
    legacyGenerationSocketPath(root, generation),
    generationSocketPath(root, generation),
  ].includes(socketPath);
}

export class LocalBackendError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] ?? "the local backend operation failed", options);
    this.code = code;
    this.name = "LocalBackendError";
  }
}

function fail(code, options) {
  throw new LocalBackendError(code, options);
}

function replacementOperation(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LocalBackendReplacementError) {
      fail(error.code, { cause: error });
    }
    throw error;
  }
}

function appHome(environment) {
  return dirname(
    resolveBackendProfilesPath({
      environment,
      homeDirectory: environment.HOME || homedir(),
    }),
  );
}

function assertOwnerDirectory(path, failureCode = "local_backend_root_unsafe") {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    fail(failureCode);
  }
}

function ensureHome(environment) {
  const root = appHome(environment);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertOwnerDirectory(root);
  return root;
}

function readOwnerFile(path, maximum) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_CLOEXEC ?? 0),
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.size < 1n ||
      stat.size > BigInt(maximum) ||
      (stat.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" &&
        stat.uid !== BigInt(process.getuid()))
    ) {
      fail("local_backend_descriptor_unsafe");
    }
    const text = readVerifiedDescriptorText(descriptor, stat);
    if (text === null) {
      fail("local_backend_descriptor_changed");
    }
    return text;
  } catch (error) {
    if (error instanceof LocalBackendError) throw error;
    if (error?.code === "ENOENT") return null;
    fail("local_backend_descriptor_unavailable", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseDescriptor(source, root) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("local_backend_descriptor_invalid");
  }
  const expectedKeys = new Set([
    "schemaVersion",
    "backendId",
    "buildId",
    "generation",
    "activationSourceGeneration",
    "socketPath",
    "databasePath",
    "controlPlaneIdentity",
    "hmuxExecutablePath",
    "hmuxExecutableDevice",
    "hmuxExecutableInode",
    "hmuxExecutableSize",
    "hmuxExecutableModified",
    "hmuxExecutableSha256",
    "hmuxRuntimeExecutablePath",
    "hmuxRuntimeExecutableDevice",
    "hmuxRuntimeExecutableInode",
    "hmuxRuntimeExecutableSize",
    "hmuxRuntimeExecutableModified",
    "hmuxRuntimeExecutableSha256",
    "hmuxDiscoveryRoot",
    "hmuxDiscoveryDevice",
    "hmuxDiscoveryInode",
    "processId",
    "observedAtMs",
  ]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    ![
      1,
      2,
      GENERATION_SOCKET_DESCRIPTOR_SCHEMA_VERSION,
      EXECUTABLE_IDENTITY_DESCRIPTOR_SCHEMA_VERSION,
      CURRENT_DESCRIPTOR_SCHEMA_VERSION,
    ].includes(value.schemaVersion) ||
    value.backendId !== LOCAL_BACKEND_ID ||
    (value.buildId !== undefined && typeof value.buildId !== "string") ||
    typeof value.generation !== "string" ||
    !/^local-v1-[a-f0-9]{32}$/.test(value.generation) ||
    (value.activationSourceGeneration !== undefined &&
      (![3, 4, CURRENT_DESCRIPTOR_SCHEMA_VERSION].includes(value.schemaVersion) ||
        !/^local-v1-[a-f0-9]{32}$/.test(value.activationSourceGeneration) ||
        value.activationSourceGeneration === value.generation)) ||
    value.socketPath !==
      descriptorSocketPath(root, value.generation, value.schemaVersion) ||
    value.databasePath !== descriptorDatabasePath(root) ||
    !Number.isSafeInteger(value.processId) ||
    value.processId < 1 ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 0
  ) {
    fail("local_backend_descriptor_invalid");
  }
  const executableIdentityValues = [
    value.hmuxExecutablePath,
    value.hmuxExecutableDevice,
    value.hmuxExecutableInode,
    value.hmuxExecutableSize,
    value.hmuxExecutableModified,
    value.hmuxExecutableSha256,
  ];
  const runtimeIdentityValues = [
    value.hmuxRuntimeExecutablePath,
    value.hmuxRuntimeExecutableDevice,
    value.hmuxRuntimeExecutableInode,
    value.hmuxRuntimeExecutableSize,
    value.hmuxRuntimeExecutableModified,
    value.hmuxRuntimeExecutableSha256,
  ];
  const discoveryIdentityValues = [
    value.hmuxDiscoveryRoot,
    value.hmuxDiscoveryDevice,
    value.hmuxDiscoveryInode,
  ];
  const validExecutableIdentity = (entries) =>
    isAbsolute(entries[0] ?? "") &&
    entries
      .slice(1)
      .every((entry) => typeof entry === "string" && entry.length > 0);
  const identityAbsent = [
    ...executableIdentityValues,
    ...runtimeIdentityValues,
    ...discoveryIdentityValues,
  ].every((entry) => entry === undefined);
  const discoveryIdentityValid =
    isAbsolute(discoveryIdentityValues[0] ?? "") &&
    discoveryIdentityValues
      .slice(1)
      .every((entry) => typeof entry === "string" && entry.length > 0);
  const fullIdentity =
    validExecutableIdentity(executableIdentityValues) &&
    validExecutableIdentity(runtimeIdentityValues) &&
    discoveryIdentityValid;
  const controlPlaneIdentityValid =
    parseLocalExecutableIdentity(value.controlPlaneIdentity) !== null;
  const controlPlaneIdentityInvalid =
    [
      EXECUTABLE_IDENTITY_DESCRIPTOR_SCHEMA_VERSION,
      CURRENT_DESCRIPTOR_SCHEMA_VERSION,
    ].includes(value.schemaVersion)
      ? controlPlaneBuildSequence(value.buildId) === null ||
        !controlPlaneIdentityValid
      : value.controlPlaneIdentity !== undefined;
  // v21 pinned only the query CLI. Accept it solely as a source for the
  // journaled replacement into the complete v22 toolchain identity.
  const upgradeableLegacyIdentity =
    value.buildId !== CONTROL_PLANE_BUILD_ID &&
    validExecutableIdentity(executableIdentityValues) &&
    runtimeIdentityValues.every((entry) => entry === undefined) &&
    discoveryIdentityValid;
  if (
    controlPlaneIdentityInvalid ||
    (value.buildId === CONTROL_PLANE_BUILD_ID && !fullIdentity) ||
    (!identityAbsent && !fullIdentity && !upgradeableLegacyIdentity)
  ) {
    fail("local_backend_descriptor_invalid");
  }
  return value;
}

function readDescriptor(root) {
  const source = readOwnerFile(
    join(root, "backend", DESCRIPTOR_FILE),
    MAX_DESCRIPTOR_BYTES,
  );
  return source === null ? null : parseDescriptor(source, root);
}

function readCandidateDescriptor(root, generation) {
  const source = readOwnerFile(
    candidateDescriptorPath(root, generation),
    MAX_DESCRIPTOR_BYTES,
  );
  return source === null ? null : parseDescriptor(source, root);
}

function profileForDescriptor(descriptor, capabilities = LOCAL_CAPABILITIES) {
  return {
    id: LOCAL_PROFILE_ID,
    default: true,
    transport: {
      kind: "local",
      endpoint: { kind: "unix_socket", path: descriptor.socketPath },
    },
    auth: { kind: "peer" },
    trust: { kind: "local_peer" },
    expected: {
      backendId: LOCAL_BACKEND_ID,
      generation: descriptor.generation,
      protocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 0 },
      },
      capabilities: [...capabilities],
    },
    deadlineMs: 185_000,
  };
}

function catalogSource(profile) {
  return `${JSON.stringify({
    schemaVersion: BACKEND_PROFILES_SCHEMA_VERSION,
    kind: BACKEND_PROFILES_KIND,
    profiles: [profile],
  }, null, 2)}\n`;
}

function syncDirectory(path) {
  const directory = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_CLOEXEC ?? 0),
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function writeMissingCatalog(root, profile) {
  const path = join(root, BACKEND_PROFILES_FILE);
  const temporary = join(
    root,
    `.backend-profiles-${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, catalogSource(profile));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    syncDirectory(root);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function replaceCanonicalLocalProfile(root, catalog, profile, environment) {
  const path = join(root, BACKEND_PROFILES_FILE);
  const source = readOwnerFile(path, MAX_BACKEND_PROFILES_BYTES);
  if (source === null) fail("local_backend_catalog_changed");
  const observed = parseBackendProfiles(source);
  const selected = observed.profiles.find((candidate) => candidate.id === LOCAL_PROFILE_ID);
  if (
    !selected ||
    !isCanonicalManagedLocalProfile(selected, environment) ||
    JSON.stringify(observed) !== JSON.stringify(catalog)
  ) {
    fail("local_backend_catalog_changed");
  }
  const document = JSON.parse(source);
  document.profiles = document.profiles.map((candidate) =>
    candidate.id === LOCAL_PROFILE_ID ? profile : candidate,
  );
  const temporary = join(root, `.backend-profiles-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, `${JSON.stringify(document, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (readOwnerFile(path, MAX_BACKEND_PROFILES_BYTES) !== source) {
      fail("local_backend_catalog_changed");
    }
    renameSync(temporary, path);
    syncDirectory(root);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export function resolveLocalBackendExecutable(cliScriptPath, environment = process.env) {
  const override = environment.DURE_CONTROL_PLANE_BIN;
  if (override) {
    if (!isAbsolute(override)) fail("local_backend_executable_invalid");
    return override;
  }
  return join(dirname(cliScriptPath), "dure-control-plane");
}

function executableIdentity(
  requested,
  environment,
  failureCode = "local_backend_hmux_executable_invalid",
) {
  const executable = resolveExecutablePath(requested, environment, failureCode);
  return {
    executablePath: executable.path,
    executableDevice: executable.metadata.dev.toString(),
    executableInode: executable.metadata.ino.toString(),
    executableSize: executable.metadata.size.toString(),
    executableModified: `${executable.metadata.mtimeNs / 1_000_000_000n}:${executable.metadata.mtimeNs % 1_000_000_000n}`,
    executableSha256: createHash("sha256")
      .update(readFileSync(executable.path))
      .digest("hex"),
  };
}

function resolveControlPlaneIdentity(cliScriptPath, environment) {
  return executableIdentity(
    resolveLocalBackendExecutable(cliScriptPath, environment),
    environment,
    "local_backend_executable_missing",
  );
}

function validateControlPlaneIdentity(identity, environment) {
  const observed = executableIdentity(
    identity.executablePath,
    environment,
    "local_backend_executable_missing",
  );
  if (JSON.stringify(observed) !== JSON.stringify(identity)) {
    fail("local_backend_executable_changed");
  }
  return observed;
}

function validateControlPlaneContract(identity, environment) {
  const executable = validateControlPlaneIdentity(identity, environment);
  try {
    const receipt = currentControlPlaneBundleIdentity(
      executable.executablePath,
      { environment },
    );
    validateControlPlaneIdentity(identity, environment);
    return receipt;
  } catch (error) {
    if (!(error instanceof ControlPlaneContractError)) throw error;
    if (error.code === "control_plane_build_mismatch") {
      fail("local_backend_control_plane_build_mismatch", { cause: error });
    }
    if (error.code === "control_plane_capabilities_mismatch") {
      fail("local_backend_control_plane_capabilities_mismatch", {
        cause: error,
      });
    }
    fail("local_backend_control_plane_identity_invalid", { cause: error });
  }
}

function validateControlPlanePreflight({
  claudeRuntime,
  controlPlaneIdentity,
  environment,
  hmuxIdentity,
  root,
}) {
  const executable = validateControlPlaneIdentity(
    controlPlaneIdentity,
    environment,
  ).executablePath;
  const result = spawnSync(
    executable,
    [
      "preflight",
      "--home",
      root,
      "--hmux-bin",
      hmuxIdentity.executablePath,
      "--hmux-runtime-bin",
      hmuxIdentity.runtimeExecutablePath,
      "--hmux-discovery-root",
      hmuxIdentity.discoveryRoot,
      ...claudeStructuredRuntimeArguments(claudeRuntime),
    ],
    {
      encoding: "utf8",
      env: environment,
      maxBuffer: MAX_DESCRIPTOR_BYTES,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {}
  if (
    result.error ||
    result.status !== 0 ||
    !receipt ||
    Object.keys(receipt).length !== 5 ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "dure.control_plane.preflight" ||
    receipt.buildId !== CONTROL_PLANE_BUILD_ID ||
    receipt.descriptorSchemaVersion !== CURRENT_DESCRIPTOR_SCHEMA_VERSION ||
    !isDeepStrictEqual(receipt.hmuxIdentity, hmuxIdentity)
  ) {
    fail("cli_update_required", { cause: result.error });
  }
  validateControlPlaneIdentity(controlPlaneIdentity, environment);
}

function requestedHmuxExecutable(environment) {
  return (
    environment.DURE_HMUX_BIN ||
    (environment.HMUX_INSTALL_DIR
      ? join(environment.HMUX_INSTALL_DIR, "hmux")
      : "hmux")
  );
}

function requestedHmuxRuntimeExecutable(environment, hmuxExecutablePath) {
  return (
    environment.DURE_HMUX_RUNTIME_BIN ||
    environment.HMUX_RUNTIME ||
    environment.HEBBIAN_HMUX_RUNTIME ||
    join(
      dirname(hmuxExecutablePath),
      process.platform === "win32" ? "hmux-runtime.exe" : "hmux-runtime",
    )
  );
}

function resolveExecutablePath(
  requested,
  environment,
  failureCode = "local_backend_hmux_executable_invalid",
) {
  const candidates = requested.includes("/")
    ? [requested]
    : (environment.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, requested));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      const path = realpathSync(candidate);
      const metadata = statSync(path, { bigint: true });
      if (!metadata.isFile() || (metadata.mode & 0o111n) === 0n) continue;
      if (metadata.size < 1n || metadata.size > 256n * 1024n * 1024n) continue;
      return { path, metadata };
    } catch {
      // Continue through the explicit PATH candidates without spawning `which`.
    }
  }
  fail(failureCode);
}

export function defaultHmuxDiscoveryRoot(environment) {
  return join(appHome(environment), "state", "hmux-hosts");
}

export function resolveHmuxToolchainIdentity(environment) {
  const executable = executableIdentity(
    requestedHmuxExecutable(environment),
    environment,
  );
  const runtime = executableIdentity(
    requestedHmuxRuntimeExecutable(environment, executable.executablePath),
    environment,
    "local_backend_hmux_runtime_executable_invalid",
  );
  const explicitRoot = environment.HMUX_DISCOVERY_ROOT;
  if (explicitRoot !== undefined && explicitRoot === "") {
    fail("local_backend_hmux_discovery_root_invalid");
  }
  const requestedRoot = explicitRoot ?? defaultHmuxDiscoveryRoot(environment);
  if (!isAbsolute(requestedRoot)) {
    fail("local_backend_hmux_discovery_root_invalid");
  }
  if (explicitRoot === undefined) {
    try {
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      assertOwnerDirectory(
        requestedRoot,
        "local_backend_hmux_discovery_root_invalid",
      );
    } catch (error) {
      if (error instanceof LocalBackendError) throw error;
      fail("local_backend_hmux_discovery_root_invalid", { cause: error });
    }
  }
  let discoveryRoot;
  let discoveryMetadata;
  try {
    discoveryRoot = realpathSync(resolve(requestedRoot));
    discoveryMetadata = statSync(discoveryRoot, { bigint: true });
    if (!discoveryMetadata.isDirectory()) {
      fail("local_backend_hmux_discovery_root_invalid");
    }
  } catch (error) {
    if (error instanceof LocalBackendError) throw error;
    fail("local_backend_hmux_discovery_root_invalid", { cause: error });
  }
  return {
    ...executable,
    runtimeExecutablePath: runtime.executablePath,
    runtimeExecutableDevice: runtime.executableDevice,
    runtimeExecutableInode: runtime.executableInode,
    runtimeExecutableSize: runtime.executableSize,
    runtimeExecutableModified: runtime.executableModified,
    runtimeExecutableSha256: runtime.executableSha256,
    discoveryRoot,
    discoveryDevice: discoveryMetadata.dev.toString(),
    discoveryInode: discoveryMetadata.ino.toString(),
  };
}

async function pingObservation(descriptor) {
  try {
    const response = await performBackendProfileRequest(
      profileForDescriptor(descriptor, []),
      {
        body: { schemaVersion: 1 },
        operation: "backend.ping",
      },
    );
    return response.backend;
  } catch {
    return null;
  }
}

function sameExecutablePayload(left, right) {
  const parsedLeft = parseLocalExecutableIdentity(left);
  const parsedRight = parseLocalExecutableIdentity(right);
  return (
    parsedLeft !== null &&
    parsedRight !== null &&
    parsedLeft.executableSize === parsedRight.executableSize &&
    parsedLeft.executableSha256 === parsedRight.executableSha256
  );
}

function claudeRuntimeForControlPlane({
  controlPlaneIdentity,
  currentControlPlaneIdentity,
  currentRuntime,
  root,
}) {
  if (
    isDeepStrictEqual(controlPlaneIdentity, currentControlPlaneIdentity)
  ) {
    return currentRuntime;
  }
  const cliScriptPath = join(
    dirname(controlPlaneIdentity.executablePath),
    "dure.mjs",
  );
  try {
    accessSync(cliScriptPath, fsConstants.R_OK);
  } catch {
    return currentRuntime;
  }
  return resolveBundledClaudeStructuredRuntime({
    appRoot: root,
    cliScriptPath,
  });
}

function currentService(
  descriptor,
  observation,
  controlPlaneIdentity,
  hmuxIdentity,
  expectedBuildId = CONTROL_PLANE_BUILD_ID,
) {
  return (
    descriptor.buildId === expectedBuildId &&
    sameExecutablePayload(
      descriptor.controlPlaneIdentity,
      controlPlaneIdentity,
    ) &&
    descriptor.hmuxExecutableSize === hmuxIdentity.executableSize &&
    descriptor.hmuxExecutableSha256 === hmuxIdentity.executableSha256 &&
    descriptor.hmuxRuntimeExecutableSize === hmuxIdentity.runtimeExecutableSize &&
    descriptor.hmuxRuntimeExecutableSha256 === hmuxIdentity.runtimeExecutableSha256 &&
    descriptor.hmuxDiscoveryRoot === hmuxIdentity.discoveryRoot &&
    Array.isArray(observation?.capabilities) &&
    observation.capabilities.length === LOCAL_CAPABILITIES.length &&
    observation.capabilities.every((capability) =>
      LOCAL_CAPABILITIES.includes(capability),
    )
  );
}

function currentServiceAuthority(
  descriptor,
  observation,
  controlPlaneIdentity,
  hmuxIdentity,
) {
  return (
    currentService(
      descriptor,
      observation,
      controlPlaneIdentity,
      hmuxIdentity,
    ) &&
    isDeepStrictEqual(descriptor.controlPlaneIdentity, controlPlaneIdentity) &&
    isDeepStrictEqual(descriptorHmuxIdentity(descriptor), hmuxIdentity)
  );
}

function shutdownBody(descriptor, target) {
  if (descriptor.schemaVersion === 1) return { schemaVersion: 1 };
  return {
    schemaVersion: 2,
    mode: "replace",
    target,
  };
}

async function shutdownOwnedService(descriptor, target) {
  let deliveryError;
  try {
    const response = await performBackendProfileRequest(
      profileForDescriptor(descriptor, []),
      {
        body: shutdownBody(descriptor, target),
        operation: "backend.shutdown",
      },
    );
    if (response.result?.status !== "stopping") {
      fail("local_backend_upgrade_rejected");
    }
  } catch (error) {
    if (error instanceof LocalBackendError) throw error;
    deliveryError = error;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    await wait(SERVICE_POLL_MS);
    if (!(await pingObservation(descriptor))) return;
  }
  fail("local_backend_upgrade_rejected", { cause: deliveryError });
}

function sourceDescriptorFromIntent(intent, root) {
  const sequence = /^dure-control-plane\/v([1-9][0-9]*)-/.exec(
    intent.source.buildId ?? "",
  );
  const buildSequence = Number(sequence?.[1] ?? 0);
  const schemaVersion =
    buildSequence >= 52 ? 5 : buildSequence >= 31 ? 3 : buildSequence >= 29 ? 2 : 1;
  const socketPath = descriptorSocketPath(
    root,
    intent.source.generation,
    schemaVersion,
  );
  return {
    schemaVersion,
    backendId: LOCAL_BACKEND_ID,
    buildId: intent.source.buildId ?? undefined,
    generation: intent.source.generation,
    socketPath,
  };
}

async function reconcileActivatedReplacement({
  claudeRuntime,
  controlPlaneIdentity,
  environment,
  hmuxIdentity,
  root,
  targetDescriptor,
}) {
  const sourceGeneration = targetDescriptor.activationSourceGeneration;
  if (!sourceGeneration) return targetDescriptor;
  const confirmation = replacementOperation(() =>
    replacementConfirmationForDescriptor({
      root,
      sourceGeneration,
      targetDescriptor,
      targetBuildId: CONTROL_PLANE_BUILD_ID,
      targetControlPlaneIdentity: controlPlaneIdentity,
      targetHmuxIdentity: hmuxIdentity,
    }),
  );
  if (!confirmation) {
    if (
      replacementOperation(() =>
        localBackendReplacementIntentExists(root, sourceGeneration),
      )
    ) {
      fail("recovering");
    }
    return targetDescriptor;
  }
  let activeTarget = targetDescriptor;
  if (!(await pingObservation(activeTarget))) {
    const targetClaudeRuntime = claudeRuntimeForControlPlane({
      controlPlaneIdentity: confirmation.intent.target.controlPlaneIdentity,
      currentControlPlaneIdentity: controlPlaneIdentity,
      currentRuntime: claudeRuntime,
      root,
    });
    startService({
      activationSourceGeneration: confirmation.intent.source.generation,
      claudeRuntime: targetClaudeRuntime,
      controlPlaneIdentity: confirmation.intent.target.controlPlaneIdentity,
      environment,
      generation: confirmation.intent.target.generation,
      hmuxIdentity: confirmation.intent.target.hmuxIdentity,
      root,
    });
    activeTarget = await waitForCurrentService(
      root,
      confirmation.intent.target.generation,
      confirmation.intent.target.controlPlaneIdentity,
      confirmation.intent.target.hmuxIdentity,
      confirmation.observedTargetBuildId,
    );
    if (!activeTarget) fail("recovering");
  }
  const activated = await confirmActivatedReplacement({
    confirmation,
    environment,
    root,
    sourceDescriptor: sourceDescriptorFromIntent(confirmation.intent, root),
    targetDescriptor: activeTarget,
  });
  if (!isDeepStrictEqual(readDescriptor(root), activated)) {
    fail("local_backend_descriptor_changed");
  }
  replacementOperation(() =>
    removeLocalBackendReplacementIntent(
      root,
      confirmation.intent.source.generation,
      confirmation.intent.target.generation,
    ),
  );
  return activated;
}

function startService({
  activationSourceGeneration,
  claudeRuntime,
  controlPlaneIdentity,
  environment,
  generation,
  hmuxIdentity,
  root,
  staged = false,
}) {
  const executable = validateControlPlaneIdentity(
    controlPlaneIdentity,
    environment,
  ).executablePath;
  const argv = [
    "serve",
    "--home",
    root,
    "--launch-executable",
    controlPlaneIdentity.executablePath,
    "--hmux-bin",
    hmuxIdentity.executablePath,
    "--hmux-runtime-bin",
    hmuxIdentity.runtimeExecutablePath,
    "--hmux-discovery-root",
    hmuxIdentity.discoveryRoot,
    ...claudeStructuredRuntimeArguments(claudeRuntime),
  ];
  if (generation) argv.push("--expected-generation", generation);
  if (activationSourceGeneration) {
    argv.push("--activation-source-generation", activationSourceGeneration);
  }
  if (staged) argv.push("--staged");
  let serviceEnvironment;
  try {
    serviceEnvironment = localBackendServiceEnvironment(environment);
  } catch (error) {
    fail("local_backend_login_environment_unavailable", { cause: error });
  }
  const child = spawn(executable, argv, {
    detached: true,
    env: serviceEnvironment,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitForCurrentService(
  root,
  generation,
  controlPlaneIdentity,
  hmuxIdentity,
  expectedBuildId = CONTROL_PLANE_BUILD_ID,
) {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(SERVICE_POLL_MS);
    const descriptor = readDescriptor(root);
    if (generation && descriptor?.generation !== generation) continue;
    if (!descriptor) continue;
    const observation = await pingObservation(descriptor);
    if (
      observation &&
      currentService(
        descriptor,
        observation,
        controlPlaneIdentity,
        hmuxIdentity,
        expectedBuildId,
      )
    ) {
      const confirmed = readDescriptor(root);
      if (!isDeepStrictEqual(confirmed, descriptor)) continue;
      return confirmed;
    }
  }
  return null;
}

async function waitForStagedService(
  root,
  generation,
  controlPlaneIdentity,
  hmuxIdentity,
  expectedBuildId = CONTROL_PLANE_BUILD_ID,
) {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(SERVICE_POLL_MS);
    const descriptor = readCandidateDescriptor(root, generation);
    if (!descriptor || descriptor.generation !== generation) continue;
    const observation = await pingObservation(descriptor);
    if (
      observation &&
      currentService(
        descriptor,
        observation,
        controlPlaneIdentity,
        hmuxIdentity,
        expectedBuildId,
      )
    ) {
      const confirmed = readCandidateDescriptor(root, generation);
      if (!isDeepStrictEqual(confirmed, descriptor)) continue;
      return confirmed;
    }
  }
  return null;
}

function readReplacementConfirmation(root, confirmation, targetDescriptor) {
  const { intent, observedTargetBuildId } = confirmation;
  return replacementOperation(() =>
    replacementConfirmationForDescriptor({
      root,
      sourceGeneration: intent.source.generation,
      targetDescriptor,
      targetBuildId: observedTargetBuildId,
      targetControlPlaneIdentity: intent.target.controlPlaneIdentity,
      targetHmuxIdentity: intent.target.hmuxIdentity,
    }),
  );
}

async function activateStagedService(
  root,
  sourceDescriptor,
  targetDescriptor,
  confirmation,
  environment,
) {
  const observed = readDescriptor(root);
  const alreadyActivated = isDeepStrictEqual(observed, targetDescriptor);
  if (!alreadyActivated && !isDeepStrictEqual(observed, sourceDescriptor)) {
    fail("local_backend_descriptor_changed");
  }
  if (
    targetDescriptor.activationSourceGeneration !==
    confirmation.intent.source.generation
  ) {
    fail("recovering");
  }
  const persistedConfirmation = readReplacementConfirmation(
    root,
    confirmation,
    targetDescriptor,
  );
  if (!isDeepStrictEqual(persistedConfirmation, confirmation)) {
    fail("recovering");
  }
  const { intent: replacementIntent, observedTargetBuildId } =
    persistedConfirmation;
  const readiness = await pingObservation(targetDescriptor);
  if (
    !readiness ||
    !currentService(
      targetDescriptor,
      readiness,
      replacementIntent.target.controlPlaneIdentity,
      replacementIntent.target.hmuxIdentity,
      observedTargetBuildId,
    )
  ) {
    fail("recovering");
  }
  const candidate = alreadyActivated
    ? null
    : readCandidateDescriptor(root, targetDescriptor.generation);
  if (!alreadyActivated && !isDeepStrictEqual(candidate, targetDescriptor)) {
    fail("recovering");
  }
  const current = readDescriptor(root);
  if (
    !isDeepStrictEqual(
      current,
      alreadyActivated ? targetDescriptor : sourceDescriptor,
    ) ||
    (!alreadyActivated &&
      !isDeepStrictEqual(
        readCandidateDescriptor(root, targetDescriptor.generation),
        candidate,
      ))
  ) {
    fail("local_backend_descriptor_changed");
  }
  const executable = validateControlPlaneIdentity(
    replacementIntent.target.controlPlaneIdentity,
    environment,
  ).executablePath;
  const activation = spawnSync(
    executable,
    [
      "activate-staged",
      "--home",
      root,
      "--source-generation",
      replacementIntent.source.generation,
      "--target-generation",
      replacementIntent.target.generation,
    ],
    {
      encoding: "utf8",
      env: environment,
      maxBuffer: MAX_DESCRIPTOR_BYTES,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  validateControlPlaneIdentity(
    replacementIntent.target.controlPlaneIdentity,
    environment,
  );
  if (activation.error || activation.status !== 0) {
    const detail = activation.stderr?.trim() ?? "";
    fail("recovering", {
      cause:
        activation.error ??
        new Error(
          detail ||
            `control-plane activation exited with status ${activation.status}`,
        ),
    });
  }
  const activated = readDescriptor(root);
  if (!isDeepStrictEqual(activated, targetDescriptor)) {
    fail("local_backend_descriptor_changed");
  }
  return activated;
}

async function confirmActivatedReplacement({
  confirmation,
  environment,
  root,
  sourceDescriptor,
  targetDescriptor,
}) {
  const { intent } = confirmation;
  const activated = await activateStagedService(
    root,
    sourceDescriptor,
    targetDescriptor,
    confirmation,
    environment,
  );
  try {
    await shutdownOwnedService(sourceDescriptor, intent.target);
  } catch (error) {
    if (await pingObservation(activated)) {
      fail("recovering", { cause: error });
    }
    throw error;
  }
  return activated;
}

// Re-read the on-disk descriptor and require it to still equal the one this
// replacement decision was based on before recording a replacement intent;
// a concurrent descriptor change fails instead of replacing the wrong service.
function guardedReplacementIntent({
  root,
  existingDescriptor,
  controlPlaneIdentity,
  hmuxIdentity,
  sourceObservation = null,
}) {
  const observedDescriptor = readDescriptor(root);
  if (
    !observedDescriptor ||
    JSON.stringify(observedDescriptor) !== JSON.stringify(existingDescriptor)
  ) {
    fail("local_backend_descriptor_changed");
  }
  return replacementOperation(() =>
    ensureLocalBackendReplacementIntent({
      root,
      sourceDescriptor: existingDescriptor,
      sourceGeneration: existingDescriptor.generation,
      sourceObservation,
      targetBuildId: CONTROL_PLANE_BUILD_ID,
      targetControlPlaneIdentity: controlPlaneIdentity,
      targetHmuxIdentity: hmuxIdentity,
    }),
  );
}

function activationPending(descriptor, root) {
  return Boolean(
    descriptor.activationSourceGeneration &&
    replacementOperation(() =>
      localBackendReplacementIntentExists(root, descriptor.activationSourceGeneration),
    ),
  );
}

// A compatible owner may serve this client's versioned protocol and capabilities.
// Connection does not activate the caller's payload. Explicit updates and
// unavailable-service recovery retain the exact lifecycle contract below.
async function joinCompatibleService(descriptor, root, environment) {
  if (parseLocalExecutableIdentity(descriptor.controlPlaneIdentity) === null) {
    fail("cli_update_required");
  }
  if (activationPending(descriptor, root)) {
    fail("recovering");
  }
  validateControlPlaneIdentity(descriptor.controlPlaneIdentity, environment);
  const hmuxIdentity = resolveHmuxToolchainIdentity({
    ...environment,
    DURE_HMUX_BIN: descriptor.hmuxExecutablePath,
    DURE_HMUX_RUNTIME_BIN: descriptor.hmuxRuntimeExecutablePath,
    HMUX_DISCOVERY_ROOT:
      environment.HMUX_DISCOVERY_ROOT ?? defaultHmuxDiscoveryRoot(environment),
  });
  if (!isDeepStrictEqual(descriptorHmuxIdentity(descriptor), hmuxIdentity)) {
    fail("local_backend_executable_changed");
  }
  const response = await performBackendProfileRequest(
    profileForDescriptor(descriptor),
    { body: { schemaVersion: 1 }, operation: "backend.ping" },
  );
  if (response.result?.schemaVersion !== 1 || response.result.status !== "ready") {
    fail("local_backend_unavailable");
  }
  validateControlPlaneIdentity(descriptor.controlPlaneIdentity, environment);
  if (!isDeepStrictEqual(readDescriptor(root), descriptor)) {
    fail("local_backend_descriptor_changed");
  }
  return descriptor;
}

async function ensureService(options) {
  const root = ensureHome(options.environment);
  let existingDescriptor = readDescriptor(root);
  if (
    existingDescriptor &&
    controlPlaneBuildSequence(existingDescriptor.buildId) >
      controlPlaneBuildSequence(CONTROL_PLANE_BUILD_ID)
  ) {
    return joinCompatibleService(existingDescriptor, root, options.environment);
  }
  const reuseCompatible =
    existingDescriptor?.buildId === CONTROL_PLANE_BUILD_ID &&
    existingDescriptor.schemaVersion >= EXECUTABLE_IDENTITY_DESCRIPTOR_SCHEMA_VERSION &&
    !options.activateCurrentBundle;
  if (reuseCompatible && !activationPending(existingDescriptor, root)) {
    try {
      return await joinCompatibleService(existingDescriptor, root, options.environment);
    } catch (error) {
      // Only an unavailable endpoint proceeds to the existing recovery owner.
      // Identity, capability, protocol and timeout failures are not stop authority.
      if (
        !(error instanceof BackendTransportError) ||
        error.code !== "backend_transport_unavailable"
      ) {
        throw error;
      }
    }
  }
  let claudeRuntime;
  try {
    claudeRuntime = resolveBundledClaudeStructuredRuntime({
      appRoot: root,
      cliScriptPath: options.cliScriptPath,
    });
  } catch (error) {
    if (!(error instanceof ClaudeStructuredRuntimeBundleError)) throw error;
    fail("cli_update_required", { cause: error });
  }
  const controlPlaneIdentity = resolveControlPlaneIdentity(
    options.cliScriptPath,
    options.environment,
  );
  validateControlPlaneContract(controlPlaneIdentity, options.environment);
  const hmuxIdentity = resolveHmuxToolchainIdentity(options.environment);
  validateControlPlanePreflight({
    claudeRuntime,
    controlPlaneIdentity,
    environment: options.environment,
    hmuxIdentity,
    root,
  });
  if (existingDescriptor) {
    existingDescriptor = await reconcileActivatedReplacement({
      claudeRuntime,
      controlPlaneIdentity,
      environment: options.environment,
      hmuxIdentity,
      root,
      targetDescriptor: existingDescriptor,
    });
    const observation = await pingObservation(existingDescriptor);
    if (reuseCompatible && observation) {
      return joinCompatibleService(existingDescriptor, root, options.environment);
    }
    // Activation selects the complete immutable installation. Its sibling CLI
    // launches connectors, so an identical binary in another bundle is not the
    // requested owner. Ordinary compatible connections returned above.
    if (
      observation &&
      currentServiceAuthority(
        existingDescriptor,
        observation,
        controlPlaneIdentity,
        hmuxIdentity,
      )
    ) {
      return existingDescriptor;
    }
    if (
      !observation &&
      currentServiceAuthority(
        existingDescriptor,
        { capabilities: LOCAL_CAPABILITIES },
        controlPlaneIdentity,
        hmuxIdentity,
      )
    ) {
      startService({
        ...options,
        activationSourceGeneration:
          existingDescriptor.activationSourceGeneration,
        controlPlaneIdentity,
        claudeRuntime,
        generation: existingDescriptor.generation,
        hmuxIdentity,
        root,
      });
      const restarted = await waitForCurrentService(
        root,
        existingDescriptor.generation,
        controlPlaneIdentity,
        hmuxIdentity,
      );
      if (restarted) return restarted;
      fail("recovering");
    }
    const replacementIntent = guardedReplacementIntent({
      root,
      existingDescriptor,
      controlPlaneIdentity,
      hmuxIdentity,
      sourceObservation: observation,
    });
    startService({
      ...options,
      activationSourceGeneration: existingDescriptor.generation,
      controlPlaneIdentity: replacementIntent.target.controlPlaneIdentity,
      claudeRuntime,
      generation: replacementIntent.target.generation,
      hmuxIdentity: replacementIntent.target.hmuxIdentity,
      root,
      staged: true,
    });
    const staged = await waitForStagedService(
      root,
      replacementIntent.target.generation,
      replacementIntent.target.controlPlaneIdentity,
      replacementIntent.target.hmuxIdentity,
    );
    if (!staged) fail("recovering");
    const expectedConfirmation = {
      intent: replacementIntent,
      observedTargetBuildId: replacementIntent.target.buildId,
    };
    const confirmation = readReplacementConfirmation(
      root,
      expectedConfirmation,
      staged,
    );
    if (!isDeepStrictEqual(confirmation, expectedConfirmation)) {
      fail("recovering");
    }
    return confirmActivatedReplacement({
      confirmation,
      environment: options.environment,
      root,
      sourceDescriptor: existingDescriptor,
      targetDescriptor: staged,
    });
  }
  startService({
    ...options,
    claudeRuntime,
    controlPlaneIdentity,
    hmuxIdentity,
    root,
  });
  const descriptor = await waitForCurrentService(
    root,
    undefined,
    controlPlaneIdentity,
    hmuxIdentity,
  );
  if (descriptor) return descriptor;
  fail("recovering");
}

function isCanonicalManagedLocalProfile(profile, environment = process.env) {
  if (!profile || profile.id !== LOCAL_PROFILE_ID) return false;
  const root = appHome(environment);
  return (
    profile.transport?.kind === "local" &&
    profile.transport.endpoint?.kind === "unix_socket" &&
    managedLocalSocketPath(
      root,
      profile.transport.endpoint.path,
      profile.expected?.generation,
    ) &&
    profile.auth?.kind === "peer" &&
    profile.trust?.kind === "local_peer" &&
    profile.expected?.backendId === LOCAL_BACKEND_ID &&
    /^local-v1-[a-f0-9]{32}$/.test(profile.expected.generation) &&
    profile.expected.protocol?.minimum?.major === 1 &&
    profile.expected.protocol.minimum.minor === 0 &&
    profile.expected.protocol?.maximum?.major === 1 &&
    profile.expected.protocol.maximum.minor === 0
  );
}

export function isManagedDefaultLocalProfile(profile, environment = process.env) {
  return (
    isCanonicalManagedLocalProfile(profile, environment) &&
    LOCAL_CAPABILITIES.every((capability) =>
      profile.expected.capabilities?.includes(capability),
    )
  );
}

export async function loadBackendProfilesWithDefault({
  cliScriptPath,
  environment = process.env,
  bootstrapMissing = false,
  activateCurrentBundle = false,
} = {}) {
  let catalog;
  try {
    catalog = loadBackendProfiles({ environment });
  } catch (error) {
    if (
      !bootstrapMissing ||
      !(error instanceof BackendProfileError) ||
      error.code !== "backend_profiles_config_missing"
    ) {
      throw error;
    }
  }
  if (catalog) {
    const managedLocal = catalog.profiles.find((profile) =>
      isCanonicalManagedLocalProfile(profile, environment),
    );
    if (!managedLocal) return catalog;
    const descriptor = await ensureService({ cliScriptPath, environment, activateCurrentBundle });
    const currentProfile = profileForDescriptor(descriptor);
    if (
      managedLocal.expected.generation !== currentProfile.expected.generation ||
      !isManagedDefaultLocalProfile(managedLocal, environment)
    ) {
      replaceCanonicalLocalProfile(
        appHome(environment),
        catalog,
        { ...currentProfile, default: managedLocal.default },
        environment,
      );
      replacementOperation(() =>
        removeLocalBackendReplacementIntent(
          appHome(environment),
          managedLocal.expected.generation,
          currentProfile.expected.generation,
        ),
      );
      return loadBackendProfiles({ environment });
    }
    return catalog;
  }
  const root = ensureHome(environment);
  const descriptor = await ensureService({ cliScriptPath, environment, activateCurrentBundle });
  writeMissingCatalog(root, profileForDescriptor(descriptor));
  return loadBackendProfiles({ environment });
}

export async function selectBackendProfileForRequest({
  cliScriptPath,
  environment = process.env,
  explicitId,
  activateCurrentBundle = false,
} = {}) {
  const requestedId = explicitId ?? environment.DURE_BACKEND_PROFILE?.trim();
  if (requestedId || activateCurrentBundle) {
    let existingCatalog;
    try {
      existingCatalog = loadBackendProfiles({ environment });
    } catch (error) {
      if (
        requestedId || !(error instanceof BackendProfileError) ||
        error.code !== "backend_profiles_config_missing"
      ) {
        throw error;
      }
    }
    if (existingCatalog) {
      const selection = selectBackendProfile(existingCatalog, { explicitId, environment });
      if (!isCanonicalManagedLocalProfile(selection.profile, environment)) {
        if (activateCurrentBundle) fail("local_backend_activation_not_managed");
        return { ...selection, managedLocal: false };
      }
    }
  }
  const catalog = await loadBackendProfilesWithDefault({
    bootstrapMissing: explicitId === undefined && !environment.DURE_BACKEND_PROFILE,
    cliScriptPath,
    environment,
    activateCurrentBundle,
  });
  const selection = selectBackendProfile(catalog, { explicitId, environment });
  const managedLocal = isManagedDefaultLocalProfile(
    selection.profile,
    environment,
  );
  if (activateCurrentBundle && !managedLocal) fail("local_backend_activation_not_managed");
  // Loading the managed catalog already reconciles its exact generation.
  // A second ensure would repeat executable hashing and could replace the
  // backend again without updating the selection returned to this caller.
  return { ...selection, managedLocal };
}



export function localBackendErrorReport(error) {
  const typed =
    error instanceof LocalBackendError
      ? error
      : new LocalBackendError("local_backend_unavailable");
  const boundary =
    typed.code === "recovering"
      ? { status: "recovering", retryable: true }
      : typed.code === "cli_update_required"
        ? {
            status: "cli_update_required",
            retryable: false,
            action: {
              label: "Update Dure App",
              command: "dure install --global",
            },
          }
        : {};
  return {
    schemaVersion: 1,
    apiVersion: "dure.local-backend/v1",
    kind: boundary.status
      ? "dure.local_backend.receipt"
      : "dure.local_backend.error",
    profile: null,
    ...boundary,
    error: { code: typed.code, message: typed.message },
  };
}
