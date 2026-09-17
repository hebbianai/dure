import { TextDecoder } from "node:util";
import { gzipSync } from "node:zlib";
import {
  loadBackendProfiles,
  selectBackendProfile,
} from "./backend-profiles.mjs";
import { resolveBackendSshReferencesFromEnvironment } from "./backend-ssh-references.mjs";
import {
  BackendTransportError,
  buildSshStdinShellArgv,
  exchangeSshBackendRequest,
  performBackendProfileRequest,
} from "./backend-transport.mjs";
import { createOrchestrationIntegrationDeliveryPackage } from "./orchestration-integration-bundle.mjs";
import { isOrchestrationIntegrationReceipt } from "./orchestration-integration.mjs";

const MAX_DELIVERY_BYTES = 256 * 1024;
const MAX_DELIVERY_RESPONSE_BYTES = 256 * 1024;
const MAX_REMOTE_SCRIPT_BYTES = 512 * 1024;
const DELIVERY_KIND = "dure.orchestration.integration_delivery";
const DELIVERY_ERROR_KIND = "dure.orchestration.integration_delivery_error";
const MUTATIONS = new Set(["install", "update", "uninstall"]);
const SHA256 = /^[a-f0-9]{64}$/;

const MESSAGES = Object.freeze({
  orchestration_integration_remote_capability_missing:
    "the SSH worker profile does not provide orchestration.invoke",
  orchestration_integration_remote_global_required:
    "SSH worker integration currently requires --global",
  orchestration_integration_remote_invalid:
    "the SSH worker integration request is invalid",
  orchestration_integration_remote_profile_required:
    "SSH worker integration requires an explicit SSH backend profile",
  orchestration_integration_remote_receipt_invalid:
    "the SSH worker returned an invalid integration receipt",
  orchestration_integration_remote_transport_required:
    "the selected integration profile is not an SSH transport",
});

export class RemoteOrchestrationIntegrationError extends Error {
  constructor(code, options = {}) {
    super(
      options.message ?? MESSAGES[code] ?? "SSH worker integration failed",
      options,
    );
    this.code = code;
    this.details = options.details;
    this.name = "RemoteOrchestrationIntegrationError";
  }
}

function fail(code, options) {
  throw new RemoteOrchestrationIntegrationError(code, options);
}

function bootstrapSource(deliveryPackage) {
  // Pin the file count to the generated manifest, not a second catalog limit.
  // Wire, decompression and decoded-content budgets remain independently bounded.
  const archive = gzipSync(Buffer.from(
    JSON.stringify({
      schemaVersion: deliveryPackage.schemaVersion,
      kind: deliveryPackage.kind,
      digest: deliveryPackage.digest,
      files: deliveryPackage.files,
    }),
    "utf8",
  ));
  if (archive.byteLength > MAX_DELIVERY_BYTES) {
    fail("orchestration_integration_remote_invalid");
  }
  const chunks = archive
    .toString("base64")
    .match(/.{1,96}/gu)
    ?.map((chunk) => JSON.stringify(chunk)) ?? [];
  const encoded = `[${chunks.join(",")}].join("")`;
  const bootstrap = `const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);
const archive = JSON.parse(require("node:zlib").gunzipSync(Buffer.from(${encoded}, "base64"), { maxOutputLength: ${MAX_REMOTE_SCRIPT_BYTES} }).toString("utf8"));
if (archive?.schemaVersion !== 1 || archive?.kind !== "dure.orchestration.integration_package" || !Array.isArray(archive.files) || archive.files.length !== ${deliveryPackage.files.length} || !/^[a-f0-9]{64}$/.test(archive.digest)) process.exit(70);
const digest = crypto.createHash("sha256").update("dure.orchestration.integration-package/v1\\0");
const seen = new Set();
let previous = "";
let total = 0;
for (const file of archive.files) {
  if (!file || typeof file.path !== "string" || typeof file.content !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,255}$/.test(file.path) || file.path.includes("//") || file.path.split("/").some((part) => part === "." || part === "..") || seen.has(file.path) || (previous && previous >= file.path)) process.exit(71);
  const content = Buffer.from(file.content, "base64");
  if (content.toString("base64") !== file.content) process.exit(72);
  total += content.byteLength;
  if (total > ${MAX_DELIVERY_BYTES}) process.exit(73);
  seen.add(file.path);
  previous = file.path;
  digest.update(file.path + "\\0").update(content).update("\\0");
  const destination = path.resolve(root, file.path);
  if (!destination.startsWith(root + path.sep)) process.exit(74);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
}
if (digest.digest("hex") !== archive.digest) process.exit(75);
`;
  const missingNode = JSON.stringify({
    schemaVersion: 1,
    kind: DELIVERY_ERROR_KIND,
    deliveryDigest: deliveryPackage.digest,
    error: {
      code: "orchestration_integration_remote_failed",
      message: "Node.js is unavailable on the SSH worker",
    },
  });
  const script = Buffer.from(
    `set -eu
umask 077
dure_stage_root=/tmp
dure_stage=$(mktemp -d "$dure_stage_root/dure-orchestration-delivery.XXXXXX")
case "$dure_stage" in "$dure_stage_root"/dure-orchestration-delivery.??????) ;; *) exit 65 ;; esac
cleanup() { rm -rf -- "$dure_stage"; }
trap cleanup EXIT HUP INT TERM
dure_node=$(command -v node || true)
if [ -z "$dure_node" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  NVM_DIR="$HOME/.nvm"
  export NVM_DIR
  . "$NVM_DIR/nvm.sh"
  dure_node=$(command -v node || true)
fi
if [ -z "$dure_node" ]; then
  printf '%s' '${missingNode}'
  exit 0
fi
"$dure_node" - "$dure_stage" <<'DURE_ORCHESTRATION_BOOTSTRAP_V1'
${bootstrap}
DURE_ORCHESTRATION_BOOTSTRAP_V1
DURE_INTEGRATION_DELIVERY_DIGEST='${deliveryPackage.digest}' "$dure_node" "$dure_stage/runner.mjs"
`,
    "utf8",
  );
  if (script.byteLength > MAX_REMOTE_SCRIPT_BYTES) {
    fail("orchestration_integration_remote_invalid");
  }
  return script;
}

