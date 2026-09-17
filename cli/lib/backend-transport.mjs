import { exchangeSshStdio } from "./backend-ssh-stdio.mjs";
import { MAX_BACKEND_CAPABILITIES_V1 } from "./backend-capabilities.mjs";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

export const BACKEND_TRANSPORT_SCHEMA_VERSION = 1;
export const BACKEND_TRANSPORT_API_VERSION = "dure.backend-transport/v1";
export const MAX_BACKEND_TRANSPORT_REQUEST_BYTES = 256 * 1024;
export const MAX_BACKEND_TRANSPORT_RESPONSE_BYTES = 256 * 1024;

const MAX_TOKEN_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 512;
const MAX_PATH_LENGTH = 1_024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_BACKEND_TRANSPORT_LARGE_RESPONSE_BYTES = 2 * 1024 * 1024;
const DURE_CONTROL_PLANE_GATEWAY = "~/.local/bin/dure-control-plane";
const SSH_GATEWAY_CAPABILITY = "backend.transport.ssh_gateway";
const TOKEN = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/;
const GENERATION = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const OPERATION_DISPOSITIONS = new Set([
  "unassigned",
  "stale_generation",
  "retry_same",
  "terminal",
]);

const MESSAGES = Object.freeze({
  backend_transport_aborted: "the backend request was aborted",
  backend_transport_backend_mismatch:
    "the backend identity does not match the selected profile",
  backend_transport_backend_stale:
    "the backend handshake is older than the allowed freshness window",
  backend_transport_capability_missing:
    "the backend does not provide a required capability",
  backend_transport_endpoint_unsupported:
    "the backend endpoint is not supported by this transport",
  backend_transport_generation_mismatch:
    "the backend generation does not match the selected profile",
  backend_transport_invalid_request: "the backend request is invalid",
  backend_transport_malformed_response: "the backend response is malformed",
  backend_transport_output_limit:
    "the backend response exceeded its byte bound",
  backend_transport_peer_untrusted: "the local backend peer is not trusted",
  backend_transport_profile_capability_missing:
    "the selected backend profile does not declare a required capability",
  backend_transport_protocol_incompatible:
    "the backend protocol is incompatible with the selected profile",
  backend_transport_reference_unavailable:
    "the backend transport reference could not be resolved",
  backend_transport_remote_error: "the backend rejected the request",
  backend_transport_ssh_failed: "the SSH backend transport failed",
  backend_transport_ssh_unavailable: "the SSH executable is unavailable",
  backend_transport_timeout: "the backend request exceeded its deadline",
  backend_transport_unavailable: "the backend endpoint is unavailable",
});

export class BackendTransportError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] ?? "backend transport operation failed", options);
    this.code = code;
    this.details = options.details;
    this.name = "BackendTransportError";
  }
}

function fail(code, options) {
  throw new BackendTransportError(code, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, code = "backend_transport_malformed_response") {
  if (!isRecord(value)) fail(code);
}

function assertOnlyKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("backend_transport_malformed_response");
  }
}

function validToken(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    TOKEN.test(value)
  );
}

function validGeneration(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    GENERATION.test(value)
  );
}

function validMessage(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MESSAGE_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validOperationDisposition(value) {
  return OPERATION_DISPOSITIONS.has(value);
}

function validProtocolVersion(value) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "major" || key === "minor") &&
    Number.isSafeInteger(value.major) &&
    value.major >= 0 &&
    value.major <= 65_535 &&
    Number.isSafeInteger(value.minor) &&
    value.minor >= 0 &&
    value.minor <= 65_535
  );
}

function compareVersions(left, right) {
  return left.major === right.major
    ? left.minor - right.minor
    : left.major - right.major;
}

function parseCapabilities(value) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_BACKEND_CAPABILITIES_V1 ||
    value.some((capability) => !validToken(capability)) ||
    new Set(value).size !== value.length
  ) {
    fail("backend_transport_malformed_response");
  }
  return [...value].sort();
}

function normalizeRequiredCapabilities(profile, requiredCapabilities) {
  if (
    !Array.isArray(requiredCapabilities) ||
    requiredCapabilities.length > MAX_BACKEND_CAPABILITIES_V1 ||
    requiredCapabilities.some((capability) => !validToken(capability))
  ) {
    fail("backend_transport_invalid_request");
  }
  const normalized = [...new Set(requiredCapabilities)].sort();
  const declared = new Set(profile.expected?.capabilities);
  for (const capability of normalized) {
    if (!declared.has(capability)) {
      fail("backend_transport_profile_capability_missing", {
        details: { capability },
      });
    }
  }
  return normalized;
}

