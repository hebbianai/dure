import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

export async function run(executable, arguments_, options = {}) {
  const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "inherit"], ...options });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, `${path.basename(executable)} failed:\n${output}`);
  return output;
}

export async function cargoArtifacts(arguments_, { kind = "cli" } = {}) {
  const output = await run(process.execPath, ["scripts/run-with-build-storage.mjs", kind, "--", "cargo", ...arguments_, "--message-format=json"]);
  return output.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter((event) => event.reason === "compiler-artifact" && event.executable);
}

export async function cargoArtifact(arguments_, targetName, options) {
  const artifacts = (await cargoArtifacts(arguments_, options))
    .filter((event) => event.target.name === targetName);
  assert(artifacts.length, `Cargo did not publish ${targetName}`);
  return artifacts.at(-1).executable;
}
