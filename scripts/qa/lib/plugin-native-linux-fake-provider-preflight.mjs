import { createHash } from "node:crypto";
import {
  LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_TARGET_ARCHITECTURES,
  LinuxNativeProviderContainmentAuthorityError,
} from "../../lib/plugin-native-linux-containment-capability.mjs";

export const LINUX_NATIVE_PROVIDER_FAKE_PROBE_PLAN_SCHEMA =
  "dure-linux-native-provider-containment-fake-probe-plan/v1";
export const LINUX_NATIVE_PROVIDER_LIVE_EVIDENCE_GAP_SCHEMA =
  "dure-linux-native-provider-containment-live-evidence-gap/v1";
export const LINUX_NATIVE_PROVIDER_FAKE_FIXTURE_ID =
  "dure-linux-containment-adversary-v1";

// These are future attacks that the live fake fixture must execute. They are
// not observations and none of them can be marked as passed by this module.
export const LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES = Object.freeze([
  "stale_boot_replay",
  "stale_process_generation_replay",
  "replaced_launcher_fd",
  "namespace_tuple_splice",
  "cgroup_generation_reuse",
  "argv_share_net_override",
  "argv_try_fallback",
  "argv_hidden_args_fd",
  "environment_inheritance",
  "writable_nested_mount",
  "fd_number_reuse",
  "self_reported_probe_forgery",
]);

const PLAN_KEYS = Object.freeze(
  [
    "authority",
    "cases",
    "disposition",
    "fixture_id",
    "policy_id",
    "policy_sha256",
    "reusable",
    "schema",
    "scope",
    "target",
  ].sort(),
);
const GAP_KEYS = Object.freeze(
  [
    "authority",
    "disposition",
    "plan_sha256",
    "policy_id",
    "policy_sha256",
    "reason_code",
    "reusable",
    "schema",
    "scope",
    "state",
    "target",
  ].sort(),
);
const TARGET_KEYS = Object.freeze(["arch", "os"]);
const TARGET_ARCHITECTURES = new Set(
  LINUX_NATIVE_PROVIDER_CONTAINMENT_TARGET_ARCHITECTURES,
);
const PLAN_MAX_BYTES = 8 * 1024;
const GAP_MAX_BYTES = 4 * 1024;

export class LinuxNativeProviderFakePreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "LinuxNativeProviderFakePreflightError";
    this.code = "plugin_native_linux_fake_preflight_invalid";
  }
}

function invalid(message) {
  throw new LinuxNativeProviderFakePreflightError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactOwnNames(value) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid("preflight wire objects must not contain symbol fields");
  }
  return Object.getOwnPropertyNames(value).sort();
}

function sameKeys(observed, expected) {
  return JSON.stringify(observed) === JSON.stringify(expected);
}

