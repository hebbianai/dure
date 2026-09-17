import { spawnSync } from "node:child_process";
import { constants, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Only finite leaf builds belong here, never app/QA lifetimes or a parent
// orchestrator that invokes another participating build.
export function nativeBuildCommand(
  command,
  args,
  {
    platform = process.platform,
    environment = process.env,
    accountHome = userInfo().homedir,
  } = {},
) {
  if (platform !== "darwin" && platform !== "linux") return { command, args };
  const root =
    environment.DURE_NATIVE_BUILD_SLOT_ROOT ??
    join(accountHome, ".dure", "native-build-slot-v1");
  if (!isAbsolute(root)) {
    throw new Error("DURE_NATIVE_BUILD_SLOT_ROOT must be absolute");
  }
  return {
    command: "python3",
    args: [
      fileURLToPath(new URL("../native/native-build-slot.py", import.meta.url)),
      root,
      "--",
      command,
      ...args,
    ],
  };
}

function main(args) {
  if (args[0] !== "--" || args.length < 2) {
    throw new Error("usage: native-build-slot.mjs -- <command> [args...]");
  }
  const invocation = nativeBuildCommand(args[1], args.slice(2));
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? (128 + (constants.signals[result.signal] ?? 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Native build was not started: ${error.message}\n`);
    process.exitCode = 1;
  }
}
