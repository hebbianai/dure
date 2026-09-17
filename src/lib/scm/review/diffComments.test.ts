import { describe, expect, it } from "vitest";
import {
  createDiffComment,
  formatDiffComment,
  formatDiffComments,
  markDeliveredMatching,
  unsentComments,
  updateDiffCommentBody,
} from "@/lib/scm/review/diffComments";

const base = (over: Partial<ReturnType<typeof createDiffComment>> = {}) => ({
  ...createDiffComment({
    agentId: "a1",
    filePath: "src/x.ts",
    line: 42,
    body: "add a null check",
    now: 1000,
  }),
  ...over,
});

describe("diffComments", () => {
  it("formats one comment deterministically and quote-safe", () => {
    const c = base({ lineText: "  const v = obj.value;" });
    expect(formatDiffComment(c)).toBe(
      'File: src/x.ts\nLine: 42\nContext: const v = obj.value;\nComment: "add a null check"',
    );
  });

  it("escapes quotes/backslashes/newlines in the body", () => {
    const c = base({ body: 'use "strict"\nand \\n escapes' });
    expect(formatDiffComment(c)).toContain(
      'Comment: "use \\"strict\\"\\nand \\\\n escapes"',
    );
  });

  it("labels file-scope comments (line 0)", () => {
    expect(formatDiffComment(base({ line: 0 }))).toContain("Scope: file");
  });

  it("orders the combined prompt by file then line", () => {
    const out = formatDiffComments([
      base({ filePath: "src/z.ts", line: 5, body: "z5" }),
      base({ filePath: "src/a.ts", line: 20, body: "a20" }),
      base({ filePath: "src/a.ts", line: 3, body: "a3" }),
    ]);
    expect(out.indexOf("a3")).toBeLessThan(out.indexOf("a20"));
    expect(out.indexOf("a20")).toBeLessThan(out.indexOf("z5"));
    expect(out).toContain("Please address these review comments");
  });

  it("empty comment set produces no prompt", () => {
    expect(formatDiffComments([])).toBe("");
  });

  it("editing the body clears the sent mark (edit-clears-sent)", () => {
    const sent = base({ sentAt: 2000 });
    const edited = updateDiffCommentBody(sent, "different text");
    expect(edited.sentAt).toBeUndefined();
    // 같은 본문이면 변화 없음(같은 참조)
    expect(updateDiffCommentBody(sent, sent.body)).toBe(sent);
  });

  it("marks only delivered comments whose body still matches the snapshot", () => {
    const c1 = base({ id: "c1", body: "original" });
    const c2 = base({ id: "c2", body: "note two" });
    // 전송 스냅샷을 찍은 뒤 c1이 바뀌었다면 c1은 미전송으로 남아야 한다.
    const snapshot = [
      { id: "c1", body: "original" },
      { id: "c2", body: "note two" },
    ];
    const changed = [{ ...c1, body: "edited mid-flight" }, c2];
    const result = markDeliveredMatching(changed, snapshot, 3000);
    expect(result.find((c) => c.id === "c1")?.sentAt).toBeUndefined();
    expect(result.find((c) => c.id === "c2")?.sentAt).toBe(3000);
    expect(unsentComments(result).map((c) => c.id)).toEqual(["c1"]);
  });
});
