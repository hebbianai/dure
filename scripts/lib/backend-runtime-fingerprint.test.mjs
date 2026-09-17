import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeBackendRuntimeFingerprint,
  readBackendRuntimeInputs,
  tryBackendRuntimeFingerprint,
} from "./backend-runtime-fingerprint.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

const roots = [];
const GIT_ISOLATION_TIMEOUT_MS = 15_000;

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  }).trim();
}

function gitWithInput(root, input, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
    input,
  }).trim();
}

function write(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function repository(inputs = ["src-tauri/src"], { objectFormat } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "backend-runtime-fingerprint-"));
  roots.push(root);
  git(
    root,
    "init",
    "-q",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  );
  git(root, "config", "user.name", "Fingerprint Test");
  git(root, "config", "user.email", "fingerprint@example.test");
  git(root, "config", "commit.gpgSign", "false");
  write(
    root,
    "scripts/backend-runtime-inputs.txt",
    `${inputs.join("\n")}\nartifact-prefix:src-tauri/binaries/hmux-runtime-\n`,
  );
  write(root, ".gitignore", "src-tauri/binaries/hmux-runtime-*\n");
  write(root, "src-tauri/src/lib.rs", "pub fn version() -> u8 { 1 }\n");
  write(root, "src-tauri/binaries/hmux-runtime-fixture-target", "binary-one\n");
  write(root, "docs/note.md", "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function expectedFingerprint(root) {
  const files = [
    "scripts/backend-runtime-inputs.txt",
    "src-tauri/binaries/hmux-runtime-fixture-target",
    "src-tauri/src/lib.rs",
  ].sort();
  const manifest = [
    "hebbian-backend-runtime-fingerprint-v1",
    ...files.map(
      (file) => `${git(root, "hash-object", "--no-filters", file)} ${file}`,
    ),
    "",
  ].join("\n");
  return `git-object-v1:${gitWithInput(
    root,
    manifest,
    "hash-object",
    "--stdin",
  )}`;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("backend runtime fingerprint", () => {
  it.each([
    "src-tauri/vendor/tauri-runtime/src/webview.rs",
    "crates/dure-app/session-runtime/src/host_command.rs",
    "crates/dure-app/session-runtime/Cargo.toml",
  ])("includes changes to the backend input %s", (runtime) => {
    const { sourceInputs } = readBackendRuntimeInputs(process.cwd());
    const root = repository(sourceInputs);
    for (const input of sourceInputs) {
      const file = statSync(path.join(process.cwd(), input)).isDirectory()
        ? path.join(input, "fingerprint-fixture")
        : input;
      write(root, file, "native source input fixture\n");
    }
    write(root, runtime, "backend input before\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "backend source input");
    const before = computeBackendRuntimeFingerprint(root);
    write(root, runtime, "backend input after\n");
    expect(computeBackendRuntimeFingerprint(root)).not.toBe(before);
  });

  it("covers every source consumed by the installed control plane", () => {
    const { sourceInputs } = readBackendRuntimeInputs(process.cwd());

    expect(sourceInputs).toEqual(
      expect.arrayContaining([
        "orchestration/Cargo.toml",
        "orchestration/src",
        "crates/dure-app/Cargo.lock",
        "crates/dure-app/protocol/Cargo.toml",
        "crates/dure-app/protocol/src",
        "crates/dure-app/provider-profile/Cargo.toml",
        "crates/dure-app/provider-profile/src",
        "crates/dure-app/provider-adapter/Cargo.toml",
        "crates/dure-app/provider-adapter/src",
        "crates/dure-app/control-plane/Cargo.toml",
        "crates/dure-app/control-plane/src",
      ]),
    );
  });

  it("matches canonical Git blob identities for raw working-tree bytes", () => {
    const root = repository();
    write(
      root,
      "src-tauri/binaries/hmux-runtime-fixture-target",
      Buffer.from([0, 1, 2, 10, 13, 128, 255]),
    );
    expect(computeBackendRuntimeFingerprint(root)).toBe(
      expectedFingerprint(root),
    );
  });

  it("uses the repository's SHA-256 object format", () => {
    const root = repository(undefined, { objectFormat: "sha256" });

    expect(computeBackendRuntimeFingerprint(root)).toBe(
      expectedFingerprint(root),
    );
  });

  it("computes the canonical fingerprint when Git stdin hashing is unavailable", () => {
    const root = repository();
    const artifact = "src-tauri/binaries/hmux-runtime-fixture-target";
    const artifactBytes = Buffer.from([0, 1, 2, 10, 13, 128, 255]);
    write(root, artifact, artifactBytes);
    const shimRoot = mkdtempSync(
      path.join(os.tmpdir(), "backend-runtime-git-shim-"),
    );
    roots.push(shimRoot);
    const shimPath = path.join(shimRoot, "git");
    write(
      shimRoot,
      "git",
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--stdin") || args.includes("--stdin-paths")) {
  process.stderr.write("Git stdin hashing unavailable\\n");
  process.exit(86);
}
const result = spawnSync(process.env.DURE_TEST_REAL_GIT, args);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
    );
    chmodSync(shimPath, 0o755);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

    const result = execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts/lib/backend-runtime-fingerprint.mjs"),
        "--root",
        root,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_TEST_REAL_GIT: realGit,
          PATH: `${shimRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    expect(result.trim()).toBe(expectedFingerprint(root));
  });

  it("hashes a large generated runtime without blocking on a Git stdin pipe", () => {
    const root = repository();
    write(
      root,
      "src-tauri/binaries/hmux-runtime-fixture-target",
      Buffer.alloc(20 * 1024 * 1024, 0x5a),
    );

    expect(computeBackendRuntimeFingerprint(root)).toBe(
      expectedFingerprint(root),
    );
  });

  it("keeps fixture commits independent from required global signing", () => {
    const configRoot = mkdtempSync(path.join(os.tmpdir(), "backend-runtime-git-config-"));
    roots.push(configRoot);
    const globalConfig = path.join(configRoot, "config");
    write(
      configRoot,
      "config",
      "[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = definitely-missing-signing-program\n",
    );
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    try {
      const root = repository();
      expect(git(root, "config", "--local", "--bool", "commit.gpgSign")).toBe("false");
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
  });

  it("ignores unrelated commit drift", () => {
    const root = repository();
    const before = computeBackendRuntimeFingerprint(root);
    write(root, "docs/note.md", "two\n");
    git(root, "add", "docs/note.md");
    git(root, "commit", "-qm", "docs only");

    expect(computeBackendRuntimeFingerprint(root)).toBe(before);
  });

  it("changes for tracked and untracked backend runtime bytes", () => {
    const root = repository();
    const before = computeBackendRuntimeFingerprint(root);
    write(root, "src-tauri/src/lib.rs", "pub fn version() -> u8 { 2 }\n");
    const tracked = computeBackendRuntimeFingerprint(root);
    write(root, "src-tauri/src/new_command.rs", "pub fn command() {}\n");

    expect(tracked).not.toBe(before);
    expect(computeBackendRuntimeFingerprint(root)).not.toBe(tracked);
  });

  it("changes when the ignored staged runtime artifact changes", () => {
    const root = repository();
    const before = computeBackendRuntimeFingerprint(root);
    write(root, "src-tauri/binaries/hmux-runtime-fixture-target", "binary-two\n");

    expect(computeBackendRuntimeFingerprint(root)).not.toBe(before);
  });

  it("fails closed when an input matches no files", () => {
    const root = repository(["src-tauri/src", "missing-runtime"]);

    expect(() => computeBackendRuntimeFingerprint(root)).toThrow(
      "backend runtime input matched no files: missing-runtime",
    );
  });

  it("rejects unsafe and duplicate manifest entries", () => {
    const root = repository();
    write(
      root,
      "scripts/backend-runtime-inputs.txt",
      "../outside\nartifact-prefix:src-tauri/binaries/hmux-runtime-\n",
    );
    expect(() => readBackendRuntimeInputs(root)).toThrow("invalid backend runtime input");

    write(
      root,
      "scripts/backend-runtime-inputs.txt",
      "src-tauri/src\nartifact-prefix:src-tauri/src\n",
    );
    expect(() => readBackendRuntimeInputs(root)).toThrow("duplicate backend runtime input");
  });

  it("rejects generated artifact filenames containing a newline", () => {
    const root = repository();
    write(
      root,
      "src-tauri/binaries/hmux-runtime-\nambiguous",
      "unsafe artifact\n",
    );

    expect(() => computeBackendRuntimeFingerprint(root)).toThrow(
      "backend runtime artifact contains a newline",
    );
  });

  it("returns null when fingerprint generation is unavailable", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "backend-runtime-fingerprint-missing-"));
    roots.push(root);

    expect(tryBackendRuntimeFingerprint(root)).toBeNull();
  });

  it("ignores inherited Git pointers from a hook-owned repository", () => {
    const root = repository();
    const foreignRoot = repository();
    const foreignHead = git(foreignRoot, "rev-parse", "HEAD");
    const output = execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts/lib/backend-runtime-fingerprint.mjs"),
        "--root",
        root,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: path.join(foreignRoot, ".git"),
          GIT_WORK_TREE: foreignRoot,
        },
      },
    ).trim();

    expect(output).toBe(computeBackendRuntimeFingerprint(root));
    expect(git(foreignRoot, "rev-parse", "HEAD")).toBe(foreignHead);
  }, GIT_ISOLATION_TIMEOUT_MS);
});
