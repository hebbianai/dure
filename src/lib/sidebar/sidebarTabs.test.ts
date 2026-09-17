import { describe, expect, it } from "vitest";
import { normalizeSidebarTab } from "@/lib/sidebar/sidebarTabs";

describe("normalizeSidebarTab", () => {
  it("keeps supported tabs", () => {
    expect(normalizeSidebarTab("files")).toBe("files");
    expect(normalizeSidebarTab("recovery")).toBe("recovery");
    expect(normalizeSidebarTab("github")).toBe("github");
    expect(normalizeSidebarTab("plugin")).toBe("plugin");
    expect(normalizeSidebarTab("automations")).toBe("automations");
  });

  it("moves removed overview, agents, and conversations tabs to spaces", () => {
    expect(normalizeSidebarTab("overview")).toBe("spaces");
    expect(normalizeSidebarTab("agents")).toBe("spaces");
    expect(normalizeSidebarTab("conversations")).toBe("spaces");
    expect(normalizeSidebarTab("interactions")).toBe("spaces");
  });

  // 시안 판을 띄워 두고 있던 사람이 업데이트 후 빈 사이드바에 갇히지 않아야
  // 한다 — 레일에서 탭이 사라졌으므로 되돌아갈 아이콘도 없다.
  it("moves the removed spacesRedesign tab to spaces", () => {
    expect(normalizeSidebarTab("spacesRedesign")).toBe("spaces");
  });

  it("uses spaces for missing or unknown persisted values", () => {
    expect(normalizeSidebarTab(undefined)).toBe("spaces");
    expect(normalizeSidebarTab("unknown")).toBe("spaces");
  });
});
