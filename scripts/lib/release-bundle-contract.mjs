import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RELEASE_BUNDLE_IDENTITY = Object.freeze({
  app: "Dure.app",
  bundleIdentifier: "io.hebbian.ade",
  bundleName: "Dure",
  executable: "dure",
  signature: "Dure.app.tar.gz.sig",
  tarball: "Dure.app.tar.gz",
});

function matchingEntry(directory, predicate, kind) {
  const matches = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(predicate)
    .map((entry) => entry.name);
  if (matches.length !== 1) {
    throw new Error(
      `release_bundle_inventory_invalid: expected one ${kind}, found ${matches.length} (${matches.join(", ") || "none"})`,
    );
  }
  return matches[0];
}

function requireName(actual, expected, kind) {
  if (actual !== expected) {
    throw new Error(
      `release_bundle_identity_drift: expected ${kind} ${expected}, found ${actual}`,
    );
  }
}

function plistValue(infoPlist, key) {
  return execFileSync(
    "/usr/bin/env",
    ["plutil", "-extract", key, "raw", "-o", "-", infoPlist],
    { encoding: "utf8" },
  ).trim();
}

function requireMetadata(infoPlist, key, expected) {
  const actual = plistValue(infoPlist, key);
  if (actual !== expected) {
    throw new Error(
      `release_bundle_metadata_drift: expected ${key}=${expected}, found ${actual}`,
    );
  }
}

export function inspectReleaseBundle(bundleRoot) {
  const macosDirectory = path.join(bundleRoot, "macos");
  const dmgDirectory = path.join(bundleRoot, "dmg");
  const appName = matchingEntry(
    macosDirectory,
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
    "app bundle",
  );
  const tarballName = matchingEntry(
    macosDirectory,
    (entry) => entry.isFile() && entry.name.endsWith(".app.tar.gz"),
    "app tarball",
  );
  const signatureName = matchingEntry(
    macosDirectory,
    (entry) => entry.isFile() && entry.name.endsWith(".app.tar.gz.sig"),
    "updater signature",
  );
  const dmgName = matchingEntry(
    dmgDirectory,
    (entry) => entry.isFile() && entry.name.endsWith(".dmg"),
    "disk image",
  );

  requireName(appName, RELEASE_BUNDLE_IDENTITY.app, "app bundle");
  requireName(tarballName, RELEASE_BUNDLE_IDENTITY.tarball, "app tarball");
  requireName(signatureName, RELEASE_BUNDLE_IDENTITY.signature, "updater signature");
  if (!/^Dure_.+\.dmg$/.test(dmgName)) {
    throw new Error(
      `release_bundle_identity_drift: expected disk image Dure_*.dmg, found ${dmgName}`,
    );
  }

  const app = path.join(macosDirectory, appName);
  const infoPlist = path.join(app, "Contents", "Info.plist");
  requireMetadata(
    infoPlist,
    "CFBundleIdentifier",
    RELEASE_BUNDLE_IDENTITY.bundleIdentifier,
  );
  requireMetadata(
    infoPlist,
    "CFBundleExecutable",
    RELEASE_BUNDLE_IDENTITY.executable,
  );
  requireMetadata(
    infoPlist,
    "CFBundleName",
    RELEASE_BUNDLE_IDENTITY.bundleName,
  );

  const executable = path.join(
    app,
    "Contents",
    "MacOS",
    RELEASE_BUNDLE_IDENTITY.executable,
  );
  const fileDescription = execFileSync("/usr/bin/env", ["file", executable], {
    encoding: "utf8",
  });
  if (!/\bMach-O\b/.test(fileDescription)) {
    throw new Error(
      `release_bundle_executable_invalid: ${executable} is not Mach-O`,
    );
  }

  return Object.freeze({
    app,
    dmg: path.join(dmgDirectory, dmgName),
    executable,
    signature: path.join(macosDirectory, signatureName),
    tarball: path.join(macosDirectory, tarballName),
  });
}
