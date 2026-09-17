import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import { normalizeFullCommitSha } from "./release-gate.mjs";
import {
  VERSION_FILES,
  bump,
  readUnifiedVersion,
  writeVersion,
} from "./release-version.mjs";

export const RELEASE_CARGO_WORKSPACES = [
  {
    manifestPath: "src-tauri/Cargo.toml",
    lockPath: "src-tauri/Cargo.lock",
    versionedPackages: [
      "dure",
      "hmux-client",
      "hmux-host",
      "hmux-local-platform",
      "hmux-runtime-contract",
      "hmux-session-protocol",
      "hmux-ssh-transport",
      "terminal-state-protocol",
    ],
  },
  {
    manifestPath: "hmux/Cargo.toml",
    lockPath: "hmux/Cargo.lock",
    versionedPackages: [
      "hmux-cli",
      "hmux-client",
      "hmux-host",
      "hmux-local-platform",
      "hmux-release-candidate",
      "hmux-release-trust",
      "hmux-runtime",
      "hmux-runtime-contract",
      "hmux-session-protocol",
      "hmux-ssh-transport",
      "terminal-core-ghostty-proof",
      "terminal-state-protocol",
      "terminal-state-protocol-codegen",
    ],
  },
  {
    manifestPath: "crates/dure-app/Cargo.toml",
    lockPath: "crates/dure-app/Cargo.lock",
    versionedPackages: [
      "hmux-client",
      "hmux-host",
      "hmux-local-platform",
      "hmux-runtime-contract",
      "hmux-session-protocol",
      "terminal-state-protocol",
    ],
  },
  {
    manifestPath: "mobile/src-tauri/Cargo.toml",
    lockPath: "mobile/src-tauri/Cargo.lock",
    versionedPackages: [
      "hmux-client",
      "hmux-host",
      "hmux-local-platform",
      "hmux-runtime-contract",
      "hmux-session-protocol",
      "hmux-ssh-transport",
      "terminal-state-protocol",
    ],
  },
];

export const RELEASE_CANDIDATE_FILES = [
  ...VERSION_FILES.map((file) => file.path),
  ...RELEASE_CARGO_WORKSPACES.map(({ lockPath }) => lockPath),
];

const gitEnvironment = withoutLocalGitOverrides();

