#!/usr/bin/env node
// Write the Homebrew cask for a published release. Usage:
//   node scripts/update-homebrew-cask.mjs <github-release.json> <cask.rb>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comparePackageVersions } from "../cli/lib/package-version.mjs";
import { releaseVersion } from "./lib/public-release-contract.mjs";

export function caskInputFromRelease(release) {
  if (release?.draft !== false) throw new Error("homebrew_cask_release_not_published");
  const version = releaseVersion(release.tag_name);
  const name = `Dure_${version}_aarch64.dmg`;
  const assets = (release.assets ?? []).filter((asset) => asset.name === name);
  if (assets.length !== 1) throw new Error("homebrew_cask_dmg_missing");
  const digest = /^sha256:([0-9a-f]{64})$/.exec(assets[0].digest ?? "");
  if (!digest) throw new Error("homebrew_cask_digest_missing");
  return { version, sha256: digest[1] };
}

export function renderCask({ version, sha256 }) {
  return `cask "dure" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/hebbianai/dure/releases/download/v#{version}/Dure_#{version}_aarch64.dmg"
  name "Dure"
  desc "Workspace for AI coding agents"
  homepage "https://www.dureai.dev/"

  auto_updates true
  depends_on arch: :arm64
  depends_on :macos

  app "Dure.app"
end
`;
}

function versionInCask(cask) {
  return /^\s*version "([^"]+)"$/m.exec(cask)?.[1];
}

function readExisting(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Events can arrive out of order, so an older release never replaces a newer cask. */
export function updateCask(release, caskPath) {
  const input = caskInputFromRelease(release);
  const existing = readExisting(caskPath);
  const current = existing === undefined ? undefined : versionInCask(existing);
  if (existing !== undefined && current === undefined) {
    throw new Error("homebrew_cask_existing_version_unreadable");
  }
  if (current !== undefined) {
    const order = comparePackageVersions(input.version, current);
    if (order === null) throw new Error("homebrew_cask_versions_incomparable");
    if (order < 0) return { written: false, version: current };
  }
  mkdirSync(dirname(caskPath), { recursive: true });
  writeFileSync(caskPath, renderCask(input));
  return { written: true, version: input.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("Usage: update-homebrew-cask.mjs <github-release.json> <cask.rb>");
    process.exitCode = 2;
  } else {
    try {
      const release = JSON.parse(readFileSync(args[0], "utf8"));
      const result = updateCask(release, args[1]);
      console.log(
        result.written
          ? `Cask set to ${result.version}`
          : `Cask stays at newer version ${result.version}`,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
