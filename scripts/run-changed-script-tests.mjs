#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  gitDiffNameOnlyArgs,
  parseNullDelimitedGitPaths,
} from "./lib/push-gate-scope.mjs";
import {
  SCRIPT_TEST_PROJECTS,
  scriptTestProjectForPath,
} from "./lib/script-test-projects.mjs";
import {
  SCRIPT_TEST_GRAPH_ROOTS,
  SCRIPT_TEST_MODULE_SUFFIXES,
  isScriptTestGraphInputPath,
  isScriptTestGraphPath,
  isScriptTestModulePath,
  isScriptTestOpaqueResourcePath,
  scriptTestOpaqueResourceSuffix,
} from "./lib/script-test-graph-paths.mjs";

const SCRIPT_TEST_PREFIX = "scripts/";
const SCRIPT_TEST_SUFFIX = ".test.mjs";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function runGit(args) {
  return spawnSync("git", args, {
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function outputText(result) {
  return Buffer.from(result.stdout ?? []).toString("utf8").trim();
}

function allTests(reason) {
  return { mode: "all", paths: [], reason };
}

function toRepositoryPath(value) {
  return value.split(path.sep).join("/");
}

export function listScriptTestGraphPaths(root = process.cwd()) {
  const modules = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (
        entry.isFile() &&
        isScriptTestModulePath(entry.name)
      ) {
        modules.push(toRepositoryPath(path.relative(root, absolutePath)));
      }
    }
  };
  for (const graphRoot of SCRIPT_TEST_GRAPH_ROOTS) {
    visit(path.join(root, graphRoot));
  }
  return modules.sort();
}

function resolveGraphPath(sourcePath, specifier) {
  let resolved;
  if (
    SCRIPT_TEST_GRAPH_ROOTS.some((root) => specifier.startsWith(`${root}/`))
  ) {
    resolved = path.posix.normalize(specifier);
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourcePath), specifier),
    );
  } else {
    return null;
  }
  if (!isScriptTestGraphPath(resolved)) return null;
  return resolved;
}

function referenceCandidates(sourcePath, specifier) {
  const resolved = resolveGraphPath(sourcePath, specifier);
  if (!resolved) return [];
  if (isScriptTestGraphInputPath(resolved)) {
    return [resolved];
  }
  return [
    resolved,
    ...SCRIPT_TEST_MODULE_SUFFIXES.map((suffix) => `${resolved}${suffix}`),
    `${resolved}/index.mjs`,
  ];
}

function isStringConcatenation(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

function dynamicStringFragments(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [null, span.literal.text]),
    ];
  }
  if (isStringConcatenation(node)) {
    return [
      ...dynamicStringFragments(node.left),
      ...dynamicStringFragments(node.right),
    ];
  }
  return [null];
}

function dynamicOpaqueHint(sourcePath, node) {
  const fragments = dynamicStringFragments(node);
  const firstDynamic = fragments.indexOf(null);
  if (firstDynamic < 0) return null;
  const lastDynamic = fragments.lastIndexOf(null);
  const first = fragments.slice(0, firstDynamic).join("");
  const last = fragments.slice(lastDynamic + 1).join("");
  const prefix = resolveGraphPath(sourcePath, first);
  const suffix = scriptTestOpaqueResourceSuffix(last);
  if (prefix && (suffix || last.length === 0)) {
    return { prefix, suffix: suffix ? last : "" };
  }
  if (!suffix) return null;
  if (last === suffix) return { suffix };
  return { basename: path.posix.basename(last) };
}

function scriptModuleAnalysis(sourcePath, source) {
  const parsed = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics.length > 0) {
    const diagnostic = parsed.parseDiagnostics[0];
    throw new Error(
      `script syntax invalid: ${sourcePath}: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        " ",
      )}`,
    );
  }
  const references = new Set();
  const ambiguousOpaqueHints = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      const candidates = referenceCandidates(sourcePath, node.text);
      for (const candidate of candidates) {
        references.add(candidate);
      }
      if (
        isScriptTestOpaqueResourcePath(node.text) &&
        !candidates.some(isScriptTestOpaqueResourcePath)
      ) {
        const suffix = scriptTestOpaqueResourceSuffix(node.text);
        if (node.text !== suffix) {
          ambiguousOpaqueHints.push({ basename: path.posix.basename(node.text) });
        }
      }
    } else if (
      ts.isTemplateExpression(node) ||
      (isStringConcatenation(node) && !isStringConcatenation(node.parent))
    ) {
      const hint = dynamicOpaqueHint(sourcePath, node);
      if (hint) ambiguousOpaqueHints.push(hint);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return {
    ambiguousOpaqueHints,
    references: [...references].sort(),
  };
}

