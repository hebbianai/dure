import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { devTreeEnvironment } from "./lib/dev-tree-environment.mjs";
import { createMacComputerDesktop } from "../../cli/lib/macos-computer-input.mjs";

if (process.platform !== "darwin" || !process.argv.includes("--foreground")) {
  throw new Error("This macOS smoke needs --foreground and an arranged test window; it temporarily activates only its own QA apps.");
}
const root = mkdtempSync(join(tmpdir(), "dure-computer-smoke-"));
const env = {
  ...devTreeEnvironment(join(root, "home"), "computer-smoke"),
  DURE_QA_APP_CHANNEL: "computer-smoke", DURE_COMPUTER_QA_FOREGROUND: "1",
  CLANG_MODULE_CACHE_PATH: join(root, "module-cache"),
};
for (const directory of [env.HOME, env.HMUX_DISCOVERY_ROOT, env.CLANG_MODULE_CACHE_PATH]) mkdirSync(directory, { recursive: true });
const runner = resolve("scripts/qa/lib/run-isolated-app.sh");
const owned = [];
const evidence = [];
const baselineIndex = process.argv.indexOf("--baseline-revision");
const baselineRevision = baselineIndex < 0 ? undefined : process.argv[baselineIndex + 1];
if (baselineIndex >= 0 && !/^[0-9a-f]{40}$/.test(baselineRevision ?? "")) {
  throw new Error("--baseline-revision requires an exact source commit SHA.");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function command(binary, args, timeout = 20_000) {
  return spawnSync("/bin/sh", [runner, binary, ...args], { env, encoding: "utf8", timeout });
}
function jxa(script) {
  const result = command("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function frontmost() {
  return jxa('ObjC.import("AppKit"); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);');
}
function state(slot) {
  try { return JSON.parse(readFileSync(join(root, `receiver-${slot}.json`), "utf8")); } catch { return null; }
}
async function waitFor(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function cli(args, path = resolve("cli/dure.mjs")) {
  const result = command(process.execPath, [path, "computer", ...args]);
  evidence.push({ args, baseline: path !== resolve("cli/dure.mjs"), status: result.status, stdout: result.stdout, stderr: result.stderr });
  return result;
}
let sequence = 0;
async function configure(slot, options = {}) {
  writeFileSync(join(root, `control-${slot}.json`), JSON.stringify({ reset: ++sequence, ...options }));
  await waitFor(() => state(slot)?.reset === sequence, `receiver ${slot} reset`);
}
function assertOwnedFocus() {
  const pid = frontmost();
  assert(owned.some((child) => child.pid === pid), "User changed focus; stop desktop QA.");
}
function makeApp(label, binary) {
  const name = `DureComputerQA-${label}-${basename(root).slice(-6)}`;
  const app = join(root, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  copyFileSync(binary, join(app, "Contents", "MacOS", name));
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string><key>CFBundleName</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>dev.dureai.qa.computer.${label}.${basename(root).slice(-6)}</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  return { app, executable: join(app, "Contents", "MacOS", name) };
}
async function launch(bundle, slot) {
  const child = spawn("/bin/sh", [runner, bundle.executable, root, slot], { env, stdio: "ignore" });
  owned.push(child);
  await waitFor(() => state(slot)?.pid === child.pid, `receiver ${slot}`);
  return child;
}
const original = frontmost();
const originalIdentity = jxa(`${createMacComputerDesktop.toString()}\nJSON.stringify(createMacComputerDesktop().observe(${original}));`);
let outcome = "failed";
try {
  const binary = join(root, "receiver");
  const build = command("/usr/bin/swiftc", [resolve("scripts/qa/computer-input-app.swift"), "-o", binary], 60_000);
  assert.equal(build.status, 0, build.stderr);
  const aBundle = makeApp("a", binary);
  const bBundle = makeApp("b", binary);
  const a = await launch(aBundle, "A");
  const b = await launch(bBundle, "B");
  const aName = jxa(`JSON.stringify(Application("System Events").applicationProcesses.whose({unixId:${a.pid}}).name()[0]);`);
  const desktopProbe = jxa(`${createMacComputerDesktop.toString()}\nJSON.stringify(createMacComputerDesktop().observe(${a.pid}));`);
  assert.equal(desktopProbe.pid, a.pid);
  assert(desktopProbe.generation);
  assert.equal(cli(["activate", "--pid", String(a.pid)]).status, 0);
  assertOwnedFocus();
  await configure("A");
  assert.equal(cli(["type", "--pid", String(a.pid), "ASCII delivery"]).status, 0);
  await waitFor(() => state("A")?.text === "ASCII delivery", "ASCII text");
  evidence.push({ scenario: "ASCII text", target: state("A") });
  await configure("A");
  const text = 'English 한글 😀 "QA" \\ path\nnext\tend';
  assert.equal(cli(["type", "--app", aName, "--text", text]).status, 0);
  await waitFor(() => state("A")?.text === text, "English and Korean Unicode text");
  assert.equal(state("B").text, "");
  assert.equal(cli(["key", "--pid", String(a.pid), "cmd+a"]).status, 0);
  await waitFor(() => state("A")?.selectionLength === text.length, "Command-A selection");
  assert.equal(cli(["type", "--pid", String(a.pid), "replacement"]).status, 0);
  await waitFor(() => state("A")?.text === "replacement", "selected text replacement");
  assert.equal(cli(["key", "--pid", String(a.pid), "return"]).status, 0);
  await waitFor(() => state("A")?.text === "replacement\n", "Return key");
  evidence.push({ scenario: "text-and-keys", state: "passed", target: state("A"), other: state("B") });

  assertOwnedFocus();
  const duplicate = await launch(aBundle, "duplicate");
  const ambiguous = cli(["type", "--app", aName, "blocked"]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /computer_app_ambiguous/);
  assert.equal(state("duplicate").text, "");
  duplicate.kill("SIGTERM");
  await waitFor(() => duplicate.exitCode !== null || duplicate.signalCode !== null, "duplicate exit");

  // Reproduce the previous fixed-delay implementation against owned receivers.
  await configure("B");
  await configure("A", { redirectPid: b.pid });
  assertOwnedFocus();
  assert.equal(cli(["activate", "--pid", String(b.pid)]).status, 0);
  if (baselineRevision) {
    const baseline = command("git", ["show", `${baselineRevision}:cli/dure.mjs`]);
    assert.equal(baseline.status, 0, baseline.stderr);
    const baselineDir = join(root, "baseline");
    mkdirSync(baselineDir);
    symlinkSync(resolve("cli/lib"), join(baselineDir, "lib"));
    const baselinePath = join(baselineDir, "dure.mjs");
    writeFileSync(baselinePath, baseline.stdout);
    const before = cli(["type", "--app", aBundle.app, "baseline-wrong-target"], baselinePath);
    assert.equal(before.status, 0, before.stderr);
    // The defect is any input reaching B. The old global dispatcher can also
    // lose characters, so do not require complete delivery to prove misrouting.
    await waitFor(() => state("B")?.text.length > 0, "baseline wrong receiver");
    assert("baseline-wrong-target".startsWith(state("B").text));
    assert.equal(state("A").text, "");
    evidence.push({ scenario: "before-focus-redirect", baselineRevision, state: "reproduced", target: state("A"), other: state("B") });
  }
  await configure("A", { redirectPid: b.pid });
  await configure("B");
  const after = cli(["type", "--pid", String(a.pid), "must-not-reach-B"]);
  assert.equal(after.status, 1);
  assert.match(after.stderr, /computer_activation_timeout|computer_focus_changed/);
  assert.equal(state("B").text, "");
  assert.equal(state("A").text, "");
  evidence.push({ scenario: "after-focus-redirect", state: "passed", target: state("A"), other: state("B") });

  assertOwnedFocus();
  await configure("A", { redirectPid: b.pid, redirectAfterCharacters: 3 });
  await configure("B");
  const partial = cli(["type", "--pid", String(a.pid), "z".repeat(200)]);
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /computer_input_unconfirmed/);
  await waitFor(() => state("A")?.text.length > 0 && state("B")?.active, "mid-input focus redirect");
  assert(state("A").text.length < 200);
  assert.equal(state("B").text, "");
  evidence.push({ scenario: "mid-input-focus-redirect", state: "passed", target: state("A"), other: state("B") });

  assertOwnedFocus();
  const exitBundle = makeApp("exit", binary);
  const exiting = await launch(exitBundle, "exit");
  await configure("exit", { exitOnActivation: true });
  const disappeared = cli(["type", "--pid", String(exiting.pid), "blocked"]);
  assert.equal(disappeared.status, 1);
  // Exit may be observed before dispatch or after the first post attempt.
  assert.match(disappeared.stderr, /computer_target_changed|computer_activation_failed|computer_input_unconfirmed/);
  await waitFor(() => exiting.exitCode !== null || exiting.signalCode !== null, "target exit");
  assert.equal(state("B").text, "");
  evidence.push({ scenario: "exit-during-activation", state: "passed", target: state("exit"), other: state("B") });
  outcome = "passed";
} catch (error) {
  evidence.push({ failure: String(error), receivers: [state("A"), state("B"), state("exit")] });
  process.exitCode = 1;
} finally {
  // Restore only if QA still owns focus. A user's subsequent selection wins.
  try {
    const currentFocus = frontmost();
    const restoreIdentity = jxa(`${createMacComputerDesktop.toString()}\nJSON.stringify(createMacComputerDesktop().observe(${original}));`);
    if (originalIdentity && restoreIdentity?.generation === originalIdentity.generation && owned.some((child) => child.pid === currentFocus)) {
      jxa(`ObjC.import("AppKit"); var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${original}); !a.isNil() && a.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);`);
    }
  } catch (error) {
    evidence.push({ cleanup: String(error) });
    outcome = "failed";
    process.exitCode = 1;
  }
  for (const child of owned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  writeFileSync(join(root, "evidence.json"), JSON.stringify({ outcome, evidence }, null, 2));
  console.log(JSON.stringify({ outcome, evidencePath: join(root, "evidence.json") }));
}
