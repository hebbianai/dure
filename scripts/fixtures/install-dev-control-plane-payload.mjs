#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

function digest(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function artifactDigest(root) {
  const hash = createHash("sha256");
  const visit = (pathname) => {
    const stat = lstatSync(pathname);
    const name = relative(root, pathname).replaceAll("\\", "/");
    if (name === "install.json") return;
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${name}\0${readlinkSync(pathname)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`directory\0${name}\0`);
      for (const entry of readdirSync(pathname).sort()) {
        visit(join(pathname, entry));
      }
      return;
    }
    hash.update(`file\0${name}\0${stat.mode & 0o111}\0`);
    hash.update(readFileSync(pathname));
    hash.update("\0");
  };
  for (const entry of readdirSync(root).sort()) visit(join(root, entry));
  return hash.digest("hex");
}

const home = process.env.HOME;
const channel = process.env.DURE_APP_CHANNEL;
const sourceRevision = process.env.DURE_CLI_SOURCE_REVISION;
const stagedSourceRevision =
  process.env.DURE_TEST_CONTROL_PLANE_STAGED_SOURCE_REVISION ?? sourceRevision;
const installRoot = process.env.DURE_CLI_INSTALL_ROOT;
if (
  !home ||
  !/^dev-[a-z0-9-]+$/.test(channel ?? "") ||
  !/^[a-f0-9]{40}$/.test(sourceRevision ?? "") ||
  !/^[a-f0-9]{40}$/.test(stagedSourceRevision ?? "") ||
  !installRoot
) {
  throw new Error("invalid dev control-plane fixture invocation");
}

const buildId = `0.1.4+fixture-${stagedSourceRevision.slice(0, 16)}`;
const versionRoot = join(installRoot, "versions", buildId);
const binRoot = join(versionRoot, "bin");
const driverRoot = join(binRoot, "provider-drivers", "claude");
const sdkRoot = join(
  driverRoot,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
);
rmSync(versionRoot, { force: true, recursive: true });
mkdirSync(sdkRoot, { mode: 0o700, recursive: true });

const controlPlanePath = join(binRoot, "dure-control-plane");
const relayPath = join(binRoot, "dure-claude-process-relay");
writeFileSync(controlPlanePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
writeFileSync(relayPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
chmodSync(controlPlanePath, 0o755);
chmodSync(relayPath, 0o755);
writeFileSync(join(driverRoot, "shared-sdk-host-entrypoint.mjs"), "export {};\n", { mode: 0o600 });
writeFileSync(
  join(driverRoot, "package.json"),
  `${JSON.stringify({
    dependencies: { "@anthropic-ai/claude-agent-sdk": "0.1.0" },
    engines: { node: process.versions.node },
  })}\n`,
);
writeFileSync(
  join(sdkRoot, "package.json"),
  `${JSON.stringify({ version: "0.1.0", claudeCodeVersion: "2.1.234" })}\n`,
);

writeFileSync(
  join(binRoot, "dure.mjs"),
  `import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const executablePath = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "dure-control-plane"));
const executableSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
const generation = "local-v1-" + executableSha256.slice(0, 32);
const appRoot = process.env.DURE_HOME || join(process.env.HOME, ".dure");
mkdirSync(join(appRoot, "backend"), { mode: 0o700, recursive: true });
writeFileSync(join(appRoot, "backend", "control-plane.json"), JSON.stringify({
  schemaVersion: 5,
  backendId: "dure-local",
  generation,
  buildId: "dure-control-plane/v1-fixture",
  controlPlaneIdentity: {
    executablePath,
    executableDevice: "1",
    executableInode: "1",
    executableSize: "1",
    executableModified: "1:1",
    executableSha256,
  },
}));
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-reconcile/v1",
  kind: "dure.backend.reconcile",
  status: "ready",
  authority: { backendId: "dure-local", generation },
}));
`,
  { mode: 0o755 },
);

const controlPlaneDigest = digest(controlPlanePath);
const hmuxExecutablePath = realpathSync(controlPlanePath);
const hmuxRuntimeExecutablePath = realpathSync(relayPath);
const bundle = {
  schemaVersion: 2,
  artifactDigest: "",
  app: { schemaVersion: 2, channel, sourceRevision: stagedSourceRevision },
  controlPlane: {
    buildId: "dure-control-plane/v1-fixture",
    digest: controlPlaneDigest,
  },
  orchestration: { schemaVersion: 1, payloadDigest: "0".repeat(64) },
  hmux: {
    schemaVersion: 1,
    channel,
    buildId: "hmux-fixture-v1",
    executablePath: hmuxExecutablePath,
    executableDigest: digest(hmuxExecutablePath),
    runtimeExecutablePath: hmuxRuntimeExecutablePath,
    runtimeExecutableDigest: digest(hmuxRuntimeExecutablePath),
  },
};
bundle.artifactDigest = artifactDigest(versionRoot);
const sourceIdentity = JSON.stringify({
  schemaVersion: 3,
  packageVersion: "0.1.4",
  artifactDigest: bundle.artifactDigest,
  app: bundle.app,
  controlPlane: bundle.controlPlane,
  orchestration: bundle.orchestration,
  hmux: bundle.hmux,
});
const sourceDigest = createHash("sha256")
  .update("dure-cli-stabilized-snapshot-v3\0")
  .update(sourceIdentity)
  .update("\0")
  .digest("hex");
writeFileSync(
  join(versionRoot, "install.json"),
  `${JSON.stringify({
    schemaVersion: 3,
    buildId,
    packageVersion: "0.1.4",
    sourceDigest,
    command: "dure",
    controlPlaneCommand: "dure-control-plane",
    compatibilityCommands: ["hebbian-ade", "hebbian-ide"],
    bundle,
  })}\n`,
);
mkdirSync(installRoot, { mode: 0o700, recursive: true });
const current = join(installRoot, "current");
rmSync(current, { force: true, recursive: true });
symlinkSync(join("versions", buildId), current);
if (process.env.DURE_TEST_CONTROL_PLANE_STAGE_RECEIPT) {
  mkdirSync(dirname(process.env.DURE_TEST_CONTROL_PLANE_STAGE_RECEIPT), {
    recursive: true,
  });
  writeFileSync(
    process.env.DURE_TEST_CONTROL_PLANE_STAGE_RECEIPT,
    sourceRevision,
  );
}
