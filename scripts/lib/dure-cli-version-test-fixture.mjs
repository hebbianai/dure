import fs from "node:fs";
import path from "node:path";

const SAFE_PACKAGE_VERSION =
  /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function dureCliVersionExpectation(repository) {
  const manifestPath = path.join(repository, "cli", "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Dure CLI fixture manifest is unreadable: ${manifestPath}`, {
      cause: error,
    });
  }
  if (
    manifest?.name !== "dure-cli" ||
    typeof manifest.version !== "string" ||
    !SAFE_PACKAGE_VERSION.test(manifest.version)
  ) {
    throw new Error(`Dure CLI fixture manifest is invalid: ${manifestPath}`);
  }

  const packageVersion = manifest.version;
  const versionPattern = escapeRegularExpression(packageVersion);
  return Object.freeze({
    packageVersion,
    installedOutput: new RegExp(
      `^dure ${versionPattern} \\(${versionPattern}\\+[A-Za-z0-9._+-]+\\)\\n$`,
      "u",
    ),
    installedPrefix: new RegExp(`^dure ${versionPattern} `, "u"),
    sourceOutput: new RegExp(
      `^dure ${versionPattern} \\(source\\)\\n$`,
      "u",
    ),
  });
}
