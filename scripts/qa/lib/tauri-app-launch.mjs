import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateAppChannel } from "../../lib/app-channel.mjs";
import { superviseDevLaunch } from "../../lib/dev-launch-supervisor.mjs";
import { resolveDevTauriCliEntrypoint } from "../../lib/dev-tauri-cli.mjs";
import { assertIsolatedCleanupBoundary } from "./isolated-hmux-session-cleanup.mjs";

export async function runQaTauriApp(config, {
  worktreeRoot = process.cwd(),
  environment = process.env,
  supervise = superviseDevLaunch,
} = {}) {
  const stateRoot = realpathSync(environment.DURE_QA_STATE_ROOT);
  assertIsolatedCleanupBoundary(stateRoot, environment.HMUX_DISCOVERY_ROOT);
  const home = realpathSync(environment.HOME);
  assert.equal(home, join(stateRoot, "home"), "QA app requires the runner's exact HOME");
  assert.equal(environment.DURE_HOME, join(home, ".dure"), "QA app requires the runner's exact DURE_HOME");
  const channel = validateAppChannel(environment.DURE_QA_APP_CHANNEL);
  assert.equal(environment.DURE_APP_CHANNEL, channel);
  assert.equal(environment.VITE_DURE_APP_CHANNEL, channel);
  const root = realpathSync(worktreeRoot);
  const entrypoint = resolveDevTauriCliEntrypoint(root);
  // The QA owner retains its witness in this process. Dev activation replaces
  // its child via execve, so that child must not advertise the owner's FD.
  const appEnvironment = { ...environment };
  delete appEnvironment.DURE_QA_LIVENESS_WITNESS_FD;
  delete appEnvironment.HEBBIAN_QA_LIVENESS_WITNESS_FD;
  // Restart the complete CLI/Vite launch at the same isolated origin. The
  // existing dev authority owns admission, retirement and successor receipts.
  return supervise({
    home,
    worktreeRoot: root,
    channel,
    command: process.execPath,
    args: [entrypoint, "dev", "--no-watch", "--config", config],
    spawnOptions: { cwd: root, env: appEnvironment, stdio: "inherit" },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runQaTauriApp(process.argv[2]).then(
    (outcome) => { process.exitCode = outcome.code; },
    (error) => { console.error(error); process.exitCode = 1; },
  );
}