function requireExactObject(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  if (!sameKeys(exactOwnNames(value), keys)) {
    invalid(`${label} fields do not match the v1 schema`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid(`${label} fields must be enumerable data properties`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function requireExactCaseVector(value) {
  if (!Array.isArray(value)) invalid("fake probe cases must be an array");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid("fake probe cases must not contain symbol fields");
  }
  const expectedNames = [
    ...LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES.map((_, index) => String(index)),
    "length",
  ].sort();
  if (!sameKeys(Object.getOwnPropertyNames(value).sort(), expectedNames)) {
    invalid("fake probe cases must be one dense exact vector");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.length?.value !== LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES.length) {
    invalid("fake probe cases length does not match the v1 attack vector");
  }
  for (let index = 0; index < LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid("fake probe cases must use enumerable data entries");
    }
    if (descriptor.value !== LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES[index]) {
      invalid("fake probe cases do not match the v1 attack order");
    }
  }
  return LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES;
}

function normalizeTarget(input) {
  const target = requireExactObject(input, TARGET_KEYS, "preflight target");
  if (target.os !== "linux") invalid("preflight target os must be linux");
  if (
    typeof target.arch !== "string" ||
    !TARGET_ARCHITECTURES.has(target.arch)
  ) {
    invalid("preflight target architecture is not part of the v1 schema");
  }
  return Object.freeze({ os: "linux", arch: target.arch });
}

function requireCommonFields(input) {
  if (input.policy_id !== LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID) {
    invalid("preflight policy_id does not match the authority-none contract");
  }
  if (input.policy_sha256 !== LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256) {
    invalid("preflight policy_sha256 does not match the authority-none contract");
  }
  if (input.authority !== "none") invalid("preflight authority must be none");
  if (input.scope !== "fake_fixture_only") {
    invalid("preflight scope must be fake_fixture_only");
  }
  if (input.disposition !== "non_qualifying") {
    invalid("preflight disposition must be non_qualifying");
  }
  if (input.reusable !== false) invalid("preflight documents are never reusable");
}

export function normalizeLinuxNativeProviderFakeProbePlanV1(input) {
  const plan = requireExactObject(input, PLAN_KEYS, "fake probe plan");
  if (plan.schema !== LINUX_NATIVE_PROVIDER_FAKE_PROBE_PLAN_SCHEMA) {
    invalid("unsupported fake probe plan schema");
  }
  requireCommonFields(plan);
  if (plan.fixture_id !== LINUX_NATIVE_PROVIDER_FAKE_FIXTURE_ID) {
    invalid("fake probe fixture_id does not match the v1 fixture");
  }
  requireExactCaseVector(plan.cases);
  return Object.freeze({
    schema: LINUX_NATIVE_PROVIDER_FAKE_PROBE_PLAN_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    target: normalizeTarget(plan.target),
    authority: "none",
    scope: "fake_fixture_only",
    disposition: "non_qualifying",
    reusable: false,
    fixture_id: LINUX_NATIVE_PROVIDER_FAKE_FIXTURE_ID,
    cases: LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES,
  });
}

export function createLinuxNativeProviderFakeProbePlanV1(target) {
  return normalizeLinuxNativeProviderFakeProbePlanV1({
    schema: LINUX_NATIVE_PROVIDER_FAKE_PROBE_PLAN_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    target,
    authority: "none",
    scope: "fake_fixture_only",
    disposition: "non_qualifying",
    reusable: false,
    fixture_id: LINUX_NATIVE_PROVIDER_FAKE_FIXTURE_ID,
    cases: LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES,
  });
}

export function serializeLinuxNativeProviderFakeProbePlanV1(input) {
  return JSON.stringify(normalizeLinuxNativeProviderFakeProbePlanV1(input));
}

function sha256(source) {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function linuxNativeProviderFakeProbePlanSha256V1(input) {
  return sha256(serializeLinuxNativeProviderFakeProbePlanV1(input));
}

function parseCanonical(source, maximumBytes, label, normalize) {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    Buffer.byteLength(source) > maximumBytes
  ) {
    invalid(`${label} must be canonical JSON up to ${maximumBytes} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid(`${label} must contain valid JSON`);
  }
  const normalized = normalize(parsed);
  if (JSON.stringify(normalized) !== source) {
    invalid(`${label} must use the canonical v1 encoding`);
  }
  return normalized;
}

export function parseLinuxNativeProviderFakeProbePlanV1(source) {
  return parseCanonical(
    source,
    PLAN_MAX_BYTES,
    "fake probe plan",
    normalizeLinuxNativeProviderFakeProbePlanV1,
  );
}

export function normalizeLinuxNativeProviderLiveEvidenceGapV1(
  input,
  expectedPlan,
) {
  const plan = normalizeLinuxNativeProviderFakeProbePlanV1(expectedPlan);
  const gap = requireExactObject(input, GAP_KEYS, "live evidence gap");
  if (gap.schema !== LINUX_NATIVE_PROVIDER_LIVE_EVIDENCE_GAP_SCHEMA) {
    invalid("unsupported live evidence gap schema");
  }
  requireCommonFields(gap);
  if (gap.state !== "not_observed") {
    invalid("live evidence gap state must remain not_observed");
  }
  if (gap.reason_code !== "live_observer_not_implemented") {
    invalid("live evidence gap reason_code is not part of the v1 schema");
  }
  const target = normalizeTarget(gap.target);
  if (target.os !== plan.target.os || target.arch !== plan.target.arch) {
    invalid("live evidence gap target does not match its plan");
  }
  if (gap.plan_sha256 !== linuxNativeProviderFakeProbePlanSha256V1(plan)) {
    invalid("live evidence gap does not bind the expected plan");
  }
  return Object.freeze({
    schema: LINUX_NATIVE_PROVIDER_LIVE_EVIDENCE_GAP_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    plan_sha256: gap.plan_sha256,
    target,
    authority: "none",
    scope: "fake_fixture_only",
    disposition: "non_qualifying",
    reusable: false,
    state: "not_observed",
    reason_code: "live_observer_not_implemented",
  });
}

export function createLinuxNativeProviderLiveEvidenceGapV1(planInput) {
  const plan = normalizeLinuxNativeProviderFakeProbePlanV1(planInput);
  return normalizeLinuxNativeProviderLiveEvidenceGapV1(
    {
      schema: LINUX_NATIVE_PROVIDER_LIVE_EVIDENCE_GAP_SCHEMA,
      policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
      policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
      plan_sha256: linuxNativeProviderFakeProbePlanSha256V1(plan),
      target: plan.target,
      authority: "none",
      scope: "fake_fixture_only",
      disposition: "non_qualifying",
      reusable: false,
      state: "not_observed",
      reason_code: "live_observer_not_implemented",
    },
    plan,
  );
}

export function serializeLinuxNativeProviderLiveEvidenceGapV1(
  input,
  expectedPlan,
) {
  return JSON.stringify(
    normalizeLinuxNativeProviderLiveEvidenceGapV1(input, expectedPlan),
  );
}

export function parseLinuxNativeProviderLiveEvidenceGapV1(
  source,
  expectedPlan,
) {
  return parseCanonical(source, GAP_MAX_BYTES, "live evidence gap", (input) =>
    normalizeLinuxNativeProviderLiveEvidenceGapV1(input, expectedPlan),
  );
}

export function assertLinuxNativeProviderFakeProbeInvocationAuthorityV1(plan) {
  normalizeLinuxNativeProviderFakeProbePlanV1(plan);
  throw new LinuxNativeProviderContainmentAuthorityError("fake-probe invocation");
}

export function assertLinuxNativeProviderFakeProbeQualificationAuthorityV1(
  plan,
  evidenceGap,
) {
  normalizeLinuxNativeProviderLiveEvidenceGapV1(evidenceGap, plan);
  throw new LinuxNativeProviderContainmentAuthorityError(
    "fake-probe qualification",
  );
}
