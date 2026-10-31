/**
 * The account sheet a session row's menu opens (#287): which account the
 * session runs on, how much of its limit is left, and the accounts the paired
 * computer would move it to.
 *
 * A sheet over the list, like the info sheet: the list is where the person
 * returns once the switch is asked for. Choosing an account opens the
 * confirmation over the sheet — a switch restarts the session, and the
 * computer refuses one that was not confirmed.
 *
 * Draws only. What each answer means is `accountSwitch.ts`; when to ask is
 * `app.ts`.
 */

import iconCheck from "./assets/icon-check.svg";
import iconHistory from "./assets/icon-history.svg";
import { type AccountNotice, accountName, limitReached, usageText } from "./accountSwitch";
import { renderConfirmDialog } from "./confirmDialog";
import { element, glyph, loader, sheetShell } from "./dom";
import { t } from "./i18n";
import type { SessionAccountChoice } from "./ipc";
import "./accountSwitchView.css";

export type AccountSheetStage =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly accounts: readonly SessionAccountChoice[];
      readonly notice?: AccountNotice;
      /** The switch is on its way; nothing else may be pressed. */
      readonly switching?: SessionAccountChoice;
      /** The account waiting for the person's confirmation. */
      readonly confirm?: SessionAccountChoice;
    };

export interface AccountSheetModel {
  /** The session's title, as the row shows it. */
  readonly session: string;
  readonly computer: string;
  readonly stage: AccountSheetStage;
}

export interface AccountSheetActions {
  readonly dismiss: () => void;
  /** Ask the computer again after a failed read. */
  readonly reload: () => void;
  readonly choose: (choice: SessionAccountChoice) => void;
  readonly confirm: () => void;
  readonly cancelConfirm: () => void;
}

export function renderAccountSheet(model: AccountSheetModel, actions: AccountSheetActions): HTMLElement {
  const { host, panel } = sheetShell(t("account.sheetTitle"), actions.dismiss, "sheet--tray account-sheet");
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", t("account.sheetLabel", { title: model.session }));
  panel.append(element("p", "sheet__note", t("account.sheetNote", { session: model.session, computer: model.computer })));

  const { stage } = model;
  if (stage.kind === "loading") {
    const waiting = element("div", "account-sheet__waiting");
    waiting.append(loader(16), element("span", undefined, t("account.loading", { computer: model.computer })));
    panel.append(waiting);
  } else if (stage.kind === "failed") {
    panel.append(notice({ tone: "error", text: stage.message }));
    const retry = element("button", "pair-button pair-button--solid pair-button--block", t("account.reload"));
    retry.type = "button";
    retry.addEventListener("click", actions.reload);
    panel.append(retry);
  } else {
    if (stage.switching) {
      const waiting = element("div", "account-sheet__waiting");
      waiting.append(loader(16), element("span", undefined, t("account.switching", { account: accountName(stage.switching.label) })));
      panel.append(waiting);
    } else if (stage.notice) {
      panel.append(notice(stage.notice));
    }
    panel.append(accountList(stage.accounts, stage.switching !== undefined, actions.choose));
  }

  const close = element("button", "pair-button pair-button--ghost pair-button--block", t("common.close"));
  close.type = "button";
  close.addEventListener("click", actions.dismiss);
  panel.append(close);

  if (stage.kind === "ready" && stage.confirm) {
    const name = accountName(stage.confirm.label);
    host.append(
      renderConfirmDialog(
        {
          title: t("account.confirm.title", { account: name }),
          description: t("account.confirm.description", { account: name }),
          confirmLabel: t("account.confirm.action"),
        },
        { cancel: actions.cancelConfirm, confirm: actions.confirm },
      ),
    );
  }
  return host;
}

function notice(value: AccountNotice): HTMLElement {
  const line = element("p", `account-sheet__notice account-sheet__notice--${value.tone}`, value.text);
  line.setAttribute("role", value.tone === "error" ? "alert" : "status");
  return line;
}

/**
 * Current account first, under its own heading, then the rest. The current
 * row is not a button: choosing the account already in use asks the computer
 * for nothing, and a press that does nothing reads as a broken one.
 */
function accountList(
  accounts: readonly SessionAccountChoice[],
  locked: boolean,
  choose: (choice: SessionAccountChoice) => void,
): HTMLElement {
  const list = element("div", "account-sheet__list");
  const current = accounts.filter((choice) => choice.current);
  const others = accounts.filter((choice) => !choice.current);
  if (current.length > 0) {
    list.append(element("h3", "account-sheet__heading", t("account.current")));
    for (const choice of current) list.append(accountRow(choice));
  }
  if (others.length > 0) {
    list.append(element("h3", "account-sheet__heading", t("account.switchTo")));
    for (const choice of others) {
      const row = accountRow(choice, () => choose(choice));
      if (row instanceof HTMLButtonElement) row.disabled = locked;
      list.append(row);
    }
  }
  return list;
}

function accountRow(choice: SessionAccountChoice, press?: () => void): HTMLElement {
  const row = element(press ? "button" : "div", "account-sheet__row");
  row.dataset.account = choice.account_id ?? "default";
  if (row instanceof HTMLButtonElement && press) {
    row.type = "button";
    row.addEventListener("click", press);
  }
  if (limitReached(choice.usage)) row.classList.add("account-sheet__row--limited");

  const copy = element("span", "account-sheet__copy");
  copy.append(element("span", "account-sheet__name", accountName(choice.label)));
  const usage = usageText(choice.usage) ?? t("account.usage.unknown");
  const detail = choice.pending ? t("account.pendingDetail", { usage }) : usage;
  copy.append(element("span", "account-sheet__detail", detail));
  row.append(copy);
  if (choice.current) row.append(glyph(iconCheck, 14, "account-sheet__mark"));
  else if (choice.pending) row.append(glyph(iconHistory, 14, "account-sheet__mark account-sheet__mark--pending"));
  return row;
}
