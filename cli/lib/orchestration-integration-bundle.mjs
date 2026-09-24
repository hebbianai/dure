import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseMetadata } from "./dure-cli-channel-launcher.mjs";
import {
  ORCHESTRATION_API_VERSION,
  ORCHESTRATION_CLIENT_CAPABILITIES,
} from "./orchestration-client.mjs";

const DELIVERY_PACKAGE_KIND = "dure.orchestration.integration_package";
const DELIVERY_PACKAGE_PREFIX = "dure.orchestration.integration-package/v1\0";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const INTEGRATION_METADATA_NAMES = Object.freeze([
  "SKILL.md",
  "mcp.json",
  "lifecycle.json",
]);

export const ORCHESTRATION_PAYLOAD_NAMES = Object.freeze([
  ...INTEGRATION_METADATA_NAMES,
  "orchestration-client.mjs",
  "contracts/orchestration-envelope.mjs",
  "managed-session-enrollment-evidence.mjs",
  "orchestration-backend-transport.mjs",
  "orchestration-failure.mjs",
  "orchestration-lifecycle.mjs",
  "orchestration-mcp-server.mjs",
  "jev-mcp-tool.mjs",
  "jev.mjs",
  "dure-cli-channel-launcher.mjs",
  "app-control-mcp-tools.mjs",
  "app-control-client.mjs",
  "app-control-location.mjs",
  "app-observation.mjs",
  "client-presentation-command.mjs",
  "client-presentation-state.mjs",
  "space-selection.mjs",
  "client-registry.mjs",
  "fd-verified-read.mjs",
  "session-runtime-projection.mjs",
  "orchestration-next-work.mjs",
  "backend-capabilities.mjs",
  "backend-capability-limit.json",
  "backend-profiles.mjs",
  "backend-ssh-references.mjs",
  "backend-ssh-material.mjs",
  "backend-ssh-stdio.mjs",
  "backend-transport.mjs",
]);

const DELIVERY_RUNNER = `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const request = JSON.parse(fs.readFileSync(new URL("./request.json", import.meta.url), "utf8"));
try {
  const packageRoot = path.dirname(fileURLToPath(import.meta.url));
  const cliScriptPath = path.resolve(packageRoot, request.cliRelativePath);
  if (!cliScriptPath.startsWith(packageRoot + path.sep)) {
    throw new Error("orchestration delivery CLI path escaped its package");
  }
  const installer = await import(
    pathToFileURL(path.join(path.dirname(cliScriptPath), "lib", "orchestration-integration.mjs")).href
  );
  const receipts = installer.runOrchestrationIntegrationAction(request.action, {
    cliScriptPath,
    channel: request.channel,
    homeDirectory: os.homedir(),
    global: request.global,
    provider: request.provider,
    approval: request.approval,
    transportRef: request.transportRef,
  });
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    kind: "dure.orchestration.integration_delivery",
    deliveryDigest: process.env.DURE_INTEGRATION_DELIVERY_DIGEST,
    receipts,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    kind: "dure.orchestration.integration_delivery_error",
    deliveryDigest: process.env.DURE_INTEGRATION_DELIVERY_DIGEST,
    error: {
      code: "orchestration_integration_remote_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  }));
}
`;

export function loadBundledOrchestrationPayload(cliScriptPath) {
  const cliRoot = path.dirname(cliScriptPath);
  const sourceRoot = path.resolve(
    cliRoot,
    "..",
    "orchestration",
    "integration",
  );
  const installedSourceRoot = path.join(cliRoot, "orchestration-integration");
  const root = fs.existsSync(installedSourceRoot)
    ? installedSourceRoot
    : sourceRoot;
  const files = ORCHESTRATION_PAYLOAD_NAMES.map((name) => [
    name,
    INTEGRATION_METADATA_NAMES.includes(name)
      ? path.join(root, name)
      : path.join(cliRoot, "lib", name),
  ]);
  for (const [, source] of files) {
    if (!fs.existsSync(source)) {
      throw new Error(`bundled orchestration payload is missing: ${source}`);
    }
  }
  const digest = crypto.createHash("sha256");
  for (const [name, source] of files) {
    digest.update(`${name}\0`);
    digest.update(fs.readFileSync(source));
    digest.update("\0");
  }
  return { files, digest: digest.digest("hex") };
}

export function orchestrationPayloadIdentity(cliScriptPath) {
  const payload = loadBundledOrchestrationPayload(cliScriptPath);
  return {
    apiVersion: ORCHESTRATION_API_VERSION,
    digest: payload.digest,
    capabilities: [...ORCHESTRATION_CLIENT_CAPABILITIES],
  };
}

export function validateOrchestrationPayloadIdentity(
  expected,
  cliScriptPath,
) {
  const observed = orchestrationPayloadIdentity(cliScriptPath);
  const keys = ["apiVersion", "digest", "capabilities"];
  if (
    expected === null ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    Object.keys(expected).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(expected, key)) ||
    expected.apiVersion !== observed.apiVersion ||
    expected.digest !== observed.digest ||
    !isDeepStrictEqual(expected.capabilities, observed.capabilities)
  ) {
    throw new Error("Dure CLI orchestration bundle receipt is invalid");
  }
  return observed;
}

