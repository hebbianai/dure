import { beforeEach, describe, expect, it, vi } from "vitest";
import { type RowMenuItem, type RowMenuModel, renderSessionRowMenu } from "./sessionRowMenu";
import { type MenuAnchor, placeRowMenu } from "./sessionRowMenuPlacement";

/** 눌린 행. 화면 좌표 그대로다. */
const ANCHOR: MenuAnchor = { top: 240, left: 12, width: 351, height: 64 };

const ITEMS: readonly RowMenuItem[] = [
  { id: "open", label: "열기", icon: "open.svg", run: () => {} },
  { id: "rename", label: "이름 바꾸기", icon: "rename.svg", run: () => {} },
  {
    id: "stop",
    label: "세션 종료",
    icon: "stop.svg",
    destructive: true,
    separated: true,
    run: () => {},
  },
];

function model(over: Partial<RowMenuModel> = {}): RowMenuModel {
  return {
    anchor: ANCHOR,
    title: "결제 재시도",
    subtitle: "gate1 · fix/payment-retry",
    items: ITEMS,
    ...over,
  };
}

/** 통합자가 하는 그대로: 그린 다음 화면에 붙인다. */
function open(
  over: Partial<RowMenuModel> = {},
  actions = { dismiss: () => {} },
): HTMLElement {
  const host = renderSessionRowMenu(model(over), actions);
  document.body.append(host);
  return host;
}

const items = (host: HTMLElement): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>(".row-menu__item"),
];

