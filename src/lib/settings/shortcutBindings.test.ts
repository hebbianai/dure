import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chordFromEvent,
  isBindableChord,
  isShortcutCaptureActive,
  setShortcutCaptureActive,
  chordFromLabels,
  chordToLabels,
  conflictingShortcutIds,
  filterShortcuts,
  isRebindable,
  matchesChord,
  resolveShortcuts,
  shortcutChord,
  shortcutStatusCounts,
  type KeyChord,
} from "@/lib/settings/shortcutBindings";
import type { Shortcut } from "@/lib/settings/settingsShortcuts";

const mocks = vi.hoisted(() => ({
  buildDisplayCatalog: vi.fn(),
  translate: vi.fn((messageId: string) => messageId),
}));

vi.mock("@/lib/i18n", () => ({ t: mocks.translate }));
vi.mock("@/lib/settings/settingsShortcuts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/settings/settingsShortcuts")>();
  return {
    ...actual,
    allShortcuts: () => {
      mocks.buildDisplayCatalog();
      return actual.allShortcuts();
    },
  };
});

const chord = (over: Partial<KeyChord> = {}): KeyChord => ({
  mod: false,
  shift: false,
  alt: false,
  key: "a",
  ...over,
});

const event = (over: Partial<Parameters<typeof chordFromEvent>[0]> = {}) => ({
  key: "a",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

const CATALOG: Shortcut[] = [
  { id: "search", command: "통합 검색", keys: [["⌘", "P"]], source: "app" },
  { id: "close", command: "활성 pane 닫기", keys: [["⌘", "W"]], source: "app" },
  { id: "range", command: "데스크탑 전환", keys: [["⌘", "1"], ["…"], ["⌘", "9"]], source: "app" },
  { id: "term-copy", command: "선택 복사", keys: [["⌘", "C"]], source: "terminal" },
];

describe("chordFromLabels", () => {
  it("수정 키와 주 키를 갈라낸다", () => {
    expect(chordFromLabels(["⌘", "⇧", "T"])).toEqual(chord({ mod: true, shift: true, key: "t" }));
  });

  it("기호 키캡을 이벤트 key 이름으로 옮긴다", () => {
    expect(chordFromLabels(["⌘", "⌫"])?.key).toBe("backspace");
    expect(chordFromLabels(["⌘", "←"])?.key).toBe("arrowleft");
    expect(chordFromLabels(["⌥", "⌫"])).toEqual(chord({ alt: true, key: "backspace" }));
  });

  it("범위 표기(…)는 단일 조합이 아니라 null", () => {
    expect(chordFromLabels(["…"])).toBeNull();
  });

  it("주 키가 없으면 null", () => {
    expect(chordFromLabels(["⌘"])).toBeNull();
  });
});

describe("chordToLabels", () => {
  it("⌘ ⇧ ⌥ 순서로 키캡을 만든다", () => {
    expect(chordToLabels(chord({ mod: true, shift: true, alt: true, key: "t" })))
      .toEqual(["⌘", "⇧", "⌥", "T"]);
  });

  it("기호 키는 기호로 되돌린다", () => {
    expect(chordToLabels(chord({ mod: true, key: "backspace" }))).toEqual(["⌘", "⌫"]);
  });

  it("라벨→조합→라벨 왕복이 안정적이다", () => {
    for (const labels of [["⌘", "P"], ["⌘", "⇧", "T"], ["⌥", "⌫"], ["⌘", "←"]]) {
      expect(chordToLabels(chordFromLabels(labels) as KeyChord)).toEqual(labels);
    }
  });
});

describe("chordFromEvent", () => {
  it("Ctrl도 ⌘와 같은 자리로 받는다 — 플랫폼 차이를 여기서 흡수", () => {
    expect(chordFromEvent(event({ ctrlKey: true, key: "p" })))
      .toEqual(chord({ mod: true, key: "p" }));
  });

  it("shift가 걸려 대문자로 와도 소문자로 정규화한다", () => {
    expect(chordFromEvent(event({ metaKey: true, shiftKey: true, key: "T" })))
      .toEqual(chord({ mod: true, shift: true, key: "t" }));
  });

  it("수정 키 자체를 누른 순간은 조합이 아니다", () => {
    for (const key of ["Meta", "Control", "Shift", "Alt"]) {
      expect(chordFromEvent(event({ key }))).toBeNull();
    }
  });
});

describe("matchesChord", () => {
  const target = chordFromLabels(["⌘", "W"]);

  it("같은 조합이면 잡는다", () => {
    expect(matchesChord(target, event({ metaKey: true, key: "w" }))).toBe(true);
    expect(matchesChord(target, event({ metaKey: true, key: "W" }))).toBe(true);
  });

  it("수정 키가 하나라도 다르면 잡지 않는다", () => {
    expect(matchesChord(target, event({ metaKey: true, shiftKey: true, key: "w" }))).toBe(false);
    expect(matchesChord(target, event({ metaKey: true, altKey: true, key: "w" }))).toBe(false);
    expect(matchesChord(target, event({ key: "w" }))).toBe(false);
  });

  it("할당 없음(null)은 어떤 키에도 반응하지 않는다", () => {
    expect(matchesChord(null, event({ metaKey: true, key: "w" }))).toBe(false);
  });

  it("US 배열의 ⇧/는 event.key가 '?'로 오지만 ⌘⇧/ 조합으로 잡는다 (리뷰 지적: 별칭 누락으로 feedback.command가 발동하지 않았다)", () => {
    const feedbackTarget = chordFromLabels(["⌘", "⇧", "/"]);
    expect(
      matchesChord(
        feedbackTarget,
        event({ metaKey: true, shiftKey: true, key: "?" }),
      ),
    ).toBe(true);
  });

  it("맨 ⌘/는 ⌘⇧/ 조합과 계속 구분된다 — '?' 별칭이 shift 감도를 없애지 않는다", () => {
    const feedbackTarget = chordFromLabels(["⌘", "⇧", "/"]);
    expect(matchesChord(feedbackTarget, event({ metaKey: true, key: "/" })))
      .toBe(false);
  });
});

describe("isBindableChord (리뷰 지적: 맨 키 바인딩이 타이핑을 가로챔)", () => {
  it("⌘·⌥ 중 하나는 있어야 한다", () => {
    expect(isBindableChord(chord({ mod: true, key: "w" }))).toBe(true);
    expect(isBindableChord(chord({ alt: true, key: "w" }))).toBe(true);
  });

  it("Space·Enter 같은 맨 키는 거부한다 — 키캡 클릭 직후 흔한 사고", () => {
    expect(isBindableChord(chord({ key: " " }))).toBe(false);
    expect(isBindableChord(chord({ key: "enter" }))).toBe(false);
    expect(isBindableChord(chord({ key: "a" }))).toBe(false);
  });

  it("shift만으로는 부족하다", () => {
    expect(isBindableChord(chord({ shift: true, key: "a" }))).toBe(false);
  });

  it("null은 거부", () => {
    expect(isBindableChord(null)).toBe(false);
  });
});

describe("캡처 잠금 (리뷰 지적: ⌘W 지정하려다 pane이 닫힘)", () => {
  afterEach(() => setShortcutCaptureActive(false));

  it("캡처 중에는 어떤 조합도 매치되지 않는다", () => {
    const target = chordFromLabels(["⌘", "W"]);
    expect(matchesChord(target, event({ metaKey: true, key: "w" }))).toBe(true);
    setShortcutCaptureActive(true);
    expect(isShortcutCaptureActive()).toBe(true);
    expect(matchesChord(target, event({ metaKey: true, key: "w" }))).toBe(false);
  });

  it("캡처가 끝나면 다시 매치된다", () => {
    const target = chordFromLabels(["⌘", "W"]);
    setShortcutCaptureActive(true);
    setShortcutCaptureActive(false);
    expect(matchesChord(target, event({ metaKey: true, key: "w" }))).toBe(true);
  });
});

describe("resolveShortcuts", () => {
  it("재지정이 없으면 카탈로그 기본값 그대로다", () => {
    const resolved = resolveShortcuts({}, CATALOG);
    expect(resolved.every((s) => !s.modified)).toBe(true);
    expect(resolved.every((s) => !s.unassigned)).toBe(true);
    expect(resolved.find((s) => s.id === "search")?.keys).toEqual([["⌘", "P"]]);
  });

  it("재지정하면 modified가 되고 키캡이 새 조합으로 바뀐다", () => {
    const resolved = resolveShortcuts({ search: chord({ mod: true, key: "k" }) }, CATALOG);
    const search = resolved.find((s) => s.id === "search");
    expect(search?.modified).toBe(true);
    expect(search?.keys).toEqual([["⌘", "K"]]);
  });

  it("기본값과 같은 값으로 재지정하면 modified가 아니다", () => {
    const resolved = resolveShortcuts({ search: chord({ mod: true, key: "p" }) }, CATALOG);
    expect(resolved.find((s) => s.id === "search")?.modified).toBe(false);
  });

  it("null 재지정은 할당 없음이 되고 키캡이 사라진다", () => {
    const resolved = resolveShortcuts({ close: null }, CATALOG);
    const close = resolved.find((s) => s.id === "close");
    expect(close?.unassigned).toBe(true);
    expect(close?.modified).toBe(true);
    expect(close?.keys).toEqual([]);
  });

  it("할당을 해제해도 rebindable은 유지된다 — 되돌릴 버튼이 사라지면 안 된다", () => {
    // 리뷰 지적: UI가 isRebindable(resolved)를 보면 keys가 비어 false가 되어
    // 키캡·해제·기본값 버튼이 전부 사라지고 영구 dead-end가 됐다.
    const resolved = resolveShortcuts({ close: null }, CATALOG);
    expect(resolved.find((s) => s.id === "close")?.rebindable).toBe(true);
  });

  it("범위 표기 항목은 rebindable이 false다", () => {
    expect(resolveShortcuts({}, CATALOG).find((s) => s.id === "range")?.rebindable).toBe(false);
  });

  it("범위 표기 항목은 재지정을 무시하고 기본 표시를 지킨다", () => {
    const resolved = resolveShortcuts({ range: chord({ mod: true, key: "z" }) }, CATALOG);
    const range = resolved.find((s) => s.id === "range");
    expect(range?.modified).toBe(false);
    expect(range?.keys).toEqual([["⌘", "1"], ["…"], ["⌘", "9"]]);
  });
});

describe("isRebindable", () => {
  it("단일 조합만 재지정할 수 있다", () => {
    expect(isRebindable(CATALOG[0])).toBe(true);
    expect(isRebindable(CATALOG[2])).toBe(false);
  });
});

describe("shortcutChord", () => {
  it("does not rebuild localized Settings copy for the default hot-path lookup", () => {
    mocks.buildDisplayCatalog.mockClear();
    mocks.translate.mockClear();
    expect(shortcutChord("close-pane", {})).toEqual(chord({ mod: true, key: "w" }));
    expect(
      shortcutChord("close-pane", {
        "close-pane": chord({ mod: true, shift: true, key: "w" }),
      }),
    ).toEqual(chord({ mod: true, shift: true, key: "w" }));
    expect(shortcutChord("close-pane", { "close-pane": null })).toBeNull();
    expect(shortcutChord("unknown", { unknown: chord({ mod: true, key: "u" }) })).toBeNull();
    expect(
      shortcutChord("switch-desktop", {
        "switch-desktop": chord({ mod: true, key: "z" }),
      }),
    ).toBeNull();
    expect(mocks.buildDisplayCatalog).not.toHaveBeenCalled();
    expect(mocks.translate).not.toHaveBeenCalled();
  });

  it("전역 핸들러가 쓰는 조회 — 재지정이 반영된다", () => {
    expect(shortcutChord("close", {}, CATALOG)).toEqual(chord({ mod: true, key: "w" }));
    expect(shortcutChord("close", { close: chord({ mod: true, key: "q" }) }, CATALOG))
      .toEqual(chord({ mod: true, key: "q" }));
    expect(shortcutChord("close", { close: null }, CATALOG)).toBeNull();
  });

  it("모르는 id는 null", () => {
    expect(shortcutChord("nope", {}, CATALOG)).toBeNull();
  });

  it("주입된 카탈로그에 빠진 정본 id로 폴백하지 않는다", () => {
    expect(shortcutChord("close-pane", {}, CATALOG)).toBeNull();
  });
});

describe("conflictingShortcutIds", () => {
  it("기본 카탈로그에는 충돌이 없다", () => {
    expect(conflictingShortcutIds(resolveShortcuts({}, CATALOG)).size).toBe(0);
  });

  it("같은 조합을 나눠 가지면 둘 다 충돌로 잡힌다", () => {
    const resolved = resolveShortcuts({ close: chord({ mod: true, key: "p" }) }, CATALOG);
    expect([...conflictingShortcutIds(resolved)].sort()).toEqual(["close", "search"]);
  });

  it("앱과 터미널이 같은 키를 써도 충돌이 아니다 — 우선순위 설정이 가르는 몫", () => {
    const resolved = resolveShortcuts({ search: chord({ mod: true, key: "c" }) }, CATALOG);
    expect(conflictingShortcutIds(resolved).size).toBe(0);
  });

  it("할당 없음끼리는 충돌하지 않는다", () => {
    const resolved = resolveShortcuts({ search: null, close: null }, CATALOG);
    expect(conflictingShortcutIds(resolved).size).toBe(0);
  });
});

describe("shortcutStatusCounts", () => {
  it("기본 상태의 개수", () => {
    expect(shortcutStatusCounts(resolveShortcuts({}, CATALOG)))
      .toEqual({ all: 4, modified: 0, unassigned: 0, conflicts: 0 });
  });

  it("재지정·비움·충돌을 각각 센다", () => {
    const resolved = resolveShortcuts(
      { close: chord({ mod: true, key: "p" }), "term-copy": null },
      CATALOG,
    );
    expect(shortcutStatusCounts(resolved))
      .toEqual({ all: 4, modified: 2, unassigned: 1, conflicts: 2 });
  });
});

describe("filterShortcuts", () => {
  const resolved = resolveShortcuts(
    { close: chord({ mod: true, key: "p" }), "term-copy": null },
    CATALOG,
  );

  it("all은 전부 통과", () => {
    expect(filterShortcuts(resolved, "all", "")).toHaveLength(4);
  });

  it("modified / unassigned / conflicts가 각각 걸러낸다", () => {
    expect(filterShortcuts(resolved, "modified", "").map((s) => s.id).sort())
      .toEqual(["close", "term-copy"]);
    expect(filterShortcuts(resolved, "unassigned", "").map((s) => s.id)).toEqual(["term-copy"]);
    expect(filterShortcuts(resolved, "conflicts", "").map((s) => s.id).sort())
      .toEqual(["close", "search"]);
  });

  it("검색어는 명령 이름과 키 표기 양쪽을 본다", () => {
    expect(filterShortcuts(resolved, "all", "검색").map((s) => s.id)).toEqual(["search"]);
    expect(filterShortcuts(resolved, "all", "⌘").length).toBeGreaterThan(0);
  });

  it("번역된 이름으로도 찾을 수 있다", () => {
    const translate = (command: string) => (command === "통합 검색" ? "Unified search" : command);
    expect(filterShortcuts(resolved, "all", "unified", translate).map((s) => s.id))
      .toEqual(["search"]);
  });

  it("상태 필터와 검색어는 함께 적용된다", () => {
    expect(filterShortcuts(resolved, "conflicts", "검색").map((s) => s.id)).toEqual(["search"]);
  });
});
