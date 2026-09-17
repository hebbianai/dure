import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const toolRoot = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(toolRoot, "../..");
export const transientOutputRoot = resolve(repoRoot, "output/playwright");
export const defaultOutputRoot = resolve(transientOutputRoot, "media");
export const providerFixtureRoot = resolve(
  transientOutputRoot,
  "provider-fixtures",
);

export function assertSafeOutputRoot(outputRoot) {
  const pathFromTransientRoot = relative(transientOutputRoot, outputRoot);
  if (
    pathFromTransientRoot === "" ||
    pathFromTransientRoot.startsWith("..") ||
    resolve(transientOutputRoot, pathFromTransientRoot) !== resolve(outputRoot)
  ) {
    throw new Error("--output must stay below output/playwright");
  }
}
