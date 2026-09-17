import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

// Cargo reports its effective job budget to real build scripts. Compile only
// this dependency-free fixture, never product source or a provider runtime.
test.skipIf(process.platform === "win32").each([
  { name: "root manifest path", cwd: ".", manifest: "hmux/Cargo.toml" },
  { name: "nested Hmux workspace", cwd: "hmux" },
  { name: "nested desktop workspace", cwd: "src-tauri" },
  { name: "nested app workspace", cwd: "crates/dure-app" },
  { name: "explicit lower budget", cwd: "hmux", override: "1", jobs: 1 },
  { name: "explicit isolated-runner budget", cwd: "hmux", override: "4", jobs: 4 },
])("preserves Cargo defaults and caller job budgets: $name", ({ cwd, manifest, override, jobs }) => {
  const root = mkdtempSync(join(tmpdir(), "dure-cargo-jobs-"));
  try {
    const tool = (name) =>
      execFileSync("rustup", ["which", name], {
        cwd: repository,
        encoding: "utf8",
        timeout: 10_000,
      }).trim();
    const cargo = tool("cargo");
    const rustc = tool("rustc");
    const workspace = join(root, cwd === "." ? "hmux" : cwd);
    mkdirSync(join(root, ".cargo"), { recursive: true });
    cpSync(join(repository, ".cargo/config.toml"), join(root, ".cargo/config.toml"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "Cargo.toml"),
      '[package]\nname = "job_budget_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    writeFileSync(
      join(workspace, "Cargo.lock"),
      'version = 4\n[[package]]\nname = "job_budget_fixture"\nversion = "0.1.0"\n',
    );
    writeFileSync(join(workspace, "src/lib.rs"), "");
    writeFileSync(join(workspace, "build.rs"), `fn main() {
    std::fs::write(
        std::env::var("DURE_TEST_JOB_RECEIPT").unwrap(),
        format!("{} {}", std::env::var("NUM_JOBS").unwrap(),
            std::thread::available_parallelism().unwrap().get()),
    ).unwrap();
}
`);
    const receipt = join(root, "jobs.txt");
    const result = execFileSync(
      cargo,
      [
        "check", "--locked", "--offline",
        ...(manifest ? ["--manifest-path", manifest] : []),
      ],
      {
        cwd: join(root, cwd),
        env: scriptTestEnvironment({
          HOME: root,
          DURE_HOME: join(root, "state"),
          HMUX_DISCOVERY_ROOT: join(root, "discovery"),
          CARGO_HOME: join(root, "cargo-home"),
          CARGO_TARGET_DIR: join(root, "target"),
          CARGO_BUILD_JOBS: override,
          RUSTC: rustc,
          DURE_TEST_JOB_RECEIPT: receipt,
        }),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    const [effectiveJobs, availableParallelism] = readFileSync(receipt, "utf8")
      .split(" ").map(Number);
    expect(effectiveJobs, result).toBe(jobs ?? availableParallelism);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
