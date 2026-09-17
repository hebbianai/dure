// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SlackConnectionsPanel } from "@/components/plugins/SlackConnectionsPanel";
import { setLang } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	exactDureBackendRoute,
} from "@/lib/ipc/dureBackendRoute";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";
import type { SlackConnection } from "@/lib/plugins/slackConnection";

const mode = vi.hoisted(() => ({ pro: true }));
vi.mock("@/components/workspace/useInterfaceMode", () => ({
	useInterfaceMode: () => (mode.pro ? "pro" : "basic"),
}));

const authority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-local", generation: "backend-1" },
	target: { source: "local", hostId: "local" },
};
const envelope = (result: Record<string, unknown>) => ({
	schemaVersion: 1,
	backendId: authority.backend.id,
	backendGeneration: authority.backend.generation,
	routeAuthority: authority,
	result: { schemaVersion: 1, ...result },
});

function fixture({
	loseConnect = false,
	failed = false,
	initial = [],
}: {
	loseConnect?: boolean;
	failed?: boolean;
	initial?: SlackConnection[];
} = {}) {
	let connections = initial;
	let delayedList: (() => Promise<unknown>) | undefined;
	const invokeCommand = vi.fn(
		async (_command: string, args: Record<string, unknown>) => {
			if (args.operation === "projects.list")
				return envelope({
					projects: [{ id: "project-main", displayName: "Main" }],
					complete: true,
				});
			expect(args.operation).toBe("slack.connector");
			const body = args.body as Record<string, unknown>;
			if (body.kind === "list" && delayedList) {
				const delay = delayedList;
				delayedList = undefined;
				return delay();
			}
			if (body.kind === "connect") {
				expect(args.route).toEqual(exactDureBackendRoute(authority));
				if (loseConnect)
					throw new DureBackendRequestError(
						"timeout",
						"fixture-app-token was in an unsafe diagnostic",
						{ kind: "transport" },
					);
				connections = [
					{
						config: body.config as SlackConnection["config"],
						enabled: !failed,
						credentialsConfigured: true,
						connection: failed ? "failed" : "connected",
						generation: "connector-1",
						failure: failed ? "slack_invalid_auth" : null,
					},
				];
			}
			if (body.kind === "disconnect") {
				expect(args.route).toEqual(exactDureBackendRoute(authority));
				connections = connections.map((entry) =>
					entry.config.teamId === body.teamId
						? { ...entry, enabled: false, connection: "stopped" }
						: entry,
				);
			}
			return envelope({ connections: structuredClone(connections) });
		},
	);
	return {
		client: createSlackConnectorClient({ invokeCommand }),
		invokeCommand,
		delayList: (next: () => Promise<unknown>) => {
			delayedList = next;
		},
		actions: (kind: string) =>
			invokeCommand.mock.calls.filter(
				([, args]) => (args.body as Record<string, unknown>).kind === kind,
			),
	};
}

