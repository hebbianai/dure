import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const homes = [];
const input = {
  state: "The app crashes.",
  questions: { bug: { type: "noul", instructions: "Is this a bug report?" } },
};
afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dure-jev-"));
  homes.push(root);
  const environment = scriptTestEnvironment({
    HOME: root,
    DURE_HOME: join(root, "dure"),
    HMUX_DISCOVERY_ROOT: join(root, "discovery"),
  });
  return { root, environment };
}

function run(args, { root, environment, preload }, stdin = "") {
  return spawnSync(process.execPath, [...(preload ? ["--import", preload] : []), cli, ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
    input: stdin,
  });
}

describe("dure jev", () => {
  it.each([["jev"], ["jev", "--help"], ["help", "jev"]].map((args) => ({ args })))(
    "discovers usage without an app or API key (%#)",
    ({ args }) => {
      const result = run(args, fixture());
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("TYPESAFE_API_KEY");
      expect(result.stdout).toContain("choice");
    },
  );

  it.each(["file", "stdin"])("evaluates %s through the real CLI entrypoint", (mode) => {
    const context = fixture();
    const source = join(context.root, "request with spaces.json");
    writeFileSync(source, JSON.stringify(input));
    context.preload = join(context.root, "fetch-fixture.mjs");
    writeFileSync(
      context.preload,
      `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
        assert.equal(options.headers.Authorization, 'Bearer fixture-key');
        assert.equal(JSON.parse(options.body).questions.bug.type, 'noul');
        return Response.json({ model: 'jev-1.13.0', answers: { bug: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12, output_tokens: 3 } });
      };
    `,
    );
    context.environment.TYPESAFE_API_KEY = "fixture-key";
    const result = run(
      ["jev", "evaluate", mode === "stdin" ? "-" : source, "--json"],
      context,
      JSON.stringify(input),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.jev.evaluation",
      answers: { bug: { noul: 0.8 } },
    });
    expect(result.stdout).not.toContain("fixture-key");
  });

  it("reports a missing API key with exit 2 and machine-readable output", () => {
    const result = run(["jev", "evaluate", "-", "--json"], fixture(), JSON.stringify(input));
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("jev_api_key_missing");
    expect(result.stderr).toBe("");
  });

  it.each(
    [
      ["jev", "evaluate"],
      ["jev", "evaluate", "-", "--backend", "secret"],
      ["jev", "evaluate", "-", "--api-key", "secret"],
      ["jev", "evaluate", "-", "--json", "--json"],
      ["jev", "unknown"],
    ].map((args) => ({ args })),
  )("rejects unsupported or duplicate flags before input or network I/O (%#)", ({ args }) => {
    const result = run(args, fixture(), JSON.stringify(input));
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain("Usage:");
    expect(result.stdout + result.stderr).not.toContain("secret");
  });

  it.each(["not-json", "x".repeat(512 * 1024 + 1)])(
    "rejects invalid or oversized stdin (%#)",
    (stdin) => {
      const result = run(["jev", "evaluate", "-", "--json"], fixture(), stdin);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("jev_input_invalid");
    },
  );

  it("does not expose inaccessible input paths", () => {
    const context = fixture();
    const result = run(
      ["jev", "evaluate", join(context.root, "private-missing-file"), "--json"],
      context,
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("jev_input_invalid");
    expect(result.stdout).not.toContain("private-missing-file");
  });
});
