// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { DureTagPane } from "./DureTagPane";

const mocks = vi.hoisted(() => ({
	open: vi.fn(),
	invoke: vi.fn(),
	activity: vi.fn(),
}));
vi.mock("@/lib/agents/chat/sharedConversationActivity", () => ({
	readSharedConversationActivity: mocks.activity,
}));
vi.mock("@/lib/agents/chat/sharedAgentConversation", () => ({
	openSharedAgentConversation: mocks.open,
}));
vi.mock("@/components/agents/chat/SharedAgentConversation", () => ({
	SharedAgentConversation: ({
		target,
		header,
	}: {
		target: { agentId: string; authority: DureBackendRouteAuthorityV1 };
		header?: ReactNode;
	}) => (
		<>
			{header}
			<div
				data-testid="tag-conversation"
				data-generation={target.authority.backend.generation}
			>
				{target.agentId}
			</div>
		</>
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const route = (generation: string): DureBackendRouteAuthorityV1 => ({
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${(generation === "one" ? "a" : "b").repeat(64)}`,
	backend: { id: "backend", generation },
	target: { source: "local", hostId: "local" },
});
let authority = route("one");
let failTasks = false;
let taskTitle = "first";
let filePermissions: { read: boolean; write: boolean } | null = null;
beforeEach(() => {
	authority = route("one");
	failTasks = false;
	filePermissions = null;
	taskTitle = "first";
	mocks.activity.mockResolvedValue(new Map());
	mocks.open.mockImplementation(async (task) => ({
		agentId: task.agentId,
		authority,
		profile: { backendProfileId: "local" },
	}));
	mocks.invoke.mockImplementation(async (_command, args) => {
		if (
			args.route.kind === "exact" &&
			args.route.authority.backend.generation !== authority.backend.generation
		)
			throw { code: "backend_transport_authority_changed" };
		const body = args.body;
		if (body.kind === "tasks" && failTasks) {
			failTasks = false;
			authority = route("two");
			throw { code: "backend_transport_authority_changed" };
		}
		return {
			schemaVersion: 1,
			backendId: authority.backend.id,
			backendGeneration: authority.backend.generation,
			routeAuthority: authority,
			result: {
				schemaVersion: 1,
				...(body.kind === "list"
					? {
							connections: [
								{
									config: { schemaVersion: 1, teamId: "T1", channels: [] },
									enabled: true,
									credentialsConfigured: true,
									connection: "connected",
									generation: "connector",
									failure: null,
									filePermissions,
								},
							],
						}
					: {
							tasks: ["first", "second"].map((id) => ({
								agentId: id,
								title: id === "first" ? taskTitle : id,
								teamId: "T1",
								channelId: "C1",
								projectId: "project",
								interactionSessionId: `interaction-${id}`,
								threadTs: id === "first" ? "100.1" : "100.2",
								backend: {
									profileId: "local",
									backendId: "backend",
									scopeId: "scope",
								},
							})),
						}),
			},
		};
	});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

it("opens and changes the conversation inside Tag without adding a Space pane", async () => {
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

async function tick() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(5000);
	});
}

it("follows a replacement backend on the next complete list observation", async () => {
	vi.useFakeTimers();
	await act(async () => {
		render(<DureTagPane />);
	});
	expect(screen.getByText("first")).toBeTruthy();
	authority = route("two");
	taskTitle = "updated after deployment";
	await tick();
	expect(screen.getByText(taskTitle)).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps observing after replacement interrupts the connection and task snapshot", async () => {
	vi.useFakeTimers();
	failTasks = true;
	await act(async () => {
		render(<DureTagPane />);
	});
	expect(screen.getByRole("alert")).toBeTruthy();
	await tick();
	expect(screen.getByText("first")).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
});

it("resolves the same selected task again after replacement without reopening it on ordinary polls", async () => {
	vi.useFakeTimers();
	await act(async () => {
		render(<DureTagPane />);
	});
	await act(async () => {
		fireEvent.click(screen.getByText("first"));
	});
	expect(screen.getByTestId("tag-conversation").dataset.generation).toBe("one");
	await tick();
	expect(mocks.open).toHaveBeenCalledTimes(1);
	authority = route("two");
	await tick();
	expect(screen.getByTestId("tag-conversation").dataset.generation).toBe("two");
	expect(mocks.open).toHaveBeenCalledTimes(2);
	expect(mocks.open.mock.calls[1]).toEqual(mocks.open.mock.calls[0]);
	expect(screen.getAllByTestId("tag-conversation")).toHaveLength(1);
});

it("ignores a late conversation response after selecting a different task", async () => {
	let finishFirst: ((value: unknown) => void) | undefined;
	mocks.open.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishFirst = resolve;
			}),
	);
	render(<DureTagPane />);
	fireEvent.click(await screen.findByText("first"));
	await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
	fireEvent.click(screen.getByRole("button", { name: "common.back" }));
	fireEvent.click(await screen.findByText("second"));
	expect((await screen.findByTestId("tag-conversation")).textContent).toBe(
		"second",
	);
	await act(async () => {
		finishFirst?.({
			agentId: "first",
			authority,
			profile: { backendProfileId: "local" },
		});
	});
	expect(screen.getByTestId("tag-conversation").textContent).toBe("second");
});

it("shows the Dure spinner only for observed work and removes it on the next idle observation", async () => {
	vi.useFakeTimers();
	mocks.activity.mockResolvedValue(
		new Map([
			["first", true],
			["second", false],
		]),
	);
	await act(async () => {
		render(<DureTagPane />);
	});
	const working = screen.getByText("first").closest("button")!;
	expect(working.getAttribute("aria-busy")).toBe("true");
	expect(working.querySelector(".dure-loader")).toBeTruthy();
	expect(screen.getByRole("status", { name: "common.working" })).toBeTruthy();
	expect(
		screen.getByText("second").closest("button")!.querySelector(".dure-loader"),
	).toBeNull();
	mocks.activity.mockResolvedValue(
		new Map([
			["first", false],
			["second", false],
		]),
	);
	await tick();
	expect(working.querySelector(".dure-loader")).toBeNull();
	expect(working.hasAttribute("aria-busy")).toBe(false);
});

it("clears unconfirmed activity after a failed observation and keeps the task available", async () => {
	vi.useFakeTimers();
	mocks.activity.mockResolvedValue(new Map([["first", true]]));
	await act(async () => {
		render(<DureTagPane />);
	});
	expect(screen.getByRole("status", { name: "common.working" })).toBeTruthy();
	mocks.activity.mockRejectedValue(new Error("backend unavailable"));
	await tick();
	expect(screen.queryByRole("status", { name: "common.working" })).toBeNull();
	expect(screen.getByRole("alert")).toBeTruthy();
	expect(screen.getByText("first")).toBeTruthy();
});

it("shows confirmed missing file permissions in the task list and conversation, and removes the notice after a grant", async () => {
	vi.useFakeTimers();
	filePermissions = { read: false, write: false };
	await act(async () => {
		render(<DureTagPane />);
	});
	expect(screen.getByText("plugins.slack.filePermissionsTitle")).toBeTruthy();
	expect(screen.getByText("tag.mentionRequired")).toBeTruthy();
	await act(async () => {
		fireEvent.click(screen.getByText("first"));
	});
	expect(screen.getByText("plugins.slack.filePermissionsTitle")).toBeTruthy();
	fireEvent.click(
		screen.getByRole("button", { name: "plugins.slack.updatePermissions" }),
	);
	expect(screen.getByRole("dialog")).toBeTruthy();
	filePermissions = { read: true, write: true };
	await tick();
	expect(screen.queryByText("plugins.slack.filePermissionsTitle")).toBeNull();
	expect(screen.getByTestId("tag-conversation")).toBeTruthy();
});

it("does not invent a missing permission on an older server", async () => {
	render(<DureTagPane />);
	await screen.findByText("first");
	expect(screen.queryByText("plugins.slack.filePermissionsTitle")).toBeNull();
});
