import { describe, expect, it } from "vitest";
import {
  type BackgroundWorkAnswer,
  type BackgroundWorkItem,
  backgroundWorkHiddenCount,
  backgroundWorkRows,
  backgroundWorkSummary,
} from "./backgroundWork";
import { t } from "./i18n";

const NOW = 1_793_600_000_000;
const MINUTE = 60_000;

function listed(
  items: BackgroundWorkItem[],
  counts: Partial<BackgroundWorkAnswer["counts"]> = {},
  truncated = false,
): BackgroundWorkAnswer {
  return {
    hub_conversation_version: 1,
    outcome: "listed",
    items,
    counts: { subagents: 0, workflows: 0, shells: 0, monitors: 0, ...counts },
    truncated,
  };
}

describe("backgroundWorkSummary", () => {
  it("hides the line when nothing runs or the computer refused", () => {
    expect(backgroundWorkSummary(listed([]))).toBeNull();
    expect(
      backgroundWorkSummary({
        hub_conversation_version: 1,
        outcome: "refused",
        code: "unavailable",
      }),
    ).toBeNull();
  });

  it("counts subagents and workflows as running, then shells and monitors", () => {
    expect(
      backgroundWorkSummary(
        listed([], { subagents: 2, workflows: 9, shells: 4, monitors: 5 }),
      ),
    ).toBe(
      [
        t("chat.backgroundWork.running", { n: 11 }),
        t("chat.backgroundWork.shells.other", { n: 4 }),
        t("chat.backgroundWork.monitors.other", { n: 5 }),
      ].join(" · "),
    );
    expect(backgroundWorkSummary(listed([], { shells: 1 }))).toBe(
      t("chat.backgroundWork.shells.one"),
    );
  });
});

describe("backgroundWorkRows", () => {
  it("formats steps, elapsed time and tokens like the desktop", () => {
    const [row] = backgroundWorkRows(
      listed([
        {
          id: "wf_1",
          kind: "workflow",
          label: "typing-accuracy-first",
          started_unix_ms: NOW - (16 * 60 + 35) * MINUTE,
          steps: { done: 9, total: 10 },
          tokens: 4_700_000,
        },
      ]),
      NOW,
    );
    expect(row).toEqual({
      id: "wf_1",
      kind: "workflow",
      label: "typing-accuracy-first",
      progress: 0.9,
      steps: "9/10",
      elapsed: "16h35m",
      tokens: "4.7M",
    });
  });

  it("names an item without a description by its kind and leaves out what was not recorded", () => {
    const [row] = backgroundWorkRows(
      listed([{ id: "s", kind: "shell", started_unix_ms: NOW - 45_000 }]),
      NOW,
    );
    expect(row.label).toBe(t("chat.backgroundWork.kind.shell"));
    expect([row.progress, row.steps, row.tokens, row.elapsed]).toEqual([
      null,
      null,
      null,
      "45s",
    ]);
  });

  it("shows a kind a newer computer sent by a neutral name", () => {
    const [row] = backgroundWorkRows(
      listed([{ id: "c", kind: "cron", started_unix_ms: NOW }]),
      NOW,
    );
    expect(row.label).toBe(t("chat.backgroundWork.kind.other"));
  });
});

describe("backgroundWorkHiddenCount", () => {
  it("counts what a truncated list left out", () => {
    const items: BackgroundWorkItem[] = [
      { id: "a", kind: "shell", started_unix_ms: NOW },
    ];
    expect(backgroundWorkHiddenCount(listed(items, { shells: 70 }, true))).toBe(
      69,
    );
    expect(backgroundWorkHiddenCount(listed(items, { shells: 1 }))).toBe(0);
  });
});
