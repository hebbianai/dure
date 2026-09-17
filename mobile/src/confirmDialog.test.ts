import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderConfirmDialog } from "./confirmDialog";

describe("renderConfirmDialog", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  /**
   * 버튼에 동사를 싣는다. "확인" 은 두 버튼 모두에서 "그래, 계속" 으로 읽히고,
   * 그중 하나는 작업을 지운다 — 버튼만 읽는 사람이 어느 쪽인지 알아야 한다.
   */
  it("puts the verb on the button that destroys", () => {
    const confirmed = vi.fn();
    const dialog = renderConfirmDialog(
      { title: "변경을 버릴까요?", description: "되돌릴 수 없습니다.", confirmLabel: "버리기" },
      { cancel: () => {}, confirm: confirmed },
    );
    document.body.append(dialog);

    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Cancel", "버리기"]);
    buttons[1]?.click();
    expect(confirmed).toHaveBeenCalledOnce();
  });

  /**
   * 시트와 달리 바깥을 눌러도 닫히지 않는다. 그 제스처는 "취소" 를 뜻하지만,
   * 되돌릴 수 없는 일 앞에서는 실수로 닿기도 한다 — 여기서는 버튼만이 답이다.
   */
  it("has no dismiss-by-tapping-away", () => {
    const cancel = vi.fn();
    const dialog = renderConfirmDialog(
      { title: "t", description: "b", confirmLabel: "버리기" },
      { cancel, confirm: () => {} },
    );
    document.body.append(dialog);

    dialog.click();
    expect(cancel).not.toHaveBeenCalled();
  });

  /** While the work runs, neither button answers a second press. */
  it("refuses both buttons while busy", () => {
    const cancel = vi.fn();
    const confirm = vi.fn();
    const dialog = renderConfirmDialog(
      { title: "t", description: "b", confirmLabel: "버리기", busy: true },
      { cancel, confirm },
    );
    document.body.append(dialog);

    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
    for (const button of buttons) button.click();
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
