import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
if (home !== path.join(root, "home") ||
    fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT) !== path.join(root, "hmux-discovery") ||
    fs.realpathSync(process.env.DURE_HOME) !== path.join(home, ".dure")) {
  throw new Error("Successor QA requires the runner's disposable roots");
}
const bin = path.join(home, "successor-bin");
fs.mkdirSync(bin, { mode: 0o700 });
fs.mkdirSync(path.join(home, "successor-project"), { mode: 0o700 });
const completionPipe = path.join(home, "provider-completion.pipe");
execFileSync("/usr/bin/mkfifo", ["-m", "600", completionPipe]);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
// Both initial launch and the durable login-shell rehost recipe resolve this
// owned provider. No account configuration or credentials are copied.
fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log("codex successor QA fixture"); process.exit(0);
}
fs.appendFileSync(${JSON.stringify(path.join(home, "provider-starts"))}, "started\\n");
console.log("DURE_SUCCESSOR_QA_READY");
setTimeout(() => process.exit(0), 180_000);
fs.readFile(${JSON.stringify(completionPipe)}, () => process.exit(0));
`, { flag: "wx", mode: 0o700 });
for (const profile of [".zshenv", ".zprofile"]) {
  fs.writeFileSync(path.join(home, profile), `export PATH=${quote(bin)}:"$PATH"\n`, { flag: "wx", mode: 0o600 });
}
assert.equal(execFileSync("/bin/zsh", ["-lc", "command -v codex"], { encoding: "utf8" }).trim(), path.join(bin, "codex"));
fs.writeFileSync(path.join(root, "qa.autorun"), "", { flag: "wx", mode: 0o600 });
