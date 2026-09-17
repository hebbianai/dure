import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  CONTROL_PLANE_BUILD_ID,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_IDENTITY_API_VERSION,
  CONTROL_PLANE_IDENTITY_KIND,
} from "../cli/lib/control-plane-contract.mjs";
import { ensureHeadroom } from "./lib/build-storage-admission.mjs";
import {
  createDureCliInstallerFixture,
  dureCliInstallerFixtureEnvironment,
} from "./lib/dure-cli-install-test-fixture.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const roots = [];
const macosTest = it.skipIf(process.platform !== "darwin");
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function compileStartupFixture(root) {
  const source = fs.readFileSync("src-tauri/src/dure_cli_install.rs", "utf8");
  const outputContract = fs.readFileSync("crates/hebbian-bounded-process/src/lib.rs", "utf8")
    .match(/pub struct CommandOutput \{[\s\S]*?\n\}/)?.[0];
  if (!outputContract) throw new Error("bounded-process output contract is unavailable");
  const functions = [
    ["pub(crate) fn prepare_startup_channel(", "\npub(crate) fn reconcile_backend_from_current_channel("],
    ["fn required_channel_cli(", "\nfn install_failure_message("],
    ["fn channel_install_root(", "\npub(crate) fn resolve_channel_dure_command("],
    ["pub(crate) fn validate_executable_file(", "\nfn installation_state("],
    ["fn backend_reconcile_command(", "\nfn validate_backend_reconcile_receipt("],
    ["fn valid_token(", "\nfn valid_digest("],
  ].map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))));
  // Compile the actual startup/resolver source with only the Tauri/serde and
  // bounded-process runner replaced. Its output type comes from the real crate;
  // child programs and arguments are real, and the outer deadline bounds them.
  const rust = `
use std::{fs, path::{Path, PathBuf}, time::Duration};
use hebbian_bounded_process::CommandSpec;
#[path = ${JSON.stringify(path.resolve("src-tauri/src/dure_cli_install/commands.rs"))}]
mod commands;
use commands::resolve_channel_dure_payload;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_INSTALL_OUTPUT_BYTES: usize = 64 * 1024;
mod dirs { pub fn home_dir() -> Option<std::path::PathBuf> { std::env::var_os("HOME").map(Into::into) } }
mod app_channel {
  pub const APP_CHANNEL_ENV: &str = "DURE_APP_CHANNEL";
  pub fn current_name() -> Result<String, String> { Ok("stable".into()) }
}
#[derive(Debug)] struct BackendReconcileError { code: &'static str, message: String }
#[derive(PartialEq)] enum DureCliInstallScope { ChannelPinned, StableGlobal }
impl DureCliInstallScope { fn for_channel(channel: &str) -> Self { if channel == "stable" { Self::StableGlobal } else { Self::ChannelPinned } } }
fn read_cli_identity(_: &Path) -> Result<(), String> { Ok(()) }
fn install_failure_message(_: &[u8]) -> Option<String> { None }
mod hebbian_bounded_process {
  use std::process::ExitStatus;
  pub struct CommandSpec(std::cell::RefCell<std::process::Command>);
  impl CommandSpec {
    pub fn new(path: impl AsRef<std::ffi::OsStr>) -> Self { Self(std::cell::RefCell::new(std::process::Command::new(path))) }
    pub fn arg(&mut self, arg: impl AsRef<std::ffi::OsStr>) -> &mut Self { self.0.get_mut().arg(arg); self }
    pub fn args<I, S>(&mut self, args: I) -> &mut Self where I: IntoIterator<Item=S>, S: AsRef<std::ffi::OsStr> { self.0.get_mut().args(args); self }
    pub fn env(&mut self, key: impl AsRef<std::ffi::OsStr>, value: impl AsRef<std::ffi::OsStr>) -> &mut Self { self.0.get_mut().env(key, value); self }
    pub fn arguments(&self) -> Vec<std::ffi::OsString> { self.0.borrow().get_args().map(Into::into).collect() }
  }
  ${outputContract}
  pub struct Error;
  impl Error { pub fn stage(&self) -> &'static str { "fixture_spawn" } }
  pub fn run(command: &CommandSpec, _: std::time::Duration, limit: usize) -> Result<CommandOutput, Error> {
    let output = command.0.borrow_mut().output().map_err(|_| Error)?;
    Ok(CommandOutput { exceeded_limit: output.stdout.len() + output.stderr.len() > limit, status: output.status, stdout: output.stdout, stderr: output.stderr })
  }
}
${functions.join("\n")}
fn main() {
  let resources = PathBuf::from(std::env::args_os().nth(1).unwrap());
  if std::env::args().nth(2).as_deref() == Some("backend-command") {
    let profile = std::env::args().nth(3);
    match backend_reconcile_command(Path::new("/fixture/dure"), "stable", profile.as_deref()) {
      Ok(command) => for arg in command.arguments() { println!("{}", arg.to_str().unwrap()); },
      Err(error) => { eprintln!("{}", error.code); std::process::exit(2); }
    }
    return;
  }
  if let Err(error) = prepare_startup_channel("stable", &resources) { eprintln!("{error}"); std::process::exit(1); }
  println!("{}", required_channel_cli("stable", &dirs::home_dir().unwrap()).unwrap().display());
}
`;
  const filename = path.join(root, "startup.rs");
  const executable = path.join(root, "startup");
  fs.writeFileSync(filename, rust);
  const admission = ensureHeadroom({
    label: "packaged CLI startup fixture",
    reclaimOutputs: () => { throw new Error("fixture must not reclaim storage"); },
  });
  if (!admission.ok) throw new Error(admission.message);
  try {
    execFileSync("rustc", ["--edition=2021", filename, "-o", executable], { stdio: "pipe" });
  } finally {
    admission.reservation?.release();
  }
  return executable;
}

