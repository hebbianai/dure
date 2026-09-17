import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertIsolatedCleanupBoundary } from "./lib/isolated-hmux-session-cleanup.mjs";

const root = realpathSync(process.env.DURE_QA_STATE_ROOT);
assertIsolatedCleanupBoundary(root, process.env.HMUX_DISCOVERY_ROOT);
assert.equal(realpathSync(process.env.HOME), join(root, "home"));
const proof = process.env.DURE_QA_PANE_RESTART_PROOF;
assert.match(proof, /^[a-f\d-]{36}$/);
writeFileSync(join(root, "pane-restart.json"), JSON.stringify({
  schemaVersion: 1, proof, phase: "fresh",
}), { flag: "wx", mode: 0o600 });
// Never inherit a developer's unrelated autorun scenario through Vite.
writeFileSync(join(root, "qa.autorun"), "", { flag: "wx", mode: 0o600 });
