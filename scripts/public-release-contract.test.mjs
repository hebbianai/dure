import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  expectedVersionFiles,
  inspectReleaseFiles,
  missingReleaseAssets,
  releaseAdmission,
  releaseVersion,
  verifyUpdaterSignature,
} from "./lib/public-release-contract.mjs";
import { RELEASE_CARGO_WORKSPACES } from "./lib/release-candidate.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const admitted = {
  repository: "hebbianai/dure",
  event: "workflow_dispatch",
  ref: "refs/heads/main",
  source: "a".repeat(40),
  head: "a".repeat(40),
  current: "0.2.28",
  bumpKind: "patch",
  verification: "full",
};

test("selects an exact public source and separates emergency beta from full verification", () => {
  expect(releaseAdmission(admitted)).toMatchObject({
    sourceSha: admitted.source,
    version: "0.2.29",
    channel: "beta",
    verification: "full",
  });
  expect(
    releaseAdmission({ ...admitted, verification: "emergency-0.2" })
      .verification,
  ).toBe("emergency-0.2");
  expect(releaseAdmission({ ...admitted, bumpKind: "minor" })).toMatchObject({
    version: "0.3.0",
    verification: "full",
  });
});

test.each([
  { repository: "example/fork" },
  { event: "pull_request" },
  { ref: "refs/heads/topic" },
  { source: "b".repeat(40) },
  { source: "HEAD" },
  { bumpKind: "major" },
  { verification: "skip" },
  { current: "0.2.26" },
  { current: "0.2.27" },
  { bumpKind: "minor", verification: "emergency-0.2" },
])("refuses unauthorized or reserved release input %j", (change) => {
  expect(() => releaseAdmission({ ...admitted, ...change })).toThrow();
});

test.each([
  "v0.2.28",
  "v0.1.99",
  "v0.2.029",
  "v0.2.29-beta",
  "v0.2.29\n",
  "v0.2.9007199254740992",
])("rejects invalid or historically reserved tag %s", (tag) => {
  expect(() => releaseVersion(tag)).toThrow();
});

test("reconstructs only the five manifest fields and existing local lock versions", () => {
  const originals = new Map([
    ["package.json", '{"version":"0.2.28","preserve":true}\n'],
    ["cli/package.json", '{"version":"0.2.28","preserve":true}\n'],
    ["src-tauri/tauri.conf.json", '{"version":"0.2.28","preserve":true}\n'],
    ["src-tauri/Cargo.toml", '[package]\nname = "dure"\nversion = "0.2.28"\n'],
    ["hmux/Cargo.toml", '[workspace.package]\nversion = "0.2.28"\n'],
    ...RELEASE_CARGO_WORKSPACES.map((workspace) => [
      workspace.lockPath,
      workspace.versionedPackages
        .map((name) => `[[package]]\nname = "${name}"\nversion = "0.2.28"\n\n`)
        .join("") +
        '[[package]]\nname = "third-party"\nversion = "0.2.28"\nsource = "registry+fixture"\n',
    ]),
  ]);
  const expected = expectedVersionFiles(
    (file) => originals.get(file),
    "0.2.28",
    "0.2.29",
  );
  expect(expected.size).toBe(9);
  expect(expected.get("package.json")).toBe(
    '{"version":"0.2.29","preserve":true}\n',
  );
  for (const workspace of RELEASE_CARGO_WORKSPACES) {
    expect(expected.get(workspace.lockPath)).toContain(
      'name = "third-party"\nversion = "0.2.28"',
    );
  }
  expect(() =>
    expectedVersionFiles((file) => originals.get(file), "0.2.27", "0.2.29"),
  ).toThrow();
});

