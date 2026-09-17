import { lstat, mkdir, realpath, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

function isMissing(error) {
  return error?.code === "ENOENT";
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

export async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function canonicalizeAllowedOutputRoot(allowedRoot) {
  const lexicalRoot = resolve(allowedRoot);
  const lexicalStatus = await lstatIfExists(lexicalRoot);
  if (!lexicalStatus) {
    throw new Error(`allowed output root does not exist: ${lexicalRoot}`);
  }
  if (lexicalStatus.isSymbolicLink() || !lexicalStatus.isDirectory()) {
    throw new Error(`allowed output root is not a real directory: ${lexicalRoot}`);
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(lexicalRoot);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`allowed output root does not exist: ${lexicalRoot}`);
    }
    throw error;
  }
  const rootStatus = await lstat(canonicalRoot);
  if (!rootStatus.isDirectory()) {
    throw new Error(`allowed output root is not a directory: ${lexicalRoot}`);
  }
  return Object.freeze({ canonicalRoot, lexicalRoot });
}

export function resolveAllowedOutputPath(root, candidate, label = "output path") {
  const lexicalCandidate = resolve(candidate);
  if (!isWithin(root.lexicalRoot, lexicalCandidate)) {
    throw new Error(`${label} escapes the allowed output root`);
  }
  const pathFromRoot = relative(root.lexicalRoot, lexicalCandidate);
  const canonicalCandidate = resolve(root.canonicalRoot, pathFromRoot);
  if (!isWithin(root.canonicalRoot, canonicalCandidate)) {
    throw new Error(`${label} escapes the canonical output root`);
  }
  return canonicalCandidate;
}

function assertDirectoryStatus(status, path, label) {
  if (status.isSymbolicLink()) {
    throw new Error(`${label} contains a symbolic link: ${path}`);
  }
  if (!status.isDirectory()) {
    throw new Error(`${label} contains a non-directory ancestor: ${path}`);
  }
}

/**
 * Resolves an output directory below an existing trusted root. Every existing
 * ancestor is inspected before the first mkdir. Missing ancestors are then
 * created one component at a time and re-inspected without following links.
 */
export async function ensureSafeOutputDirectory({
  allowedRoot,
  directory,
  label = "output directory",
}) {
  const root = await canonicalizeAllowedOutputRoot(allowedRoot);
  const outputDirectory = resolveAllowedOutputPath(root, directory, label);
  const pathFromRoot = relative(root.canonicalRoot, outputDirectory);
  const components = pathFromRoot === "" ? [] : pathFromRoot.split(sep);

  let current = root.canonicalRoot;
  let firstMissing = components.length;
  for (let index = 0; index < components.length; index += 1) {
    current = resolve(current, components[index]);
    const status = await lstatIfExists(current);
    if (!status) {
      firstMissing = index;
      break;
    }
    assertDirectoryStatus(status, current, label);
    const resolvedAncestor = await realpath(current);
    if (!isWithin(root.canonicalRoot, resolvedAncestor)) {
      throw new Error(`${label} ancestor escapes the allowed output root`);
    }
  }

  current = root.canonicalRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = resolve(current, components[index]);
    if (index >= firstMissing) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    const status = await lstat(current);
    assertDirectoryStatus(status, current, label);
    const resolvedAncestor = await realpath(current);
    if (!isWithin(root.canonicalRoot, resolvedAncestor)) {
      throw new Error(`${label} ancestor escapes the allowed output root`);
    }
  }

  return Object.freeze({ ...root, outputDirectory });
}

export async function resolveSafeExistingDirectory({
  allowedRoot,
  directory,
  label = "input directory",
}) {
  const root = await canonicalizeAllowedOutputRoot(allowedRoot);
  const inputDirectory = resolveAllowedOutputPath(root, directory, label);
  const pathFromRoot = relative(root.canonicalRoot, inputDirectory);
  const components = pathFromRoot === "" ? [] : pathFromRoot.split(sep);
  let current = root.canonicalRoot;
  for (const component of components) {
    current = resolve(current, component);
    const status = await lstatIfExists(current);
    if (!status) throw new Error(`${label} does not exist: ${current}`);
    assertDirectoryStatus(status, current, label);
    const resolvedAncestor = await realpath(current);
    if (!isWithin(root.canonicalRoot, resolvedAncestor)) {
      throw new Error(`${label} ancestor escapes the allowed root`);
    }
  }
  return inputDirectory;
}

export async function captureDirectoryFence(path, label = "directory") {
  const status = await lstat(path);
  assertDirectoryStatus(status, path, label);
  return Object.freeze({
    path,
    canonicalPath: await realpath(path),
    device: status.dev,
    inode: status.ino,
  });
}

export async function assertDirectoryFence(fence, label = "directory") {
  const current = await captureDirectoryFence(fence.path, label);
  if (
    current.device !== fence.device ||
    current.inode !== fence.inode ||
    current.canonicalPath !== fence.canonicalPath
  ) {
    throw new Error(`${label} changed during the generation`);
  }
  return current;
}

export async function assertRegularDirectoryTree(directory, label = "output tree") {
  const rootStatus = await lstat(directory);
  assertDirectoryStatus(rootStatus, directory, label);
  const pending = [directory];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const name of await readdir(parent)) {
      const path = resolve(parent, name);
      const status = await lstat(path);
      if (status.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${path}`);
      }
      if (status.isDirectory()) {
        pending.push(path);
      } else if (!status.isFile()) {
        throw new Error(`${label} contains a special filesystem entry: ${path}`);
      }
    }
  }
}
