/**
 * The floating notice, the desktop's toast Alert on the phone (`toast.ts`).
 *
 * Where it stands and what it wears are CSS, which jsdom cannot see; the
 * device QA owns those. What is fixed here is the anatomy: which tone shows
 * which parts, what it announces, and what a press does and does not do.
 */

import { describe, expect, it } from "vitest";
import { type ToastModel, renderToast } from "./toast";

const FAILURE: ToastModel = {
  tone: "destructive",
  title: "연결할 수 없습니다",
  detail: "mac-mini에 닿지 않습니다. 컴퓨터가 켜져 있는지 확인하세요.",
};
const REPORT: ToastModel = { tone: "neutral", title: "에이전트를 띄웠습니다" };

function open(model: ToastModel): { card: HTMLElement; dismissed: () => number } {
  let count = 0;
  const card = renderToast(model, {
    dismiss: () => {
      count += 1;
    },
  });
  return { card, dismissed: () => count };
}

describe("floating notice", () => {
  it("draws a failure as title and detail, with the alert glyph and a close control", () => {
    const { card } = open(FAILURE);

    expect(card.classList.contains("toast--destructive")).toBe(true);
    expect(card.querySelector(".toast__title")?.textContent).toBe(FAILURE.title);
    expect(card.querySelector(".toast__detail")?.textContent).toBe(FAILURE.detail);
    expect(card.querySelector(".toast__glyph")).not.toBeNull();
    expect(card.querySelector<HTMLButtonElement>(".toast__close")?.type).toBe("button");
  });

  it("draws a report as copy alone: no glyph, no close, no second line", () => {
    const { card } = open(REPORT);

    expect(card.classList.contains("toast--neutral")).toBe(true);
    expect(card.querySelector(".toast__glyph")).toBeNull();
    expect(card.querySelector(".toast__close")).toBeNull();
    expect(card.querySelector(".toast__detail")).toBeNull();
  });

  /** A failure asserts, a report is polite — the desktop's own live regions. */
  it("announces itself, a failure louder than a report", () => {
    expect(open(FAILURE).card.getAttribute("role")).toBe("alert");
    expect(open(REPORT).card.getAttribute("role")).toBe("status");
    expect(open(REPORT).card.getAttribute("aria-atomic")).toBe("true");
  });

  it("closes on a press anywhere on the card, and once on the close control", () => {
    const failure = open(FAILURE);
    failure.card.click();
    expect(failure.dismissed()).toBe(1);
    failure.card.querySelector<HTMLButtonElement>(".toast__close")?.click();
    // The control's own press does not bubble into a second dismissal.
    expect(failure.dismissed()).toBe(2);

    const report = open(REPORT);
    report.card.click();
    expect(report.dismissed()).toBe(1);
  });

  /**
   * Taking the card down is the caller's job. A press only asks; the card
   * stays in the tree, so the caller never removes a node already gone or
   * draws a second one over a card it believes is still up.
   */
  it("stays in the tree after asking to be dismissed", () => {
    const { card, dismissed } = open(FAILURE);
    const host = document.createElement("div");
    host.append(card);

    card.click();

    expect(dismissed()).toBe(1);
    expect(host.contains(card)).toBe(true);
  });

  it("keys its entrance by its text", () => {
    expect(open(REPORT).card.dataset.text).toBe(REPORT.title);
  });
});
