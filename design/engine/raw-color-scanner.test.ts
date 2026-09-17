import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countRawColors, scanRawColors } from "./raw-color-scanner.ts";

describe("countRawColors", () => {
  it("counts exact-length hex literals and color functions", () => {
    expect(countRawColors(`const a = "#fff"; const b = "#a5b4fc24";`)).toBe(2);
    expect(countRawColors(`const s = { color: "rgb(1, 2, 3)", bg: \`oklch(0.5 0.1 200)\` };`)).toBe(2);
    expect(countRawColors(`color: rgb(1, 2, 3); background: oklch(0.5 0.1 200);`, "css")).toBe(2);
  });

  it("excludes comments even after JSX text containing apostrophes", () => {
    const jsx = `export function T() {\n  return <span>Don't panic</span>;\n}\n// 앱 --accent(≈#2b2b2b)는 시안 강조(#404040)보다 어둡다\n`;
    expect(countRawColors(jsx)).toBe(0);
  });

  it("ignores anchors, odd-length hex words, and comments", () => {
    expect(countRawColors(`href="#empty-state"`)).toBe(0);
    expect(countRawColors(`"#added"`)).toBe(0); // 5 hex-ish chars — not a color length
    expect(countRawColors(`// #ffffff\n/* #000 */`)).toBe(0);
    expect(countRawColors(`const url = "https://x.test/#abc";`)).toBe(1); // protocol // is not a comment; #abc counts
  });

  it("does not treat var() as a color function", () => {
    expect(countRawColors(`color: var(--status-error);`)).toBe(0);
  });

  it.each([
    `<input placeholder="#123" />`,
    `<Input placeholder="#123" />`,
    `<textarea placeholder="#abcd or rgb(1, 2, 3)" />`,
  ])("treats literal JSX placeholder text as copy: %s", (source) => {
    expect(countRawColors(source)).toBe(0);
  });

  it("does not classify the real duplicate-issue number placeholder as paint", () => {
    const source = readFileSync(
      new URL("../../src/components/github/GitHubIssueStatusControl.tsx", import.meta.url),
      "utf8",
    );
    expect(countRawColors(source)).toBe(0);
  });

  it.each([
    `<Input placeholder="#123" style={{ color: "#123" }} />`,
    `<svg placeholder="#123" fill="#123" />`,
    `<Input placeholder="#123" className="bg-[#123]" />`,
    `<><Input placeholder="#123" /><span style={{ color: "#123" }} /></>`,
    `<Input placeholder={preview({ style: { color: "#123" } })} />`,
    `<Input placeholder={preview(<svg fill="#123" />)} />`,
    `<Input placeholder={preview(<span className="bg-[#123]" />)} />`,
    `<Input placeholder={preview(\`bg-[#123]\`)} />`,
    `<Input placeholder={\`Example: \${preview({ color: "#123" })}\`} />`,
    `const options = { placeholder: "#123" };`,
  ])("keeps sibling colors and unclassified expressions visible: %s", (source) => {
    expect(countRawColors(source)).toBe(1);
  });

  it("mid-string // does not swallow later literals (AST counting)", () => {
    expect(countRawColors(`const p = "a//b"; const c = "#fff";`)).toBe(1);
    expect(countRawColors(`const cdn = "//cdn.x/y"; const c = "#123456";`)).toBe(1);
    // A bare rgb() CALL in ts code is a color-library invocation, not a raw
    // literal — only string-context "rgb(...)" counts.
    expect(countRawColors(`s.split("//"); rgb(1,2,3)`)).toBe(0);
  });

  it("in-string /* does not open a comment; stripped bytes keep spacing", () => {
    expect(countRawColors(`const g = "/*"; const c = "#123456"; const h = "*/";`)).toBe(1);
    // A block comment splitting a hex literal must not fuse it into a color.
    expect(countRawColors(`const x = "#ff" /* gap */ + "ffff";`)).toBe(0);
  });

  it("css files strip only block comments, so url(//cdn…) survives", () => {
    expect(countRawColors(`a { background: url(//cdn.x/i.png); color: #123456; }`, "css")).toBe(1);
    expect(countRawColors(`/* #ffffff */ b { color: oklch(0.5 0.1 200); }`, "css")).toBe(1);
  });
});

