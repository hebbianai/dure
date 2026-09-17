/**
 * 세션 행 길게 누르기. Figma 3356:85254.
 *
 * jsdom은 레이아웃을 하지 않으므로 `getBoundingClientRect`는 늘 0을 돌려준다 —
 * 여기서 확인하는 것은 좌표가 아니라 상태 기계다. 행이 어떤 사각형을 건네받는지는
 * 노드의 `getBoundingClientRect`를 가로채서 본다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_CANCEL_PX, HOLD_DELAY_MS, type PressHold, bindPressHold } from "./pressHold";

/** 행이 놓여 있는 자리. 값 자체는 아무래도 좋고, 그대로 전달되는지만 본다. */
const ROW_RECT = new DOMRect(8, 120, 320, 64);

const POINTER_ID = 7;

describe("press hold", () => {
  let node: HTMLElement;
  let label: HTMLElement;
  let held: DOMRect[];
  /** 행을 여는 평범한 탭이 몇 번 통과했는지. */
  let opened: number;
  let captured: number[];
  let clock: number;
  let bindings: PressHold[];

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    held = [];
    opened = 0;
    captured = [];
    bindings = [];
    node = document.createElement("div");
    node.getBoundingClientRect = () => ROW_RECT;
    // jsdom에는 포인터 캡처가 없다. 뷰가 optional 호출로 부르는 그 자리를 대신 본다.
    node.setPointerCapture = (pointerId: number) => captured.push(pointerId);
    label = document.createElement("span");
    label.textContent = "Session";
    node.append(label);
    // 행이 스스로 다는 "세션 열기". 버블 단계 — 길게 누른 뒤의 click은 여기까지
    // 오면 안 된다.
    node.addEventListener("click", () => {
      opened += 1;
    });
    document.body.append(node);
  });

  afterEach(() => {
    for (const binding of bindings) binding.dispose();
    node.remove();
    vi.useRealTimers();
  });

  const bind = (): PressHold => {
    const binding = bindPressHold(node, {
      hold: (rect) => held.push(rect),
      now: () => clock,
    });
    bindings.push(binding);
    return binding;
  };

  const at = (type: string, x = 0, y = 0): void => {
    node.dispatchEvent(
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        pointerId: POINTER_ID,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  /** 실제 기기에서는 시계와 타이머가 함께 흐른다. */
  const wait = (ms: number): void => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  /** 행을 눌렀다 뗀 뒤 브라우저가 보내는 click. 삼켜졌는지 함께 돌려준다. */
  const tapClick = (): boolean => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    label.dispatchEvent(click);
    return click.defaultPrevented;
  };

  it("누른 채로 기다리면 행의 사각형과 함께 딱 한 번 열린다", () => {
    bind();
    at("pointerdown");

    wait(HOLD_DELAY_MS);
    expect(held).toHaveLength(1);
    // 행이 스스로 잰 사각형이 그대로 건너간다 — 메뉴는 그 자리에 붙는다.
    expect(held[0]).toBe(ROW_RECT);

    // 더 기다려도, 손을 떼어도 두 번째 메뉴는 없다.
    wait(HOLD_DELAY_MS * 4);
    at("pointerup");
    expect(held).toHaveLength(1);
  });

  /**
   * 메뉴가 열리는 것 자체가 이 행 위의 포인터 이벤트다. hold()가 돌아온 뒤에
   * 뒷정리를 하면 그렇게 시작된 다음 누름이 정리에 쓸려 나간다.
   */
  it("메뉴를 여느라 시작된 다음 누름을 잡아먹지 않는다", () => {
    let reopened = false;
    bindings.push(
      bindPressHold(node, {
        hold: (rect) => {
          held.push(rect);
          if (reopened) return;
          reopened = true;
          at("pointerdown");
        },
        now: () => clock,
      }),
    );

    at("pointerdown");
    wait(HOLD_DELAY_MS);
    expect(held).toHaveLength(1);

    wait(HOLD_DELAY_MS);
    expect(held).toHaveLength(2);
  });

  it("HOLD_DELAY_MS가 차기 전에는 열리지 않는다", () => {
    bind();
    at("pointerdown");

    wait(HOLD_DELAY_MS - 1);
    expect(held).toEqual([]);
    wait(1);
    expect(held).toHaveLength(1);
  });

  /** 타이머는 깨우기만 한다. 눌린 지 얼마나 됐는지는 시계가 답한다. */
  it("타이머만 흘러서는 열리지 않는다", () => {
    bind();
    at("pointerdown");

    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(held).toEqual([]);

    wait(HOLD_DELAY_MS);
    expect(held).toHaveLength(1);
  });

  /**
   * 위 테스트는 시계가 조금도 흐르지 않은 경우만 본다. 진짜로 지키는 것은 문턱이다 —
   * 타이머가 일찍 깨도 시계가 HOLD_DELAY_MS를 채우기 전에는 열리지 않고, 모자란
   * 만큼 다시 눕는다.
   */
  it("타이머가 일찍 깨면 모자란 만큼 다시 기다린다", () => {
    bind();
    at("pointerdown");

    // 타이머는 다 흘렀는데 시계는 1ms 모자라다.
    clock += HOLD_DELAY_MS - 1;
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(held).toEqual([]);

    // 그 1ms가 채워지는 순간 열린다.
    wait(1);
    expect(held).toHaveLength(1);
  });

  /** now()는 주입점일 뿐이다. 주지 않은 뷰는 진짜 시계로 익어야 한다. */
  it("now()를 주지 않으면 기본 시계로 익는다", () => {
    bindings.push(bindPressHold(node, { hold: (rect) => held.push(rect) }));

    at("pointerdown");
    // 이 바인딩은 clock을 보지 않는다. 가짜 타이머가 Date.now도 함께 끌고 간다.
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(held).toHaveLength(1);
  });

  it("포인터를 잡아 둔다 — 목록이 손가락 밑에서 스크롤돼도 누름은 이어진다", () => {
    bind();
    at("pointerdown");

    expect(captured).toEqual([POINTER_ID]);
  });

  it("HOLD_CANCEL_PX 안에서 흔들리는 것은 여전히 누르고 있는 것이다", () => {
    bind();
    at("pointerdown");
    at("pointermove", HOLD_CANCEL_PX, 0);

    wait(HOLD_DELAY_MS);
    expect(held).toHaveLength(1);
  });

  it("HOLD_CANCEL_PX보다 멀리 가면 취소된다", () => {
    bind();
    at("pointerdown");
    at("pointermove", HOLD_CANCEL_PX + 1, 0);

    wait(HOLD_DELAY_MS);
    expect(held).toEqual([]);
  });

  /** 축마다 6px씩이면 실제로는 8px을 간 것 — 그건 목록을 스크롤하는 손가락이다. */
  it("비스듬히 새어 나간 거리도 거리로 친다", () => {
    bind();
    at("pointerdown");
    at("pointermove", 5, 5);

    wait(HOLD_DELAY_MS);
    expect(held).toEqual([]);
  });

  /**
   * 마우스가 달린 화면에서는 누르지 않은 채로도 pointermove가 계속 온다. 시작점이
   * 없는 이동은 조용히 흘러가야 한다. 리스너가 던지면 브라우저는 window의 error로만
   * 알리므로 — 던지는 채로도 이 파일의 다른 테스트는 전부 초록이다 — 여기서는 그
   * error를 직접 받아 본다.
   */
  it("누름 밖의 pointermove는 조용히 흘러간다", () => {
    const thrown: string[] = [];
    const onError = (event: ErrorEvent): void => {
      thrown.push(event.message);
      // 막지 않으면 vitest가 콘솔에만 찍고 테스트는 그대로 통과한다.
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      bind();
      // 손가락이 닿기 전.
      at("pointermove", 40, 40);
      at("pointerdown");
      wait(HOLD_DELAY_MS);
      at("pointerup");
      // 뗀 뒤에도 포인터는 계속 움직인다.
      at("pointermove", 80, 80);
    } finally {
      window.removeEventListener("error", onError);
    }

    expect(thrown).toEqual([]);
    expect(held).toHaveLength(1);
  });

  it("타이머가 차기 전에 손을 떼면 아무 일도 없다", () => {
    bind();
    at("pointerdown");
    wait(HOLD_DELAY_MS - 1);
    at("pointerup");

    wait(HOLD_DELAY_MS);
    expect(held).toEqual([]);
  });

  it("제스처가 취소되면 아무 일도 없다", () => {
    bind();
    at("pointerdown");
    wait(HOLD_DELAY_MS - 1);
    at("pointercancel");

    wait(HOLD_DELAY_MS);
    expect(held).toEqual([]);
  });

  it("메뉴를 연 누름 뒤의 click은 행까지 가지 않는다", () => {
    bind();
    at("pointerdown");
    wait(HOLD_DELAY_MS);
    at("pointerup");

    expect(tapClick()).toBe(true);
    expect(opened).toBe(0);
  });

  it("그냥 탭한 click은 행을 연다", () => {
    bind();
    at("pointerdown");
    at("pointerup");

    expect(tapClick()).toBe(false);
    expect(opened).toBe(1);
  });

  it("브라우저의 길게 누르기 메뉴를 막아 앱 메뉴와 겹치지 않게 한다", () => {
    bind();
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    label.dispatchEvent(selectStart);
    label.dispatchEvent(menu);
    at("pointerdown");
    wait(HOLD_DELAY_MS);
    // Samsung Android 16 commits its native selection after Dure's 500ms
    // menu timer, while the finger is still down.
    const range = document.createRange();
    range.selectNodeContents(label);
    window.getSelection()?.addRange(range);
    // The menu render removes the held row before Android sends pointercancel,
    // so no release event can be required for the late clear.
    vi.runAllTimers();

    expect(selectStart.defaultPrevented).toBe(true);
    expect(menu.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toBe("");
    expect(held).toEqual([ROW_RECT]);
  });

  /**
   * 브라우저가 길게 누름 뒤의 click을 아예 보내지 않는 경우가 있다. 그때 플래그가
   * 서 있는 채로 남으면 다음 탭이 먹힌다 — keyStripView.ts가 겪은 그 버그.
   */
  it("click이 오지 않아도 다음 누름에서 억제가 풀린다", () => {
    bind();
    at("pointerdown");
    wait(HOLD_DELAY_MS);
    at("pointerup");

    at("pointerdown");
    at("pointerup");
    expect(tapClick()).toBe(false);
    expect(opened).toBe(1);
  });

  it("dispose()는 걸려 있던 타이머를 끈다", () => {
    const binding = bind();
    at("pointerdown");
    binding.dispose();

    wait(HOLD_DELAY_MS);
    expect(held).toEqual([]);
  });

  it("dispose() 뒤에는 누름도 click 억제도 남지 않는다", () => {
    const binding = bind();
    // 한 번 열어 두어 억제 플래그를 세워 둔다 — 리스너가 남아 있다면 삼킬 것이다.
    at("pointerdown");
    wait(HOLD_DELAY_MS);
    at("pointerup");
    binding.dispose();

    at("pointerdown");
    wait(HOLD_DELAY_MS);
    expect(held).toHaveLength(1);
    expect(tapClick()).toBe(false);
    expect(opened).toBe(1);

    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    label.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });
});
