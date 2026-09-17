import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { macosProcessBoundaryCompileArguments } from "./lib/process-identity.mjs";

const guardianModule = pathToFileURL(
  path.join(import.meta.dirname, "run-hmux-tests.mjs"),
).href;
const identityModule = pathToFileURL(
  path.join(import.meta.dirname, "lib/process-identity.mjs"),
).href;
const boundarySource = path.join(
  import.meta.dirname,
  "native/owned-process-observer.c",
);

function nativePreparationFixture({ warmInitial = false, failure, compilerOnly = false } = {}) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync("/tmp"), "hmux-guardian-preparation."),
  );
  const initialTmp = path.join(root, "initial");
  const stateBoundary = path.join(root, "states");
  const bin = path.join(root, "bin");
  const compilerCalls = path.join(root, "compiler-outputs.txt");
  const commandCapture = path.join(root, "command.json");
  for (const directory of [initialTmp, stateBoundary, bin]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  const digest = createHash("sha256")
    .update(fs.readFileSync(boundarySource))
    .digest("hex")
    .slice(0, 20);
  const initialCache = path.join(
    initialTmp,
    `dure-process-boundary-${process.getuid()}`,
  );
  if (warmInitial) {
    fs.mkdirSync(initialCache, { mode: 0o700 });
    const executable = path.join(initialCache, digest);
    const compiled = spawnSync(
      "/usr/bin/cc",
      macosProcessBoundaryCompileArguments(executable),
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    fs.chmodSync(executable, 0o700);
  }
  fs.writeFileSync(
    path.join(bin, "cc"),
    `#!/bin/sh
previous=""
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then
    printf '%s\\n' "$argument" >> ${JSON.stringify(compilerCalls)}
  fi
  previous="$argument"
done
${failure === "compiler" ? "exit 42" : `exec ${JSON.stringify(process.execPath)} -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); process.execve("/usr/bin/cc", ["cc", ...process.argv.slice(1)], process.env);' -- "$@"`}
`,
    { mode: 0o700 },
  );
  if (failure === "unsafe-cache") {
    const untrusted = path.join(root, "untrusted");
    fs.mkdirSync(untrusted, { mode: 0o700 });
    fs.symlinkSync(untrusted, initialCache, "dir");
  }

  if (compilerOnly) {
    const executable = path.join(root, "compiler-self-check");
    const startedAt = performance.now();
    const compiled = spawnSync(
      path.join(bin, "cc"),
      macosProcessBoundaryCompileArguments(executable),
      { detached: true, encoding: "utf8", timeout: 30_000 },
    );
    if (compiled.error) {
      throw new Error(`compiler fixture failed; preserved ${root}`, {
        cause: compiled.error,
      });
    }
    const result = {
      artifactExists: fs.existsSync(executable),
      compiled,
      elapsedMs: performance.now() - startedAt,
    };
    fs.rmSync(root, { recursive: true, force: true });
    return result;
  }

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  const result = realSpawnSync(...args);
  if (args[0] === "cc") console.error(JSON.stringify({ command: "cc", status: result.status, signal: result.signal, error: result.error?.code, stderr: result.stderr }));
  return result;
};
syncBuiltinESMExports();
const { runGuardian } = await import(${JSON.stringify(guardianModule)});
const initial = process.env.TMPDIR;
let status;
let error;
try {
  status = await runGuardian([
    process.execPath,
    "-e",
    ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(commandCapture)}, JSON.stringify({ pid: process.pid, tmpdir: process.env.TMPDIR }));`)},
  ], { temporaryRoot: ${JSON.stringify(stateBoundary)} });
} catch (value) {
  status = 97;
  error = { code: value.code, message: value.message };
}
console.log(JSON.stringify({ status, error, restored: process.env.TMPDIR === initial }));
process.exitCode = status;`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DURE_HOST_RESOURCE_POLICY: path.join(root, "absent-host-resource-policy.json"),
        DURE_HMUX_TEST_STATE_ROOT_CAPTURE: path.join(root, "state-root.txt"),
        HMUX_GHOSTTY_VT_PROOF_PREFIX: path.join(root, "unused-proof"),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TMPDIR: initialTmp,
      },
      timeout: 50_000,
    },
  );
  // A timeout may leave owned processes. Preserve their evidence for the
  // guardian's recovery path instead of deleting a potentially live root.
  if (child.error) {
    throw new Error(`guardian fixture failed; preserved ${root}`, {
      cause: child.error,
    });
  }
  const result = {
    child,
    command: fs.existsSync(commandCapture)
      ? JSON.parse(fs.readFileSync(commandCapture, "utf8"))
      : null,
    compilerCalls: fs.existsSync(compilerCalls)
      ? fs.readFileSync(compilerCalls, "utf8").trim().split("\n")
      : [],
    initialCache,
    result: JSON.parse(child.stdout.trim().split("\n").at(-1)),
    stateBoundary,
    stateRoots: fs.readdirSync(stateBoundary).filter(
      (entry) => entry.startsWith("dure-hmux-test."),
    ),
  };
  if (child.status !== 0 && (result.command || result.stateRoots.some((entry) =>
    fs.existsSync(path.join(stateBoundary, entry, "test-process-group.json")),
  ))) {
    throw new Error(`guardian cleanup failed; preserved ${root}: ${child.stderr}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test.runIf(process.platform === "darwin")("validates the delayed real compiler fixture", () => {
  const { artifactExists, compiled, elapsedMs } = nativePreparationFixture({ compilerOnly: true });
  expect(compiled.status, compiled.stderr).toBe(0);
  expect(artifactExists).toBe(true);
  expect(elapsedMs).toBeGreaterThanOrEqual(2_500);
});

