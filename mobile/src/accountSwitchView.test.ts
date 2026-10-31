import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AccountSheetActions, renderAccountSheet } from "./accountSwitchView";
import { t } from "./i18n";
import type { SessionAccountChoice } from "./ipc";

const ACCOUNTS: SessionAccountChoice[] = [
  { current: false, pending: false },
  {
    account_id: "acct-work",
    label: "Work",
    current: true,
    pending: false,
    usage: { used_percent: 100, window: "five_hour", resets_in: "1h 20m" },
  },
  {
    account_id: "acct-spare",
    label: "Spare",
    current: false,
    pending: false,
    usage: { used_percent: 12, window: "weekly" },
  },
];

function actions(overrides: Partial<AccountSheetActions> = {}): AccountSheetActions {
  return {
    dismiss: vi.fn(),
    reload: vi.fn(),
    choose: vi.fn(),
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("renderAccountSheet", () => {
  it("shows the current account with its usage, apart from the ones to switch to", () => {
    const host = renderAccountSheet(
      { session: "claude-2", computer: "Laptop", stage: { kind: "ready", accounts: ACCOUNTS } },
      actions(),
    );
    document.body.append(host);

    const headings = [...host.querySelectorAll(".account-sheet__heading")].map((node) => node.textContent);
    expect(headings).toEqual([t("account.current"), t("account.switchTo")]);
    const current = host.querySelector<HTMLElement>('[data-account="acct-work"]');
    expect(current?.tagName).toBe("DIV");
    expect(current?.classList.contains("account-sheet__row--limited")).toBe(true);
    expect(current?.querySelector(".account-sheet__detail")?.textContent).toBe(
      "100% of the 5-hour limit used · resets in 1h 20m",
    );
    expect(host.querySelector('[data-account="default"] .account-sheet__name')?.textContent).toBe(
      t("account.default"),
    );
    expect(host.querySelector('[data-account="default"] .account-sheet__detail')?.textContent).toBe(
      t("account.usage.unknown"),
    );
  });

  it("chooses another account, never the current one", () => {
    const choose = vi.fn();
    const host = renderAccountSheet(
      { session: "claude-2", computer: "Laptop", stage: { kind: "ready", accounts: ACCOUNTS } },
      actions({ choose }),
    );
    document.body.append(host);

    host.querySelector<HTMLButtonElement>('[data-account="acct-spare"]')?.click();
    host.querySelector<HTMLElement>('[data-account="acct-work"]')?.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledWith(ACCOUNTS[2]);
  });

  /** A switch restarts the session; the sheet asks before anything is sent. */
  it("asks for the restart before confirming", () => {
    const confirm = vi.fn();
    const cancelConfirm = vi.fn();
    const host = renderAccountSheet(
      {
        session: "claude-2",
        computer: "Laptop",
        stage: { kind: "ready", accounts: ACCOUNTS, confirm: ACCOUNTS[2] },
      },
      actions({ confirm, cancelConfirm }),
    );
    document.body.append(host);

    const dialog = host.querySelector(".confirm-dialog");
    expect(dialog?.querySelector(".confirm-dialog__title")?.textContent).toBe(
      t("account.confirm.title", { account: "Spare" }),
    );
    const [cancel, restart] = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    expect(restart?.textContent).toBe(t("account.confirm.action"));
    restart?.click();
    cancel?.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancelConfirm).toHaveBeenCalledOnce();
  });

  it("locks the list while a switch is on its way and says where it is going", () => {
    const host = renderAccountSheet(
      {
        session: "claude-2",
        computer: "Laptop",
        stage: { kind: "ready", accounts: ACCOUNTS, switching: ACCOUNTS[2] },
      },
      actions(),
    );
    document.body.append(host);

    expect(host.querySelector(".account-sheet__waiting")?.textContent).toBe(
      t("account.switching", { account: "Spare" }),
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button.account-sheet__row")];
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("says a refusal as an alert and offers to ask again after a failed read", () => {
    const reload = vi.fn();
    const refused = renderAccountSheet(
      {
        session: "claude-2",
        computer: "Laptop",
        stage: { kind: "ready", accounts: ACCOUNTS, notice: { tone: "error", text: "busy" } },
      },
      actions(),
    );
    expect(refused.querySelector(".account-sheet__notice--error")?.getAttribute("role")).toBe("alert");

    const failed = renderAccountSheet(
      { session: "claude-2", computer: "Laptop", stage: { kind: "failed", message: "offline" } },
      actions({ reload }),
    );
    document.body.append(failed);
    [...failed.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === t("account.reload"))
      ?.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
