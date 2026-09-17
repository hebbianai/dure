import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stateRoot = process.env.DURE_HMUX_TEST_STATE_ROOT;
const discoveryRoot = process.env.HMUX_DISCOVERY_ROOT;
assert(stateRoot && discoveryRoot, "run through scripts/run-hmux-tests.mjs");
assert.equal(discoveryRoot, path.join(stateRoot, "hmux-discovery"));
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const root = path.join(stateRoot, "command-paste");
fs.mkdirSync(root, { mode: 0o700 });
const home = path.join(root, "home");
fs.mkdirSync(home, { mode: 0o700 });
const environment = { ...process.env, HOME: home };
delete environment.HMUX;
const provider = fileURLToPath(new URL("./fixtures/command-input-provider.py", import.meta.url));
const command = (args) => new Promise((resolve) => {
  execFile(cli, ["--discovery-root", discoveryRoot, "--json", ...args], {
    cwd: root, env: environment, timeout: 10_000, maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }));
});
function json(result) {
  assert(result.ok, JSON.stringify(result));
  return JSON.parse(result.stdout);
}
async function file(name) {
  const target = path.join(root, name);
  const deadline = performance.now() + 5000;
  while (!fs.existsSync(target)) {
    assert(performance.now() < deadline, `provider did not publish ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fs.readFileSync(target, "utf8");
}
let session;
try {
  json(await command(["new", "--name", "command-paste", "--runtime", runtime,
    "--", "python3", provider]));
  const sessions = json(await command(["ls"]));
  assert.equal(sessions.length, 1);
  [session] = sessions;
  await file("ready");
  const exact = ["--target", session.session_id, "--workspace", session.workspace_id];
  const long = "Long multiline assignment. 한국어 입력도 한 번만 제출합니다.\n".repeat(100);
  const cases = [
    { text: long, submit: true },
    { text: "next\n한국어\nassignment", submit: true },
    { text: "draft\n한국어", submit: false },
    { text: "", submit: true },
  ];
  const expected = [];
  let pending = "";
  for (const [step, entry] of cases.entries()) {
    const receipt = json(await command(["command-input", ...exact, "--text", entry.text,
      ...(entry.submit ? ["--submit"] : [])])).receipt;
    if (entry.text) assert.equal(receipt.text.state, "written_to_pty");
    if (entry.submit) assert.equal(receipt.submit.state, "written_to_pty");
    // Release only after both receipts; the peer may coalesce every byte.
    fs.writeFileSync(path.join(root, `release-${step}.json`), JSON.stringify(entry));
    const result = JSON.parse(await file(`result-${step}.json`));
    pending += entry.text;
    if (entry.submit) {
      expected.push(pending);
      pending = "";
    }
    console.log(JSON.stringify({ step, receipt, receivedBytes: result.bytes,
      submissions: result.submissions.length, draftBytes: Buffer.byteLength(result.draft) }));
    assert.equal(result.submissions.length, expected.length,
      "PTY receipts must leave one distinct Enter after the exact pasted body");
    assert.deepEqual(result.submissions, expected);
    assert.equal(result.draft, pending, "only explicit submit consumes the draft");
  }
} finally {
  if (session) {
    const cleanup = await command(["kill", session.session_id, "--workspace", session.workspace_id]);
    assert(cleanup.ok, JSON.stringify(cleanup));
  }
}
