import {
  parseLinuxProcessIdentity,
  parseMacosProcessIdentity,
  parseWindowsProcessIdentity,
} from "./process-identity.mjs";

export const DEV_DEPLOY_RUNNER_GENERATION_SCHEMA_VERSION = 1;

const LEGACY_MACOS_PROCESS_IDENTITY = /^kernel-start-v2:macos:(\d+)$/u;

function legacyMacosProcessIdentity(value) {
  const match = typeof value === "string"
    ? value.match(LEGACY_MACOS_PROCESS_IDENTITY)
    : null;
  return match
    ? { family: "macos", version: 2 }
    : null;
}

function processIdentityParts(value) {
  const macos = parseMacosProcessIdentity(value);
  if (macos) {
    return {
      family: "macos",
      version: 3,
    };
  }
  const legacyMacos = legacyMacosProcessIdentity(value);
  if (legacyMacos) return legacyMacos;
  const linux = parseLinuxProcessIdentity(value);
  if (linux) {
    return {
      family: "linux",
      version: 1,
    };
  }
  const windows = parseWindowsProcessIdentity(value);
  if (windows) {
    return {
      family: "windows",
      version: 1,
    };
  }
  return null;
}

function compatibleProcessIdentity(exactIdentity) {
  const macos = parseMacosProcessIdentity(exactIdentity);
  return macos
    ? `kernel-start-v2:macos:${macos.uniqueId}`
    : exactIdentity;
}

export function devDeployRunnerGeneration(exactIdentity) {
  if (typeof exactIdentity !== "string" || !exactIdentity) {
    throw new Error("dev deploy runner process identity is invalid");
  }
  return {
    // Pre-v3 queue readers compare this field with their boot-local observer.
    // Current readers use processGeneration as the exact authority below.
    processIdentity: compatibleProcessIdentity(exactIdentity),
    processGeneration: {
      schemaVersion: DEV_DEPLOY_RUNNER_GENERATION_SCHEMA_VERSION,
      processIdentity: exactIdentity,
    },
  };
}

export function parseDevDeployRunnerGeneration(value, label) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion < 1 ||
    typeof value.processIdentity !== "string" ||
    !value.processIdentity
  ) {
    throw new Error(`${label} process generation is invalid`);
  }
  return value;
}

export function devDeployRunnerExactIdentity(owner) {
  return owner?.processGeneration?.processIdentity ?? owner?.processIdentity;
}

function comparableLiveness(expectedIdentity, observedIdentity) {
  const expected = processIdentityParts(expectedIdentity);
  const observed = processIdentityParts(observedIdentity);
  if (!expected || !observed || expected.family !== observed.family) {
    return "incompatible";
  }
  if (expectedIdentity === observedIdentity) return "active";
  return expected.version === observed.version ? "stale" : "incompatible";
}

export function devDeployRunnerLiveness(owner, alive, identity) {
  if (!owner || !alive(owner.pid)) return "stale";
  let processGeneration;
  try {
    processGeneration = parseDevDeployRunnerGeneration(
      owner.processGeneration,
      "dev deploy runner",
    );
  } catch {
    return "incompatible";
  }
  if (
    processGeneration &&
    processGeneration.schemaVersion !==
      DEV_DEPLOY_RUNNER_GENERATION_SCHEMA_VERSION
  ) {
    return "incompatible";
  }
  const observedIdentity = identity(owner.pid);
  if (!observedIdentity) return "unknown";
  const expectedIdentity = devDeployRunnerExactIdentity(owner);
  return comparableLiveness(expectedIdentity, observedIdentity);
}
