import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  prepareCheckoutHelperArtifact,
  stageCheckoutHelperArtifact,
  supplyCheckoutHelperArtifact,
} from "./remote-git-checkout-helper-artifact.mjs";

const roots = [];
const resourcePath = "src-tauri/resources/remote-git-checkout-helper";
const targets = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];
const binaryName = "dure-git-checkout-helper";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root, env: withoutLocalGitOverrides(), encoding: "utf8", stdio: "pipe",
  }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-helper-artifact-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  for (const file of [
    "scripts/remote-git-checkout-helper-artifact.mjs",
    "scripts/stage-remote-git-checkout-helper.sh",
    "scripts/build-remote-git-checkout-helper.sh",
    "scripts/verify-static-linux-binary.sh",
    "scripts/lib/git-environment.mjs",
  ]) fs.copyFileSync(file, path.join(root, file));
  fs.writeFileSync(path.join(root, ".gitignore"), "src-tauri/resources/remote-git-checkout-helper/*/\n");
  fs.writeFileSync(path.join(root, "source.rs"), "fn main() {}\n");
  // Stand in for the expensive compiler/slot boundary, not artifact validation.
  fs.writeFileSync(path.join(root, "scripts/with-hmux-build-environment.sh"), `#!/bin/sh
set -eu
printf 'build\\n' >> "$DURE_TEST_HELPER_BUILD_LOG"
[ "\${DURE_TEST_HELPER_FAIL_BUILD:-0}" != 1 ] || exit 79
[ "\${DURE_TEST_HELPER_FAIL_TARGET:-}" != "$1" ] || exit 78
mkdir -p "$CARGO_TARGET_DIR/$1/release"
cp "fixture-$1.elf" "$CARGO_TARGET_DIR/$1/release/dure-git-checkout-helper"
`);
  for (const target of targets) fs.writeFileSync(path.join(root, `fixture-${target}.elf`), elf(target));
  git(root, "init", "-q");
  commit(root);
  return root;
}

function ordinaryStage(root, extra = {}) {
  const environment = withoutLocalGitOverrides({
    ...process.env,
    DURE_TEST_HELPER_BUILD_LOG: path.join(root, "build.log"),
    ...extra,
  });
  delete environment.DURE_CHECKOUT_HELPER_ARTIFACT_ROOT;
  delete environment.CARGO_TARGET_DIR;
  return spawnSync("sh", [path.join(root, "scripts/stage-remote-git-checkout-helper.sh")], {
    cwd: root, env: environment, encoding: "utf8", timeout: 20_000,
  });
}

function localFixture() {
  const root = fixture();
  fs.appendFileSync(path.join(root, ".gitignore"), "crates/dure-app/target/\nbuild.log\n");
  commit(root);
  return root;
}

test("ordinary staging reuses verified helpers without entering the native build slot", () => {
  const root = localFixture();
  const first = ordinaryStage(root);
  expect(first.status, first.stderr).toBe(0);
  const log = fs.readFileSync(path.join(root, "build.log"), "utf8");
  expect(log.trim().split("\n")).toHaveLength(2);
  const second = ordinaryStage(root, { DURE_TEST_HELPER_FAIL_BUILD: "1" });
  expect(second.status, second.stderr).toBe(0);
  expect(fs.readFileSync(path.join(root, "build.log"), "utf8")).toBe(log);
});

test.each(["src/App.tsx", "src-tauri/src/window.rs", "docs/operations/example.md"])(
  "a presentation/adapter/docs-only commit reuses prepared helpers without a build: %s", (file) => {
    const root = localFixture();
    expect(ordinaryStage(root).status).toBe(0);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "presentation-only change\n");
    commit(root);
    const result = ordinaryStage(root, { DURE_TEST_HELPER_FAIL_BUILD: "1" });
    expect(result.status, result.stderr).toBe(0);
  },
);

test.each([
  "crates/dure-app/session-runtime/src/command.rs", "hmux/Cargo.toml",
  "orchestration/src/lib.rs", "cli/lib/backend-capability-limit.json",
  "scripts/new-build-input.sh", "crates/dure-app/Cargo.lock", ".cargo/config.toml",
  "new-unknown-input",
])("a changed helper input requires a build and retires stale proof: %s", (file) => {
  const root = localFixture();
  expect(ordinaryStage(root).status).toBe(0);
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), "changed native input\n");
  commit(root);
  const result = ordinaryStage(root, { DURE_TEST_HELPER_FAIL_BUILD: "1" });
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(path.join(root, "build.log"), "utf8").trim().split("\n")).toHaveLength(3);
  expect(fs.existsSync(path.join(root, resourcePath, "artifact/checkout-helper.json"))).toBe(false);
});

