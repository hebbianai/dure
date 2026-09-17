import { ipc } from "./ipc";
import { type LocalNotification, type NotificationPermission, readNotificationPermission } from "./notificationPolicy";

/** The notification plugin, loaded only when a notice or the settings screen needs it — same reason as `cameraBridge`. */
async function notificationPlugin(): Promise<typeof import("@tauri-apps/plugin-notification")> {
  return import("@tauri-apps/plugin-notification");
}

/**
 * Whether the system allows notifications right now, read from the system.
 *
 * Not the plugin's `isPermissionGranted()`: that answers from a snapshot the
 * plugin's init script takes once at page load and refreshes only from its own
 * `requestPermission`, so an allowance made in the system settings while the
 * app was away would not reach the row — nor any notice — until the app was
 * killed. `ipc.notificationPermissionGranted` asks the OS every time. Rejects
 * when the plugin is missing, which callers read as refused.
 */
async function isNotificationPermissionGranted(): Promise<NotificationPermission> {
  return readNotificationPermission(await ipc.notificationPermissionGranted());
}

/**
 * Posts one local notification, if the system allows it right now. Never
 * throws and never surfaces a failure: a refused permission or a missing
 * plugin is not the runtime record's problem, and the screen will show the
 * same fact when the app comes back.
 */
export async function sendLocalNotification(notification: LocalNotification): Promise<void> {
  try {
    if ((await isNotificationPermissionGranted()) !== "granted") return;
    const plugin = await notificationPlugin();
    plugin.sendNotification({ title: notification.title, body: notification.body });
  } catch {
    return;
  }
}

/**
 * What the system has decided about notifications. `request` shows the
 * system sheet when it has not decided yet (and is the retry after a refusal
 * — the system answers a refused app at once, without a sheet); without it
 * this only reads. A throw — no plugin — reads as refused, which is what the
 * row should say.
 */
export async function notificationPermission(request: boolean): Promise<NotificationPermission> {
  try {
    const known = await isNotificationPermissionGranted();
    if (known === "granted" || !request) return known;
    const plugin = await notificationPlugin();
    return readNotificationPermission(await plugin.requestPermission());
  } catch {
    return "denied";
  }
}
