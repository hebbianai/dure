import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startApp } from "./app";
import { save } from "./keyTray";

const surface = vi.hoisted(() => ({
  sendText: vi.fn(), sendKey: vi.fn(), fit: vi.fn(), dispose: vi.fn(),
}));
vi.mock("./structuredTerminal", () => ({ mountStructuredTerminal: () => surface }));
vi.mock("@tauri-apps/plugin-haptics", () => ({ impactFeedback: vi.fn() }));
vi.mock("@tauri-apps/plugin-biometric", () => ({ checkStatus: async () => ({ isAvailable: false }) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    const session = {
      session_id: "qa-history", session_name: "QA history", workspace_id: "qa",
      session_class: "standalone", lifecycle: "ready", provider_id: "shell",
      runner_principal: "qa", runner_instance: "runner-qa", channel_epoch: "1",
      host_instance_id: "host-qa", terminal_epoch: "epoch-qa",
      capabilities: ["terminal_surface_v1"], ready: true,
    };
    switch (command) {
      case "list_servers": return { version: 3, servers: [] };
      case "hub_list": return [{ id: "qa-hub", box_label: "QA", endpoint: "127.0.0.1:1", relay_offered: true }];
      case "hub_layouts": return {};
      case "take_session_census": return [];
      case "hub_open": return {
        id: "qa-hub", box_label: "QA", device_label: "QA phone", relay_offered: true,
        layout: null, layout_note: null, direct_pairing: null, direct_pairing_error: null,
        sessions: [{ ...session, box_id: "qa-box", box_label: "QA", launch_program: null }],
        unreachable: [],
      };
      case "attach_hub_session": return {
        session_id: session.session_id, attestation: "relayed", role: "controller",
        granted_capabilities: ["terminal_surface_v1"], withheld_over_relay: [],
        terminal: { attachment_id: "attach-qa", terminal_epoch: "epoch-qa", through_output_seq: "1", state_revision: "1", initial_delivery_record_count: 1 },
      };
      case "detach_session": return null;
      case "plugin:notification|is_permission_granted": return false;
      case "device_identity_status": return { state: "not_provisioned", reason: "QA", planned_algorithm: "ecdsa-sha2-nistp256" };
      default: throw new Error(`Unexpected QA command: ${command}`);
    }
  },
}));

let dispose: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => dispose?.());

function pick<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

async function openTerminal(): Promise<void> {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  dispose = startApp(root);
  await vi.waitFor(() => expect(document.querySelector(".list__open")).not.toBeNull());
  pick<HTMLButtonElement>(".list__open").click();
  await vi.waitFor(() => expect(document.querySelector(".tray__box")).not.toBeNull());
}

function type(text: string): void {
  const box = pick<HTMLTextAreaElement>(".tray__box");
  box.value = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(): void {
  const field = pick(".tray__box");
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  field.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "insertLineBreak", bubbles: true, cancelable: true,
  }));
  pick<HTMLButtonElement>(".tray__toggle--history").click();
}

// Regression: QA606, found on Android 2026-09-09. The provider received /model
// while the phone offered model for replay. Evidence: dure-internal issue #606.
it("records printable tray input together with native keyboard input", async () => {
  await openTerminal();
  const slash = [...document.querySelectorAll<HTMLButtonElement>(".tray__key")]
    .find((button) => button.textContent === "/");
  expect(slash).toBeDefined();
  slash?.click();
  type("model");
  submit();
  expect(surface.sendText.mock.calls.map(([text]) => text)).toEqual(["/", "model"]);
  expect(surface.sendKey.mock.calls.map(([key]) => key.key)).toEqual(["Enter"]);
  expect(pick(".history-item__text").textContent).toBe("/model");
});

it("keeps the same attachment's history draft when a drawer is opened and closed", async () => {
  await openTerminal();
  type("git ");
  pick<HTMLButtonElement>(".tray__toggle--history").click();
  pick<HTMLButtonElement>(".tray__toggle--history").click();
  type("status");
  submit();
  expect(surface.sendText.mock.calls.map(([text]) => text)).toEqual(["git ", "status"]);
  expect(pick(".history-item__text").textContent).toBe("git status");
});

it("records Enter chips once and applies Backspace chips to printable input", async () => {
  save({ id: "qa", name: "QA", keyIds: ["slash", "backspace", "enter"] });
  await openTerminal();
  const chip = (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".tray__key")]
      .find((entry) => entry.textContent === label);
    if (!button) throw new Error(`Missing chip ${label}`);
    button.click();
  };
  chip("/");
  expect(pick(".tray__row").classList.contains("tray__row--sending")).toBe(true);
  type("model😀");
  chip("⌫");
  chip("↵");
  expect(pick(".tray__row").classList.contains("tray__row--sending")).toBe(false);
  pick<HTMLButtonElement>(".tray__toggle--history").click();
  expect(pick(".history-item__text").textContent).toBe("/model");
  expect(surface.sendKey.mock.calls.map(([key]) => key.key)).toEqual(["Backspace", "Enter"]);
  pick<HTMLButtonElement>(".history-item").click();
  expect(surface.sendText.mock.calls.map(([text]) => text)).toEqual(["/", "model😀", "/model"]);
  expect(surface.sendKey.mock.calls.map(([key]) => key.key)).toEqual(["Backspace", "Enter", "Enter"]);
  expect(JSON.parse(localStorage.getItem("hebbian.commands.v1") ?? "[]")).toHaveLength(1);
});

it("does not carry an unsent history draft into a different attachment", async () => {
  await openTerminal();
  type("old ");
  pick<HTMLButtonElement>(".session__header button").click();
  await vi.waitFor(() => expect(document.querySelector(".list__open")).not.toBeNull());
  pick<HTMLButtonElement>(".list__open").click();
  await vi.waitFor(() => expect(document.querySelector(".tray__box")).not.toBeNull());
  type("new");
  submit();
  expect(pick(".history-item__text").textContent).toBe("new");
});