test.each(["missing", "corrupted", "symlink", "nonexecutable", "wrong-architecture", "missing-receipt", "legacy-receipt"])(
  "unproven local output cannot skip preparation: %s", (fault) => {
    const root = localFixture();
    expect(ordinaryStage(root).status).toBe(0);
    const binary = path.join(root, resourcePath, targets[1], binaryName);
    const receiptPath = path.join(root, resourcePath, "artifact/checkout-helper.json");
    if (fault === "missing") fs.unlinkSync(binary);
    if (fault === "corrupted") fs.appendFileSync(binary, "corruption");
    if (fault === "symlink") {
      fs.unlinkSync(binary);
      fs.symlinkSync(path.join(root, `fixture-${targets[1]}.elf`), binary);
    }
    if (fault === "nonexecutable") fs.chmodSync(binary, 0o600);
    if (fault === "missing-receipt") fs.unlinkSync(receiptPath);
    if (fault === "legacy-receipt") {
      const receipt = JSON.parse(fs.readFileSync(receiptPath));
      receipt.schemaVersion = 1;
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    }
    if (fault === "wrong-architecture") {
      const bytes = elf(targets[0]);
      fs.writeFileSync(binary, bytes);
      const receipt = JSON.parse(fs.readFileSync(receiptPath));
      receipt.binaries[targets[1]] = createHash("sha256").update(bytes).digest("hex");
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    }
    expect(ordinaryStage(root, { DURE_TEST_HELPER_FAIL_BUILD: "1" }).status).not.toBe(0);
    expect(fs.existsSync(receiptPath)).toBe(false);
  },
);

test("dirty source builds without a receipt; compiler overrides invalidate reuse", () => {
  const root = localFixture();
  expect(ordinaryStage(root).status).toBe(0);
  const changedFlags = ordinaryStage(root, { RUSTFLAGS: "--cfg changed", DURE_TEST_HELPER_FAIL_BUILD: "1" });
  expect(changedFlags.status).not.toBe(0);
  expect(ordinaryStage(root).status).toBe(0);
  fs.appendFileSync(path.join(root, "source.rs"), "// dirty input\n");
  expect(ordinaryStage(root).status).toBe(0);
  expect(fs.existsSync(path.join(root, resourcePath, "artifact/checkout-helper.json"))).toBe(false);
});

test("a failed second architecture cannot publish reusable preparation", () => {
  const root = localFixture();
  const result = ordinaryStage(root, { DURE_TEST_HELPER_FAIL_TARGET: targets[1] });
  expect(result.status).not.toBe(0);
  expect(fs.existsSync(path.join(root, resourcePath, "artifact/checkout-helper.json"))).toBe(false);
});

test("committed source movement during a build cannot publish proof", () => {
  const root = localFixture();
  expect(() => prepareCheckoutHelperArtifact(root, () => {
    fakeBuild(root);
    fs.appendFileSync(path.join(root, "source.rs"), "// moved\n");
    commit(root);
  })).toThrow("source changed during the build");
  expect(fs.existsSync(path.join(root, resourcePath, "artifact/checkout-helper.json"))).toBe(false);
});

function commit(root) {
  git(root, "add", ".");
  git(root, "-c", "user.name=Artifact Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
}

// Minimal ELF64 fixtures exercise the real static verifier, not a compiler or
// Linux runtime. One PT_LOAD segment and no interpreter/dependencies.
function elf(target) {
  const bytes = Buffer.alloc(120);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(target.startsWith("x86_64") ? 62 : 183, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64);
  return bytes;
}

function fakeBuild(root) {
  for (const target of targets) {
    const directory = path.join(root, resourcePath, target);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, binaryName), elf(target));
  }
}

function transfer(root) {
  const source = supplyCheckoutHelperArtifact(root, fakeBuild);
  const download = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-helper-download-"));
  roots.push(download);
  fs.cpSync(source, download, { recursive: true });
  return download;
}

