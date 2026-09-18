import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { collectAgentRun } from "../../cli/lib/agent-run.mjs";
import { loadBackendProfiles } from "../../cli/lib/backend-profiles.mjs";
import { performBackendProfileRequest } from "../../cli/lib/backend-transport.mjs";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";
import { cargoArtifact, run } from "./managed-provider-fixture.mjs";

// Run through run-hmux-tests.mjs. Only the installed CLI, backend and provider
// participate; no desktop or WebView is started by this scenario.
const root = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
assert.match(path.basename(root), /^dure-hmux-test\./);
assert.equal(fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT), path.join(root, "hmux-discovery"));
const home = path.join(root, "home");
const self = fileURLToPath(import.meta.url);
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function provision() {
  const limited = fs.realpathSync(process.env.DURE_QA_CODEX_LIMITED_HOME);
  const allowed = fs.realpathSync(process.env.DURE_QA_CODEX_HOME);
  const codex = fs.realpathSync(process.env.DURE_QA_CODEX_BIN);
  const hmux = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
  const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
  const originals = [limited, allowed].map((directory) => path.join(directory, "auth.json"));
  const before = originals.map(digest);
  const principals = originals.map((file) => JSON.parse(fs.readFileSync(file, "utf8")).tokens?.account_id);
  assert.ok(principals.every((id) => typeof id === "string" && id.length > 0));
  assert.ok(principals[0] !== principals[1], "choose distinct limited and allowed test accounts");
  const backend = await cargoArtifact([
    "build", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml",
    "-p", "dure-control-plane", "--bin", "dure-control-plane", "--bin", "dure-claude-process-relay",
  ], "dure-control-plane");
  fs.mkdirSync(home, { mode: 0o700 });
  const install = path.join(home, ".local/share/hebbian-ide-cli");
  const bin = path.join(home, ".local/bin");
  const searchPath = [bin, path.dirname(process.execPath), path.dirname(codex), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env = {
    ...process.env, HOME: home, DURE_HOME: path.join(home, ".dure"),
    PATH: searchPath.join(":"), SHELL: "/bin/zsh",
    DURE_CLI_INSTALL_ROOT: install, DURE_CLI_INSTALL_DIR: bin,
    DURE_APP_CHANNEL: "stable", DURE_CONTROL_PLANE_BIN: backend,
    DURE_HMUX_BIN: hmux, DURE_HMUX_RUNTIME_BIN: runtime,
    DURE_HMUX_BUILD_ID: (await run(process.execPath, ["scripts/hmux-dev-build-id.mjs"])).trim(),
    HMUX_INSTALL_ROOT: path.join(root, "hmux-install"),
  };
  delete env.NODE_OPTIONS;
  delete env.DURE_ORCHESTRATION_HOME;
  fs.writeFileSync(path.join(home, ".zprofile"), `export PATH=${searchPath.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(":")}\n`, { mode: 0o600, flag: "wx" });
  for (const [source, destination] of [
    [limited, path.join(home, ".codex")],
    [allowed, path.join(home, ".dure/accounts/codex-qa-allowed")],
  ]) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, "auth.json"), path.join(destination, "auth.json"));
    fs.chmodSync(path.join(destination, "auth.json"), 0o600);
    assert.notEqual(fs.statSync(path.join(source, "auth.json")).ino, fs.statSync(path.join(destination, "auth.json")).ino);
    fs.writeFileSync(path.join(destination, "config.toml"), "mcp_servers = {}\n", { mode: 0o600, flag: "wx" });
  }
  try {
    console.log(JSON.stringify({ phase: "install", root, noDesktop: true }));
    process.stdout.write(await run(process.execPath, ["scripts/install-dure-cli.mjs"], { env }));
    process.stdout.write(await run("sh", ["scripts/qa/lib/run-isolated-app.sh", process.execPath, self, "--client"], { env }));
  } finally {
    assert.deepEqual(originals.map(digest), before, "the source credentials must remain unchanged");
  }
}

