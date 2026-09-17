import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run under run-hmux-tests.mjs with explicit DURE_QA_HMUX_BIN / RUNTIME paths.
// No build, provider account, live discovery root, or application is used.
const stateRoot = process.env.DURE_HMUX_TEST_STATE_ROOT;
const discoveryRoot = process.env.HMUX_DISCOVERY_ROOT;
assert(stateRoot && discoveryRoot, "the isolated Hmux test guardian is required");
assert.equal(discoveryRoot, path.join(stateRoot, "hmux-discovery"));
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
// The unchanged CLI may drive a freshly built runtime during red/green. The
// real create/attach/probe handshake below proves their protocol compatibility.
assert(fs.statSync(cli).isFile() && fs.statSync(runtime).isFile());
const provider = fileURLToPath(new URL("./fixtures/pty-backpressure-provider.py", import.meta.url));
const mode = process.argv[2] ?? "duplex";
assert(["control", "duplex", "reply"].includes(mode));
const evidenceDirectory = process.env.DURE_QA_EVIDENCE_DIRECTORY;
if (evidenceDirectory) {
  assert(path.isAbsolute(evidenceDirectory));
  const directory = fs.lstatSync(evidenceDirectory);
  assert(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(directory.mode & 0o077, 0, "evidence must remain owner-only");
  assert.equal(directory.uid, process.getuid());
}
const fixtureRoot = path.join(stateRoot, mode);
fs.mkdirSync(fixtureRoot, { mode: 0o700 });
const fixtureHome = path.join(fixtureRoot, "home");
fs.mkdirSync(fixtureHome, { mode: 0o700 });
const environment = { ...process.env, HOME: fixtureHome };
delete environment.HMUX;

function command(args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile(cli, ["--discovery-root", discoveryRoot, "--json", ...args], {
      cwd: fixtureRoot,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      timeout,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? error.code ?? null : 0,
        signal: error?.signal ?? null,
        timedOut: error?.killed === true,
        stdout,
        stderr,
      });
    });
  });
}

function json(result) {
  assert(result.ok, JSON.stringify(result));
  return JSON.parse(result.stdout);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function marker(name, timeout) {
  const deadline = performance.now() + timeout;
  while (!fs.existsSync(path.join(fixtureRoot, name))) {
    if (performance.now() >= deadline) return false;
    await sleep(20);
  }
  return true;
}

const build = { mode, cli, runtime, capabilities: json(await command(["capabilities"])) };
console.log(JSON.stringify(build));
let session;
let input;
let finalInput;
let evidence;
try {
  const created = await command([
    "new", "--name", `pty-backpressure-${mode}`, "--runtime", runtime,
    "--", process.env.DURE_QA_PYTHON ?? "python3", provider, mode,
  ]);
  assert(created.ok, JSON.stringify(created));
  const sessions = json(await command(["ls"]));
  assert.equal(sessions.length, 1, "the fixture must own exactly one isolated session");
  [session] = sessions;
  assert(await marker("ready", 3_000), "provider did not establish the raw PTY");
  const exact = [session.session_id, "--workspace", session.workspace_id];
  const before = json(await command(["session", "probe", ...exact]));
  assert.equal(before.status, "healthy", "fixture must be healthy before pressure");
  const bytes = mode === "control" ? 64 : mode === "reply" ? 1 : 64 * 1024;
  let inputResult = null;
  input = command(["send-keys", "--target", ...exact, "--literal", "x".repeat(bytes)]);
  input.then((result) => { inputResult = result; });
  const completed = await marker("complete", 5_000);
  const after = await command(["session", "probe", ...exact], 2_000);
  evidence = { ...build, observedAt: new Date().toISOString(), session, before, completed, after, input: inputResult };
  console.log(`pty_backpressure_evidence=${JSON.stringify(evidence)}`);
  if (evidenceDirectory) {
    fs.writeFileSync(path.join(evidenceDirectory, `${mode}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (!completed && process.platform === "darwin") {
      const samplePath = path.join(evidenceDirectory, `${mode}.sample.txt`);
      assert(!fs.existsSync(samplePath));
      await new Promise((resolve, reject) => {
        execFile("/usr/bin/sample", [String(session.host_process.process_id), "1", "10", "-file", samplePath], { timeout: 3_000 }, (error) => error ? reject(error) : resolve());
      });
      fs.chmodSync(samplePath, 0o600);
      console.log(`pty_backpressure_sample=${samplePath}`);
    }
  }
} finally {
  if (session) {
    // A deadlocked Host may reject a new termination handshake. The peer's
    // independent 15-second deadline breaks that cycle before guardian cleanup.
    const exact = [session.session_id, "--workspace", session.workspace_id];
    const stopped = await command(["kill", ...exact], 4_000);
    console.log(`pty_backpressure_cleanup=${JSON.stringify(stopped)}`);
    // A timeout is not evidence that the provider survived: the request may
    // already have killed it before its acknowledgement was lost. The outer
    // guardian verifies exact process departure and isolated-root retirement.
  }
  if (input) finalInput = await input;
}
assert(evidence.completed, "PTY peer could not complete the exact full-duplex transfer");
assert.equal(json(evidence.after).status, "healthy", "Host observer handshake lost liveness");
assert(finalInput?.ok, "input did not receive successful completion");
