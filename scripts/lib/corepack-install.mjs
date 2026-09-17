const PINNED_PNPM = /^pnpm@[1-9][0-9]*\.[0-9]+\.[0-9]+$/u;
const INSTALL_ARGUMENTS = Object.freeze([
  "--config.node-linker=hoisted",
  "install",
  "--frozen-lockfile",
  "--prod",
  "--ignore-scripts",
]);

export const COREPACK_EXECUTABLE_ENV = "DURE_COREPACK_EXECUTABLE";

export function corepackExecutable(environment = process.env) {
  const executable = environment[COREPACK_EXECUTABLE_ENV];
  return typeof executable === "string" && executable.length > 0
    ? executable
    : "corepack";
}

/** Normalize one pinned package-manager install at the process boundary. */
export function corepackInstallInvocation({
  packageManager,
  platform = process.platform,
  commandInterpreter = process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
  environment = process.env,
}) {
  if (!PINNED_PNPM.test(packageManager ?? "")) {
    throw new Error("Claude SDK driver package manager must be exactly pinned");
  }
  const corepackArguments = [packageManager, ...INSTALL_ARGUMENTS];
  if (platform !== "win32") {
    return Object.freeze({
      file: corepackExecutable(environment),
      arguments: Object.freeze(corepackArguments),
    });
  }
  if (typeof commandInterpreter !== "string" || !commandInterpreter) {
    throw new Error("Windows command interpreter is unavailable");
  }
  return Object.freeze({
    file: commandInterpreter,
    arguments: Object.freeze([
      "/d",
      "/s",
      "/c",
      "corepack",
      ...corepackArguments,
    ]),
  });
}
