import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireDureCliMutationLock as acquire,
  releaseDureCliMutationLock as release,
} from "../cli/lib/dure-cli-mutation-lock.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const roots = [];
const moduleUrl = new URL("../cli/lib/dure-cli-mutation-lock.mjs", import.meta.url).href;
const imports = `import fs from 'node:fs';
  import { acquireDureCliMutationLock as acquire, releaseDureCliMutationLock as release } from ${JSON.stringify(moduleUrl)};
  const root = process.argv[1];`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-mutation-lock-"));
  roots.push(root);
  return root;
}

function childOptions(root) {
  return {
    encoding: "utf8",
    env: {
      ...scriptTestEnvironment(),
      HOME: root,
      DURE_HOME: path.join(root, "home"),
      HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
    },
  };
}

function child(root, source) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", imports + source, root], childOptions(root));
}

function deadOwner(root) {
  const result = child(root, "process.stdout.write(JSON.stringify(acquire(root, 0))); process.exit(86);");
  expect(result.status, result.stderr).toBe(86);
  return JSON.parse(result.stdout);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("excludes another process while the owner is live and fences an old release from its successor", () => {
  const root = fixture();
  const first = acquire(root, 0);
  const bytes = fs.readFileSync(first.pathname);
  const contender = child(root, "acquire(root, 0);");
  expect(contender.status).toBe(1);
  expect(contender.stderr).toContain("another Dure CLI install holds");
  expect(fs.readFileSync(first.pathname)).toEqual(bytes);
  expect(release(first)).toBe(true);
  const successor = acquire(root, 0);
  expect(release(first)).toBe(false);
  expect(fs.existsSync(successor.pathname)).toBe(true);
  release(successor);
});

it.each(["empty", "malformed", "unsupported", "remote", "symlink-directory", "symlink-owner"])(
  "preserves unknown %s lock ownership regardless of age",
  (kind) => {
    const root = fixture();
    const directory = path.join(root, ".mutation-lock");
    const target = path.join(root, "unknown");
    if (kind === "symlink-directory") {
      fs.mkdirSync(target);
      fs.symlinkSync(target, directory, "dir");
    } else {
      fs.mkdirSync(directory);
      if (kind !== "empty") {
        const exited = child(root, "process.stdout.write(String(process.pid));");
        expect(exited.status, exited.stderr).toBe(0);
        const generation = randomUUID();
        const pathname = path.join(directory, `owner-${generation}.json`);
        const body = JSON.stringify({ schemaVersion: kind === "unsupported" ? 99 : 1,
          generation, hostname: kind === "remote" ? "another-host" : os.hostname(), pid: Number(exited.stdout) });
        if (kind === "symlink-owner") {
          fs.writeFileSync(target, body);
          fs.symlinkSync(target, pathname);
        } else fs.writeFileSync(pathname, kind === "malformed" ? "{" : body);
      }
    }
    fs.utimesSync(directory, 1, 1);
    const before = fs.lstatSync(directory);
    const entries = fs.readdirSync(directory);
    expect(() => acquire(root, 0)).toThrow("another Dure CLI install holds");
    expect(fs.lstatSync(directory).ino).toBe(before.ino);
    expect(fs.readdirSync(directory)).toEqual(entries);
  },
);

it("preserves an old lock generation when its PID now belongs to a live process", () => {
  const root = fixture();
  const owner = deadOwner(root);
  const record = JSON.parse(fs.readFileSync(owner.pathname, "utf8"));
  record.pid = process.pid;
  fs.writeFileSync(owner.pathname, JSON.stringify(record));
  expect(() => acquire(root, 0)).toThrow("another Dure CLI install holds");
  expect(JSON.parse(fs.readFileSync(owner.pathname, "utf8"))).toEqual(record);
});

it.each(["EPERM", "EACCES", "EIO"])("does not treat %s as owner absence", (code) => {
  const root = fixture();
  const owner = deadOwner(root);
  const bytes = fs.readFileSync(owner.pathname);
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
  expect(() => acquire(root, 0)).toThrow("another Dure CLI install holds");
  expect(fs.readFileSync(owner.pathname)).toEqual(bytes);
});

it("does not let a losing reclaimer remove a successor before its owner file is published", () => {
  const root = fixture();
  const stale = deadOwner(root);
  const result = child(root, `
    import { syncBuiltinESMExports } from 'node:module';
    const stale = ${JSON.stringify(stale)};
    const unlink = fs.unlinkSync;
    let raced = false;
    fs.unlinkSync = (pathname) => {
      if (!raced && pathname === stale.pathname) {
        raced = true;
        unlink(pathname);
        fs.rmdirSync(stale.directory);
        fs.mkdirSync(stale.directory);
      }
      return unlink(pathname);
    };
    syncBuiltinESMExports();
    let refused = false;
    try { acquire(root, 0); } catch { refused = true; }
    process.stdout.write(JSON.stringify({ raced, refused, preserved: fs.existsSync(stale.directory) }));
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ raced: true, refused: true, preserved: true });
});

it("serializes competing processes through recovery and repeated acquisition", async () => {
  const root = fixture();
  deadOwner(root);
  const counter = path.join(root, "counter");
  fs.writeFileSync(counter, "0");
  const workers = Array.from({ length: 4 }, () => new Promise((resolve) => {
    const worker = spawn(process.execPath, ["--input-type=module", "--eval", imports + `
      for (let i = 0; i < 30; i++) {
        const lock = acquire(root, 5000);
        const guard = root + '/critical-section';
        fs.closeSync(fs.openSync(guard, 'wx'));
        const n = Number(fs.readFileSync(root + '/counter', 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        fs.writeFileSync(root + '/counter', String(n + 1));
        fs.unlinkSync(guard);
        release(lock);
      }
    `, root], childOptions(root));
    let stderr = "";
    worker.stderr.on("data", (data) => { stderr += data; });
    worker.on("error", (error) => resolve({ error: error.message }));
    worker.on("close", (code) => resolve({ code, stderr }));
  }));
  const results = await Promise.all(workers);
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stderr: "" })));
  expect(fs.readFileSync(counter, "utf8")).toBe("120");
  expect(fs.existsSync(path.join(root, ".mutation-lock"))).toBe(false);
  expect(fs.existsSync(path.join(root, "critical-section"))).toBe(false);
});