export function scriptModuleReferences(sourcePath, source) {
  return scriptModuleAnalysis(sourcePath, source).references;
}

function opaqueHintMatchesPath(hint, sourcePath) {
  if ("prefix" in hint) {
    return sourcePath.startsWith(hint.prefix) && sourcePath.endsWith(hint.suffix);
  }
  if ("basename" in hint) {
    return path.posix.basename(sourcePath) === hint.basename;
  }
  return sourcePath.endsWith(hint.suffix);
}

export function affectedScriptTests({
  changedPaths,
  readSource = (sourcePath) => fs.readFileSync(sourcePath, "utf8"),
  scriptPaths = listScriptTestGraphPaths(),
}) {
  const available = new Set(scriptPaths);
  const tests = scriptPaths.filter(
    (sourcePath) =>
      sourcePath.startsWith(SCRIPT_TEST_PREFIX) &&
      sourcePath.endsWith(SCRIPT_TEST_SUFFIX),
  );
  const selected = new Set();
  const graphChangedPaths = [];
  for (const changedPath of changedPaths) {
    if (changedPath.endsWith(SCRIPT_TEST_SUFFIX)) {
      if (available.has(changedPath)) selected.add(changedPath);
    } else {
      graphChangedPaths.push(changedPath);
    }
  }
  if (graphChangedPaths.length === 0) {
    return { paths: [...selected].sort(), unresolved: [] };
  }
  const testSet = new Set(tests);
  const analyses = new Map();
  const consumersByPath = new Map();
  const pendingSources = [...tests];
  while (pendingSources.length > 0) {
    const sourcePath = pendingSources.pop();
    if (analyses.has(sourcePath)) continue;
    const analysis = scriptModuleAnalysis(sourcePath, readSource(sourcePath));
    analyses.set(sourcePath, analysis);
    for (const dependency of analysis.references) {
      const consumers = consumersByPath.get(dependency) ?? new Set();
      consumers.add(sourcePath);
      consumersByPath.set(dependency, consumers);
      if (available.has(dependency) && !analyses.has(dependency)) {
        pendingSources.push(dependency);
      }
    }
  }
  const testConsumersFor = (dependency) => {
    const consumers = new Set();
    const visited = new Set([dependency]);
    const pending = [dependency];
    while (pending.length > 0) {
      for (const sourcePath of consumersByPath.get(pending.pop()) ?? []) {
        if (visited.has(sourcePath)) continue;
        visited.add(sourcePath);
        if (testSet.has(sourcePath)) consumers.add(sourcePath);
        pending.push(sourcePath);
      }
    }
    return [...consumers].sort();
  };

  const unresolved = [];
  for (const changedPath of graphChangedPaths) {
    const consumers = testConsumersFor(changedPath);
    const hasAmbiguousConsumer =
      isScriptTestOpaqueResourcePath(changedPath) &&
      [...analyses.values()].some((analysis) =>
        analysis.ambiguousOpaqueHints.some((hint) =>
          opaqueHintMatchesPath(hint, changedPath),
        ),
      );
    if (consumers.length === 0 || hasAmbiguousConsumer) {
      unresolved.push(changedPath);
    }
    for (const consumer of consumers) selected.add(consumer);
  }
  return { paths: [...selected].sort(), unresolved };
}

function validateScriptSyntax(paths, readSource) {
  for (const sourcePath of paths.filter(isScriptTestModulePath)) {
    scriptModuleReferences(sourcePath, readSource(sourcePath));
  }
}

