import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

function fixture(cwd, sourceEnvironment = {}) {
  const calls = [], resolutions = [];
  return { calls, resolutions, run: (args) => collectBrowserCommand({ args, cwd, sourceEnvironment,
    resolveBackend: async (selection) => { resolutions.push(selection); return { profile: { id: "remote", transport: { kind: "ssh" } } }; },
    requestBackend: async (_profile, { body }) => { calls.push(body); return { result: { result: { control: {} } } }; },
  }) };
}

test("startup files cross the remote boundary as ordered contents in one creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-launch-scripts-"));
  try {
    const source = "window.order=['한글']; // $(touch /tmp/not-a-shell) `date` $HOME";
    await writeFile(join(root, "한글 file.js"), source);
    await writeFile(join(root, "empty.js"), "");
    const f = fixture(root);
    const result = await f.run(["create", "--idempotency-key", "launch-once", "--init-script", "한글 file.js", "--init-script=empty.js", "--init-script", "한글 file.js"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls, [{ kind: "create", operation_id: "launch-once", init_scripts: [source, "", source] }]);
    assert.equal(f.resolutions.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native startup environment files precede repeated explicit files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-launch-scripts-"));
  try {
    for (const [name, text] of [["first.js", "first"], ["second.js", "second"], ["last.js", "last"]]) await writeFile(join(root, name), text);
    const f = fixture(root, { AGENT_BROWSER_INIT_SCRIPTS: " first.js, ,second.js\n " });
    assert.equal((await f.run(["create", "--init-script", "last.js"])).ok, true);
    assert.deepEqual(f.calls[0].init_scripts, ["first", "second", "last"]);
    const plain = fixture(root);
    assert.equal((await plain.run(["create"])).ok, true);
    assert.equal(Object.hasOwn(plain.calls[0], "init_scripts"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid, unreadable, non-UTF8 and oversized startup files fail before backend contact", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-launch-scripts-"));
  try {
    await writeFile(join(root, "invalid.js"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, "large.js"), "한".repeat(21846));
    await writeFile(join(root, "half.js"), "a".repeat(33 * 1024));
    for (const files of [["missing.js"], ["."], ["invalid.js"], ["large.js"], ["half.js", "half.js"], Array(17).fill("half.js"), [""]]) {
      const f = fixture(root);
      const result = await f.run(["create", ...files.flatMap(file => ["--init-script", file])]);
      assert.equal(result.ok, false, JSON.stringify({ files, result }));
      assert.deepEqual(f.calls, []); assert.deepEqual(f.resolutions, []);
    }
    const f = fixture(root);
    assert.equal((await f.run(["reload", "resource", "--init-script", "half.js"])).ok, false);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.resolutions, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
