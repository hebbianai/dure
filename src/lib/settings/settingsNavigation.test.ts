import { describe, expect, it } from "vitest";
import {
  filterSettingsNavigation,
  type SettingsNavigationGroup,
} from "@/lib/settings/settingsNavigation";

const navigation: readonly SettingsNavigationGroup<string, string>[] = [
  {
    group: "AI",
    items: [
      { id: "accounts", icon: "user", label: "AI 제공업체 계정" },
      { id: "tools", icon: "server", label: "MCP·플러그인·스킬" },
    ],
  },
  {
    group: "앱",
    items: [{ id: "terminal", icon: "terminal", label: "터미널" }],
  },
];

describe("filterSettingsNavigation", () => {
  it("preserves the original groups for a blank query", () => {
    expect(filterSettingsNavigation(navigation, "  ")).toBe(navigation);
  });

  it("matches labels case-insensitively and removes empty groups", () => {
    expect(filterSettingsNavigation(navigation, " mcp ")).toEqual([
      {
        group: "AI",
        items: [
          { id: "tools", icon: "server", label: "MCP·플러그인·스킬" },
        ],
      },
    ]);
  });
});

describe("filterSettingsNavigation — 설정 항목까지 검색", () => {
  const groups = [
    {
      group: "인터페이스",
      items: [
        { id: "appearance", icon: null, label: "외관", keywords: ["글꼴군", "테마"] },
        { id: "shortcuts", icon: null, label: "단축키" },
      ],
    },
    {
      group: "앱",
      items: [{ id: "general", icon: null, label: "일반", keywords: ["미니맵", "자동 저장"] }],
    },
  ];

  it("페이지 안의 설정 이름으로 찾는다", () => {
    const out = filterSettingsNavigation(groups, "미니맵");
    expect(out).toHaveLength(1);
    expect(out[0].items.map((i) => i.id)).toEqual(["general"]);
  });

  it("그룹 이름으로도 찾는다 — 헤더에 보이는 낱말이 안 걸리면 고장으로 읽힌다", () => {
    const out = filterSettingsNavigation(groups, "인터페이스");
    expect(out).toHaveLength(1);
    expect(out[0].items.map((i) => i.id)).toEqual(["appearance", "shortcuts"]);
  });

  it("페이지 이름 검색은 그대로 동작한다", () => {
    expect(filterSettingsNavigation(groups, "단축키")[0].items.map((i) => i.id))
      .toEqual(["shortcuts"]);
  });

  it("대소문자를 가리지 않는다", () => {
    const withEnglish = [
      { group: "App", items: [{ id: "a", icon: null, label: "General", keywords: ["Minimap"] }] },
    ];
    expect(filterSettingsNavigation(withEnglish, "minimap")).toHaveLength(1);
  });

  it("어디에도 없으면 빈 목록", () => {
    expect(filterSettingsNavigation(groups, "존재하지않는설정")).toEqual([]);
  });

  it("색인어가 없는 항목도 안전하다", () => {
    expect(filterSettingsNavigation(groups, "글꼴")[0].items.map((i) => i.id)).toEqual(["appearance"]);
  });
});
