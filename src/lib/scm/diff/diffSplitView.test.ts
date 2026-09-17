import { describe, expect, it } from "vitest";
import {
  hasSplitContent,
  parseHunkHeader,
  splitDiffRows,
  splitGutterWidth,
  splitWindow,
} from "@/lib/scm/diff/diffSplitView";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,5 +1,6 @@",
  " const a = 1;",
  "-const b = 2;",
  "-const c = 3;",
  "+const b = 20;",
  "+const c = 30;",
  "+const d = 40;",
  " const e = 5;",
].join("\n");

describe("parseHunkHeader", () => {
  it("좌우 시작 줄 번호를 읽는다", () => {
    expect(parseHunkHeader("@@ -12,7 +30,9 @@ fn main()")).toEqual({ oldStart: 12, newStart: 30 });
  });

  it("개수가 생략된 형태도 받는다", () => {
    expect(parseHunkHeader("@@ -1 +1 @@")).toEqual({ oldStart: 1, newStart: 1 });
  });

  it("combined diff(@@@)도 첫 두 범위를 읽는다", () => {
    expect(parseHunkHeader("@@@ -1,2 +3,4 @@@")).toEqual({ oldStart: 1, newStart: 3 });
  });

  it("hunk가 아니면 null", () => {
    expect(parseHunkHeader("const a = 1;")).toBeNull();
    expect(parseHunkHeader("@@ nope")).toBeNull();
  });
});

describe("splitDiffRows", () => {
  const rows = splitDiffRows(DIFF);
  const pairs = rows.filter((r) => r.kind === "pair");

  it("헤더 줄은 폭 전체를 쓰는 meta 행이 된다", () => {
    expect(rows[0]).toMatchObject({ kind: "meta", label: "diff --git a/src/a.ts b/src/a.ts" });
    expect(rows.some((r) => r.kind === "hunk" && r.label === "@@ -1,5 +1,6 @@")).toBe(true);
  });

  it("문맥 줄은 양쪽에 같은 내용으로 들어간다", () => {
    expect(pairs[0].left).toEqual({ lineNumber: 1, text: "const a = 1;", kind: "context" });
    expect(pairs[0].right).toEqual({ lineNumber: 1, text: "const a = 1;", kind: "context" });
  });

  it("삭제·추가 묶음을 위에서부터 맞물린다", () => {
    expect(pairs[1].left).toMatchObject({ text: "const b = 2;", kind: "del", lineNumber: 2 });
    expect(pairs[1].right).toMatchObject({ text: "const b = 20;", kind: "add", lineNumber: 2 });
    expect(pairs[2].left).toMatchObject({ text: "const c = 3;", kind: "del", lineNumber: 3 });
    expect(pairs[2].right).toMatchObject({ text: "const c = 30;", kind: "add", lineNumber: 3 });
  });

  it("추가가 더 많으면 왼쪽이 채움 행이 된다", () => {
    expect(pairs[3].left).toEqual({ lineNumber: null, text: "", kind: "empty" });
    expect(pairs[3].right).toMatchObject({ text: "const d = 40;", kind: "add", lineNumber: 4 });
  });

  it("좌우 행 수가 항상 같다 — 두 열이 같은 높이로 정렬되는 근거", () => {
    // pair 행은 정의상 좌우 한 칸씩이므로, 행 수가 곧 양쪽 높이다.
    expect(pairs.every((r) => r.left !== undefined && r.right !== undefined)).toBe(true);
  });

  it("채움 행 뒤에도 줄 번호가 어긋나지 않는다", () => {
    const last = pairs[pairs.length - 1];
    expect(last.left).toMatchObject({ text: "const e = 5;", lineNumber: 4 });
    // 왼쪽은 1 문맥 + 2 삭제 뒤라 4, 오른쪽은 1 문맥 + 3 추가 뒤라 5다.
    expect(last.right).toMatchObject({ text: "const e = 5;", lineNumber: 5 });
  });

  it("삭제만 있는 hunk는 오른쪽이 전부 채움 행", () => {
    const only = splitDiffRows(["@@ -1,2 +1,0 @@", "-a", "-b"].join("\n"));
    const p = only.filter((r) => r.kind === "pair");
    expect(p).toHaveLength(2);
    expect(p.every((r) => r.right.kind === "empty")).toBe(true);
    expect(p.map((r) => r.left.lineNumber)).toEqual([1, 2]);
  });

  it("추가만 있는 hunk는 왼쪽이 전부 채움 행", () => {
    const only = splitDiffRows(["@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"));
    const p = only.filter((r) => r.kind === "pair");
    expect(p).toHaveLength(2);
    expect(p.every((r) => r.left.kind === "empty")).toBe(true);
    expect(p.map((r) => r.right.lineNumber)).toEqual([1, 2]);
  });

  it("여러 hunk를 지나도 각 hunk 헤더의 번호에서 다시 센다", () => {
    const multi = splitDiffRows(
      ["@@ -1,1 +1,1 @@", " a", "@@ -50,1 +80,1 @@", " b"].join("\n"),
    );
    const p = multi.filter((r) => r.kind === "pair");
    expect(p[0].left.lineNumber).toBe(1);
    expect(p[1].left.lineNumber).toBe(50);
    expect(p[1].right.lineNumber).toBe(80);
  });

  it("'\\ No newline' 안내는 행으로 만들지 않는다 — 앞 줄에 붙는 주석이다", () => {
    const rowsNn = splitDiffRows(["@@ -1,1 +1,1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n"));
    expect(rowsNn.some((r) => r.label?.startsWith("\\ No newline"))).toBe(false);
    expect(rowsNn.filter((r) => r.kind === "pair")).toHaveLength(1);
  });

  it("본문의 '--- ' 삭제 줄을 헤더로 오해하지 않는다", () => {
    const sql = splitDiffRows(["@@ -1,1 +1,1 @@", "--- SQL 주석", "+-- 새 주석"].join("\n"));
    const p = sql.filter((r) => r.kind === "pair");
    expect(p[0].left).toMatchObject({ text: "-- SQL 주석", kind: "del" });
    expect(p[0].right).toMatchObject({ text: "-- 새 주석", kind: "add" });
  });

  it("빈 diff는 빈 목록", () => {
    expect(splitDiffRows("")).toEqual([]);
  });
});

