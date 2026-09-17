// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dropPosition: vi.fn(),
	launchDiscovered: vi.fn(),
	message: vi.fn(),
	movePanelsToDesktop: vi.fn(),
	openAgentPanel: vi.fn(),
	openFileViewer: vi.fn(),
	openLocalTerminalPanel: vi.fn(),
	openSshTerminalPanel: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));

vi.mock("@/lib/workspace/dock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock")>()),
	movePanelsToDesktop: mocks.movePanelsToDesktop,
	openAgentPanel: mocks.openAgentPanel,
	openAgentPanelOnDesktop: vi.fn(),
	openLocalTerminalPanel: mocks.openLocalTerminalPanel,
	openSshTerminalPanel: mocks.openSshTerminalPanel,
}));
vi.mock("@/lib/workspace/pane/panePlacement", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/pane/panePlacement")
	>()),
	dropPosition: mocks.dropPosition,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	mountedDockviewEntries: () => [],
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/panelFocusHandoff")
	>()),
	navigateToPanel: vi.fn(),
}));
vi.mock("@/lib/files/fileViewerPane", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/files/fileViewerPane")>()),
	openFileViewer: mocks.openFileViewer,
}));
vi.mock("@/lib/sessions/launch/discoveredConversationLaunch", () => ({
	launchDiscoveredLocalConversationPane: mocks.launchDiscovered,
}));
vi.mock("@/lib/workspace/pane/paneWindowTransferRuntime", () => ({
	handlePaneWindowDataDrop: () => false,
}));

import { encodeDureDragPayload } from "@/lib/platform/productDragPayload";
import { handleSidebarDrop } from "@/lib/sidebar/sidebarDropHandler";

function dropEvent(payload: unknown) {
	return {
		position: "right",
		group: { id: "group-target" },
		nativeEvent: {
			clientX: 420,
			clientY: 240,
			dataTransfer: {
				getData: (mime: string) =>
					mime === "text/plain" ? encodeDureDragPayload(payload) : "",
			},
		} as unknown as DragEvent,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.dropPosition.mockReturnValue({
		referenceGroup: { id: "group-target" },
		direction: "right",
	});
	mocks.launchDiscovered.mockResolvedValue({ id: "agent-resumed" });
	mocks.openAgentPanel.mockReturnValue(true);
});

describe("handleSidebarDrop recent sessions", () => {
	it("resumes an exact local conversation at the explicit pane drop position", () => {
		handleSidebarDrop(
			dropEvent({
				type: "recent-session",
				provider: "claude",
				conversationId: "conversation-before-dure",
				executionLocation: "local",
				cwd: "/repo/packages/app",
				workspaceRoot: "/repo",
			}),
			"desktop-target",
			document.createElement("div"),
		);

		expect(mocks.launchDiscovered).toHaveBeenCalledWith({
			provider: "claude",
			conversationId: "conversation-before-dure",
			cwd: "/repo/packages/app",
			workspaceRoot: "/repo",
			desktopId: "desktop-target",
			existingOwner: "return",
			position: {
				referenceGroup: { id: "group-target" },
				direction: "right",
			},
		});
	});
});
