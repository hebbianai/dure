import fs from "node:fs";
import path from "node:path";
import { htmlLanguage } from "@codemirror/lang-html";
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from "@codemirror/lang-javascript";
import { rustLanguage } from "@codemirror/lang-rust";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const RUNTIME_ROOTS = [
  "src",
  "src-tauri/src",
  "mobile/src",
  "mobile/src-tauri/src",
  "crates",
  "hmux/crates",
  "cli",
];

const ROOT_RUNTIME_FILES = ["index.html", "vite.config.ts"];
const SOURCE_PARSERS = {
  ".html": htmlLanguage.parser,
  ".js": javascriptLanguage.parser,
  ".jsx": jsxLanguage.parser,
  ".json": null,
  ".mjs": javascriptLanguage.parser,
  ".rs": rustLanguage.parser,
  ".toml": null,
  ".ts": typescriptLanguage.parser,
  ".tsx": tsxLanguage.parser,
};
const FORBIDDEN_REFERENCES = [
  "docs/public/",
  "tools/media-capture",
  "public/readme",
];
const COMMENT_NODES = new Set(["Comment", "LineComment", "BlockComment"]);
const DEPENDENCY_DIRECTIVE = /<reference\s|@jsxImportSource\b|[#@]\s*source(?:Mapping)?URL=/;

function withoutCitations(source, file) {
  const extension = path.extname(file);
  if (extension === ".toml") {
    return stringifyToml(parseToml(source, { integersAsBigInt: true }));
  }
  const parser = SOURCE_PARSERS[extension];
  if (!parser) return source;
  const parts = [];
  let start = 0;
  parser.parse(source).iterate({
    enter(node) {
      if (!COMMENT_NODES.has(node.name)) return;
      // Compiler and source-map directives are dependencies, not citations.
      if (!DEPENDENCY_DIRECTIVE.test(source.slice(node.from, node.to))) {
        parts.push(source.slice(start, node.from), "\n");
        start = node.to;
      }
      // Rust block comments can contain other block comments.
      return false;
    },
  });
  parts.push(source.slice(start));
  return parts.join("");
}

function sourceFilesBelow(root) {
  if (!fs.existsSync(root)) return [];
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && Object.hasOwn(SOURCE_PARSERS, path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }
  return files;
}

/**
 * Public documentation and media capture paths are allowed to skip product
 * gates only while production code cannot import or embed them. This scan runs
 * inside architecture:check, so a future runtime-side reference fails on the
 * change that introduces it.
 */
export function productMediaBoundaryViolations(repositoryRoot) {
  const candidates = [
    ...RUNTIME_ROOTS.flatMap((relativeRoot) =>
      sourceFilesBelow(path.join(repositoryRoot, relativeRoot)),
    ),
    ...ROOT_RUNTIME_FILES.map((relativePath) => path.join(repositoryRoot, relativePath)).filter(
      fs.existsSync,
    ),
  ];
  const violations = [];
  for (const file of candidates) {
    const raw = fs.readFileSync(file, "utf8");
    if (!FORBIDDEN_REFERENCES.some((reference) => raw.includes(reference))) continue;
    const source = withoutCitations(raw, file);
    for (const forbidden of FORBIDDEN_REFERENCES) {
      if (source.includes(forbidden)) {
        violations.push(
          `productMediaBoundary: ${path.relative(repositoryRoot, file)} references ${forbidden}`,
        );
      }
    }
  }
  return violations.sort();
}