test("stages a same-source transfer through the shell entrypoint without a compiler", () => {
  const supply = fixture();
  const download = transfer(supply);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-helper-consumer-"));
  roots.push(root);
  git(root, "clone", "--no-hardlinks", supply, ".");
  for (const target of targets) {
    fs.mkdirSync(path.join(root, resourcePath, target), { recursive: true });
    fs.writeFileSync(path.join(root, resourcePath, target, binaryName), "old resource");
  }
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-helper-tools-"));
  roots.push(tools);
  fs.writeFileSync(path.join(tools, "cargo"), "#!/bin/sh\nexit 79\n", { mode: 0o755 });
  execFileSync("sh", [path.join(root, "scripts/stage-remote-git-checkout-helper.sh")], {
    cwd: root,
    env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`,
      DURE_CHECKOUT_HELPER_ARTIFACT_ROOT: download },
    stdio: "pipe",
  });
  for (const target of targets) {
    expect(fs.readFileSync(path.join(root, resourcePath, target, binaryName))).toEqual(elf(target));
  }
  expect(JSON.parse(fs.readFileSync(path.join(root, resourcePath, "artifact/checkout-helper.json"))))
    .toEqual(JSON.parse(fs.readFileSync(path.join(download, "artifact/checkout-helper.json"))));
});

test("a transferred artifact can serve a later adapter commit without relabelling its supplier", () => {
  const root = localFixture();
  expect(ordinaryStage(root).status).toBe(0);
  const suppliedCommit = git(root, "rev-parse", "HEAD");
  const download = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-helper-equivalent-"));
  roots.push(download);
  fs.cpSync(path.join(root, resourcePath), download, { recursive: true });
  fs.mkdirSync(path.join(root, "src-tauri/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src-tauri/src/window.rs"), "// adapter-only change\n");
  commit(root);
  stageCheckoutHelperArtifact(root, download);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, resourcePath, "artifact/checkout-helper.json")));
  expect(receipt.sourceCommit).toBe(suppliedCommit);
  expect(receipt.sourceCommit).not.toBe(git(root, "rev-parse", "HEAD"));
  const result = ordinaryStage(root, { DURE_TEST_HELPER_FAIL_BUILD: "1" });
  expect(result.status, result.stderr).toBe(0);
});

test("rejects a changed target before replacing either existing resource", () => {
  const root = fixture();
  const download = transfer(root);
  fs.appendFileSync(path.join(download, targets[1], binaryName), "corrupted");
  for (const target of targets) {
    fs.writeFileSync(path.join(root, resourcePath, target, binaryName), "old resource");
  }
  expect(() => stageCheckoutHelperArtifact(root, download)).toThrow("digest changed");
  for (const target of targets) {
    expect(fs.readFileSync(path.join(root, resourcePath, target, binaryName), "utf8")).toBe("old resource");
  }
});

test("rejects a different source commit and uncommitted source", () => {
  const root = fixture();
  const download = transfer(root);
  fs.appendFileSync(path.join(root, "source.rs"), "// changed\n");
  expect(() => stageCheckoutHelperArtifact(root, download)).toThrow("clean source checkout");
  commit(root);
  expect(() => stageCheckoutHelperArtifact(root, download)).toThrow("does not match this source commit");
});

test("a failed or source-changing build cannot publish a receipt", () => {
  const root = fixture();
  expect(() => supplyCheckoutHelperArtifact(root, () => { throw new Error("build failed"); }))
    .toThrow("build failed");
  expect(() => supplyCheckoutHelperArtifact(root, () => {
    fs.appendFileSync(path.join(root, "source.rs"), "// during build\n");
  })).toThrow("clean source checkout");
  expect(fs.existsSync(path.join(root, resourcePath, "artifact/checkout-helper.json"))).toBe(false);
});

test("a failed rebuild retires the old receipt rather than exporting stale output", () => {
  const root = fixture();
  supplyCheckoutHelperArtifact(root, fakeBuild);
  expect(() => supplyCheckoutHelperArtifact(root, () => { throw new Error("build failed"); }))
    .toThrow("build failed");
  expect(fs.existsSync(path.join(root, resourcePath, "artifact/checkout-helper.json"))).toBe(false);
  for (const target of targets) {
    expect(fs.readFileSync(path.join(root, resourcePath, target, binaryName))).toEqual(elf(target));
  }
});

test("a matching digest does not admit a binary for the wrong architecture", () => {
  const root = fixture();
  const download = transfer(root);
  const bytes = elf(targets[0]);
  fs.writeFileSync(path.join(download, targets[1], binaryName), bytes);
  const receiptPath = path.join(download, "artifact/checkout-helper.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.binaries[targets[1]] = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  expect(() => stageCheckoutHelperArtifact(root, download)).toThrow("expected b700");
});
