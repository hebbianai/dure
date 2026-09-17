import { describe, expect, it } from "vitest";
import type { RemoteHmuxCatalogReceiptV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { projectRemoteAutomaticManagedRehostSession } from "@/lib/sessions/managed/remoteAutomaticManagedRehost";
import { stopFenceFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const stopFence = stopFenceFixture({
	runnerPrincipal: "principal",
	runnerInstance: "instance",
	hostInstanceId: "host-old",
	terminalEpoch: "terminal-old",
});

function agent(): Agent {
	return {
		id: "agent-1",
		name: "remote-codex",
		provider: "codex",
		projectId: "project-1",
		worktreePath: "/srv/repo",
		branch: "main",
		sessionId: "session-old",
		sessionKind: "ssh",
		conversationId: "conversation-1",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "ssh-host",
			sessionId: "session-old",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-old",
			commandBridgeNonce: "bridge-old",
			stopFence,
		},
	};
}

function attached(patch: Partial<HmuxSessionSummary> = {}): HmuxSessionSummary {
	return {
		sessionId: "session-old",
		workspaceId: "workspace-1",
		sessionClass: "managed",
		lifecycle: "ready",
		manifestLifecycle: "ready",
		health: "current_healthy",
		hostBuildVersion: "build-old",
		inputAllowed: true,
		detachOnly: false,
		runtimeHost: "ssh-host",
		terminalEpoch: "terminal-old",
		stopFence,
		outputSeq: "42",
		capabilities: [],
		...patch,
	};
}

function catalog(
	patch: Partial<RemoteHmuxCatalogReceiptV1["sessions"][number]> = {},
): RemoteHmuxCatalogReceiptV1 {
	return {
		schemaVersion: 1,
		hostId: "ssh-host",
		sessions: [
			{
				sessionId: "session-old",
				workspaceId: "workspace-1",
				sessionClass: "managed",
				lifecycle: "ready",
				providerId: "codex",
				runnerPrincipal: stopFence.runnerPrincipal,
				runnerInstance: stopFence.runnerInstance,
				channelEpoch: stopFence.channelEpoch,
				hostInstanceId: stopFence.hostInstanceId,
				terminalEpoch: stopFence.terminalEpoch,
				supportedProtocol: {
					minimum: { major: 1, minor: 0 },
					maximum: { major: 1, minor: 0 },
				},
				capabilities: ["terminal_input"],
				hostLiveness: "live",
				gatewayBuildId: "build-current",
				...patch,
			},
		],
	};
}

describe("remote automatic managed rehost projection", () => {
	it("marks only an exact live old Host as an upgrade candidate", () => {
		expect(
			projectRemoteAutomaticManagedRehostSession(agent(), attached(), catalog())
				?.health,
		).toBe("compatible_old_healthy");
		expect(
			projectRemoteAutomaticManagedRehostSession(
				agent(),
				attached({ hostBuildVersion: "build-current" }),
				catalog(),
			)?.health,
		).toBe("current_healthy");
	});

	it.each([
		["offline Host", { hostLiveness: "absent" as const }],
		["unknown Host", { hostLiveness: "unknown" as const }],
		["different provider", { providerId: "claude" }],
		["compatibility catalog", { gatewayBuildId: undefined }],
		["replacement generation", { terminalEpoch: "terminal-new" }],
	])("defers %s without mutating the attached summary", (_name, patch) => {
		const source = attached();
		expect(
			projectRemoteAutomaticManagedRehostSession(
				agent(),
				source,
				catalog(patch),
			),
		).toBeUndefined();
		expect(source.health).toBe("current_healthy");
	});
});
