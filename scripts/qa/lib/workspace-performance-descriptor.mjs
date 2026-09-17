import fs from "node:fs";
import path from "node:path";

export function resolveWorkspacePerformanceDescriptorPath({
  descriptorPath,
  home,
  stateRoot,
}) {
  const root = path.resolve(requiredValue(stateRoot, "DURE_QA_STATE_ROOT"));
  const resolvedHome = path.resolve(requiredValue(home, "HOME"));
  if (resolvedHome !== path.join(root, "home")) {
    throw new Error("workspace performance QA HOME escaped its isolated root");
  }

  const realRoot = fs.realpathSync(root);
  const realHome = fs.realpathSync(resolvedHome);
  if (realHome !== path.join(realRoot, "home")) {
    throw new Error("workspace performance QA HOME escaped its isolated root");
  }

  const dureState = path.join(resolvedHome, ".dure");
  const dureStateMetadata = fs.lstatSync(dureState);
  if (dureStateMetadata.isSymbolicLink() || !dureStateMetadata.isDirectory()) {
    throw new Error("workspace performance isolated Dure state is not a directory");
  }
  const realDureState = fs.realpathSync(dureState);
  if (realDureState !== path.join(realHome, ".dure")) {
    throw new Error("workspace performance isolated Dure state escaped HOME");
  }

  const configured = requiredValue(
    descriptorPath,
    "DURE_QA_SERVER_DESCRIPTOR",
  );
  if (!path.isAbsolute(configured)) {
    throw new Error(
      "workspace performance server descriptor escaped its isolated Dure state",
    );
  }
  const resolvedDescriptor = path.resolve(configured);
  const relative = path.relative(dureState, resolvedDescriptor);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "workspace performance server descriptor escaped its isolated Dure state",
    );
  }
  assertExistingComponentsAreDirectories(dureState, relative);
  assertExistingDescriptorRealpath(
    resolvedDescriptor,
    path.join(realDureState, relative),
  );
  return resolvedDescriptor;
}

export function readWorkspacePerformanceDescriptor(options) {
  const filename = resolveWorkspacePerformanceDescriptorPath(options);
  let metadata;
  try {
    metadata = fs.lstatSync(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  assertOwnerOnlyRegularDescriptor(metadata);

  const descriptor = readExactRegularFile(filename, metadata, options);
  const value = JSON.parse(descriptor);
  return Number.isInteger(value.port) && typeof value.token === "string"
    ? value
    : undefined;
}

function assertExistingDescriptorRealpath(filename, expectedRealpath) {
  try {
    if (fs.realpathSync(filename) !== expectedRealpath) {
      throw new Error(
        "workspace performance server descriptor escaped its isolated Dure state",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertOwnerOnlyRegularDescriptor(metadata) {
  if (metadata.isSymbolicLink()) {
    throw new Error(
      "workspace performance server descriptor path contains a symlink",
    );
  }
  if (!metadata.isFile()) {
    throw new Error(
      "workspace performance server descriptor is not a regular file",
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("server descriptor is not owner-only");
  }
}

function requiredValue(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function assertExistingComponentsAreDirectories(root, relative) {
  const components = relative.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    let metadata;
    try {
      metadata = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        "workspace performance server descriptor path contains a symlink",
      );
    }
    if (index < components.length - 1 && !metadata.isDirectory()) {
      throw new Error(
        "workspace performance server descriptor parent is not a directory",
      );
    }
  }
}

function readExactRegularFile(filename, expectedMetadata, options) {
  const noFollow = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(filename, noFollow);
  try {
    const openedMetadata = fs.fstatSync(descriptor);
    assertOwnerOnlyRegularDescriptor(openedMetadata);
    if (
      openedMetadata.dev !== expectedMetadata.dev ||
      openedMetadata.ino !== expectedMetadata.ino
    ) {
      throw new Error(
        "workspace performance server descriptor changed before read",
      );
    }
    const resolvedFilename = resolveWorkspacePerformanceDescriptorPath(options);
    if (resolvedFilename !== filename) {
      throw new Error(
        "workspace performance server descriptor changed before read",
      );
    }
    const currentMetadata = fs.lstatSync(filename);
    assertOwnerOnlyRegularDescriptor(currentMetadata);
    if (
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino ||
      currentMetadata.mode !== openedMetadata.mode
    ) {
      throw new Error(
        "workspace performance server descriptor changed before read",
      );
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}
