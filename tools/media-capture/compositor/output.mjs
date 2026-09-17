import { relative, resolve } from "node:path";

function assertContained(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(root, pathFromRoot) !== candidate
  ) {
    throw new Error(`${label} must stay below the storyboard output root`);
  }
}

function assertPathSegment(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[\\/]/u.test(value)
  ) {
    throw new Error(`${label} must be one safe path segment`);
  }
}

export function storyboardOutputPaths({
  outputRoot,
  storyboardId,
  locale,
  target,
}) {
  assertPathSegment(storyboardId, "storyboard id");
  assertPathSegment(locale, "storyboard locale");
  assertPathSegment(target.id, "storyboard target id");
  const directory = resolve(outputRoot, storyboardId, locale, target.id);
  assertContained(outputRoot, directory, "storyboard output");
  const stem = `${storyboardId}.${locale}.${target.id}`;
  return storyboardPathsInDirectory({
    directory,
    storyboardId,
    locale,
    target,
  });
}

export function storyboardPathsInDirectory({
  directory,
  storyboardId,
  locale,
  target,
}) {
  assertPathSegment(storyboardId, "storyboard id");
  assertPathSegment(locale, "storyboard locale");
  assertPathSegment(target.id, "storyboard target id");
  const stem = `${storyboardId}.${locale}.${target.id}`;
  const paths = {
    directory,
    plan: resolve(directory, `${stem}.render-plan.json`),
    media: resolve(directory, `${stem}.${target.format}`),
  };
  assertContained(directory, paths.plan, "storyboard render plan");
  assertContained(directory, paths.media, "storyboard media");
  return paths;
}