test.runIf(process.platform === "darwin").each([
  { warmInitial: false, label: "initial" },
  { warmInitial: true, label: "isolated TMPDIR" },
])("prepares a cold $label boundary before guardian observations", (options) => {
  const { child, command, compilerCalls, initialCache, result, stateBoundary, stateRoots } =
    nativePreparationFixture(options);
  expect(child.status, JSON.stringify({ stderr: child.stderr, result, command, compilerCalls })).toBe(0);
  expect(result).toEqual({ status: 0, restored: true });
  expect(command.tmpdir.startsWith(`${stateBoundary}${path.sep}`)).toBe(true);
  expect(stateRoots).toEqual([]);
  expect(compilerCalls.some((output) => output.startsWith(`${initialCache}${path.sep}`)))
    .toBe(!options.warmInitial);
  expect(compilerCalls.some((output) =>
    output.startsWith(`${stateBoundary}${path.sep}`) && output.includes("/tmp/dure-process-boundary-"),
  )).toBe(true);
});

test.runIf(process.platform === "darwin")(
  "fails closed before publishing ownership when initial preparation fails",
  () => {
    const { child, command, result, stateRoots } = nativePreparationFixture({ failure: "compiler" });
    expect(child.status).toBe(97);
    expect(command).toBeNull();
    expect(result.error.message).toContain("native process boundary build failed");
    expect(result.restored).toBe(true);
    expect(stateRoots).toEqual([]);
  },
);

test.runIf(process.platform === "darwin")(
  "restores the environment and refuses command admission when isolated preparation fails",
  () => {
    const { child, command, result, stateRoots } = nativePreparationFixture({ warmInitial: true, failure: "compiler" });
    expect(child.status).toBe(97);
    expect(child.stderr).toContain("native process boundary build failed");
    expect(command).toBeNull();
    expect(result.restored).toBe(true);
    expect(stateRoots).toHaveLength(1);
  },
);

test.runIf(process.platform === "darwin")(
  "refuses unsafe preparation cache provenance without invoking the compiler",
  () => {
    const { child, command, compilerCalls, result, stateRoots } =
      nativePreparationFixture({ failure: "unsafe-cache" });
    expect(child.status).toBe(97);
    expect(result.error.code).toBe("DEV_PROCESS_BOUNDARY_PROVENANCE_INVALID");
    expect(compilerCalls).toEqual([]);
    expect(command).toBeNull();
    expect(stateRoots).toEqual([]);
  },
);

test.runIf(process.platform === "linux")(
  "retains native Linux process-group admission and exact observation",
  () => {
    const child = spawnSync(process.execPath, [
      "--input-type=module", "-e",
      `import { requireNativeProcessGroupSupport, processMemberSnapshots } from ${JSON.stringify(identityModule)};
await requireNativeProcessGroupSupport();
console.log(JSON.stringify(processMemberSnapshots([process.pid])));`,
    ], { encoding: "utf8", timeout: 5_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      status: "complete",
      members: [{ pid: expect.any(Number), processIdentity: expect.stringMatching(/^linux:/u) }],
    });
  },
);
