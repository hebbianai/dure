import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, writeFileSync, renameSync, symlinkSync, linkSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { directoryIdentity } from "./lib/atomic-directory-move.mjs";

const cli = fileURLToPath(new URL("./disk-gc.mjs", import.meta.url));
let root;
let repository;
let worktree;
let profile;
let environment;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dure-cache-only-")));
  repository = join(root, "repository");
  worktree = join(root, "open-pane");
  mkdirSync(repository);
  environment = withoutLocalGitOverrides({
    ...process.env,
    DURE_HOME: join(root, "state"),
    HMUX_DISCOVERY_ROOT: join(root, "discovery"),
  });
  const git = (...args) => execFileSync("git", args, {
    cwd: repository, env: environment, stdio: "pipe",
  });
  git("init", "--initial-branch=main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Cache fixture");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repository, "Cargo.toml"),
    '[package]\nname = "cache_fixture"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFileSync(join(repository, ".gitignore"), "target/\n");
  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, "src", "main.rs"), 'fn main() { println!("fixture"); }\n');
  git("add", ".");
  git("commit", "-m", "fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("worktree", "add", "-b", "open-pane", worktree);
  profile = join(worktree, "target", "debug");
  mkdirSync(join(profile, "incremental", "crate-session"), { recursive: true });
  mkdirSync(join(profile, "deps"));
  writeFileSync(join(profile, ".cargo-lock"), "");
  writeFileSync(join(profile, ".cargo-build-lock"), "");
  writeFileSync(join(profile, "incremental", "crate-session", "query-cache.bin"), "rebuildable");
  writeFileSync(join(profile, "deps", "libfixture-123.rlib"), "!<arch>\nrebuildable");
  writeFileSync(join(profile, "deps", "libfixture-123.rmeta"), "rust metadata");
  writeFileSync(join(profile, "deps", "libfixture-123.dylib"), "runtime library");
  writeFileSync(join(profile, "running-app"), "runtime binary");
  writeFileSync(join(worktree, "src", "main.rs"), "uncommitted work\n");
  mkdirSync(environment.DURE_HOME);
  writeFileSync(join(environment.DURE_HOME, "agents.json"), JSON.stringify({
    agents: [{ id: "open-agent", worktree }],
    clientPresentation: { complete: true, spaces: [{ panes: ["agent:open-agent"] }] },
  }));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(...args) {
  const result = spawnSync(process.execPath, [cli,
    "--worktree", worktree, "--all", "--json", ...args,
  ], { cwd: repository, env: environment, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  return { ...result, receipt: JSON.parse(result.stdout) };
}

function expectRetained() {
  expect(readFileSync(join(worktree, "src", "main.rs"), "utf8")).toBe("uncommitted work\n");
  expect(readFileSync(join(profile, "running-app"), "utf8")).toBe("runtime binary");
  expect(readFileSync(join(profile, "deps", "libfixture-123.dylib"), "utf8")).toBe("runtime library");
  expect(existsSync(join(profile, ".cargo-lock"))).toBe(true);
  expect(existsSync(join(profile, ".cargo-build-lock"))).toBe(true);
  expect(JSON.parse(readFileSync(join(environment.DURE_HOME, "agents.json"), "utf8"))
    .agents[0].id).toBe("open-agent");
}

describe("explicit cache-only disk reclamation", () => {
  function rustObject(name, filetype = 1) {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
    bytes.writeUInt32LE(filetype, 12);
    const path = join(profile, "deps", name);
    writeFileSync(path, bytes);
    return path;
  }

  it("reclaims standalone Rust Mach-O objects while preserving runtime outputs", () => {
    const object = rustObject("fixture.abc123.rcgu.o");
    run("--cache-only");
    expect(existsSync(object)).toBe(true);
    run("--cache-only", "--apply");
    expect(existsSync(object)).toBe(false);
    expectRetained();
  });

  it("retains ambiguous object files, executable headers, links and executable modes", () => {
    const retained = [
      rustObject("source.o"),
      rustObject("program.abc.rcgu.o", 2),
      rustObject("library.abc.rcgu.o", 6),
      rustObject("executable.abc.rcgu.o"),
      rustObject("shared.abc.rcgu.o"),
      rustObject("invalid.abc.rcgu.o"),
    ];
    chmodSync(retained[3], 0o700);
    const outside = join(worktree, "source-object.o");
    linkSync(retained[4], outside);
    writeFileSync(retained[5], "not an object file");
    const link = join(profile, "deps", "linked.abc.rcgu.o");
    symlinkSync(outside, link);
    run("--cache-only", "--apply");
    for (const path of [...retained, outside, link]) expect(existsSync(path)).toBe(true);
    expectRetained();
  });

  it("reclaims compiler caches with a pane open, preserving runtime files and WIP", () => {
    const result = run("--cache-only", "--apply");
    expect(existsSync(join(profile, "incremental", "crate-session", "query-cache.bin")))
      .toBe(false);
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(false);
    expect(existsSync(join(profile, "deps", "libfixture-123.rmeta"))).toBe(false);
    expect(result.receipt.removedBytes).toBeGreaterThan(0);
    expectRetained();
  });

  it("keeps dry runs and the default target GC non-destructive for open panes", () => {
    run("--cache-only");
    run("--apply", "--aggressive");
    expect(existsSync(join(profile, "incremental", "crate-session", "query-cache.bin")))
      .toBe(true);
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
    expectRetained();
  });

  it.each([".cargo-lock", ".cargo-build-lock"])("does not race a holder of %s", async name => {
    const object = rustObject("locked.abc123.rcgu.o");
    const holder = spawn("python3", ["-I", "-S", "-c", `
import fcntl, sys
with open(sys.argv[1], "r+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print("locked", flush=True)
    sys.stdin.read()
`, join(profile, name)], { stdio: ["pipe", "pipe", "pipe"] });
    const ended = once(holder, "exit");
    try {
      await once(holder.stdout, "data");
      const { receipt } = run("--cache-only", "--apply");
      expect(receipt.skipped).toContainEqual(expect.objectContaining({ reason: "cargo-build-lock-held" }));
      expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
      expect(existsSync(object)).toBe(true);
      expectRetained();
    } finally {
      holder.stdin.end();
      await ended;
    }
    const released = run("--cache-only", "--apply");
    expect(released.receipt.refused).toEqual([]);
    expect(released.receipt.skipped).toEqual([]);
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(false);
    expect(existsSync(object)).toBe(false);
  });

  it.each([".cargo-lock", ".cargo-build-lock"])("creates missing %s only when applying an authorized cache removal", name => {
    const missing = join(profile, name);
    unlinkSync(missing);
    run("--cache-only");
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
    run("--cache-only", "--apply");
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(false);
    expectRetained();
  });

  it("does not create lock evidence for a profile with no existing Cargo locks", () => {
    for (const name of [".cargo-lock", ".cargo-build-lock"]) unlinkSync(join(profile, name));
    const native = fileURLToPath(new URL("./native/cargo-cache-reclaim.py", import.meta.url));
    const result = spawnSync("python3", ["-I", "-S", native], {
      input: JSON.stringify({ operation: "apply", root: worktree, profile: "target/debug",
        rootIdentity: directoryIdentity(worktree), profileIdentity: directoryIdentity(profile) }),
      env: environment, encoding: "utf8",
    });
    expect(JSON.parse(result.stdout)).toEqual({ state: "refused", reason: "Cargo profile has no existing build lock" });
    expect(existsSync(join(profile, ".cargo-lock"))).toBe(false);
    expect(existsSync(join(profile, ".cargo-build-lock"))).toBe(false);
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
  });

  it.each(["symlink", "hardlink", "directory"])("refuses an unsafe %s Cargo lock without changing caches", kind => {
    const lock = join(profile, ".cargo-build-lock");
    const outside = join(root, "external-lock");
    writeFileSync(outside, "must survive");
    unlinkSync(lock);
    if (kind === "symlink") symlinkSync(outside, lock);
    else if (kind === "hardlink") linkSync(outside, lock);
    else mkdirSync(lock);
    const { receipt } = run("--cache-only", "--apply");
    expect(receipt.skipped).toContainEqual(expect.objectContaining({ path: profile }));
    expect(readFileSync(outside, "utf8")).toBe("must survive");
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
    expectRetained();
  });

  it("refuses linked cache directories before deletion and preserves external data", () => {
    const original = join(profile, "incremental");
    const outside = join(root, "source-must-survive");
    renameSync(original, outside);
    symlinkSync(outside, original, "dir");
    const { receipt } = run("--cache-only", "--apply");
    expect(receipt.skipped.length).toBeGreaterThan(0);
    expect(readFileSync(join(outside, "crate-session", "query-cache.bin"), "utf8")).toBe("rebuildable");
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
    expectRetained();
  });

  it("blocks a first split-directory Cargo consumer from another worktree during legacy cache removal", async () => {
    unlinkSync(join(profile, ".cargo-build-lock"));
    const native = fileURLToPath(new URL("./native/cargo-cache-reclaim.py", import.meta.url));
    const request = { operation: "apply", root: worktree, profile: "target/debug",
      rootIdentity: directoryIdentity(worktree), profileIdentity: directoryIdentity(profile) };
    // Pause the real reclaimer after it acquired its locks, before visiting any
    // cache entries. No lock operation or Cargo behavior is mocked.
    const reclaimer = spawn("python3", ["-I", "-S", "-c", `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cache_reclaim", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
visit = module.visit_incremental
def paused_visit(*args):
    module.visit_incremental = visit
    print("locked", flush=True)
    sys.stdin.readline()
    return visit(*args)
module.visit_incremental = paused_visit
print(json.dumps(module.reclaim(json.loads(sys.argv[2]))), flush=True)
`, native, JSON.stringify(request)], { cwd: worktree, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const reclaimed = once(reclaimer, "exit");
    const output = createInterface({ input: reclaimer.stdout });
    const lines = output[Symbol.asyncIterator]();
    let cargo;
    let cargoEnded;
    let stderr = "";
    try {
      expect((await lines.next()).value).toBe("locked");
      cargo = spawn("cargo", ["clean", "--dry-run", "--offline", "-p", "cache_fixture",
        "--manifest-path", join(repository, "Cargo.toml"), "--target-dir", join(repository, "target")], {
        cwd: repository,
        env: { ...environment, CARGO_HOME: join(root, "cargo-home"),
          CARGO_BUILD_BUILD_DIR: join(worktree, "target"), RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      cargoEnded = once(cargo, "exit");
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`Cargo never reached the lock: ${stderr}`)), 15_000);
        cargo.stderr.on("data", chunk => {
          stderr += chunk;
          if (/Blocking.*file lock/s.test(stderr)) { clearTimeout(deadline); resolve(); }
        });
        cargo.once("error", error => { clearTimeout(deadline); reject(error); });
        cargo.once("exit", () => {
          clearTimeout(deadline);
          if (!/Blocking.*file lock/s.test(stderr)) reject(new Error(`Cargo bypassed the reclaimer: ${stderr}`));
        });
      });
      expect(cargo.exitCode).toBeNull();
      expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
    } finally {
      reclaimer.stdin.end("continue\n");
      await reclaimed;
      if (cargoEnded) await cargoEnded;
      output.close();
    }
    expect(reclaimer.exitCode).toBe(0);
    expect(cargo.exitCode, stderr).toBe(0);
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(false);
    expectRetained();
  });

  it("retains archive symlinks and hard-linked outputs", () => {
    const archive = join(profile, "deps", "libfixture-123.rlib");
    const output = join(profile, "libfixture.rlib");
    linkSync(archive, output);
    const source = join(worktree, "src", "main.rs");
    symlinkSync(source, join(profile, "deps", "libsource-abc.rmeta"));
    const executable = join(profile, "deps", "libexecutable-abc.rlib");
    writeFileSync(executable, "executable output");
    chmodSync(executable, 0o700);
    run("--cache-only", "--apply");
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(output, "utf8")).toContain("rebuildable");
    expect(readFileSync(source, "utf8")).toBe("uncommitted work\n");
    expect(readFileSync(executable, "utf8")).toBe("executable output");
  });

  it("rejects a replaced profile generation at the native boundary", () => {
    const profileIdentity = directoryIdentity(profile);
    renameSync(profile, join(worktree, "target", "old-profile"));
    mkdirSync(join(profile, "incremental"), { recursive: true });
    writeFileSync(join(profile, "incremental", "source"), "foreign generation");
    const native = fileURLToPath(new URL("./native/cargo-cache-reclaim.py", import.meta.url));
    const result = spawnSync("python3", ["-I", "-S", native], {
      input: JSON.stringify({ operation: "apply", root: worktree, profile: "target/debug",
        rootIdentity: directoryIdentity(worktree), profileIdentity }),
      encoding: "utf8",
    });
    expect(JSON.parse(result.stdout).state).toBe("refused");
    expect(readFileSync(join(profile, "incremental", "source"), "utf8")).toBe("foreign generation");
  });

  it("requires an exact worktree scope before any cache mutation", () => {
    const result = spawnSync(process.execPath, [cli, "--cache-only", "--apply", "--json"], {
      cwd: repository, env: environment, encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("cache-worktree-scope-required");
    expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
  });

  it.each(["combined", "split"])("uses a lock that the installed Cargo itself respects (%s directories)", async layout => {
    const buildRoot = layout === "split" ? join(worktree, "target", "agent-tools-build") : join(worktree, "target");
    const lockProfile = join(buildRoot, "debug");
    const lockName = layout === "split" ? ".cargo-build-lock" : ".cargo-lock";
    mkdirSync(lockProfile, { recursive: true });
    writeFileSync(join(lockProfile, lockName), "");
    writeFileSync(join(worktree, "target", "CACHEDIR.TAG"),
      "Signature: 8a477f597d28d172789f06886806bc55\n");
    const holder = spawn("python3", ["-I", "-S", "-c", `
import fcntl, sys
with open(sys.argv[1], "r+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print("locked", flush=True)
    sys.stdin.read()
`, join(lockProfile, lockName)], { stdio: ["pipe", "pipe", "pipe"] });
    const holderEnded = once(holder, "exit");
    await once(holder.stdout, "data");
    const cargo = spawn("cargo", ["clean", "--dry-run", "--offline", "-p", "cache_fixture",
      "--manifest-path", join(worktree, "Cargo.toml"), "--target-dir", join(worktree, "target")], {
      cwd: worktree,
      env: { ...environment, CARGO_HOME: join(root, "cargo-home"),
        CARGO_BUILD_BUILD_DIR: buildRoot, RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cargoEnded = once(cargo, "exit");
    let stderr = "";
    try {
      const native = fileURLToPath(new URL("./native/cargo-cache-reclaim.py", import.meta.url));
      const attempted = spawnSync("python3", ["-I", "-S", native], {
        input: JSON.stringify({ operation: "apply", root: worktree,
          profile: lockProfile.slice(worktree.length + 1), rootIdentity: directoryIdentity(worktree),
          profileIdentity: directoryIdentity(lockProfile) }),
        encoding: "utf8",
      });
      expect(JSON.parse(attempted.stdout).state).toBe("busy");
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`Cargo never reached the lock: ${stderr}`)), 15_000);
        cargo.stderr.on("data", chunk => {
          stderr += chunk;
          if (/Blocking.*file lock/s.test(stderr)) { clearTimeout(deadline); resolve(); }
        });
        cargo.once("error", error => { clearTimeout(deadline); reject(error); });
        cargo.once("exit", () => {
          clearTimeout(deadline);
          if (!/Blocking.*file lock/s.test(stderr)) reject(new Error(`Cargo did not wait: ${stderr}`));
        });
      });
      expect(existsSync(join(profile, "deps", "libfixture-123.rlib"))).toBe(true);
    } finally {
      holder.stdin.end();
      await holderEnded;
      const [code] = await cargoEnded;
      expect(code, stderr).toBe(0);
    }
    expectRetained();
  });

  it.each(["combined", "split"])("keeps a real executable running and rebuilds the reclaimed Cargo dependency (%s directories)", async layout => {
    const buildRoot = join(worktree, "target", ...(layout === "split" ? ["agent-tools-build"] : []));
    const targetRoot = layout === "split" ? join(worktree, "target", "agent-tools", "version") : buildRoot;
    const builtProfile = join(buildRoot, "debug");
    const dependency = join(worktree, "dependency");
    mkdirSync(join(dependency, "src"), { recursive: true });
    writeFileSync(join(dependency, "Cargo.toml"),
      '[package]\nname = "cache_dependency"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(dependency, "src", "lib.rs"),
      'pub fn answer() -> u32 { 41 }\n');
    writeFileSync(join(worktree, "Cargo.toml"),
      '[package]\nname = "cache_fixture"\nversion = "0.1.0"\nedition = "2021"\n' +
      '[dependencies]\ncache_dependency = { path = "dependency" }\n');
    const source = join(worktree, "src", "main.rs");
    writeFileSync(source, [
      "use std::io::{self, BufRead};",
      "fn main() {",
      '    println!("{}", cache_dependency::answer());',
      "    for _ in io::stdin().lock().lines() {",
      '        println!("{}", cache_dependency::answer());',
      "    }",
      "}",
    ].join("\n"));
    const cargoEnvironment = {
      ...environment,
      CARGO_HOME: join(root, "cargo-home"),
      CARGO_BUILD_BUILD_DIR: buildRoot,
      CARGO_INCREMENTAL: "1",
      CARGO_BUILD_JOBS: "1",
      CARGO_PROFILE_DEV_DEBUG: "2",
      CARGO_PROFILE_DEV_SPLIT_DEBUGINFO: "unpacked",
      RUSTC_WRAPPER: "",
      RUSTC_WORKSPACE_WRAPPER: "",
      RUSTFLAGS: "",
      CARGO_ENCODED_RUSTFLAGS: "",
    };
    const build = () => execFileSync("cargo", [
      "build", "--offline", "--message-format=json", "--manifest-path",
      join(worktree, "Cargo.toml"), "--target-dir", targetRoot,
    ], { cwd: worktree, env: cargoEnvironment, encoding: "utf8", timeout: 60_000 })
      .trim().split("\n").map(line => JSON.parse(line));
    const artifacts = build();
    const archive = artifacts.find(item =>
      item.reason === "compiler-artifact" && item.target.name === "cache_dependency")
      ?.filenames.find(path => path.endsWith(".rlib"));
    const binary = artifacts.find(item =>
      item.reason === "compiler-artifact" && item.executable)?.executable;
    expect(archive).toBeTruthy();
    expect(binary).toBeTruthy();
    expect(readdirSync(join(builtProfile, "incremental")).length).toBeGreaterThan(1);
    const objects = process.platform === "darwin"
      ? readdirSync(join(builtProfile, "deps"))
        .filter(name => name.endsWith(".rcgu.o"))
        .map(name => join(builtProfile, "deps", name))
      : [];
    if (process.platform === "darwin") expect(objects.length).toBeGreaterThan(0);
    const binaryBefore = readFileSync(binary);
    const sourceBefore = readFileSync(source);
    const registry = join(environment.DURE_HOME, "agents.json");
    const registryBefore = readFileSync(registry);
    const runtime = spawn(binary, [], { cwd: worktree, stdio: ["pipe", "pipe", "pipe"] });
    const ended = once(runtime, "exit");
    const output = createInterface({ input: runtime.stdout });
    const lines = output[Symbol.asyncIterator]();
    try {
      expect((await lines.next()).value).toBe("41");
      const { receipt } = run("--cache-only", "--apply");
      expect(receipt.refused).toEqual([]);
      expect(receipt.skipped).toEqual([]);
      expect(existsSync(archive)).toBe(false);
      for (const object of objects) expect(existsSync(object)).toBe(false);
      expect(readdirSync(join(builtProfile, "incremental"))).toEqual([]);
      expect(readFileSync(binary)).toEqual(binaryBefore);
      expect(readFileSync(source)).toEqual(sourceBefore);
      expect(readFileSync(registry)).toEqual(registryBefore);
      expect(runtime.exitCode).toBeNull();
      runtime.stdin.write("after cleanup\n");
      expect((await lines.next()).value).toBe("41");
    } finally {
      runtime.stdin.end();
      await ended;
      output.close();
    }
    expect(runtime.exitCode).toBe(0);
    const rebuilt = build();
    expect(rebuilt).toContainEqual(expect.objectContaining({
      reason: "compiler-artifact",
      target: expect.objectContaining({ name: "cache_dependency" }),
      fresh: false,
    }));
    expect(existsSync(archive)).toBe(true);
    expect(execFileSync(binary, [], { input: "", encoding: "utf8" }).trim()).toBe("41");
  });

  it.each([
    ["agent-tools/version", "debug", ".cargo-lock"],
    ["remote-agent-tools/version", "aarch64-unknown-linux-gnu/release", ".cargo-lock"],
    ["remote-agent-tools-build", "x86_64-unknown-linux-musl/release", ".cargo-build-lock"],
    ["remote-agent-tools-build", "aarch64-unknown-linux-musl/release", ".cargo-build-lock"],
  ])(
    "reclaims nested Cargo caches at %s/%s without removing staged runtimes", (nested, profilePath, lock) => {
      const buildRoot = join(worktree, "target", nested);
      const nestedProfile = join(buildRoot, profilePath);
      mkdirSync(join(nestedProfile, "incremental", "session"), { recursive: true });
      writeFileSync(join(buildRoot, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
      writeFileSync(join(nestedProfile, lock), "");
      const cache = join(nestedProfile, "incremental", "session", "query-cache.bin");
      const runtime = join(nestedProfile, "hmux-runtime");
      writeFileSync(cache, "rebuildable nested cache");
      writeFileSync(runtime, "staged runtime");
      run("--cache-only", "--apply");
      expect(existsSync(cache)).toBe(false);
      expect(readFileSync(runtime, "utf8")).toBe("staged runtime");
      expectRetained();
    },
  );

  it.each(["missing", "invalid", "symlink"])(
    "retains a nested cache when its Cargo marker is %s", marker => {
      const buildRoot = join(worktree, "target", "agent-tools", "unverified");
      const nestedProfile = join(buildRoot, "debug");
      mkdirSync(join(nestedProfile, "incremental"), { recursive: true });
      writeFileSync(join(nestedProfile, ".cargo-lock"), "");
      const cache = join(nestedProfile, "incremental", "query-cache.bin");
      writeFileSync(cache, "unverified cache");
      const tag = join(buildRoot, "CACHEDIR.TAG");
      if (marker === "invalid") writeFileSync(tag, "not a Cargo marker");
      if (marker === "symlink") {
        const outside = join(root, "external-cache-tag");
        writeFileSync(outside, "Signature: 8a477f597d28d172789f06886806bc55\n");
        symlinkSync(outside, tag);
      }
      const { receipt } = run("--cache-only", "--apply");
      expect(receipt.skipped).toContainEqual(expect.objectContaining({ path: nestedProfile }));
      expect(readFileSync(cache, "utf8")).toBe("unverified cache");
      expectRetained();
    },
  );
});
