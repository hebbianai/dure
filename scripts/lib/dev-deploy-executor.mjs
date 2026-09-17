import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fsyncDirectory } from "./durable-file.mjs";
import { parseDevDeployExecutor } from "./dev-deploy-transaction.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import { assertOwnerOnlyDirectory, safeLstat } from "./dev-launch-storage.mjs";
import { windowsPrivateStorage } from "./windows-private-storage.mjs";

const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXECUTOR_MANIFEST = "scripts/dev-deploy-executor-files.json";
const SAFE_MANIFEST_PATH =
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/;

function pathInside(root, relativePath) {
  const canonicalRoot = resolve(root);
  const pathname = resolve(canonicalRoot, relativePath);
  const suffix = relative(canonicalRoot, pathname);
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  ) {
    throw new Error(`dev deploy executor path escapes its root: ${relativePath}`);
  }
  return pathname;
}

function parseExecutorManifest(contents, label) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    !value.includes(EXECUTOR_MANIFEST) ||
    !value.includes("scripts/deploy-dev-app.mjs") ||
    !value.includes("scripts/queue-dev-app-deploy.mjs") ||
    new Set(value).size !== value.length ||
    value.some(
      (relativePath) =>
        typeof relativePath !== "string" ||
        !SAFE_MANIFEST_PATH.test(relativePath),
    )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export const DEV_DEPLOY_EXECUTOR_FILES = Object.freeze(
  parseExecutorManifest(
    readFileSync(join(SOURCE_ROOT, EXECUTOR_MANIFEST), "utf8"),
    "dev deploy executor manifest",
  ),
);

export function devDeployQueueEntrypoint(executor) {
  const parsed = parseDevDeployExecutor(
    executor,
    "dev deploy executor identity",
  );
  return join(dirname(parsed.entrypoint), "queue-dev-app-deploy.mjs");
}

function ownerDirectory(pathname) {
  const existed = Boolean(safeLstat(pathname));
  assertOwnerOnlyDirectory(pathname, { create: true });
  if (!existed) fsyncDirectory(dirname(pathname));
}

function writeSnapshotFile(pathname, contents) {
  const descriptor = openSync(pathname, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sourceSnapshot(sourceRoot) {
  const canonicalSourceRoot = realpathSync(sourceRoot);
  const manifestPath = pathInside(canonicalSourceRoot, EXECUTOR_MANIFEST);
  if (realpathSync(manifestPath) !== manifestPath) {
    throw new Error("dev deploy executor source manifest is unsafe");
  }
  const relativePaths = parseExecutorManifest(
    readFileSync(manifestPath, "utf8"),
    "dev deploy executor source manifest",
  );
  const files = relativePaths.map((relativePath) => {
    const pathname = pathInside(canonicalSourceRoot, relativePath);
    const stat = lstatSync(pathname);
    if (
      realpathSync(pathname) !== pathname ||
      stat.isSymbolicLink() ||
      !stat.isFile()
    ) {
      throw new Error(`dev deploy executor source is unsafe: ${pathname}`);
    }
    return { relativePath, contents: readFileSync(pathname) };
  });
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    env: withoutLocalGitOverrides(),
  });
}

function commitFile(repositoryRoot, sourceHead, relativePath) {
  const treeEntry = git(
    repositoryRoot,
    ["ls-tree", "-z", sourceHead, "--", relativePath],
    null,
  ).toString("utf8");
  const match = treeEntry.match(
    /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/,
  );
  if (!match || match[3] !== relativePath) {
    throw new Error(
      `dev deploy executor source is not a regular target blob: ${relativePath}`,
    );
  }
  return {
    relativePath,
    contents: git(repositoryRoot, ["cat-file", "blob", match[2]], null),
  };
}

function commitSnapshot(repositoryRoot, sourceHead) {
  const resolved = git(
    repositoryRoot,
    ["rev-parse", "--verify", `${sourceHead}^{commit}`],
  ).trim();
  if (resolved !== sourceHead) {
    throw new Error("dev deploy executor source commit is not exact");
  }
  const manifest = commitFile(repositoryRoot, sourceHead, EXECUTOR_MANIFEST);
  const relativePaths = parseExecutorManifest(
    manifest.contents.toString("utf8"),
    "target dev deploy executor manifest",
  );
  const files = relativePaths.map((relativePath) =>
    relativePath === EXECUTOR_MANIFEST
      ? manifest
      : commitFile(repositoryRoot, sourceHead, relativePath),
  );
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

function snapshotDirectories(root, files) {
  const directories = new Set([root]);
  for (const { relativePath } of files) {
    let directory = dirname(join(root, relativePath));
    while (directory !== root) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return [...directories].sort((left, right) => right.length - left.length);
}

function matchesSnapshot(directory, snapshot) {
  try {
    assertOwnerOnlyDirectory(directory);
    const files = snapshot.files.map(({ relativePath, contents }) => ({
      pathname: pathInside(directory, relativePath), contents,
    }));
    if (process.platform === "win32") {
      windowsPrivateStorage(files.map(({ pathname }) => ({
        operation: "inspect", pathname, directory: dirname(pathname),
      })));
    }
    return files.every(({ pathname, contents }) => {
      if (process.platform !== "win32") {
        const stat = lstatSync(pathname);
        if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) return false;
      }
      return readFileSync(pathname).equals(contents);
    });
  } catch {
    return false;
  }
}

export function stageDevDeployExecutor({
  queueDirectory,
  sourceRoot = SOURCE_ROOT,
  sourceHead,
} = {}) {
  if (!queueDirectory) throw new Error("dev deploy queue directory is required");
  ownerDirectory(queueDirectory);
  const snapshot = sourceHead
    ? commitSnapshot(sourceRoot, sourceHead)
    : sourceSnapshot(sourceRoot);
  const runtimeRoot = join(queueDirectory, "executors-v1");
  const destination = join(runtimeRoot, snapshot.digest);
  ownerDirectory(runtimeRoot);
  if (matchesSnapshot(destination, snapshot)) {
    return {
      generation: snapshot.digest,
      entrypoint: join(destination, "scripts", "deploy-dev-app.mjs"),
    };
  }

  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  ownerDirectory(temporary);
  try {
    const directories = snapshotDirectories(temporary, snapshot.files);
    if (process.platform === "win32") {
      windowsPrivateStorage([
        ...[...directories].reverse().map((pathname) => ({ operation: "directory", pathname, create: true })),
        ...snapshot.files.map(({ relativePath, contents }) => ({
          operation: "createFile", pathname: pathInside(temporary, relativePath),
          sourceBase64: contents.toString("base64"),
        })),
      ]);
    } else {
      for (const { relativePath, contents } of snapshot.files) {
        const pathname = pathInside(temporary, relativePath);
        ownerDirectory(dirname(pathname));
        writeSnapshotFile(pathname, contents);
      }
    }
    for (const directory of directories) {
      fsyncDirectory(directory);
    }
    try {
      renameSync(temporary, destination);
      fsyncDirectory(runtimeRoot);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (!matchesSnapshot(destination, snapshot)) {
    throw new Error("dev deploy executor snapshot did not commit atomically");
  }
  return {
    generation: snapshot.digest,
    entrypoint: join(destination, "scripts", "deploy-dev-app.mjs"),
  };
}
