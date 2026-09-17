import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const previousRoot = path.resolve(toolDirectory, "../compat/previous");

export function assertPreviousTerminalStateReleaseFrozen(
  root = previousRoot,
) {
  const manifestPath = path.join(root, "SHA256SUMS");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  for (const line of manifest.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error("invalid previous terminal state checksum line");
    const [, expected, relative] = match;
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error("previous terminal state checksum escapes its root");
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`previous terminal state asset is not regular: ${relative}`);
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (actual !== expected) {
      throw new Error(`previous terminal state release drift: ${relative}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertPreviousTerminalStateReleaseFrozen();
}
