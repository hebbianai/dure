import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// Only refusals are exercised here: each one exits before the first keychain
// command, so this suite never touches a developer's keychains. The import
// itself is covered on a GitHub-hosted macOS runner.
const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "manage-hosted-signing-keychain.sh",
);
const temporaryDirectories = [];

function runnerTemp() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-signing-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(action, environment) {
  return spawnSync("sh", [script, ...(action ? [action] : [])], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...environment },
  });
}

const hosted = (overrides = {}) => ({
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_TEMP: runnerTemp(),
  APPLE_CERTIFICATE: "Y2VydGlmaWNhdGU=",
  APPLE_CERTIFICATE_PASSWORD: "not-a-real-password",
  ...overrides,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("hosted signing keychain refusals", () => {
  test("requires an explicit action", () => {
    for (const action of [null, "import", "delete"]) {
      const result = run(action, hosted());
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("usage:");
    }
  });

  test.each(["prepare", "remove"])("%s runs only inside GitHub Actions", (action) => {
    const result = run(action, hosted({ GITHUB_ACTIONS: undefined }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only inside GitHub Actions");
  });

  test.each([
    ["prepare", "self-hosted"],
    ["remove", "self-hosted"],
    ["prepare", undefined],
  ])("%s never changes keychains on a %s runner", (action, environment) => {
    const temp = runnerTemp();
    const result = run(action, hosted({ RUNNER_ENVIRONMENT: environment, RUNNER_TEMP: temp }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside a disposable GitHub-hosted runner");
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  test.each(["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"])(
    "prepare names a missing %s without printing either secret",
    (name) => {
      const environment = hosted({ [name]: "" });
      const result = run("prepare", environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${name} is not configured`);
      for (const secret of [environment.APPLE_CERTIFICATE, environment.APPLE_CERTIFICATE_PASSWORD])
        if (secret) expect(result.stdout + result.stderr).not.toContain(secret);
      expect(fs.readdirSync(environment.RUNNER_TEMP)).toEqual([]);
    },
  );

  test.runIf(process.platform !== "darwin")("refuses a runner that is not macOS", () => {
    const environment = hosted();
    const result = run("prepare", environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("require macOS");
    expect(fs.readdirSync(environment.RUNNER_TEMP)).toEqual([]);
  });
});
