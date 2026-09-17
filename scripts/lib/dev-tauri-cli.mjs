import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);

export function resolveDevTauriCliEntrypoint(root) {
  const require = createRequire(join(root, "package.json"));
  const manifestPath = require.resolve("@tauri-apps/cli/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const relativePath =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tauri;
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error(
      "the installed @tauri-apps/cli package has no Tauri entrypoint",
    );
  }
  return resolve(dirname(manifestPath), relativePath);
}

export function devTauriCliInvocation(args) {
  return {
    command: process.execPath,
    args: [SELF, ...args],
  };
}

function main() {
  const entrypoint = resolveDevTauriCliEntrypoint(process.cwd());
  process.execve(
    process.execPath,
    [process.execPath, entrypoint, ...process.argv.slice(2)],
    process.env,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`dev Tauri CLI: ${error.message}\n`);
    process.exitCode = 1;
  }
}
