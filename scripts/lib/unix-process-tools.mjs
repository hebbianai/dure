import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const PROCESS_CENSUS_PATHS = Object.freeze(["/bin/ps", "/usr/bin/ps"]);
const ENVIRONMENT_PATHS = Object.freeze(["/usr/bin/env", "/bin/env"]);
const POSIX_SHELL_PATHS = Object.freeze(["/bin/sh"]);

export const POSIX_SHELL_EXECUTABLE_ENV = "DURE_POSIX_SHELL";
export const PACKAGE_SCRIPT_SHELL_ENV = "npm_config_script_shell";

export function resolveExecutableFile(pathname) {
  try {
    const resolved = realpathSync(pathname);
    const metadata = statSync(resolved);
    accessSync(resolved, fsConstants.X_OK);
    return metadata.isFile() &&
      metadata.size > 0 &&
      (metadata.mode & 0o111) !== 0
      ? resolved
      : null;
  } catch {
    return null;
  }
}

function executableCandidates(name, fixedPaths, environment) {
  const path = typeof environment.PATH === "string" ? environment.PATH : "";
  const pathCandidates = path
    .split(delimiter)
    .filter((directory) => isAbsolute(directory))
    .map((directory) => join(directory, name));
  return [...new Set([...pathCandidates, ...fixedPaths])];
}

function resolveUnixExecutable(
  name,
  fixedPaths,
  {
    platform = process.platform,
    environment = process.env,
    resolveExecutablePath = resolveExecutableFile,
    preserveInvocationPath = false,
  } = {},
) {
  if (platform === "win32") return null;
  for (const candidate of executableCandidates(name, fixedPaths, environment)) {
    const resolved = resolveExecutablePath(candidate);
    if (typeof resolved === "string" && isAbsolute(resolved)) {
      return preserveInvocationPath ? candidate : resolved;
    }
  }
  return null;
}

function unavailableReason(missing) {
  return `required Unix tools are unavailable: ${missing.join(", ")}`;
}

/** Resolve fresh cold-bootstrap dependencies once before any checkout mutation. */
export function resolveUnixDevChainTools(options = {}) {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const processCensusExecutable = resolveUnixExecutable(
    "ps",
    PROCESS_CENSUS_PATHS,
    options,
  );
  const lsofExecutable = resolveLsofExecutable(options);
  const environmentExecutable = resolveUnixExecutable(
    "env",
    ENVIRONMENT_PATHS,
    options,
  );
  const shellExecutable = resolvePosixShellExecutable(options);
  const tools = Object.freeze({
    processCensusExecutable,
    processCwdExecutable: lsofExecutable,
    portCensusExecutable: lsofExecutable,
    environmentExecutable,
    shellExecutable,
    ...(options.dependencyInstallerExecutable
      ? {
          dependencyInstallerExecutable:
            options.dependencyInstallerExecutable,
        }
      : {}),
  });
  const observationMissing = [];
  if (!processCensusExecutable) observationMissing.push("process census (ps)");
  if (!lsofExecutable) {
    observationMissing.push("process cwd (lsof)", "port census (lsof)");
  }
  const missing = [...observationMissing];
  if (!environmentExecutable) missing.push("environment launch (env)");
  if (!shellExecutable) missing.push("POSIX shell (sh)");
  if (windows) {
    missing.splice(0, missing.length, "Unix process adapter");
    observationMissing.splice(
      0,
      observationMissing.length,
      "Unix process adapter",
    );
  }
  const immutableMissing = Object.freeze(missing);
  const immutableObservationMissing = Object.freeze(observationMissing);
  return Object.freeze({
    status: missing.length === 0 ? "available" : "unavailable",
    observationStatus:
      observationMissing.length === 0 ? "available" : "unavailable",
    tools,
    ...(observationMissing.length === 0
      ? {}
      : {
          observationReason: unavailableReason(
            immutableObservationMissing,
          ),
        }),
    ...(missing.length === 0
      ? {}
      : {
          missing: immutableMissing,
          reason: unavailableReason(immutableMissing),
        }),
  });
}

export function resolveLsofExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  return resolveUnixExecutable(
    "lsof",
    platform === "darwin"
      ? ["/usr/sbin/lsof", "/usr/bin/lsof"]
      : ["/usr/bin/lsof", "/usr/sbin/lsof"],
    options,
  );
}

export function resolvePosixShellExecutable(options = {}) {
  return resolveUnixExecutable("sh", POSIX_SHELL_PATHS, {
    ...options,
    preserveInvocationPath: true,
  });
}

export function resolveCorepackExecutable(options = {}) {
  return resolveUnixExecutable("corepack", [], options);
}

export function readProcessCwd(
  pid,
  {
    execute = execFileSync,
    executable = resolveLsofExecutable(),
  } = {},
) {
  if (!executable) return undefined;
  try {
    const output = execute(
      executable,
      ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { encoding: "utf8", timeout: 10_000 },
    );
    return output
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
  } catch {
    return undefined;
  }
}
