import { t } from "./i18n";
import type { NotificationPermission } from "./notificationPolicy";
import type { NotificationPreference } from "./settingsPreferences";

/** One paired computer's part of a sync (`HubPushOutcome`). `code` names
 * the reason when the phone or the computer could: a `PushRefusal` value, or
 * one of the phone's own `setup_pending`, `computer_unreachable` and
 * `computer_update`. `error` is the computer's own sentence. */
export interface PushSyncOutcome {
  id: string;
  computer?: string;
  error: string | null;
  code?: string;
}

export interface PushSyncResult {
  supported: boolean;
  outcomes: PushSyncOutcome[];
}

export type PushSyncState =
  | { kind: "syncing" | "registered" | "off" | "unsupported" | "unpaired" }
  | { kind: "error"; detail: string; code?: string; computer?: string };

interface DesiredPush {
  preference: NotificationPreference;
  language: "en" | "ko";
}

/** Coalesce changes while the OS and paired computers answer. A stale reply
 * never overwrites a newer choice or claims that an unacknowledged Off synced. */
export function createPushSync(options: {
  permission(): Promise<NotificationPermission>;
  synchronize(preference: "all" | "approvals" | null, language: "en" | "ko"): Promise<PushSyncResult>;
  changed(state: PushSyncState): void;
}) {
  let desired: DesiredPush | undefined;
  let running = false;
  let disposed = false;
  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (desired && !disposed) {
        const current = desired;
        desired = undefined;
        options.changed({ kind: "syncing" });
        try {
          const permission = current.preference === "off" ? "denied" : await options.permission();
          if (desired || disposed) continue;
          const preference = permission === "granted" && current.preference !== "off" ? current.preference : null;
          const result = await options.synchronize(preference, current.language);
          if (desired || disposed) continue;
          const failure = result.outcomes.find((outcome) => outcome.error);
          options.changed(!result.supported ? { kind: "unsupported" }
            : failure ? failed(failure)
            : preference === null ? { kind: "off" }
            : result.outcomes.length === 0 ? { kind: "unpaired" }
            : { kind: "registered" });
        } catch (error) {
          if (!desired && !disposed) options.changed({ kind: "error", detail:
            error instanceof Error ? error.message
              : typeof error === "object" && error !== null && "message" in error ? String(error.message)
                : String(error),
          });
        }
      }
    } finally { running = false; }
  }
  return {
    request(value: DesiredPush) { desired = value; void drain(); },
    dispose() { disposed = true; desired = undefined; },
  };
}

function failed(outcome: PushSyncOutcome): PushSyncState {
  return {
    kind: "error",
    detail: outcome.error ?? "",
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.computer ? { computer: outcome.computer } : {}),
  };
}

/** The note for each reason a computer's alerts are not ready. A reason
 * without one (`phone_update_required`, `other`, a later value) shows the
 * computer's own sentence. */
const REASON_NOTES: Record<string, string> = {
  setup_pending: "notifications.push.setupPending",
  computer_unreachable: "notifications.push.computerUnreachable",
  computer_update: "notifications.push.computerUpdate",
  grant_refused: "notifications.push.grantRefused",
  grant_superseded: "notifications.push.grantRefused",
  refused: "notifications.push.grantRefused",
  grant_expired: "notifications.push.grantExpired",
  rate_limited: "notifications.push.rateLimited",
  not_configured: "notifications.push.serviceUnavailable",
  service_unreachable: "notifications.push.serviceUnavailable",
  capacity: "notifications.push.serviceUnavailable",
  token_invalid: "notifications.push.serviceUnavailable",
  service_outdated: "notifications.push.serviceOutdated",
};

function failureNote(state: { detail: string; code?: string; computer?: string }): string {
  const note = state.code && state.computer ? REASON_NOTES[state.code] : undefined;
  return note ? t(note, { computer: state.computer ?? "" })
    : t("notifications.push.failed", { detail: state.detail });
}

function deliveryNote(state: PushSyncState | undefined): string {
  const description = t("notifications.push.description");
  if (!state) return description;
  switch (state.kind) {
    case "error": return `${description} ${failureNote(state)}`;
    case "syncing": return `${description} ${t("notifications.push.syncing")}`;
    case "registered": return `${description} ${t("notifications.push.registered")}`;
    case "unpaired": return `${description} ${t("notifications.push.noComputer")}`;
    case "off": return t("notifications.push.off");
    case "unsupported": return t("notifications.local.description");
  }
}

export function pushSyncNote(state: PushSyncState | undefined, permission?: NotificationPermission): string {
  const note = deliveryNote(state);
  return permission === "denied" ? `${note} ${t("notifications.permission.denied")}`
    : permission === "prompt" ? `${note} ${t("notifications.permission.prompt")}`
      : note;
}