function serializeBounded(value, maximum, code) {
  let source;
  try {
    source = JSON.stringify(value);
  } catch {
    fail(code);
  }
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") + 1 > maximum
  ) {
    fail(code);
  }
  return Buffer.from(`${source}\n`, "utf8");
}

function validateProfile(profile) {
  if (
    !isRecord(profile) ||
    !validToken(profile.id) ||
    !isRecord(profile.transport) ||
    !isRecord(profile.expected) ||
    !validToken(profile.expected.backendId) ||
    !validGeneration(profile.expected.generation) ||
    !isRecord(profile.expected.protocol) ||
    !validProtocolVersion(profile.expected.protocol.minimum) ||
    !validProtocolVersion(profile.expected.protocol.maximum) ||
    compareVersions(
      profile.expected.protocol.minimum,
      profile.expected.protocol.maximum,
    ) > 0 ||
    !Array.isArray(profile.expected.capabilities) ||
    !Number.isSafeInteger(profile.deadlineMs) ||
    profile.deadlineMs < 1
  ) {
    fail("backend_transport_invalid_request");
  }
}

export function createBackendTransportRequest(
  profile,
  {
    body,
    operation,
    requestId = randomUUID(),
    requiredCapabilities = [],
    scopeId,
  },
) {
  validateProfile(profile);
  if (
    !validToken(requestId) || !validToken(operation) || !isRecord(body) ||
    !Array.isArray(requiredCapabilities) ||
    (scopeId !== undefined && !validToken(scopeId))
  ) {
    fail("backend_transport_invalid_request");
  }
  const required = normalizeRequiredCapabilities(
    profile,
    scopeId === undefined || requiredCapabilities.includes("backend.scope.v1")
      ? requiredCapabilities
      : [...requiredCapabilities, "backend.scope.v1"],
  );
  const request = {
    schemaVersion: BACKEND_TRANSPORT_SCHEMA_VERSION,
    apiVersion: BACKEND_TRANSPORT_API_VERSION,
    kind: "dure.backend.request",
    requestId,
    operation,
    expected: {
      backendId: profile.expected.backendId,
      generation: profile.expected.generation,
      ...(scopeId === undefined ? {} : { scopeId }),
      protocol: {
        minimum: { ...profile.expected.protocol.minimum },
        maximum: { ...profile.expected.protocol.maximum },
      },
      requiredCapabilities: required,
    },
    body,
  };
  return {
    request,
    bytes: serializeBounded(
      request,
      MAX_BACKEND_TRANSPORT_REQUEST_BYTES,
      "backend_transport_invalid_request",
    ),
    requiredCapabilities: required,
  };
}

function decodeResponse(value, maximumBytes) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  if (bytes.byteLength > maximumBytes) {
    fail("backend_transport_output_limit");
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("backend_transport_malformed_response");
  }
  let response;
  try {
    response = JSON.parse(source);
  } catch {
    fail("backend_transport_malformed_response");
  }
  return response;
}

function validateBackendHandshake(
  backend,
  { nowMs, profile, requiredCapabilities },
) {
  assertRecord(backend);
  assertOnlyKeys(
    backend,
    new Set([
      "id",
      "generation",
      "protocol",
      "capabilities",
      "observedAtMs",
    ]),
  );
  if (!validToken(backend.id) || !validGeneration(backend.generation)) {
    fail("backend_transport_malformed_response");
  }
  if (backend.id !== profile.expected.backendId) {
    fail("backend_transport_backend_mismatch");
  }
  if (backend.generation !== profile.expected.generation) {
    fail("backend_transport_generation_mismatch");
  }
  if (!validProtocolVersion(backend.protocol)) {
    fail("backend_transport_malformed_response");
  }
  if (
    compareVersions(backend.protocol, profile.expected.protocol.minimum) < 0 ||
    compareVersions(backend.protocol, profile.expected.protocol.maximum) > 0
  ) {
    fail("backend_transport_protocol_incompatible");
  }
  const capabilities = parseCapabilities(backend.capabilities);
  const capabilitySet = new Set(capabilities);
  for (const capability of [
    ...profile.expected.capabilities,
    ...requiredCapabilities,
  ]) {
    if (!capabilitySet.has(capability)) {
      fail("backend_transport_capability_missing", {
        details: { capability },
      });
    }
  }
  if (
    !Number.isSafeInteger(backend.observedAtMs) ||
    backend.observedAtMs < 0 ||
    backend.observedAtMs > nowMs + MAX_CLOCK_SKEW_MS
  ) {
    fail("backend_transport_malformed_response");
  }
  if (nowMs - backend.observedAtMs > MAX_CLOCK_SKEW_MS) {
    fail("backend_transport_backend_stale");
  }
  return {
    id: backend.id,
    generation: backend.generation,
    protocol: { ...backend.protocol },
    capabilities,
    observedAtMs: backend.observedAtMs,
    sourceAgeMs: Math.max(0, nowMs - backend.observedAtMs),
  };
}

