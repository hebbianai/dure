/**
 * The floating notice: the desktop's `Alert surface="toast"` on the phone.
 *
 * One form for every notice that floats over content it is unrelated to,
 * as on the desktop (owner call 2026-09-12 there; 2026-09-15 승연 here: "웹
 * 토스트 디자인이랑 통일"). It wears the menu's material — glass/menu under a
 * 15px blur, the menu hairline, shadow-menu, the 8px radius — and the tone
 * lives in the copy and the glyph, as shadcn draws it: a failure is
 * destructive with a 12px alert glyph and a close control, and stays until
 * it is closed; a plain report is foreground copy with no glyph, and the
 * caller takes it down after the desktop's 2.5 seconds.
 *
 * It stands at the bottom, where what it answers usually is — the row that
 * was pressed, the tray, the thing just done — and where it covers no bar.
 * The stylesheet places it above the session's tray and left of Home's FAB.
 * Fixed, so nothing in the column moves when it appears: the row somebody
 * pressed stays under the finger still on it.
 *
 * A failure can be dismissed by its close control or by pressing the card
 * anywhere: a thumb finds 328px more easily than 24.
 */
import iconCircleAlert from "./assets/icon-circle-alert.svg";
import iconX from "./assets/icon-x.svg";
import { element, glyph } from "./dom";
import { t } from "./i18n";
import "./toast.css";

export type ToastTone = "neutral" | "destructive";

export interface ToastModel {
  readonly tone: ToastTone;
  /** What happened, or what did not. */
  readonly title: string;
  /** A second line — which machine, what to look at. Optional. */
  readonly detail?: string;
}

export function renderToast(
  model: ToastModel,
  actions: { readonly dismiss: () => void },
): HTMLElement {
  const failure = model.tone === "destructive";
  const card = element("div", `toast toast--${model.tone}`);
  // The entrance ledger keys the toast by its text: a new message rises
  // again, a render that rebuilds the same one stands still.
  card.dataset.text = model.title;
  // A failure asserts, a report is polite — the desktop's own live regions.
  card.setAttribute("role", failure ? "alert" : "status");
  card.setAttribute("aria-atomic", "true");
  if (failure) card.append(glyph(iconCircleAlert, 12, "toast__glyph"));
  const lines = element("span", "toast__lines");
  lines.append(element("span", "toast__title", model.title));
  if (model.detail) lines.append(element("span", "toast__detail", model.detail));
  card.append(lines);
  if (failure) {
    const close = element("button", "toast__close");
    close.type = "button";
    close.setAttribute("aria-label", t("common.close"));
    close.append(glyph(iconX, 14));
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.dismiss();
    });
    card.append(close);
  }
  card.addEventListener("click", actions.dismiss);
  return card;
}
