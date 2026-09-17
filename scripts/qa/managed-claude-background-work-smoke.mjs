import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runNativeClaudeBackgroundWork } from "./fixtures/claude-background-work.mjs";

const ownerRoot = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
assert.ok(path.basename(ownerRoot).startsWith("dure-hmux-test."), "Run under scripts/run-hmux-tests.mjs");
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const claude = fs.realpathSync(process.argv[2]);
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === "--delayed-completion"));
const hook = path.join(ownerRoot, "managed-claude-hook.py");
fs.writeFileSync(hook, fs.readFileSync(new URL("../../src-tauri/resources/managed-claude-hook.py", import.meta.url), "utf8")
  .replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', JSON.stringify(runtime)), { flag: "wx", mode: 0o600 });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const evidenceRoot = fs.mkdtempSync(path.join(path.dirname(ownerRoot), "dure-claude-background-evidence-"));
console.log(JSON.stringify({ evidenceRoot }));
await runNativeClaudeBackgroundWork({ ownerRoot, discoveryRoot: process.env.HMUX_DISCOVERY_ROOT, cli, runtime, claude,
  hookCommand: `/usr/bin/python3 ${quote(hook)} claude --managed-direct --terminal-events`, evidenceRoot,
  delayedCompletion: process.argv[3] === "--delayed-completion" });
