import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

const INPUTS_PATH = "scripts/backend-runtime-inputs.txt";
const DOMAIN = "hebbian-backend-runtime-fingerprint-v1";
const FINGERPRINT_PREFIX = "git-object-v1:";
const ARTIFACT_PREFIX = "artifact-prefix:";

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function repositoryObjectFormat(repositoryRoot) {
  const format = git(repositoryRoot, ["rev-parse", "--show-object-format"]).trim();
  if (format !== "sha1" && format !== "sha256") {
    throw new Error(`unsupported Git object format: ${format}`);
  }
  return format;
}

function fileBlobHash(repositoryRoot, file, objectFormat) {
  try {
    const bytes = readFileSync(path.join(repositoryRoot, file));
    const hash = createHash(objectFormat)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (!/^[0-9a-f]{40,64}$/.test(hash)) {
      throw new Error("git returned an invalid file blob hash");
    }
    return hash;
  } catch (error) {
    throw new Error(
      `hash backend runtime file failed: ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function readBackendRuntimeInputs(repositoryRoot) {
  const source = readFileSync(path.join(repositoryRoot, INPUTS_PATH), "utf8");
  const entries = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (entries.length === 0) {
    throw new Error("backend runtime input manifest is empty");
  }
  const seen = new Set();
  const sourceInputs = [];
  const artifactPrefixes = [];
  for (const entry of entries) {
    const artifact = entry.startsWith(ARTIFACT_PREFIX);
    const input = artifact ? entry.slice(ARTIFACT_PREFIX.length) : entry;
    if (
      !input ||
      path.isAbsolute(input) ||
      input === ".." ||
      input.startsWith("../") ||
      input.includes("/../") ||
      input.includes("\\") ||
      input.includes("\0") ||
      input.includes("\n")
    ) {
      throw new Error(`invalid backend runtime input: ${JSON.stringify(input)}`);
    }
    if (seen.has(input)) {
      throw new Error(`duplicate backend runtime input: ${input}`);
    }
    seen.add(input);
    (artifact ? artifactPrefixes : sourceInputs).push(input);
  }
  if (sourceInputs.length === 0) {
    throw new Error("backend runtime input manifest has no source inputs");
  }
  return { sourceInputs, artifactPrefixes };
}

function listedFiles(repositoryRoot, inputs) {
  const output = git(repositoryRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    INPUTS_PATH,
    ...inputs,
  ]);
  const files = output
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (!files.includes(INPUTS_PATH)) {
    throw new Error(`backend runtime input manifest is not tracked: ${INPUTS_PATH}`);
  }
  for (const input of inputs) {
    if (!files.some((file) => file === input || file.startsWith(`${input}/`))) {
      throw new Error(`backend runtime input matched no files: ${input}`);
    }
  }
  for (const file of files) {
    if (file.includes("\n")) {
      throw new Error(`backend runtime file contains a newline: ${JSON.stringify(file)}`);
    }
  }
  return files;
}

function listedArtifacts(repositoryRoot, prefixes) {
  return prefixes.flatMap((prefix) => {
    const directory = path.dirname(prefix);
    const namePrefix = path.basename(prefix);
    const files = readdirSync(path.join(repositoryRoot, directory), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.startsWith(namePrefix))
      .map((entry) => `${directory}/${entry.name}`)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const file of files) {
      if (file.includes("\n")) {
        throw new Error(
          `backend runtime artifact contains a newline: ${JSON.stringify(file)}`,
        );
      }
    }
    if (files.length === 0) {
      throw new Error(`backend runtime artifact matched no files: ${prefix}`);
    }
    return files;
  });
}

export function computeBackendRuntimeFingerprint(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const { sourceInputs, artifactPrefixes } = readBackendRuntimeInputs(root);
  const sourceFiles = listedFiles(root, sourceInputs);
  const artifactFiles = listedArtifacts(root, artifactPrefixes);
  const objectFormat = repositoryObjectFormat(root);
  const files = [...sourceFiles, ...artifactFiles].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  // Synchronous Git stdin can wait for EOF and block both native builds and
  // Vite requests. Hash raw files and the manifest using Git's blob format.
  const hashes = files.map((file) => fileBlobHash(root, file, objectFormat));

  const manifest = [
    DOMAIN,
    ...files.map((file, index) => `${hashes[index]} ${file}`),
    "",
  ].join("\n");
  const bytes = Buffer.from(manifest);
  const digest = createHash(objectFormat)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (!/^[0-9a-f]{40,64}$/.test(digest)) {
    throw new Error("git returned an invalid backend runtime fingerprint");
  }
  return `${FINGERPRINT_PREFIX}${digest}`;
}

export function tryBackendRuntimeFingerprint(repositoryRoot) {
  try {
    return computeBackendRuntimeFingerprint(repositoryRoot);
  } catch {
    return null;
  }
}

function cliRoot(argv) {
  if (argv.length !== 2 || argv[0] !== "--root" || !argv[1]) {
    throw new Error("usage: backend-runtime-fingerprint.mjs --root <repository>");
  }
  return argv[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${computeBackendRuntimeFingerprint(cliRoot(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
