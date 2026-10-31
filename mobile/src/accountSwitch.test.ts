import { beforeEach, describe, expect, it } from "vitest";
import {
  accountHub,
  accountName,
  accountSummaryText,
  choiceId,
  durationText,
  limitReached,
  outcomeNotice,
  refusalText,
  retryKeepsPress,
  usageText,
} from "./accountSwitch";
import type { HubSessions } from "./allSessions";
import { t } from "./i18n";
import type { HubProbeSession, SessionAccountOutcome } from "./ipc";
import { DEFAULT_SETTINGS_PREFERENCES, saveSettingsPreferences } from "./settingsPreferences";

function session(sessionId: string, overrides: Partial<HubProbeSession> = {}): HubProbeSession {
  return {
    session_id: sessionId,
    session_name: null,
    workspace_id: "workspace-1",
    session_class: "managed",
    lifecycle: "ready",
    provider_id: "claude-code",
    runner_principal: "local-user",
    runner_instance: "runner-1",
    channel_epoch: "1",
    host_instance_id: "host-1",
    terminal_epoch: "terminal-1",
    capabilities: [],
    ready: true,
    launch_program: null,
    box_id: "this-laptop",
    box_label: "Laptop",
    ...overrides,
  };
}

function hub(hubId: string, sessions: HubProbeSession[], reachable = true): HubSessions {
  return { hubId, hubLabel: hubId, reachable, sessions };
}

function answer(overrides: Partial<SessionAccountOutcome>): SessionAccountOutcome {
  return { outcome: "listed", accounts: [], detail: null, code: null, ...overrides };
}

beforeEach(() => {
  localStorage.clear();
  saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language: "en" });
});

describe("accountHub", () => {
  /** An older computer sends no account line, so it is never offered a switch. */
  it("offers a switch only where a reachable computer reported an account line", () => {
    const withAccount = session("s-1", { presentation: { account: { label: "Work" } } });
    expect(accountHub("s-1", [hub("old", [session("s-1")])])).toBeUndefined();
    expect(accountHub("s-1", [hub("offline", [withAccount], false)])).toBeUndefined();
    expect(accountHub("s-1", [hub("old", [session("s-1")]), hub("new", [withAccount])])?.hubId).toBe("new");
  });
});

describe("account wording", () => {
  it("names the default account in the phone's own words", () => {
    expect(accountName(undefined)).toBe(t("account.default"));
    expect(accountName("  ")).toBe(t("account.default"));
    expect(accountName("Work")).toBe("Work");
    expect(choiceId({ current: false, pending: false })).toBeNull();
    expect(choiceId({ account_id: "acct-1", current: false, pending: false })).toBe("acct-1");
  });

  it("says a queued switch on the info line", () => {
    expect(accountSummaryText(session("s"))).toBeUndefined();
    expect(accountSummaryText(session("s", { presentation: { account: { label: "Work" } } }))).toBe("Work");
    expect(
      accountSummaryText(session("s", { presentation: { account: { label: "Work", pending: {} } } })),
    ).toBe("Work → Default account after this turn");
  });

  it("puts the computer's compact duration into words, and keeps what it cannot read", () => {
    expect(durationText("3h 40m")).toBe("3h 40m");
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language: "ko" });
    expect(durationText("2d 4h")).toBe("2일 4시간");
    expect(durationText("soon")).toBe("soon");
  });

  it("says which window the usage is for, and when it resets", () => {
    expect(usageText(undefined)).toBeUndefined();
    expect(usageText({ used_percent: 100, window: "five_hour", resets_in: "1h 20m" })).toBe(
      "100% of the 5-hour limit used · resets in 1h 20m",
    );
    expect(usageText({ used_percent: 40, window: "weekly" })).toBe("40% of the weekly limit used");
    expect(limitReached({ used_percent: 100, window: "weekly" })).toBe(true);
    expect(limitReached({ used_percent: 99, window: "weekly" })).toBe(false);
    expect(limitReached(null)).toBe(false);
  });
});

describe("outcomeNotice", () => {
  it("tells done, queued, still running and refused apart", () => {
    expect(outcomeNotice(answer({}), "Spare")).toBeUndefined();
    expect(outcomeNotice(answer({ outcome: "switched" }), "Spare")).toEqual({
      tone: "done",
      text: t("account.notice.switched", { account: "Spare" }),
    });
    expect(outcomeNotice(answer({ outcome: "scheduled" }), "Spare")?.tone).toBe("waiting");
    expect(outcomeNotice(answer({ outcome: "in_progress" }), "Spare")?.text).toBe(t("account.notice.inProgress"));
    expect(outcomeNotice(answer({ outcome: "refused", code: "busy", detail: "x" }), "Spare")).toEqual({
      tone: "error",
      text: t("account.refused.busy"),
    });
  });

  it("falls back to the computer's sentence for a code it does not know", () => {
    expect(refusalText("failed", "Could not switch the account: boom")).toBe("Could not switch the account: boom");
    expect(refusalText(null, null)).toBe(t("account.refused.unknown"));
  });
});

describe("retryKeepsPress", () => {
  /** Not knowing is not a refusal: a new name would restart the session again. */
  it("keeps the press name only when the outcome is unknown", () => {
    expect(retryKeepsPress(undefined)).toBe(true);
    expect(retryKeepsPress(answer({ outcome: "in_progress", code: "still_switching" }))).toBe(true);
    expect(retryKeepsPress(answer({ outcome: "refused", code: "screen_silent" }))).toBe(true);
    expect(retryKeepsPress(answer({ outcome: "refused", code: "busy" }))).toBe(false);
    expect(retryKeepsPress(answer({ outcome: "switched" }))).toBe(false);
  });
});
