import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  architectureFitnessBaseSha,
  readGodFileLinesAtRevision,
  resolveArchitectureFitnessCiBase,
} from "./lib/architecture-fitness-base.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const temporaryDirectories = [];
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const unsignedGitArguments = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "gpg.format=openpgp",
];

function git(root, ...args) {
  return execFileSync("git", [...unsignedGitArguments, ...args], {
    cwd: root,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  }).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("architecture fitness base", () => {
  test("prefers the Dure base while accepting the legacy verification base", () => {
    const dure = "a".repeat(40);
    const legacy = "b".repeat(40);
    expect(
      architectureFitnessBaseSha({
        DURE_ARCHITECTURE_BASE_SHA: dure,
        HEBBIAN_VERIFICATION_BASE_SHA: legacy,
      }),
    ).toBe(dure);
    expect(
      architectureFitnessBaseSha({
        HEBBIAN_VERIFICATION_BASE_SHA: legacy,
      }),
    ).toBe(legacy);
    expect(
      architectureFitnessBaseSha({
        DURE_ARCHITECTURE_BASE_SHA: "",
        HEBBIAN_VERIFICATION_BASE_SHA: legacy,
      }),
    ).toBe(legacy);
    expect(
      architectureFitnessBaseSha({
        DURE_ARCHITECTURE_BASE_SHA: "0".repeat(40),
      }),
    ).toBeNull();
  });

  test("reads exact base line counts without creating paths for missing files", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-architecture-base-"),
    );
    temporaryDirectories.push(root);
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.name", "Architecture Test");
    git(root, "config", "user.email", "architecture@example.com");
    git(root, "config", "commit.gpgsign", "true");
    git(root, "config", "gpg.format", "ssh");
    git(root, "config", "gpg.ssh.program", "/usr/bin/false");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/big.ts"), "one\ntwo\n");
    fs.writeFileSync(path.join(root, "src/[literal].ts"), "one\n");
    git(root, "add", "src/big.ts", "src/[literal].ts");
    git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");

    expect(
      readGodFileLinesAtRevision(root, base, [
        "src/missing.ts",
        "src/[literal].ts",
        "src/big.ts",
        "src/big.ts",
      ]),
    ).toEqual({
      "src/big.ts": 3,
      "src/[literal].ts": 2,
      "src/missing.ts": 0,
    });
    expect(fs.existsSync(path.join(root, "src/missing.ts"))).toBe(false);

    fs.appendFileSync(path.join(root, "src/big.ts"), "three\n");
    git(root, "add", "src/big.ts");
    git(root, "commit", "-m", "head");
    expect(resolveArchitectureFitnessCiBase(root, "")).toBe(base);
    expect(resolveArchitectureFitnessCiBase(root, base)).toBe(base);
  });

  test("carries a god-file line count across a detected Git rename", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-architecture-rename-"),
    );
    temporaryDirectories.push(root);
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.name", "Architecture Test");
    git(root, "config", "user.email", "architecture@example.com");
    fs.mkdirSync(path.join(root, "src"));
    const lines = Array.from(
      { length: 100 },
      (_, index) => `export const v${index} = ${index};`,
    );
    fs.writeFileSync(path.join(root, "src/big.ts"), `${lines.join("\n")}\n`);
    git(root, "add", "src/big.ts");
    git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");

    fs.mkdirSync(path.join(root, "src/domain"));
    git(root, "mv", "src/big.ts", "src/domain/big.ts");
    fs.appendFileSync(
      path.join(root, "src/domain/big.ts"),
      "export const grew = true;\n",
    );
    git(root, "add", "src/domain/big.ts");
    git(root, "commit", "-m", "move and grow");

    expect(
      readGodFileLinesAtRevision(root, base, ["src/domain/big.ts"]),
    ).toEqual({ "src/domain/big.ts": 101 });
  });

  test("rejects malformed bases before invoking Git", () => {
    expect(() =>
      architectureFitnessBaseSha({
        DURE_ARCHITECTURE_BASE_SHA: "main",
      }),
    ).toThrow("full 40-character commit SHA");
  });

  test("the CLI rejects growth that remains below the legacy ceiling", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-architecture-growth-"),
    );
    temporaryDirectories.push(root);
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.name", "Architecture Test");
    git(root, "config", "user.email", "architecture@example.com");
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(
      path.join(root, "src/big.ts"),
      `${Array.from({ length: 901 }, (_, index) => `export const v${index} = ${index};`).join("\n")}\n`,
    );
    fs.writeFileSync(
      path.join(root, "scripts/architecture-fitness-baseline.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        directTauriInvoke: {},
        concreteProviderBranch: {},
        concreteRuntimeBranch: {},
        godFileLines: { "src/big.ts": 903 },
      })}\n`,
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    fs.appendFileSync(path.join(root, "src/big.ts"), "export const grew = true;\n");

    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts/check-architecture-fitness.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...withoutLocalGitOverrides(),
          DURE_ARCHITECTURE_BASE_SHA: base,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "godFileGrowth: src/big.ts grew from 902 to 903 line(s)",
    );
    expect(result.stderr).not.toContain("baseline allows");
  });
});
