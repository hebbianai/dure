import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { rustToolchainTestEnvironment } from "./lib/rust-toolchain-test-environment.mjs";

const stageScript = fileURLToPath(new URL("./stage-hmux-runtime.sh", import.meta.url));
let toolchainEnvironment;
beforeAll(() => { toolchainEnvironment = rustToolchainTestEnvironment(); });

function write(root, name, content, mode = 0o600) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function program(revision) {
  return `use std::io::{self, BufRead};
fn main() {
    if std::env::args().any(|arg| arg == "hmux-build-info") {
        println!("{{\\\"productProfile\\\":\\\"structured-terminal-v1\\\"}}");
        return;
    }
    println!("${revision}:{}", cache_dependency::answer());
    for _ in io::stdin().lock().lines() {
        println!("${revision}:{}", cache_dependency::answer());
    }
}
`;
}

// Exercise the real stage/build/normalization boundary without compiling the
// product or launching any host. Cargo only builds an offline local fixture.
test.skipIf(process.platform === "win32").each(["default", "explicit-build-dir", "explicit-target"])(
  "dev generations reuse dependencies without replacing an earlier running executable (%s)",
  async mode => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dure-hmux-build-cache-")));
    const environment = withoutLocalGitOverrides({
      ...process.env,
      ...toolchainEnvironment,
      HOME: root,
      DURE_HOME: path.join(root, "state"),
      HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
      DURE_NATIVE_BUILD_SLOT_ROOT: path.join(root, "build-slot"),
      HMUX_DEV_CHANNEL: "",
      HMUX_SKIP_TAURI_STAGE: "1",
      HMUX_GHOSTTY_VT_PROOF_PREFIX: path.join(root, "proof"),
      CARGO_HOME: path.join(root, "cargo-home"),
      CARGO_BUILD_JOBS: "1",
      CARGO_INCREMENTAL: "1",
      RUSTFLAGS: "",
      CARGO_ENCODED_RUSTFLAGS: "",
      RUSTC_WRAPPER: "",
      RUSTC_WORKSPACE_WRAPPER: "",
      DURE_POSIX_SHELL: "/bin/sh",
    });
    delete environment.CARGO_BUILD_TARGET;
    delete environment.CARGO_BUILD_BUILD_DIR;
    delete environment.CARGO_TARGET_DIR;
    if (mode === "explicit-build-dir") {
      environment.CARGO_BUILD_BUILD_DIR = path.join(root, "hmux", "target", "custom-build");
    }
    if (mode === "explicit-target") {
      environment.CARGO_TARGET_DIR = path.join(root, "custom target");
      environment.CARGO_BUILD_TARGET = execFileSync("rustc", ["-vV"], {
        env: environment, encoding: "utf8", timeout: 10_000,
      }).match(/^host: (.+)$/m)[1];
    }
    const targetRoot = environment.CARGO_TARGET_DIR ?? path.join(root, "hmux", "target");
    let runtime;
    let ended;
    let output;
    try {
      const cargo = execFileSync("/bin/sh", ["-c", "command -v cargo"], {
        env: environment, encoding: "utf8",
      }).trim();
      write(root, "tools/cargo", `#!/bin/sh
exec "$DURE_TEST_CARGO" "$@" --offline --message-format=json >"$DURE_TEST_ARTIFACT_LOG"
`, 0o700);
      environment.DURE_TEST_CARGO = cargo;
      environment.PATH = `${path.join(root, "tools")}${path.delimiter}${environment.PATH}`;
      write(root, "proof/hmux-ghostty-vt-proof.receipt", "fixture; no product source compiled\n");
      write(root, "hmux/Cargo.toml", '[workspace]\nmembers = ["cli", "runtime", "dependency"]\nresolver = "2"\n');
      write(root, "hmux/dependency/Cargo.toml", '[package]\nname = "cache_dependency"\nversion = "0.1.0"\nedition = "2021"\n');
      write(root, "hmux/dependency/src/lib.rs", "pub fn answer() -> u32 { 41 }\n");
      for (const [folder, name, binary] of [["cli", "hmux-cli", "hmux"], ["runtime", "hmux-runtime", "hmux-runtime"]]) {
        write(root, `hmux/${folder}/Cargo.toml`, `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n` +
          `[features]\nterminal-state-stream = []\n[dependencies]\ncache_dependency = { path = "../dependency" }\n[[bin]]\nname = "${binary}"\npath = "src/main.rs"\n`);
        write(root, `hmux/${folder}/src/main.rs`, program("first"));
      }
      execFileSync(cargo, ["generate-lockfile", "--offline", "--manifest-path", "hmux/Cargo.toml"], {
        cwd: root, env: environment, stdio: "pipe", timeout: 30_000,
      });
      const build = (id) => {
        const artifacts = path.join(root, `stage-${id}`);
        fs.mkdirSync(artifacts);
        const log = path.join(root, `cargo-${id}.jsonl`);
        execFileSync("/bin/sh", [stageScript, "debug"], {
          cwd: root,
          env: { ...environment, HMUX_BUILD_ID: id, HMUX_STAGE_ARTIFACT_DIR: artifacts, DURE_TEST_ARTIFACT_LOG: log },
          encoding: "utf8", timeout: 60_000,
        });
        const messages = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
        return {
          messages,
          artifacts,
          dependency: messages.find(item => item.reason === "compiler-artifact" && item.target.name === "cache_dependency"),
          binary: path.join(targetRoot, "agent-tools", id, environment.CARGO_BUILD_TARGET ?? "", "debug", "hmux-runtime"),
        };
      };
      const first = build("generation-one");
      const binaryBefore = fs.readFileSync(first.binary);
      const stagedBefore = fs.readFileSync(path.join(first.artifacts, "hmux-runtime"));
      const dependencyFile = first.dependency.filenames.find(file => file.endsWith(".rlib"));
      const expectedBuildRoot = environment.CARGO_BUILD_BUILD_DIR ?? path.join(targetRoot, "agent-tools-build");
      const dependencyBefore = fs.statSync(dependencyFile);
      runtime = spawn(first.binary, [], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
      ended = once(runtime, "exit");
      output = createInterface({ input: runtime.stdout });
      const lines = output[Symbol.asyncIterator]();
      expect((await lines.next()).value).toBe("first:41");

      write(root, "hmux/runtime/src/main.rs", program("second"));
      const second = build("generation-two");
      expect(fs.readFileSync(first.binary)).toEqual(binaryBefore);
      expect(fs.readFileSync(path.join(first.artifacts, "hmux-runtime"))).toEqual(stagedBefore);
      runtime.stdin.write("still alive\n");
      expect((await lines.next()).value).toBe("first:41");
      expect(execFileSync(second.binary, [], { input: "", encoding: "utf8" }).trim()).toBe("second:41");
      expect(first.dependency.fresh).toBe(false);
      expect(second.dependency.fresh).toBe(true);
      expect(dependencyFile.startsWith(`${expectedBuildRoot}${path.sep}`)).toBe(true);
      expect(second.dependency.filenames).toEqual(first.dependency.filenames);
      expect(fs.statSync(dependencyFile).mtimeMs).toBe(dependencyBefore.mtimeMs);
      expect(second.messages).toContainEqual(expect.objectContaining({
        reason: "compiler-artifact", target: expect.objectContaining({ name: "hmux-runtime" }), fresh: false,
      }));
    } finally {
      if (runtime) {
        runtime.stdin.end();
        await ended;
        output.close();
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000,
);
