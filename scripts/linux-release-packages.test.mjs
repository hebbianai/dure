import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  collectLinuxPackages,
  finishAppImage,
  finishDeb,
  signLinuxPackages,
  stagedDureCli,
} from "./linux-release-packages.mjs";

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
    JSON.stringify({ productName: "Dure", version: "0.2.63", plugins: { updater: { pubkey } } }),
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
/** An ELF header with this e_machine (62 x86_64, 183 aarch64). */
const executable = (machine, label) => {
  const header = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header.writeUInt16LE(machine, 18);
  return Buffer.concat([header, Buffer.from(label)]);
};

/** The layout stage-dure-cli.mjs writes: one version behind a relative `current`. */
function stageCli(root, machine = 62) {
  const payload = path.join(root, "src-tauri/resources/dure-cli");
  const bin = path.join(payload, "versions/0.2.63+fixture/bin");
  fs.mkdirSync(path.join(bin, "lib"), { recursive: true });
  for (const name of ["node", "dure-control-plane", "dure-claude-process-relay", "hmux", "hmux-runtime"]) {
    fs.writeFileSync(path.join(bin, name), executable(machine, name));
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.writeFileSync(path.join(bin, "dure.mjs"), "#!/bin/sh\n");
  fs.chmodSync(path.join(bin, "dure.mjs"), 0o700);
  fs.symlinkSync("dure.mjs", path.join(bin, "dure"));
  // Staged under a restrictive umask: owner-only data and directories.
  fs.writeFileSync(path.join(bin, "lib/dure-cli-bootstrap.mjs"), "export {};\n");
  fs.chmodSync(path.join(bin, "lib/dure-cli-bootstrap.mjs"), 0o600);
  fs.chmodSync(path.join(bin, "lib"), 0o700);
  fs.writeFileSync(path.join(payload, "versions/0.2.63+fixture/install.json"), "{}\n");
  fs.symlinkSync("versions/0.2.63+fixture", path.join(payload, "current"));
  return payload;
}

/** Entries below a directory without following links, with their modes. */
function listing(directory, prefix = "") {
  return fs.readdirSync(path.join(directory, prefix)).sort().flatMap((name) => {
    const relative = path.join(prefix, name);
    const stat = fs.lstatSync(path.join(directory, relative));
    if (stat.isSymbolicLink()) return [`${relative} -> ${fs.readlinkSync(path.join(directory, relative))}`];
    const mode = (stat.mode & 0o777).toString(8);
    if (stat.isDirectory()) return [`${relative}/ ${mode}`, ...listing(directory, relative)];
    return [`${relative} ${mode} ${fs.statSync(path.join(directory, relative)).size}`];
  });
}

const PACKAGED_CLI = [
  "current -> versions/0.2.63+fixture",
  "versions/ 755",
  "versions/0.2.63+fixture/ 755",
  "versions/0.2.63+fixture/bin/ 755",
  "versions/0.2.63+fixture/bin/dure -> dure.mjs",
  "versions/0.2.63+fixture/bin/dure-claude-process-relay 755 45",
  "versions/0.2.63+fixture/bin/dure-control-plane 755 38",
  "versions/0.2.63+fixture/bin/dure.mjs 755 10",
  "versions/0.2.63+fixture/bin/hmux 755 24",
  "versions/0.2.63+fixture/bin/hmux-runtime 755 32",
  "versions/0.2.63+fixture/bin/lib/ 755",
  "versions/0.2.63+fixture/bin/lib/dure-cli-bootstrap.mjs 644 11",
  "versions/0.2.63+fixture/bin/node 755 24",
  "versions/0.2.63+fixture/install.json 644 3",
];

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
  stageCli(root);
  return { root, bundleRoot: path.join(root, "bundle"), appDir: path.join(root, appDir) };
}

