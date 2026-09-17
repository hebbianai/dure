import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Resolve the compiler before fixtures substitute their disposable homes. */
export function rustToolchainTestEnvironment() {
  const read = (...args) => execFileSync("rustup", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return {
    RUSTUP_HOME: read("show", "home"),
    RUSTUP_TOOLCHAIN: read("show", "active-toolchain").split(/\s+/u)[0],
  };
}
