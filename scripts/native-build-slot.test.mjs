import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
  createDureCliInstallerFixture,
  dureCliInstallerFixtureEnvironment,
} from "./lib/dure-cli-install-test-fixture.mjs";
import { nativeBuildCommand } from "./lib/native-build-slot.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const buildEnvironment = fileURLToPath(
  new URL("./with-hmux-build-environment.sh", import.meta.url),
);
const slotHelper = fileURLToPath(
  new URL("./native/native-build-slot.py", import.meta.url),
);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dure-native-build-slot-")));
  const proof = join(root, "proof");
  mkdirSync(proof);
  writeFileSync(join(proof, "hmux-ghostty-vt-proof.receipt"), "fixture\n");
  const worker = join(root, "build.mjs");
  writeFileSync(worker, `import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
const slot = process.env.DURE_NATIVE_BUILD_SLOT_ROOT;
const active = join(slot, "active");
mkdirSync(slot, { recursive: true, mode: 0o700 });
try { mkdirSync(active); } catch { process.stdout.write("OVERLAP\\n"); process.exit(89); }
process.stdout.write("BUILD_ENTERED\\n");
process.stdin.resume();
process.stdin.once("end", () => { rmdirSync(active); process.exit(Number(process.env.DURE_TEST_WORKER_EXIT_CODE ?? process.argv[2] ?? 0)); });
`);
  const children = [];
  const releases = [];
  function environment(cwd, slot = join(root, "slot")) {
    return scriptTestEnvironment({
      HOME: cwd,
      DURE_HOME: join(cwd, "state"),
      HMUX_DISCOVERY_ROOT: join(cwd, "discovery"),
      HMUX_GHOSTTY_VT_PROOF_PREFIX: proof,
      DURE_NATIVE_BUILD_SLOT_ROOT: slot,
    });
  }
  function start(
    name,
    exitCode = 0,
    {
      slot,
      command = [process.execPath, worker, String(exitCode)],
      entry,
      extraEnvironment = {},
    } = {},
  ) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    const invocation = entry ?? [
      "sh", buildEnvironment, "aarch64-apple-darwin", "--", ...command,
    ];
    const child = spawn(invocation[0], invocation.slice(1), {
      cwd,
      env: { ...environment(cwd, slot), ...extraEnvironment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const completion = once(child, "close");
    const exited = once(child, "exit");
    const entered = Promise.race([
      once(child.stdout, "data").then(([data]) => data.toString()),
      completion.then(([code, signal]) => `BUILD_EXITED: ${code ?? signal}`),
    ]);
    const notice = once(child.stderr, "data").then(([data]) => data.toString());
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const item = { child, completion, exited, entered, notice, stderr: () => stderr };
    children.push(item);
    return item;
  }
  return {
    root,
    worker,
    environment,
    releases,
    start,
    async cleanup() {
      for (const release of releases) release();
      for (const { child } of children) child.stdin.end();
      await Promise.all(children.map(({ completion }) => completion));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")("finite builds and their compiler children preserve caller CPU priority", async () => {
  const setup = fixture();
  try {
    const parentPriority = getPriority();
    const invocation = nativeBuildCommand(process.execPath, ["-e", `
const { getPriority } = require("node:os");
const { execFileSync } = require("node:child_process");
const childPriority = Number(execFileSync(process.execPath, ["-p", 'require("node:os").getPriority()'], { encoding: "utf8" }));
process.stdout.write(JSON.stringify({ priority: getPriority(), childPriority }));
`], { environment: setup.environment(setup.root) });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: setup.root, env: setup.environment(setup.root), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const priority = parentPriority;
    expect(JSON.parse(result.stdout)).toEqual({ priority, childPriority: priority });
    expect(getPriority()).toBe(parentPriority);
  } finally {
    await setup.cleanup();
  }
});

test.each(["darwin", "linux"])("the %s native slot does not inject CPU or I/O throttling", (platform) => {
  const command = nativeBuildCommand("cargo", ["build", "--locked"], {
    platform,
    environment: { DURE_NATIVE_BUILD_SLOT_ROOT: "/fixture/slot" },
  });
  expect(command).toEqual({
    command: "python3",
    args: [slotHelper, "/fixture/slot", "--", "cargo", "build", "--locked"],
  });
});

test.skipIf(process.platform === "win32")(
  "two worktrees share one native build slot and continue after a failed build",
  async () => {
    const setup = fixture();
    try {
      const first = setup.start("worktree-one", 23);
      expect(await first.entered).toBe("BUILD_ENTERED\n");
      const inode = statSync(join(setup.root, "slot/build.lock")).ino;
      const second = setup.start("worktree-two");
      expect(await Promise.race([second.entered, second.notice])).toContain("Waiting for the native build slot");
      first.child.stdin.end();
      expect(await first.completion).toEqual([23, null]);
      expect(await second.entered).toBe("BUILD_ENTERED\n");
      second.child.stdin.end();
      expect(await second.completion).toEqual([0, null]);
      expect(statSync(join(setup.root, "slot/build.lock")).ino).toBe(inode);
    } finally {
      await setup.cleanup();
    }
  },
);

test.skipIf(process.platform === "win32")("simultaneous first-use callers create one slot and all acquire it", async () => {
  const setup = fixture();
  try {
    const result = spawnSync("python3", ["-c", `
import concurrent.futures, json, multiprocessing, os, runpy, sys
acquire = runpy.run_path(sys.argv[1])["acquire"]
context = multiprocessing.get_context("fork")
barrier = context.Barrier(8, timeout=2)
def worker(index):
    observations = []
    for cycle in range(10):
        root = os.path.join(sys.argv[2], str(cycle))
        descriptor = None
        barrier.wait()
        try:
            descriptor = acquire(root)
            active = os.path.join(root, "active")
            os.mkdir(active)
            metadata = os.fstat(descriptor)
            observations.append({"cycle": cycle, "inode": metadata.st_ino})
            os.rmdir(active)
        except Exception as error:
            observations.append({"cycle": cycle, "error": repr(error)})
        finally:
            if descriptor is not None:
                os.close(descriptor)
        barrier.wait()
    return observations
with concurrent.futures.ProcessPoolExecutor(max_workers=8, mp_context=context) as pool:
    observations = list(pool.map(worker, range(8)))
print(json.dumps(observations))
`, slotHelper, join(setup.root, "first-use")], {
      env: setup.environment(setup.root), encoding: "utf8", timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const observations = JSON.parse(result.stdout).flat();
    expect(observations).toHaveLength(80);
    expect(observations.filter((item) => item.error)).toEqual([]);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const entries = observations.filter((item) => item.cycle === cycle);
      expect(entries).toHaveLength(8);
      expect(new Set(entries.map((item) => item.inode)).size).toBe(1);
    }
  } finally {
    await setup.cleanup();
  }
});

test.skipIf(process.platform === "win32")("a surviving build descendant retains admission after its parent exits", async () => {
  const setup = fixture();
  try {
    const control = join(setup.root, "descendant-control");
    let released = false;
    const release = () => {
      if (released) return;
      let descriptor;
      try {
        descriptor = openSync(control, constants.O_WRONLY | constants.O_NONBLOCK);
        writeSync(descriptor, "stop");
        released = true;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENXIO") throw error;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    };
    setup.releases.push(release);
    const first = setup.start("orphan-parent", 0, { command: ["python3", "-c", `import os, sys
os.mkfifo(sys.argv[1])
if os.fork():
    os._exit(17)
control = os.open(sys.argv[1], os.O_RDWR)
sys.stdout.write("BUILD_ENTERED\\n")
sys.stdout.flush()
os.read(control, 4)
os._exit(0)
`, control] });
    expect(await first.entered).toBe("BUILD_ENTERED\n");
    expect(await first.exited).toEqual([17, null]);
    const second = setup.start("successor");
    expect(await Promise.race([second.entered, second.notice])).toContain("Waiting for the native build slot");
    release();
    await first.completion;
    expect(await second.entered).toBe("BUILD_ENTERED\n");
    second.child.stdin.end();
    expect(await second.completion).toEqual([0, null]);
  } finally {
    await setup.cleanup();
  }
});

test.skipIf(process.platform === "win32")("independent fixture roots do not block each other", async () => {
  const setup = fixture();
  try {
    const first = setup.start("one");
    expect(await first.entered).toBe("BUILD_ENTERED\n");
    const second = setup.start("two", 0, { slot: join(setup.root, "other-slot") });
    expect(await Promise.race([second.entered, second.notice])).toBe("BUILD_ENTERED\n");
  } finally {
    await setup.cleanup();
  }
});

test.skipIf(process.platform === "win32")("launch errors release the slot and preserve the next command's arguments and output", async () => {
  const setup = fixture();
  try {
    const environment = setup.environment(setup.root);
    const missing = nativeBuildCommand(join(setup.root, "missing-compiler"), [], { environment });
    const failed = spawnSync(missing.command, missing.args, { env: environment, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Native build was not started");
    const args = ["space here", "--literal=$VALUE", "한글"];
    const next = nativeBuildCommand(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}))', ...args], { environment });
    const succeeded = spawnSync(next.command, next.args, { cwd: setup.root, env: environment, encoding: "utf8" });
    expect(succeeded.status, succeeded.stderr).toBe(0);
    expect(JSON.parse(succeeded.stdout)).toEqual({ args, cwd: setup.root });
  } finally {
    await setup.cleanup();
  }
});

test.skipIf(process.platform === "win32").each(["directory-link", "file-link", "public-file"])("refuses an unsafe slot (%s) without running the command", async (kind) => {
  const setup = fixture();
  try {
    const slot = join(setup.root, "slot");
    const target = join(setup.root, "retained");
    if (kind === "directory-link") {
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, slot);
    } else {
      mkdirSync(slot, { mode: 0o700 });
      writeFileSync(target, "retained", { mode: 0o600 });
      if (kind === "file-link") symlinkSync(target, join(slot, "build.lock"));
      else {
        writeFileSync(join(slot, "build.lock"), "retained");
        chmodSync(join(slot, "build.lock"), 0o666);
      }
    }
    const environment = setup.environment(setup.root);
    const command = nativeBuildCommand(process.execPath, ["-e", 'process.stdout.write("STARTED")'], { environment });
    const result = spawnSync(command.command, command.args, { env: environment, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    if (kind !== "directory-link") expect(readFileSync(target, "utf8")).toBe("retained");
  } finally {
    await setup.cleanup();
  }
});

test.each(["darwin", "linux"])("the default %s slot belongs to the OS account, not a worktree or overridden HOME", (platform) => {
  const defaults = { platform, accountHome: "/account" };
  const first = nativeBuildCommand("cargo", ["build"], { ...defaults, environment: { HOME: "/qa-one", DURE_HOME: "/qa-one/state" } });
  const second = nativeBuildCommand("cargo", ["build"], { ...defaults, environment: { HOME: "/qa-two", DURE_HOME: "/qa-two/state" } });
  expect(first).toEqual(second);
  expect(nativeBuildCommand("cargo", ["build"], { ...defaults, environment: {} })).toEqual(first);
  expect(first.args).toContain("/account/.dure/native-build-slot-v1");
  expect(() => nativeBuildCommand("cargo", [], { ...defaults, environment: { DURE_NATIVE_BUILD_SLOT_ROOT: "relative" } })).toThrow("must be absolute");
  expect(nativeBuildCommand("cargo", ["build"], { platform: "win32" })).toEqual({ command: "cargo", args: ["build"] });
});

test.skipIf(process.platform === "win32")("cancelling a waiter does not disturb the current build or poison admission", async () => {
  const setup = fixture();
  try {
    const first = setup.start("current");
    expect(await first.entered).toBe("BUILD_ENTERED\n");
    const waiter = setup.start("cancelled", 0, { entry: ["python3", "-c", `import os, runpy, signal, sys, threading
def cancel():
    sys.stdin.read(1)
    os.kill(os.getpid(), signal.SIGINT)
threading.Thread(target=cancel, daemon=True).start()
sys.argv = [sys.argv[1], sys.argv[2], "--", sys.executable, "-c", 'print("BUILD_ENTERED")']
runpy.run_path(sys.argv[0], run_name="__main__")
`, slotHelper, join(setup.root, "slot")] });
    expect(await Promise.race([waiter.entered, waiter.notice])).toContain("Waiting for the native build slot");
    waiter.child.stdin.write("cancel");
    expect(await waiter.completion).toEqual([130, null]);
    const second = setup.start("next");
    expect(await Promise.race([second.entered, second.notice])).toContain("Waiting for the native build slot");
    first.child.stdin.end();
    expect(await first.completion).toEqual([0, null]);
    expect(await second.entered).toBe("BUILD_ENTERED\n");
  } finally {
    await setup.cleanup();
  }
});

test.skipIf(process.platform === "win32").each(["file", "directory"])("refuses a replaced lock %s instead of launching against stale admission", async (kind) => {
  const setup = fixture();
  try {
    const first = setup.start("current", 0, {
      command: [process.execPath, "-e", `
process.stdout.write("BUILD_ENTERED\\n");
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
`],
    });
    expect(await first.entered).toBe("BUILD_ENTERED\n");
    const second = setup.start("waiting");
    expect(await Promise.race([second.entered, second.notice])).toContain("Waiting for the native build slot");
    const lock = join(setup.root, "slot/build.lock");
    if (kind === "file") {
      renameSync(lock, join(setup.root, "retained-lock"));
    } else {
      renameSync(join(setup.root, "slot"), join(setup.root, "retained-slot"));
      mkdirSync(join(setup.root, "slot"), { mode: 0o700 });
    }
    writeFileSync(lock, "replacement", { mode: 0o600 });
    first.child.stdin.end();
    expect(await first.completion).toEqual([0, null]);
    expect(await second.completion).toEqual([1, null]);
    expect(second.stderr()).toContain("identity changed while waiting");
    expect(readFileSync(lock, "utf8")).toBe("replacement");
  } finally {
    await setup.cleanup();
  }
});

test.skipIf(process.platform === "win32")("CLI compilation and Hmux preparation use the same slot", async () => {
  const setup = fixture();
  try {
    const repository = createDureCliInstallerFixture(join(setup.root, "cli-source"));
    // The fixture compiler produces no artifacts, so disk admission is outside
    // this wiring proof. Keep the real installer and native slot execution.
    writeFileSync(join(repository, "scripts/lib/build-storage-admission.mjs"),
      "export function ensureHeadroom() { return { ok: true, reservation: null }; }\n");
    writeFileSync(join(repository, ".test-bin/cargo"),
      `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(setup.worker).href)};\n`, { mode: 0o700 });
    const environment = dureCliInstallerFixtureEnvironment(repository, setup.environment(setup.root));
    const first = setup.start("cli-worktree", 0, {
      entry: [process.execPath, join(repository, "scripts/install-dure-cli.mjs")],
      extraEnvironment: {
        ...environment,
        DURE_NATIVE_BUILD_SLOT_ROOT: join(setup.root, "slot"),
        DURE_TEST_WORKER_EXIT_CODE: "23",
      },
    });
    expect(await Promise.race([first.entered, first.notice])).toBe("BUILD_ENTERED\n");
    const second = setup.start("hmux-worktree");
    expect(await Promise.race([second.entered, second.notice])).toContain("Waiting for the native build slot");
    first.child.stdin.end();
    expect((await first.completion)[0]).not.toBe(0);
    expect(await second.entered).toBe("BUILD_ENTERED\n");
  } finally {
    await setup.cleanup();
  }
});
