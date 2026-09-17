import fs from "node:fs";
import { prepareHookExtension } from "./managed-hook-extension.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This versioned extension is shared by Dure channels. Each launch selects its
// own reporter, so installing another channel cannot redirect a running session.
const name = "dure-lifecycle-v1";
const command = 'if [ -n "$DURE_QWEN_HOOK_PATH" ]; then exec node "$DURE_QWEN_HOOK_PATH"; else printf "{}"; fi';
const hooks = Object.fromEntries(["SessionStart", "UserPromptSubmit", "PreToolUse",
  "PostToolUse", "PostToolUseFailure", "Notification", "PermissionDenied", "Stop",
  "StopFailure", "SessionEnd"].map((event) => [event, [{ hooks: [{
    type: "command", command, timeout: 3,
  }] }]]));
const files = {
  "qwen-extension.json": JSON.stringify({ name, version: "1.0.0" }),
  "hooks/hooks.json": JSON.stringify({ hooks }),
};

export function prepareQwenExtension(directory, environment = process.env) {
  const home = environment.QWEN_HOME || path.join(environment.HOME || os.homedir(), ".qwen");
  if (!path.isAbsolute(home)) throw new Error("Qwen home must be absolute");
  prepareHookExtension(directory, home, files, "qwen-extension.json");
  return path.join(directory, "managed-qwen-hook.mjs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.stdout.write(prepareQwenExtension(path.dirname(fileURLToPath(import.meta.url)))); }
  catch (error) {
    process.stderr.write(`Dure Qwen launch refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
