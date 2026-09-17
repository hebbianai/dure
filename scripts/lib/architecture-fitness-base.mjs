import { spawnSync } from "node:child_process";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0{40}$/;

export function architectureFitnessBaseSha(environment = process.env) {
  const canonical = environment.DURE_ARCHITECTURE_BASE_SHA;
  const candidate =
    canonical === undefined || canonical === ""
      ? environment.HEBBIAN_VERIFICATION_BASE_SHA
      : canonical;
  if (candidate === undefined || candidate === "" || ZERO_SHA.test(candidate)) {
    return null;
  }
  if (!FULL_SHA.test(candidate)) {
    throw new Error(
      "architecture fitness base must be a full 40-character commit SHA",
    );
  }
  return candidate.toLowerCase();
}

function requireGit(root, args, label, run) {
  const result = run("git", args, {
    cwd: root,
    encoding: null,
    env: withoutLocalGitOverrides(),
  });
  if (result.status !== 0) {
    throw new Error(
      `architecture fitness Git failed (${label}): ${result.stderr?.toString("utf8").trim() || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

function lineCount(source) {
  return source.toString("utf8").split(/\r?\n/).length;
}

function renamedBasePath(root, sha, filename, run) {
  const output = requireGit(
    root,
    [
      "diff",
      "--find-renames=50%",
      "--diff-filter=R",
      "--name-status",
      "-z",
      sha,
      "HEAD",
      "--",
      "src/",
    ],
    `resolve rename for ${filename}`,
    run,
  );
  if (output.length === 0) return null;
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) !== "" || (fields.length - 1) % 3 !== 0) {
    throw new Error(`architecture fitness rename output is malformed: ${filename}`);
  }

  const matches = [];
  for (let index = 0; index < fields.length - 1; index += 3) {
    const [status, oldPath, newPath] = fields.slice(index, index + 3);
    if (
      !/^R[0-9]{3}$/.test(status) ||
      !oldPath.startsWith("src/") ||
      !newPath.startsWith("src/")
    ) {
      throw new Error(`architecture fitness rename output is unsafe: ${filename}`);
    }
    if (newPath === filename) matches.push(oldPath);
  }
  if (matches.length > 1) {
    throw new Error(`architecture fitness base rename is ambiguous: ${filename}`);
  }
  return matches[0] ?? null;
}

function pathAtRevision(root, sha, filename, run) {
  const listing = requireGit(
    root,
    ["ls-tree", "-z", "--name-only", sha, "--", `:(literal)${filename}`],
    `inspect ${filename}`,
    run,
  );
  if (listing.length === 0) return false;
  if (!listing.equals(Buffer.from(`${filename}\0`))) {
    throw new Error(`architecture fitness base path is ambiguous: ${filename}`);
  }
  return true;
}

export function resolveArchitectureFitnessCiBase(
  root,
  candidate,
  run = spawnSync,
) {
  const requested = architectureFitnessBaseSha({
    DURE_ARCHITECTURE_BASE_SHA: candidate,
  });
  const revision = requested ? `${requested}^{commit}` : "HEAD^";
  const resolved = requireGit(root, ["rev-parse", revision], "resolve CI base", run)
    .toString("utf8")
    .trim()
    .toLowerCase();
  const normalized = architectureFitnessBaseSha({
    DURE_ARCHITECTURE_BASE_SHA: resolved,
  });
  if (!normalized || (requested && normalized !== requested)) {
    throw new Error("architecture fitness CI base did not resolve exactly");
  }
  return normalized;
}

export function readGodFileLinesAtRevision(
  root,
  revision,
  filenames,
  run = spawnSync,
) {
  if (!Array.isArray(filenames)) {
    throw new Error("architecture fitness filenames must be an array");
  }
  const sha = architectureFitnessBaseSha({
    DURE_ARCHITECTURE_BASE_SHA: revision,
  });
  if (!sha) return {};
  const resolved = requireGit(
    root,
    ["rev-parse", `${sha}^{commit}`],
    "resolve base",
    run,
  )
    .toString("utf8")
    .trim();
  if (resolved !== sha) {
    throw new Error("architecture fitness base did not resolve exactly");
  }

  const counts = {};
  for (const filename of [...new Set(filenames)].sort()) {
    if (
      typeof filename !== "string" ||
      !filename.startsWith("src/") ||
      filename.includes("\0")
    ) {
      throw new Error("architecture fitness filename is unsafe");
    }
    const baseFilename = pathAtRevision(root, sha, filename, run)
      ? filename
      : renamedBasePath(root, sha, filename, run);
    if (!baseFilename) {
      counts[filename] = 0;
      continue;
    }
    if (
      baseFilename !== filename &&
      !pathAtRevision(root, sha, baseFilename, run)
    ) {
      throw new Error(
        `architecture fitness renamed base path is missing: ${baseFilename}`,
      );
    }
    counts[filename] = lineCount(
      requireGit(
        root,
        ["show", `${sha}:${baseFilename}`],
        `read ${baseFilename}`,
        run,
      ),
    );
  }
  return counts;
}
