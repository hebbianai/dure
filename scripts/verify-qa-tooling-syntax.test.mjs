import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { syntaxCommand } from "./verify-qa-tooling-syntax.mjs";

const verifier = fileURLToPath(new URL("./verify-qa-tooling-syntax.mjs", import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "dure-qa-syntax-"));
  fixtures.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

describe("QA tooling syntax verification", () => {
  test.each([
    ["#!/usr/bin/env bash\n", "bash"],
    ["#!/bin/bash -e\n", "bash"],
    ["#! /usr/bin/env -S bash -eu\n", "bash"],
    ["#!/bin/sh\n", "sh"],
    ["#!/usr/bin/env sh\n", "sh"],
    ["#!/usr/bin/bashful\n", "sh"],
    ["echo no shebang\n#!/bin/bash\n", "sh"],
  ])("parses a script with shebang %j using %s", (source, shell) => {
    const file = join(fixture({ "script.sh": source }), "script.sh");
    expect(syntaxCommand(file)).toEqual([shell, ["-n", file]]);
  });

  // Linux runners use dash as sh. macOS ships it too, so both reproduce it.
  test.skipIf(!existsSync("/bin/dash"))("accepts bash scripts where sh is dash", () => {
    const root = fixture({
      "scripts/qa/guest.sh": '#!/usr/bin/env bash\nitems=(one two)\necho "${items[@]}"\n',
      "scripts/qa/portable.sh": "#!/bin/sh\nset -eu\necho ok\n",
    });
    mkdirSync(join(root, "bin"));
    symlinkSync("/bin/dash", join(root, "bin/sh"));
    const run = () =>
      spawnSync(process.execPath, [verifier], {
        cwd: root,
        env: { ...process.env, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}` },
        encoding: "utf8",
      });
    expect(run()).toMatchObject({ status: 0, stderr: "" });
    writeFileSync(join(root, "scripts/qa/portable.sh"), "#!/bin/sh\nitems=(one two)\n");
    const rejected = run();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("portable.sh");
  });
});
