import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, storeState } = vi.hoisted(() => ({
	invoke: vi.fn(),
	storeState: { sound: "Ping" },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/store", () => ({
	DEFAULT_NOTIFY_PREFS: { sound: "__system__" },
	useStore: {
		getState: () => ({ notifyPrefs: { sound: storeState.sound } }),
	},
}));

import { systemNotify } from "./notify";

describe("systemNotify", () => {
	beforeEach(() => {
		invoke.mockReset();
		storeState.sound = "Ping";
	});

	it("returns the native Dure dispatch receipt instead of hiding delivery failures", async () => {
		invoke.mockResolvedValue({
			accepted: true,
			authorization: "authorized",
			sender: "dure-app",
		});

		await expect(
			systemNotify("Codex", "입력을 기다리고 있어요"),
		).resolves.toEqual({
			accepted: true,
			authorization: "authorized",
			sender: "dure-app",
		});
		expect(invoke).toHaveBeenCalledWith("notification_dispatch", {
			title: "Codex",
			body: "입력을 기다리고 있어요",
			sound: "Ping",
		});
	});

	it.each(["", "__system__"])(
		"maps legacy/system preference %j to the native default sound",
		async (sound) => {
			storeState.sound = sound;
			invoke.mockResolvedValue({ accepted: true });

			await systemNotify("Claude", "완료");

			expect(invoke).toHaveBeenCalledWith("notification_dispatch", {
				title: "Claude",
				body: "완료",
				sound: "__dure_system_default__",
			});
		},
	);

	it("sends null only for the explicit no-sound preference", async () => {
		storeState.sound = "__none__";
		invoke.mockResolvedValue({ accepted: true });

		await systemNotify("Claude", "완료");

		expect(invoke).toHaveBeenCalledWith("notification_dispatch", {
			title: "Claude",
			body: "완료",
			sound: null,
		});
	});

	it("forwards the stable Host event id for native exactly-once delivery", async () => {
		invoke.mockResolvedValue({ accepted: true });

		await systemNotify("Codex", "두 번째 완료", {
			eventId: "hmux:session:epoch:turn:8",
		});

		expect(invoke).toHaveBeenCalledWith("notification_dispatch", {
			title: "Codex",
			body: "두 번째 완료",
			sound: "Ping",
			eventId: "hmux:session:epoch:turn:8",
		});
	});

	it("preserves the exact pane target for notification click activation", async () => {
		invoke.mockResolvedValue({ accepted: true });

		await systemNotify("Codex", "완료", {
			eventId: "hmux:session:epoch:turn:9",
			paneTarget: { desktopId: "desktop-b", panelId: "agent:codex" },
		});

		expect(invoke).toHaveBeenCalledWith("notification_dispatch", {
			title: "Codex",
			body: "완료",
			sound: "Ping",
			eventId: "hmux:session:epoch:turn:9",
			paneTarget: { desktopId: "desktop-b", panelId: "agent:codex" },
		});
	});
});
