/**
 * Where the long-press card lands. The view can only ask this question with a
 * real layout, so the answer is pinned here instead.
 */

import { describe, expect, it } from "vitest";
import {
  MENU_GAP,
  MENU_INSET,
  MENU_WIDTH,
  placeRowMenu,
  type MenuViewport,
} from "./sessionRowMenuPlacement";

/** A 393×852 phone: 59pt of notch, 34pt of home indicator. */
const PHONE: MenuViewport = { width: 393, height: 852, safeTop: 59, safeBottom: 34 };
/** 그 폰에서 카드가 서 있을 수 있는 바닥. */
const FLOOR = PHONE.height - PHONE.safeBottom;

/** 스펙이 그린 그대로의 행: 아래가 y=213, 그룹 인셋 12에서 시작한다. */
const ROW = { top: 149, left: 12, width: 369, height: 64 };

describe("placeRowMenu", () => {
  it("기본은 잡은 행 바로 아래, 스펙의 8px 아래에 선다", () => {
    // Figma 3356:85374의 행 아래 213 + 8 = 3356:85387의 카드 위 221.
    expect(placeRowMenu(ROW, 200, PHONE)).toEqual({ top: 221, left: 12, above: false });
  });

  it("아래로 두면 안전 영역 밖으로 나갈 때 행 위로 뒤집는다", () => {
    const bottomRow = { ...ROW, top: 700 };
    // 700 + 64 + 8 = 772, 여기에 200을 더하면 바닥(818)을 넘는다.
    expect(placeRowMenu(bottomRow, 200, PHONE)).toEqual({ top: 492, left: 12, above: true });
  });

  /**
   * 행이 길어 위아래 어느 쪽에도 카드가 안 들어가는 경우. 화면 밖으로 반쯤
   * 나간 카드보다 행을 덮은 카드가 낫다.
   */
  it("양쪽 다 모자라면 넓은 쪽을 골라 안전 영역 안으로 밀어 넣는다", () => {
    const tall = { ...ROW, top: 200, height: 480 };
    // 위 133 vs 아래 130 — 위가 넓으니 위를 고르고, 넘치는 만큼 내려 물린다.
    const up = placeRowMenu(tall, 200, PHONE);
    expect(up.above).toBe(true);
    expect(up.top).toBeGreaterThanOrEqual(PHONE.safeTop);
    expect(up.top + 200).toBeLessThanOrEqual(FLOOR);

    // 같은 카드, 위 73 vs 아래 190 — 아래를 고르고 바닥에 맞춰 행을 덮는다.
    const down = placeRowMenu({ ...tall, top: 140 }, 200, PHONE);
    expect(down).toEqual({ top: FLOOR - 200, left: 12, above: false });

    // 위 133, 아래 133 — 어느 쪽도 넓지 않으면 스펙이 그린 아래로 간다.
    const tie = placeRowMenu({ ...tall, height: 477 }, 200, PHONE);
    expect(tie.above).toBe(false);
    expect(tie.top).toBe(FLOOR - 200);
  });

  it("left는 행의 왼쪽을 따르되 양옆 인셋 안으로 물린다", () => {
    expect(placeRowMenu({ ...ROW, left: 40 }, 200, PHONE).left).toBe(40);
    expect(placeRowMenu({ ...ROW, left: 0 }, 200, PHONE).left).toBe(MENU_INSET);
    // 카드는 스펙의 폭을 지키므로 오른쪽 한계는 행이 아니라 그 폭이 정한다.
    expect(placeRowMenu({ ...ROW, left: 300 }, 200, PHONE).left).toBe(
      PHONE.width - MENU_WIDTH - MENU_INSET,
    );
    // 카드보다 좁은 창(분할 화면)에서는 두 한계가 뒤집힌다. top과 같은 이유로
    // 여기서도 인셋이 이겨야 카드의 첫 항목이 화면 안에 남는다.
    expect(placeRowMenu(ROW, 200, { ...PHONE, width: 240 }).left).toBe(MENU_INSET);
  });

  /** 안전 영역보다 긴 카드는 두 한계가 뒤집히는데, 이길 쪽은 safeTop이다. */
  it("카드가 안전 영역보다 길어도 top이 safeTop 위로 올라가지 않는다", () => {
    expect(placeRowMenu({ ...ROW, top: 300 }, 900, PHONE).top).toBe(PHONE.safeTop);
  });

  /** 셋 다 스펙에서 읽은 값이고, 12는 프로젝트 그룹 자신의 인셋이다. */
  it("스펙의 간격·폭·인셋을 그대로 쓴다", () => {
    expect([MENU_GAP, MENU_WIDTH, MENU_INSET]).toEqual([8, 262, 12]);
  });
});
