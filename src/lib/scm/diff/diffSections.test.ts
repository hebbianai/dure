import { describe, expect, it } from "vitest";
import { splitDiffSections } from "@/lib/scm/diff/diffSections";

const commitShow = [
  "commit abc123",
  "Author: Jay",
  "",
  "    fix: something",
  "",
  " a.ts | 2 +-",
  " b.ts | 1 +",
  "",
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/dir/b.ts b/dir/b.ts",
  "@@ -0,0 +1 @@",
  "+added",
].join("\n");

describe("splitDiffSections", () => {
  it("preserves preamble, adjacent patch boundaries and the final newline exactly", () => {
    const text = `${commitShow}\n`;
    const sections = splitDiffSections(text);
    expect(sections.map((section) => section.text).join("\n")).toBe(text);
    expect(sections.map((section) => section.fromLine)).toEqual([1, 9, 16]);
  });
  it.each([
    ['diff --git "a/sp ace.ts" "b/sp ace.ts"\n--- "a/sp ace.ts"\n+++ "b/sp ace.ts"\n@@ -1 +1 @@\n-a\n+b', "sp ace.ts"],
    ['diff --git a/assets b/logo.png b/assets b/logo.png\nBinary files differ', "assets b/logo.png"],
    ['diff --git a/old.txt b/b/new.ts\nsimilarity index 100%\nrename from old.txt\nrename to b/new.ts', "b/new.ts"],
  ])("resolves a file path from git metadata without losing path text", (diff, path) => {
    expect(splitDiffSections(diff)[0].file).toBe(path);
  });
  it("헤더(메시지·stat)와 파일별 섹션으로 나눈다", () => {
    const sections = splitDiffSections(commitShow);
    expect(sections.map((s) => s.file)).toEqual([null, "a.ts", "dir/b.ts"]);
    expect(sections[0].text).toContain("fix: something");
    expect(sections[1].text).toContain("+new");
    expect(sections[2].text).toContain("+added");
  });

  it("diff 경계 없는 텍스트(파일 하나짜리 diff 명령 출력 등)는 그대로", () => {
    const single = "@@ -1 +1 @@\n-a\n+b";
    expect(splitDiffSections(single)).toEqual([{ file: null, text: single, fromLine: 1 }]);
  });

  it("헤더가 공백뿐이면 버린다 (git diff 출력이 바로 diff --git으로 시작)", () => {
    const text = "diff --git a/x b/x\n@@ -1 +1 @@\n-1\n+2";
    const sections = splitDiffSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].file).toBe("x");
  });
});

const SAMPLE = [
  "diff --git a/src/a.rs b/src/a.rs",
  "index 111..222 100644",
  "--- a/src/a.rs",
  "+++ b/src/a.rs",
  "@@ -1,2 +1,3 @@",
  " one",
  "+two",
  "--- looks like a header but is a deletion",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old/name.rs b/new/name.rs",
  "similarity index 90%",
  "rename from old/name.rs",
  "rename to new/name.rs",
  "--- a/old/name.rs",
  "+++ b/new/name.rs",
  "@@ -1 +1 @@",
  "-x",
  "+y",
].join("\n");

describe("splitDiffSections", () => {
  it("splits a multi-file diff into sections keyed by new path", () => {
    const sections = splitDiffSections(SAMPLE);
    expect(sections.map((s) => s.file)).toEqual([
      "src/a.rs",
      "new.txt",
      "gone.txt",
      "new/name.rs",
    ]);
  });

  it("keeps each section's full text including its header", () => {
    const sections = splitDiffSections(SAMPLE);
    expect(sections[0].text).toContain("diff --git a/src/a.rs b/src/a.rs");
    expect(sections[0].text).toContain("+two");
    // hunk 내용의 "--- " 삭제 라인이 경로를 덮어쓰지 않는다.
    expect(sections[0].file).toBe("src/a.rs");
    expect(sections[1].text).toContain("+hello");
    expect(sections[2].text).toContain("-bye");
  });

  it("uses the old path for deleted files", () => {
    const sections = splitDiffSections(SAMPLE);
    expect(sections[2].file).toBe("gone.txt");
  });

  it("keys binary and mode-only sections without +++/--- lines correctly", () => {
    const bin = [
      "diff --git a/assets b/logo.png b/assets b/logo.png",
      "index 111..222 100644",
      "Binary files a/assets b/logo.png and b/assets b/logo.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    // 경로에 " b/"가 들어가도 OLD == NEW 대칭으로 갈라낸다.
    expect(splitDiffSections(bin).map((s) => s.file)).toEqual(["assets b/logo.png", "run.sh"]);
  });

  it("keys pure renames (no content change) via the rename-to line", () => {
    const ren = [
      "diff --git a/old dir/x.rs b/new dir/y.rs",
      "similarity index 100%",
      "rename from old dir/x.rs",
      "rename to new dir/y.rs",
    ].join("\n");
    expect(splitDiffSections(ren)[0].file).toBe("new dir/y.rs");
  });

  it("handles quoted paths and empty input", () => {
    const quoted = [
      'diff --git "a/sp ace.txt" "b/sp ace.txt"',
      "--- \"a/sp ace.txt\"",
      "+++ \"b/sp ace.txt\"",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(splitDiffSections(quoted)[0].file).toBe("sp ace.txt");
    expect(splitDiffSections("")).toEqual([]);
  });

  it.each([
    ["report.ts ", "report.ts \t"],
    ["한글.ts\u00a0", "한글.ts\u00a0"],
    ["dir/ report.ts  ", "dir/ report.ts  \t"],
  ])("preserves whitespace in modified and deleted file paths: %j", (path, headerPath) => {
    for (const deleted of [false, true]) {
      const diff = [
        `diff --git a/${path} b/${path}`,
        `--- a/${headerPath}`,
        deleted ? "+++ /dev/null" : `+++ b/${headerPath}`,
        deleted ? "@@ -1 +0,0 @@" : "@@ -1 +1 @@",
        "-old",
        ...(deleted ? [] : ["+new"]),
        "",
      ].join("\n");
      expect(splitDiffSections(diff)).toEqual([{ file: path, text: diff, fromLine: 1 }]);
    }
  });
});
