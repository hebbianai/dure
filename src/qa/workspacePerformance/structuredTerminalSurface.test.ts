import { expect, test, vi } from "vitest";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import { terminalWindowFocusProbeForSurface } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { createWorkspacePerformanceStructuredTerminalLease } from "./structuredTerminalSurface";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "qa-main" }),
}));

test("registers the structured probe under the exact pane attachment owner", () => {
	const desktopId = "qa-performance-1";
	const panelId = "term:hmux-1";
	const registerExpectedTerminal = vi.spyOn(
		workspacePerformance,
		"registerExpectedTerminal",
	);
	const lease = createWorkspacePerformanceStructuredTerminalLease({
		spaces: [{ id: desktopId, name: "QA 1" }],
		panelIdsByDesktop: { [desktopId]: [panelId] },
	});
	const surfaceId = hmuxPaneOwnerId("qa-main", desktopId, panelId);

	expect(terminalWindowFocusProbeForSurface(surfaceId)).toBe(
		lease.surface(panelId),
	);
	expect(terminalWindowFocusProbeForSurface(panelId)).toBeUndefined();
	expect(registerExpectedTerminal).toHaveBeenCalledWith(
		expect.objectContaining({ id: surfaceId }),
	);

	lease.dispose();
	registerExpectedTerminal.mockRestore();
});
