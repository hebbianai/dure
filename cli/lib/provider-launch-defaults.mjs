import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MODES = ["require_approvals", "bypass_approvals"];
const MAX_OUTPUT_BYTES = 256 * 1024;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function sameDefaults(left, right) {
  if (!record(left) || !record(right)) return false;
  const leftProviders = Object.keys(left).sort();
  const rightProviders = Object.keys(right).sort();
  return (
    leftProviders.length === rightProviders.length &&
    leftProviders.every(
      (providerId, index) =>
        providerId === rightProviders[index] &&
        left[providerId]?.permissionMode === right[providerId]?.permissionMode,
    )
  );
}

function document(value) {
  if (
    !onlyKeys(value, ["schemaVersion", "revision", "defaults", "fingerprint"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !record(value.defaults) ||
    Object.keys(value.defaults).length > 64 ||
    !SHA256.test(value.fingerprint)
  ) {
    return null;
  }
  for (const [providerId, entry] of Object.entries(value.defaults)) {
    if (
      providerId.length > 128 ||
      !PROVIDER_ID.test(providerId) ||
      !onlyKeys(entry, ["permissionMode"]) ||
      !MODES.includes(entry.permissionMode)
    ) {
      return null;
    }
  }
  return value;
}

function errorReport(action, error, profile) {
  return {
    schemaVersion: 1,
    apiVersion: "dure.provider-launch-defaults/v1",
    kind: "dure.provider_launch_defaults.error",
    action,
    complete: false,
    source: { kind: "backend_profile", appDaemonRequired: false },
    error: { ...error, ...(profile ? { profileId: profile.id } : {}) },
  };
}

function backendErrorReport(action, error, profile) {
  return errorReport(action, backendRequestFailure(error, profile), profile);
}

async function request(requestBackend, backend, operation, body) {
  return requestBackend(
    backend.profile,
    {
      operation,
      requiredCapabilities: [operation],
      body,
    },
    {
      ...backend.transportOptions,
      deadlineMs: backend.profile.deadlineMs ?? 2_500,
      maxResponseBytes: MAX_OUTPUT_BYTES,
    },
  );
}

export async function collectProviderLaunchDefaults({
  action,
  providerId,
  permissionMode,
  idempotencyKey,
  backend,
  requestBackend = performBackendProfileRequest,
} = {}) {
  const profile = backend?.profile;
  if (
    !["get", "set"].includes(action) ||
    (action === "set" &&
      ((providerId?.length ?? 0) > 128 ||
        !PROVIDER_ID.test(providerId ?? "") ||
        !MODES.includes(permissionMode) ||
        !TOKEN.test(idempotencyKey ?? "")))
  ) {
    return errorReport(
      action,
      { code: "provider_launch_defaults_request_invalid" },
      profile,
    );
  }
  if (backend?.error || !profile) {
    return backendErrorReport(action, backend?.error, profile);
  }
  try {
    const read = await request(
      requestBackend,
      backend,
      "provider_launch_defaults.get",
      { schemaVersion: 1 },
    );
    const current =
      onlyKeys(read.result, ["schemaVersion", "document"]) &&
      read.result.schemaVersion === 1
        ? document(read.result.document)
        : null;
    if (!current) {
      return errorReport(
        action,
        { code: "provider_launch_defaults_payload_invalid" },
        profile,
      );
    }
    let receipt = null;
    let selected = current;
    let backendIdentity = read.backend;
    if (action === "set") {
      const requestedDefaults = {
        ...current.defaults,
        [providerId]: { permissionMode },
      };
      const write = await request(
        requestBackend,
        backend,
        "provider_launch_defaults.put",
        {
          schemaVersion: 1,
          idempotencyKey,
          expectedRevision: current.revision,
          defaults: requestedDefaults,
        },
      );
      const writtenDocument = document(write.result?.receipt?.document);
      const disposition = write.result?.receipt?.disposition;
      const exactWrite = disposition === "created" || disposition === "updated";
      const revisionMatches =
        (disposition === "created" &&
          current.revision === 0 &&
          writtenDocument?.revision === 1) ||
        (disposition === "updated" &&
          writtenDocument?.revision === current.revision + 1) ||
        (disposition === "preserved_existing" &&
          current.revision === 0 &&
          Number(writtenDocument?.revision) > 0);
      if (
        write.backend.id !== read.backend.id ||
        write.backend.generation !== read.backend.generation ||
        !onlyKeys(write.result, ["schemaVersion", "receipt"]) ||
        write.result.schemaVersion !== 1 ||
        !onlyKeys(write.result.receipt, [
          "schemaVersion",
          "idempotencyKey",
          "expectedRevision",
          "disposition",
          "document",
          "updatedAtMs",
        ]) ||
        write.result.receipt.schemaVersion !== 1 ||
        write.result.receipt.idempotencyKey !== idempotencyKey ||
        write.result.receipt.expectedRevision !== current.revision ||
        !["created", "updated", "preserved_existing"].includes(
          write.result.receipt.disposition,
        ) ||
        !Number.isSafeInteger(write.result.receipt.updatedAtMs) ||
        write.result.receipt.updatedAtMs < 0 ||
        !writtenDocument ||
        !revisionMatches ||
        (exactWrite && !sameDefaults(writtenDocument.defaults, requestedDefaults))
      ) {
        return errorReport(
          action,
          { code: "provider_launch_defaults_payload_invalid" },
          profile,
        );
      }
      if (writtenDocument.defaults[providerId]?.permissionMode !== permissionMode) {
        return errorReport(
          action,
          { code: "provider_launch_defaults_revision_conflict" },
          profile,
        );
      }
      selected = writtenDocument;
      receipt = write.result.receipt;
      backendIdentity = write.backend;
    }
    return {
      schemaVersion: 1,
      apiVersion: "dure.provider-launch-defaults/v1",
      kind: `dure.provider_launch_defaults.${action}`,
      action,
      complete: true,
      source: {
        kind: "backend_profile",
        appDaemonRequired: false,
        profileId: profile.id,
        transport: profile.transport.kind,
        backend: backendIdentity,
      },
      document: selected,
      ...(receipt ? { receipt } : {}),
    };
  } catch (error) {
    return backendErrorReport(action, error, profile);
  }
}

export function providerLaunchDefaultsExitCode(report) {
  return report.complete ? 0 : 2;
}

export function formatProviderLaunchDefaults(report) {
  if (!report.complete) {
    return `Provider launch defaults unavailable: ${report.error.remoteCode ?? report.error.code}`;
  }
  return [
    `revision\t${report.document.revision}`,
    ...Object.entries(report.document.defaults).map(
      ([providerId, value]) => `${providerId}\t${value.permissionMode}`,
    ),
  ].join("\n");
}
