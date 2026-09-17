import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { MAX_BACKEND_CAPABILITIES_V1 } from "./backend-capabilities.mjs";

const MAX_IDENTITY_BYTES = 16 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,255}$/;
const BUILD_ID = /^dure-control-plane\/v([1-9][0-9]*)-[A-Za-z0-9._:/-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function parseBuildIdentityManifest() {
  let value;
  try {
    value = JSON.parse(
      readFileSync(
        new URL("./control-plane-build-identity.json", import.meta.url),
        "utf8",
      ),
    );
  } catch (error) {
    throw new Error("the control-plane build identity manifest is invalid", {
      cause: error,
    });
  }
  const identity = value?.identity;
  const capabilities = identity?.capabilities;
  const currentBuild =
    typeof value?.currentBuildId === "string"
      ? BUILD_ID.exec(value.currentBuildId)
      : null;
  const previousBuild =
    typeof value?.previousBuildId === "string"
      ? BUILD_ID.exec(value.previousBuildId)
      : null;
  const currentSequence = currentBuild ? Number(currentBuild[1]) : NaN;
  const previousSequence = previousBuild ? Number(previousBuild[1]) : NaN;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !["schemaVersion", "currentBuildId", "previousBuildId", "identity"].every(
      (key) => Object.hasOwn(value, key),
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.currentBuildId !== "string" ||
    typeof value.previousBuildId !== "string" ||
    !SAFE_TOKEN.test(value.currentBuildId) ||
    !SAFE_TOKEN.test(value.previousBuildId) ||
    !currentBuild ||
    !previousBuild ||
    !Number.isSafeInteger(currentSequence) ||
    !Number.isSafeInteger(previousSequence) ||
    previousSequence >= currentSequence ||
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).length !== 3 ||
    !["apiVersion", "kind", "capabilities"].every((key) =>
      Object.hasOwn(identity, key),
    ) ||
    typeof identity.apiVersion !== "string" ||
    typeof identity.kind !== "string" ||
    !SAFE_TOKEN.test(identity.apiVersion) ||
    !SAFE_TOKEN.test(identity.kind) ||
    !Array.isArray(capabilities) ||
    capabilities.length < 1 ||
    capabilities.length > MAX_BACKEND_CAPABILITIES_V1 ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" || !SAFE_TOKEN.test(capability),
    ) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw new Error("the control-plane build identity manifest is invalid");
  }
  return Object.freeze({
    currentBuildId: value.currentBuildId,
    previousBuildId: value.previousBuildId,
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    capabilities: Object.freeze([...capabilities]),
  });
}

// The CLI bundle and binary embed projections of one repository manifest, but
// neither trusts the other at runtime. Promotion still compares the binary's
// typed receipt and digest with this independently bundled projection.
const BUILD_IDENTITY = parseBuildIdentityManifest();
export const CONTROL_PLANE_BUILD_ID = BUILD_IDENTITY.currentBuildId;
export const PREVIOUS_CONTROL_PLANE_BUILD_ID =
  BUILD_IDENTITY.previousBuildId;
export const CONTROL_PLANE_IDENTITY_API_VERSION = BUILD_IDENTITY.apiVersion;
export const CONTROL_PLANE_IDENTITY_KIND = BUILD_IDENTITY.kind;
export const CONTROL_PLANE_CAPABILITIES = BUILD_IDENTITY.capabilities;

const MESSAGES = Object.freeze({
  control_plane_build_mismatch:
    "the control-plane build does not match the CLI contract",
  control_plane_capabilities_mismatch:
    "the control-plane capabilities do not match the CLI contract",
  control_plane_digest_mismatch:
    "the control-plane digest does not match the bundle receipt",
  control_plane_identity_invalid:
    "the control-plane returned an invalid identity receipt",
  control_plane_identity_unavailable:
    "the control-plane identity receipt is unavailable",
});

export class ControlPlaneContractError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] ?? "the control-plane contract is invalid", options);
    this.code = code;
    this.name = "ControlPlaneContractError";
  }
}

function fail(code, options) {
  throw new ControlPlaneContractError(code, options);
}

function sameCapabilities(left, right) {
  return isDeepStrictEqual(left, right);
}

function parseIdentity(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail("control_plane_identity_invalid", { cause: error });
  }
  const keys = [
    "schemaVersion",
    "apiVersion",
    "kind",
    "buildId",
    "capabilities",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    value.apiVersion !== CONTROL_PLANE_IDENTITY_API_VERSION ||
    value.kind !== CONTROL_PLANE_IDENTITY_KIND ||
    !SAFE_TOKEN.test(value.buildId) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length < 1 ||
    value.capabilities.length > MAX_BACKEND_CAPABILITIES_V1 ||
    value.capabilities.some((capability) => !SAFE_TOKEN.test(capability)) ||
    new Set(value.capabilities).size !== value.capabilities.length
  ) {
    fail("control_plane_identity_invalid");
  }
  return value;
}

export function probeControlPlaneIdentity(
  executablePath,
  { environment = process.env, timeoutMs = 5_000 } = {},
) {
  const result = spawnSync(executablePath, ["identity"], {
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_IDENTITY_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    fail("control_plane_identity_unavailable", { cause: result.error });
  }
  return parseIdentity(result.stdout);
}

export function currentControlPlaneBundleIdentity(
  executablePath,
  options,
) {
  const identity = probeControlPlaneIdentity(executablePath, options);
  if (identity.buildId !== CONTROL_PLANE_BUILD_ID) {
    fail("control_plane_build_mismatch");
  }
  if (!sameCapabilities(identity.capabilities, CONTROL_PLANE_CAPABILITIES)) {
    fail("control_plane_capabilities_mismatch");
  }
  return {
    apiVersion: identity.apiVersion,
    buildId: identity.buildId,
    digest: createHash("sha256")
      .update(readFileSync(executablePath))
      .digest("hex"),
    capabilities: [...identity.capabilities],
  };
}

export function validateControlPlaneBundleIdentity(
  expected,
  executablePath,
  options,
) {
  if (
    expected === null ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    Object.keys(expected).length !== 4 ||
    !["apiVersion", "buildId", "digest", "capabilities"].every((key) =>
      Object.hasOwn(expected, key),
    ) ||
    !SHA256.test(expected.digest ?? "")
  ) {
    fail("control_plane_identity_invalid");
  }
  const observed = currentControlPlaneBundleIdentity(executablePath, options);
  if (expected.digest !== observed.digest) {
    fail("control_plane_digest_mismatch");
  }
  if (
    expected.apiVersion !== observed.apiVersion ||
    expected.buildId !== observed.buildId ||
    !sameCapabilities(expected.capabilities, observed.capabilities)
  ) {
    fail("control_plane_identity_invalid");
  }
  return observed;
}
