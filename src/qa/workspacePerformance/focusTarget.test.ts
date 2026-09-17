import { describe, expect, test, vi } from "vitest";
import {
	confirmSingleDesktopActivationIntent,
	focusWorkspacePerformanceTarget,
} from "./focusTarget";

describe("workspace performance focus target", () => {
	test("retries native focus until the document and requested pane agree", async () => {
		let attempts = 0;
		let activePanel: string | undefined;
		const activatePanel = vi.fn(() => {
			activePanel = "term:target";
		});
		const requestWindowFocus = vi.fn(async () => {
			attempts += 1;
		});

		await focusWorkspacePerformanceTarget(
			{ panelId: "term:target", timeoutMs: 100, retryMs: 0 },
			{
				activatePanel,
				requestWindowFocus,
				hasDocumentFocus: () => attempts >= 2,
				activePanelId: () => activePanel,
				wait: async () => {},
			},
		);

		expect(requestWindowFocus).toHaveBeenCalledTimes(2);
		expect(activatePanel).toHaveBeenCalledTimes(2);
	});

	test("fails closed instead of recording an unfocused paint run", async () => {
		await expect(
			focusWorkspacePerformanceTarget(
				{ panelId: "term:target", timeoutMs: 0 },
				{
					activatePanel: () => {},
					requestWindowFocus: async () => {},
					hasDocumentFocus: () => false,
					activePanelId: () => "term:other",
					wait: async () => {},
				},
			),
		).rejects.toThrow(
			"documentFocused=false activePanel=term:other expectedPanel=term:target",
		);
	});

	test("dispatches one desktop activation while the workspace commits", async () => {
		let polls = 0;
		const dispatchDesktopActivation = vi.fn();
		await confirmSingleDesktopActivationIntent(
			"desktop-b",
			{
				dispatchDesktopActivation,
				activeSpaceId: () => {
					polls += 1;
					return polls >= 3 ? "desktop-b" : "desktop-a";
				},
				wait: async () => {},
			},
			{ timeoutMs: 100, pollMs: 0 },
		);

		expect(dispatchDesktopActivation).toHaveBeenCalledOnce();
	});
});
