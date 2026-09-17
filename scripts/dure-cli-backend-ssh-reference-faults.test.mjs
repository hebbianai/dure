import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["catalog", "metadata-error"],
  ["catalog", "changed-identity"],
  ["catalog", "wrong-owner"],
  ["catalog", "read-replacement"],
  ["material", "metadata-error"],
  ["material", "changed-identity"],
  ["material", "wrong-owner"],
  ["material", "read-replacement"],
])("closes the opened %s descriptor after %s rejection", (target, fault) => {
  const root = mkdtempSync(join(tmpdir(), "ssh-reference-fault-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const material = join(root, "known-hosts");
  const catalog = join(root, "backend-ssh-references.json");
  writeFileSync(material, "fixture-only host key\n", { mode: 0o600 });
  writeFileSync(
    catalog,
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_ssh_references",
      references: [{
        reference: "known-hosts-profile:remote-a",
        kind: "known_hosts_file",
        path: material,
      }],
    }),
    { mode: 0o600 },
  );
  const resolver = new URL(
    "../cli/lib/backend-ssh-references.mjs",
    import.meta.url,
  ).href;
  const source = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalOpen = fs.openSync;
const originalStat = fs.fstatSync;
const originalRead = fs.readSync;
const target = ${JSON.stringify(target === "catalog" ? catalog : material)};
const fault = ${JSON.stringify(fault)};
let descriptor;
let injected = false;
fs.openSync = (path, ...args) => {
  const opened = originalOpen(path, ...args);
  if (path === target) descriptor = opened;
  return opened;
};
fs.fstatSync = (fd, ...args) => {
  const stat = originalStat(fd, ...args);
  if (fd !== descriptor || injected || fault === "read-replacement") return stat;
  injected = true;
  if (fault === "metadata-error") throw new Error("injected metadata error");
  if (fault === "changed-identity") stat.ino += 1n;
  if (fault === "wrong-owner") stat.uid += 1n;
  return stat;
};
fs.readSync = (fd, ...args) => {
  const count = originalRead(fd, ...args);
  if (fd === descriptor && !injected && fault === "read-replacement" && count > 0) {
    injected = true;
    const replacement = target + ".replacement";
    fs.copyFileSync(target, replacement);
    fs.chmodSync(replacement, 0o600);
    fs.renameSync(replacement, target);
  }
  return count;
};
syncBuiltinESMExports();
const { resolveBackendSshReferencesFromEnvironment } = await import(${JSON.stringify(resolver)});
assert.throws(() => resolveBackendSshReferencesFromEnvironment({
  auth: { kind: "ssh_agent" },
  profileId: "remote-a",
  trust: { kind: "known_hosts", reference: "known-hosts-profile:remote-a" },
}, { DURE_HOME: ${JSON.stringify(root)} }), { code: "backend_transport_reference_unavailable" });
assert.equal(injected, true, "the real opened-descriptor boundary must be reached");
assert.throws(() => originalStat(descriptor), { code: "EBADF" }, "the rejected descriptor must be closed");
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
