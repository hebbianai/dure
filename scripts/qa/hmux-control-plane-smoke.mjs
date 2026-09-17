import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWithBuildStorage } from "../run-with-build-storage.mjs";
import { hmuxTestBinaries } from "../run-hmux-tests.mjs";

const test = process.argv[2];
if (!test || !process.env.DURE_HMUX_TEST_STATE_ROOT) {
  throw new Error("Select a control-plane smoke through scripts/run-hmux-tests.mjs");
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const toolchain = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (toolchain.status !== 0) throw new Error("Rust toolchain is unavailable");
const triple = process.env.CARGO_BUILD_TARGET ?? toolchain.stdout.match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error("Rust target is unavailable");
const suppliedCli = process.env.DURE_QA_HMUX_BIN;
const suppliedRuntime = process.env.DURE_QA_HMUX_RUNTIME;
const suppliedTest = process.env.DURE_QA_CONTROL_PLANE_TEST_BINARY;
if (suppliedTest && (!isAbsolute(suppliedTest) || !statSync(suppliedTest).isFile())) {
  throw new Error("DURE_QA_CONTROL_PLANE_TEST_BINARY must name an exact existing test artifact");
}
if (Boolean(suppliedCli) !== Boolean(suppliedRuntime)) {
  throw new Error("Provide both DURE_QA_HMUX_BIN and DURE_QA_HMUX_RUNTIME, or neither");
}
const { hmuxCli, hmuxRuntime } = hmuxTestBinaries(process.env);
const fixtureHome = mkdtempSync(join(tmpdir(), "dure-control-plane-qa-home-"));

function run(kind, args, environment = process.env) {
  const status = runWithBuildStorage([kind, "--", ...args], {
    cwd: root,
    environment,
  });
  if (status !== 0) throw new Error(`Control-plane smoke exited with ${status}`);
}

if (!suppliedCli) {
  run("qa", ["sh", "scripts/build-hmux-product-runtime.sh", triple, "--", "cargo", "build", "--locked",
    "--manifest-path", "hmux/Cargo.toml", "--package", "hmux-cli", "--package", "hmux-runtime"]);
}
const invocation = suppliedTest
  ? [suppliedTest, test, "--ignored", "--nocapture"]
  : [process.execPath, join(root, "scripts/lib/native-build-slot.mjs"), "--",
    "cargo", "test", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml",
    "--package", "dure-control-plane", "--lib", test, "--", "--ignored", "--nocapture"];
run("cli", invocation, {
  ...process.env,
  CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
  RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
  HOME: fixtureHome,
  DURE_HOME: join(fixtureHome, "dure"),
  HMUX_DISCOVERY_ROOT: join(fixtureHome, "discovery"),
  DURE_QA_HMUX_BIN: hmuxCli,
  DURE_QA_HMUX_RUNTIME: hmuxRuntime,
});
