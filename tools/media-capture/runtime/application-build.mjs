import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withoutLocalGitOverrides } from "../../../scripts/lib/git-environment.mjs";
import {
  normalizeFrontendRuntimeObservation,
} from "../../../src/contracts/frontendRuntimeObservation.mjs";

const execFileAsync = promisify(execFile);
const defaultRepoRoot = resolve(import.meta.dirname, "../../..");

async function gitBytes(repoRoot, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "buffer",
    env: withoutLocalGitOverrides(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function updateRecord(hash, label, value) {
  const labelBytes = Buffer.from(label);
  const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(labelBytes.length, 0);
  lengths.writeUInt32BE(valueBytes.length, 4);
  hash.update(lengths);
  hash.update(labelBytes);
  hash.update(valueBytes);
}

/**
 * Classify and hash the exact tracked patch plus every non-ignored untracked
 * file. This keeps iterative dirty-tree capture useful without letting
 * `HEAD-dirty` silently describe two different sets of source bytes.
 */
export async function applicationWorkingTreeState(
  repoRoot = defaultRepoRoot,
) {
  const [trackedPatch, untrackedOutput] = await Promise.all([
    gitBytes(repoRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "HEAD",
      "--",
    ]),
    gitBytes(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const hash = createHash("sha256");
  hash.update("dure-application-working-tree-v1\0");
  updateRecord(hash, "tracked-patch", trackedPatch);
  const untrackedPaths = untrackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const relativePath of untrackedPaths) {
    const absolutePath = join(repoRoot, relativePath);
    const stat = await lstat(absolutePath);
    const kind = stat.isSymbolicLink() ? "symlink" : "file";
    const content = stat.isSymbolicLink()
      ? Buffer.from(await readlink(absolutePath))
      : await readFile(absolutePath);
    updateRecord(
      hash,
      `${kind}:${stat.mode & 0o111}:${relativePath}`,
      content,
    );
  }
  return Object.freeze({
    dirty: trackedPatch.length > 0 || untrackedPaths.length > 0,
    fingerprint: `git-working-tree-v1:${hash.digest("hex")}`,
  });
}

export async function applicationWorkingTreeFingerprint(
  repoRoot = defaultRepoRoot,
) {
  return (await applicationWorkingTreeState(repoRoot)).fingerprint;
}

export function normalizeApplicationBuildInfo(value) {
  const observation = normalizeFrontendRuntimeObservation(value);
  if (!observation) {
    throw new Error("capture application runtime observation is invalid");
  }
  if (
    observation.sourceRevision === null ||
    observation.worktreeOverlay === "unknown"
  ) {
    throw new Error("capture application source identity is unavailable");
  }
  return {
    buildId: observation.buildId,
    packageVersion: observation.buildId.slice(
      0,
      observation.buildId.indexOf("+"),
    ),
    sourceRevision: observation.sourceRevision,
    dirty: observation.worktreeOverlay === "present",
    backendRuntimeFingerprint: observation.backendRuntimeFingerprint,
  };
}

export async function readApplicationBuild(
  baseUrl,
  fetchImpl = fetch,
  readWorkingTreeFingerprint = applicationWorkingTreeFingerprint,
) {
  const fingerprintBefore = await readWorkingTreeFingerprint();
  const response = await fetchImpl(`${baseUrl}/__app_build_info`);
  if (!response.ok) {
    throw new Error(`capture server build info failed: ${response.status}`);
  }
  const build = normalizeApplicationBuildInfo(await response.json());
  const workingTreeFingerprint = await readWorkingTreeFingerprint();
  if (fingerprintBefore !== workingTreeFingerprint) {
    throw new Error("capture application working tree changed while reading build identity");
  }
  return { ...build, workingTreeFingerprint };
}

export function assertApplicationBuildUnchanged(expected, current) {
  const fields = [
    "buildId",
    "packageVersion",
    "sourceRevision",
    "dirty",
    "backendRuntimeFingerprint",
    "workingTreeFingerprint",
  ];
  const changed = fields.filter((field) => expected?.[field] !== current?.[field]);
  if (changed.length > 0) {
    throw new Error(
      `capture application build changed while rendering: ${changed.join(", ")}`,
    );
  }
}
