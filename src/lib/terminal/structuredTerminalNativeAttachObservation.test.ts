import { beforeEach, describe, expect, it, vi } from "vitest";
import { structuredTerminalAttachmentRetired } from "./structuredTerminalAttachPreparation";
import { attachStructuredTerminalRecords } from "./structuredTerminalRecordAdapter";
import { hmuxStandaloneBinding } from "./terminalBinding";

const mocks = vi.hoisted(() => ({
	attach: vi.fn(),
	next: vi.fn(),
	detach: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
	hmux: {
		attachStructuredTerminal: mocks.attach,
		nextStructuredTerminalRecord: mocks.next,
		detachStructuredTerminal: mocks.detach,
	},
}));
beforeEach(() => {
	vi.resetAllMocks();
});

const request = () => ({
	observerId: "observer",
	surfaceId: "surface",
	access: "writer" as const,
	binding: hmuxStandaloneBinding("session", "workspace"),
	sshHosts: [],
});

describe("native attach dispatch observation", () => {
	it("does not count a preparation that retires before native dispatch", async () => {
		const onNativeAttachStarted = vi.fn();
		await expect(
			attachStructuredTerminalRecords({
				...request(),
				onNativeAttachStarted,
				prepareAttach: async () =>
					structuredTerminalAttachmentRetired("generation_retired"),
			}),
		).rejects.toMatchObject({ code: "structured_terminal_attach_retired" });
		expect(onNativeAttachStarted).not.toHaveBeenCalled();
		expect(mocks.attach).not.toHaveBeenCalled();
	});

	it("does not count an attachment aborted during preparation", async () => {
		const abort = new AbortController();
		const onNativeAttachStarted = vi.fn();
		await expect(
			attachStructuredTerminalRecords({
				...request(),
				onNativeAttachStarted,
				signal: abort.signal,
				prepareAttach: async () => {
					abort.abort();
				},
			}),
		).rejects.toBeDefined();
		expect(onNativeAttachStarted).not.toHaveBeenCalled();
		expect(mocks.attach).not.toHaveBeenCalled();
	});

	it("counts a refused native call once and preserves its original cause", async () => {
		const cause = new Error("native refusal");
		const order: string[] = [];
		mocks.attach.mockImplementation(() => {
			order.push("native");
			return Promise.reject(cause);
		});
		await expect(
			attachStructuredTerminalRecords({
				...request(),
				prepareAttach: async () => {
					order.push("prepared");
				},
				onNativeAttachStarted: () => {
					order.push("dispatch");
				},
			}),
		).rejects.toBe(cause);
		expect(order).toEqual(["prepared", "dispatch", "native"]);
		expect(mocks.attach).toHaveBeenCalledOnce();
	});
});
