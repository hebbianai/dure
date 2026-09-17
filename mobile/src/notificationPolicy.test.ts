import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeState } from "./agentRuntimeState";
import { t } from "./i18n";
import {
  createNotificationObserver,
  decideNotification,
  readNotificationPermission,
} from "./notificationPolicy";
import type { NotificationPreference } from "./settingsPreferences";

function runtime(overrides: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return {
    lifecycle: "running",
    activity: "working",
    attention: "none",
    revision: "1",
    turnCompletedCount: "0",
    ...overrides,
  };
}

const approval = (id = "appr-1"): AgentRuntimeState =>
  runtime({ activity: "waiting", attention: "approval_required", attentionId: id, revision: "2" });

const APPROVAL = {
  title: t("승인 필요"),
  body: t("{session} 세션이 승인을 기다립니다", { session: "planner" }),
};
const TURN_END = {
  title: t("작업 완료"),
  body: t("{session} 세션의 에이전트가 턴을 마쳤습니다", { session: "planner" }),
};

function decide(
  preference: NotificationPreference,
  previous: AgentRuntimeState | undefined,
  next: AgentRuntimeState,
  hidden = true,
) {
  return decideNotification({ preference, previous, next, hidden, session: "planner" });
}

describe("decideNotification", () => {
  it("says nothing while the preference is off", () => {
    expect(decide("off", runtime(), approval())).toBeNull();
  });

  it("says nothing while the app is in the foreground — the screen itself shows it", () => {
    expect(decide("all", runtime(), approval(), false)).toBeNull();
  });

  it("says nothing for the seed record of an attach: nothing happened since the person looked", () => {
    expect(decide("all", undefined, approval())).toBeNull();
  });

  it("notifies a new approval under 승인만 and 모두", () => {
    expect(decide("approvals", runtime(), approval())).toEqual(APPROVAL);
    expect(decide("all", runtime(), approval())).toEqual(APPROVAL);
  });

  it("notifies each approval once, keyed by its id, and a new one after the last", () => {
    expect(decide("approvals", approval("appr-1"), approval("appr-1"))).toBeNull();
    expect(decide("approvals", approval("appr-1"), approval("appr-2"))).toEqual(APPROVAL);
  });

  it("falls back to the revision for an unnamed approval", () => {
    const unnamed = (revision: string) =>
      runtime({ activity: "waiting", attention: "approval_required", revision });
    expect(decide("approvals", unnamed("3"), unnamed("3"))).toBeNull();
    expect(decide("approvals", unnamed("3"), unnamed("4"))).toEqual(APPROVAL);
  });

  it("notifies a finished turn under 모두 only", () => {
    const before = runtime({ turnCompletedCount: "4" });
    const after = runtime({ activity: "waiting", turnCompletedCount: "5" });
    expect(decide("all", before, after)).toEqual(TURN_END);
    expect(decide("approvals", before, after)).toBeNull();
    const sameTurn = runtime({ activity: "waiting", turnCompletedCount: "4" });
    expect(decide("all", before, sameTurn)).toBeNull();
  });

  it("reads the turn counter alone: the working→waiting edge is not a turn end", () => {
    const counted = runtime({ turnCompletedCount: "4" });
    expect(decide("all", counted, { ...counted, activity: "waiting" })).toBeNull();
    expect(decide("all", runtime(), runtime({ activity: "waiting" }))).toBeNull();
  });

  /**
   * The first turn: the counter goes 0→1 while the activity stays `waiting`
   * (an approval answered elsewhere, then the agent finishing). The edge
   * never happens; the counter is what says the turn ended.
   */
  it("notifies the first finished turn when the activity never crosses working→waiting", () => {
    const before = runtime({ activity: "waiting", attention: "approval_required", attentionId: "appr-1" });
    const after = runtime({ activity: "waiting", turnCompletedCount: "1" });
    expect(decide("all", before, after)).toEqual(TURN_END);
  });

  it("names the input the agent waits for when the turn ends on a question", () => {
    const question = runtime({
      activity: "waiting",
      attention: "input_required",
      attentionId: "q-1",
      turnCompletedCount: "1",
    });
    expect(decide("all", runtime(), question)).toEqual({
      title: t("작업 완료"),
      body: t("{session} 세션의 에이전트가 입력을 기다립니다", { session: "planner" }),
    });
  });

  it("sends one notice, the approval, when a turn ends on an approval", () => {
    expect(decide("all", runtime({ turnCompletedCount: "4" }), approval())).toEqual(APPROVAL);
  });
});

describe("createNotificationObserver", () => {
  it("remembers the last state, reads preference and visibility per record, hands the notice on", () => {
    const notify = vi.fn();
    let preference: NotificationPreference = "approvals";
    let hidden = false;
    const observer = createNotificationObserver({
      preference: () => preference,
      hidden: () => hidden,
      session: "planner",
      notify,
    });

    observer.observe(runtime());
    observer.observe(approval("appr-1"));
    expect(notify).not.toHaveBeenCalled();

    hidden = true;
    observer.observe(approval("appr-1"));
    expect(notify).not.toHaveBeenCalled();

    observer.observe(approval("appr-2"));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(APPROVAL);

    preference = "off";
    observer.observe(approval("appr-3"));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("readNotificationPermission", () => {
  it("parses both plugin answers, and treats anything unknown as not yet asked", () => {
    expect(readNotificationPermission(true)).toBe("granted");
    expect(readNotificationPermission("granted")).toBe("granted");
    expect(readNotificationPermission(false)).toBe("denied");
    expect(readNotificationPermission("denied")).toBe("denied");
    expect(readNotificationPermission(null)).toBe("prompt");
    expect(readNotificationPermission("default")).toBe("prompt");
    expect(readNotificationPermission(undefined)).toBe("prompt");
  });
});
