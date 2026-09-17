import { join, resolve } from "node:path";

export function resolveBuiltDureControlPlane({
  cargoTargetDirectory,
  command,
  repositoryRoot,
}) {
  const targetRoot = cargoTargetDirectory
    ? resolve(repositoryRoot, cargoTargetDirectory)
    : join(repositoryRoot, "crates", "dure-app", "target");
  return join(targetRoot, "release", command);
}
