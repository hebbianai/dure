// Exercise the production ownership modules without compiling or launching Tauri.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHeadroom } from "../lib/build-storage-admission.mjs";
import { buildStorageBudget } from "../lib/disk-space.mjs";
import { availableBytes, repositoryRoots } from "../lib/disk-reclaim.mjs";
import { rustToolchainTestEnvironment } from "../lib/rust-toolchain-test-environment.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const admission = ensureHeadroom({
  cwd: repo,
  label: "app startup ownership module tests",
  buildClass: "cli",
  requestedBytes: buildStorageBudget("cli"),
  // Preserve caches while applying the existing budget/floor/reservation
  // authority. Refuse admission if it would require reclaiming outputs.
  reclaimOutputs: () => ({
    availableAfter: availableBytes(repositoryRoots(repo).mainRoot),
    removed: [],
    removedBytes: 0,
  }),
});
if (!admission.ok) throw new Error(admission.message);

try {
  const root = mkdtempSync(join(tmpdir(), "dure-app-startup-ownership-"));
  const home = join(root, "home");
  mkdirSync(home);
  const lock = readFileSync(join(repo, "src-tauri/Cargo.lock"), "utf8");
  const windowsVersion = readFileSync(join(repo, "src-tauri/Cargo.toml"), "utf8")
    .match(/^windows = \{ version = "([0-9]+\.[0-9]+\.[0-9]+)"/m)?.[1];
  if (!windowsVersion) throw new Error("Missing exact Windows dependency in app manifest");
  const version = (name, expected) => {
    const candidates = lock.split("[[package]]")
      .filter((entry) => entry.includes(`\nname = "${name}"\n`))
      .map((entry) => entry.match(/\nversion = "([^"]+)"/)?.[1])
      .filter((value) => value && (expected === undefined || value === expected));
    if (candidates.length !== 1) throw new Error(`Missing or ambiguous pinned dependency: ${name}`);
    return `=${candidates[0]}`;
  };
  const dependency = (name) => `${name} = ${JSON.stringify(version(name))}`;
  writeFileSync(join(root, "Cargo.toml"), `[package]
name = "dure-app-startup-ownership-fixture"
version = "0.0.0"
edition = "2021"
[workspace]
[lib]
path = "fixture.rs"
[dependencies]
${["fs2", "libc", "serde_json", "tempfile"].map(dependency).join("\n")}
tokio = { version = "${version("tokio")}", features = ["macros", "rt-multi-thread", "sync", "time"] }
reqwest = { version = "${version("reqwest")}", default-features = false, features = ["blocking"] }
[target.'cfg(windows)'.dependencies]
windows = { version = "${version("windows", windowsVersion)}", features = ["Win32_Foundation", "Win32_System_Threading"] }
`);
  // Reuse repository-pinned transitive dependencies; Cargo only adjusts the
  // disposable fixture's package entry. No repository lockfile is rewritten.
  writeFileSync(join(root, "Cargo.lock"), lock);
  const module = (name) =>
    `#[path = ${JSON.stringify(join(repo, `src-tauri/src/${name}.rs`))}] mod ${name};`;
  writeFileSync(join(root, "fixture.rs"), `
// Root/profile resolution, Tauri task spawning and CLI/backend side effects
// use fixture adapters. Ownership, authenticated probing, channel validation
// and coordinator preparation/publication ordering are production code.
mod app_home {
    pub fn app_root_resolution() -> Result<(std::path::PathBuf, ()), String> {
        Ok((std::env::var_os("DURE_HOME").unwrap().into(), ()))
    }
}
mod worktree_release {
    pub fn resolve_channel(channel: Option<String>) -> std::io::Result<Option<String>> {
        Ok(channel)
    }
}
extern crate self as tauri;
pub mod async_runtime {
    pub use tokio::spawn;
    pub use tokio::task::spawn_blocking;
}
mod dure_backend_transport {
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct BackendProfile(String);
    impl BackendProfile {
        pub fn id(&self) -> &str { &self.0 }
        pub fn same_profile_id(&self, other: &Self) -> bool { self == other }
        pub fn deadline(&self) -> std::time::Duration { std::time::Duration::from_secs(1) }
    }
}
mod dure_cli_install {
    pub struct BackendReconcileError { pub code: &'static str, pub message: String }
    pub struct ReconciledBackendAuthority {
        pub managed_authority: Option<crate::dure_backend_transport::BackendProfile>,
    }
    pub fn prepare_startup_channel(_: &str, _: &std::path::Path) -> Result<(), String> {
        panic!("fixture must inject preparation; no CLI installation")
    }
    pub fn reconcile_backend_from_current_channel(_: &str, _: Option<&str>) -> Result<ReconciledBackendAuthority, BackendReconcileError> {
        panic!("fixture must inject reconciliation; no live backend access")
    }
}
${["process_liveness", "app_channel", "app_instance", "dure_backend_coordinator"].map(module).join("\n")}
`);
  const environment = {
    ...process.env,
    ...rustToolchainTestEnvironment(),
    CARGO_HOME: process.env.CARGO_HOME || join(homedir(), ".cargo"),
    CARGO_TARGET_DIR: join(root, "target"),
    CARGO_TERM_PROGRESS_WHEN: "never",
    CARGO_TERM_COLOR: "never",
    HOME: home,
    DURE_HOME: join(root, "dure-home"),
    HMUX_DISCOVERY_ROOT: join(root, "hmux-discovery"),
  };
  console.log(`Isolated native module fixture: ${root}`);
  const result = spawnSync("cargo", [
    "test", "--offline", "--manifest-path", join(root, "Cargo.toml"), "--lib",
  ], {
    cwd: root, env: environment, encoding: "utf8",
    timeout: 180_000, maxBuffer: 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  // Retain this disposable build cache for inspection and reuse.
} finally {
  admission.reservation?.release();
}