function mapExchangeFailure(result) {
  if (result?.kind === "timeout") {
    throw new BackendTransportError("backend_transport_timeout");
  }
  if (result?.kind === "aborted") {
    throw new BackendTransportError("backend_transport_aborted");
  }
  if (result?.kind === "output_limit") {
    throw new BackendTransportError("backend_transport_output_limit");
  }
  throw new BackendTransportError(
    result?.kind === "unavailable"
      ? "backend_transport_ssh_unavailable"
      : "backend_transport_ssh_failed",
  );
}

async function negotiateWorkerProfile(
  profile,
  references,
  { requestBackend, signal },
) {
  const response = await requestBackend(
    profile,
    {
      body: { schemaVersion: 1 },
      operation: "backend.ping",
      requiredCapabilities: ["orchestration.invoke"],
    },
    {
      resolveSshReferences: () => references,
      signal,
    },
  );
  if (
    !exactKeys(response.result, new Set(["schemaVersion", "status"])) ||
    response.result.schemaVersion !== 1 ||
    response.result.status !== "ready"
  ) {
    throw new BackendTransportError("backend_transport_malformed_response");
  }
  return response.backend;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.size &&
    Object.keys(value).every((key) => keys.has(key))
  );
}

function matchesCurrentReceipt(receipt, expected) {
  return (
    receipt.status === "current" &&
    receipt.scope === "global" &&
    receipt.version === expected.version &&
    receipt.cliDigest === expected.cliDigest &&
    receipt.digest === expected.payloadDigest &&
    receipt.transportRef === expected.transportRef &&
    JSON.stringify(receipt.capabilities) ===
      JSON.stringify(expected.capabilities) &&
    receipt.globalConfigurationApproved === true
  );
}

