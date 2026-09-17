import { describe, expect, it } from "vitest";
import { reuseStableRows } from "@/lib/ui/stableRows";

describe("reuseStableRows", () => {
  const rows = [
    { key: "a", title: "1" },
    { key: "b", title: "2" },
  ];

  it("내용이 전부 같으면 이전 배열 참조를 그대로 돌려준다", () => {
    const next = rows.map((row) => ({ ...row }));
    expect(reuseStableRows(rows, next)).toBe(rows);
  });

  it("일부만 바뀌면 안 바뀐 행의 참조를 재사용한다", () => {
    const next = [{ ...rows[0] }, { key: "b", title: "changed" }];
    const merged = reuseStableRows(rows, next);
    expect(merged).not.toBe(rows);
    expect(merged[0]).toBe(rows[0]);
    expect(merged[1]).toBe(next[1]);
  });

  it("길이가 바뀌면 새 배열 (겹치는 같은 행은 재사용)", () => {
    const next = [{ ...rows[0] }];
    const merged = reuseStableRows(rows, next);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(rows[0]);
  });

  it("이전이 없으면 next 그대로", () => {
    expect(reuseStableRows(undefined, rows)).toBe(rows);
  });

  it("키 집합이 다르면 다른 행으로 본다", () => {
    const next = [{ key: "a", title: "1", extra: true }, { ...rows[1] }];
    const merged = reuseStableRows(rows, next as never);
    expect(merged[0]).toBe(next[0]);
  });
});
