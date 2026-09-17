import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_PLANE_BUILD_ID,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_IDENTITY_API_VERSION,
  CONTROL_PLANE_IDENTITY_KIND,
} from "../../cli/lib/control-plane-contract.mjs";

export function writeControlPlaneFixture(pathname, buildId = CONTROL_PLANE_BUILD_ID) {
  const identity = JSON.stringify({
    schemaVersion: 1,
    apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
    kind: CONTROL_PLANE_IDENTITY_KIND,
    buildId,
    capabilities: CONTROL_PLANE_CAPABILITIES,
  });
  fs.writeFileSync(
    pathname,
    `#!/bin/sh\nif [ "$1" = identity ]; then\n  printf '%s\\n' '${identity}'\n  exit 0\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  writeClaudeRelayFixture(pathname);
}

export function writeClaudeRelayFixture(controlPlanePathname) {
  fs.writeFileSync(
    path.join(path.dirname(controlPlanePathname), "dure-claude-process-relay"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
}

const sourceRepository = fileURLToPath(new URL("../..", import.meta.url));
const driverPath = path.join(
  "crates",
  "dure-app",
  "control-plane",
  "provider-drivers",
  "claude",
);
const preparationInputNames = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "sdk-runtime.mjs",
];

function copyRepositoryPath(repository, relativePath, options) {
  const source = path.join(sourceRepository, relativePath);
  const target = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.lstatSync(source).isDirectory()) {
    fs.cpSync(source, target, { recursive: true, ...options });
  } else {
    fs.copyFileSync(source, target);
  }
}

function claudeSdkContractFixture(repository) {
  const fixtureDriver = fs.realpathSync(path.join(repository, driverPath));
  const driverManifest = JSON.parse(
    fs.readFileSync(path.join(fixtureDriver, "package.json"), "utf8"),
  );
  const sdkVersion = driverManifest.dependencies?.[
    "@anthropic-ai/claude-agent-sdk"
  ];
  if (typeof sdkVersion !== "string") {
    throw new Error("Claude SDK fixture version is unavailable");
  }
  if (typeof driverManifest.packageManager !== "string") {
    throw new Error("Claude SDK fixture package manager is unavailable");
  }
  const claudeCodeVersion = "2.1.234";
  return Object.freeze({
    driverRoot: fixtureDriver,
    packageManager: driverManifest.packageManager,
    sdkManifest: {
      version: claudeCodeVersion,
      platforms: Object.fromEntries(
        [
          "darwin-arm64",
          "darwin-x64",
          "linux-arm64",
          "linux-arm64-musl",
          "linux-x64",
          "linux-x64-musl",
          "win32-arm64",
          "win32-x64",
        ].map((target) => [
          target,
          {
            binary: target.startsWith("win32-") ? "claude.exe" : "claude",
            checksum: "0".repeat(64),
            size: 1,
          },
        ]),
      ),
    },
    sdkModule: [
      "export function getSessionMessages() {}",
      "export function query() {}",
      "export function startup() {}",
      "",
    ].join("\n"),
    sdkPackage: {
      name: "@anthropic-ai/claude-agent-sdk",
      version: sdkVersion,
      type: "module",
      exports: "./sdk.mjs",
      claudeCodeVersion,
      optionalDependencies: {
        "@anthropic-ai/claude-agent-sdk-darwin-arm64": sdkVersion,
      },
    },
    sdkVersion,
  });
}

export function dureCliInstallerFixtureCorepackInvocation(repository) {
  const contract = claudeSdkContractFixture(repository);
  return Object.freeze({
    argv: [
      contract.packageManager,
      "--config.node-linker=hoisted",
      "install",
      "--frozen-lockfile",
      "--prod",
      "--ignore-scripts",
    ],
  });
}

function installCorepackFixture(repository) {
  const binaryDirectory = path.join(repository, ".test-bin");
  const marker = dureCliInstallerFixtureCorepackMarker(repository);
  const contract = claudeSdkContractFixture(repository);
  const invocation = dureCliInstallerFixtureCorepackInvocation(repository);
  const preparationInputs = preparationInputNames.map((name) => ({
    name,
    contents: fs.readFileSync(path.join(contract.driverRoot, name), "utf8"),
  }));
  fs.mkdirSync(binaryDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(binaryDirectory, "corepack"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      `const expected = ${JSON.stringify(invocation)};`,
      `const expectedDriverRoot = ${JSON.stringify(contract.driverRoot)};`,
      `const expectedInputs = ${JSON.stringify(preparationInputs)};`,
      "const actual = { cwd: fs.realpathSync(process.cwd()), argv: process.argv.slice(2) };",
      'const expectedStagingRoot = path.basename(path.dirname(actual.cwd)).startsWith("dure-cli-build-");',
      'if (actual.cwd === expectedDriverRoot || path.basename(actual.cwd) !== "claude-driver-dependencies" || !expectedStagingRoot || JSON.stringify(actual.argv) !== JSON.stringify(expected.argv)) {',
      '  process.stderr.write("corepack fixture invocation mismatch\\n");',
      "  process.exit(64);",
      "}",
      "for (const input of expectedInputs) {",
      "  if (fs.readFileSync(path.join(actual.cwd, input.name), \"utf8\") !== input.contents) {",
      '    process.stderr.write("corepack fixture preparation input mismatch\\n");',
      "    process.exit(65);",
      "  }",
      "}",
      'const nodeModules = path.join(actual.cwd, "node_modules");',
      'const sdkRoot = path.join(nodeModules, "@anthropic-ai", "claude-agent-sdk");',
      "fs.mkdirSync(sdkRoot, { recursive: true });",
      `fs.writeFileSync(path.join(sdkRoot, "package.json"), ${JSON.stringify(
        `${JSON.stringify(contract.sdkPackage, null, 2)}\n`,
      )});`,
      `fs.writeFileSync(path.join(sdkRoot, "manifest.json"), ${JSON.stringify(
        `${JSON.stringify(contract.sdkManifest, null, 2)}\n`,
      )});`,
      `fs.writeFileSync(path.join(sdkRoot, "sdk.mjs"), ${JSON.stringify(
        contract.sdkModule,
      )});`,
      `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(actual) + "\\n");`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binaryDirectory, "corepack.cmd"),
    '@node "%~dp0corepack" %*\r\n',
  );
}

export function createDureCliInstallerFixture(root) {
  const repository = path.join(root, "repository");
  for (const relativePath of [
    "cli",
    "scripts/lib",
    "orchestration/integration",
    "crates/dure-app/control-plane/Cargo.toml",
    "crates/dure-app/control-plane/src",
  ]) {
    copyRepositoryPath(repository, relativePath);
  }
  for (const script of [
    "scripts/install-dure-cli.mjs",
    "scripts/install-hebbian-ide-cli.mjs",
    "scripts/native/native-build-slot.py",
  ]) {
    copyRepositoryPath(repository, script);
  }
  const sourceDriver = path.join(sourceRepository, driverPath);
  copyRepositoryPath(repository, driverPath, {
    filter: (source) => {
      const relative = path.relative(sourceDriver, source);
      return (
        relative !== "node_modules" &&
        !relative.startsWith(`node_modules${path.sep}`) &&
        !relative.endsWith(".test.mjs")
      );
    },
  });
  installCorepackFixture(repository);
  return repository;
}

export function dureCliInstallerFixtureCorepackMarker(repository) {
  return path.join(repository, ".test-corepack-invoked");
}

export function dureCliInstallerFixtureEnvironment(repository, environment) {
  const pathKey =
    Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return {
    ...environment,
    DURE_NATIVE_BUILD_SLOT_ROOT: path.join(repository, ".native-build-slot"),
    [pathKey]: [path.join(repository, ".test-bin"), environment[pathKey]]
      .filter(Boolean)
      .join(path.delimiter),
  };
}
