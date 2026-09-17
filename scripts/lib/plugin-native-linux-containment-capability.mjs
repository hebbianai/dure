import { createHash } from "node:crypto";

export const LINUX_NATIVE_PROVIDER_CONTAINMENT_CAPABILITY_SCHEMA =
  "dure-linux-native-provider-containment-capability/v1";
export const LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID =
  "linux-bwrap-networkless-v1";
export const LINUX_NATIVE_PROVIDER_CONTAINMENT_TARGET_ARCHITECTURES =
  Object.freeze(["x86_64", "aarch64"]);

// This vector is deliberately indivisible. Live evidence will attest one exact
// policy digest instead of combining independently observed booleans into a
// capability that no single execution actually proved.
export const LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_GUARANTEES =
  Object.freeze([
    "exact_outer_launcher_fd_no_path_lookup_and_scrubbed_environment_v1",
    "exact_bubblewrap_fd_regular_root_owned_non_setid_no_file_caps_v1",
    "trusted_nonwritable_ancestors_and_runtime_loader_closure_v1",
    "explicit_user_mount_pid_network_ipc_uts_cgroup_namespaces_v1",
    "nested_user_namespace_disabled_without_try_fallbacks_v1",
    "empty_root_with_held_fd_bounded_mounts_v1",
    "recursive_read_only_nodev_nosuid_read_mounts_v1",
    "private_read_only_nodev_nosuid_noexec_proc_v1",
    "architecture_bound_seccomp_and_exact_fd_allowlist_v1",
    "no_new_privileges_and_empty_linux_capability_sets_v1",
    "fixed_uts_hostname_v1",
    "clear_environment_fixed_working_directory_and_new_session_v1",
    "content_addressed_closure_rehashed_inside_sandbox_v1",
    "single_owner_only_host_backed_writable_root_v1",
    "nonce_bound_trusted_pre_exec_attestation_gate_v1",
    "host_cgroup_v2_atomic_kill_and_pidfd_subreaper_receipt_v1",
    "separate_provider_evidence_and_control_roots_v1",
    "cleanup_proofs_before_identity_bound_root_retirement_v1",
  ]);

const POLICY_DOCUMENT = JSON.stringify({
  schema: "dure-linux-native-provider-containment-policy/v1",
  policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
  guarantees: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_GUARANTEES,
});

export const LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256 = `sha256:${createHash(
  "sha256",
)
  .update(POLICY_DOCUMENT)
  .digest("hex")}`;

export const LINUX_NATIVE_PROVIDER_CONTAINMENT_REASON_CODES = Object.freeze({
  not_implemented: Object.freeze(["runner_not_implemented"]),
  unsupported: Object.freeze([
    "platform_unsupported",
    "architecture_unsupported",
    "bubblewrap_absent",
    "bubblewrap_build_unqualified",
    "unprivileged_userns_unavailable",
    "required_namespace_unavailable",
    "userns_lockdown_unavailable",
    "seccomp_unavailable",
    "pidfd_unavailable",
    "subreaper_unavailable",
    "cgroup_v2_unavailable",
    "cgroup_delegation_unavailable",
    "cgroup_kill_unavailable",
    "runtime_closure_unavailable",
  ]),
  failed: Object.freeze([
    "bubblewrap_identity_mismatch",
    "bubblewrap_identity_changed",
    "policy_digest_mismatch",
    "staged_identity_changed",
    "namespace_attestation_mismatch",
    "mount_attestation_mismatch",
    "proc_attestation_mismatch",
    "environment_attestation_mismatch",
    "fd_attestation_mismatch",
    "network_attestation_mismatch",
    "writable_root_attestation_mismatch",
    "process_containment_mismatch",
    "probe_protocol_invalid",
    "capability_drift_after_probe",
    "cleanup_incomplete",
  ]),
});

const CAPABILITY_KEYS = Object.freeze([
  "authority",
  "policy_id",
  "policy_sha256",
  "reason_code",
  "schema",
  "state",
  "target",
]);
const CAPABILITY_KEYS_WITH_DIAGNOSTIC = Object.freeze([
  ...CAPABILITY_KEYS,
  "diagnostic",
].sort());
const TARGET_KEYS = Object.freeze(["arch", "os"]);
const TARGET_ARCHITECTURES = new Set(
  LINUX_NATIVE_PROVIDER_CONTAINMENT_TARGET_ARCHITECTURES,
);
const MAX_CAPABILITY_DOCUMENT_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function exactSortedKeys(value) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid("v1 capability objects must not contain symbol fields");
  }
  return Object.getOwnPropertyNames(value).sort();
}

function sameKeys(observed, expected) {
  return JSON.stringify(observed) === JSON.stringify(expected);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message) {
  throw new LinuxNativeProviderContainmentCapabilityError(message);
}

