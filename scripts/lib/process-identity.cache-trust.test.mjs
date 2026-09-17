import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const processIdentityModule = pathToFileURL(
  join(import.meta.dirname, "process-identity.mjs"),
).href;
const boundarySource = join(
  import.meta.dirname,
  "../native/owned-process-observer.c",
);
const fixtureProcessIdentity =
  "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:1";

function runWithPreclaimedBoundary(mode) {
  const root = mkdtempSync(join(tmpdir(), "dure-boundary-cache-trust-"));
  try {
    const temporaryDirectory = join(root, "tmp");
    const attackerDirectory = join(root, "attacker");
    const sentinel = join(root, "sentinel");
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    mkdirSync(attackerDirectory, { mode: 0o700 });

    const digest = createHash("sha256")
      .update(readFileSync(boundarySource))
      .digest("hex")
      .slice(0, 20);
    const owner = typeof process.getuid === "function" ? process.getuid() : 0;
    const cacheDirectory = join(
      temporaryDirectory,
      `dure-process-boundary-${owner}`,
    );
    symlinkSync(attackerDirectory, cacheDirectory, "dir");
    writeFileSync(
      join(attackerDirectory, digest),
      `#!/bin/sh
printf sentinel > "$DURE_TEST_SENTINEL"
printf 'M %s 1 1 live ${fixtureProcessIdentity}\\n' "$2"
`,
      { mode: 0o700 },
    );

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { existsSync } from "node:fs";
const mode = process.argv[1];
Object.defineProperty(process, "platform", { value: "darwin" });
const boundary = await import(${JSON.stringify(processIdentityModule)});
let accepted = false;
let error = null;
let errorCode = null;
try {
  const owner = {
    pid: process.pid,
    processIdentity: ${JSON.stringify(fixtureProcessIdentity)},
  };
  accepted = mode === "async"
    ? await boundary.signalProcessGeneration(owner, "SIGTERM")
    : boundary.signalProcessGenerationSync(owner, "SIGTERM");
} catch (value) {
  error = String(value?.message ?? value);
  errorCode = value?.code ?? null;
}
console.log(JSON.stringify({
  accepted,
  error,
  errorCode,
  sentinelRan: existsSync(process.env.DURE_TEST_SENTINEL),
}));`,
        mode,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_TEST_SENTINEL: sentinel,
          TMPDIR: temporaryDirectory,
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.runIf(process.platform !== "win32").each(["async", "sync"])(
  "refuses a %s boundary executable reached through a preclaimed symlink",
  (mode) => {
    const result = runWithPreclaimedBoundary(mode);
    expect(result.sentinelRan).toBe(false);
    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe(
      "DEV_PROCESS_BOUNDARY_PROVENANCE_INVALID",
    );
    expect(result.error).toContain("native process boundary cache is unsafe");
  },
);
