import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { run, cargoArtifact } from "./managed-provider-fixture.mjs";

const requiredPath = (name) => {
  assert(process.env[name], `${name} must select the exact executable under qualification`);
  return fs.realpathSync(process.env[name]);
};
const opencode = requiredPath("DURE_QA_OPENCODE_BIN");
const hmuxRuntime = requiredPath("DURE_QA_HMUX_RUNTIME");
assert(process.env.DURE_HMUX_TEST_STATE_ROOT, "run this fixture through scripts/run-hmux-tests.mjs");
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), "oc");
fs.mkdirSync(root, { mode: 0o700 });
const home = path.join(root, "home");
fs.mkdirSync(home, { mode: 0o700 });
const observations = [];
let toolSequence = 0;
let releaseOfflineTurn;
const offlineTurnReleased = new Promise((resolve) => { releaseOfflineTurn = resolve; });

const server = http.createServer(async (request, response) => {
  if (request.url === "/fixture/release-offline-turn") {
    releaseOfflineTurn();
    response.writeHead(204).end();
    return;
  }
  let bytes = "";
  for await (const chunk of request) bytes += chunk;
  const body = JSON.parse(bytes);
  const mainTurn = body.tools?.some((tool) => tool.function?.name === "bash") === true;
  const users = body.messages?.filter((message) => message.role === "user") ?? [];
  const user = JSON.stringify(users.at(-1)?.content ?? "");
  const afterTool = body.messages?.at(-1)?.role === "tool";
  const needsPermission = mainTurn && user.includes("DURE_QA_PERMISSION") && !afterTool;
  observations.push({ model: body.model, effort: body.reasoning_effort, mainTurn, needsPermission });
  // The fourth tool turn cannot ask for approval until the first control
  // plane is gone. This proves the process owns policy without a timing guess.
  if (needsPermission && toolSequence === 3) await offlineTurnReleased;
  const delta = needsPermission ? {
    role: "assistant", tool_calls: [{ index: 0, id: `fixture-tool-${++toolSequence}`, type: "function", function: {
      name: "bash", arguments: JSON.stringify({ command: "printf dure-opencode-fixture", description: "Read the isolated fixture marker" }),
    } }],
  } : { role: "assistant", content: "Dure OpenCode fixture answer." };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [
    { id: "fixture-answer", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "fixture-answer", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: needsPermission ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } },
  ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
});

try {
  const testBinary = await cargoArtifact(["test", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml", "--package", "dure-control-plane", "--lib", "--no-run"], "dure_control_plane");
  const controlPlane = await cargoArtifact(["build", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml", "--package", "dure-control-plane", "--bin", "dure-control-plane"], "dure-control-plane");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const model = { name: "Fixture model", reasoning: true, variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } }, limit: { context: 8192, output: 1024 } };
  const env = {
    HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local/state"),
    DURE_HOME: path.join(home, "dure"), HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: ["fixture"], permission: { bash: "ask", edit: "ask" },
      provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only" }, models: { "fixture-model": model, "fixture-alternate": { ...model, name: "Fixture alternate" } } } }, model: "fixture/fixture-model",
    }),
    DURE_QA_OPENCODE_OFFLINE_RELEASE: `http://127.0.0.1:${server.address().port}/fixture/release-offline-turn`,
    DURE_QA_OPENCODE_BIN: opencode, DURE_QA_CONTROL_PLANE_BIN: controlPlane, DURE_QA_HMUX_RUNTIME: hmuxRuntime, DURE_QA_OPENCODE_RUNTIME_ROOT: root,
  };
  assert.equal((await run(opencode, ["--version"], { env })).trim(), "1.18.29", "qualify and update the pinned provider contract before changing this version");
  process.stdout.write(await run(testBinary, ["--ignored", "--exact", "managed_structured_runtime::opencode_tests::live_opencode_keeps_the_exact_conversation_across_settings_and_reconnect", "--nocapture"], { env }));
  const actual = observations.filter((entry) => entry.mainTurn);
  for (const [modelId, effort] of [["fixture-model", "low"], ["fixture-alternate", "low"], ["fixture-alternate", "high"]]) {
    assert(actual.some((entry) => entry.model === modelId && entry.effort === effort), `missing actual LLM request for ${modelId}/${effort}`);
  }
  assert.equal(actual.filter((entry) => entry.needsPermission).length, 4);
  const evidence = process.env.DURE_QA_OPENCODE_EVIDENCE ?? `/tmp/dure-opencode-conformance-${process.pid}.json`;
  fs.writeFileSync(evidence, JSON.stringify({ version: "1.18.29", observations }, null, 2), { mode: 0o600 });
  console.log(`OpenCode 1.18.29 conformance passed; evidence: ${evidence}`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(`Isolated fixture root: ${root}`);
}
