import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriWindows = vi.hoisted(() => ({
	getAllWebviewWindows: vi.fn(),
	getCurrentWebviewWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => tauriWindows);
vi.mock("@/lib/ipc", () => ({
	hmux: { paneAttachmentStatus: vi.fn() },
}));

import { cliHmuxPaneActivationDependencies } from "@/lib/cli/cliHmuxPaneActivationRuntime";

describe("CLI Hmux pane activation runtime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tauriWindows.getCurrentWebviewWindow.mockReturnValue({ label: "main" });
	});

	it("returns live workspace windows with the claimant first", async () => {
		tauriWindows.getAllWebviewWindows.mockResolvedValue([
			{ label: "main" },
			{ label: "win-1788099326856-0" },
			{ label: "win-diff-agent-a" },
			{ label: "win-source-control" },
		]);

		await expect(
			cliHmuxPaneActivationDependencies.windowLabels(),
		).resolves.toEqual(["main", "win-1788099326856-0"]);
	});

	it("does not hide a failed native window census as a main-only result", async () => {
		tauriWindows.getAllWebviewWindows.mockRejectedValue(
			new Error("window census unavailable"),
		);

		await expect(
			cliHmuxPaneActivationDependencies.windowLabels(),
		).rejects.toThrow("window census unavailable");
	});
});
