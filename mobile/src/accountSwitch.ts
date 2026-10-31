/**
 * A session's provider account, seen from the phone (#287). Tauri/DOM 없이
 * 시험된다.
 *
 * # Who decides
 *
 * The paired computer. Its account selector owns which account a session is
 * on, what a switch does (restart on the same conversation, or wait for the
 * running turn), and the usage it shows. This file only decides what the
 * phone may offer — a switch only where the computer said it can perform one
 * — and how to say each answer.
 *
 * # Why the offer comes from the catalog
 *
 * `presentation.account` is present only when the computer answers account
 * requests for that session. An older computer never sends it, so the phone
 * never offers a switch that computer would close the connection on.
 */

import type { HubSessions } from "./allSessions";
import { t } from "./i18n";
import type {
  HubProbeSession,
  SessionAccountChoice,
  SessionAccountOutcome,
  SessionAccountUsage,
} from "./ipc";

/** The computer that can switch this session's account, and what it said about it. */
export interface AccountHub {
  readonly hubId: string;
  readonly hubLabel: string;
  readonly session: HubProbeSession;
}

/**
 * The first reachable paired computer that lists this session with an
 * account line. A row may have come by SSH while a laptop also lists it; the
 * laptop is still the one that can switch it.
 */
export function accountHub(sessionId: string, hubs: readonly HubSessions[]): AccountHub | undefined {
  for (const hub of hubs) {
    if (!hub.reachable) continue;
    const session = hub.sessions.find((candidate) => candidate.session_id === sessionId);
    if (session?.presentation?.account) {
      return { hubId: hub.hubId, hubLabel: hub.hubLabel, session };
    }
  }
  return undefined;
}

/** An account's name; the default account has none of its own. */
export function accountName(label: string | null | undefined): string {
  const named = label?.trim();
  return named ? named : t("account.default");
}

/**
 * The info sheet's account line: the current account, and the one a queued
 * switch will move to once the running turn ends.
 */
export function accountSummaryText(session: HubProbeSession): string | undefined {
  const account = session.presentation?.account;
  if (!account) return undefined;
  const current = accountName(account.label);
  return account.pending
    ? t("account.summaryPending", { current, next: accountName(account.pending.label) })
    : current;
}

const DURATION_TOKEN = /^(\d+)([dhm])$/;

/**
 * The computer's compact duration (`3h 40m`) in this phone's words.
 *
 * A token this build does not know is shown as it came: the computer's
 * number is still better than nothing, and nothing would read as "no reset".
 */
export function durationText(compact: string): string {
  const tokens = compact.trim().split(/\s+/);
  const words = tokens.map((token) => {
    const match = DURATION_TOKEN.exec(token);
    if (!match) return undefined;
    const [, count, unit] = match;
    const key = unit === "d" ? "account.duration.days" : unit === "h" ? "account.duration.hours" : "account.duration.minutes";
    return t(key, { count });
  });
  return words.every((word) => word !== undefined) ? words.join(" ") : compact.trim();
}

/** "92% of the 5-hour limit used · resets in 1h 20m". */
export function usageText(usage: SessionAccountUsage | null | undefined): string | undefined {
  if (!usage) return undefined;
  const used = t(usage.window === "weekly" ? "account.usage.weekly" : "account.usage.fiveHour", {
    percent: usage.used_percent,
  });
  const resets = usage.resets_in?.trim();
  return resets ? t("account.usage.withReset", { usage: used, reset: durationText(resets) }) : used;
}

/** At or past this, the account is at its limit for the window shown. */
const LIMIT_REACHED_PERCENT = 100;

export function limitReached(usage: SessionAccountUsage | null | undefined): boolean {
  return usage != null && usage.used_percent >= LIMIT_REACHED_PERCENT;
}

/** The account the session runs on now, as the computer reported it. */
export function currentChoice(accounts: readonly SessionAccountChoice[]): SessionAccountChoice | undefined {
  return accounts.find((choice) => choice.current);
}

/** The id a choice is selected by: null for the default account. */
export function choiceId(choice: SessionAccountChoice): string | null {
  return choice.account_id ?? null;
}

/** A notice the sheet shows above the list, and how it is drawn. */
export interface AccountNotice {
  readonly tone: "done" | "waiting" | "error";
  readonly text: string;
}

/**
 * What the sheet says after an answer. A read says nothing: the list is the
 * answer. Every refusal code the computer can send is named here, so a new
 * code falls back to the computer's own sentence rather than to silence.
 */
export function outcomeNotice(answer: SessionAccountOutcome, target: string): AccountNotice | undefined {
  switch (answer.outcome) {
    case "listed":
      return undefined;
    case "switched":
      return { tone: "done", text: t("account.notice.switched", { account: target }) };
    case "scheduled":
      return { tone: "waiting", text: t("account.notice.scheduled", { account: target }) };
    case "in_progress":
      return { tone: "waiting", text: t("account.notice.inProgress") };
    case "refused":
      return { tone: "error", text: refusalText(answer.code, answer.detail) };
  }
}

const REFUSALS: Readonly<Record<string, string>> = {
  busy: "account.refused.busy",
  account_missing: "account.refused.accountMissing",
  already_current: "account.refused.alreadyCurrent",
  session_missing: "account.refused.sessionMissing",
  unsupported: "account.refused.unsupported",
  screen_unreachable: "account.refused.screenUnreachable",
  screen_silent: "account.refused.screenSilent",
};

export function refusalText(code: string | null, detail: string | null): string {
  const key = code ? REFUSALS[code] : undefined;
  if (key) return t(key);
  return detail?.trim() || t("account.refused.unknown");
}

/**
 * Whether pressing again after this answer is the same press.
 *
 * When the computer did not say what happened — the answer was lost, it
 * stopped watching, or it never answered — the switch may be running. A new
 * name would read as a second press and restart the session again.
 */
const UNKNOWN_OUTCOME_CODES = new Set(["screen_silent", "screen_unreachable", "still_switching"]);

export function retryKeepsPress(answer: SessionAccountOutcome | undefined): boolean {
  if (answer === undefined) return true;
  return answer.outcome === "in_progress" || (answer.code !== null && UNKNOWN_OUTCOME_CODES.has(answer.code));
}
