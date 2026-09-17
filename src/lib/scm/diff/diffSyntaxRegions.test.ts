import { describe, expect, it } from "vitest";
import { diffPathsIn, diffFileRegions, regionPathAtLine } from "@/lib/scm/diff/diffSyntaxRegions";

const twoFiles = [
  "commit abc", // 1 — 경계 전 (커밋 메시지 등)
  "diff --git a/src/a.ts b/src/a.ts", // 2
  "@@ -1 +1 @@", // 3
  "+const x = 1;", // 4
  "diff --git a/b.rs b/b.rs", // 5
  "+fn main() {}", // 6
].join("\n");

describe("diffFileRegions", () => {
  it("uses the same resolved rename path as file selection and commit detail", () => {
    expect(diffFileRegions("diff --git a/old.ts b/assets b/new.rs\nsimilarity index 100%\nrename from old.ts\nrename to assets b/new.rs")).toEqual([
      { fromLine: 1, path: "assets b/new.rs" },
    ]);
  });
  it("diff --git 경계마다 구간을 만든다", () => {
    const regions = diffFileRegions(twoFiles);
    expect(regions).toEqual([
      { fromLine: 2, path: "src/a.ts" },
      { fromLine: 5, path: "b.rs" },
    ]);
  });

  it("라인이 속한 구간의 경로를 찾는다 (경계 전은 null)", () => {
    const regions = diffFileRegions(twoFiles);
    expect(regionPathAtLine(regions, 1)).toBeNull();
    expect(regionPathAtLine(regions, 4)).toBe("src/a.ts");
    expect(regionPathAtLine(regions, 6)).toBe("b.rs");
  });

  it("경계 없는 단일 diff 텍스트는 구간이 없다", () => {
    expect(diffFileRegions("@@ -1 +1 @@\n-a\n+b")).toEqual([]);
  });
});

describe("diffPathsIn", () => {
  it("구간의 경로를 중복 없이 모은다", () => {
    expect(
      diffPathsIn([
        { fromLine: 1, path: "a.ts" },
        { fromLine: 9, path: "b.rs" },
        { fromLine: 20, path: "a.ts" },
      ]),
    ).toEqual(["a.ts", "b.rs"]);
  });

  it("구간이 없으면 빈 목록이다", () => {
    expect(diffPathsIn([])).toEqual([]);
  });
});
