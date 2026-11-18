import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindBundledDureRuntime } from "../cli/lib/dure-cli-bundled-runtime.mjs";
import {
  artifactDigest,
  artifactFingerprint,
  parseMetadata,
  verificationCacheDirectory,
  writeArtifactManifest,
} from "../cli/lib/dure-cli-channel-launcher.mjs";

const temporaryDirectories = [];

afterEach(() => {
  vi.useRealTimers();
  forgetVerificationsInProcess();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Each launch is a new process; tests reuse one, so they forget between launches. */
function forgetVerificationsInProcess() {
  globalThis[Symbol.for("dure.cli.verifiedArtifacts")]?.clear();
}

/** A payload installed long enough ago that its timestamps are settled. */
function settledClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60_000);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function installedVersion() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-verification-"));
  temporaryDirectories.push(root);
  const versionRoot = path.join(root, "install", "versions", "0.1.4+fixture");
  const library = path.join(versionRoot, "bin", "lib");
  fs.mkdirSync(library, { recursive: true });
  const script = path.join(versionRoot, "bin", "dure.mjs");
  fs.writeFileSync(script, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(path.join(library, "session-query.mjs"), "export {};\n");
  const hmux = path.join(root, "hmux");
  fs.writeFileSync(hmux, "#!/bin/sh\n", { mode: 0o755 });
  writeArtifactManifest(versionRoot);
  const metadata = {
    schemaVersion: 3,
    buildId: "0.1.4+fixture",
    packageVersion: "0.1.4",
    sourceDigest: sha256("0.1.4+fixture"),
    command: "dure",
    controlPlaneCommand:
      process.platform === "win32" ? "dure-control-plane.exe" : "dure-control-plane",
    compatibilityCommands: ["hebbian-ade", "hebbian-ide"],
    bundle: {
      schemaVersion: 2,
      artifactDigest: artifactDigest(versionRoot),
      app: { schemaVersion: 1, channel: "stable" },
      controlPlane: { buildId: "dure-control-plane/v1-test" },
      orchestration: {},
      hmux: {
        schemaVersion: 1,
        channel: "stable",
        buildId: "hmux-test-v1",
        executablePath: hmux,
        executableDigest: sha256(fs.readFileSync(hmux)),
        runtimeExecutablePath: hmux,
        runtimeExecutableDigest: sha256(fs.readFileSync(hmux)),
      },
    },
  };
  const metadataPath = path.join(versionRoot, "install.json");
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
  return {
    cache: path.join(root, "cache"),
    home: path.join(root, "home"),
    hmux,
    metadata,
    metadataPath,
    script,
    versionRoot,
  };
}

function receipts(cache) {
  return fs.existsSync(cache) ? fs.readdirSync(cache) : [];
}

describe("installed CLI verification receipts", () => {
  it("reuses a recorded verification of the unchanged payload instead of hashing it", () => {
    const version = installedVersion();
    settledClock();
    expect(parseMetadata(version.versionRoot, { verificationCache: version.cache }))
      .toEqual(version.metadata);
    const [name] = receipts(version.cache);
    expect(receipts(version.cache)).toEqual([name]);

    // A receipt that matches the payload's current metadata stands for its
    // content: a launch with the receipt does not read the changed bytes.
    fs.appendFileSync(version.script, "// changed\n");
    const receiptPath = path.join(version.cache, name);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.fingerprint = artifactFingerprint(version.versionRoot, [
      version.hmux,
      version.hmux,
    ]).fingerprint;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    forgetVerificationsInProcess();

    expect(parseMetadata(version.versionRoot, { verificationCache: version.cache }))
      .toEqual(version.metadata);
    expect(() => parseMetadata(version.versionRoot))
      .toThrow("immutable bundle digest does not match");
  });

  it("verifies the content again after a payload entry changes, appears or the Hmux executable changes", () => {
    const version = installedVersion();
    settledClock();
    const parse = () => {
      forgetVerificationsInProcess();
      return parseMetadata(version.versionRoot, { verificationCache: version.cache });
    };
    parse();
    expect(receipts(version.cache)).toHaveLength(1);

    const original = fs.readFileSync(version.script);
    fs.appendFileSync(version.script, "// changed\n");
    expect(parse).toThrow(/changed after installation \(changed: bin\/dure\.mjs\)/);
    fs.writeFileSync(version.script, original);
    expect(parse()).toEqual(version.metadata);

    const unexpected = path.join(version.versionRoot, "bin", "lib", "node_modules");
    fs.mkdirSync(unexpected);
    expect(parse).toThrow(/unexpected: bin\/lib\/node_modules/);
    fs.rmdirSync(unexpected);
    expect(parse()).toEqual(version.metadata);

    fs.appendFileSync(version.hmux, "# changed\n");
    expect(parse).toThrow("Hmux bundle digest does not match");
  });

  it("does not let a receipt vouch for different install metadata", () => {
    const version = installedVersion();
    settledClock();
    parseMetadata(version.versionRoot, { verificationCache: version.cache });
    forgetVerificationsInProcess();

    fs.writeFileSync(
      version.metadataPath,
      `${JSON.stringify({
        ...version.metadata,
        bundle: { ...version.metadata.bundle, artifactDigest: "0".repeat(64) },
      })}\n`,
    );
    expect(() => parseMetadata(version.versionRoot, { verificationCache: version.cache }))
      .toThrow("immutable bundle digest does not match");
  });

  it("does not record a payload that changed moments ago", () => {
    const version = installedVersion();
    expect(parseMetadata(version.versionRoot, { verificationCache: version.cache }))
      .toEqual(version.metadata);
    expect(receipts(version.cache)).toEqual([]);
  });

  it("verifies in full when the receipt cannot be written", () => {
    const version = installedVersion();
    settledClock();
    fs.writeFileSync(version.cache, "not a directory");
    expect(parseMetadata(version.versionRoot, { verificationCache: version.cache }))
      .toEqual(version.metadata);
    forgetVerificationsInProcess();
    fs.appendFileSync(version.script, "// changed\n");
    expect(() => parseMetadata(version.versionRoot, { verificationCache: version.cache }))
      .toThrow("immutable bundle digest does not match");
  });

  it("binds the bundled runtime through the caller's per-user cache", () => {
    const version = installedVersion();
    settledClock();
    const environment = { HOME: version.home, LOCALAPPDATA: version.home };
    bindBundledDureRuntime(version.script, environment);
    expect(environment.DURE_HMUX_BIN).toBe(version.hmux);
    expect(receipts(verificationCacheDirectory(environment))).toHaveLength(1);
  });

  it("keeps receipts in the per-user cache directory", () => {
    const home = path.resolve("/home/fixture");
    const expected = {
      darwin: path.join(home, "Library", "Caches", "Dure", "cli-verification"),
      win32: path.join(home, "AppData", "Local", "Dure", "cli-verification"),
    }[process.platform] ?? path.join(home, ".cache", "dure", "cli-verification");
    expect(verificationCacheDirectory({
      HOME: home,
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    })).toBe(expected);
    expect(verificationCacheDirectory({ HOME: "relative", LOCALAPPDATA: "relative" }))
      .toBeNull();
    expect(verificationCacheDirectory({})).toBeNull();
    if (!["darwin", "win32"].includes(process.platform)) {
      const cache = path.resolve("/xdg-cache");
      expect(verificationCacheDirectory({ HOME: home, XDG_CACHE_HOME: cache }))
        .toBe(path.join(cache, "dure", "cli-verification"));
    }
  });
});
