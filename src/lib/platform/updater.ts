import { check } from "@tauri-apps/plugin-updater";
import { AppUpdateSession } from "@/lib/platform/appUpdateSession";
import { createValueStore } from "@/lib/state/broadcast";
import { worktreeReleaseProfile } from "@/lib/platform/worktreeReleaseProfile";
import {
  clearMaintenanceLaneInterval,
  setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import {
  clearUpdateNotice,
  updateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

export const APP_UPDATE_SOURCE_REF = "dure.app";

type AppUpdateCheckStatus = "idle" | "checking" | "current" | "available" | "error" | "unsupported";
const status = createValueStore<AppUpdateCheckStatus>("idle");
export const appUpdateCheckSnapshot = status.get;
export const subscribeAppUpdateChecks = status.subscribe;
let inFlight: Promise<AppUpdateCheckStatus> | undefined;
let session: AppUpdateSession | undefined;
let actionGeneration = 0;

/** Manual and scheduled checks share one request and result. Only the notice
 * action owns installation; stopping a schedule does not discard an active check. */
export function checkForAppUpdates(): Promise<AppUpdateCheckStatus> {
  if (worktreeReleaseProfile()) {
    status.set("unsupported");
    return Promise.resolve("unsupported");
  }
  if (inFlight) return inFlight;
  if (session?.blocksChecks && updateNoticeSnapshot().notices.some((notice) => notice.sourceRef === APP_UPDATE_SOURCE_REF)) return Promise.resolve("available");
  const checkedActionGeneration = actionGeneration;
  // Register the request before notifying subscribers, including reentrant callers.
  inFlight = Promise.resolve().then(async (): Promise<AppUpdateCheckStatus> => {
    try {
      const update = await check();
      // An action started after this check owns its running or failed notice,
      // even if it has already settled. Release the superseded check resource.
      if (actionGeneration !== checkedActionGeneration) {
        await update?.close();
        return "available";
      }
      if (update && session?.revision === JSON.stringify([update.currentVersion, update.version]) && updateNoticeSnapshot().notices.some((notice) => notice.sourceRef === APP_UPDATE_SOURCE_REF)) {
        await update.close();
        return "available";
      }
      const previous = session;
      // Transfer the visible action synchronously before retiring native resources.
      // No click may start a download on the resource whose close() is pending.
      if (update) {
        session = new AppUpdateSession(APP_UPDATE_SOURCE_REF, update, () => { actionGeneration += 1; status.set("available"); });
        session.publish();
      } else {
        session = undefined;
        clearUpdateNotice(APP_UPDATE_SOURCE_REF);
      }
      try { await previous?.close(); } catch (error) { console.warn("[updater] failed to release superseded resource", error); }
      return update ? "available" : "current";
    } catch {
      return actionGeneration !== checkedActionGeneration ? "available" : "error";
    }
  }).then((result) => {
    inFlight = undefined;
    status.set(result);
    return result;
  });
  status.set("checking");
  return inFlight;
}

/** Check once after startup and hourly thereafter using the shared authority. */
export function startUpdateChecks(): () => void {
  if (worktreeReleaseProfile()) return () => {};
  let disposed = false;
  const checkOnce = () => {
    if (!disposed) void checkForAppUpdates();
  };
  const initial = setTimeout(() => void checkOnce(), 30_000);
  const interval = setMaintenanceLaneInterval(
    () => void checkOnce(),
    60 * 60 * 1000,
    "app-update-check",
  );
  return () => {
    disposed = true;
    clearTimeout(initial);
    clearMaintenanceLaneInterval(interval);
  };
}
