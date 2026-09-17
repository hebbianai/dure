import { join } from "node:path";
import { devTauriCliInvocation } from "./dev-tauri-cli.mjs";
import { resolvePosixShellExecutable } from "./unix-process-tools.mjs";

/** One ordered prerequisite authority for initial launch and parent reload. */
export function devLaunchPrerequisites({
  worktreeRoot,
  childEnvironment,
  devServer,
}) {
  const inherited = {
    cwd: worktreeRoot,
    env: childEnvironment,
    stdio: "inherit",
  };
  const shell = process.platform === "win32"
    ? null
    : resolvePosixShellExecutable({ environment: childEnvironment });
  if (process.platform !== "win32" && !shell) {
    throw new Error("Development agent tools require a POSIX shell (sh)");
  }
  return [
    {
      command: process.execPath,
      args: [join(worktreeRoot, "scripts/guard-dev-channel.mjs")],
      spawnOptions: inherited,
    },
    {
      command: process.execPath,
      args: [
        join(worktreeRoot, "scripts/node-dependency-preflight.mjs"),
        "--install",
      ],
      spawnOptions: inherited,
    },
    ...(process.platform === "darwin" ? [{
      command: process.execPath,
      args: [join(worktreeRoot, "scripts/stage-mobile-runtime.mjs")],
      spawnOptions: inherited,
    }] : []),
    ...(process.platform === "win32" ? [] : [{
      command: shell,
      args: [join(worktreeRoot, "scripts/prepare-agent-tools.sh")],
      spawnOptions: inherited,
    }]),
    {
      command: process.execPath,
      args: [
        join(worktreeRoot, "scripts/run-dev-frontend.mjs"),
        "--check",
        "--host",
        devServer.host,
        "--port",
        String(devServer.port),
      ],
      spawnOptions: inherited,
    },
    {
      ...devTauriCliInvocation(["--version"]),
      spawnOptions: {
        ...inherited,
        stdio: "ignore",
      },
    },
  ];
}
