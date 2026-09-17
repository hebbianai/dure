import { describe, expect, it } from "vitest";
import {
  dropPinnedPanesForDesktop,
  isPanePinned,
  panePinKey,
  shouldConfirmPaneClose,
  togglePinnedPane,
  unpinPane,
} from "@/lib/workspace/pane/panePin";

describe("isPanePinned", () => {
  it("true인 항목만 고정으로 본다", () => {
    expect(isPanePinned({ a: true }, "a")).toBe(true);
    expect(isPanePinned({ a: false }, "a")).toBe(false);
    expect(isPanePinned({}, "a")).toBe(false);
  });
});

describe("togglePinnedPane", () => {
  it("고정하면 키가 생긴다", () => {
    expect(togglePinnedPane({}, "a")).toEqual({ a: true });
  });

  it("해제하면 false를 남기지 않고 키를 지운다", () => {
    expect(togglePinnedPane({ a: true, b: true }, "a")).toEqual({ b: true });
  });

  it("원본을 바꾸지 않는다", () => {
    const before = { a: true };
    togglePinnedPane(before, "b");
    expect(before).toEqual({ a: true });
  });
});

describe("shouldConfirmPaneClose", () => {
  it("설정이 켜져 있고 고정된 pane이면 묻는다", () => {
    expect(shouldConfirmPaneClose({ pinned: { a: true }, paneId: "a", confirmEnabled: true }))
      .toBe(true);
  });

  it("설정이 꺼져 있으면 고정돼 있어도 묻지 않는다", () => {
    expect(shouldConfirmPaneClose({ pinned: { a: true }, paneId: "a", confirmEnabled: false }))
      .toBe(false);
  });

  it("고정되지 않은 pane은 설정과 무관하게 묻지 않는다", () => {
    expect(shouldConfirmPaneClose({ pinned: {}, paneId: "a", confirmEnabled: true })).toBe(false);
  });
});

describe("unpinPane", () => {
  it("고정을 거둔다", () => {
    expect(unpinPane({ a: true, b: true }, "a")).toEqual({ b: true });
  });

  it("고정돼 있지 않았으면 원본 참조를 그대로 준다 — 불필요한 store 갱신 방지", () => {
    const before = { a: true };
    expect(unpinPane(before, "zzz")).toBe(before);
  });
});

describe("panePinKey (리뷰 지적: pane id가 데스크탑 간 충돌)", () => {
  it("데스크탑을 앞에 붙여 같은 pane id를 갈라놓는다", () => {
    // browser:main, git:<projectId> 등은 결정적 id라 여러 데스크탑에 동시 존재한다.
    expect(panePinKey("desk-a", "browser:main")).not.toBe(panePinKey("desk-b", "browser:main"));
  });

  it("데스크탑이 없으면 detached로 묶는다 (분리된 창)", () => {
    expect(panePinKey(undefined, "term:1")).toBe("detached:term:1");
  });

  it("A에서 고정해도 B는 고정되지 않는다", () => {
    const pinned = togglePinnedPane({}, panePinKey("desk-a", "browser:main"));
    expect(isPanePinned(pinned, panePinKey("desk-a", "browser:main"))).toBe(true);
    expect(isPanePinned(pinned, panePinKey("desk-b", "browser:main"))).toBe(false);
  });
});

describe("dropPinnedPanesForDesktop", () => {
  const pinned = {
    "desk-a:browser:main": true,
    "desk-a:term:1": true,
    "desk-b:browser:main": true,
  };

  it("그 데스크탑 몫만 버린다", () => {
    expect(dropPinnedPanesForDesktop(pinned, "desk-a")).toEqual({ "desk-b:browser:main": true });
  });

  it("접두가 겹치는 다른 데스크탑을 잘못 지우지 않는다", () => {
    const mixed = { "desk-a:x": true, "desk-ab:x": true };
    expect(dropPinnedPanesForDesktop(mixed, "desk-a")).toEqual({ "desk-ab:x": true });
  });
});
