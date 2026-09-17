/**
 * When a change in the attached agent's runtime state is worth a local
 * notification, and what it says.
 *
 * The screen is the authority while the app is visible: the transcript and
 * the attention chip already show an approval or a finished turn, so a
 * notification then would be the same fact twice. Only while the app is
 * hidden does the phone have no other way to say "the agent wants you".
 *
 * Honest limit, carried into the settings copy: these are local
 * notifications sent by the running app, not push. iOS suspends the WebView a
 * few seconds after it leaves the screen, so a change that arrives later is
 * only seen when the app is opened again.
 */

import { type AgentRuntimeState, approvalIdentity } from "./agentRuntimeState";
import { t } from "./i18n";
import type { NotificationPreference } from "./settingsPreferences";

export interface LocalNotification {
  readonly title: string;
  readonly body: string;
}

export interface NotificationContext {
  readonly preference: NotificationPreference;
  /** The state before this one — none for the seed record of an attach. */
  readonly previous: AgentRuntimeState | undefined;
  readonly next: AgentRuntimeState;
  /** `document.visibilityState === "hidden"` at the moment the record arrived. */
  readonly hidden: boolean;
  /** The session's title, so a phone with several open sessions knows which one wants it. */
  readonly session: string;
}

/**
 * Null when nothing should be sent. At most one notice per record: an
 * approval outranks the finished turn it usually arrives with.
 *
 * The seed record — the first after an attach — never notifies: it describes
 * the state the person just attached to, not something that happened while
 * they were away.
 */
export function decideNotification(context: NotificationContext): LocalNotification | null {
  const { preference, previous, next, hidden, session } = context;
  if (preference === "off" || !hidden || previous === undefined) return null;

  if (
    next.attention === "approval_required" &&
    approvalIdentity(next) !== approvalIdentity(previous)
  ) {
    return {
      title: t("승인 필요"),
      body: t("{session} 세션이 승인을 기다립니다", { session }),
    };
  }
  if (preference !== "all") return null;

  if (next.attention !== "approval_required" && turnEnded(previous, next)) {
    return {
      title: t("작업 완료"),
      body:
        next.attention === "input_required"
          ? t("{session} 세션의 에이전트가 입력을 기다립니다", { session })
          : t("{session} 세션의 에이전트가 턴을 마쳤습니다", { session }),
    };
  }
  return null;
}

/**
 * The Host's turn counter is the one authority: a turn can end without the
 * activity crossing working→waiting (an approval answered elsewhere, then the
 * agent finishing), and the counter is always known — absent on the wire
 * means zero, which the parser fills in.
 */
function turnEnded(previous: AgentRuntimeState, next: AgentRuntimeState): boolean {
  return previous.turnCompletedCount !== next.turnCompletedCount;
}

/**
 * What the system has decided about this app's notifications. `prompt` is
 * "never asked": the sheet has not been shown, so choosing 모두 or 승인만 is
 * what shows it.
 */
export type NotificationPermission = "granted" | "denied" | "prompt";

/**
 * Parses the plugin's answers once. `isPermissionGranted()` is typed as a
 * boolean but resolves `null` while the system has not been asked;
 * `requestPermission()` answers the web strings, `"default"` for not asked.
 * Anything unrecognised is treated as not asked, never as granted.
 */
export function readNotificationPermission(answer: unknown): NotificationPermission {
  if (answer === true || answer === "granted") return "granted";
  if (answer === false || answer === "denied") return "denied";
  return "prompt";
}

export interface NotificationObserverOptions {
  /** Read on every record — the preference can change while a session is open. */
  readonly preference: () => NotificationPreference;
  /** Read on every record — whether the app is off screen right now. */
  readonly hidden: () => boolean;
  readonly session: string;
  readonly notify: (notification: LocalNotification) => void;
}

export interface NotificationObserver {
  /** The agent's latest runtime state, as the relay sent it. */
  observe(state: AgentRuntimeState): void;
}

/**
 * One per attachment, beside the approval gate: it keeps only the last state
 * it saw, which is exactly what "what changed" needs.
 */
export function createNotificationObserver(
  options: NotificationObserverOptions,
): NotificationObserver {
  let previous: AgentRuntimeState | undefined;
  return {
    observe(next) {
      const notification = decideNotification({
        preference: options.preference(),
        previous,
        next,
        hidden: options.hidden(),
        session: options.session,
      });
      previous = next;
      if (notification) options.notify(notification);
    },
  };
}
