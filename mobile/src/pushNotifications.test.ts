import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "./i18n";
import { en } from "./locales/en";
import { ko } from "./locales/ko";
import { createPushSync, pushSyncNote } from "./pushNotifications";
import { DEFAULT_SETTINGS_PREFERENCES, saveSettingsPreferences } from "./settingsPreferences";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("push registration lifetime", () => {
  it("registers without any mounted terminal attachment", async () => {
    const changed = vi.fn();
    const synchronize = vi.fn(async () => ({ supported: true, outcomes: [{ id: "computer", error: null }] }));
    const sync = createPushSync({ permission: async () => "granted", synchronize, changed });
    sync.request({ preference: "all", language: "ko" });
    await tick();
    expect(synchronize).toHaveBeenCalledWith("all", "ko");
    expect(changed).toHaveBeenLastCalledWith({ kind: "registered" });
    sync.dispose();
  });

  it("does not report an old registration as ready after choosing Off", async () => {
    let complete: ((result: { supported: boolean; outcomes: { id: string; error: null }[] }) => void) | undefined;
    const changed = vi.fn();
    const synchronize = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValue({ supported: true, outcomes: [{ id: "computer", error: null }] });
    const sync = createPushSync({ permission: async () => "granted", synchronize, changed });
    sync.request({ preference: "all", language: "en" });
    await tick();
    sync.request({ preference: "off", language: "ko" });
    complete?.({ supported: true, outcomes: [{ id: "computer", error: null }] });
    await tick();
    expect(synchronize).toHaveBeenLastCalledWith(null, "ko");
    expect(changed).not.toHaveBeenCalledWith({ kind: "registered" });
    expect(changed).toHaveBeenLastCalledWith({ kind: "off" });
  });

  it("shows failed Off synchronization instead of claiming delivery stopped", async () => {
    const changed = vi.fn();
    const sync = createPushSync({ permission: async () => "granted", changed,
      synchronize: async () => ({ supported: true, outcomes: [{ id: "computer", error: "Computer offline" }] }),
    });
    sync.request({ preference: "off", language: "en" });
    await tick();
    expect(changed).toHaveBeenLastCalledWith({ kind: "error", detail: "Computer offline" });
  });

  it("clears stale remote consent when OS permission is denied", async () => {
    const synchronize = vi.fn(async () => ({ supported: true, outcomes: [{ id: "computer", error: null }] }));
    const sync = createPushSync({ permission: async () => "denied", synchronize, changed: vi.fn() });
    sync.request({ preference: "approvals", language: "en" });
    await tick();
    expect(synchronize).toHaveBeenCalledWith(null, "en");
  });

  it("does not publish a late result after the app is disposed", async () => {
    let complete: (() => void) | undefined;
    const changed = vi.fn();
    const sync = createPushSync({ permission: async () => "granted", changed,
      synchronize: () => new Promise((resolve) => { complete = () => resolve({ supported: true, outcomes: [] }); }),
    });
    sync.request({ preference: "all", language: "en" });
    await tick();
    sync.dispose();
    changed.mockClear();
    complete?.();
    await tick();
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("why a computer's alerts are not ready", () => {
  beforeEach(() => localStorage.clear());

  it("reports the first failing computer with its code and name", async () => {
    const changed = vi.fn();
    const sync = createPushSync({ permission: async () => "granted", changed,
      synchronize: async () => ({ supported: true, outcomes: [
        { id: "desk", computer: "Desk", error: null },
        { id: "laptop", computer: "Laptop", error: "The grant has expired", code: "grant_expired" },
        { id: "studio", computer: "Studio", error: "Offline", code: "computer_unreachable" },
      ] }),
    });
    sync.request({ preference: "all", language: "en" });
    await tick();
    expect(changed).toHaveBeenLastCalledWith({
      kind: "error", detail: "The grant has expired", code: "grant_expired", computer: "Laptop",
    });
    sync.dispose();
  });

  it.each(["en", "ko"] as const)("names the computer in a localized note (%s)", (language) => {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language });
    const description = t("notifications.push.description");
    const note = (code: string) =>
      pushSyncNote({ kind: "error", detail: "the computer's sentence", code, computer: "Laptop" });
    for (const [code, key] of [
      ["setup_pending", "notifications.push.setupPending"],
      ["computer_unreachable", "notifications.push.computerUnreachable"],
      ["computer_update", "notifications.push.computerUpdate"],
      ["grant_refused", "notifications.push.grantRefused"],
      ["grant_expired", "notifications.push.grantExpired"],
      ["rate_limited", "notifications.push.rateLimited"],
      ["service_unreachable", "notifications.push.serviceUnavailable"],
      ["service_outdated", "notifications.push.serviceOutdated"],
    ] as const) {
      expect(note(code)).toBe(`${description} ${t(key, { computer: "Laptop" })}`);
      expect(note(code)).toContain("Laptop");
      expect(note(code)).not.toContain("the computer's sentence");
    }
    // A reason without a note of its own shows the computer's sentence.
    for (const code of ["phone_update_required", "other", "phone_on_fire"]) {
      expect(note(code)).toBe(
        `${description} ${t("notifications.push.failed", { detail: "the computer's sentence" })}`);
    }
    expect(pushSyncNote({ kind: "error", detail: "Offline" })).toContain("Offline");
  });

  it("has every note in English and Korean, with the computer's name", () => {
    for (const key of [
      "notifications.push.setupPending",
      "notifications.push.computerUnreachable",
      "notifications.push.computerUpdate",
      "notifications.push.grantRefused",
      "notifications.push.grantExpired",
      "notifications.push.rateLimited",
      "notifications.push.serviceUnavailable",
      "notifications.push.serviceOutdated",
    ]) {
      expect(en[key]).toContain("{computer}");
      expect(ko[key]).toContain("{computer}");
    }
    expect(en["notifications.push.grantExpired"]).toMatch(/date and time/);
  });
});
