import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devTreeEnvironment } from "./lib/dev-tree-environment.mjs";

assert.equal(process.platform, "win32", "This observation requires native Windows.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "dure-storage-env-")));
const isolated = devTreeEnvironment(root, "dev-storage-environment-fixture");
const smoke = fileURLToPath(new URL("./dev-launch-storage-smoke.mjs", import.meta.url));

try {
  const result = spawnSync(process.execPath, [smoke], {
    cwd: root, env: isolated, stdio: "inherit", windowsHide: true, timeout: 60_000,
  });
  assert.equal(result.status, 0, result.error?.message || "Isolated native storage smoke failed.");
} finally {
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith("dure-storage-env-"));
  rmSync(root, { recursive: true });
}
