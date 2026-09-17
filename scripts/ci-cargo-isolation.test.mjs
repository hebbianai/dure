import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const prepareScript = path.join(
  repositoryRoot,
  "scripts",
  "prepare-ci-cargo-home.sh",
);
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ci-cargo-isolation-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function runPrepare({ cargoHome, home, runnerTemp }) {
  const githubEnvironmentDirectory = path.join(
    runnerTemp,
    "_runner_file_commands",
  );
  const githubEnvironment = path.join(
    githubEnvironmentDirectory,
    "set_env_test",
  );
  fs.mkdirSync(githubEnvironmentDirectory);
  fs.writeFileSync(githubEnvironment, "");

  const result = spawnSync("sh", [prepareScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_HOME: cargoHome,
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: githubEnvironment,
      GITHUB_JOB: "verify",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "12345",
      HEBBIAN_CI_RUNNER_TEMP: runnerTemp,
      HOME: home,
    },
  });
  return { ...result, githubEnvironment };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("isolated Cargo home preparation", () => {
  test("creates only the exact runner-owned Cargo home", () => {
    const root = temporaryDirectory();
    const runnerTemp = path.join(root, "runner-temp");
    const home = path.join(root, "developer");
    const developerCargo = path.join(home, ".cargo");
    const cargoHome = path.join(runnerTemp, "hebbian-cargo-home");
    fs.mkdirSync(runnerTemp);
    fs.mkdirSync(developerCargo, { recursive: true });
    fs.writeFileSync(path.join(developerCargo, "sentinel"), "developer-owned");

    const result = runPrepare({ cargoHome, home, runnerTemp });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(developerCargo, "sentinel"), "utf8")).toBe(
      "developer-owned",
    );
    expect(
      fs.readFileSync(path.join(cargoHome, ".hebbian-ci-owner"), "utf8"),
    ).toBe("12345:2:verify\n");
    expect(fs.readFileSync(result.githubEnvironment, "utf8")).toBe(
      `CARGO_HOME=${fs.realpathSync(cargoHome)}\n`,
    );
    expect(fs.statSync(cargoHome).mode & 0o777).toBe(0o700);
  });

  test("refuses a developer Cargo home without changing it", () => {
    const root = temporaryDirectory();
    const runnerTemp = path.join(root, "runner-temp");
    const home = path.join(root, "developer");
    const developerCargo = path.join(home, ".cargo");
    fs.mkdirSync(runnerTemp);
    fs.mkdirSync(developerCargo, { recursive: true });
    fs.writeFileSync(path.join(developerCargo, "sentinel"), "developer-owned");

    const result = runPrepare({
      cargoHome: developerCargo,
      home,
      runnerTemp,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exact runner-owned CARGO_HOME");
    expect(fs.readFileSync(path.join(developerCargo, "sentinel"), "utf8")).toBe(
      "developer-owned",
    );
    expect(fs.readFileSync(result.githubEnvironment, "utf8")).toBe("");
  });

  test("refuses a runner-temp symlink that escapes to developer state", () => {
    const root = temporaryDirectory();
    const runnerTemp = path.join(root, "runner-temp");
    const home = path.join(root, "developer");
    const developerCargo = path.join(home, ".cargo");
    const cargoHome = path.join(runnerTemp, "hebbian-cargo-home");
    fs.mkdirSync(runnerTemp);
    fs.mkdirSync(developerCargo, { recursive: true });
    fs.writeFileSync(path.join(developerCargo, "sentinel"), "developer-owned");
    fs.symlinkSync(developerCargo, cargoHome);

    const result = runPrepare({ cargoHome, home, runnerTemp });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not be a symlink");
    expect(fs.readFileSync(path.join(developerCargo, "sentinel"), "utf8")).toBe(
      "developer-owned",
    );
    expect(fs.readFileSync(result.githubEnvironment, "utf8")).toBe("");
  });
});
