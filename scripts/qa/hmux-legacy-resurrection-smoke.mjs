import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const hmux = process.env.HMUX_CLI_BIN ?? join(repositoryRoot, "hmux/target/debug/hmux");
const runtime =
  process.env.HMUX_RUNTIME_BIN ?? join(repositoryRoot, "hmux/target/debug/hmux-runtime");
const state = mkdtempSync(join(tmpdir(), "hmux-legacy-resurrection-"));
const discoveryRoot = join(state, "state/hmux-hosts");
const legacyRoot = join(state, "state/hmux-resurrection-v1");
const restoreCwd = join(state, "workspace");
const workspaceId = "workspace_0123456789abcdef";
const logicalSessionId = `resurrection_smoke_${process.pid}`;
const sessionName = `legacy-smoke-${process.pid}`;
let restored = false;

try {
  assert.equal(existsSync(hmux), true, `missing hmux binary: ${hmux}`);
  assert.equal(existsSync(runtime), true, `missing hmux-runtime binary: ${runtime}`);
  mkdirPrivate(discoveryRoot);
  mkdirPrivate(restoreCwd);
  const workspaceDigest = sha256(workspaceId);
  const records = join(legacyRoot, workspaceDigest, "records");
  mkdirPrivate(legacyRoot);
  mkdirPrivate(join(legacyRoot, workspaceDigest));
  mkdirPrivate(records);
  const legacyRecord = join(records, `${sha256(logicalSessionId)}.json`);
  writeFileSync(
    legacyRecord,
    JSON.stringify({
      schema_version: 1,
      logical_session_id: logicalSessionId,
      workspace_id: workspaceId,
      session_name: sessionName,
      restore_generation: 1,
      launch_recipe: {
        kind: "shell",
        program: "/bin/sh",
        arguments: [],
        restore_cwd: restoreCwd,
      },
      restore_policy: "safe_auto",
      predecessor_runtime: null,
      last_runtime: null,
      created_unix_ms: Date.now(),
      updated_unix_ms: Date.now(),
    }),
    { mode: 0o600 },
  );
  chmodSync(legacyRecord, 0o600);

  const receipt = runJson([
    "--discovery-root",
    discoveryRoot,
    "--json",
    "restore",
    sessionName,
    "--runtime",
    runtime,
  ]);
  restored = true;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.restored, true);
  assert.equal(receipt.migratedLegacyRecipe, true);
  assert.equal(receipt.sessionName, sessionName);

  runJson([
    "--discovery-root",
    discoveryRoot,
    "--json",
    "send-keys",
    "-t",
    sessionName,
    'printf "__HMUX_LEGACY_RESTORE_OK__:%s\\n" "$PWD"',
    "Enter",
  ]);
  const marker = `__HMUX_LEGACY_RESTORE_OK__:${realpathSync(restoreCwd)}`;
  const read = await pollForMarker(marker);
  assert.equal(read.lines.some((line) => line.includes(marker)), true);

  const currentRecipes = readdirSync(join(discoveryRoot, ".resurrection")).filter((name) =>
    name.endsWith(".json"),
  );
  assert.equal(currentRecipes.length, 1);
  const currentRecipe = JSON.parse(
    readFileSync(join(discoveryRoot, ".resurrection", currentRecipes[0]), "utf8"),
  );
  assert.deepEqual(currentRecipe.command, ["/bin/sh"]);
  assert.equal(currentRecipe.resurrectionReplayPolicy, "safe_interactive_shell");
  assert.equal(existsSync(legacyRecord), true, "legacy record was destructively removed");

  runJson(["--discovery-root", discoveryRoot, "--json", "kill", sessionName]);
  restored = false;
  console.log(
    JSON.stringify({
      ok: true,
      sessionName,
      migratedLegacyRecipe: true,
      inputReadVerified: true,
      legacyRecordRetained: true,
    }),
  );
} finally {
  if (restored) {
    run([
      "--discovery-root",
      discoveryRoot,
      "--json",
      "kill",
      sessionName,
    ], false);
  }
  rmSync(state, { recursive: true, force: true });
}

async function pollForMarker(marker) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const read = runJson([
      "--discovery-root",
      discoveryRoot,
      "--json",
      "read",
      sessionName,
      "--lines",
      "8",
    ]);
    if (read.lines.some((line) => line.includes(marker))) {
      return read;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`timed out waiting for restored shell marker: ${marker}`);
}

function runJson(arguments_) {
  return JSON.parse(run(arguments_, true).stdout);
}

function run(arguments_, check) {
  const environment = { ...process.env };
  for (const name of ["HMUX", "HMUX_SESSION_ID", "HMUX_SESSION_NAME", "HMUX_WORKSPACE_ID"]) {
    delete environment[name];
  }
  const result = spawnSync(hmux, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  if (check && result.status !== 0) {
    throw new Error(
      `hmux ${arguments_.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function mkdirPrivate(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