/** A stand-in AppImage: the repacked image is a copy of the AppDir tree, links included. */
const imageOf = (appDir) => ({
  repack(directory, output) {
    expect(directory).toBe(appDir);
    execFileSync("cp", ["-pR", directory, `${output}.tree`]);
    fs.writeFileSync(output, "repacked image");
  },
  extract(image, scratch) {
    execFileSync("cp", ["-pR", `${image}.tree`, path.join(scratch, "squashfs-root")]);
    fs.rmSync(`${image}.tree`, { recursive: true });
    return path.join(scratch, "squashfs-root");
  },
});

test("restores the exact bundled executables linuxdeploy rewrote, adds the Dure CLI and repacks the AppImage", () => {
  const value = patchedBundle();
  const { restored, addedDureCli } = finishAppImage({ root: value.root, bundleRoot: value.bundleRoot, arch: "x86_64", ...imageOf(value.appDir) });
  expect(restored).toEqual([
    "usr/bin/hmux-runtime",
    "usr/lib/Dure/resources/hmux-remote/x86_64-unknown-linux-musl/bin/hmux-runtime",
  ]);
  expect(addedDureCli).toBe(true);
  // The payload keeps its links and gets package modes for every user.
  const cli = path.join(value.appDir, "usr/lib/Dure/resources/dure-cli");
  expect(listing(cli)).toEqual(PACKAGED_CLI);
  expect(fs.readFileSync(path.join(value.appDir, "usr/bin/hmux-runtime"))).toEqual(elf("runtime"));
  expect(fs.statSync(path.join(value.appDir, "usr/bin/hmux-runtime")).mode & 0o777).toBe(0o755);
  expect(fs.readFileSync(path.join(value.appDir, "usr/bin/dure"))).toEqual(elf("app, linked against bundled libraries"));
  expect(fs.readFileSync(path.join(value.bundleRoot, "appimage/Dure_0.2.63_amd64.AppImage"), "utf8")).toBe("repacked image");
  expect(fs.readdirSync(path.join(value.bundleRoot, "appimage")).sort()).toEqual(["Dure.AppDir", "Dure_0.2.63_amd64.AppImage"]);
  // A second run finds nothing to restore or add and leaves the image alone.
  expect(finishAppImage({
    root: value.root, bundleRoot: value.bundleRoot, arch: "x86_64",
    repack: () => { throw new Error("must not repack"); },
  })).toEqual({ restored: [], addedDureCli: false });
  // An AppDir holding another payload is refused.
  fs.appendFileSync(path.join(cli, "current/install.json"), " ");
  expect(() => finishAppImage({ root: value.root, bundleRoot: value.bundleRoot, arch: "x86_64" }))
    .toThrow("holds a different Dure CLI payload");
});

test("refuses an unstaged Dure CLI or one built for the other architecture", () => {
  const root = checkout();
  expect(() => stagedDureCli(root, "x86_64")).toThrow("the Dure CLI payload is not staged");
  stageCli(root, 183);
  expect(stagedDureCli(root, "aarch64").buildId).toBe("0.2.63+fixture");
  expect(() => stagedDureCli(root, "x86_64")).toThrow("the staged Dure CLI node is not an x86_64 executable");
});

test("checks the Dure CLI payload in the repacked AppImage", () => {
  const value = patchedBundle();
  const image = imageOf(value.appDir);
  expect(() => finishAppImage({
    root: value.root,
    bundleRoot: value.bundleRoot,
    arch: "x86_64",
    repack: image.repack,
    extract(repacked, scratch) {
      const tree = image.extract(repacked, scratch);
      const link = path.join(tree, "usr/lib/Dure/resources/dure-cli/current/bin/dure");
      fs.rmSync(link);
      fs.copyFileSync(path.join(path.dirname(link), "dure.mjs"), link);
      return tree;
    },
  })).toThrow("the repacked AppImage does not hold the staged Dure CLI payload");
});

const dpkgDeb = spawnSync("dpkg-deb", ["--version"]).status === 0;

