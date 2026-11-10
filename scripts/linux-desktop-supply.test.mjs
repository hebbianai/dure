import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { stageLinuxDesktop, supplyLinuxDesktop } from "./linux-desktop-supply.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const targets = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, env: withoutLocalGitOverrides(), encoding: "utf8" }).trim();
}

function write(file, body, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
}

function repository() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dure-linux-supply-"));
  roots.push(parent);
  const root = path.join(parent, "repo");
  write(path.join(root, ".gitignore"), [
    "src-tauri/binaries/",
    "src-tauri/resources/hmux-remote/*/",
    "src-tauri/resources/remote-git-checkout-helper/*/",
    "",
  ].join("\n"));
  write(path.join(root, "hmux/Cargo.toml"), '[workspace.package]\nversion = "0.2.63"\n');
  git(parent, "init", "-q", root);
  git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "source");
  return { parent, root };
}

/** Builds that write labelled bytes where the real scripts write binaries. */
function supply(root, output, calls = []) {
  return supplyLinuxDesktop({
    root,
    output,
    platform: "darwin",
    arch: "arm64",
    environment: { PATH: process.env.PATH, CARGO_BUILD_TARGET: "inherited-target" },
    execute(command, args, options) {
      calls.push({
        command: [command, ...args].join(" "),
        target: options.env.CARGO_BUILD_TARGET ?? null,
        triples: options.env.HMUX_REMOTE_TRIPLES ?? null,
        ...(options.env.HMUX_BUILD_ID ? { buildId: options.env.HMUX_BUILD_ID } : {}),
      });
      if (args[0] === "scripts/stage-hmux-runtime.sh") {
        for (const name of ["hmux-runtime", "hmux"])
          write(path.join(options.env.HMUX_STAGE_ARTIFACT_DIR, name), `${name} ${options.env.CARGO_BUILD_TARGET}`, 0o755);
      }
      if (args[0] === "scripts/stage-hmux-remote-resources.sh") {
        for (const target of options.env.HMUX_REMOTE_TRIPLES.split(" ")) {
          const tree = path.join(root, "src-tauri/resources/hmux-remote", target);
          for (const name of ["hmux-runtime", "hmux"]) write(path.join(tree, "bin", name), `remote ${name} ${target}`, 0o755);
          write(path.join(tree, "install.json"), `{"target":"${target}"}\n`);
        }
      }
    },
    supplyHelper(repository) {
      const helper = path.join(repository, "src-tauri/resources/remote-git-checkout-helper");
      for (const target of targets) write(path.join(helper, target, "dure-git-checkout-helper"), `helper ${target}`, 0o755);
      write(path.join(helper, "artifact/checkout-helper.json"), '{"schemaVersion":2}\n');
      return helper;
    },
    verifyStatic() {},
  });
}

function stage(root, output, arch = "arm64", calls = []) {
  return stageLinuxDesktop({
    root,
    supply: output,
    platform: "linux",
    arch,
    stageHelper: (repository, directory) => calls.push(["helper", directory]),
    verifyStatic: (_root, target, file) => calls.push(["static", target, fs.readFileSync(file, "utf8")]),
    verifyRuntime: (_root, file) => calls.push(["runtime", path.basename(file)]),
  });
}

test("supply builds every Linux binary on the macOS host and records the source and digests", () => {
  const { parent, root } = repository();
  const output = path.join(parent, "supply");
  const calls = [];
  supply(root, output, calls);
  expect(calls).toEqual([
    // Ghostty's proof builder is a host tool: it never sees a cross target.
    ...targets.map((target) => ({ command: `node scripts/ensure-ghostty-vt-proof.mjs --target ${target}`, target: null, triples: null })),
    ...targets.map((target) => ({ command: "sh scripts/stage-hmux-runtime.sh release", target, triples: null })),
    // The SSH host runtimes carry their own id beside the macOS app's `.dure` trees.
    {
      command: "sh scripts/stage-hmux-remote-resources.sh release",
      target: null,
      triples: targets.join(" "),
      buildId: `0.2.63+${git(root, "rev-parse", "HEAD").slice(0, 12)}.dure-linux`,
    },
  ]);
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8"));
  expect(receipt.sourceCommit).toBe(git(root, "rev-parse", "HEAD"));
  expect(Object.keys(receipt.files)).toEqual([
    ...targets.flatMap((target) => [`hmux-remote/${target}/bin/hmux`, `hmux-remote/${target}/bin/hmux-runtime`, `hmux-remote/${target}/install.json`]).sort(),
    "remote-git-checkout-helper/aarch64-unknown-linux-musl/dure-git-checkout-helper",
    "remote-git-checkout-helper/artifact/checkout-helper.json",
    "remote-git-checkout-helper/x86_64-unknown-linux-musl/dure-git-checkout-helper",
    ...targets.flatMap((target) => [`sidecars/${target}/hmux`, `sidecars/${target}/hmux-runtime`]).sort(),
  ].sort());
  expect(() => supplyLinuxDesktop({ root, output: path.join(parent, "other"), platform: "linux", arch: "x64" }))
    .toThrow("macOS ARM64");
});

