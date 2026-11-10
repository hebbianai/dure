import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  BETA_UPDATER_URL,
  planBetaMetadataUpdate,
  withLinuxPlatforms,
} from "./lib/beta-release-metadata.mjs";

test.each(["tauri.conf.json", "tauri.beta.conf.json"])(
  "%s consumes the feed maintained by public release publication",
  (filename) => {
    const config = JSON.parse(readFileSync(new URL(`../src-tauri/${filename}`, import.meta.url), "utf8"));
    expect(config.plugins.updater.endpoints).toEqual([BETA_UPDATER_URL]);
  },
);

const valid = {
  channel: "beta", version: "0.2.2", pub_date: "2026-09-08T00:00:00Z",
  platforms: { "darwin-aarch64": { signature: "signed-fixture", url: "https://github.com/hebbianai/hebbian-releases/releases/download/v0.2.2/Dure.app.tar.gz" } },
};

test("moves the existing beta feed to an immutable public-source release", () => {
  const prior = Buffer.from(JSON.stringify(valid));
  const sha = createHash("sha1").update(`blob ${prior.length}\0`).update(prior).digest("hex");
  const next = JSON.parse(JSON.stringify(valid).replaceAll("0.2.2", "0.2.29"));
  next.platforms["darwin-aarch64"].url = "https://github.com/hebbianai/dure/releases/download/v0.2.29/Dure.app.tar.gz";
  const bytes = Buffer.from(JSON.stringify(next));
  const previous = { type: "file", path: "beta/latest.json", encoding: "base64", content: prior.toString("base64"), sha };
  expect(planBetaMetadataUpdate({ tag: "v0.2.29", bytes, signature: "signed-fixture", previous })).toEqual({
    message: "Update Dure beta metadata to v0.2.29", branch: "main", content: bytes.toString("base64"), sha,
  });
});
test.each([
  ["version", { ...valid, version: "0.2.3" }],
  ["signature", { ...valid, platforms: { "darwin-aarch64": { ...valid.platforms["darwin-aarch64"], signature: "different" } } }],
  ["mutable URL", { ...valid, platforms: { "darwin-aarch64": { ...valid.platforms["darwin-aarch64"], url: "https://github.com/hebbianai/hebbian-releases/releases/latest/download/Dure.app.tar.gz" } } }],
  ["foreign URL", { ...valid, platforms: { "darwin-aarch64": { ...valid.platforms["darwin-aarch64"], url: "https://example.invalid/Dure.app.tar.gz" } } }],
  ["extra platform", { ...valid, platforms: { ...valid.platforms, "windows-x86_64": valid.platforms["darwin-aarch64"] } }],
  ["extra field", { ...valid, privateSource: "must not be copied" }],
  ["channel", { ...valid, channel: "stable" }],
])("rejects mismatched %s before planning a public metadata write", (_name, value) => {
  expect(() => planBetaMetadataUpdate({ tag: "v0.2.2", bytes: Buffer.from(JSON.stringify(value)), signature: "signed-fixture", previous: null })).toThrow();
});

test("conditional update uses the exact prior blob and rejects a substituted SHA", () => {
  const bytes = Buffer.from(JSON.stringify(valid));
  const prior = Buffer.from(JSON.stringify(valid).replaceAll("0.2.2", "0.2.1"));
  const sha = createHash("sha1").update(`blob ${prior.length}\0`).update(prior).digest("hex");
  const previous = { type: "file", path: "beta/latest.json", encoding: "base64", content: prior.toString("base64"), sha };
  expect(planBetaMetadataUpdate({ tag: "v0.2.2", bytes, signature: "signed-fixture", previous })).toEqual({ message: "Update Dure beta metadata to v0.2.2", branch: "main", content: bytes.toString("base64"), sha });
  expect(() => planBetaMetadataUpdate({ tag: "v0.2.2", bytes, signature: "signed-fixture", previous: { ...previous, sha: "f".repeat(40) } })).toThrow("beta_metadata_blob_mismatch");
});

const linuxRelease = (version) => ({
  channel: "beta", version, pub_date: "2026-11-10T00:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: "signed-fixture", url: `https://github.com/hebbianai/dure/releases/download/v${version}/Dure.app.tar.gz` },
  },
});

test("adds every Linux installer target to the feed and leaves the macOS entry unchanged", () => {
  const macos = Buffer.from(JSON.stringify(linuxRelease("0.2.63")));
  const merged = withLinuxPlatforms(macos, (file) => `signature of ${file}\n`);
  const value = JSON.parse(merged);
  expect(value.platforms).toEqual({
    "darwin-aarch64": linuxRelease("0.2.63").platforms["darwin-aarch64"],
    "linux-aarch64-appimage": { signature: "signature of Dure_0.2.63_aarch64.AppImage", url: "https://github.com/hebbianai/dure/releases/download/v0.2.63/Dure_0.2.63_aarch64.AppImage" },
    "linux-aarch64-deb": { signature: "signature of Dure_0.2.63_arm64.deb", url: "https://github.com/hebbianai/dure/releases/download/v0.2.63/Dure_0.2.63_arm64.deb" },
    "linux-x86_64-appimage": { signature: "signature of Dure_0.2.63_amd64.AppImage", url: "https://github.com/hebbianai/dure/releases/download/v0.2.63/Dure_0.2.63_amd64.AppImage" },
    "linux-x86_64-deb": { signature: "signature of Dure_0.2.63_amd64.deb", url: "https://github.com/hebbianai/dure/releases/download/v0.2.63/Dure_0.2.63_amd64.deb" },
  });
  expect(planBetaMetadataUpdate({ tag: "v0.2.63", bytes: merged, signature: "signed-fixture", previous: null })).toMatchObject({ content: merged.toString("base64") });
  // A newer Linux-carrying feed replaces a macOS-only one, never the reverse.
  const prior = Buffer.from(JSON.stringify(valid));
  const sha = createHash("sha1").update(`blob ${prior.length}\0`).update(prior).digest("hex");
  const previous = { type: "file", path: "beta/latest.json", encoding: "base64", content: prior.toString("base64"), sha };
  expect(planBetaMetadataUpdate({ tag: "v0.2.63", bytes: merged, signature: "signed-fixture", previous })).toMatchObject({ sha });
  expect(() => withLinuxPlatforms(merged, () => "again")).toThrow("beta_manifest_linux_already_present");
});

test.each([
  ["a partial Linux set", (value) => { delete value.platforms["linux-x86_64-deb"]; }],
  ["a Linux package outside the public source repository", (value) => {
    value.platforms["linux-aarch64-appimage"].url = value.platforms["linux-aarch64-appimage"].url.replace("/dure/", "/hebbian-releases/");
  }],
  ["a Linux package of another version", (value) => {
    value.platforms["linux-x86_64-appimage"].url = value.platforms["linux-x86_64-appimage"].url.replaceAll("0.2.63", "0.2.62");
  }],
  ["an empty Linux signature", (value) => { value.platforms["linux-aarch64-deb"].signature = " "; }],
  ["a generic Linux target", (value) => {
    value.platforms["linux-x86_64"] = value.platforms["linux-x86_64-appimage"];
  }],
])("rejects %s in the feed", (_name, change) => {
  const value = JSON.parse(withLinuxPlatforms(Buffer.from(JSON.stringify(linuxRelease("0.2.63"))), (file) => `signature of ${file}`));
  change(value);
  expect(() => planBetaMetadataUpdate({ tag: "v0.2.63", bytes: Buffer.from(JSON.stringify(value)), signature: "signed-fixture", previous: null })).toThrow("beta_manifest_invalid");
});
