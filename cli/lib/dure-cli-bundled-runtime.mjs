import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  parseMetadata,
  verificationCacheDirectory,
} from "./dure-cli-channel-launcher.mjs";

export function bindBundledDureRuntime(cliScriptPath, environment = process.env) {
  const versionRoot = dirname(dirname(realpathSync(cliScriptPath)));
  if (
    !existsSync(join(versionRoot, "install.json")) &&
    !existsSync(join(versionRoot, "bin", "node"))
  ) return;
  // Every CLI invocation passes here, so it reuses an earlier verification of
  // the unchanged payload instead of hashing it again.
  const metadata = parseMetadata(versionRoot, {
    verificationCache: verificationCacheDirectory(environment),
  });
  if (
    metadata.bundle.hmux.schemaVersion === 2 &&
    realpathSync(process.execPath) !== join(versionRoot, "bin", "node")
  ) {
    throw new Error("packaged Dure CLI must use its immutable Node runtime");
  }
  environment.DURE_HMUX_BIN = resolve(versionRoot, metadata.bundle.hmux.executablePath);
  environment.DURE_HMUX_RUNTIME_BIN = resolve(versionRoot, metadata.bundle.hmux.runtimeExecutablePath);
}
