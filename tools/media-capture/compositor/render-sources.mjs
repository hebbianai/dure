import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { sha256FileEvidence } from "./file-digest.mjs";

function assertContained(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(root, pathFromRoot) !== candidate
  ) {
    throw new Error(`${label} escapes the capture root`);
  }
}

export async function verifyRenderSources({ sources, captureRoot }) {
  const resolvedRoot = await realpath(captureRoot);
  return Promise.all(
    sources.map(async (source) => {
      const candidate = resolve(resolvedRoot, source.capturePath);
      assertContained(resolvedRoot, candidate, `render source ${source.id}`);
      const resolvedSource = await realpath(candidate);
      assertContained(resolvedRoot, resolvedSource, `render source ${source.id}`);
      const evidence = await sha256FileEvidence(resolvedSource);
      if (evidence.bytes !== source.bytes || evidence.sha256 !== source.sha256) {
        throw new Error(`render source ${source.id} changed after compilation`);
      }
      return { id: source.id, path: resolvedSource, ...evidence };
    }),
  );
}
