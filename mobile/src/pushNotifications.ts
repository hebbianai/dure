import { t } from "./i18n";
import type { NotificationPermission } from "./notificationPolicy";
import type { NotificationPreference } from "./settingsPreferences";

export interface PushSyncResult {
  supported: boolean;
  outcomes: { id: string; error: string | null }[];
}

export type PushSyncState =
  | { kind: "syncing" | "registered" | "off" | "unsupported" | "unpaired" }
  | { kind: "error"; detail: string };

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
            : failure ? { kind: "error", detail: failure.error ?? "" }
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

function deliveryNote(state: PushSyncState | undefined): string {
  const description = t("notifications.push.description");
  if (!state) return description;
  switch (state.kind) {
    case "error": return `${description} ${t("notifications.push.failed", { detail: state.detail })}`;
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
