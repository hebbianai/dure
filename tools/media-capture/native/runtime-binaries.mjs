import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { withoutLocalGitOverrides } from "../../../scripts/lib/git-environment.mjs";

const execFileAsync = promisify(execFile);
const TARGET_TRIPLE = /^[A-Za-z0-9._-]+$/u;

async function defaultRun(command, args, options) {
  return execFileAsync(command, args, options);
}

async function defaultAssertExecutable(path) {
  await access(path, constants.X_OK);
}

function targetTripleFromRustc(output) {
  const target = /^host:\s*(\S+)$/mu.exec(output)?.[1];
  if (!target || !TARGET_TRIPLE.test(target)) {
    throw new Error("native media could not resolve a safe Rust target triple");
  }
  return target;
}

export function nativeHmuxRuntimeEnvironment(baseEnvironment, binaries) {
  return {
    ...baseEnvironment,
    DURE_MEDIA_HMUX_BIN: binaries.cli,
    DURE_QA_HMUX_CLI: binaries.cli,
    DURE_QA_HMUX_RUNTIME: binaries.runtime,
  };
}

/** Stage one current-source Hmux pair for both provider capture and Tauri. */
export async function stageNativeHmuxRuntime({
  assertExecutable = defaultAssertExecutable,
  baseEnvironment = process.env,
  repoRoot = resolve(import.meta.dirname, "../../.."),
  run = defaultRun,
} = {}) {
  const environment = withoutLocalGitOverrides(baseEnvironment);
  await run("pnpm", ["hmux:runtime:stage:dev"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  const target = baseEnvironment.CARGO_BUILD_TARGET || targetTripleFromRustc(
    (
      await run("rustc", ["-vV"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: environment,
        timeout: 5_000,
      })
    ).stdout,
  );
  if (!TARGET_TRIPLE.test(target)) {
    throw new Error("native media Rust target triple is unsafe");
  }
  const suffix = target.includes("-windows-") ? ".exe" : "";
  const binaries = {
    cli: resolve(repoRoot, "src-tauri", "binaries", `hmux-${target}${suffix}`),
    runtime: resolve(
      repoRoot,
      "src-tauri",
      "binaries",
      `hmux-runtime-${target}${suffix}`,
    ),
  };
  await Promise.all([
    assertExecutable(binaries.cli),
    assertExecutable(binaries.runtime),
  ]);
  return binaries;
}
