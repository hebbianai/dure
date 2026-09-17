import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(import.meta.url);

if (process.argv[2] === "--publish") {
  // Compile the existing pure publisher in an isolated process, without loading
  // the app's Vite configuration, starting its UI, or opening a listening port.
  const { createServer } = await import("vite");
  const root = realpathSync(process.argv[3]);
  assert.equal(dirname(root), realpathSync(tmpdir()), "publisher stays in the OS temporary root");
  assert.ok(basename(root).startsWith("dure-spaces-offline-"), "publisher uses its QA fixture root");
  const server = await createServer({
    configFile: false, root: repository, cacheDir: join(root, "vite-cache"),
    resolve: { alias: { "@": join(repository, "src") } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true }, appType: "custom",
  });
  try {
    const { buildDureClientPresentation } = await server.ssrLoadModule("/src/lib/persistence/dureClientPresentation.ts");
    const input = JSON.parse(readFileSync(join(root, "layout.json"), "utf8"));
    writeFileSync(join(root, "dure", "agents.json"), JSON.stringify({
      version: 3, updatedAt: Date.now(), agents: [],
      clientPresentation: buildDureClientPresentation(input),
    }), { mode: 0o600, flag: "wx" });
  } finally {
    await server.close();
  }
} else {
  const hmux = realpathSync(process.argv[2] ?? join(repository, "hmux/target/debug/hmux"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dure-spaces-offline-")));
  const environment = {
    TMPDIR: realpathSync(tmpdir()), PATH: process.env.PATH, HOME: join(root, "home"), DURE_HOME: join(root, "dure"),
    DURE_APP_CHANNEL: "stable", DURE_HMUX_BIN: hmux,
    HMUX_DISCOVERY_ROOT: join(root, "discovery"),
  };
  for (const directory of [environment.HOME, environment.DURE_HOME, environment.HMUX_DISCOVERY_ROOT]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const input = {
    spaces: [{ id: "desk-review", name: "Review Space" }], agents: [],
    layouts: { "desk-review": { panels: {
      "term:z": { contentComponent: "terminal", title: "Review terminal", params: { token: "qa-private-parameter" } },
      "browser:a": { contentComponent: "browser", title: "Documentation" },
    } } },
  };
  function run(args) {
    const result = spawnSync(process.execPath, args, {
      cwd: root, env: environment, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, "bounded isolated command");
    assert.equal(result.status, 0, `isolated command failed: ${result.stderr}`);
    return result.stdout;
  }
  let passed = false;
  try {
    writeFileSync(join(root, "layout.json"), JSON.stringify(input), { mode: 0o600 });
    run([script, "--publish", root]);
    // The publishing process has exited before any CLI read. Its durable file
    // is the only presentation authority; the real Hmux catalog is empty.
    assert.equal(existsSync(join(environment.DURE_HOME, "server.json")), false);
    const cli = join(repository, "cli/dure.mjs");
    const list = JSON.parse(run([cli, "spaces", "list", "--json"]));
    assert.deepEqual(list.spaces.map(({ id, name }) => ({ id, name })), [{ id: "desk-review", name: "Review Space" }]);
    const show = JSON.parse(run([cli, "spaces", "show", "Review Space", "--json"]));
    assert.equal(show.source.appDaemonRequired, false);
    assert.equal(show.space.id, "desk-review");
    assert.deepEqual(show.space.panes.map(({ id, title }) => ({ id, title })), [
      { id: "term:z", title: "Review terminal" }, { id: "browser:a", title: "Documentation" },
    ]);
    assert.equal(show.space.panes[0].runtime.reason, "session_binding_unavailable");
    assert.ok(!JSON.stringify(show).includes("qa-private-parameter"));
    const humanList = run([cli, "spaces", "list"]);
    assert.ok(humanList.includes("desk-review") && humanList.includes("Review Space"));
    const human = run([cli, "spaces", "show", "desk-review"]);
    assert.ok(human.includes("Review terminal") && human.includes("Documentation"));
    console.log(JSON.stringify({ scenario: "saved Spaces after publisher exit", spaces: list.spaces.length,
      panes: show.space.panes.length, publisherExited: true, appDaemonRequired: false, nativeHmux: true }));
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true });
    else console.error(`Failed offline QA fixture retained at ${root}`);
  }
}
