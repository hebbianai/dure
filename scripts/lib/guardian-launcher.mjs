// Launcher half of the self-re-exec guardian pattern shared by
// scripts/run-hmux-tests.mjs (originally shared with the since-removed
// run-with-full-verification-lock.mjs):
// the runner re-invokes its own script as a detached guardian process with an
// internal marker argument, forwards SIGINT/SIGTERM to that guardian, and maps
// the guardian's exit into a shell-conventional status code.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

export function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function launchDetachedGuardian({
  command,
  guardianArgument,
  scriptUrl,
  environment = process.env,
}) {
  const guardian = spawn(
    process.execPath,
    [fileURLToPath(scriptUrl), guardianArgument, "--", ...command],
    {
      cwd: process.cwd(),
      detached: true,
      env: withoutLocalGitOverrides(environment),
      stdio: "inherit",
    },
  );
  const forward = (signal) => {
    try {
      guardian.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  const result = await waitForChild(guardian);
  if (result.signal) return SIGNAL_EXIT_CODES[result.signal] ?? 1;
  return result.code ?? 1;
}