async function exercise() {
  assert.equal(fs.realpathSync(process.env.HOME), home);
  assert.equal(process.env.DURE_HOME, path.join(home, ".dure"));
  const cli = path.join(home, ".local/bin/dure");
  assert.ok(fs.realpathSync(cli).startsWith(`${home}/`));
  const project = path.join(home, "project");
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, "AGENTS.md"), "This is a disposable recovery test. Reply only with the requested marker. Do not use tools, inspect credentials, contact services or delegate.\n", { mode: 0o600, flag: "wx" });
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "QA source"]]) {
    await run("git", args, { cwd: project, env: withoutLocalGitOverrides() });
  }
  await run(cli, ["projects", "register", "qa-recovery", "--path", project, "--json"]);
  const profile = loadBackendProfiles().profiles.find((entry) => entry.id === "local");
  assert.ok(profile);
  const call = async (operation, body) => (await performBackendProfileRequest(profile, {
    operation, body,
  }, { deadlineMs: 185_000, maxResponseBytes: 2 * 1024 * 1024 })).result;
  const descriptor = JSON.parse(fs.readFileSync(path.join(home, ".dure/backend/control-plane.json"), "utf8"));
  assert.ok(descriptor.controlPlaneIdentity.executablePath.startsWith(`${home}/`));
  assert.equal(fs.existsSync(path.join(home, ".dure/server.json")), false, "there is no desktop broker");
  const registered = await call("provider_credential_profile.register", {
    schemaVersion: 1, providerId: "codex", referenceId: "qa-allowed", profileDirectoryName: "codex-qa-allowed",
  });
  const proof = randomUUID();
  const policy = JSON.parse(await run(cli, ["recovery", "put", "codex", "--enabled", "true", "--expected-revision", "0", "--idempotency-key", `qa-policy-${proof}`, "--accounts", JSON.stringify([{ profile: registered.profile, name: "QA allowed account" }])]));
  assert.equal(policy.policy.enabled, true);
  const marker = `QA_HEADLESS_RECOVERY_${proof}`;
  const input = `Reply exactly ${marker}. Do not use tools.`;
  const { report } = await collectAgentRun({
    projectId: "qa-recovery", providerId: "codex", agentName: `qa-recovery-${proof.slice(0, 8)}`,
    prompt: input, idempotencyKey: `qa-run-${proof}`, backend: { profile },
  });
  assert.equal(report.receipt?.state, "succeeded", JSON.stringify(report));
  const agentId = report.receipt.plan.agentId;
  try {
    const { binding } = await call("agent_conversation.inspect", { schemaVersion: 1, agentId });
    assert.ok(binding, "the headless Run starts a structured conversation");
    const deadline = Date.now() + 120_000;
    let page;
    while (Date.now() < deadline) {
      const result = await call("agent_conversation.read", {
        schemaVersion: 1, interactionSessionId: binding.interactionSessionId,
        direction: "tail", cursor: null, limit: 128,
      });
      assert.equal(result.read.type, "page");
      page = result.read.page;
      assert.equal(page.recovery?.stopped ?? null, null, JSON.stringify(page.recovery));
      if (page.recovery?.turnState === "accepted" && !page.activeTurn && page.rows.some(({ item }) =>
        item.body.type === "message" && item.body.role === "assistant" && item.body.markdown.trim() === marker)) break;
      await delay(100);
    }
    assert.equal(page?.recovery?.turnState, "accepted", JSON.stringify(page?.latestFailure));
    assert.equal(page.activeTurn, null);
    assert.equal(page.binding.providerConversationRef, binding.providerConversationRef);
    assert.equal(page.binding.executionProfile.reference_id, "qa-allowed");
    assert.equal(page.binding.executionProfile.credential_generation, registered.profile.credentialGeneration);
    const failure = page.rows.find(({ item }) => item.itemId === page.recovery.failureItemId)?.item;
    assert.equal(failure?.body.type, "lifecycle");
    assert.equal(failure.body.state, "turn_failed");
    assert.equal(failure.body.detail, "usage_limit", "this proof requires an actual provider limit");
    const retained = page.rows.filter(({ item }) => item.clientMessageId === page.recovery.attemptId && item.body.type === "message" && item.body.role === "user");
    assert.equal(retained.length, 1);
    assert.equal(retained[0].item.body.markdown, input);
    assert.ok(page.rows.some(({ item }) => item.body.type === "message" && item.body.role === "assistant" && item.body.markdown.trim() === marker));
    const status = JSON.parse(await run(cli, ["recovery", "status", agentId]));
    assert.deepEqual(status.recovery, page.recovery);
    const evidence = { proof, noDesktop: true, realProvider: true, naturalQuota: true, distinctProviderAccounts: true, backendGeneration: descriptor.generation, agentId, interactionSessionId: binding.interactionSessionId, recovery: page.recovery, providerReply: marker };
    if (process.env.DURE_QA_RECOVERY_EVIDENCE) fs.writeFileSync(process.env.DURE_QA_RECOVERY_EVIDENCE, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify(evidence));
  } finally {
    const stopped = await call("agent_runtime.stop", { schemaVersion: 1, agentId });
    assert.equal(stopped.stopped, true);
  }
}

if (process.argv[2] === "--client") await exercise();
else {
  assert.equal(process.argv.length, 2);
  await provision();
}
