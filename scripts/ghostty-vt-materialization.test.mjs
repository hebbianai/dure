import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { ensureGhosttyVtProof } from "./ensure-ghostty-vt-proof.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ghostty-vt-materialization-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function executable(pathname, contents) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, contents, { mode: 0o755 });
}

function copyBuildWrappers(scripts) {
  for (const file of [
    "build-hmux-product-runtime.sh",
    "with-hmux-build-environment.sh",
    "lib/native-build-slot.mjs",
    "lib/background-cpu-priority.mjs",
    "native/native-build-slot.py",
  ]) {
    fs.mkdirSync(path.dirname(path.join(scripts, file)), { recursive: true });
    fs.copyFileSync(path.resolve("scripts", file), path.join(scripts, file));
  }
}

function materializationFixtureEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.HMUX_GHOSTTY_VT_PROOF_PREFIX;
  return { ...environment, ...overrides };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("downloads without GitHub authentication and rejects changed bytes before extraction", () => {
  const cache = path.join(temporaryDirectory(), "cache");
  const requests = [];
  const environment = { DURE_GHOSTTY_VT_CACHE_ROOT: cache };

  expect(() =>
    ensureGhosttyVtProof({
      arch: "arm64",
      platform: "darwin",
      target: "aarch64-apple-darwin",
      environment,
      runCommand(program, arguments_, options) {
        if (program === "gh") throw new Error("GitHub authentication required");
        if (path.basename(program) !== "curl") {
          throw new Error("unverified input reached extraction or compilation");
        }
        expect(options.env).toEqual(environment);
        requests.push(arguments_.at(-1));
        const destination = arguments_[arguments_.indexOf("--output") + 1];
        fs.writeFileSync(destination, "untrusted download body");
      },
    }),
  ).toThrow("downloaded Ghostty VT provenance asset hash changed");

  expect(requests).toEqual([
    "https://github.com/hebbianai/dure/releases/download/hmux-ghostty-vt-provenance-v2/hmux-ghostty-vt-provenance-v2.tar.gz",
  ]);
  expect(fs.readdirSync(cache)).toEqual([]);
});

test("a failed public download leaves no cache or authenticated fallback", () => {
  const cache = path.join(temporaryDirectory(), "cache");
  let requests = 0;

  expect(() =>
    ensureGhosttyVtProof({
      arch: "arm64",
      platform: "darwin",
      target: "aarch64-apple-darwin",
      environment: { DURE_GHOSTTY_VT_CACHE_ROOT: cache },
      runCommand(program, arguments_) {
        if (path.basename(program) !== "curl") {
          throw new Error("unexpected authenticated fallback or build");
        }
        requests += 1;
        const destination = arguments_[arguments_.indexOf("--output") + 1];
        fs.writeFileSync(destination, "partial download");
        throw new Error("public download connection interrupted");
      },
    }),
  ).toThrow("public download connection interrupted");

  expect(requests).toBe(1);
  expect(fs.readdirSync(cache)).toEqual([]);
});

test.each([
  ["build-hmux-product-runtime.sh", ["--features", "hmux-runtime/terminal-state-stream"]],
  ["with-hmux-build-environment.sh", []],
])("%s materializes the build environment without changing its consumer's features", (wrapper, features) => {
  const root = temporaryDirectory();
  const scripts = path.join(root, "scripts");
  const tools = path.join(root, "tools");
  const proof = path.join(root, "generated-proof");
  const capture = path.join(root, "cargo-environment");
  fs.mkdirSync(scripts);
  fs.mkdirSync(proof);
  copyBuildWrappers(scripts);
  fs.writeFileSync(
    path.join(proof, "hmux-ghostty-vt-proof.receipt"),
    "fixture receipt validated at the Cargo boundary\n",
  );
  fs.writeFileSync(
    path.join(scripts, "ensure-ghostty-vt-proof.mjs"),
    "process.stdout.write(`${process.env.FIXTURE_GHOSTTY_PROOF}\\n`);\n",
  );
  executable(
    path.join(tools, "cargo"),
    `#!/bin/sh
printf '%s\n' "$HMUX_GHOSTTY_VT_PROOF_PREFIX" >"$FIXTURE_CARGO_CAPTURE"
printf '%s\n' "$@" >>"$FIXTURE_CARGO_CAPTURE"
`,
  );

  execFileSync(
    "sh",
    [
      path.join(scripts, wrapper),
      "aarch64-apple-darwin",
      "cargo",
      "check",
    ],
    {
      env: materializationFixtureEnvironment({
        FIXTURE_CARGO_CAPTURE: capture,
        FIXTURE_GHOSTTY_PROOF: proof,
        HOME: path.join(root, "empty-home"),
        DURE_NATIVE_BUILD_SLOT_ROOT: path.join(root, "build-slot"),
        PATH: `${tools}${path.delimiter}${process.env.PATH}`,
      }),
      stdio: "pipe",
    },
  );

  expect(fs.readFileSync(capture, "utf8").trim().split("\n")).toEqual([
    proof, "check", ...features,
  ]);
});