export function parseBackendTransportResponse(
  value,
  {
    nowMs = Date.now(),
    profile,
    requestId,
    requiredCapabilities = [],
    maxResponseBytes = MAX_BACKEND_TRANSPORT_RESPONSE_BYTES,
  },
) {
  validateProfile(profile);
  if (
    !validToken(requestId) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_BACKEND_TRANSPORT_LARGE_RESPONSE_BYTES
  ) {
    fail("backend_transport_invalid_request");
  }
  const response = decodeResponse(value, maxResponseBytes);
  assertRecord(response);
  assertOnlyKeys(
    response,
    new Set([
      "schemaVersion",
      "apiVersion",
      "kind",
      "requestId",
      "backend",
      "result",
      "error",
    ]),
  );
  if (
    response.schemaVersion !== BACKEND_TRANSPORT_SCHEMA_VERSION ||
    response.apiVersion !== BACKEND_TRANSPORT_API_VERSION ||
    !new Set(["dure.backend.response", "dure.backend.error"]).has(
      response.kind,
    ) ||
    response.requestId !== requestId
  ) {
    fail("backend_transport_malformed_response");
  }
  const backend = validateBackendHandshake(response.backend, {
    nowMs,
    profile,
    requiredCapabilities,
  });
  if (response.kind === "dure.backend.error") {
    if (response.result !== undefined) {
      fail("backend_transport_malformed_response");
    }
    assertRecord(response.error);
    assertOnlyKeys(response.error, new Set(["code", "message", "details"]));
    if (
      !validToken(response.error.code) ||
      !validMessage(response.error.message)
    ) {
      fail("backend_transport_malformed_response");
    }
    if (
      response.error.details !== undefined &&
      !isRecord(response.error.details)
    ) {
      fail("backend_transport_malformed_response");
    }
    const disposition = response.error.details?.disposition;
    if (disposition !== undefined && !validOperationDisposition(disposition)) {
      fail("backend_transport_malformed_response");
    }
    fail("backend_transport_remote_error", {
      details: {
        code: response.error.code,
        ...(disposition ? { disposition } : {}),
        ...(validToken(response.error.details?.reasonCode)
          ? { reasonCode: response.error.details.reasonCode }
          : {}),
      },
    });
  }
  if (response.error !== undefined || response.result === undefined) {
    fail("backend_transport_malformed_response");
  }
  return {
    schemaVersion: BACKEND_TRANSPORT_SCHEMA_VERSION,
    apiVersion: BACKEND_TRANSPORT_API_VERSION,
    kind: "dure.backend.result",
    requestId,
    backend,
    result: response.result,
  };
}

function boundedPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    isAbsolute(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function sshForwardTarget(endpoint) {
  if (endpoint.kind !== "tcp") {
    fail("backend_transport_endpoint_unsupported");
  }
  const host = endpoint.host.includes(":")
    ? `[${endpoint.host}]`
    : endpoint.host;
  return `${host}:${endpoint.port}`;
}

function buildSshTransportArgv(
  profile,
  resolvedReferences,
  { sshCommand = "ssh" } = {},
) {
  validateProfile(profile);
  if (profile.transport.kind !== "ssh" || !validMessage(sshCommand)) {
    fail("backend_transport_invalid_request");
  }
  assertRecord(resolvedReferences, "backend_transport_reference_unavailable");
  const knownHostsFile = resolvedReferences.knownHostsFile;
  if (!boundedPath(knownHostsFile)) {
    fail("backend_transport_reference_unavailable");
  }
  const argv = [
    sshCommand,
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PubkeyAuthentication=yes",
    "-o",
    "NumberOfPasswordPrompts=0",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "LogLevel=ERROR",
    "-o",
    `ConnectTimeout=${Math.max(
      1,
      Math.ceil(profile.transport.connectTimeoutMs / 1_000),
    )}`,
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
  ];
  if (profile.auth.kind === "identity_file") {
    if (!boundedPath(resolvedReferences.identityFile)) {
      fail("backend_transport_reference_unavailable");
    }
    argv.push(
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `IdentityFile=${resolvedReferences.identityFile}`,
    );
  } else if (profile.auth.kind === "ssh_agent") {
    argv.push("-o", "IdentitiesOnly=no", "-o", "IdentityFile=none");
  } else {
    fail("backend_transport_invalid_request");
  }
  argv.push("-p", String(profile.transport.port), "-l", profile.transport.user);
  return argv;
}

export function buildSshStdinShellArgv(
  profile,
  resolvedReferences,
  options = {},
) {
  return [
    ...buildSshTransportArgv(profile, resolvedReferences, options),
    "--",
    profile.transport.host,
    "/bin/sh -s",
  ];
}

export function buildBackendSshArgv(
  profile,
  resolvedReferences,
  options = {},
) {
  const argv = buildSshTransportArgv(profile, resolvedReferences, options);
  if (profile.transport.endpoint.kind === "tcp") {
    argv.push(
      "-W",
      sshForwardTarget(profile.transport.endpoint),
      "--",
      profile.transport.host,
    );
  } else if (profile.transport.endpoint.kind === "unix_socket") {
    if (!profile.expected.capabilities.includes(SSH_GATEWAY_CAPABILITY)) {
      fail("backend_transport_profile_capability_missing", {
        details: { capability: SSH_GATEWAY_CAPABILITY },
      });
    }
    argv.push(
      "--",
      profile.transport.host,
      DURE_CONTROL_PLANE_GATEWAY,
      "gateway",
      "--socket-hex",
      Buffer.from(profile.transport.endpoint.path, "utf8").toString("hex"),
      "--expected-generation",
      profile.expected.generation,
    );
  } else {
    fail("backend_transport_endpoint_unsupported");
  }
  return argv;
}

export function exchangeLocalBackendRequest(
  endpoint,
  input,
  {
    connect = createConnection,
    deadlineMs,
    lstat = lstatSync,
    maxResponseBytes = MAX_BACKEND_TRANSPORT_RESPONSE_BYTES,
    signal,
  },
) {
  return new Promise((resolve) => {
    if (
      !isRecord(endpoint) ||
      !new Set(["unix_socket", "windows_named_pipe"]).has(endpoint.kind) ||
      !Buffer.isBuffer(input) ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1
    ) {
      resolve({ kind: "unavailable", stdout: Buffer.alloc(0) });
      return;
    }
    if (signal?.aborted) {
      resolve({ kind: "aborted", stdout: Buffer.alloc(0) });
      return;
    }
    let socket;
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket?.destroy();
      resolve(result);
    };
    const onAbort = () =>
      finish({ kind: "aborted", stdout: Buffer.concat(chunks) });
    const timer = setTimeout(
      () => finish({ kind: "timeout", stdout: Buffer.concat(chunks) }),
      deadlineMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      socket = connect(
        endpoint.kind === "unix_socket" ? endpoint.path : endpoint.name,
      );
      socket.on("connect", () => {
        if (
          endpoint.kind === "unix_socket" &&
          !ownerOnlySocket(endpoint.path, lstat)
        ) {
          finish({ kind: "peer_untrusted", stdout: Buffer.alloc(0) });
          return;
        }
        socket.write(input);
      });
      socket.on("data", (chunk) => {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxResponseBytes) {
          finish({ kind: "output_limit", stdout: Buffer.concat(chunks) });
          return;
        }
        chunks.push(bytes);
      });
      socket.on("end", () =>
        finish({ kind: "success", stdout: Buffer.concat(chunks) }),
      );
      socket.on("error", () =>
        finish({ kind: "unavailable", stdout: Buffer.concat(chunks) }),
      );
    } catch {
      finish({ kind: "unavailable", stdout: Buffer.concat(chunks) });
    }
  });
}

