import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runNativeClaudeBackgroundWork } from "./fixtures/claude-background-work.mjs";
import { runClaudeConversationContinuation } from "./fixtures/claude-conversation-continuation.mjs";
import { runNativeHookProbe } from "./managed-claude-native-hook-smoke.mjs";

const root = process.env.DURE_QA_STATE_ROOT;
const descriptor = process.env.DURE_QA_SERVER_DESCRIPTOR;
const channel = process.env.DURE_QA_APP_CHANNEL;
const claude = process.env.DURE_QA_CLAUDE_BIN;
assert(root && descriptor?.startsWith(`${root}/`) && channel?.startsWith("qa-") && claude,
  "Run through the isolated managed Claude hook app smoke");
const canonicalRoot = await realpath(root);
const settings = path.join(path.dirname(descriptor), "managed-claude-settings.json");
const deadline = Date.now() + 120_000;
let contents;
while (!contents && Date.now() < deadline) {
  try { contents = await readFile(settings); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!contents) await delay(250);
}
assert(contents, "App did not publish the managed Claude settings");
const runtime = await realpath(path.join(root, "home", ".local", "share", "hebbian-ide-cli", "channels", channel, "current", "bin", "dure-control-plane"));
assert(runtime.startsWith(`${canonicalRoot}/home/`) && runtime.includes("/versions/"));
const parsed = JSON.parse(contents);
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification"]) {
  const groups = parsed.hooks[event];
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hooks.length, 1);
  const hook = groups[0].hooks[0];
  assert.equal(await realpath(hook.command), path.join(await realpath(path.dirname(descriptor)), "managed-claude-hook-v2.sh"));
  assert.equal(await readFile(hook.command, "utf8"), `#!/bin/sh\nexec '${runtime.replaceAll("'", "'\"'\"'")}' managed-claude-hook\n`);
}
const probe = await mkdtemp(path.join(root, "dure-managed-claude-native-hook-"));
await runNativeHookProbe(probe, runtime, claude, settings);
assert.deepEqual(await readFile(settings), contents, "Provider execution changed app-owned settings");
console.log("Actual app publication and installed native companion: clean HOME, preserved hooks, and bounded stdin passed; report destination was an isolated HTTP fixture.");
await runClaudeConversationContinuation({
  ownerRoot: canonicalRoot,
  discoveryRoot: process.env.HMUX_DISCOVERY_ROOT,
  cli: process.env.DURE_HMUX_BIN,
  runtime: process.env.DURE_HMUX_RUNTIME_BIN,
  hook: parsed.hooks.Stop[0].hooks[0].command,
  appHome: path.join(root, "home", ".dure"),
  appChannel: channel,
  evidenceRoot: process.env.DURE_QA_EVIDENCE_DIR,
});
await runNativeClaudeBackgroundWork({
  ownerRoot: canonicalRoot,
  discoveryRoot: process.env.HMUX_DISCOVERY_ROOT,
  cli: process.env.DURE_HMUX_BIN,
  runtime: process.env.DURE_HMUX_RUNTIME_BIN,
  claude,
  hookCommand: `'${parsed.hooks.Stop[0].hooks[0].command.replaceAll("'", "'\\''")}'`,
  appHome: path.join(root, "home", ".dure"),
  appChannel: channel,
  evidenceRoot: process.env.DURE_QA_EVIDENCE_DIR,
  delayedCompletion: true,
});
assert.deepEqual(await readFile(settings), contents, "Native background work changed app-owned settings");
