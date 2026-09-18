import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { planBetaMetadataUpdate } from "./lib/beta-release-metadata.mjs";

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
