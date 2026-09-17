import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import { MAX_BACKEND_CAPABILITIES_V1 } from "./backend-capabilities.mjs";

export const BACKEND_PROFILES_SCHEMA_VERSION = 1;
export const BACKEND_PROFILES_KIND = "dure.backend_profiles";
export const BACKEND_PROFILES_FILE = "backend-profiles.json";
export const MAX_BACKEND_PROFILES_BYTES = 64 * 1024;
export const MAX_BACKEND_PROFILES = 32;
export const DEFAULT_BACKEND_PROFILE_DEADLINE_MS = 10_000;
export const MAX_BACKEND_PROFILE_DEADLINE_MS = 190_000;

const MAX_ID_LENGTH = 64;
const MAX_SHORT_STRING_LENGTH = 256;
const MAX_PATH_LENGTH = 1_024;
const DEFAULT_SSH_CONNECT_TIMEOUT_MS = 5_000;
const CREDENTIAL_REFERENCE_PREFIX = "credential-profile:";
const KNOWN_HOSTS_REFERENCE_PREFIX = "known-hosts-profile:";
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const GENERATION = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const CAPABILITY = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SSH_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;
const SSH_USER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const MESSAGES = Object.freeze({
  backend_profiles_auth_invalid: "backend profile authentication is invalid",
  backend_profiles_capabilities_invalid:
    "backend profile capabilities are invalid",
  backend_profiles_config_changed:
    "backend profiles configuration changed while it was read",
  backend_profiles_config_missing: "backend profiles configuration is missing",
  backend_profiles_config_too_large:
    "backend profiles configuration exceeds its byte bound",
  backend_profiles_config_untrusted_platform:
    "the platform cannot provide no-follow backend profile reads",
  backend_profiles_config_unavailable:
    "backend profiles configuration could not be read",
  backend_profiles_config_unsafe:
    "backend profiles configuration is not an owner-only regular file",
  backend_profiles_default_ambiguous:
    "backend profiles configuration declares more than one default",
  backend_profiles_endpoint_invalid: "backend profile endpoint is invalid",
  backend_profiles_expected_invalid:
    "backend profile expected identity is invalid",
  backend_profiles_json_invalid: "backend profiles configuration is not valid JSON",
  backend_profiles_utf8_invalid:
    "backend profiles configuration is not valid UTF-8",
  backend_profiles_profile_count_invalid:
    "backend profiles configuration has an invalid profile count",
  backend_profiles_profile_id_duplicate:
    "backend profiles configuration contains a duplicate profile id",
  backend_profiles_profile_id_invalid: "backend profile id is invalid",
  backend_profiles_profile_invalid: "backend profile is invalid",
  backend_profiles_protocol_invalid: "backend profile protocol range is invalid",
  backend_profiles_schema_invalid: "backend profiles configuration schema is invalid",
  backend_profiles_selection_missing:
    "no backend profile selector or unique default is available",
  backend_profiles_selection_not_found: "selected backend profile does not exist",
  backend_profiles_selector_invalid: "backend profile selector is invalid",
  backend_profiles_transport_invalid: "backend profile transport is invalid",
  backend_profiles_trust_invalid: "backend profile trust policy is invalid",
  backend_profiles_unknown_field: "backend profiles configuration has an unknown field",
});

export class BackendProfileError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] ?? "backend profiles operation failed", options);
    this.code = code;
    this.name = "BackendProfileError";
  }
}

function fail(code, options) {
  throw new BackendProfileError(code, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, code) {
  if (!isRecord(value)) fail(code);
}

function assertOnlyKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("backend_profiles_unknown_field");
  }
}

function validBoundedString(value, maximum = MAX_SHORT_STRING_LENGTH) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseProfileId(value, code = "backend_profiles_profile_id_invalid") {
  if (
    !validBoundedString(value, MAX_ID_LENGTH) ||
    !PROFILE_ID.test(value)
  ) {
    fail(code);
  }
  return value;
}

