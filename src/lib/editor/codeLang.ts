/**
 * 파일 이름 → 언어 id 매핑. CodeMirror를 import 하지 않는 가벼운 모듈이다.
 *
 * 실제 문법 패키지는 `codeLangExtensions.ts`가 들고 있고 에디터가 뜰 때만
 * 지연 로드된다 — 언어팩 전체가 앱 시작 번들에 들어가면 1MB 가까이 된다.
 * 여기(id 목록)가 단일 출처이고, 무거운 쪽은 id를 받아 확장을 돌려준다.
 */

export type LangId =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "rust"
  | "go"
  | "cpp"
  | "java"
  | "swift"
  | "python"
  | "ruby"
  | "php"
  | "perl"
  | "lua"
  | "haskell"
  | "clojure"
  | "shell"
  | "json"
  | "yaml"
  | "toml"
  | "properties"
  | "html"
  | "xml"
  | "css"
  | "markdown"
  | "sql"
  | "diff"
  | "dockerfile";

/** 확장자(소문자, 점 제외) → 언어 id */
const BY_EXT: Record<string, LangId> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  rs: "rust",
  go: "go",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  java: "java",
  // Kotlin 전용 팩이 없어 Java 문법으로 근사한다 — 키워드 상당수가 겹친다.
  kt: "java",
  kts: "java",
  swift: "swift",
  py: "python",
  pyi: "python",
  rb: "ruby",
  php: "php",
  pl: "perl",
  lua: "lua",
  hs: "haskell",
  clj: "clojure",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "properties",
  conf: "properties",
  env: "properties",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};

/** 확장자가 없는 잘 알려진 파일 이름 */
const BY_NAME: Record<string, LangId> = {
  dockerfile: "dockerfile",
  makefile: "properties",
  ".gitignore": "properties",
  ".env": "properties",
};

/** 파일 이름의 언어 id. 모르는 형식이면 null(플레인 텍스트). */
export function langIdFor(fileName: string): LangId | null {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  const lower = base.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXT[lower.slice(dot + 1)] ?? null;
}

/** 상태 표시줄에 쓸 짧은 라벨 — 확장자를 그대로 보여준다. */
export function languageLabel(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  const lower = base.toLowerCase();
  if (BY_NAME[lower]) return lower;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "text";
  const ext = lower.slice(dot + 1);
  return BY_EXT[ext] ? ext : "text";
}
