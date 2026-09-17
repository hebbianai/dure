export const SCRIPT_TEST_GRAPH_ROOTS = Object.freeze(["scripts", "cli"]);
export const SCRIPT_TEST_MODULE_SUFFIXES = Object.freeze([".mjs", ".js"]);
const OPAQUE_RESOURCE_SUFFIXES = Object.freeze([".py", ".sh", ".c"]);
const GRAPH_INPUT_SUFFIXES = Object.freeze([
  ...SCRIPT_TEST_MODULE_SUFFIXES,
  ...OPAQUE_RESOURCE_SUFFIXES,
]);

function hasSuffix(sourcePath, suffixes) {
  return suffixes.some((suffix) => sourcePath.endsWith(suffix));
}

export function isScriptTestGraphPath(sourcePath) {
  return SCRIPT_TEST_GRAPH_ROOTS.some(
    (root) => sourcePath === root || sourcePath.startsWith(`${root}/`),
  );
}

export function isScriptTestGraphInputPath(sourcePath) {
  return (
    isScriptTestGraphPath(sourcePath) &&
    hasSuffix(sourcePath, GRAPH_INPUT_SUFFIXES)
  );
}

export function isScriptTestModulePath(sourcePath) {
  return hasSuffix(sourcePath, SCRIPT_TEST_MODULE_SUFFIXES);
}

export function scriptTestOpaqueResourceSuffix(sourcePath) {
  return OPAQUE_RESOURCE_SUFFIXES.find((suffix) =>
    sourcePath.endsWith(suffix),
  );
}

export function isScriptTestOpaqueResourcePath(sourcePath) {
  return scriptTestOpaqueResourceSuffix(sourcePath) !== undefined;
}