test("a cached Windows proof is reusable without a supply build host", () => {
  const root = temporaryDirectory();
  const cache = path.join(root, "cache");
  const proof = path.join(cache, "windows-proof");
  const target = "x86_64-pc-windows-msvc";
  fs.mkdirSync(path.join(cache, "targets"), { recursive: true });
  fs.mkdirSync(proof);
  fs.writeFileSync(
    path.join(proof, "hmux-ghostty-vt-proof.receipt"),
    [
      "schema=hmux-ghostty-vt-artifact-v5",
      `target=${target}`,
      "zig_target=x86_64-windows-gnu",
      "archive_normalizer=rust-1.85-llvm-19-objcopy-strip-debug-remove-addrsig-zig-ar-crsD-ranlib-D-lld-v3",
      "rust_objcopy_sha256=17e49737796f7f4c90a2884d6fb1f35c680f5025ce1f589a546a326713f1eebb",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(cache, "targets", `${target}.txt`), `${proof}\n`);

  expect(
    ensureGhosttyVtProof({
      arch: "x64",
      environment: { DURE_GHOSTTY_VT_CACHE_ROOT: cache },
      platform: "win32",
      target,
    }),
  ).toBe(proof);
});

test("a stale Windows proof cannot satisfy the current product receipt", () => {
  const root = temporaryDirectory();
  const cache = path.join(root, "cache");
  const proof = path.join(cache, "stale-windows-proof");
  const target = "x86_64-pc-windows-msvc";
  fs.mkdirSync(path.join(cache, "targets"), { recursive: true });
  fs.mkdirSync(proof);
  fs.writeFileSync(
    path.join(proof, "hmux-ghostty-vt-proof.receipt"),
    [
      "schema=hmux-ghostty-vt-artifact-v4",
      `target=${target}`,
      "zig_target=x86_64-windows-gnu",
      "archive_normalizer=zig-ar-crsD-ranlib-D-v1",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(cache, "targets", `${target}.txt`), `${proof}\n`);

  expect(() =>
    ensureGhosttyVtProof({
      arch: "x64",
      environment: { DURE_GHOSTTY_VT_CACHE_ROOT: cache },
      platform: "win32",
      target,
    }),
  ).toThrow(
    "automatic Ghostty VT preparation currently requires the macOS ARM64 build host",
  );
});

test("the product Cargo boundary normalizes Windows drive-absolute proofs", () => {
  const root = temporaryDirectory();
  const scripts = path.join(root, "scripts");
  const tools = path.join(root, "tools");
  const normalizedWindowsProof = "D:/ghostty-proof";
  const proof = path.join(root, "D:", "ghostty-proof");
  const capture = path.join(root, "cargo-environment");
  fs.mkdirSync(scripts);
  fs.mkdirSync(proof, { recursive: true });
  copyBuildWrappers(scripts);
  fs.writeFileSync(
    path.join(proof, "hmux-ghostty-vt-proof.receipt"),
    "fixture Windows receipt validated at the Cargo boundary\n",
  );
  executable(
    path.join(tools, "cargo"),
    `#!/bin/sh
printf '%s\n' "$HMUX_GHOSTTY_VT_PROOF_PREFIX" >"$FIXTURE_CARGO_CAPTURE"
`,
  );

  for (const windowsProof of [normalizedWindowsProof, "D:\\ghostty-proof"]) {
    execFileSync(
      "sh",
      [
        path.join(scripts, "build-hmux-product-runtime.sh"),
        "x86_64-pc-windows-msvc",
        "cargo",
        "check",
      ],
      {
        cwd: root,
        env: materializationFixtureEnvironment({
          FIXTURE_CARGO_CAPTURE: capture,
          HMUX_GHOSTTY_VT_PROOF_PREFIX: windowsProof,
          DURE_NATIVE_BUILD_SLOT_ROOT: path.join(root, "build-slot"),
          PATH: `${tools}${path.delimiter}${process.env.PATH}`,
        }),
        stdio: "pipe",
      },
    );

    expect(fs.readFileSync(capture, "utf8").trim()).toBe(
      normalizedWindowsProof,
    );
  }
});