function requireExactObject(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  if (!sameKeys(exactSortedKeys(value), keys)) {
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

function requireDiagnostic(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_DIAGNOSTIC_BYTES ||
    CONTROL_CHARACTER.test(value) ||
    value !== value.normalize("NFC")
  ) {
    invalid(
      `diagnostic must be canonical, control-free text up to ${MAX_DIAGNOSTIC_BYTES} bytes`,
    );
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      invalid("diagnostic must not contain an unpaired surrogate");
    }
  }
  return value;
}

function normalizeTarget(input) {
  const target = requireExactObject(input, TARGET_KEYS, "capability target");
  if (target.os !== "linux") {
    invalid("capability target os must be linux");
  }
  if (!TARGET_ARCHITECTURES.has(target.arch)) {
    invalid("capability target architecture is not part of the v1 schema");
  }
  return Object.freeze({ os: target.os, arch: target.arch });
}

function normalizeStateAndReason(state, reasonCode) {
  if (typeof state !== "string" || typeof reasonCode !== "string") {
    invalid("capability state and reason_code must be strings");
  }
  if (!Object.hasOwn(LINUX_NATIVE_PROVIDER_CONTAINMENT_REASON_CODES, state)) {
    invalid("capability state is not part of the v1 schema");
  }
  if (!LINUX_NATIVE_PROVIDER_CONTAINMENT_REASON_CODES[state].includes(reasonCode)) {
    invalid("capability reason_code does not belong to its state");
  }
  return { reasonCode, state };
}

export class LinuxNativeProviderContainmentCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "LinuxNativeProviderContainmentCapabilityError";
    this.code = "plugin_native_linux_containment_capability_invalid";
  }
}

export class LinuxNativeProviderContainmentAuthorityError extends Error {
  constructor(operation) {
    super(
      `Linux native-provider ${operation} is disabled because the v1 capability has authority none`,
    );
    this.name = "LinuxNativeProviderContainmentAuthorityError";
    this.code = "plugin_native_linux_containment_authority_none";
  }
}

export function normalizeLinuxNativeProviderContainmentCapabilityV1(input) {
  if (!isPlainObject(input)) invalid("capability must be a plain object");
  const hasDiagnostic = Object.hasOwn(input, "diagnostic");
  const expectedKeys = hasDiagnostic
    ? CAPABILITY_KEYS_WITH_DIAGNOSTIC
    : CAPABILITY_KEYS;
  const capability = requireExactObject(input, expectedKeys, "capability");
  if (capability.schema !== LINUX_NATIVE_PROVIDER_CONTAINMENT_CAPABILITY_SCHEMA) {
    invalid("unsupported Linux native-provider containment capability schema");
  }
  if (capability.policy_id !== LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID) {
    invalid("capability policy_id does not match the v1 policy");
  }
  if (capability.policy_sha256 !== LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256) {
    invalid("capability policy_sha256 does not match the v1 policy");
  }
  if (capability.authority !== "none") {
    invalid("v1 Linux native-provider containment authority must be none");
  }
  const { reasonCode, state } = normalizeStateAndReason(
    capability.state,
    capability.reason_code,
  );
  const normalized = {
    schema: LINUX_NATIVE_PROVIDER_CONTAINMENT_CAPABILITY_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    target: normalizeTarget(capability.target),
    authority: "none",
    state,
    reason_code: reasonCode,
    ...(hasDiagnostic
      ? { diagnostic: requireDiagnostic(capability.diagnostic) }
      : {}),
  };
  return Object.freeze(normalized);
}

export function createLinuxNativeProviderContainmentCapabilityV1({
  target,
  state,
  reasonCode,
  diagnostic,
}) {
  return normalizeLinuxNativeProviderContainmentCapabilityV1({
    schema: LINUX_NATIVE_PROVIDER_CONTAINMENT_CAPABILITY_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    target,
    authority: "none",
    state,
    reason_code: reasonCode,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
}

export function serializeLinuxNativeProviderContainmentCapabilityV1(input) {
  return JSON.stringify(
    normalizeLinuxNativeProviderContainmentCapabilityV1(input),
  );
}

export function parseLinuxNativeProviderContainmentCapabilityV1(source) {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    Buffer.byteLength(source) > MAX_CAPABILITY_DOCUMENT_BYTES
  ) {
    invalid(
      `capability document must be JSON up to ${MAX_CAPABILITY_DOCUMENT_BYTES} bytes`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid("capability document must contain valid JSON");
  }
  const normalized = normalizeLinuxNativeProviderContainmentCapabilityV1(parsed);
  if (JSON.stringify(normalized) !== source) {
    invalid("capability document must use the canonical v1 encoding");
  }
  return normalized;
}

function denyAuthority(input, operation) {
  normalizeLinuxNativeProviderContainmentCapabilityV1(input);
  throw new LinuxNativeProviderContainmentAuthorityError(operation);
}

export function assertLinuxNativeProviderInvocationAuthorityV1(input) {
  denyAuthority(input, "invocation");
}

export function assertLinuxNativeProviderQualificationAuthorityV1(input) {
  denyAuthority(input, "qualification");
}
