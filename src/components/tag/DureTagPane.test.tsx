// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DureTagPane } from "./DureTagPane";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/agents/chat/sharedAgentConversation", () => ({
	openSharedAgentConversation: mocks.open,
}));
vi.mock("@/components/agents/chat/SharedAgentConversation", () => ({
	SharedAgentConversation: ({ target }: { target: { agentId: string } }) => (
		<div data-testid="tag-conversation">{target.agentId}</div>
	),
}));
vi.mock("@/components/plugins/useSlackTeamConnection", () => ({
	useSlackTeamConnection: () => ({
		pro: true,
		selected: "local",
		profiles: [],
		select: vi.fn(),
	}),
}));
vi.mock("@/components/plugins/SlackConnectionsPanel", () => ({
	SlackConnectionsPanel: () => null,
}));
vi.mock("@/components/plugins/SlackServerSelect", () => ({
	SlackServerSelect: () => null,
}));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/store", () => ({
	useStore: (selector: (s: unknown) => unknown) => selector({ projects: [] }),
}));
vi.mock("@/lib/ipc/slackConnector", () => ({
	createSlackConnectorClient: () => ({
		list: async () => ({
			connections: [{ config: { teamId: "team" } }],
			authority: {},
		}),
		tasks: async () =>
			["first", "second"].map((id) => ({
				agentId: id,
				title: id,
				teamId: "team",
				channelId: "channel",
				threadTs: id === "first" ? "100.1" : "100.2",
				backend: { backendId: "backend", scopeId: "scope" },
			})),
	}),
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("opens and changes the conversation inside Tag without adding a Space pane", async () => {
	mocks.open.mockImplementation(async (task) => ({
		agentId: task.agentId,
		authority: { revision: 1 },
		profile: { backendProfileId: "local" },
	}));
	render(<DureTagPane />);
	fireEvent.click(await screen.findByText("first"));
	await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
	expect((await screen.findByTestId("tag-conversation")).textContent).toBe(
		"first",
	);
	fireEvent.click(screen.getByRole("button", { name: "common.back" }));
	fireEvent.click(await screen.findByText("second"));
	expect((await screen.findByTestId("tag-conversation")).textContent).toBe(
		"second",
	);
	expect(screen.getAllByTestId("tag-conversation")).toHaveLength(1);
});
