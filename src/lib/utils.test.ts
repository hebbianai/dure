import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("커스텀 글자 크기가 색 클래스에 밀려 사라지지 않는다", () => {
    // tailwind-merge는 모르는 `text-*` 이름을 색으로 넘긴다. 그래서 등록해
    // 두지 않으면 아래 조합에서 크기가 조용히 지워지고, 요소는 부모 크기를
    // 물려받는다 (데스크탑 그룹 이름이 11px 대신 16px로 나왔던 실제 버그).
    const merged = cn("text-meta font-semibold", "text-muted-foreground");
    expect(merged).toContain("text-meta");
    expect(merged).toContain("text-muted-foreground");
  });

  it("같은 무리끼리는 여전히 뒤에 온 것이 이긴다", () => {
    // 등록이 충돌 해소 자체를 깨뜨리면 안 된다.
    expect(cn("text-meta", "text-xs")).toBe("text-xs");
    expect(cn("text-xs", "text-meta")).toBe("text-meta");
    expect(cn("text-muted-foreground", "text-destructive")).toBe("text-destructive");
  });

  it("기본 동작은 그대로다", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("flex", false && "hidden", "items-center")).toBe("flex items-center");
  });
});
