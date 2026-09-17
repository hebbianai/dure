// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContextMenu } from "@/components/agents/AgentContextMenu";
import { presentForkInAgentPanelDesktop } from "@/components/panels/AgentPanelToolbarFrame";
import { t } from "@/lib/i18n";
import { agentFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({
	forkAgent: vi.fn(),
	messageDialog: vi.fn(),
	isMountedPaneOwned: vi.fn(),
	openAgentPanel: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	message: mocks.messageDialog,
}));
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => ["codex"],
}));
vi.mock("@/lib/agents/fork", () => ({
	forkAgent: mocks.forkAgent,
}));
vi.mock("@/lib/workspace/pane/paneOwnership", () => ({
	isMountedPaneOwned: mocks.isMountedPaneOwned,
}));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.openAgentPanel,
}));
vi.mock("@/components/agents/ProviderLogo", () => ({
	ProviderGlyph: () => null,
}));
vi.mock("@/components/agents/AgentRenameDialog", () => ({
	AgentRenameDialog: () => null,
}));

const sourceAgent = agentFixture({ id: "agent-source", provider: "codex" });
const forkedAgent = agentFixture({ id: "agent-fork", provider: "codex" });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("Agent context-menu fork presentation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.messageDialog.mockResolvedValue(undefined);
		mocks.isMountedPaneOwned.mockReturnValue(true);
		mocks.openAgentPanel.mockReturnValue(true);
	});

	afterEach(cleanup);

	it("does not present a completed fork after its source pane is gone", async () => {
		const pendingFork = deferred<typeof forkedAgent>();
		mocks.forkAgent.mockReturnValueOnce(pendingFork.promise);
		render(
			<AgentContextMenu
				agent={sourceAgent}
				presentFork={(agent) =>
					presentForkInAgentPanelDesktop(
						{ desktopId: "desktop-source", panelId: "agent:agent-source" },
						agent,
					)
				}
			>
				<button type="button">source agent</button>
			</AgentContextMenu>,
		);

		fireEvent.contextMenu(screen.getByRole("button", { name: "source agent" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /Codex/ }));
		await waitFor(() => expect(mocks.forkAgent).toHaveBeenCalledOnce());

		mocks.isMountedPaneOwned.mockReturnValue(false);
		pendingFork.resolve(forkedAgent);

		await waitFor(() =>
			expect(mocks.messageDialog).toHaveBeenCalledWith(
				t("workspace.agentWindow.forkPresentationFailed"),
				{ kind: "error" },
			),
		);
		expect(mocks.isMountedPaneOwned).toHaveBeenCalledWith({
			desktopId: "desktop-source",
			panelId: "agent:agent-source",
		});
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("presents the fork when the exact source pane is still mounted", async () => {
		mocks.forkAgent.mockResolvedValueOnce(forkedAgent);
		render(
			<AgentContextMenu
				agent={sourceAgent}
				presentFork={(agent) =>
					presentForkInAgentPanelDesktop(
						{ desktopId: "desktop-source", panelId: "agent:agent-source" },
						agent,
					)
				}
			>
				<button type="button">source agent</button>
			</AgentContextMenu>,
		);

		fireEvent.contextMenu(screen.getByRole("button", { name: "source agent" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /Codex/ }));

		await waitFor(() =>
			expect(mocks.openAgentPanel).toHaveBeenCalledWith(
				"desktop-source",
				forkedAgent,
			),
		);
		expect(mocks.isMountedPaneOwned).toHaveBeenCalledWith({
			desktopId: "desktop-source",
			panelId: "agent:agent-source",
		});
		expect(mocks.messageDialog).not.toHaveBeenCalled();
	});
});
