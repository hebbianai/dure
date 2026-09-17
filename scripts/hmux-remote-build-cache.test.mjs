import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { rustToolchainTestEnvironment } from "./lib/rust-toolchain-test-environment.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const targets = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];
let toolchainEnvironment;
beforeAll(() => { toolchainEnvironment = rustToolchainTestEnvironment(); });

function write(root, file, contents, mode = 0o600) {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents, { mode });
}

function program(revision) {
  return `fn main() {
    println!("hmux-product-profile=structured-terminal-v1:${revision}:{}:{}",
        cache_dependency::answer(), env!("HMUX_BUILD_ID"));
}\n`;
}

test.skipIf(process.platform === "win32").each(["default", "custom-target", "custom-build"])(
  "remote bundles reuse intermediates, preserving target identities and older outputs (%s)",
  layout => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dure-remote-build-cache-")));
    const environment = withoutLocalGitOverrides({
      ...process.env,
      ...toolchainEnvironment,
      HOME: root,
      DURE_HOME: path.join(root, "state"),
      HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
      CARGO_HOME: path.join(root, "cargo-home"),
      CARGO_BUILD_JOBS: "1",
      CARGO_NET_OFFLINE: "true",
      CARGO_TERM_PROGRESS_WHEN: "never",
      RUSTC_WRAPPER: "",
      RUSTC_WORKSPACE_WRAPPER: "",
    });
    for (const key of ["CARGO_TARGET_DIR", "CARGO_BUILD_BUILD_DIR", "CARGO_BUILD_TARGET", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "HMUX_PROFILE", "HMUX_BUILD_ID"]) {
      delete environment[key];
    }
    if (layout !== "default") {
      environment.CARGO_TARGET_DIR = path.join(root, "custom target");
    }
    if (layout === "custom-build") {
      environment.CARGO_BUILD_BUILD_DIR = path.join(root, "custom intermediates");
    }
    const targetRoot = environment.CARGO_TARGET_DIR ?? path.join(root, "hmux", "target");
    const intermediateRoot = environment.CARGO_BUILD_BUILD_DIR ?? path.join(targetRoot, "remote-agent-tools-build");
    try {
      const git = (...args) => execFileSync("git", args, { cwd: root, env: environment, stdio: "pipe" });
      git("init", "--initial-branch=main");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
      const cargo = execFileSync("/bin/sh", ["-c", "command -v cargo"], { env: environment, encoding: "utf8" }).trim();
      environment.DURE_TEST_CARGO = cargo;
      environment.DURE_TEST_BUILD_LOG = path.join(root, "cargo.jsonl");
      environment.PATH = `${path.join(root, "tools")}${path.delimiter}${environment.PATH}`;
      write(root, "tools/cargo", `#!/bin/sh
[ "\${DURE_TEST_FAIL_BUILD:-0}" != 1 ] || exit 42
exec "$DURE_TEST_CARGO" "$@" --offline --message-format=json >>"$DURE_TEST_BUILD_LOG"
`, 0o700);
      for (const name of ["stage-hmux-remote-resources.sh", "package-hmux-prebuilt.sh", "verify-static-linux-binary.sh", "verify-hmux-product-runtime.sh"]) {
        write(root, `scripts/${name}`, fs.readFileSync(path.join(scripts, name), "utf8"), 0o700);
      }
      // Only the unrelated Ghostty/C shim preparation is replaced. Staging,
      // Cargo, both cross-target linkers, ELF checks and packaging are real.
      write(root, "scripts/build-hmux-product-runtime.sh", '#!/bin/sh\nshift\nexec "$@"\n', 0o700);
      write(root, ".cargo/config.toml", fs.readFileSync(path.join(scripts, "../.cargo/config.toml"), "utf8"));
      write(root, "hmux/Cargo.toml", '[workspace]\nmembers = ["cli", "runtime", "dependency"]\nresolver = "2"\n[workspace.package]\nversion = "0.1.0"\n');
      write(root, "hmux/dependency/Cargo.toml", '[package]\nname = "cache_dependency"\nversion = "0.1.0"\nedition = "2021"\n');
      write(root, "hmux/dependency/src/lib.rs", 'pub fn answer() -> u32 { 41 }\n');
      for (const [folder, name, binary] of [["cli", "hmux-cli", "hmux"], ["runtime", "hmux-runtime", "hmux-runtime"]]) {
        write(root, `hmux/${folder}/Cargo.toml`, `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n` +
          `[dependencies]\ncache_dependency = { path = "../dependency" }\n[[bin]]\nname = "${binary}"\npath = "src/main.rs"\n`);
        write(root, `hmux/${folder}/src/main.rs`, program("first"));
      }
      execFileSync(cargo, ["generate-lockfile", "--offline", "--manifest-path", "hmux/Cargo.toml"], {
        cwd: root, env: environment, stdio: "pipe", timeout: 30_000,
      });
      const stage = (id, extra = {}) => spawnSync("/bin/sh", ["scripts/stage-hmux-remote-resources.sh", "release"], {
        cwd: root, env: { ...environment, HMUX_BUILD_ID: id, ...extra }, encoding: "utf8", timeout: 60_000,
      });
      const artifacts = () => fs.readFileSync(environment.DURE_TEST_BUILD_LOG, "utf8")
        .trim().split("\n").map(line => JSON.parse(line)).filter(item => item.reason === "compiler-artifact");
      const bundlePath = (target, file) => path.join(root, "src-tauri/resources/hmux-remote", target, file);
      const finalPath = (id, target, binary) => path.join(targetRoot, "remote-agent-tools", id, target, "release", binary);
      const first = stage("generation-one");
      expect(first.status, first.stderr).toBe(0);
      const firstArtifacts = artifacts();
      const dependencies = firstArtifacts.filter(item => item.target.name === "cache_dependency");
      expect(dependencies).toHaveLength(2);
      expect(dependencies.every(item => !item.fresh)).toBe(true);
      const archives = dependencies.map(item => item.filenames.find(file => file.endsWith(".rlib")));
      const mtimes = archives.map(file => fs.statSync(file).mtimeMs);
      const oldBinaries = targets.flatMap(target => ["hmux", "hmux-runtime"].map(binary => {
        const file = finalPath("generation-one", target, binary);
        return { file, contents: fs.readFileSync(file) };
      }));
      write(root, "hmux/runtime/src/main.rs", program("second"));
      const second = stage("generation-two");
      expect(second.status, second.stderr).toBe(0);
      const newArtifacts = artifacts().slice(firstArtifacts.length);
      const runtimes = newArtifacts.filter(item => item.target.name === "hmux-runtime");
      expect(runtimes).toHaveLength(2);
      expect(runtimes.map(item => item.fresh)).toEqual([false, false]);
      for (const target of targets) {
        const manifest = JSON.parse(fs.readFileSync(bundlePath(target, "install.json"), "utf8"));
        expect(manifest).toMatchObject({ buildId: `generation-two.${target}.release`, targetTriple: target, profile: "release" });
        for (const binary of ["hmux", "hmux-runtime"]) {
          expect(fs.readFileSync(bundlePath(target, `bin/${binary}`))).toEqual(fs.readFileSync(finalPath("generation-two", target, binary)));
        }
      }
      for (const { file, contents } of oldBinaries) expect(fs.readFileSync(file)).toEqual(contents);
      const secondDependencies = newArtifacts.filter(item => item.target.name === "cache_dependency");
      expect(secondDependencies).toHaveLength(2);
      expect(secondDependencies.map(item => item.fresh)).toEqual([true, true]);
      expect(secondDependencies.map(item => item.filenames.find(file => file.endsWith(".rlib")))).toEqual(archives);
      expect(archives.map(file => fs.statSync(file).mtimeMs)).toEqual(mtimes);
      for (const [index, target] of targets.entries()) expect(archives[index].startsWith(path.join(intermediateRoot, target))).toBe(true);
      expect(fs.readFileSync(path.join(intermediateRoot, "CACHEDIR.TAG"), "utf8")).toContain("Signature: 8a477f597d28d172789f06886806bc55");

      const logBefore = fs.readFileSync(environment.DURE_TEST_BUILD_LOG);
      expect(stage("generation-two").status).toBe(0);
      expect(fs.readFileSync(environment.DURE_TEST_BUILD_LOG)).toEqual(logBefore);
      const bundleContents = () => targets.flatMap(target => ["install.json", "bin/hmux", "bin/hmux-runtime"]
        .map(file => fs.readFileSync(bundlePath(target, file))));
      const bundleBefore = bundleContents();
      const failed = stage("generation-three", { DURE_TEST_FAIL_BUILD: "1" });
      expect(failed.status).toBe(42);
      expect(bundleContents()).toEqual(bundleBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000,
);
