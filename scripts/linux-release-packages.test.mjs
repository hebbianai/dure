import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { collectLinuxPackages, repairAppImage, signLinuxPackages } from "./linux-release-packages.mjs";

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

const elf = (label) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(` ${label}`)]);

function patchedBundle() {
  const root = checkout();
  const put = (relative, bytes) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), bytes);
  };
  const remote = "hmux-remote/x86_64-unknown-linux-musl";
  put("src-tauri/binaries/hmux-runtime-x86_64-unknown-linux-gnu", elf("runtime"));
  put("src-tauri/binaries/hmux-x86_64-unknown-linux-gnu", elf("cli"));
  put("src-tauri/binaries/README.md", "not bundled");
  put(`src-tauri/resources/${remote}/bin/hmux-runtime`, elf("remote runtime"));
  put(`src-tauri/resources/${remote}/install.json`, "{}\n");
  put("src-tauri/resources/mobile-runtime/serve-sim-native.dylib", elf("not bundled on Linux"));
  const appDir = "bundle/appimage/Dure.AppDir";
  // linuxdeploy rewrote two executables and left the CLI and data alone.
  put(`${appDir}/usr/bin/hmux-runtime`, Buffer.concat([elf("runtime"), Buffer.from(" rpath")]));
  put(`${appDir}/usr/bin/hmux`, elf("cli"));
  put(`${appDir}/usr/bin/dure`, elf("app, linked against bundled libraries"));
  put(`${appDir}/usr/lib/Dure/resources/${remote}/bin/hmux-runtime`, Buffer.concat([elf("remote runtime"), Buffer.from(" rpath")]));
  put(`${appDir}/usr/lib/Dure/resources/${remote}/install.json`, "{}\n");
  put("bundle/appimage/Dure_0.2.63_amd64.AppImage", "patched image");
  return { root, bundleRoot: path.join(root, "bundle"), appDir: path.join(root, appDir) };
}

/** A stand-in AppImage: the repacked image is a copy of the AppDir tree. */
const imageOf = (appDir) => ({
  repack(directory, output) {
    expect(directory).toBe(appDir);
    fs.cpSync(directory, `${output}.tree`, { recursive: true });
    fs.writeFileSync(output, "repacked image");
  },
  extract(image, scratch) {
    fs.cpSync(`${image}.tree`, path.join(scratch, "squashfs-root"), { recursive: true });
    fs.rmSync(`${image}.tree`, { recursive: true });
    return path.join(scratch, "squashfs-root");
  },
});

test("restores the exact bundled executables linuxdeploy rewrote and repacks the AppImage", () => {
  const value = patchedBundle();
  const restored = repairAppImage({ root: value.root, bundleRoot: value.bundleRoot, arch: "x86_64", ...imageOf(value.appDir) });
  expect(restored).toEqual([
    "usr/bin/hmux-runtime",
    "usr/lib/Dure/resources/hmux-remote/x86_64-unknown-linux-musl/bin/hmux-runtime",
  ]);
  expect(fs.readFileSync(path.join(value.appDir, "usr/bin/hmux-runtime"))).toEqual(elf("runtime"));
  expect(fs.statSync(path.join(value.appDir, "usr/bin/hmux-runtime")).mode & 0o777).toBe(0o755);
  expect(fs.readFileSync(path.join(value.appDir, "usr/bin/dure"))).toEqual(elf("app, linked against bundled libraries"));
  expect(fs.readFileSync(path.join(value.bundleRoot, "appimage/Dure_0.2.63_amd64.AppImage"), "utf8")).toBe("repacked image");
  expect(fs.readdirSync(path.join(value.bundleRoot, "appimage")).sort()).toEqual(["Dure.AppDir", "Dure_0.2.63_amd64.AppImage"]);
  // A second run finds nothing to restore and leaves the image alone.
  expect(repairAppImage({
    root: value.root, bundleRoot: value.bundleRoot, arch: "x86_64",
    repack: () => { throw new Error("must not repack"); },
  })).toEqual([]);
});

test("keeps the original AppImage when the repacked one does not hold the source bytes", () => {
  const value = patchedBundle();
  const image = imageOf(value.appDir);
  expect(() => repairAppImage({
    root: value.root,
    bundleRoot: value.bundleRoot,
    arch: "x86_64",
    repack: image.repack,
    extract(repacked, scratch) {
      const tree = image.extract(repacked, scratch);
      fs.appendFileSync(path.join(tree, "usr/bin/hmux-runtime"), " rpath again");
      return tree;
    },
  })).toThrow("the repacked AppImage changed usr/bin/hmux-runtime");
  expect(fs.readFileSync(path.join(value.bundleRoot, "appimage/Dure_0.2.63_amd64.AppImage"), "utf8")).toBe("patched image");
});

test("refuses an AppDir without the bundled Hmux runtime", () => {
  const value = patchedBundle();
  fs.rmSync(path.join(value.appDir, "usr/bin/hmux-runtime"));
  expect(() => repairAppImage({ root: value.root, bundleRoot: value.bundleRoot, arch: "x86_64", ...imageOf(value.appDir) }))
    .toThrow("no bundled hmux-runtime");
});
