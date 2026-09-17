import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import { fixtureGitArguments } from "./git-test-fixture.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Git test fixture isolation", () => {
  it("ignores hostile global signing and credential helpers without mutating repository config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-git-fixture-"));
    roots.push(root);
    const home = path.join(root, "home");
    const repository = path.join(root, "repository");
    const signerMarker = path.join(root, "signer-called");
    const credentialMarker = path.join(root, "credential-called");
    const signer = path.join(root, "signer.sh");
    const credential = path.join(root, "credential.sh");
    fs.mkdirSync(home);
    fs.mkdirSync(repository);
    fs.writeFileSync(
      signer,
      `#!/bin/sh\nprintf called > ${JSON.stringify(signerMarker)}\nexit 1\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      credential,
      `#!/bin/sh\nprintf called > ${JSON.stringify(credentialMarker)}\nexit 1\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(home, ".gitconfig"),
      `[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tprogram = ${signer}\n[credential]\n\thelper = ${credential}\n`,
    );
    const environment = {
      ...withoutLocalGitOverrides(),
      HOME: home,
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (...args) =>
      execFileSync("git", fixtureGitArguments(...args), {
        cwd: repository,
        encoding: "utf8",
        env: environment,
      }).trim();

    git("init", "--quiet");
    fs.writeFileSync(path.join(repository, "fixture.txt"), "fixture\n");
    git("add", "fixture.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const credentialProbe = spawnSync(
      "git",
      fixtureGitArguments("credential", "fill"),
      {
        cwd: repository,
        encoding: "utf8",
        env: environment,
        input: "protocol=https\nhost=example.invalid\n\n",
      },
    );

    expect(git("rev-parse", "HEAD")).toMatch(/^[a-f0-9]{40,64}$/);
    expect(credentialProbe.status).not.toBe(0);
    expect(fs.existsSync(signerMarker)).toBe(false);
    expect(fs.existsSync(credentialMarker)).toBe(false);
    const localConfig = git("config", "--local", "--list");
    expect(localConfig).not.toContain("commit.gpgsign");
    expect(localConfig).not.toContain("credential.helper");
  });
});
