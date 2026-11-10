import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { collectLinuxPackages, signLinuxPackages } from "./linux-release-packages.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function updaterKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = Buffer.from("0102030405060708", "hex");
  const pubkey = Buffer.from(
    `untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]).toString("base64")}\n`,
  ).toString("base64");
  // The Tauri CLI's output shape: base64 of a prehashed minisign signature.
  const signFile = (_root, file) => {
    const prehashed = sign(null, createHash("blake2b512").update(fs.readFileSync(file)).digest(), privateKey);
    const trusted = `timestamp:1\tfile:${path.basename(file)}`;
    const comment = sign(null, Buffer.concat([prehashed, Buffer.from(trusted)]), privateKey);
    fs.writeFileSync(`${file}.sig`, Buffer.from(
      `untrusted comment: fixture\n${Buffer.concat([Buffer.from("ED"), id, prehashed]).toString("base64")}\ntrusted comment: ${trusted}\n${comment.toString("base64")}\n`,
    ).toString("base64"));
  };
  return { pubkey, signFile };
}

function checkout(pubkey = "unused") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-linux-packages-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src-tauri"));
  fs.writeFileSync(
    path.join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({ version: "0.2.63", plugins: { updater: { pubkey } } }),
  );
  return root;
}

function bundle(root, files) {
  for (const [directory, name] of files) {
    fs.mkdirSync(path.join(root, "bundle", directory), { recursive: true });
    fs.writeFileSync(path.join(root, "bundle", directory, name), `package ${name}`);
  }
  return path.join(root, "bundle");
}

test.each([
  ["x86_64", "Dure_0.2.63_amd64.AppImage", "Dure_0.2.63_amd64.deb"],
  ["aarch64", "Dure_0.2.63_aarch64.AppImage", "Dure_0.2.63_arm64.deb"],
])("collects exactly this version's %s AppImage and Debian package", (arch, appimage, deb) => {
  const root = checkout();
  const bundleRoot = bundle(root, [["appimage", appimage], ["deb", deb]]);
  const output = collectLinuxPackages({ root, bundleRoot, arch, output: path.join(root, "out") });
  expect(fs.readdirSync(output).sort()).toEqual([appimage, deb].sort());
  expect(fs.readFileSync(path.join(output, deb), "utf8")).toBe(`package ${deb}`);
});

test.each([
  ["a stale version beside the new one", [["appimage", "Dure_0.2.62_amd64.AppImage"]]],
  ["the other architecture's name", [["deb", "Dure_0.2.63_arm64.deb"]]],
])("refuses %s", (_name, extra) => {
  const root = checkout();
  const bundleRoot = bundle(root, [
    ["appimage", "Dure_0.2.63_amd64.AppImage"],
    ["deb", "Dure_0.2.63_amd64.deb"],
    ...extra,
  ]);
  expect(() => collectLinuxPackages({ root, bundleRoot, arch: "x86_64", output: path.join(root, "out") }))
    .toThrow("expected exactly");
  expect(() => collectLinuxPackages({ root, bundleRoot, arch: "riscv64", output: path.join(root, "out") }))
    .toThrow("unknown Linux release architecture");
});

const PACKAGES = [
  "Dure_0.2.63_aarch64.AppImage",
  "Dure_0.2.63_amd64.AppImage",
  "Dure_0.2.63_amd64.deb",
  "Dure_0.2.63_arm64.deb",
];

function packages(root, names = PACKAGES) {
  const input = path.join(root, "packages");
  fs.mkdirSync(input);
  for (const name of names) fs.writeFileSync(path.join(input, name), `package ${name}`);
  return input;
}

test("signs every Linux package and checks each signature against this commit's updater key", () => {
  const key = updaterKey();
  const root = checkout(key.pubkey);
  const signed = [];
  const output = signLinuxPackages({
    root,
    input: packages(root),
    output: path.join(root, "signed"),
    sign: (repository, file) => {
      signed.push(path.basename(file));
      key.signFile(repository, file);
    },
  });
  expect(signed.sort()).toEqual(PACKAGES);
  expect(fs.readdirSync(output).sort()).toEqual(PACKAGES.flatMap((name) => [name, `${name}.sig`]).sort());
  expect(fs.readFileSync(path.join(output, PACKAGES[0]), "utf8")).toBe(`package ${PACKAGES[0]}`);
});

test("refuses a signature from another key and an incomplete package set", () => {
  const root = checkout(updaterKey().pubkey);
  const other = updaterKey();
  expect(() => signLinuxPackages({
    root, input: packages(root), output: path.join(root, "signed"), sign: other.signFile,
  })).toThrow("release_updater_signature_invalid");
  const partial = checkout(other.pubkey);
  expect(() => signLinuxPackages({
    root: partial, input: packages(partial, PACKAGES.slice(1)), output: path.join(partial, "signed"), sign: other.signFile,
  })).toThrow("must be exactly");
});
