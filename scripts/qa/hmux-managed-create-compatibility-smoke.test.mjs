import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { scriptTestEnvironment } from "../lib/script-test-environment.mjs";

const source = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(process.platform === "win32")("managed-create smoke isolation", () => {
  test.each([true, false])("owns the runtime install root (ambient root: %s)", (inherited) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "managed-create-script-")),
    );
    try {
      const repository = path.join(root, "repository");
      const qa = path.join(repository, "scripts", "qa");
      const bin = path.join(root, "bin");
      const guardian = path.join(root, "guardian");
      const capture = path.join(root, "children.jsonl");
      for (const directory of [path.join(qa, "lib"), bin, guardian]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      const script = "hmux-managed-create-compatibility-smoke.sh";
      fs.copyFileSync(path.join(source, script), path.join(qa, script));
      fs.copyFileSync(
        path.join(source, "lib", "run-isolated-app.sh"),
        path.join(qa, "lib", "run-isolated-app.sh"),
      );
      // Only the actual shell wrappers run. Build, install and Cargo commands
      // are finite stand-ins that observe their received environment.
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      fs.writeFileSync(
        path.join(bin, "pnpm"),
        "#!/bin/sh\n[ \"$*\" = hmux:runtime:stage:dev ]\n",
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(bin, "rustc"),
        "#!/bin/sh\nprintf 'host: fixture-native\\n'\n",
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(bin, "cargo"),
        "#!/bin/sh\nexec node scripts/capture-child.mjs native\n",
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(repository, "scripts", "hmux-dev-build-id.mjs"),
        "console.log('fixture-build');\n",
      );
      fs.writeFileSync(
        path.join(repository, "scripts", "capture-child.mjs"),
        `import fs from "node:fs";
fs.appendFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({
  phase: process.argv[2] ?? "install",
  home: process.env.HOME,
  installRoot: process.env.HMUX_INSTALL_ROOT,
}) + "\\n");
`,
      );
      fs.writeFileSync(
        path.join(repository, "scripts", "install-dure-cli.mjs"),
        "import './capture-child.mjs';\n",
      );
      const result = spawnSync("sh", [path.join(qa, script)], {
        encoding: "utf8",
        env: scriptTestEnvironment({
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: path.join(root, "home"),
          DURE_HMUX_TEST_STATE_ROOT: guardian,
          HMUX_INSTALL_ROOT: inherited ? path.join(root, "ambient-install") : undefined,
          FIXTURE_CAPTURE: capture,
        }),
      });
      assert.equal(result.status, 0, result.stderr);
      const children = fs.readFileSync(capture, "utf8")
        .trim().split("\n").map(JSON.parse);
      const qaHome = path.join(guardian, "managed-create-home");
      assert.deepEqual(children, [
        {
          phase: "install",
          home: path.join(
            repository, "artifacts", "qa", "managed-create-compatibility-cli",
          ),
          installRoot: path.join(qaHome, "hmux-install"),
        },
        { phase: "native", home: qaHome, installRoot: path.join(qaHome, "hmux-install") },
      ]);
    } finally {
      // Every child is synchronous and finite; no detached Host is launched.
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