beforeEach(() => {
	setLang("en");
	mode.pro = true;
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

async function newWorkspace() {
	fireEvent.click(
		await screen.findByRole("button", { name: "Connect a workspace" }),
	);
	fireEvent.change(screen.getByLabelText("Slack workspace"), {
		target: { value: "https://app.slack.com/client/T1" },
	});
	fireEvent.change(screen.getByLabelText("App-level token"), {
		target: { value: "fixture-app-token" },
	});
	fireEvent.change(screen.getByLabelText("Bot token"), {
		target: { value: "fixture-bot-token" },
	});
}

it("connects before channel selection, keeps the connection after closing the panel, and edits its routes", async () => {
	const f = fixture();
	const view = render(<SlackConnectionsPanel client={f.client} />);
	await newWorkspace();
	fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
	await screen.findByText("Connected");
	expect(
		(f.actions("connect")[0][1].body as Record<string, unknown>).config,
	).toEqual({ schemaVersion: 1, teamId: "T1", channels: [] });
	await waitFor(() =>
		expect(
			(screen.getByLabelText("App-level token") as HTMLInputElement).value,
		).toBe(""),
	);
	view.unmount();
	expect(f.actions("disconnect")).toHaveLength(0);
	render(<SlackConnectionsPanel client={f.client} />);
	await screen.findByText("Connected");
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	await waitFor(() =>
		expect(
			f.invokeCommand.mock.calls.some(
				([, args]) => args.operation === "projects.list",
			),
		).toBe(true),
	);
	fireEvent.click(screen.getByRole("button", { name: "Add channel" }));
	fireEvent.change(screen.getByLabelText("Slack channel"), {
		target: { value: "https://team.slack.com/archives/C1" },
	});
	fireEvent.change(screen.getByLabelText("Execution server (optional)"), {
		target: { value: "worker-two" },
	});
	fireEvent.change(screen.getByLabelText("Project"), {
		target: { value: "remote-project" },
	});
	fireEvent.change(screen.getByLabelText("Shared goal (optional)"), {
		target: { value: "Keep the release moving" },
	});
	fireEvent.change(screen.getByLabelText("Dure Space (optional)"), {
		target: { value: "Team" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
	await waitFor(() => expect(f.actions("connect")).toHaveLength(2));
	expect(f.actions("connect")[1][1].body).toEqual({
		schemaVersion: 1,
		kind: "connect",
		config: {
			schemaVersion: 1,
			teamId: "T1",
			channels: [
				{
					channelId: "C1",
					projectId: "remote-project",
					providerId: "claude",
					backend: "worker-two",
					objective: "Keep the release moving",
					space: "Team",
				},
			],
		},
	});
	await waitFor(() =>
		expect(
			(screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
	await screen.findByText("Disconnected");
	expect(f.actions("disconnect")).toHaveLength(1);
});

it("keeps a failed submission and its draft without replaying the action or showing raw diagnostics", async () => {
	const f = fixture({ loseConnect: true });
	render(<SlackConnectionsPanel client={f.client} />);
	await newWorkspace();
	fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
	await screen.findByText(
		"The Slack connection request failed. Your draft is still here.",
	);
	expect(
		(screen.getByLabelText("App-level token") as HTMLInputElement).value,
	).toBe("fixture-app-token");
	expect(document.body.textContent).not.toContain("unsafe diagnostic");
	expect(f.actions("connect")).toHaveLength(1);
});

it("shows the server's terminal failure and does not turn observation into another connect", async () => {
	vi.useFakeTimers();
	const f = fixture({ failed: true });
	await act(async () => {
		render(<SlackConnectionsPanel client={f.client} />);
	});
	await act(async () => {
		fireEvent.click(
			screen.getByRole("button", { name: "Connect a workspace" }),
		);
	});
	fireEvent.change(screen.getByLabelText("Slack workspace"), {
		target: { value: "T1" },
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
	});
	expect(
		screen.getByText(
			"Slack rejected the saved tokens. Update them and connect again.",
		),
	).toBeTruthy();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3100);
	});
	expect(f.actions("list").length).toBeGreaterThan(1);
	expect(f.actions("connect")).toHaveLength(1);
});

it("keeps a newer connect response when a previous observation arrives late", async () => {
	vi.useFakeTimers();
	const stopped: SlackConnection = {
		config: { schemaVersion: 1, teamId: "T1", channels: [] },
		enabled: false,
		credentialsConfigured: true,
		connection: "stopped",
		generation: null,
		failure: null,
	};
	const f = fixture({ initial: [stopped] });
	await act(async () => {
		render(<SlackConnectionsPanel client={f.client} />);
	});
	let resolvePending!: (value: unknown) => void;
	const pending = new Promise<unknown>((resolve) => {
		resolvePending = resolve;
	});
	f.delayList(() => pending);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1500);
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
	});
	expect(screen.getByText("Connected")).toBeTruthy();
	await act(async () => {
		resolvePending(envelope({ connections: [stopped] }));
	});
	expect(screen.getByText("Connected")).toBeTruthy();
	expect(screen.queryByText("Disconnected")).toBeNull();
});

it("does not expose or request Slack connection management in Basic mode", async () => {
	mode.pro = false;
	const f = fixture();
	await act(async () => {
		render(<SlackConnectionsPanel client={f.client} />);
	});
	expect(f.invokeCommand).not.toHaveBeenCalled();
	expect(
		screen.queryByRole("button", { name: "Connect a workspace" }),
	).toBeNull();
});
