import { spawnSync } from "node:child_process";

/** Environment for a new local backend generation. Runtime identities travel
 * in validated arguments, never inherited Hmux selector variables. */
export function localBackendServiceEnvironment(environment, platform = process.platform) {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => ![
        "DURE_HMUX_BIN", "DURE_HMUX_RUNTIME_BIN", "HEBBIAN_HMUX_RUNTIME",
        "HMUX_DISCOVERY_ROOT", "HMUX_RUNTIME",
      ].includes(name),
    ),
  );
  if (platform === "win32") return result;

  // Desktop provider preflight and managed pane launch use `SHELL -lc`.
  // The backend must not freeze a dev launcher's different provider PATH.
  // Import PATH only: shell startup cannot replace credential/app identities.
  const probe = spawnSync(environment.SHELL || "/bin/sh", ["-lc", "env -0"], {
    cwd: environment.HOME,
    env: environment,
    encoding: "utf8",
    timeout: 3_000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const path = probe.stdout?.split("\0").find((entry) => entry.startsWith("PATH="))?.slice(5);
  if (probe.error || probe.status !== 0 || !path) {
    const error = new Error("Could not resolve the login-shell provider PATH; review shell startup and retry.");
    error.code = "local_backend_login_environment_unavailable";
    throw error;
  }
  return { ...result, PATH: path };
}
