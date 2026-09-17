import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telemetrySetChoice, telemetryState, track } from "@/lib/ipc/telemetry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(undefined);
});

describe("track", () => {
	it("offers the tagged event shape the native type deserialises", () => {
		track("pane_hidden");
		track("message_sent", { provider: "codex" });
		expect(invokeMock).toHaveBeenNthCalledWith(1, "telemetry_track", {
			event: { event: "pane_hidden" },
		});
		expect(invokeMock).toHaveBeenNthCalledWith(2, "telemetry_track", {
			event: { event: "message_sent", properties: { provider: "codex" } },
		});
	});

	it("never rejects, whatever the native side answers", async () => {
		invokeMock.mockRejectedValueOnce(new Error("not a tauri webview"));
		expect(() => track("pane_restored")).not.toThrow();
		await Promise.resolve();
		expect(invokeMock).toHaveBeenCalledWith("telemetry_track", {
			event: { event: "pane_restored" },
		});
	});
});

describe("state and choice", () => {
	it("resolves with whatever invoke resolves", async () => {
		const pending = { effective: "pending", choice: null };
		invokeMock.mockResolvedValueOnce(pending);
		await expect(telemetryState()).resolves.toEqual(pending);
		expect(invokeMock).toHaveBeenCalledWith("telemetry_state");

		const enabled = { effective: "enabled", choice: "accepted" };
		invokeMock.mockResolvedValueOnce(enabled);
		await expect(telemetrySetChoice("accepted")).resolves.toEqual(enabled);
		expect(invokeMock).toHaveBeenCalledWith("telemetry_set_choice", {
			choice: "accepted",
		});
	});
});
