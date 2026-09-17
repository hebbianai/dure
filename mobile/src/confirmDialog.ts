/**
 * The two-button "are you sure?" dialog. Figma `dure-UI` 3202:81879.
 *
 * One component, because there are now two of them: 기기 초기화 in 설정, and
 * 기본값으로 재설정 on the key-strip screen. Both frames draw the same thing —
 * a scrim, a `glass/bubble` card, a title, a line of consequence, and 취소
 * beside a light button whose label is destructive-coloured — and a second copy
 * would be two answers to "what does a confirmation look like here".
 *
 * # What the caller decides, and what it does not
 *
 * Copy and the confirming verb are the caller's. The shape, the focus trap and
 * the fact that Escape cancels are not: a dialog that traps a phone's focus
 * differently on two screens is a dialog somebody can get stuck in on one of
 * them.
 */

import "./confirmDialog.css";

import { element } from "./dom";
import { t } from "./i18n";

export interface ConfirmDialogModel {
  readonly title: string;
  /** One line: what happens if they go ahead. */
  readonly description: string;
  /** The verb on the confirming button — 초기화, 재설정. */
  readonly confirmLabel: string;
  /** The work is already running; both buttons refuse further presses. */
  readonly busy?: boolean;
}

export interface ConfirmDialogActions {
  readonly cancel: () => void;
  readonly confirm: () => void;
}

const TITLE_ID = "confirm-dialog-title";
const DESCRIPTION_ID = "confirm-dialog-description";

export function renderConfirmDialog(
  model: ConfirmDialogModel,
  actions: ConfirmDialogActions,
): HTMLElement {
  const busy = model.busy === true;
  const overlay = element("div", "confirm-dialog");
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", TITLE_ID);
  overlay.setAttribute("aria-describedby", DESCRIPTION_ID);
  overlay.setAttribute("aria-busy", String(busy));

  const panel = element("div", "confirm-dialog__panel");
  const title = element("h2", "confirm-dialog__title", model.title);
  title.id = TITLE_ID;
  const description = element("p", "confirm-dialog__description", model.description);
  description.id = DESCRIPTION_ID;

  const actionsRow = element("div", "confirm-dialog__actions");
  const cancel = element("button", "confirm-dialog__button", t("취소"));
  cancel.type = "button";
  cancel.disabled = busy;
  cancel.addEventListener("click", actions.cancel);

  const confirm = element(
    "button",
    "confirm-dialog__button confirm-dialog__button--confirm",
    model.confirmLabel,
  );
  confirm.type = "button";
  confirm.disabled = busy;
  confirm.addEventListener("click", actions.confirm);

  overlay.addEventListener("keydown", (event) => {
    if (busy) return;
    if (event.key === "Escape") {
      event.preventDefault();
      actions.cancel();
      return;
    }
    if (event.key !== "Tab") return;
    if (event.shiftKey && document.activeElement === cancel) {
      event.preventDefault();
      confirm.focus();
    } else if (!event.shiftKey && document.activeElement === confirm) {
      event.preventDefault();
      cancel.focus();
    }
  });

  actionsRow.append(cancel, confirm);
  panel.append(title, description, actionsRow);
  overlay.append(panel);
  // Cancel takes the focus, never the destructive button: a stray Return must
  // not be the thing that resets somebody's strip.
  queueMicrotask(() => cancel.focus());
  return overlay;
}