export function readDureCliIdentity(cliScriptPath) {
  const versionRoot = path.dirname(path.dirname(fs.realpathSync(cliScriptPath)));
  const metadataPath = path.join(versionRoot, "install.json");
  if (fs.existsSync(metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (
      metadata.schemaVersion === 3 &&
      path.basename(versionRoot) === metadata.buildId &&
      SAFE_TOKEN.test(metadata.buildId) &&
      SHA256.test(metadata.sourceDigest)
    ) {
      return {
        version: metadata.buildId,
        cliDigest: metadata.sourceDigest,
        // Advisory update availability is cheap. Installation still verifies
        // the complete immutable artifact before selecting executable paths.
        mcpIdleWorkerAvailable: advertisesMcpIdleWorker(metadata),
      };
    }
  }
  return { version: "source", cliDigest: null, mcpIdleWorkerAvailable: false };
}

function advertisesMcpIdleWorker(metadata) {
  const controlPlane = metadata.bundle?.controlPlane;
  if (controlPlane !== undefined && (
    !Array.isArray(controlPlane?.capabilities) ||
    !controlPlane.capabilities.every((capability) => typeof capability === "string")
  )) {
    throw new Error("MCP worker capabilities are invalid");
  }
  return controlPlane?.capabilities.includes("mcp_stdio_idle_worker_v1") ?? false;
}

export function immutableOrchestrationIdleWorker(cliScriptPath) {
  const binaryRoot = path.dirname(fs.realpathSync(cliScriptPath));
  const versionRoot = path.dirname(binaryRoot);
  const metadataPath = path.join(versionRoot, "install.json");
  if (!fs.existsSync(metadataPath)) return null;
  const advertised = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (!advertisesMcpIdleWorker(advertised)) {
    // Source and remote integration-only payloads keep their existing endpoint.
    return null;
  }
  // Installation is the boundary for full immutable-payload verification. Do
  // not probe a subprocess or rehash the bundle on every MCP call/status read.
  const metadata = parseMetadata(versionRoot);
  const catalogue = path.join(binaryRoot, "orchestration-mcp-catalogue.json");
  if (!fs.statSync(catalogue).isFile()) throw new Error("MCP worker catalogue is unavailable");
  return {
    schemaVersion: 1,
    // Unlike a backend launch override, these paths must stay inside the exact
    // installed version whose worker and catalogue survive an integration update.
    executable: path.join(binaryRoot, metadata.controlPlaneCommand),
    worker: path.join(binaryRoot, "lib", "orchestration-mcp-server.mjs"),
    catalogue,
  };
}

function packageDigest(files) {
  const digest = crypto.createHash("sha256");
  digest.update(DELIVERY_PACKAGE_PREFIX);
  for (const file of files) {
    digest.update(`${file.path}\0`);
    digest.update(file.content);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function createOrchestrationIntegrationDeliveryPackage(
  cliScriptPath,
  request,
) {
  const payload = loadBundledOrchestrationPayload(cliScriptPath);
  const identity = readDureCliIdentity(cliScriptPath);
  const cliRoot = path.dirname(cliScriptPath);
  const versionPrefix = `versions/${identity.version}`;
  const binaryPrefix = `${versionPrefix}/bin`;
  const files = payload.files.map(([name, source]) => ({
    path: INTEGRATION_METADATA_NAMES.includes(name)
      ? `${binaryPrefix}/orchestration-integration/${name}`
      : `${binaryPrefix}/lib/${name}`,
    content: fs.readFileSync(source),
  }));
  files.push(
    {
      path: `${binaryPrefix}/dure.mjs`,
      content: Buffer.from("#!/usr/bin/env node\n", "utf8"),
    },
    {
      path: `${binaryPrefix}/lib/orchestration-integration.mjs`,
      content: fs.readFileSync(
        path.join(cliRoot, "lib", "orchestration-integration.mjs"),
      ),
    },
    {
      path: `${binaryPrefix}/lib/orchestration-integration-bundle.mjs`,
      content: fs.readFileSync(
        path.join(cliRoot, "lib", "orchestration-integration-bundle.mjs"),
      ),
    },
    {
      path: "request.json",
      content: Buffer.from(
        `${JSON.stringify({
          ...request,
          cliRelativePath: `${binaryPrefix}/dure.mjs`,
        })}\n`,
        "utf8",
      ),
    },
    { path: "runner.mjs", content: Buffer.from(DELIVERY_RUNNER, "utf8") },
  );
  if (identity.cliDigest !== null) {
    files.push({
      path: `${versionPrefix}/install.json`,
      content: Buffer.from(
        `${JSON.stringify({
          schemaVersion: 3,
          buildId: identity.version,
          sourceDigest: identity.cliDigest,
        })}\n`,
        "utf8",
      ),
    });
  }
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    schemaVersion: 1,
    kind: DELIVERY_PACKAGE_KIND,
    digest: packageDigest(files),
    identity: {
      version: identity.version,
      cliDigest: identity.cliDigest,
      payloadDigest: payload.digest,
      apiVersion: ORCHESTRATION_API_VERSION,
      capabilities: [...ORCHESTRATION_CLIENT_CAPABILITIES],
    },
    files: files.map((file) => ({
      path: file.path,
      content: file.content.toString("base64"),
    })),
  };
}
