import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const home = realpathSync(required("HOME"));
if (home !== realpathSync(path.join(required("DURE_QA_STATE_ROOT"), "home"))) {
  throw new Error("program status HOME escaped its isolated root");
}

// Process inspection recognizes a provider by its executable name, so a link
// to Node stands in for a hand-started Codex CLI in a plain terminal pane.
const bin = path.join(home, ".local", "bin");
mkdirSync(bin, { mode: 0o700, recursive: true });
symlinkSync(realpathSync(process.execPath), path.join(bin, "codex-program-status-fixture"));

writeFileSync(path.join(home, "program-status-fixture.mjs"), `
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const control = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const signalled = async (name) => {
  while (!existsSync(join(control, name))) await sleep(50);
};
const report = (body) => process.stdout.write("\\x1b]7501;" + body + "\\x07");
const message = Buffer.from("Run cargo test?").toString("base64");

process.stdout.write("Program status fixture\\r\\n");
await signalled("program-status-block");
report("state=blocked:kind=permission:app=codex:msg=" + message);
await signalled("program-status-clear");
report("state=idle:app=codex");
await sleep(30_000);
`, { mode: 0o600 });