function parseAbsolutePath(value, code) {
  if (!validBoundedString(value, MAX_PATH_LENGTH) || !isAbsolute(value)) {
    fail(code);
  }
  return value;
}

function parsePort(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) fail(code);
  return value;
}

function parsePositiveInteger(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(code);
  return value;
}

function parseNamespacedReference(value, prefix, code) {
  if (
    !validBoundedString(value, MAX_SHORT_STRING_LENGTH) ||
    !value.startsWith(prefix)
  ) {
    fail(code);
  }
  const referenceId = value.slice(prefix.length);
  if (`${prefix}${parseProfileId(referenceId, code)}` !== value) fail(code);
  return value;
}

function parseEndpoint(value) {
  const code = "backend_profiles_endpoint_invalid";
  assertRecord(value, code);
  if (value.kind === "unix_socket") {
    assertOnlyKeys(value, new Set(["kind", "path"]));
    return {
      kind: "unix_socket",
      path: parseAbsolutePath(value.path, code),
    };
  }
  if (value.kind === "windows_named_pipe") {
    assertOnlyKeys(value, new Set(["kind", "name"]));
    if (
      !validBoundedString(value.name, MAX_PATH_LENGTH) ||
      !value.name.startsWith("\\\\.\\pipe\\")
    ) {
      fail(code);
    }
    return { kind: "windows_named_pipe", name: value.name };
  }
  if (value.kind === "tcp") {
    assertOnlyKeys(value, new Set(["kind", "host", "port"]));
    if (!validBoundedString(value.host) || !SSH_HOST.test(value.host)) fail(code);
    return { kind: "tcp", host: value.host, port: parsePort(value.port, code) };
  }
  fail(code);
}

function parseTransport(value, deadlineMs) {
  const code = "backend_profiles_transport_invalid";
  assertRecord(value, code);
  if (value.kind === "local") {
    assertOnlyKeys(value, new Set(["kind", "endpoint"]));
    const endpoint = parseEndpoint(value.endpoint);
    if (endpoint.kind === "tcp") fail(code);
    return { kind: "local", endpoint };
  }
  if (value.kind === "ssh") {
    assertOnlyKeys(
      value,
      new Set([
        "kind",
        "host",
        "port",
        "user",
        "endpoint",
        "batchMode",
        "strictHostKeyChecking",
        "connectTimeoutMs",
      ]),
    );
    if (!validBoundedString(value.host) || !SSH_HOST.test(value.host)) fail(code);
    if (!validBoundedString(value.user, 64) || !SSH_USER.test(value.user)) {
      fail(code);
    }
    const batchMode = value.batchMode ?? true;
    const strictHostKeyChecking = value.strictHostKeyChecking ?? "yes";
    const connectTimeoutMs = parsePositiveInteger(
      value.connectTimeoutMs ??
        Math.min(DEFAULT_SSH_CONNECT_TIMEOUT_MS, deadlineMs),
      deadlineMs,
      code,
    );
    if (batchMode !== true || strictHostKeyChecking !== "yes") fail(code);
    return {
      kind: "ssh",
      host: value.host,
      port: parsePort(value.port, code),
      user: value.user,
      endpoint: parseEndpoint(value.endpoint),
      batchMode: true,
      strictHostKeyChecking: "yes",
      connectTimeoutMs,
    };
  }
  fail(code);
}

function parseAuth(value, transportKind) {
  const code = "backend_profiles_auth_invalid";
  assertRecord(value, code);
  if (transportKind === "local" && value.kind === "peer") {
    assertOnlyKeys(value, new Set(["kind"]));
    return { kind: "peer" };
  }
  if (transportKind === "ssh" && value.kind === "ssh_agent") {
    assertOnlyKeys(value, new Set(["kind"]));
    return { kind: "ssh_agent" };
  }
  if (transportKind === "ssh" && value.kind === "identity_file") {
    assertOnlyKeys(value, new Set(["kind", "reference"]));
    return {
      kind: "identity_file",
      reference: parseNamespacedReference(
        value.reference,
        CREDENTIAL_REFERENCE_PREFIX,
        code,
      ),
    };
  }
  fail(code);
}

