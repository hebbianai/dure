import { isDeepStrictEqual } from "node:util";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPT_COUNT = 4_096;
const MAX_SCRIPT_COMMAND_BYTES = 64 * 1024;
const SIMPLE_SHELL_TOKEN = /^[A-Za-z0-9_@%+,./:=~-]+$/u;
const AMBIGUOUS_SHELL_SYNTAX = /[\0\r\n`$;|<>\\'"(){}[\]*?!#]/u;
const UNSAFE_LIFECYCLE_SCRIPT =
  /^(?:pre|post)?(?:dependencies|install|pack|prepare|publish|publishOnly|restart|start|stop|test|uninstall|version)$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManifest(source) {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    Buffer.byteLength(source) > MAX_MANIFEST_BYTES
  ) {
    return null;
  }
  const manifest = JSON.parse(source);
  if (!isObject(manifest)) return null;

  const scripts = Object.hasOwn(manifest, "scripts") ? manifest.scripts : {};
  if (!isObject(scripts)) return null;
  const entries = Object.entries(scripts);
  if (
    entries.length > MAX_SCRIPT_COUNT ||
    entries.some(
      ([name, command]) =>
        name.length === 0 ||
        typeof command !== "string" ||
        Buffer.byteLength(command) > MAX_SCRIPT_COMMAND_BYTES,
    )
  ) {
    return null;
  }
  return { manifest, scripts };
}

function nonScriptFieldsEqual(left, right) {
  const withoutScripts = (manifest) =>
    Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== "scripts"),
    );
  return isDeepStrictEqual(withoutScripts(left), withoutScripts(right));
}

function unsafeScriptName(name) {
  return (
    UNSAFE_LIFECYCLE_SCRIPT.test(name) ||
    name.split(":").some((segment) => /build/iu.test(segment))
  );
}

function simpleCommandSegments(command) {
  if (
    command.trim().length === 0 ||
    AMBIGUOUS_SHELL_SYNTAX.test(command) ||
    command.replaceAll("&&", "").includes("&")
  ) {
    return null;
  }
  const segments = command.split("&&").map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) return null;
  const tokenized = segments.map((segment) => segment.split(/[ \t]+/u));
  return tokenized.every((tokens) =>
    tokens.every((token) => SIMPLE_SHELL_TOKEN.test(token)),
  )
    ? tokenized
    : null;
}

function repositoryCommandPath(token) {
  const candidate = token.startsWith("./") ? token.slice(2) : token;
  if (
    candidate.length === 0 ||
    candidate.startsWith("/") ||
    !candidate.includes("/") ||
    candidate
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    return null;
  }
  return candidate;
}

function pathsForScript(name, scripts, visiting) {
  if (
    unsafeScriptName(name) ||
    visiting.has(name) ||
    !Object.hasOwn(scripts, name)
  ) {
    return null;
  }
  const nextVisiting = new Set(visiting).add(name);
  return pathsForCommand(scripts[name], scripts, nextVisiting);
}

function pathsForInvocation(name, scripts, visiting) {
  if (!Object.hasOwn(scripts, name)) return null;
  const paths = [];
  for (const invokedName of [`pre${name}`, name, `post${name}`]) {
    if (!Object.hasOwn(scripts, invokedName)) continue;
    const invokedPaths = pathsForScript(invokedName, scripts, visiting);
    if (!invokedPaths) return null;
    paths.push(...invokedPaths);
  }
  return paths;
}

function pathsForSegment(tokens, scripts, visiting) {
  let command = tokens;
  if (command[0] === "corepack") {
    if (command[1] !== "pnpm") return null;
    command = command.slice(1);
  }

  if (command[0] === "pnpm") {
    const scriptName =
      command[1] === "run" && command.length === 3 ? command[2] : null;
    return scriptName ? pathsForInvocation(scriptName, scripts, visiting) : null;
  }

  if (["bash", "node", "sh"].includes(command[0])) {
    if (command.length !== 2) return null;
    const sourcePath = repositoryCommandPath(command[1]);
    return sourcePath ? [sourcePath] : null;
  }

  if (command.length !== 1) return null;
  const sourcePath = repositoryCommandPath(command[0]);
  return sourcePath ? [sourcePath] : null;
}

function pathsForCommand(command, scripts, visiting) {
  const segments = simpleCommandSegments(command);
  if (!segments) return null;
  const paths = [];
  for (const segment of segments) {
    const segmentPaths = pathsForSegment(segment, scripts, visiting);
    if (!segmentPaths) return null;
    paths.push(...segmentPaths);
  }
  return paths;
}

function changedScriptNames(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .sort();
}

/**
 * Parse a trusted before/after root manifest pair into repository command paths.
 * `null` means the change is not provably script-only and callers must fail
 * closed. The restricted command grammar intentionally recognizes only direct
 * repository executables and package-script composition; arbitrary shell stays
 * outside this semantic boundary.
 */
export function packageManifestScriptImpactPaths(evidence) {
  try {
    const before = parseManifest(evidence?.before);
    const after = parseManifest(evidence?.after);
    if (
      !before ||
      !after ||
      !nonScriptFieldsEqual(before.manifest, after.manifest)
    ) {
      return null;
    }

    const paths = new Set();
    for (const name of changedScriptNames(before.scripts, after.scripts)) {
      if (unsafeScriptName(name)) return null;
      for (const scripts of [before.scripts, after.scripts]) {
        if (!Object.hasOwn(scripts, name)) continue;
        const commandPaths = pathsForInvocation(name, scripts, new Set());
        if (!commandPaths) return null;
        for (const sourcePath of commandPaths) paths.add(sourcePath);
      }
    }
    return [...paths].sort();
  } catch {
    return null;
  }
}
