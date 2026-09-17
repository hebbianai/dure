import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startApp } from "./app";

const native = vi.hoisted(() => ({
	handler: undefined as (() => void) | undefined,
	detach: vi.fn(),
	reset: vi.fn(),
}));
vi.mock("./structuredTerminal", () => ({
	mountStructuredTerminal: () => ({
		sendText: vi.fn(),
		sendKey: vi.fn(),
		fit: vi.fn(),
		dispose: vi.fn(),
	}),
}));
vi.mock("@tauri-apps/api/app", () => ({
	onBackButtonPress: async (handler: () => void) => {
		native.handler = handler;
		return {
			unregister: async () => {
				native.handler = undefined;
			},
		};
	},
}));
vi.mock("@tauri-apps/plugin-haptics", () => ({ impactFeedback: vi.fn() }));
vi.mock("@tauri-apps/plugin-biometric", () => ({
	checkStatus: async () => ({ isAvailable: false }),
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (command: string) => {
		const session = {
			session_id: "qa-back",
			session_name: "QA back",
			workspace_id: "qa",
			session_class: "standalone",
			lifecycle: "ready",
			provider_id: "shell",
			runner_principal: "qa",
			runner_instance: "runner-qa",
			channel_epoch: "1",
			host_instance_id: "host-qa",
			terminal_epoch: "epoch-qa",
			capabilities: ["terminal_surface_v1"],
			ready: true,
		};
		switch (command) {
			case "list_servers":
				return { version: 3, servers: [] };
			case "hub_list":
				return [
					{
						id: "qa-hub",
						box_label: "QA",
						endpoint: "127.0.0.1:1",
						relay_offered: true,
					},
				];
			case "hub_layouts":
				return {};
			case "take_session_census":
				return [];
			case "hub_open":
				return {
					id: "qa-hub",
					box_label: "QA",
					sessions: [{ ...session, box_id: "qa-box", box_label: "QA" }],
					unreachable: [],
				};
			case "attach_hub_session":
				return {
					session_id: session.session_id,
					attestation: "relayed",
					role: "controller",
					granted_capabilities: ["terminal_surface_v1"],
					withheld_over_relay: [],
					terminal: {
						attachment_id: "attach-qa",
						terminal_epoch: "epoch-qa",
						through_output_seq: "1",
						state_revision: "1",
						initial_delivery_record_count: 1,
					},
				};
			case "detach_session":
				return native.detach();
			case "reset_device":
				return native.reset();
			case "plugin:notification|is_permission_granted":
				return false;
			case "device_identity_status":
				return {
					state: "not_provisioned",
					reason: "QA",
					planned_algorithm: "ecdsa-sha2-nistp256",
				};
			default:
				throw new Error(`Unexpected QA command: ${command}`);
		}
	},
}));

let dispose: (() => void) | undefined;
beforeEach(() => {
	localStorage.clear();
	native.handler = undefined;
	native.detach.mockReset();
	native.reset.mockReset();
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
});
afterEach(async () => {
	dispose?.();
	await vi.waitFor(() => expect(native.handler).toBeUndefined());
	vi.restoreAllMocks();
});

function click(selector: string): void {
	const button = document.querySelector<HTMLButtonElement>(selector);
	if (!button) throw new Error(`Missing ${selector}`);
	button.click();
}

async function openSettings(): Promise<void> {
	const root = document.createElement("div");
	document.body.replaceChildren(root);
	dispose = startApp(root);
	await vi.waitFor(() =>
		expect(document.querySelector(".home__settings")).not.toBeNull(),
	);
	click(".home__settings");
	expect(document.querySelector(".settings__body")).not.toBeNull();
}

// QA606: system Back exited the real Android activity from Settings, with IME closed.
it("uses the existing Settings back action and restores native root behavior", async () => {
	await openSettings();
	// No native listener means Android exits the activity instead of navigating.
	await vi.waitFor(() => expect(native.handler).toBeTypeOf("function"));
	native.handler?.();
	expect(document.querySelector(".settings__body")).toBeNull();
	expect(document.querySelector(".home__settings")).not.toBeNull();
	await vi.waitFor(() => expect(native.handler).toBeUndefined());
});

it("cancels a destructive confirmation before leaving Settings", async () => {
	await openSettings();
	click('[data-row="reset"]');
	await vi.waitFor(() => expect(native.handler).toBeTypeOf("function"));
	expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
	native.handler?.();
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();
	expect(document.querySelector(".settings__body")).not.toBeNull();
	expect(native.reset).not.toHaveBeenCalled();
});

it.each([
	"language",
	"notifications",
	"font-size",
	"scroll",
	"computers",
	"hosts",
	"key-strip",
])("returns from %s to Settings before Home", async (row) => {
	await openSettings();
	click(`[data-row="${row}"]`);
	await vi.waitFor(() => expect(native.handler).toBeTypeOf("function"));
	expect(document.querySelector(".settings__body")).toBeNull();
	native.handler?.();
	expect(document.querySelector(".settings__body")).not.toBeNull();
	native.handler?.();
	expect(document.querySelector(".home__settings")).not.toBeNull();
});

it("does not escape a device reset while its operation is pending", async () => {
	let finish: (() => void) | undefined;
	native.reset.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	await openSettings();
	click('[data-row="reset"]');
	click(".confirm-dialog__button--confirm");
	await vi.waitFor(() => expect(native.handler).toBeTypeOf("function"));
	native.handler?.();
	expect(
		document.querySelector('[role="alertdialog"][aria-busy="true"]'),
	).not.toBeNull();
	expect(native.reset).toHaveBeenCalledOnce();
	finish?.();
	await vi.waitFor(() =>
		expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
	);
});

it("closes the terminal drawer first, then uses the existing attachment detach", async () => {
	await openSettings();
	click(".settings__bar button");
	await vi.waitFor(() =>
		expect(document.querySelector(".list__open")).not.toBeNull(),
	);
	click(".list__open");
	await vi.waitFor(() =>
		expect(document.querySelector(".tray__box")).not.toBeNull(),
	);
	click(".tray__toggle--history");
	await vi.waitFor(() => expect(native.handler).toBeTypeOf("function"));
	native.handler?.();
	expect(document.querySelector(".tray__panel")).toBeNull();
	expect(document.querySelector(".tray__box")).not.toBeNull();
	expect(native.detach).not.toHaveBeenCalled();
	native.handler?.();
	await vi.waitFor(() =>
		expect(document.querySelector(".home__settings")).not.toBeNull(),
	);
	expect(native.detach).toHaveBeenCalledOnce();
});
