import { describe, expect, it } from "vitest";
import { classifyDiffLine, statLabel, statTotals } from "@/lib/scm/diff/diffReview";

describe("classifyDiffLine", () => {
  it("classifies added/deleted/context lines", () => {
    expect(classifyDiffLine("+new line")).toBe("add");
    expect(classifyDiffLine("-old line")).toBe("del");
    expect(classifyDiffLine(" unchanged")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });

  it("classifies hunk headers and file headers", () => {
    expect(classifyDiffLine("@@ -1,3 +1,4 @@ fn main()")).toBe("hunk");
    expect(classifyDiffLine("+++ b/src/a.rs")).toBe("meta");
    expect(classifyDiffLine("--- a/src/a.rs")).toBe("meta");
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("index 1234567..89abcde 100644")).toBe("meta");
    expect(classifyDiffLine("new file mode 100644")).toBe("meta");
    expect(classifyDiffLine("Binary files a/logo.png and b/logo.png differ")).toBe("meta");
    expect(classifyDiffLine("rename from old.rs")).toBe("meta");
    expect(classifyDiffLine("\\ No newline at end of file")).toBe("meta");
  });

  it("treats +++/--- content lines as add/del, not headers", () => {
    // 헤더는 a/·b/·/dev/null 경로가 뒤따른다 — "-- SQL 주석" 삭제("--- …")나
    // "++ x" 추가("+++ …")를 meta로 죽이면 리뷰어가 변경을 놓친다.
    expect(classifyDiffLine("+++x")).toBe("add");
    expect(classifyDiffLine("---x")).toBe("del");
    expect(classifyDiffLine("--- drop old index")).toBe("del");
    expect(classifyDiffLine("+++ more pluses")).toBe("add");
    expect(classifyDiffLine("--- /dev/null")).toBe("meta");
    expect(classifyDiffLine('+++ "b/한글 경로.md"')).toBe("meta");
  });
});

describe("stat helpers", () => {
  it("formats per-file badges, marking binaries", () => {
    expect(statLabel({ added: 3, deleted: 1 })).toBe("+3 −1");
    expect(statLabel({ added: null, deleted: null })).toBe("BIN");
  });

  it("sums totals and counts binaries separately", () => {
    expect(
      statTotals([
        { added: 3, deleted: 1 },
        { added: 2, deleted: 0 },
        { added: null, deleted: null },
      ]),
    ).toEqual({ added: 5, deleted: 1, binary: 1 });
  });
});
