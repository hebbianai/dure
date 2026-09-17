import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubProbe, HubProbeSession } from "./ipc";

const native = vi.hoisted(() => ({
  hubList: vi.fn(),
  hubLayouts: vi.fn(),
  listServers: vi.fn(),
  takeSessionCensus: vi.fn(),
  hubOpen: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipc: native }));
vi.mock("@tauri-apps/plugin-biometric", () => ({
  checkStatus: () => Promise.resolve({ isAvailable: false }),
  authenticate: () => Promise.reject(new Error("unavailable")),
}));

import { startApp } from "./app";

const hub = { id: "qa-hub", box_label: "QA computer", endpoint: "qa", relay_offered: true };
function session(id: string, boxId = "local"): HubProbeSession {
  return {
    session_id: id, session_name: id, workspace_id: "qa-project", session_class: "standalone",
    lifecycle: "ready", provider_id: "codex", runner_principal: "qa", runner_instance: "qa",
    channel_epoch: "1", host_instance_id: id, terminal_epoch: "1", capabilities: [], ready: true,
    box_id: boxId, box_label: boxId, launch_program: null,
  };
}
function probe(sessions: HubProbeSession[]): HubProbe {
  return {
    ...hub, device_label: "QA phone", sessions, layout_note: null, direct_pairing: null,
    direct_pairing_error: null, unreachable: [],
    layout: {
      desktop_order: ["QA"],
      placements: Object.fromEntries(sessions.map((row, order) => [row.session_id,
        { desktop: "QA", project: "QA project", order }])),
    },
  };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
let root: HTMLElement;
let dispose: (() => void) | undefined;
function hidden(value: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true, value: value ? "hidden" : "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
async function launch(): Promise<void> {
  dispose = startApp(root);
  await settle();
}
function button(selector: string): HTMLButtonElement {
  const result = root.querySelector<HTMLButtonElement>(selector);
  if (!result) throw new Error(`Missing ${selector}: ${root.textContent}`);
  return result;
}
function holdHub(): (sessions?: HubProbeSession[]) => void {
  let release!: (value: HubProbe) => void;
  native.hubOpen.mockImplementationOnce(() => new Promise<HubProbe>((resolve) => { release = resolve; }));
  return (sessions = [session("existing"), session("desktop-created")]) => release(probe(sessions));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  native.hubList.mockResolvedValue([hub]);
  native.hubLayouts.mockResolvedValue({});
  native.listServers.mockResolvedValue({ version: 3, servers: [] });
  native.takeSessionCensus.mockResolvedValue([]);
  native.hubOpen.mockResolvedValue(probe([session("existing")]));
  root = document.createElement("div");
  document.body.replaceChildren(root);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  root.remove();
  vi.useRealTimers();
});

it("reflects working and waiting transitions within two seconds on visible Home", async () => {
  const entry = session("existing");
  native.hubOpen.mockResolvedValue(probe([{ ...entry, presentation: { displayState: "waiting" } }]));
  await launch();
  const row = () => button('[data-session-id="existing"]');
  expect(row().querySelector(".dure-loader")).toBeNull();
  native.hubOpen.mockResolvedValue(probe([{ ...entry, presentation: { displayState: "working" } }]));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(row().querySelector(".dure-loader")).not.toBeNull();
  native.hubOpen.mockResolvedValue(probe([{ ...entry, presentation: { displayState: "waiting" } }]));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(row().querySelector(".dure-loader")).toBeNull();
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(1);
});

it.each(["local", "ssh-tail"])("shows a desktop-created %s agent on visible Home without a gesture", async (box) => {
  await launch();
  expect(root.querySelectorAll(".list__open")).toHaveLength(1);
  native.hubOpen.mockResolvedValue(probe([session("existing"), session("desktop-created", box)]));

  await vi.advanceTimersByTimeAsync(2_000);

  expect(root.querySelectorAll(".list__open")).toHaveLength(2);
  expect(root.textContent).toContain("desktop-created");
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(1);
  expect(root.querySelector(".home__pull--busy")).toBeNull();
});

it("keeps unchanged Home nodes and focus, and preserves row identity when another row is inserted", async () => {
  await launch();
  const row = button(".list__open");
  row.focus();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(button(".list__open")).toBe(row);
  expect(document.activeElement).toBe(row);
  root.querySelector<HTMLElement>(".home__body")!.scrollTop = 240;
  const tabs = root.querySelector(".tabs");
  if (tabs) tabs.scrollLeft = 100;
  native.hubOpen.mockResolvedValue(probe([session("inserted-first"), session("existing")]));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(document.activeElement?.textContent).toContain("existing");
  expect(root.querySelectorAll(".list__open")).toHaveLength(2);
  expect(root.querySelector(".home__body")?.scrollTop).toBe(240);
  expect(root.querySelector(".tabs")?.scrollLeft).toBe(100);
});

it("pauses while hidden, caches an in-flight result without redrawing, and displays it on return", async () => {
  await launch();
  const release = holdHub();
  await vi.advanceTimersByTimeAsync(2_000);
  const row = button(".list__open");
  hidden(true);
  release();
  await settle();
  expect(button(".list__open")).toBe(row);
  expect(root.querySelectorAll(".list__open")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(2);
  hidden(false);
  expect(root.querySelectorAll(".list__open")).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(3);
});

it("does not refresh settings or replace its focused control when an earlier Home request completes", async () => {
  await launch();
  const release = holdHub();
  await vi.advanceTimersByTimeAsync(2_000);
  button(".home__settings").click();
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  const settings = root.querySelector(".settings");
  const focused = button("button");
  focused.focus();
  release();
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(root.querySelector(".settings")).toBe(settings);
  expect(document.activeElement).toBe(focused);
  expect(native.hubOpen).toHaveBeenCalledTimes(2);
});

it("preserves a typed SSH form, its caret and focus across an earlier automatic response", async () => {
  await launch();
  const release = holdHub();
  await vi.advanceTimersByTimeAsync(2_000);
  button(".fab").click();
  button(".add-sheet__row:nth-child(2)").click();
  const input = root.querySelector<HTMLInputElement>(".ssh-add__input");
  expect(input).not.toBeNull();
  if (!input) return;
  input.value = "typed-host.example";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(3, 8);
  release();
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  hidden(true);
  hidden(false);
  expect(root.querySelector(".ssh-add__input")).toBe(input);
  expect(input.value).toBe("typed-host.example");
  expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
  expect(document.activeElement).toBe(input);
  expect(native.hubOpen).toHaveBeenCalledTimes(2);
});

it("clears a queued full refresh in state without replacing the form the person navigated to", async () => {
  await launch();
  const release = holdHub();
  await vi.advanceTimersByTimeAsync(2_000);
  button(".home__refresh").click();
  button(".fab").click();
  button(".add-sheet__row:nth-child(2)").click();
  const input = root.querySelector<HTMLInputElement>(".ssh-add__input");
  expect(input).not.toBeNull();
  if (!input) return;
  input.value = "draft.example";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  release();
  await settle();
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(2);
  expect(root.querySelector(".ssh-add__input")).toBe(input);
  expect(document.activeElement).toBe(input);
  button(".ssh-add__bar button").click();
  expect(root.querySelector(".home__pull--busy")).toBeNull();
  expect(button(".home__refresh").disabled).toBe(false);
});

it("does not refresh while an Add sheet covers Home", async () => {
  await launch();
  button(".fab").click();
  const sheet = root.querySelector(".sheet--add");
  expect(sheet).not.toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(root.querySelector(".sheet--add")).toBe(sheet);
  expect(native.hubOpen).toHaveBeenCalledTimes(1);
});

it("keeps polling disabled offline rows and re-enables them after recovery", async () => {
  await launch();
  native.hubOpen.mockRejectedValue(new Error("offline"));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(button(".list__open").disabled).toBe(true);
  button(".list__open").click();
  expect(root.querySelector(".toast")).toBeNull();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(3);
  native.hubOpen.mockResolvedValue(probe([session("existing")]));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(button(".list__open").disabled).toBe(false);
});

it("stops startup after teardown instead of launching a census for a retired app", async () => {
  let release!: (rows: typeof hub[]) => void;
  native.hubList.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  dispose = startApp(root);
  dispose();
  release([hub]);
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(native.listServers).not.toHaveBeenCalled();
  expect(native.hubOpen).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("queues exactly one full manual census behind an automatic Hub-only read", async () => {
  await launch();
  const release = holdHub();
  await vi.advanceTimersByTimeAsync(2_000);
  button(".home__refresh").click();
  expect(root.querySelector(".home__pull--busy")).not.toBeNull();
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(2);
  release();
  await settle();
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(2);
  expect(native.hubOpen).toHaveBeenCalledTimes(3);
  expect(root.querySelector(".home__pull--busy")).toBeNull();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(native.hubOpen).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(native.hubOpen).toHaveBeenCalledTimes(4);
});

it("does not overlap automatic reads with an in-flight manual census", async () => {
  await launch();
  const release = holdHub();
  button(".home__refresh").click();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(2);
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(2);
  release();
  await settle();
  expect(root.querySelector(".home__pull--busy")).toBeNull();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(3);
});

it("suspends for pagehide and resumes for pageshow without a background poll", async () => {
  await launch();
  window.dispatchEvent(new Event("pagehide"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(2);
});

it("does not redraw a suspended page from an in-flight reply before pageshow", async () => {
  await launch();
  const release = holdHub();
  await vi.advanceTimersByTimeAsync(2_000);
  const before = root.innerHTML;
  window.dispatchEvent(new Event("pagehide"));
  release();
  await settle();
  expect(root.innerHTML).toBe(before);
  window.dispatchEvent(new Event("pageshow"));
  expect(root.querySelectorAll(".list__open")).toHaveLength(2);
});

it("tears down timers/listeners and ignores in-flight replies after disposal", async () => {
  await launch();
  const release = holdHub();
  await vi.advanceTimersByTimeAsync(2_000);
  const before = root.innerHTML;
  dispose?.();
  release();
  await settle();
  window.dispatchEvent(new Event("pageshow"));
  hidden(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(2);
  expect(root.innerHTML).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it("retires a replaced root so only the new app polls", async () => {
  await launch();
  const old = root;
  root = document.createElement("div");
  document.body.replaceChildren(root);
  await launch();
  const before = old.innerHTML;
  native.hubOpen.mockResolvedValue(probe([session("existing"), session("desktop-created")]));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(native.hubOpen).toHaveBeenCalledTimes(3);
  expect(root.querySelectorAll(".list__open")).toHaveLength(2);
  expect(old.innerHTML).toBe(before);
});
