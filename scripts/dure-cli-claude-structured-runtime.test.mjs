import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeStructuredRuntimeBundleError,
  claudeStructuredRuntimeArguments,
  resolveBundledClaudeStructuredRuntime,
  sameClaudeStructuredRuntimePayload,
} from "../cli/lib/claude-structured-runtime.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "dure-claude-runtime-bundle-"),
  );
  temporaryRoots.push(root);
  return root;
}

function writeBundle(root) {
  const cliRoot = path.join(root, "version", "bin");
  const driverRoot = path.join(cliRoot, "provider-drivers", "claude");
  const sdkRoot = path.join(
    driverRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
  );
  fs.mkdirSync(sdkRoot, { recursive: true });
  const cliScriptPath = path.join(cliRoot, "dure.mjs");
  fs.writeFileSync(cliScriptPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(cliRoot, "dure-claude-process-relay"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(driverRoot, "shared-sdk-host-entrypoint.mjs"),
    "await Promise.resolve();\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(driverRoot, "runtime-helper.mjs"),
    "export const runtime = true;\n",
  );
  fs.writeFileSync(
    path.join(driverRoot, "package.json"),
    JSON.stringify({
      engines: { node: process.versions.node },
      dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.234" },
    }),
  );
  fs.writeFileSync(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({ version: "0.3.234", claudeCodeVersion: "2.1.234" }),
  );
  return { cliRoot, cliScriptPath, driverRoot };
}

describe("bundled Claude structured runtime", () => {
  it("resolves one exact local runtime tuple and creates no service process", () => {
    const root = temporaryRoot();
    const bundle = writeBundle(root);
    const appRoot = path.join(root, "dure");
    fs.mkdirSync(appRoot, { mode: 0o700 });

    const runtime = resolveBundledClaudeStructuredRuntime({
      appRoot,
      cliScriptPath: bundle.cliScriptPath,
    });

    expect(runtime).toEqual({
      claudeCodeVersion: "2.1.234",
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      hostEntrypoint: fs.realpathSync(
        path.join(bundle.driverRoot, "shared-sdk-host-entrypoint.mjs"),
      ),
      nodeBin: fs.realpathSync(process.execPath),
      relayBin: fs.realpathSync(
        path.join(bundle.cliRoot, "dure-claude-process-relay"),
      ),
      runtimeRoot: fs.realpathSync(
        path.join(appRoot, "runtimes", "claude-code"),
      ),
      sdkVersion: "0.3.234",
    });
    expect(claudeStructuredRuntimeArguments(runtime)).toEqual([
      "--claude-node-bin",
      runtime.nodeBin,
      "--claude-host-entrypoint",
      runtime.hostEntrypoint,
      "--claude-relay-bin",
      runtime.relayBin,
      "--claude-runtime-root",
      runtime.runtimeRoot,
    ]);
    expect(fs.statSync(runtime.runtimeRoot).mode & 0o077).toBe(0);
  });

  it("compares runtime payloads independently of their install path", () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const firstBundle = writeBundle(firstRoot);
    const secondBundle = writeBundle(secondRoot);
    for (const root of [firstRoot, secondRoot]) {
      fs.mkdirSync(path.join(root, "dure"), { mode: 0o700 });
    }
    const first = resolveBundledClaudeStructuredRuntime({
      appRoot: path.join(firstRoot, "dure"),
      cliScriptPath: firstBundle.cliScriptPath,
    });
    const copied = resolveBundledClaudeStructuredRuntime({
      appRoot: path.join(secondRoot, "dure"),
      cliScriptPath: secondBundle.cliScriptPath,
    });
    expect(sameClaudeStructuredRuntimePayload(first, copied)).toBe(true);

    fs.appendFileSync(
      path.join(secondBundle.driverRoot, "runtime-helper.mjs"),
      "export const updated = true;\n",
    );
    const updated = resolveBundledClaudeStructuredRuntime({
      appRoot: path.join(secondRoot, "dure"),
      cliScriptPath: secondBundle.cliScriptPath,
    });
    expect(sameClaudeStructuredRuntimePayload(first, updated)).toBe(false);
    expect(sameClaudeStructuredRuntimePayload(null, null)).toBe(true);
    expect(sameClaudeStructuredRuntimePayload(first, null)).toBe(false);

    const relayUpdatedBundle = writeBundle(temporaryRoot());
    const relayUpdatedRoot = path.resolve(
      relayUpdatedBundle.cliRoot,
      "..",
      "..",
      "dure",
    );
    fs.mkdirSync(relayUpdatedRoot, { mode: 0o700 });
    fs.appendFileSync(
      path.join(relayUpdatedBundle.cliRoot, "dure-claude-process-relay"),
      "# updated\n",
    );
    const relayUpdated = resolveBundledClaudeStructuredRuntime({
      appRoot: relayUpdatedRoot,
      cliScriptPath: relayUpdatedBundle.cliScriptPath,
    });
    expect(sameClaudeStructuredRuntimePayload(first, relayUpdated)).toBe(false);
  });

  it("keeps source checkouts without a bundled driver terminal-only", () => {
    const root = temporaryRoot();
    const appRoot = path.join(root, "dure");
    const cliRoot = path.join(root, "source", "cli");
    fs.mkdirSync(appRoot, { mode: 0o700 });
    fs.mkdirSync(cliRoot, { recursive: true });

    expect(
      resolveBundledClaudeStructuredRuntime({
        appRoot,
        cliScriptPath: path.join(cliRoot, "dure.mjs"),
      }),
    ).toBeNull();
    expect(fs.existsSync(path.join(appRoot, "runtimes"))).toBe(false);
  });

  it("rejects a partially replaced provider payload", () => {
    const root = temporaryRoot();
    const appRoot = path.join(root, "dure");
    const cliRoot = path.join(root, "version", "bin");
    fs.mkdirSync(appRoot, { mode: 0o700 });
    fs.mkdirSync(cliRoot, { recursive: true });
    fs.writeFileSync(
      path.join(cliRoot, "dure-claude-process-relay"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );

    expect(() =>
      resolveBundledClaudeStructuredRuntime({
        appRoot,
        cliScriptPath: path.join(cliRoot, "dure.mjs"),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "claude_structured_runtime_bundle_invalid",
        reason: "payload_incomplete",
      }),
    );
  });

  it("rejects a Node generation that differs from the pinned driver", () => {
    const root = temporaryRoot();
    const bundle = writeBundle(root);
    const appRoot = path.join(root, "dure");
    fs.mkdirSync(appRoot, { mode: 0o700 });

    expect(() =>
      resolveBundledClaudeStructuredRuntime({
        appRoot,
        cliScriptPath: bundle.cliScriptPath,
        nodeVersion: "24.15.1",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "claude_structured_runtime_bundle_invalid",
        reason: "node_version_mismatch",
      }),
    );
  });

  it("rejects a provider executable replaced by a symlink", () => {
    const root = temporaryRoot();
    const bundle = writeBundle(root);
    const appRoot = path.join(root, "dure");
    const relay = path.join(bundle.cliRoot, "dure-claude-process-relay");
    const replacement = path.join(root, "replacement-relay");
    fs.mkdirSync(appRoot, { mode: 0o700 });
    fs.writeFileSync(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.rmSync(relay);
    fs.symlinkSync(replacement, relay);

    expect(() =>
      resolveBundledClaudeStructuredRuntime({
        appRoot,
        cliScriptPath: bundle.cliScriptPath,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "claude_structured_runtime_bundle_invalid",
        reason: "relay_invalid",
      }),
    );
  });

  it("uses a typed provider boundary error", () => {
    expect(new ClaudeStructuredRuntimeBundleError("fixture")).toMatchObject({
      code: "claude_structured_runtime_bundle_invalid",
      reason: "fixture",
    });
  });
});