export function selectChangedScriptTests({
  base,
  head = "HEAD",
  git = runGit,
  pathExists = fs.existsSync,
  readSource = (sourcePath) => fs.readFileSync(sourcePath, "utf8"),
  scriptPaths = listScriptTestGraphPaths(),
} = {}) {
  if (typeof base !== "string" || !COMMIT_SHA.test(base)) {
    return allTests("verification base is unavailable or invalid");
  }

  const resolvedHead = git(["rev-parse", "--verify", `${head}^{commit}`]);
  const headSha = outputText(resolvedHead);
  if (resolvedHead.status !== 0 || !COMMIT_SHA.test(headSha)) {
    return allTests("verification head could not be resolved");
  }

  const ancestry = git(["merge-base", "--is-ancestor", base, headSha]);
  if (ancestry.status !== 0) {
    return allTests("verification base is not an ancestor of HEAD");
  }

  const diff = git(gitDiffNameOnlyArgs(base, headSha));
  if (diff.status !== 0) {
    return allTests("changed test paths could not be read");
  }

  let changedPaths;
  try {
    changedPaths = parseNullDelimitedGitPaths(
      diff.stdout ?? new Uint8Array(),
    ).filter(isScriptTestGraphInputPath);
  } catch {
    return allTests("changed test paths were malformed");
  }
  const absentOpaqueResources = changedPaths.filter(
    (changedPath) =>
      isScriptTestOpaqueResourcePath(changedPath) && !pathExists(changedPath),
  );
  if (absentOpaqueResources.length > 0) {
    return allTests(
      `changed opaque resource is absent: ${absentOpaqueResources.join(", ")}`,
    );
  }
  const currentChangedPaths = changedPaths.filter(
    (changedPath) =>
      !changedPath.endsWith(SCRIPT_TEST_SUFFIX) && pathExists(changedPath),
  );
  validateScriptSyntax(currentChangedPaths, readSource);
  const selection = affectedScriptTests({
    changedPaths,
    readSource,
    scriptPaths,
  });
  if (selection.unresolved.length > 0) {
    return allTests(
      `changed script test consumer set is incomplete: ${selection.unresolved.join(", ")}`,
    );
  }
  return { mode: "changed", paths: selection.paths, reason: null };
}

export function vitestArguments(project, paths = []) {
  const arguments_ = ["pnpm", "exec", "vitest", "run", "--project", project];
  arguments_.push(...paths);
  return arguments_;
}

function projectInvocation(project, paths = []) {
  return project.runner === "node"
    ? { command: process.execPath, args: ["--test", ...paths] }
    : { command: "corepack", args: vitestArguments(project.name, paths) };
}

export function scriptTestInvocations(selection) {
  if (selection.mode === "all") {
    return SCRIPT_TEST_PROJECTS.flatMap((project) =>
      project.separateInvocations
        ? project.paths.map((path) => projectInvocation(project, [path]))
        : [projectInvocation(project)],
    );
  }

  const pathsByProject = new Map();
  for (const path of selection.paths) {
    const project = scriptTestProjectForPath(path);
    const paths = pathsByProject.get(project) ?? [];
    paths.push(path);
    pathsByProject.set(project, paths);
  }
  return SCRIPT_TEST_PROJECTS.flatMap((project) => {
    const paths = pathsByProject.get(project.name);
    if (!paths) return [];
    return project.separateInvocations
      ? paths.map((path) => projectInvocation(project, [path]))
      : [projectInvocation(project, paths)];
  });
}

export function runSelectedScriptTests({
  all = false,
  base =
    process.env.DURE_VERIFICATION_BASE_SHA ??
    process.env.HEBBIAN_VERIFICATION_BASE_SHA,
  run = spawnSync,
  selectionOptions = {},
} = {}) {
  const scriptPaths =
    selectionOptions.scriptPaths ?? listScriptTestGraphPaths();
  const readSource =
    selectionOptions.readSource ??
    ((sourcePath) => fs.readFileSync(sourcePath, "utf8"));
  const resolvedSelectionOptions = {
    ...selectionOptions,
    readSource,
    scriptPaths,
  };
  const selection = all
    ? allTests("full script gate requested")
    : selectChangedScriptTests({ base, ...resolvedSelectionOptions });
  if (selection.mode === "all") {
    validateScriptSyntax(scriptPaths, readSource);
  }
  if (selection.mode === "changed" && selection.paths.length === 0) {
    console.log("script tests: no current changed test files — suite skipped");
    return 0;
  }
  if (selection.mode === "all") {
    console.log(`script tests: ${selection.reason} — running the full suite`);
  } else {
    console.log(`script tests: running ${selection.paths.length} changed file(s)`);
  }
  for (const { command, args } of scriptTestInvocations(selection)) {
    const result = run(command, args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = runSelectedScriptTests({
      all: process.argv.slice(2).includes("--all"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
