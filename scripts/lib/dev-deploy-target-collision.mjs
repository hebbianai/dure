import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

function treePaths(root, commit) {
  const source = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--name-only", commit],
    { cwd: root, encoding: null, env: withoutLocalGitOverrides() },
  );
  const paths = [];
  const end = source.length - (source.at(-1) === 0 ? 1 : 0);
  for (const bytes of source.subarray(0, end).toString("binary").split("\0")) {
    if (!bytes) continue;
    const raw = Buffer.from(bytes, "binary");
    const path = raw.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(raw)) {
      throw new Error("integrated target contains a non-UTF-8 path");
    }
    if (
      isAbsolute(path) ||
      path
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`integrated target contains an unsafe path: ${path}`);
    }
    paths.push(path);
  }
  return paths;
}

function optionalLstat(pathname) {
  try {
    return lstatSync(pathname);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function localOnlyDescendant(root, relativePath, currentPaths) {
  const entries = readdirSync(join(root, relativePath), {
    withFileTypes: true,
  });
  if (entries.length === 0) return relativePath;
  for (const entry of entries) {
    const child = `${relativePath}/${entry.name}`;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const collision = localOnlyDescendant(root, child, currentPaths);
      if (collision) return collision;
    } else if (!currentPaths.has(child)) {
      return child;
    }
  }
  return undefined;
}

function collisionAt(root, targetPath, currentPaths) {
  const exact = optionalLstat(join(root, targetPath));
  if (exact) {
    const hasTrackedDescendant = [...currentPaths].some((path) =>
      path.startsWith(`${targetPath}/`),
    );
    if (!exact.isDirectory() || exact.isSymbolicLink() || !hasTrackedDescendant) {
      return targetPath;
    }
    const descendant = localOnlyDescendant(root, targetPath, currentPaths);
    if (descendant) return descendant;
  }

  const segments = targetPath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    if (currentPaths.has(ancestor)) break;
    const stat = optionalLstat(join(root, ancestor));
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) return ancestor;
  }
  return undefined;
}

export function assertNoHeadTransitionTargetPathCollision({
  root,
  currentHead,
  targetHead,
}) {
  const currentPaths = new Set(treePaths(root, currentHead));
  const targetPaths = treePaths(root, targetHead);
  for (const targetPath of targetPaths) {
    if (currentPaths.has(targetPath)) continue;
    const collision = collisionAt(root, targetPath, currentPaths);
    if (collision) {
      throw new Error(`head transition target path collision: ${collision}`);
    }
  }
}