function packageFixture({ olderManagedInstall = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-package-"));
  roots.push(root);
  const repository = createDureCliInstallerFixture(root);
  const resources = path.join(root, "build-resources");
  const bundle = path.join(resources, "resources", "dure-cli");
  const controlPlane = path.join(root, "dure-control-plane");
  const identity = JSON.stringify({
    schemaVersion: 1,
    apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
    kind: CONTROL_PLANE_IDENTITY_KIND,
    buildId: CONTROL_PLANE_BUILD_ID,
    capabilities: CONTROL_PLANE_CAPABILITIES,
  });
  fs.writeFileSync(controlPlane, `#!/bin/sh\nprintf '%s\\n' '${identity}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "dure-claude-process-relay"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const buildEnvironment = dureCliInstallerFixtureEnvironment(repository, scriptTestEnvironment({
    HOME: path.join(root, "build-home"),
    DURE_CLI_INSTALL_ROOT: path.join(root, "build-install"),
    DURE_CLI_INSTALL_DIR: path.join(root, "build-bin"),
    DURE_CONTROL_PLANE_BIN: controlPlane,
    DURE_HMUX_BIN: controlPlane,
    DURE_HMUX_RUNTIME_BIN: controlPlane,
    DURE_HMUX_BUILD_ID: "hmux-package-test-v1",
    DURE_CLI_SOURCE_REVISION: "a".repeat(40),
  }));
  fs.mkdirSync(resources, { recursive: true });
  execFileSync(process.execPath, ["scripts/install-dure-cli.mjs", "--bundle", bundle], {
    cwd: repository, env: buildEnvironment, stdio: "pipe", timeout: 30_000,
  });
  const installedResources = path.join(root, "Dure with spaces.app", "Contents", "Resources");
  fs.mkdirSync(path.dirname(installedResources), { recursive: true });
  const configuration = JSON.parse(fs.readFileSync("src-tauri/tauri.macos.conf.json", "utf8"));
  // Match Tauri's macOS copy_dir: preserve symlinks and executable modes,
  // including under the restrictive umask used by isolated release fixtures.
  for (const [destination, source] of Object.entries(configuration.bundle.macOS.files)) {
    const target = path.join(path.dirname(installedResources), destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync("/bin/cp", ["-pR", path.join(resources, source), target]);
  }
  fs.rmSync(resources, { recursive: true });
  const startup = compileStartupFixture(root);
  const home = path.join(root, "clean-home");
  fs.mkdirSync(home);
  let oldVersion;
  if (olderManagedInstall) {
    const legacyTools = path.join(home, "legacy-tools");
    fs.mkdirSync(legacyTools);
    const hmux = path.join(legacyTools, "hmux");
    fs.copyFileSync(controlPlane, hmux);
    const installRoot = path.join(home, ".local", "share", "hebbian-ide-cli");
    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: repository,
      env: { ...buildEnvironment, HOME: home, DURE_CLI_SOURCE_REVISION: "b".repeat(40),
        DURE_CLI_INSTALL_ROOT: installRoot, DURE_CLI_INSTALL_DIR: path.join(home, ".local", "bin"),
        DURE_HMUX_BIN: hmux, DURE_HMUX_RUNTIME_BIN: hmux },
      stdio: "pipe", timeout: 30_000,
    });
    oldVersion = fs.realpathSync(path.join(installRoot, "current"));
  }
  // No build checkout, source executables, or staging install may survive.
  fs.rmSync(repository, { recursive: true });
  fs.rmSync(controlPlane);
  fs.rmSync(path.join(root, "dure-claude-process-relay"));
  const environment = scriptTestEnvironment({ HOME: home, PATH: "/usr/bin:/bin", DURE_APP_CHANNEL: "stable" });
  const runStartup = () => spawnSync(startup, [installedResources], { env: environment, encoding: "utf8", timeout: 30_000 });
  return { root, home, environment, runStartup, installedResources, oldVersion };
}

macosTest("app startup activates its bundle while recovery follows the selected backend", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-backend-command-"));
  roots.push(root);
  const executable = compileStartupFixture(root);
  const run = (profile) => spawnSync(executable, [root, "backend-command", ...(profile === undefined ? [] : [profile])], {
    encoding: "utf8", timeout: 10_000,
    env: scriptTestEnvironment({ HOME: root, DURE_HOME: path.join(root, "dure"), HMUX_DISCOVERY_ROOT: path.join(root, "discovery") }),
  });
  const startup = run();
  expect(startup.status, startup.stderr).toBe(0);
  expect(startup.stdout.trim().split("\n")).toEqual(["backend", "activate", "--json"]);
  const recovery = run("local");
  expect(recovery.status, recovery.stderr).toBe(0);
  expect(recovery.stdout.trim().split("\n")).toEqual(["backend", "reconcile", "--backend", "local", "--json"]);
  const invalid = run("--activate");
  expect(invalid.status).toBe(2);
  expect(invalid.stderr.trim()).toBe("backend_reconcile_profile_invalid");
}, 30_000);

macosTest("bootstraps the actual stable startup from a relocated package into an empty home without PATH Node", () => {
  const { home, environment, runStartup } = packageFixture();
  expect(fs.readdirSync(home)).toEqual([]);
  const result = runStartup();
  expect(result.status, result.stderr).toBe(0);
  const cli = result.stdout.trim();
  expect(cli).toContain(path.join(home, ".local", "share", "hebbian-ide-cli", "versions"));
  const command = path.join(home, ".local", "share", "hebbian-ide-cli", "bin", "dure");
  for (const executable of [cli, command]) {
    const version = spawnSync(executable, ["version", "--json"], { env: environment, encoding: "utf8", timeout: 15_000 });
    expect(version.status, version.stderr).toBe(0);
    expect(JSON.parse(version.stdout).command).toBe("dure");
  }
  const versionRoot = path.dirname(path.dirname(cli));
  const node = path.join(versionRoot, "bin", "node");
  const observe = spawnSync(node, ["--input-type=module", "-e", `
    import { pathToFileURL } from "node:url";
    const cli = ${JSON.stringify(cli)};
    const lib = ${JSON.stringify(path.join(versionRoot, "bin", "lib"))};
    const { bindBundledDureRuntime } = await import(pathToFileURL(lib + "/dure-cli-bundled-runtime.mjs"));
    const { resolveHmuxToolchainIdentity, resolveLocalBackendExecutable } = await import(pathToFileURL(lib + "/local-backend.mjs"));
    const { resolveBundledClaudeStructuredRuntime } = await import(pathToFileURL(lib + "/claude-structured-runtime.mjs"));
    bindBundledDureRuntime(cli);
    console.log(JSON.stringify({
      hmux: resolveHmuxToolchainIdentity(process.env),
      controlPlane: resolveLocalBackendExecutable(cli),
      claude: resolveBundledClaudeStructuredRuntime({ appRoot: process.env.HOME + "/.dure", cliScriptPath: cli }),
    }));
  `], {
    env: { ...environment, DURE_HMUX_BIN: "/missing-developer-hmux", DURE_HMUX_RUNTIME_BIN: "/missing-developer-runtime" },
    encoding: "utf8", timeout: 15_000,
  });
  expect(observe.status, observe.stderr).toBe(0);
  const runtime = JSON.parse(observe.stdout);
  expect(runtime.hmux.executablePath).toBe(path.join(versionRoot, "bin", "hmux"));
  expect(runtime.hmux.runtimeExecutablePath).toBe(path.join(versionRoot, "bin", "hmux-runtime"));
  expect(runtime.controlPlane).toBe(path.join(versionRoot, "bin", "dure-control-plane"));
  expect(runtime.claude.nodeBin).toBe(node);
  expect(runtime.claude.relayBin).toBe(path.join(versionRoot, "bin", "dure-claude-process-relay"));
}, 60_000);

macosTest("preserves existing stable installs, development channels, global commands, and provider files", () => {
  const { home, environment, runStartup, installedResources } = packageFixture();
  const installRoot = path.join(home, ".local", "share", "hebbian-ide-cli");
  const protectedFiles = [
    path.join(installRoot, "channels", "dev-owned", "owner"),
    path.join(home, ".local", "bin", "dure"),
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".codex", "auth.json"),
  ];
  for (const filename of protectedFiles) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "fixture-user-owned-data\n");
  }
  const first = runStartup();
  expect(first.status, first.stderr).toBe(0);
  const current = fs.readlinkSync(path.join(installRoot, "current"));
  const bundle = path.join(installedResources, "resources", "dure-cli", "current", "bin");
  const concurrentBootstrap = spawnSync(path.join(bundle, "node"), [path.join(bundle, "lib", "dure-cli-bootstrap.mjs"), home, "stable"], {
    env: environment, encoding: "utf8", timeout: 15_000,
  });
  expect(concurrentBootstrap.status, concurrentBootstrap.stderr).toBe(0);
  expect(JSON.parse(concurrentBootstrap.stdout).status).toBe("current");
  const second = runStartup();
  expect(second.status, second.stderr).toBe(0);
  expect(second.stdout).toBe(first.stdout);
  expect(fs.readlinkSync(path.join(installRoot, "current"))).toBe(current);
  for (const filename of protectedFiles) expect(fs.readFileSync(filename, "utf8")).toBe("fixture-user-owned-data\n");
}, 60_000);

macosTest("advances an older managed stable install to the shipped payload and preserves its rollback version", () => {
  const { home, environment, runStartup, oldVersion } = packageFixture({ olderManagedInstall: true });
  const oldMetadata = fs.readFileSync(path.join(oldVersion, "install.json"), "utf8");
  const result = runStartup();
  expect(result.status, result.stderr).toBe(0);
  const cli = result.stdout.trim();
  expect(path.dirname(path.dirname(cli))).not.toBe(oldVersion);
  expect(fs.readFileSync(path.join(oldVersion, "install.json"), "utf8")).toBe(oldMetadata);
  const version = spawnSync(path.join(home, ".local", "bin", "dure"), ["version", "--json"], {
    env: environment, encoding: "utf8", timeout: 15_000,
  });
  expect(version.status, version.stderr).toBe(0);
  expect(JSON.parse(version.stdout).buildId).toBe(path.basename(path.dirname(path.dirname(cli))));
}, 60_000);

macosTest("refuses to replace an incomplete existing installation", () => {
  const { home, runStartup } = packageFixture();
  const bin = path.join(home, ".local", "share", "hebbian-ide-cli", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const existing = path.join(bin, "dure");
  fs.writeFileSync(existing, "user-owned-incomplete-install");
  const result = runStartup();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Dure CLI bootstrap exited with exit status: 1");
  expect(fs.readFileSync(existing, "utf8")).toBe("user-owned-incomplete-install");
  expect(fs.existsSync(path.join(bin, "..", "current"))).toBe(false);
}, 60_000);

macosTest.each(["payload", "source-identity", "channel", "hmux-path"])("rejects a package with changed %s before promoting it", (change) => {
  const { home, runStartup, installedResources } = packageFixture();
  const versionRoot = fs.realpathSync(path.join(installedResources, "resources", "dure-cli", "current"));
  const metadataPath = path.join(versionRoot, "install.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (change === "payload") fs.appendFileSync(path.join(versionRoot, "bin", "hmux"), "# changed\n");
  if (change === "source-identity") metadata.bundle.app.sourceRevision = "b".repeat(40);
  if (change === "channel") metadata.bundle.app.channel = "dev-other";
  if (change === "hmux-path") metadata.bundle.hmux.executablePath = "../../outside";
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const result = runStartup();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Dure CLI bootstrap exited with exit status: 1");
  expect(fs.readdirSync(home)).toEqual([]);
}, 60_000);
