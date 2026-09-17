import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-conversion-entry-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const qa = path.join(repo, "scripts", "qa");
  const bin = path.join(root, "bin");
  const source = path.join(root, "source-account");
  const target = path.join(root, "target");
  const calls = path.join(root, "calls.jsonl");
  for (const directory of [path.join(qa, "lib"), bin, source, path.join(target, "debug")])
    fs.mkdirSync(directory, { recursive: true });
  const executable = (file, text) => fs.writeFileSync(file, text, { mode: 0o755 });
  const record = (kind, extra = "") => `require('node:fs').appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({kind:'${kind}'${extra}})+'\\n')`;
  for (const name of ["codex", "claude", "git"]) executable(path.join(bin, name), "#!/bin/sh\nexit 0\n");
  executable(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n");
  executable(path.join(bin, "rustc"), "#!/bin/sh\nprintf 'host: fixture-target\\n'\n");
  for (const name of ["hmux", "hmux-runtime"]) executable(path.join(target, "debug", name), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(source, "auth.json"), "synthetic-auth-only");
  fs.writeFileSync(path.join(repo, "qa.log"), "preserve checkout log\n");
  fs.writeFileSync(path.join(repo, "qa.autorun"), "preserve checkout scenario\n");
  fs.copyFileSync(fileURLToPath(new URL("./hmux-session-conversion-smoke.sh", import.meta.url)), path.join(qa, "hmux-session-conversion-smoke.sh"));
  executable(path.join(repo, "scripts", "build-hmux-product-runtime.sh"), `#!/bin/sh\nnode -e "${record("private-build")}"\n`);
  fs.writeFileSync(path.join(qa, "managed-claude-hook-channel-handoff-smoke.mjs"), `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); ${record("unowned-hook")}\n`);
  executable(path.join(qa, "lib", "tauri-app-runner.sh"), `#!/bin/sh\nnode -e "${record("runner", ",layer:process.env.DURE_QA_LAYER,unique:process.env.DURE_QA_UNIQUE_APP_CHANNEL,client:process.env.DURE_QA_CLIENT,setup:process.env.DURE_QA_HOME_SETUP,source:process.env.HEBBIAN_QA_REAL_CODEX_HOME")}"\nexit "\${FIXTURE_RUNNER_STATUS:-0}"\n`);
  fs.writeFileSync(path.join(repo, "scripts", "run-with-build-storage.mjs"), `
    import { createRequire } from 'node:module';
    import { spawnSync } from 'node:child_process';
    const require = createRequire(import.meta.url);
    ${record("storage", ",args:process.argv.slice(2)")};
    const result = spawnSync(process.argv[4], process.argv.slice(5), {stdio:'inherit'});
    process.exit(result.status ?? 1);
  `);
  const run = (overrides = {}) => spawnSync("/bin/sh", [path.join(qa, "hmux-session-conversion-smoke.sh")], {
    cwd: repo, encoding: "utf8", timeout: 10_000,
    env: { ...withoutLocalGitOverrides(), PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: source, CODEX_HOME: source, HEBBIAN_QA_REAL_CODEX_HOME: source,
      CARGO_BUILD_TARGET: "", CARGO_TARGET_DIR: target, TMPDIR: root, FIXTURE_CALLS: calls, ...overrides },
  });
  return { repo, qa, source, run, calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [] };
}

test("hands conversion to the existing owned runner without rewriting checkout data", () => {
  const f = fixture();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(path.join(f.repo, "qa.log"))).toBe(true);
  expect(fs.readFileSync(path.join(f.repo, "qa.log"), "utf8")).toBe("preserve checkout log\n");
  expect(fs.readFileSync(path.join(f.repo, "qa.autorun"), "utf8")).toBe("preserve checkout scenario\n");
  const calls = f.calls();
  expect(calls.map(({ kind }) => kind)).toEqual(["storage", "runner"]);
  expect(calls[0].args).toEqual(["qa", "--", "sh", path.join(f.qa, "lib", "tauri-app-runner.sh")]);
  expect(calls[1]).toMatchObject({ layer: "background", unique: "1", source: f.source,
    client: path.join(f.qa, "hmux-session-conversion-client.mjs"), setup: path.join(f.qa, "hmux-session-conversion-home-setup.mjs") });
});

test("requires an explicitly selected account before any runner or build", () => {
  const f = fixture();
  const result = f.run({ HEBBIAN_QA_REAL_CODEX_HOME: "" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("HEBBIAN_QA_REAL_CODEX_HOME");
  expect(f.calls()).toEqual([]);
  expect(fs.readFileSync(path.join(f.repo, "qa.autorun"), "utf8")).toBe("preserve checkout scenario\n");
});

test("preserves a runner failure and leaves cleanup to its owner", () => {
  const f = fixture();
  const result = f.run({ FIXTURE_RUNNER_STATUS: "37" });
  expect(result.status).toBe(37);
  expect(fs.existsSync(path.join(f.repo, "qa.log"))).toBe(true);
  expect(fs.readFileSync(path.join(f.repo, "qa.autorun"), "utf8")).toBe("preserve checkout scenario\n");
});