function parseTrust(value, transportKind) {
  const code = "backend_profiles_trust_invalid";
  assertRecord(value, code);
  if (transportKind === "local" && value.kind === "local_peer") {
    assertOnlyKeys(value, new Set(["kind"]));
    return { kind: "local_peer" };
  }
  if (transportKind === "ssh" && value.kind === "known_hosts") {
    assertOnlyKeys(value, new Set(["kind", "reference"]));
    return {
      kind: "known_hosts",
      reference: parseNamespacedReference(
        value.reference,
        KNOWN_HOSTS_REFERENCE_PREFIX,
        code,
      ),
    };
  }
  fail(code);
}

function parseVersion(value) {
  const code = "backend_profiles_protocol_invalid";
  assertRecord(value, code);
  assertOnlyKeys(value, new Set(["major", "minor"]));
  if (
    !Number.isSafeInteger(value.major) ||
    value.major < 0 ||
    value.major > 65_535 ||
    !Number.isSafeInteger(value.minor) ||
    value.minor < 0 ||
    value.minor > 65_535
  ) {
    fail(code);
  }
  return { major: value.major, minor: value.minor };
}

function compareVersions(left, right) {
  return left.major === right.major
    ? left.minor - right.minor
    : left.major - right.major;
}

function parseCapabilities(value) {
  const code = "backend_profiles_capabilities_invalid";
  if (!Array.isArray(value) || value.length > MAX_BACKEND_CAPABILITIES_V1) fail(code);
  const capabilities = value.map((capability) => {
    if (
      !validBoundedString(capability, 128) ||
      !CAPABILITY.test(capability)
    ) {
      fail(code);
    }
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) fail(code);
  return capabilities.sort();
}

function parseExpected(value) {
  const code = "backend_profiles_expected_invalid";
  assertRecord(value, code);
  assertOnlyKeys(
    value,
    new Set(["backendId", "generation", "protocol", "capabilities"]),
  );
  const backendId = parseProfileId(value.backendId, code);
  if (
    !validBoundedString(value.generation, 128) ||
    !GENERATION.test(value.generation)
  ) {
    fail(code);
  }
  assertRecord(value.protocol, "backend_profiles_protocol_invalid");
  assertOnlyKeys(value.protocol, new Set(["minimum", "maximum"]));
  const minimum = parseVersion(value.protocol.minimum);
  const maximum = parseVersion(value.protocol.maximum);
  if (compareVersions(minimum, maximum) > 0) {
    fail("backend_profiles_protocol_invalid");
  }
  return {
    backendId,
    generation: value.generation,
    protocol: { minimum, maximum },
    capabilities: parseCapabilities(value.capabilities),
  };
}

function parseProfile(value) {
  const code = "backend_profiles_profile_invalid";
  assertRecord(value, code);
  assertOnlyKeys(
    value,
    new Set([
      "id",
      "default",
      "transport",
      "auth",
      "trust",
      "expected",
      "deadlineMs",
    ]),
  );
  if (value.default !== undefined && typeof value.default !== "boolean") {
    fail(code);
  }
  const deadlineMs = parsePositiveInteger(
    value.deadlineMs ?? DEFAULT_BACKEND_PROFILE_DEADLINE_MS,
    MAX_BACKEND_PROFILE_DEADLINE_MS,
    code,
  );
  const transport = parseTransport(value.transport, deadlineMs);
  return {
    id: parseProfileId(value.id),
    default: value.default === true,
    transport,
    auth: parseAuth(value.auth, transport.kind),
    trust: parseTrust(value.trust, transport.kind),
    expected: parseExpected(value.expected),
    deadlineMs,
  };
}

export function parseBackendProfiles(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("backend_profiles_json_invalid");
  }
  assertRecord(value, "backend_profiles_schema_invalid");
  assertOnlyKeys(value, new Set(["schemaVersion", "kind", "profiles"]));
  if (
    value.schemaVersion !== BACKEND_PROFILES_SCHEMA_VERSION ||
    value.kind !== BACKEND_PROFILES_KIND ||
    !Array.isArray(value.profiles) ||
    value.profiles.length < 1 ||
    value.profiles.length > MAX_BACKEND_PROFILES
  ) {
    fail(
      Array.isArray(value.profiles) &&
        (value.profiles.length < 1 || value.profiles.length > MAX_BACKEND_PROFILES)
        ? "backend_profiles_profile_count_invalid"
        : "backend_profiles_schema_invalid",
    );
  }
  const profiles = value.profiles.map(parseProfile);
  const ids = new Set();
  let defaults = 0;
  for (const profile of profiles) {
    if (ids.has(profile.id)) fail("backend_profiles_profile_id_duplicate");
    ids.add(profile.id);
    if (profile.default) defaults += 1;
  }
  if (defaults > 1) fail("backend_profiles_default_ambiguous");
  profiles.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return {
    schemaVersion: BACKEND_PROFILES_SCHEMA_VERSION,
    kind: BACKEND_PROFILES_KIND,
    profiles,
  };
}