test.each([["arm64", "aarch64"], ["x64", "x86_64"]])(
  "stage on Linux %s places the static sidecars under the GNU desktop target and both remote runtimes",
  (arch, machine) => {
    const { parent, root } = repository();
    const output = path.join(parent, "supply");
    supply(root, output);
    // An earlier, different remote tree is replaced, not merged.
    write(path.join(root, "src-tauri/resources/hmux-remote", targets[0], "bin/stale"), "stale");
    const calls = [];
    expect(stage(root, output, arch, calls)).toBe(`${machine}-unknown-linux-gnu`);
    for (const name of ["hmux-runtime", "hmux"]) {
      const file = path.join(root, "src-tauri/binaries", `${name}-${machine}-unknown-linux-gnu`);
      expect(fs.readFileSync(file, "utf8")).toBe(`${name} ${machine}-unknown-linux-musl`);
      expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    }
    expect(fs.readdirSync(path.join(root, "src-tauri/binaries")).sort()).toEqual([
      `hmux-${machine}-unknown-linux-gnu`,
      `hmux-runtime-${machine}-unknown-linux-gnu`,
    ].sort());
    for (const target of targets) {
      const tree = path.join(root, "src-tauri/resources/hmux-remote", target);
      expect(fs.readdirSync(path.join(tree, "bin")).sort()).toEqual(["hmux", "hmux-runtime"]);
      expect(fs.statSync(path.join(tree, "bin/hmux-runtime")).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(tree, "install.json")).mode & 0o777).toBe(0o644);
    }
    expect(calls).toEqual([
      ["static", `${machine}-unknown-linux-musl`, `hmux-runtime ${machine}-unknown-linux-musl`],
      ["static", `${machine}-unknown-linux-musl`, `hmux ${machine}-unknown-linux-musl`],
      ["runtime", `hmux-runtime-${machine}-unknown-linux-gnu`],
      ["helper", path.join(output, "remote-git-checkout-helper")],
    ]);
  },
);

test.each([
  ["a changed file", (output) => fs.appendFileSync(path.join(output, "sidecars/x86_64-unknown-linux-musl/hmux"), "changed"), "digest changed"],
  ["an unlisted file", (output) => write(path.join(output, "sidecars/extra"), "extra"), "differ from its receipt"],
  ["a missing file", (output) => fs.rmSync(path.join(output, "hmux-remote/aarch64-unknown-linux-musl/install.json")), "differ from its receipt"],
  ["another commit", (_output, root) => {
    write(path.join(root, "next"), "next");
    git(root, "add", "next");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "next");
  }, "built from another commit"],
  ["a dirty checkout", (_output, root) => write(path.join(root, "untracked"), "dirty"), "clean source checkout"],
])("stage refuses %s before staging anything", (_name, change, message) => {
  const { parent, root } = repository();
  const output = path.join(parent, "supply");
  supply(root, output);
  change(output, root);
  expect(() => stage(root, output)).toThrow(message);
  expect(fs.existsSync(path.join(root, "src-tauri/binaries"))).toBe(false);
});

test("stage runs only on Linux x86_64 or arm64", () => {
  const { parent, root } = repository();
  const output = path.join(parent, "supply");
  supply(root, output);
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "riscv64"]])
    expect(() => stageLinuxDesktop({ root, supply: output, platform, arch })).toThrow("Linux x86_64 or arm64");
});
