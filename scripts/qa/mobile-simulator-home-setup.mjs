import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = realpathSync(process.env.HOME);
assert.equal(home, join(root, "home"), "QA login profile must stay in its disposable home");
assert.equal(realpathSync(process.env.HMUX_DISCOVERY_ROOT), join(root, "hmux-discovery"));
assert.ok(Number(process.versions.node.split(".")[0]) >= 20);
const node = realpathSync(process.execPath);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
// Provision the required runtime without importing the user's shell profiles.
for (const name of [".profile", ".bash_profile", ".zprofile"]) {
  writeFileSync(join(home, name), `export PATH=${quote(dirname(node))}:"$PATH"\n`, { flag: "wx", mode: 0o600 });
}
const resolved = execFileSync("/bin/zsh", ["-lc", "command -v node"], {
  env: { ...process.env, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000,
}).trim();
assert.equal(realpathSync(resolved), node, "A minimal GUI PATH must resolve the provisioned Node");