const itemNamed = (host: HTMLElement, label: string): HTMLButtonElement => {
  const found = items(host).find((item) => item.textContent === label);
  if (!found) throw new Error(`no item ${label}`);
  return found;
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderSessionRowMenu", () => {
  /**
   * 렌더가 트리를 통째로 갈아치우므로 원래 행 노드는 다음 프레임에 없다. 눌린
   * 행이 스크림 위에 남으려면 그 자리에 복사본을 다시 그리는 수밖에 없다.
   */
  it("눌린 행을 있던 자리에 그대로 다시 그린다", () => {
    const row = open().querySelector<HTMLElement>(".row-menu__row");

    expect(row?.textContent).toBe("결제 재시도gate1 · fix/payment-retry");
    expect(row?.style.top).toBe("240px");
    expect(row?.style.left).toBe("12px");
    expect(row?.style.width).toBe("351px");
    expect(row?.style.height).toBe("64px");
  });

  it("두 번째 줄이 없는 세션은 제목만 다시 그린다", () => {
    const row = open({ subtitle: undefined }).querySelector<HTMLElement>(".row-menu__row");

    expect(row?.textContent).toBe("결제 재시도");
    expect(row?.querySelector(".row-menu__row-subtitle")).toBeNull();
  });

  /**
   * 카드 자리는 `placeRowMenu`가 정한다 — 화면 아래쪽 행이면 행 밑에 그리라는
   * 계산 결과(804px)가 아니라 안전 영역 안으로 끌어올린 값이 나와야 한다.
   * jsdom은 배치를 하지 않아 카드 높이가 0이고, 그래서 여기서 갈리는 것은
   * 오직 "누가 계산했는가"다.
   */
  it("카드 위치를 placeRowMenu에 맡긴다", () => {
    const anchor: MenuAnchor = { top: 740, left: 12, width: 351, height: 64 };
    const card = open({ anchor }).querySelector<HTMLElement>(".row-menu__card");

    const expected = placeRowMenu(anchor, 0, {
      width: window.innerWidth,
      height: window.innerHeight,
      safeTop: 0,
      safeBottom: 0,
    });
    expect(expected.top).toBeLessThan(anchor.top + anchor.height);
    expect(card?.style.top).toBe(`${expected.top}px`);
    expect(card?.style.left).toBe(`${expected.left}px`);
  });

  it("메뉴와 항목을 보조기술이 읽을 수 있는 역할로 내놓는다", () => {
    const host = open();

    expect(host.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector(".row-menu__card")?.getAttribute("role")).toBe("menu");
    expect(items(host).map((item) => item.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
    ]);
  });

  /** 스크림 말고는 이 화면에서 빠져나갈 방법이 없다. */
  it("스크림을 누르면 닫는다", () => {
    const dismiss = vi.fn();
    const host = open({}, { dismiss });

    host.click();

    expect(dismiss).toHaveBeenCalledOnce();
  });

  /** 카드 안을 눌러 놓고 메뉴가 사라지면 고르던 동작을 잃는다. */
  it("카드 안을 눌러도 닫지 않는다", () => {
    const dismiss = vi.fn();
    const host = open({}, { dismiss });

    host.querySelector<HTMLElement>(".row-menu__card")?.click();

    expect(dismiss).not.toHaveBeenCalled();
  });

  /**
   * 아무것도 포커스를 갖지 않으므로 키는 body에 도착한다 — 호스트에 건 리스너로는
   * 영영 오지 않는다.
   */
  it("Escape로 닫는다", () => {
    const dismiss = vi.fn();
    open({}, { dismiss });

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("다른 키는 삼키지 않는다", () => {
    const dismiss = vi.fn();
    open({}, { dismiss });

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(dismiss).not.toHaveBeenCalled();
  });

  /**
   * 이름 바꾸기는 메뉴 위에 시트를 연다. 메뉴가 스스로 닫아버리면 그 시트가
   * 무엇에 대한 것이었는지가 함께 사라진다 — 닫는 것은 부르는 쪽의 몫이다.
   */
  it("항목을 고르면 그 동작만 실행하고 스스로 닫지 않는다", () => {
    const run = vi.fn();
    const dismiss = vi.fn();
    const host = open({ items: [{ ...ITEMS[0], run }, ITEMS[1]] }, { dismiss });

    itemNamed(host, "열기").click();

    expect(run).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
  });

  /** 구분선 위 항목의 `run`이 대신 불리면 사람이 세션을 잘못 종료한다. */
  it("누른 항목의 동작만 실행한다", () => {
    const stop = vi.fn();
    const openRun = vi.fn();
    const host = open({
      items: [{ ...ITEMS[0], run: openRun }, { ...ITEMS[2], run: stop }],
    });

    itemNamed(host, "세션 종료").click();

    expect(stop).toHaveBeenCalledOnce();
    expect(openRun).not.toHaveBeenCalled();
  });

  /** 3356:85398 — 세션 종료를 가르는 실선과, 그 아래의 더 높은 행. */
  it("구분선을 긋고 그 아래 항목을 한 단 높게 그린다", () => {
    const host = open();

    expect(host.querySelectorAll(".row-menu__divider")).toHaveLength(1);
    expect(host.querySelector(".row-menu__divider")?.getAttribute("role")).toBe("separator");
    expect(items(host).map((item) => item.classList.contains("row-menu__item--below"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("구분선이 없으면 선도 높은 행도 없다", () => {
    const host = open({ items: [ITEMS[0], ITEMS[1]] });

    expect(host.querySelector(".row-menu__divider")).toBeNull();
    expect(items(host).some((item) => item.classList.contains("row-menu__item--below"))).toBe(
      false,
    );
  });

  /**
   * 색은 항목 전체가 갖는다 — 글리프는 `currentColor`로 칠하는 마스크라, 라벨만
   * 붉고 아이콘은 흰 조합이 나올 수 없다.
   */
  it("파괴적 항목은 라벨과 아이콘을 함께 물들인다", () => {
    const host = open();
    const destructive = host.querySelector<HTMLElement>(".row-menu__item--destructive");

    expect(destructive?.querySelector(".row-menu__label")?.textContent).toBe("세션 종료");
    expect(destructive?.querySelector(".row-menu__icon")).not.toBeNull();
    expect(items(host).filter((item) => item.classList.contains("row-menu__item--destructive")))
      .toHaveLength(1);
  });

  /**
   * 뒤의 화면은 인구조사 틱마다 다시 그려지고, 그 렌더는 포커스를 날린다.
   * 메뉴가 첫 항목을 잡아두면 그 틱들과 스크린리더 커서를 두고 계속 다툰다.
   */
  it("아무것도 포커스를 가져가지 않는다", async () => {
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();

    open();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(elsewhere);
  });
});
