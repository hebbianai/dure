/** Actual mobile app with disposable IPC fixtures; no camera, pairing or network operations. */
import "../src/styles.css";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startApp } from "../src/app";
import { DEFAULT_SETTINGS_PREFERENCES, saveSettingsPreferences } from "../src/settingsPreferences";

saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language: "en", notifications: "off" });
mockIPC((command) => {
  switch (command) {
    case "list_servers": return { version: 3, servers: [] };
    case "hub_list": case "take_session_census": return [];
    case "hub_layouts": return {};
    case "sync_push_notifications": return { supported: false, outcomes: [] };
    case "pairing_flow_for": return "online";
    case "pair_from_scan": throw { code: "pairing_not_a_code", message: "Invalid pairing code" };
    case "plugin:barcode-scanner|check_permissions": return { camera: "granted" };
    case "plugin:barcode-scanner|scan": throw { message: "Camera unavailable in QA", code: "camera_unavailable" };
    case "plugin:barcode-scanner|cancel": return;
    default: throw new Error(`Unexpected fixture command: ${command}`);
  }
});
startApp(document.querySelector<HTMLElement>("#app")!);
