import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseMetadata } from "./dure-cli-channel-launcher.mjs";

export function bindBundledDureRuntime(cliScriptPath, environment = process.env) {
  const versionRoot = dirname(dirname(realpathSync(cliScriptPath)));
  if (
    !existsSync(join(versionRoot, "install.json")) &&
    !existsSync(join(versionRoot, "bin", "node"))
  ) return;
  const metadata = parseMetadata(versionRoot);
  if (
    metadata.bundle.hmux.schemaVersion === 2 &&
    realpathSync(process.execPath) !== join(versionRoot, "bin", "node")
  ) {
    throw new Error("packaged Dure CLI must use its immutable Node runtime");
  }
  environment.DURE_HMUX_BIN = resolve(versionRoot, metadata.bundle.hmux.executablePath);
  environment.DURE_HMUX_RUNTIME_BIN = resolve(versionRoot, metadata.bundle.hmux.runtimeExecutablePath);
}
