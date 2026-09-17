import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("./spawn-prompt-ssh-home-setup.mjs", import.meta.url),
);
const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-ssh-home-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const home = path.join(stateRoot, "home");
  const source = path.join(root, "source");
  fs.mkdirSync(home, { mode: 0o700, recursive: true });
  fs.mkdirSync(source, { mode: 0o700 });
  const keySource = path.join(source, "id_ed25519");
  const knownHostsSource = path.join(source, "known_hosts");
  fs.writeFileSync(keySource, "fixture-private-key\n", { mode: 0o600 });
  fs.writeFileSync(
    knownHostsSource,
    "192.0.2.10 ssh-ed25519 AAAAfixture\n",
    { mode: 0o600 },
  );
  return { home, keySource, knownHostsSource, root, stateRoot };
}

function run(input, overrides = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DURE_QA_SSH_HOST: "192.0.2.10",
      DURE_QA_SSH_KEY_SOURCE: input.keySource,
      DURE_QA_SSH_KNOWN_HOSTS_SOURCE: input.knownHostsSource,
      DURE_QA_SSH_PORT: "22",
      DURE_QA_PROJECT: "/home/dure/receipt-loss-project",
      DURE_QA_SSH_USER: "dure",
      DURE_QA_STATE_ROOT: input.stateRoot,
      HOME: input.home,
      ...overrides,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("SSH receipt-loss isolated home setup", () => {
  test("copies only the owned SSH material and publishes one project fixture", () => {
    const input = fixture();
    const sourceKey = fs.statSync(input.keySource);
    const sourceKnownHosts = fs.statSync(input.knownHostsSource);
    const sourceKeyBytes = fs.readFileSync(input.keySource, "utf8");
    const sourceKnownHostsBytes = fs.readFileSync(
      input.knownHostsSource,
      "utf8",
    );

    const result = run(input);

    expect(result.status, result.stderr).toBe(0);
    const sshRoot = path.join(fs.realpathSync(input.home), ".ssh");
    const keyPath = path.join(sshRoot, "dure-receipt-loss");
    const knownHostsPath = path.join(sshRoot, "known_hosts");
    expect(fs.readFileSync(keyPath, "utf8")).toBe("fixture-private-key\n");
    expect(fs.readFileSync(knownHostsPath, "utf8")).toBe(
      "192.0.2.10 ssh-ed25519 AAAAfixture\n",
    );
    expect(fs.statSync(sshRoot).mode & 0o777).toBe(0o700);
    const installedKey = fs.statSync(keyPath);
    const installedKnownHosts = fs.statSync(knownHostsPath);
    expect(installedKey.mode & 0o777).toBe(0o600);
    expect(installedKnownHosts.mode & 0o777).toBe(0o600);
    expect(installedKey.nlink).toBe(1);
    expect(installedKnownHosts.nlink).toBe(1);
    expect([installedKey.dev, installedKey.ino]).not.toEqual([
      sourceKey.dev,
      sourceKey.ino,
    ]);
    expect([installedKnownHosts.dev, installedKnownHosts.ino]).not.toEqual([
      sourceKnownHosts.dev,
      sourceKnownHosts.ino,
    ]);
    const sourceKeyAfter = fs.statSync(input.keySource);
    const sourceKnownHostsAfter = fs.statSync(input.knownHostsSource);
    expect(fs.readFileSync(input.keySource, "utf8")).toBe(sourceKeyBytes);
    expect(fs.readFileSync(input.knownHostsSource, "utf8")).toBe(
      sourceKnownHostsBytes,
    );
    expect([
      sourceKeyAfter.dev,
      sourceKeyAfter.ino,
      sourceKeyAfter.mode & 0o777,
    ]).toEqual([sourceKey.dev, sourceKey.ino, sourceKey.mode & 0o777]);
    expect([
      sourceKnownHostsAfter.dev,
      sourceKnownHostsAfter.ino,
      sourceKnownHostsAfter.mode & 0o777,
    ]).toEqual([
      sourceKnownHosts.dev,
      sourceKnownHosts.ino,
      sourceKnownHosts.mode & 0o777,
    ]);

    const directive = fs
      .readFileSync(path.join(input.stateRoot, "qa.autorun"), "utf8")
      .trim();
    expect(directive.startsWith("sshproject=")).toBe(true);
    const fixturePayload = JSON.parse(
      Buffer.from(directive.slice("sshproject=".length), "base64url").toString(
        "utf8",
      ),
    );
    expect(fixturePayload).toEqual({
      name: "receipt-loss",
      host: "192.0.2.10",
      user: "dure",
      port: 22,
      auth: "key",
      keyPath,
      expectedWorkspacePath: "/home/dure/receipt-loss-project",
    });
    expect(fs.statSync(path.join(input.stateRoot, "qa.autorun")).mode & 0o777).toBe(
      0o600,
    );
  });

  test("does not overwrite an existing runner-owned autorun", () => {
    const input = fixture();
    const autorun = path.join(input.stateRoot, "qa.autorun");
    fs.writeFileSync(autorun, "existing\n");

    const result = run(input);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(autorun, "utf8")).toBe("existing\n");
  });

  test("rejects a HOME outside the runner-owned state root", () => {
    const input = fixture();
    const outside = path.join(input.root, "outside-home");
    fs.mkdirSync(outside);

    const result = run(input, { HOME: outside });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "SSH receipt-loss HOME escaped its isolated root",
    );
    expect(fs.existsSync(path.join(outside, ".ssh"))).toBe(false);
  });
});
