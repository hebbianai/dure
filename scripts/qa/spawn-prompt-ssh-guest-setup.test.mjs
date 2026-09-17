import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("./spawn-prompt-ssh-guest-setup.sh", import.meta.url),
);
const roots = [];

function fixture() {
  const root = fs.mkdtempSync("/tmp/dure-spawn-prompt-ssh.");
  roots.push(root);
  const home = path.join(root, "home");
  const incoming = path.join(root, "incoming");
  fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700, recursive: true });
  fs.mkdirSync(incoming, { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".profile"), "# fixture profile\n");
  fs.writeFileSync(
    path.join(home, ".ssh", "authorized_keys"),
    "ssh-ed25519 AAAAlima lima-control\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(incoming, "client.pub"),
    "ssh-ed25519 AAAAclient generated-comment\n",
  );
  for (const name of ["claude"]) {
    fs.writeFileSync(path.join(incoming, name), "#!/bin/sh\nexit 0\n");
  }
  fs.writeFileSync(
    path.join(incoming, "dure-qa-fake-provider-common.sh"),
    "# fixture common\n",
  );
  return { home, root };
}

function run(input) {
  return spawnSync("sh", [script, input.root], {
    encoding: "utf8",
    env: { ...process.env, HOME: input.home },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("SSH receipt-loss guest setup", () => {
  test("installs ordinary key auth, providers, capture, and a committed project", () => {
    const input = fixture();

    const result = run(input);

    expect(result.status, result.stderr).toBe(0);
    const authorizedKeys = fs
      .readFileSync(path.join(input.home, ".ssh", "authorized_keys"), "utf8")
      .trim()
      .split("\n");
    expect(authorizedKeys).toEqual([
      "ssh-ed25519 AAAAlima lima-control",
      "restrict ssh-ed25519 AAAAclient dure-ssh-receipt-loss",
    ]);
    expect(authorizedKeys[1]).toContain("restrict");
    expect(authorizedKeys[1]).not.toContain("command=");
    expect(fs.statSync(path.join(input.home, ".ssh")).mode & 0o777).toBe(
      0o700,
    );
    expect(
      fs.statSync(path.join(input.home, ".ssh", "authorized_keys")).mode &
        0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(input.root, "bin", "claude")).mode & 0o777,
    ).toBe(0o700);
    expect(
      fs.statSync(
        path.join(input.root, "bin", "dure-qa-fake-provider-common.sh"),
      ).mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(input.root, "provider-capture")).mode & 0o777,
    ).toBe(0o700);
    const head = spawnSync(
      "git",
      ["-C", path.join(input.root, "project"), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    expect(head.status, head.stderr).toBe(0);
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/u);
    expect(fs.readFileSync(path.join(input.home, ".profile"), "utf8")).toContain(
      `. ${input.root}/provider-profile.sh`,
    );
    expect(
      fs.readFileSync(path.join(input.root, "provider-profile.sh"), "utf8"),
    ).toContain(`DURE_QA_CAPTURE_DIR='${input.root}/provider-capture'`);
    const login = spawnSync(
      "/bin/sh",
      [
        "-lc",
        [
          'printf "%s\\n"',
          '"$(command -v claude)"',
          '"$DURE_QA_CAPTURE_DIR"',
          '"$HEBBIAN_QA_CAPTURE_DIR"',
        ].join(" "),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: input.home },
      },
    );
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout.trim().split("\n")).toEqual([
      path.join(input.root, "bin", "claude"),
      path.join(input.root, "provider-capture"),
      path.join(input.root, "provider-capture"),
    ]);
  });

  test("rejects an alternate authorization for the same client key", () => {
    const input = fixture();
    fs.appendFileSync(
      path.join(input.home, ".ssh", "authorized_keys"),
      "restrict ssh-ed25519 AAAAclient alternate\n",
    );

    const result = run(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ambiguous authorization");
    expect(fs.existsSync(path.join(input.root, "project"))).toBe(false);
  });

  test("rejects a guest root containing path syntax", () => {
    const input = fixture();

    const result = run({ ...input, root: `${input.root}/nested` });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("guest root is unsafe");
    expect(fs.existsSync(path.join(input.root, "project"))).toBe(false);
  });
});
