import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

function binding(generation: number) {
	return managedBindingFixture({
		sessionId: `session-${generation}`,
		createIdempotencyKey: `create-${generation}`,
		stopFence: stopFenceFixture({
			hostInstanceId: `host-${generation}`,
			terminalEpoch: `terminal-${generation}`,
		}),
	});
}

export function managedRehostAgentFixture(generation: number) {
	return managedAgentFixture({
		sessionId: `session-${generation}`,
		conversationId: `conversation-${generation}`,
		runtimeBinding: binding(generation),
	});
}

export function managedRehostNotificationFixture(
	generation: number,
): ManagedAgentRehostSyncPayload {
	return {
		schemaVersion: 2,
		operationId: `rehost-${generation}`,
		launchKind: "fresh",
		permissionMode: "default",
		agentId: "agent-1",
		agentName: "agent-1",
		projectId: "project-1",
		providerId: "codex",
		sourceBinding: binding(generation - 1),
		sourceConversationId: `conversation-${generation - 1}`,
		binding: binding(generation),
		conversationId: `conversation-${generation}`,
		cwd: "/repo/.worktrees/agent-1",
		desktopId: "desk-1",
		panelId: "agent:agent-1",
	};
}