function run(command, args, root, encoding = "utf8") {
  return execFileSync(command, args, {
    cwd: root,
    encoding,
    env: gitEnvironment,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(root, ...args) {
  return run("git", args, root).trim();
}

function updateCargoLocks(root) {
  for (const { manifestPath } of RELEASE_CARGO_WORKSPACES) {
    execFileSync(
      "cargo",
      ["update", "--workspace", "--manifest-path", manifestPath],
      {
        cwd: root,
        env: gitEnvironment,
        stdio: "inherit",
      },
    );
  }
}

const packageBlock =
  /^\[\[package\]\]\n.*?(?=^\[\[package\]\]\n|(?![\s\S]))/gms;

function assertExactCargoLockChanges(root, currentVersion, version) {
  for (const workspace of RELEASE_CARGO_WORKSPACES) {
    const { lockPath } = workspace;
    const original = run("git", ["show", `HEAD:${lockPath}`], root);
    const expected = replaceReleaseCargoLock(
      original, workspace, currentVersion, version,
    );
    const actual = readFileSync(path.join(root, lockPath), "utf8");
    if (actual !== expected) {
      throw new Error(`release_candidate_lock_mismatch: ${lockPath}`);
    }
  }
}

/** The candidate and source-bookkeeping tools share the exact local-package inventory. */
export function replaceReleaseCargoLock(
  original, { lockPath, versionedPackages }, currentVersion, version,
) {
  const packageNames = new Set(versionedPackages);
  if (packageNames.size !== versionedPackages.length) {
    throw new Error(`release_candidate_lock_contract_invalid: ${lockPath}`);
  }
  const seen = new Set();
  const expected = original.replace(packageBlock, (block) => {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    if (!packageNames.has(name)) return block;
    if (seen.has(name) || /^source\s*=/m.test(block)) {
      throw new Error(`release_candidate_lock_invalid: ${lockPath}:${name}`);
    }
    const versionPattern = new RegExp(
      `^version = "${currentVersion.replaceAll(".", "\\.")}"$`,
      "m",
    );
    if (!versionPattern.test(block)) {
      throw new Error(`release_candidate_lock_stale: ${lockPath}:${name}`);
    }
    seen.add(name);
    return block.replace(versionPattern, `version = "${version}"`);
  });
  if (seen.size !== packageNames.size) {
    throw new Error(`release_candidate_lock_packages_missing: ${lockPath}`);
  }
  return expected;
}

function statusEntries(root) {
  const output = run(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    root,
  );
  if (!output) return [];
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({
      path: entry.slice(3),
      status: entry.slice(0, 2),
    }));
}

function assertExactCandidateChanges(root) {
  const entries = statusEntries(root);
  const expected = [...RELEASE_CANDIDATE_FILES].sort();
  const actual = entries.map((entry) => entry.path).sort();
  if (
    entries.some((entry) => entry.status !== " M") ||
    actual.length !== expected.length ||
    actual.some((file, index) => file !== expected[index])
  ) {
    const detail = entries
      .map((entry) => `${entry.status} ${entry.path}`)
      .join(", ");
    throw new Error(
      `release_candidate_files_mismatch: expected only ${expected.join(", ")}; got ${detail || "no changes"}`,
    );
  }
}

export function prepareReleaseCandidate({
  baseSha: baseInput,
  bumpKind,
  outputDirectory,
  root = process.cwd(),
  updateLocks = updateCargoLocks,
}) {
  if (bumpKind !== "patch" && bumpKind !== "minor") {
    throw new Error(
      `release_candidate_bump_invalid: ${bumpKind} (patch|minor only)`,
    );
  }

  const repositoryRoot = path.resolve(root);
  const artifactRoot = path.resolve(outputDirectory);
  const relativeArtifact = path.relative(repositoryRoot, artifactRoot);
  const artifactIsOutsideRepository =
    relativeArtifact === ".." ||
    relativeArtifact.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeArtifact);
  if (!artifactIsOutsideRepository) {
    throw new Error(
      "release_candidate_output_inside_repository: use an external runner temp directory",
    );
  }

  const baseSha = normalizeFullCommitSha(baseInput, "release base");
  const head = normalizeFullCommitSha(
    git(repositoryRoot, "rev-parse", "HEAD"),
    "candidate checkout",
  );
  if (head !== baseSha) {
    throw new Error(
      `release_candidate_base_mismatch: checkout is ${head}, expected ${baseSha}`,
    );
  }
  if (statusEntries(repositoryRoot).length > 0) {
    throw new Error(
      "release_candidate_dirty: candidate checkout must be clean before mutation",
    );
  }

  if (existsSync(artifactRoot) && readdirSync(artifactRoot).length > 0) {
    throw new Error(
      `release_candidate_output_not_empty: ${artifactRoot}`,
    );
  }
  mkdirSync(artifactRoot, { recursive: true });

  const currentVersion = readUnifiedVersion(repositoryRoot);
  const version = bump(currentVersion, bumpKind);
  for (const file of VERSION_FILES) {
    writeVersion(file, version, repositoryRoot);
  }
  updateLocks(repositoryRoot, currentVersion, version);
  assertExactCargoLockChanges(repositoryRoot, currentVersion, version);

  assertExactCandidateChanges(repositoryRoot);
  run("git", ["diff", "--check"], repositoryRoot);
  const patch = run(
    "git",
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--",
      ...RELEASE_CANDIDATE_FILES,
    ],
    repositoryRoot,
    null,
  );
  if (patch.length === 0) {
    throw new Error("release_candidate_patch_empty");
  }

  const manifest = {
    schemaVersion: 1,
    baseSha,
    bump: bumpKind,
    currentVersion,
    version,
    tag: `v${version}`,
    files: RELEASE_CANDIDATE_FILES,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  };
  writeFileSync(
    path.join(artifactRoot, "candidate.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  writeFileSync(path.join(artifactRoot, "version.patch"), patch, {
    flag: "wx",
  });
  return manifest;
}
