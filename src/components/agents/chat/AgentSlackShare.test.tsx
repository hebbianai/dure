// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSlackShare } from "@/components/agents/chat/AgentSlackShare";
import { setLang } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";
import { openSelect } from "@/test/select";

const mode = vi.hoisted(() => ({ pro: true }));
vi.mock("@/components/workspace/useInterfaceMode", () => ({
	useInterfaceMode: () => (mode.pro ? "pro" : "basic"),
}));
beforeEach(() => {
	setLang("en");
	mode.pro = true;
});
afterEach(cleanup);
const identity = {
	agentId: "agent-1",
	interactionSessionId: "conversation-1",
	backendProfileId: "worker",
};
const authority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "gateway",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "gateway", generation: "generation-1" },
	target: { source: "local", hostId: "local" },
};
function fixture(failed = false, backend?: string) {
	const invokeCommand = vi.fn(
		async (_command: string, args: Record<string, unknown>) => {
			expect(args.operation).toBe("slack.connector");
			const body = args.body as Record<string, unknown>;
			let result: Record<string, unknown>;
			if (body.kind === "list")
				result = {
					connections: [
						{
							config: {
								schemaVersion: 1,
								teamId: "T1",
								channels: [
									{
										channelId: "C1",
										projectId: "project-1",
										providerId: "codex",
										backend: "worker",
									},
								],
							},
							enabled: true,
							connection: "connected",
							credentialsConfigured: true,
							generation: "connector-1",
							failure: null,
						},
					],
				};
			else {
				expect(args.route).toEqual({ kind: "exact", authority });
				expect(body).toEqual({
					schemaVersion: 1,
					kind: "share",
					requestId: expect.any(String),
					teamId: "T1",
					channelId: "C1",
					agentId: "agent-1",
					interactionSessionId: "conversation-1",
					...(backend ? { backend } : {}),
				});
				if (failed)
					throw new DureBackendRequestError(
						"slack_share_conversation_changed",
						"private fixture detail",
						{ kind: "operation", disposition: "terminal" },
					);
				result = {
					share: { state: "succeeded", ...body, threadTs: "200.001" },
				};
			}
			return {
				schemaVersion: 1,
				backendId: authority.backend.id,
				backendGeneration: authority.backend.generation,
				routeAuthority: authority,
				result: { schemaVersion: 1, ...result },
			};
		},
	);
	return {
		client: createSlackConnectorClient({ invokeCommand }),
		invokeCommand,
	};
}
async function chooseChannel() {
	fireEvent.click(screen.getByRole("button", { name: "Share in Slack" }));
	const picker = await screen.findByRole("combobox", { name: "Slack channel" });
	openSelect(picker);
	fireEvent.click(screen.getByRole("option", { name: "T1 / C1" }));
	return within(screen.getByRole("dialog")).getByRole("button", {
		name: "Share in Slack",
	});
}
it("shares the exact current conversation through the observed gateway only after channel choice", async () => {
	const f = fixture();
	render(<AgentSlackShare identity={identity} client={f.client} />);
	expect(f.invokeCommand).not.toHaveBeenCalled();
	const submit = await chooseChannel();
	expect(f.invokeCommand).toHaveBeenCalledTimes(1);
	fireEvent.click(submit);
	await screen.findByRole("status");
	expect(f.invokeCommand).toHaveBeenCalledTimes(2);
	expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(true);
});
it("keeps the channel choice and visible failure without automatically posting again", async () => {
	const f = fixture(true);
	render(<AgentSlackShare identity={identity} client={f.client} />);
	fireEvent.click(await chooseChannel());
	await screen.findByRole("alert");
	expect(screen.getByRole("alert").textContent).toContain(
		"different conversation",
	);
	expect(screen.getByRole("alert").textContent).not.toContain(
		"private fixture detail",
	);
	expect(screen.getByRole("combobox").textContent).toContain("T1 / C1");
	await waitFor(() => expect(f.invokeCommand).toHaveBeenCalledTimes(2));
});
it("offers sharing in Basic and waits for the user to open it", () => {
	mode.pro = false;
	const f = fixture();
	render(<AgentSlackShare identity={identity} client={f.client} />);
	expect(screen.getByRole("button", { name: "Share in Slack" })).toBeTruthy();
	expect(f.invokeCommand).not.toHaveBeenCalled();
});

it("can share work from another server without changing the channel default", async () => {
	const f = fixture(false, "worker-two");
	render(<AgentSlackShare identity={identity} client={f.client} />);
	const submit = await chooseChannel();
	fireEvent.click(screen.getByText("Execution server (optional)"));
	fireEvent.change(
		screen.getByRole("textbox", { name: "Execution server (optional)" }),
		{ target: { value: " worker-two " } },
	);
	fireEvent.click(submit);
	await screen.findByRole("status");
	expect(f.invokeCommand).toHaveBeenCalledTimes(2);
});