describe("splitGutterWidth", () => {
  it("가장 큰 줄 번호의 자릿수를 쓴다", () => {
    const rows = splitDiffRows(["@@ -998,3 +998,3 @@", " a", " b", " c"].join("\n"));
    expect(splitGutterWidth(rows)).toBe(4);
  });

  it("번호가 없어도 최소 2칸은 잡는다", () => {
    expect(splitGutterWidth([])).toBe(2);
  });
});

describe("hasSplitContent", () => {
  it("본문 행이 있으면 true", () => {
    expect(hasSplitContent(splitDiffRows(DIFF))).toBe(true);
  });

  it("바이너리처럼 헤더만 있는 섹션은 false", () => {
    const bin = splitDiffRows(
      ["diff --git a/x.png b/x.png", "Binary files a/x.png and b/x.png differ"].join("\n"),
    );
    expect(hasSplitContent(bin)).toBe(false);
  });
});

describe("splitDiffRows — 리뷰 지적", () => {
  it("'\\ No newline'이 del/add 짝을 가르지 않는다", () => {
    const rows = splitDiffRows(
      ["@@ -1,2 +1,2 @@", " keep", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"].join("\n"),
    );
    const pairs = rows.filter((r) => r.kind === "pair");
    expect(pairs).toHaveLength(2);
    expect(pairs[1].left).toMatchObject({ text: "old", kind: "del" });
    expect(pairs[1].right).toMatchObject({ text: "new", kind: "add" });
    // 사이에 전폭 배너가 끼지 않는다.
    expect(rows.some((r) => r.kind === "meta" && r.label?.startsWith("\\"))).toBe(false);
  });

  it("git 출력의 끝 개행이 가짜 빈 행을 만들지 않는다", () => {
    // splitDiffSections는 마지막 섹션에 끝 개행을 그대로 남긴다.
    const rows = splitDiffRows("@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
    const pairs = rows.filter((r) => r.kind === "pair");
    expect(pairs).toHaveLength(2);
    expect(pairs.every((r) => r.left.text !== "" || r.left.kind === "empty")).toBe(true);
  });

  it("hunk 밖의 빈 줄은 여전히 안내 행을 만들지 않는다", () => {
    expect(splitDiffRows("")).toEqual([]);
  });
});

describe("splitWindow", () => {
  const base = { rowCount: 1000, rowHeight: 20, scrollTop: 0, viewportHeight: 400, overscan: 5 };

  it("맨 위에서는 0부터 화면+여유만큼만 그린다", () => {
    const w = splitWindow(base);
    expect(w.start).toBe(0);
    expect(w.end).toBe(30); // ceil(400/20) + 5*2
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((1000 - 30) * 20);
  });

  it("스크롤하면 창이 따라 내려가고 위쪽은 스페이서가 된다", () => {
    const w = splitWindow({ ...base, scrollTop: 2000 }); // 100번째 행
    expect(w.start).toBe(95);
    expect(w.padTop).toBe(95 * 20);
    expect(w.end).toBeGreaterThan(w.start);
  });

  it("맨 아래에서는 끝을 넘지 않고 아래 스페이서가 0이다", () => {
    const w = splitWindow({ ...base, scrollTop: 1000 * 20 });
    expect(w.end).toBe(1000);
    expect(w.padBottom).toBe(0);
  });

  it("전체 높이는 항상 보존된다 — 스크롤바가 튀지 않게", () => {
    for (const scrollTop of [0, 500, 5000, 19_999, 99_999]) {
      const w = splitWindow({ ...base, scrollTop });
      expect(w.padTop + (w.end - w.start) * 20 + w.padBottom).toBe(1000 * 20);
    }
  });

  it("행이 없거나 높이가 0이면 아무것도 그리지 않는다", () => {
    expect(splitWindow({ ...base, rowCount: 0 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(splitWindow({ ...base, rowHeight: 0 }).end).toBe(0);
  });

  it("음수 스크롤도 범위 안으로 잘린다", () => {
    expect(splitWindow({ ...base, scrollTop: -500 }).start).toBe(0);
  });
});
