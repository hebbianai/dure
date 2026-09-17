import { expect, it, vi } from "vitest";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { openSlackTask } from "./slackTask";

const task = {
	teamId: "T1",
	channelId: "C1",
	threadTs: "100.01",
	agentId: "agent-a",
	projectId: "project-a",
	interactionSessionId: "conversation-a",
	backend: {
		profileId: "local",
		backendId: "backend-team",
		scopeId: "team-scope",
	},
};
const binding = {
	schemaVersion: 1,
	agentId: task.agentId,
	interactionSessionId: task.interactionSessionId,
	providerId: "codex",
	executionProfile: { kind: "provider_default" },
	providerConversationRef: null,
	runtime: { runtimeGeneration: "runtime-a", providerEpoch: "provider-a" },
	timelineEpoch: "timeline-a",
	bindingRevision: 1,
	historyComplete: true,
	createdAtMs: 1,
	updatedAtMs: 1,
};

function server() {
	let scopeId = "team-scope";
	const inputs: string[] = [];
	const operations: string[] = [];
	const client = (profileId: string) => {
		const authority = {
			...testDureBackendRouteAuthority("backend-team", "generation-a"),
			profileId,
		};
		const invoke = vi.fn(
			async (_command: string, args: Record<string, unknown>) => {
				const body = args.body as Record<string, unknown>;
				operations.push(`${args.operation}:${body.kind ?? ""}`);
				let result: Record<string, unknown>;
				switch (args.operation) {
					case "backend.scope":
						result = { scopeId };
						break;
					case "slack.connector":
						result = { tasks: [task] };
						break;
					case "agent_conversation.inspect":
						result = { binding };
						break;
					case "agent_conversation.start_turn":
						expect(args.route).toEqual({ kind: "exact", authority });
						inputs.push(String(body.input));
						result = { receipt: { intent: body, state: "accepted" } };
						break;
					default:
						throw new Error(String(args.operation));
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
		return { authority, invoke };
	};
	return {
		client,
		operations,
		inputs,
		replace: () => {
			scopeId = "different-team";
		},
	};
}

it("lets independently named client connections discover and direct the same shared task without creating a connector or agent", async () => {
	const shared = server();
	for (const profile of ["my-team", "teammates-server"]) {
		const { invoke, authority } = shared.client(profile);
		const connector = createSlackConnectorClient({
			profileId: profile,
			invokeCommand: invoke,
		});
		const [linked] = await connector.tasks("T1", authority);
		const target = await openSlackTask(linked, profile, invoke);
		expect(target.profile.backendProfileId).toBe(profile);
		expect(target.agentId).toBe(task.agentId);
		const conversation = createDureAgentConversationClient({
			profileId: profile,
			routeAuthority: target.authority,
			invokeCommand: invoke,
		});
		await conversation.startTurn(
			{
				schemaVersion: 1,
				interactionSessionId: target.profile.interactionSessionId,
				runtime: binding.runtime,
				turnId: `turn-${profile}`,
				clientMessageId: `message-${profile}`,
				input: `direction from ${profile}`,
				requestedAtMs: 1,
			},
			target.authority,
		);
	}
	expect(shared.inputs).toEqual([
		"direction from my-team",
		"direction from teammates-server",
	]);
	expect(shared.operations.some((value) => /connect$|spawn/.test(value))).toBe(
		false,
	);
});

it("surfaces a moved server without reading its conversation or trying the local server", async () => {
	const shared = server();
	const { invoke } = shared.client("my-team");
	shared.replace();
	await expect(openSlackTask(task, "my-team", invoke)).rejects.toThrow(
		"slack_task_server_mismatch",
	);
	expect(shared.operations).toEqual(["backend.scope:"]);
});