function parseDelivery(source, expected) {
  let delivery;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    delivery = JSON.parse(text);
  } catch {
    fail("orchestration_integration_remote_receipt_invalid");
  }
  if (
    !exactKeys(
      delivery,
      new Set(
        delivery?.kind === DELIVERY_KIND
          ? ["schemaVersion", "kind", "deliveryDigest", "receipts"]
          : ["schemaVersion", "kind", "deliveryDigest", "error"],
      ),
    ) ||
    delivery.schemaVersion !== 1 ||
    delivery.deliveryDigest !== expected.deliveryDigest ||
    !SHA256.test(delivery.deliveryDigest)
  ) {
    fail("orchestration_integration_remote_receipt_invalid");
  }
  if (delivery.kind === DELIVERY_ERROR_KIND) {
    if (
      !exactKeys(delivery.error, new Set(["code", "message"])) ||
      delivery.error?.code !== "orchestration_integration_remote_failed" ||
      typeof delivery.error?.message !== "string" ||
      delivery.error.message.length < 1 ||
      delivery.error.message.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(delivery.error.message)
    ) {
      fail("orchestration_integration_remote_receipt_invalid");
    }
    throw new RemoteOrchestrationIntegrationError(delivery.error.code, {
      message: delivery.error.message,
      details: { message: delivery.error.message },
    });
  }
  if (
    delivery.kind !== DELIVERY_KIND ||
    !Array.isArray(delivery.receipts) ||
    delivery.receipts.length !== expected.providers.length
  ) {
    fail("orchestration_integration_remote_receipt_invalid");
  }
  const providers = new Set();
  for (const receipt of delivery.receipts) {
    if (
      !isOrchestrationIntegrationReceipt(receipt) ||
      (receipt.scope !== null && receipt.scope !== "global") ||
      !expected.providers.includes(receipt.provider) ||
      providers.has(receipt.provider) ||
      typeof receipt.status !== "string" ||
      receipt.apiVersion !== expected.apiVersion
    ) {
      fail("orchestration_integration_remote_receipt_invalid");
    }
    providers.add(receipt.provider);
    if (expected.action === "install" || expected.action === "update") {
      if (!matchesCurrentReceipt(receipt, expected)) {
        fail("orchestration_integration_remote_receipt_invalid");
      }
    } else if (expected.action === "uninstall") {
      if (
        receipt.status !== "removed" ||
        receipt.scope !== "global" ||
        receipt.digest !== expected.payloadDigest ||
        receipt.transportRef !== expected.transportRef ||
        receipt.globalConfigurationApproved !== true
      ) {
        fail("orchestration_integration_remote_receipt_invalid");
      }
    } else {
      if (
        !new Set(["current", "outdated", "missing", "invalid"]).has(
          receipt.status,
        ) ||
        (receipt.status === "current" &&
          !matchesCurrentReceipt(receipt, expected))
      ) {
        fail("orchestration_integration_remote_receipt_invalid");
      }
    }
  }
  return delivery.receipts;
}

export async function runRemoteOrchestrationIntegration(
  {
    action,
    approval,
    backend,
    channel,
    cliScriptPath,
    global,
    provider,
  },
  {
    environment = process.env,
    exchange = exchangeSshBackendRequest,
    requestBackend = performBackendProfileRequest,
    resolveSshReferences = resolveBackendSshReferencesFromEnvironment,
    signal,
    sshCommand = "ssh",
  } = {},
) {
  if (
    !new Set(["install", "update", "uninstall", "status"]).has(action) ||
    typeof backend !== "string" ||
    backend.length === 0 ||
    (provider !== undefined && !new Set(["codex", "claude"]).has(provider))
  ) {
    fail("orchestration_integration_remote_profile_required");
  }
  if (!global) fail("orchestration_integration_remote_global_required");
  if (MUTATIONS.has(action) && !approval) {
    throw new Error(
      "global provider configuration requires --approve-global-config",
    );
  }
  const selection = selectBackendProfile(
    loadBackendProfiles({ environment }),
    { explicitId: backend, environment },
  );
  const profile = selection.profile;
  if (profile.transport.kind !== "ssh") {
    fail("orchestration_integration_remote_transport_required");
  }
  if (!profile.expected.capabilities.includes("orchestration.invoke")) {
    fail("orchestration_integration_remote_capability_missing");
  }
  const references = resolveSshReferences(
    {
      auth: { ...profile.auth },
      profileId: profile.id,
      trust: { ...profile.trust },
    },
    environment,
  );
  const backendIdentity = await negotiateWorkerProfile(profile, references, {
    requestBackend,
    signal,
  });
  const transportRef = `ssh-profile:${profile.id}@${backendIdentity.generation}`;
  const deliveryPackage = createOrchestrationIntegrationDeliveryPackage(
    cliScriptPath,
    {
      schemaVersion: 1,
      action,
      approval: Boolean(approval),
      channel,
      global: true,
      ...(provider === undefined ? {} : { provider }),
      transportRef,
    },
  );
  const material = references.pin();
  let result;
  try {
    const argv = buildSshStdinShellArgv(profile, material, { sshCommand });
    result = await exchange(argv, bootstrapSource(deliveryPackage), {
      deadlineMs: profile.deadlineMs,
      maxResponseBytes: MAX_DELIVERY_RESPONSE_BYTES,
      signal,
    });
  } finally {
    material.dispose();
  }
  if (result?.kind !== "success") mapExchangeFailure(result);
  return parseDelivery(result.stdout, {
    action,
    apiVersion: deliveryPackage.identity.apiVersion,
    capabilities: deliveryPackage.identity.capabilities,
    cliDigest: deliveryPackage.identity.cliDigest,
    deliveryDigest: deliveryPackage.digest,
    payloadDigest: deliveryPackage.identity.payloadDigest,
    providers: provider === undefined ? ["claude", "codex"] : [provider],
    transportRef,
    version: deliveryPackage.identity.version,
  });
}
