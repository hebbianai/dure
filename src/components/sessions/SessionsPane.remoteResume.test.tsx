// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listProviderConversations: vi.fn(),
	loadProviderConversationDetails: vi.fn(),
	launchLocal: vi.fn(),
	launchRemote: vi.fn(),
	message: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: mocks.listProviderConversations,
	loadProviderConversationDetails: mocks.loadProviderConversationDetails,
}));
vi.mock("@/lib/sessions/launch/discoveredConversationLaunch", () => ({
	launchDiscoveredLocalConversationPane: mocks.launchLocal,
	launchDiscoveredRemoteConversationPane: mocks.launchRemote,
}));

import { SessionsPane } from "@/components/sessions/SessionsPane";
import { setLang } from "@/lib/i18n";
import { resetRecentSessionHistoryForTests } from "@/lib/sessions/recentSessionHistoryResource";
import { useStore } from "@/store";

beforeEach(() => {
	resetRecentSessionHistoryForTests();
	setLang("en");
	useStore.setState({
		projects: [],
		agents: [],
		agentActivity: {},
		layouts: {},
		spaces: [{ id: "desktop-active", name: "Product" }],
		activeSpaceId: "desktop-active",
		sshHosts: [
			{
				id: "build-mac",
				name: "Build Mac",
				host: "build.test",
				port: 22,
				user: "agent",
				auth: "auto",
			},
		],
	});
	mocks.listProviderConversations.mockResolvedValue([
		{
			provider: "codex",
			id: "remote-conversation",
			title: "Continue the remote rollout",
			mtime: Date.now() / 1000,
			cwd: "/srv/product/.worktrees/rollout",
			repositoryRoot: "/srv/product",
			resumeCapability: "exact",
			executionLocation: "ssh",
			hostId: "build-mac",
			workingDirectoryAvailable: true,
		},
	]);
	mocks.loadProviderConversationDetails.mockResolvedValue({
		subagents: [],
		totalCount: 0,
	});
	mocks.launchRemote.mockResolvedValue({ id: "remote-agent" });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SessionsPane SSH recent-session resume", () => {
	const openConfirmation = async () => {
		fireEvent.click(
			await screen.findByRole("button", {
				name: /Details.*Continue the remote rollout/i,
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: /Review SSH setup.*Continue the remote rollout/i,
			}),
		);
		return await screen.findByRole("dialog", {
			name: /Continue this SSH session/i,
		});
	};

	it("previews the exact host, folder, and pane result before registration", async () => {
		render(<SessionsPane />);

		const dialog = await openConfirmation();
		expect(dialog.textContent).toContain("Build Mac");
		expect(dialog.textContent).toContain("agent@build.test");
		expect(dialog.textContent).toContain("/srv/product");
		expect(dialog.textContent).toContain("new pane");
		expect(mocks.message).not.toHaveBeenCalled();
	});

	it("cancels without registering a project, runtime, or pane", async () => {
		render(<SessionsPane />);
		await openConfirmation();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(mocks.launchRemote).not.toHaveBeenCalled();
		expect(useStore.getState().projects).toEqual([]);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("starts the exact host-scoped launch only after confirmation", async () => {
		render(<SessionsPane />);
		await openConfirmation();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Register folder and continue in a new pane",
			}),
		);

		await vi.waitFor(() =>
			expect(mocks.launchRemote).toHaveBeenCalledWith({
				provider: "codex",
				conversationId: "remote-conversation",
				cwd: "/srv/product/.worktrees/rollout",
				workspaceRoot: "/srv/product",
				hostId: "build-mac",
				desktopId: "desktop-active",
			}),
		);
		await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mocks.message).not.toHaveBeenCalled();
	});

	it("keeps a failed launch retryable in the same dialog", async () => {
		mocks.launchRemote.mockRejectedValueOnce(
			new Error("remote_transport_failed"),
		);
		render(<SessionsPane />);
		await openConfirmation();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Register folder and continue in a new pane",
			}),
		);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("remote_transport_failed");
		expect(alert.textContent).toContain("No pane was opened");
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(
			screen
				.getByRole("button", {
					name: "Register folder and continue in a new pane",
				})
				.hasAttribute("disabled"),
		).toBe(false);
	});
});
