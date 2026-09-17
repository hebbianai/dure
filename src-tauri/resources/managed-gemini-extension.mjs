import fs from "node:fs";
import { prepareHookExtension } from "./managed-hook-extension.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This versioned extension is shared by Dure channels. Each launch selects its
// own reporter, so installing another channel cannot redirect a running session.
const name = "dure-lifecycle-v1";
const command = 'if [ -n "$DURE_GEMINI_HOOK_PATH" ]; then exec node "$DURE_GEMINI_HOOK_PATH"; else printf "{}"; fi';
const hooks = Object.fromEntries(["SessionStart", "BeforeAgent", "BeforeModel", "AfterModel", "BeforeTool",
  "AfterTool", "Notification", "AfterAgent", "SessionEnd"].map((event) => [event, [{ hooks: [{
    type: "command", name: "dure-gemini-lifecycle", command, timeout: 3000,
  }] }]]));
const files = {
  "gemini-extension.json": JSON.stringify({ name, version: "1.0.0" }),
  "hooks/hooks.json": JSON.stringify({ hooks }),
};

export function prepareGeminiExtension(directory, environment = process.env) {
  const home = environment.GEMINI_CLI_HOME || environment.HOME || os.homedir();
  if (!path.isAbsolute(home)) throw new Error("Gemini home must be absolute");
  prepareHookExtension(directory, path.join(home, ".gemini"), files, "gemini-extension.json");
  return path.join(directory, "managed-gemini-hook.mjs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.stdout.write(prepareGeminiExtension(path.dirname(fileURLToPath(import.meta.url)))); }
  catch (error) {
    process.stderr.write(`Dure Gemini launch refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