function ownerOnlySocket(pathname, lstat) {
  if (process.platform === "win32") return true;
  const expectedUid = process.geteuid?.();
  if (!Number.isSafeInteger(expectedUid)) return false;
  try {
    const metadata = lstat(pathname);
    return (
      !metadata.isSymbolicLink() &&
      metadata.isSocket() &&
      metadata.uid === expectedUid &&
      (metadata.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

export function exchangeSshBackendRequest(
  argv,
  input,
  {
    deadlineMs,
    maxResponseBytes = MAX_BACKEND_TRANSPORT_RESPONSE_BYTES,
    signal,
    spawnProcess,
  },
) {
  if (
    !Array.isArray(argv) || !validMessage(argv[0]) || !Buffer.isBuffer(input) ||
    !Number.isSafeInteger(deadlineMs) || deadlineMs < 1
  ) {
    return Promise.resolve({ kind: "unavailable", stdout: Buffer.alloc(0) });
  }
  return exchangeSshStdio(argv, input, {
    deadlineMs, maxResponseBytes, signal, spawnProcess,
  });
}

function mapExchangeFailure(result, transportKind) {
  if (result.kind === "timeout") fail("backend_transport_timeout");
  if (result.kind === "aborted") fail("backend_transport_aborted");
  if (result.kind === "output_limit") fail("backend_transport_output_limit");
  if (result.kind === "peer_untrusted") {
    fail("backend_transport_peer_untrusted");
  }
  if (transportKind === "ssh") {
    fail(
      result.kind === "unavailable"
        ? "backend_transport_ssh_unavailable"
        : "backend_transport_ssh_failed",
    );
  }
  fail("backend_transport_unavailable");
}

export async function performBackendProfileRequest(
  profile,
  requestOptions,
  {
    deadlineMs: requestedDeadlineMs,
    localExchange = exchangeLocalBackendRequest,
    maxResponseBytes = MAX_BACKEND_TRANSPORT_RESPONSE_BYTES,
    now = Date.now,
    resolveSshReferences,
    signal,
    sshCommand = "ssh",
    sshExchange = exchangeSshBackendRequest,
  } = {},
) {
  let effectiveRequestOptions = requestOptions;
  if (
    profile?.transport?.kind === "ssh" &&
    profile.transport.endpoint?.kind === "unix_socket"
  ) {
    const requestedCapabilities = requestOptions?.requiredCapabilities ?? [];
    if (!Array.isArray(requestedCapabilities)) {
      fail("backend_transport_invalid_request");
    }
    effectiveRequestOptions = {
      ...requestOptions,
      requiredCapabilities: [
        ...requestedCapabilities,
        SSH_GATEWAY_CAPABILITY,
      ],
    };
  }
  const { bytes, request, requiredCapabilities } =
    createBackendTransportRequest(profile, effectiveRequestOptions);
  const deadlineMs = Math.min(
    profile.deadlineMs,
    requestedDeadlineMs ?? profile.deadlineMs,
  );
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    fail("backend_transport_invalid_request");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_BACKEND_TRANSPORT_LARGE_RESPONSE_BYTES
  ) {
    fail("backend_transport_invalid_request");
  }
  let exchange;
  if (profile.transport.kind === "local") {
    exchange = await localExchange(profile.transport.endpoint, bytes, {
      deadlineMs,
      maxResponseBytes,
      signal,
    });
  } else if (profile.transport.kind === "ssh") {
    if (typeof resolveSshReferences !== "function") {
      fail("backend_transport_reference_unavailable");
    }
    let resolvedReferences;
    try {
      resolvedReferences = resolveSshReferences({
        auth: { ...profile.auth },
        profileId: profile.id,
        trust: { ...profile.trust },
      }).pin();
    } catch {
      fail("backend_transport_reference_unavailable");
    }
    try {
      const argv = buildBackendSshArgv(profile, resolvedReferences, { sshCommand });
      exchange = await sshExchange(argv, bytes, {
        deadlineMs, maxResponseBytes, signal,
      });
    } finally {
      resolvedReferences.dispose();
    }
  } else {
    fail("backend_transport_endpoint_unsupported");
  }
  if (exchange?.kind !== "success") {
    mapExchangeFailure(
      exchange ?? { kind: "unavailable" },
      profile.transport.kind,
    );
  }
  return parseBackendTransportResponse(exchange.stdout, {
    nowMs: now(),
    profile,
    requestId: request.requestId,
    requiredCapabilities,
    maxResponseBytes,
  });
}

export function backendTransportErrorReport(error, profile) {
  const typed =
    error instanceof BackendTransportError
      ? error
      : new BackendTransportError("backend_transport_unavailable");
  return {
    schemaVersion: BACKEND_TRANSPORT_SCHEMA_VERSION,
    apiVersion: BACKEND_TRANSPORT_API_VERSION,
    kind: "dure.backend.transport_error",
    profile: isRecord(profile)
      ? { id: profile.id, transport: profile.transport?.kind }
      : null,
    error: {
      code: typed.code,
      message: typed.message,
      ...(typed.details?.capability
        ? { capability: typed.details.capability }
        : {}),
      ...(typed.details?.code ? { remoteCode: typed.details.code } : {}),
      ...(validToken(typed.details?.reasonCode)
        ? { reasonCode: typed.details.reasonCode }
        : {}),
      ...(validOperationDisposition(typed.details?.disposition)
        ? { disposition: typed.details.disposition }
        : {}),
    },
  };
}