describe("scanRawColors regression judgment", () => {
  it("rejects actual painting colors beside an issue-number placeholder", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-color-placeholder-"));
    const file = "src/components/demo/Issue.tsx";
    try {
      mkdirSync(join(root, "src/components/demo"), { recursive: true });
      writeFileSync(
        join(root, file),
        `<><Input placeholder="#123" style={{ color: "#123" }} className="bg-[#123]" /><svg fill="#123" /></>`,
      );
      const scan = scanRawColors(root);
      expect(scan.total).toBe(3);
      expect(scan.files[file]).toBe(3);
      expect(scan.regressions).toEqual([
        expect.objectContaining({ code: "raw-color-regression", file }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("errors only above the allowlisted count and stays silent within it", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-color-"));
    mkdirSync(join(root, "src/components/demo"), { recursive: true });
    mkdirSync(join(root, "design"), { recursive: true });
    writeFileSync(join(root, "src/components/demo/Chip.tsx"), `const c = "#123456";\nconst d = "#abcdef";\n`);
    writeFileSync(
      join(root, "design/raw-color-allowlist.json"),
      `${JSON.stringify({ schemaVersion: 1, files: { "src/components/demo/Chip.tsx": 2 } })}\n`,
    );
    const ok = scanRawColors(root);
    expect(ok.total).toBe(2);
    expect(ok.regressions).toEqual([]);

    writeFileSync(
      join(root, "src/components/demo/Chip.tsx"),
      `const c = "#123456";\nconst d = "#abcdef";\nconst e = "#0f0";\n`,
    );
    const regressed = scanRawColors(root);
    expect(regressed.total).toBe(3);
    expect(regressed.regressions).toHaveLength(1);
    expect(regressed.regressions[0].code).toBe("raw-color-regression");
    rmSync(root, { recursive: true, force: true });
  });

  it("reports but never gates raw colors outside the classifier-covered denominator", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-color-report-"));
    mkdirSync(join(root, "src/lib/scm"), { recursive: true });
    writeFileSync(join(root, "src/lib/scm/graph.ts"), `const lane = "#123456";\n`);
    const scan = scanRawColors(root);
    expect(scan.total).toBe(1);
    expect(scan.files["src/lib/scm/graph.ts"]).toBe(1);
    expect(scan.regressions).toEqual([]); // dashboard signal only — gate surface is src/components/**
    rmSync(root, { recursive: true, force: true });
  });

  it("reports allowlist rot when the actual count drops below the allowance", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-color-stale-"));
    mkdirSync(join(root, "src/components/demo"), { recursive: true });
    mkdirSync(join(root, "design"), { recursive: true });
    writeFileSync(join(root, "src/components/demo/Chip.tsx"), `const c = "#123456";\n`);
    writeFileSync(
      join(root, "design/raw-color-allowlist.json"),
      `${JSON.stringify({ schemaVersion: 1, files: { "src/components/demo/Chip.tsx": 3, "src/components/demo/Gone.tsx": 2 } })}\n`,
    );
    const scan = scanRawColors(root);
    expect(scan.regressions).toEqual([]);
    expect(scan.stale).toEqual([
      { file: "src/components/demo/Chip.tsx", allowed: 3, actual: 1 },
      { file: "src/components/demo/Gone.tsx", allowed: 2, actual: 0 },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("excludes the token source, theme lib, and test files", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-color-excl-"));
    mkdirSync(join(root, "src/lib/theme"), { recursive: true });
    writeFileSync(join(root, "src/index.css"), `:root { --x: #123456; }\n`);
    writeFileSync(join(root, "src/lib/theme/palette.ts"), `export const P = "#abcdef";\n`);
    writeFileSync(join(root, "src/lib/thing.test.ts"), `const fixture = "#fedcba";\n`);
    const scan = scanRawColors(root);
    expect(scan.total).toBe(0);
    expect(scan.regressions).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