test.skipIf(!dpkgDeb)("adds the Dure CLI to the Debian package with its links, modes and checksums", () => {
  const root = checkout();
  stageCli(root);
  // A package shaped like Tauri's: resources below usr/lib/<product>.
  const tree = path.join(root, "tree");
  fs.mkdirSync(path.join(tree, "DEBIAN"), { recursive: true });
  fs.mkdirSync(path.join(tree, "usr/lib/Dure/resources/hmux-remote"), { recursive: true });
  fs.mkdirSync(path.join(tree, "usr/bin"), { recursive: true });
  fs.writeFileSync(path.join(tree, "usr/bin/dure"), "app\n", { mode: 0o755 });
  fs.writeFileSync(path.join(tree, "usr/lib/Dure/resources/hmux-remote/install.json"), "{}\n");
  fs.writeFileSync(path.join(tree, "DEBIAN/control"), [
    "Package: dure", "Version: 0.2.63", "Architecture: amd64", "Installed-Size: 10",
    "Maintainer: fixture", "Description: fixture", "",
  ].join("\n"));
  fs.writeFileSync(path.join(tree, "DEBIAN/md5sums"), `${createHash("md5").update("app\n").digest("hex")}  usr/bin/dure\n`);
  const bundleRoot = path.join(root, "bundle");
  fs.mkdirSync(path.join(bundleRoot, "deb"), { recursive: true });
  const deb = path.join(bundleRoot, "deb/Dure_0.2.63_amd64.deb");
  execFileSync("dpkg-deb", ["--root-owner-group", "--build", tree, deb], { stdio: "ignore" });

  expect(finishDeb({ root, bundleRoot, arch: "x86_64" })).toBe(true);
  const unpacked = path.join(root, "unpacked");
  execFileSync("dpkg-deb", ["--raw-extract", deb, unpacked]);
  const cli = path.join(unpacked, "usr/lib/Dure/resources/dure-cli");
  expect(listing(cli)).toEqual(PACKAGED_CLI);
  expect(fs.readFileSync(path.join(unpacked, "usr/bin/dure"), "utf8")).toBe("app\n");
  const control = fs.readFileSync(path.join(unpacked, "DEBIAN/control"), "utf8");
  expect(control).toMatch(/^Installed-Size: 11$/m);
  const sums = fs.readFileSync(path.join(unpacked, "DEBIAN/md5sums"), "utf8").trim().split("\n");
  expect(sums).toContain(`${createHash("md5").update("app\n").digest("hex")}  usr/bin/dure`);
  expect(sums).toContain(`${createHash("md5").update(executable(62, "node")).digest("hex")}  usr/lib/Dure/resources/dure-cli/versions/0.2.63+fixture/bin/node`);
  // md5sums lists regular files only; links travel as links.
  expect(sums.some((line) => line.endsWith("/current") || line.endsWith("bin/dure"))).toBe(false);
  const contents = execFileSync("dpkg-deb", ["--contents", deb], { encoding: "utf8" });
  expect(contents).toMatch(/^lrwxrwxrwx root\/root .* \.\/usr\/lib\/Dure\/resources\/dure-cli\/current -> versions\/0\.2\.63\+fixture$/m);
  // A finished package is left as it is.
  const before = fs.readFileSync(deb);
  expect(finishDeb({ root, bundleRoot, arch: "x86_64" })).toBe(false);
  expect(fs.readFileSync(deb).equals(before)).toBe(true);
});

test("keeps the original AppImage when the repacked one does not hold the source bytes", () => {
  const value = patchedBundle();
  const image = imageOf(value.appDir);
  expect(() => finishAppImage({
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
  expect(() => finishAppImage({ root: value.root, bundleRoot: value.bundleRoot, arch: "x86_64", ...imageOf(value.appDir) }))
    .toThrow("no bundled hmux-runtime");
});
