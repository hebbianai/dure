import { describe, expect, it } from "vitest";
import { frozenDesktopSkipsRendering } from "./frozenDesktopPresentation";

const settled = {
  frozen: true,
  active: false,
  mountSettled: true,
  constructionPending: false,
};

describe("frozenDesktopSkipsRendering", () => {
  it("정착했고 construction이 없는 frozen 비활성 데스크탑만 스킵한다", () => {
    expect(frozenDesktopSkipsRendering(settled)).toBe(true);
  });

  it("활성 데스크탑은 tier 상태가 늦어도 절대 스킵하지 않는다", () => {
    // 전환 커밋에서 tier 재조정(effect)이 한 프레임 늦는다 — active가
    // 항상 이겨야 방문 순간 빈 화면이 없다.
    expect(frozenDesktopSkipsRendering({ ...settled, active: true })).toBe(
      false,
    );
  });

  it("미완료 construction이 있으면 스킵하지 않는다 — 0-geometry 함정", () => {
    // 숨김 큐(3s 지연·400ms 간격)·레인 정지 때문에 소요가 유계가 아니라
    // 벽시계가 아닌 원장 pending으로 게이트한다. frozen 데스크탑에 pane이
    // 나중에 추가돼도 같은 조건이 강등을 풀었다가 완료 후 재개한다.
    expect(
      frozenDesktopSkipsRendering({ ...settled, constructionPending: true }),
    ).toBe(false);
  });

  it("마운트 직후(레이아웃 복원·ledger 등록 전)에는 스킵하지 않는다", () => {
    expect(
      frozenDesktopSkipsRendering({ ...settled, mountSettled: false }),
    ).toBe(false);
  });

  it("parks a settled warm desktop presentation while retaining its runtime", () => {
    expect(frozenDesktopSkipsRendering({ ...settled, frozen: false })).toBe(
      true,
    );
  });
});