function signedFiles() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "dure-release-signature-"),
  );
  roots.push(root);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0102030405060708", "hex");
  const rawKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const key = Buffer.from(
    `untrusted comment: test key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`,
  ).toString("base64");
  const archive = Buffer.from("test archive, not a native bundle");
  const signature = sign(
    null,
    createHash("blake2b512").update(archive).digest(),
    privateKey,
  );
  const comment = "timestamp:1\tfile:Dure.app.tar.gz";
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    privateKey,
  );
  const text = `untrusted comment: fixture\n${Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  const encoded = Buffer.from(text).toString("base64");
  fs.writeFileSync(path.join(root, "Dure.app.tar.gz"), archive);
  fs.writeFileSync(path.join(root, "Dure.app.tar.gz.sig"), encoded);
  fs.writeFileSync(path.join(root, "Dure_0.2.29_aarch64.dmg"), "test image");
  const manifest = {
    channel: "beta",
    version: "0.2.29",
    pub_date: "2026-09-18T00:00:00Z",
    platforms: {
      "darwin-aarch64": {
        signature: encoded,
        url: "https://github.com/hebbianai/dure/releases/download/v0.2.29/Dure.app.tar.gz",
      },
    },
  };
  fs.writeFileSync(path.join(root, "latest.json"), JSON.stringify(manifest));
  return { root, key, encoded, text, manifest };
}

test("binds all four files to the exact-tag updater key and immutable public URL", () => {
  const fixture = signedFiles();
  expect(
    inspectReleaseFiles(fixture.root, "v0.2.29", fixture.key).assets,
  ).toHaveLength(4);
  fs.writeFileSync(
    path.join(fixture.root, "Dure.app.tar.gz"),
    "changed archive",
  );
  expect(() =>
    inspectReleaseFiles(fixture.root, "v0.2.29", fixture.key),
  ).toThrow("release_updater_signature_invalid");
});

test("rejects changed trusted comments and a different key", () => {
  const fixture = signedFiles();
  const file = path.join(fixture.root, "Dure.app.tar.gz");
  expect(() =>
    verifyUpdaterSignature(
      file,
      fixture.key,
      Buffer.from(fixture.text.replace("timestamp:1", "timestamp:2")).toString(
        "base64",
      ),
    ),
  ).toThrow("release_updater_signature_invalid");
  expect(() =>
    verifyUpdaterSignature(file, signedFiles().key, fixture.encoded),
  ).toThrow("release_updater_signature_invalid");
});

test("accepts the independent minisign prehash conformance vector", () => {
  const fixture = signedFiles();
  const file = path.join(fixture.root, "vector");
  fs.writeFileSync(file, "test");
  const key =
    "untrusted comment: fixture\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
  const signature =
    "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
  expect(() =>
    verifyUpdaterSignature(
      file,
      Buffer.from(key).toString("base64"),
      Buffer.from(signature).toString("base64"),
    ),
  ).not.toThrow();
});

test.each([
  "extra",
  "symlink",
  "wrong repository",
  "wrong version",
  "wrong signature",
])("refuses %s in the release payload", (kind) => {
  const fixture = signedFiles();
  if (kind === "extra")
    fs.writeFileSync(path.join(fixture.root, "unreviewed"), "extra");
  if (kind === "symlink") {
    const image = path.join(fixture.root, "Dure_0.2.29_aarch64.dmg");
    fs.unlinkSync(image);
    fs.symlinkSync("Dure.app.tar.gz", image);
  }
  if (kind === "wrong repository")
    fixture.manifest.platforms["darwin-aarch64"].url =
      fixture.manifest.platforms["darwin-aarch64"].url.replace(
        "/dure/",
        "/hebbian-releases/",
      );
  if (kind === "wrong version") fixture.manifest.version = "0.2.30";
  if (kind === "wrong signature")
    fixture.manifest.platforms["darwin-aarch64"].signature = "other";
  fs.writeFileSync(
    path.join(fixture.root, "latest.json"),
    JSON.stringify(fixture.manifest),
  );
  expect(() =>
    inspectReleaseFiles(fixture.root, "v0.2.29", fixture.key),
  ).toThrow();
});

test("returns only missing files, refusing duplicate, changed, incomplete or unknown assets", () => {
  const expected = [
    { name: "a", size: 5, digest: "sha256:a" },
    { name: "b", size: 6, digest: "sha256:b" },
  ];
  const uploaded = { ...expected[0], state: "uploaded" };
  expect(missingReleaseAssets(expected, [uploaded])).toEqual([expected[1]]);
  expect(() =>
    missingReleaseAssets(expected, [uploaded], { complete: true }),
  ).toThrow("release_assets_incomplete");
  for (const remote of [
    [uploaded, uploaded],
    [{ ...uploaded, digest: "sha256:other" }],
    [{ ...uploaded, state: "starter" }],
    [{ ...uploaded, name: "unknown" }],
  ]) {
    expect(() => missingReleaseAssets(expected, remote)).toThrow();
  }
});