export function resolveBackendProfilesPath({
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  const override = environment.DURE_ORCHESTRATION_HOME || environment.DURE_HOME;
  if (override !== undefined && override !== "") {
    if (!validBoundedString(override, MAX_PATH_LENGTH) || !isAbsolute(override)) {
      fail("backend_profiles_config_unsafe");
    }
    return join(override, BACKEND_PROFILES_FILE);
  }
  return join(homeDirectory, ".dure", BACKEND_PROFILES_FILE);
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertSecureFile(stat) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1n ||
    (stat.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    fail("backend_profiles_config_unsafe");
  }
  if (stat.size > BigInt(MAX_BACKEND_PROFILES_BYTES)) {
    fail("backend_profiles_config_too_large");
  }
}

export function requireBackendProfileNoFollowFlag(
  flag = fsConstants.O_NOFOLLOW,
) {
  if (!Number.isSafeInteger(flag) || flag <= 0) {
    fail("backend_profiles_config_untrusted_platform");
  }
  return flag;
}

function readOwnerOnlyFile(filePath) {
  let descriptor;
  try {
    const pathStat = lstatSync(filePath, { bigint: true });
    assertSecureFile(pathStat);
    const noFollowFlag = requireBackendProfileNoFollowFlag();
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY |
        (fsConstants.O_CLOEXEC ?? 0) |
        noFollowFlag,
    );
    const before = fstatSync(descriptor, { bigint: true });
    assertSecureFile(before);
    if (!sameFileSnapshot(pathStat, before)) {
      fail("backend_profiles_config_changed");
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    let finalPathStat;
    try {
      finalPathStat = lstatSync(filePath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") fail("backend_profiles_config_changed");
      throw error;
    }
    if (
      offset !== Number(before.size) ||
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(after, finalPathStat)
    ) {
      fail("backend_profiles_config_changed");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      );
    } catch {
      fail("backend_profiles_utf8_invalid");
    }
  } catch (error) {
    if (error instanceof BackendProfileError) throw error;
    if (error?.code === "ENOENT") fail("backend_profiles_config_missing");
    if (["ELOOP", "EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
      fail("backend_profiles_config_unsafe");
    }
    fail("backend_profiles_config_unavailable", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadBackendProfiles(options = {}) {
  const configPath =
    options.configPath ?? resolveBackendProfilesPath(options);
  return parseBackendProfiles(readOwnerOnlyFile(configPath));
}

export function selectBackendProfile(
  catalog,
  { explicitId, environment = process.env } = {},
) {
  const environmentId = environment.DURE_ORCHESTRATION_HOME
    ? "local"
    : environment.DURE_BACKEND_PROFILE;
  let selectedId;
  let source;
  if (explicitId !== undefined) {
    selectedId = parseProfileId(explicitId, "backend_profiles_selector_invalid");
    source = "cli";
  } else if (environmentId !== undefined && environmentId !== "") {
    selectedId = parseProfileId(
      environmentId,
      "backend_profiles_selector_invalid",
    );
    source = "environment";
  } else {
    const defaults = catalog.profiles.filter((profile) => profile.default);
    if (defaults.length !== 1) fail("backend_profiles_selection_missing");
    selectedId = defaults[0].id;
    source = "default";
  }
  const profile = catalog.profiles.find((item) => item.id === selectedId);
  if (!profile) fail("backend_profiles_selection_not_found");
  return { profile, source };
}

function endpointId(endpoint) {
  const authority =
    endpoint.kind === "unix_socket"
      ? endpoint.path
      : endpoint.kind === "windows_named_pipe"
        ? endpoint.name
        : `${endpoint.host}:${endpoint.port}`;
  return `e_${createHash("sha256").update(`${endpoint.kind}\0${authority}`).digest("hex").slice(0, 16)}`;
}

function projectEndpoint(endpoint) {
  return { kind: endpoint.kind, id: endpointId(endpoint) };
}

export function projectBackendProfile(profile) {
  const transport =
    profile.transport.kind === "local"
      ? {
          kind: "local",
          endpoint: projectEndpoint(profile.transport.endpoint),
        }
      : {
          kind: "ssh",
          host: profile.transport.host,
          port: profile.transport.port,
          user: profile.transport.user,
          endpoint: projectEndpoint(profile.transport.endpoint),
          batchMode: profile.transport.batchMode,
          strictHostKeyChecking: profile.transport.strictHostKeyChecking,
          connectTimeoutMs: profile.transport.connectTimeoutMs,
        };
  const auth =
    profile.auth.kind === "identity_file"
      ? { kind: "identity_file", referenceKind: "private_key_file" }
      : { kind: profile.auth.kind, referenceKind: null };
  const trust =
    profile.trust.kind === "known_hosts"
      ? { kind: "known_hosts", referenceKind: "known_hosts_file" }
      : { kind: profile.trust.kind, referenceKind: null };
  return {
    id: profile.id,
    default: profile.default,
    transport,
    auth,
    trust,
    expected: {
      backendId: profile.expected.backendId,
      generation: profile.expected.generation,
      protocol: {
        minimum: { ...profile.expected.protocol.minimum },
        maximum: { ...profile.expected.protocol.maximum },
      },
      capabilities: [...profile.expected.capabilities],
    },
    deadlineMs: profile.deadlineMs,
  };
}

export function backendProfilesErrorReport(error) {
  const typed =
    error instanceof BackendProfileError
      ? error
      : new BackendProfileError("backend_profiles_config_unavailable");
  return {
    schemaVersion: BACKEND_PROFILES_SCHEMA_VERSION,
    apiVersion: "dure.backend-profiles/v1",
    kind: "dure.backend_profiles.error",
    error: { code: typed.code, message: typed.message },
  };
}

export function formatBackendProfilesReport(report) {
  if (report.kind === "dure.backend_profiles.list") {
    const lines = [`Dure backend profiles: ${report.profiles.length}`];
    for (const profile of report.profiles) {
      lines.push(
        `  ${profile.default ? "*" : "-"} ${profile.id} (${profile.transport.kind})`,
      );
    }
    return lines.join("\n");
  }
  const profile = report.profile;
  return [
    `Dure backend profile: ${profile.id}`,
    `  selected by: ${report.selection?.source ?? "explicit show"}`,
    `  transport: ${profile.transport.kind}`,
    `  auth: ${profile.auth.kind}`,
    `  trust: ${profile.trust.kind}`,
    `  backend: ${profile.expected.backendId}@${profile.expected.generation}`,
  ].join("\n");
}
