/**
 * jsdom reports `navigator.language` as `en-US`, so `t()` resolves through
 * `locales/en.ts` here — these assertions read the English catalogue, which
 * also checks that a new Korean string was actually translated.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CommitSheetModel, renderCommitSheet } from "./scmSheets";

function commit(over: Partial<CommitSheetModel> = {}, actions = {
  dismiss: () => {},
  edit: () => {},
  submit: () => {},
}) {
  const model: CommitSheetModel = {
    files: 3,
    branch: "fix/payment-retry",
    message: "",
    ...over,
  };
  return renderCommitSheet(model, actions);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderCommitSheet", () => {
  it("names what this commit is about", () => {
    expect(commit().textContent).toContain("3 files · fix/payment-retry");
  });

  /** 지어낸 이름 위에 커밋을 만들게 두지 않는다. */
  it("names only the count when the branch is unknown", () => {
    const sheet = commit({ branch: undefined });

    expect(sheet.textContent).toContain("3 files");
    expect(sheet.textContent).not.toContain("·");
  });

  /** 빈 메시지는 git 도 거절한다. 20초 뒤에 그 문장을 받는 것보다 낫다. */
  it("cannot be sent with a blank message", () => {
    const button = commit({ message: "  \n " }).querySelector<HTMLButtonElement>(
      ".pair-button--solid",
    );

    expect(button?.disabled).toBe(true);
  });

  /** 두 번 누르면 커밋이 둘 생긴다. */
  it("cannot be sent twice while a commit is in flight", () => {
    const dismiss = vi.fn();
    const sheet = commit({ message: "fix it", busy: true }, { dismiss, edit: () => {}, submit: () => {} });
    const button = sheet.querySelector<HTMLButtonElement>(
      ".pair-button--solid",
    );

    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Committing…");
    sheet.click();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("reports edits and updates validation without replacing the message field", () => {
    const edit = vi.fn();
    const sheet = commit({ error: "commit rejected" }, { dismiss: () => {}, edit, submit: () => {} });
    document.body.append(sheet);

    const field = sheet.querySelector<HTMLTextAreaElement>("textarea");
    if (field === null) throw new Error("the message field");
    field.focus();
    field.value = "결제 재시도를 지수 백오프로 교체";
    field.dispatchEvent(new Event("input"));

    expect(edit).toHaveBeenCalledWith("결제 재시도를 지수 백오프로 교체");
    expect(sheet.querySelector<HTMLButtonElement>(".pair-button--solid")?.disabled).toBe(false);
    expect(sheet.querySelector(".prform__error")).toBeNull();
    expect(document.activeElement).toBe(field);
    field.value = " \n ";
    field.dispatchEvent(new Event("input"));
    expect(sheet.querySelector<HTMLButtonElement>(".pair-button--solid")?.disabled).toBe(true);
  });
});
