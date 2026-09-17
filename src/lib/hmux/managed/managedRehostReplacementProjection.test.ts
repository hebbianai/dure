import { describe, expect, it } from "vitest";
import { projectManagedRehostReplacement } from "@/lib/hmux/managed/managedRehostReplacementProjection";
import type { ManagedRehostTargetReceiptV1 } from "@/lib/hmux/managed/managedRehostTargetReceipt";

const target: ManagedRehostTargetReceiptV1 = {
	idempotencyKey: "create-1",
	sessionId: "target-1",
	workspaceId: "workspace-1",
	providerId: "codex",
	permissionMode: "default",
	runnerPrincipal: "principal-1",
	runnerInstance: "runner-1",
	channelEpoch: "7",
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
};

describe("managed rehost replacement projection", () => {
	it("uses the fenced receipt while catalog inventory catches up", () => {
		expect(
			projectManagedRehostReplacement(target, undefined, "build-1"),
		).toMatchObject({
			sessionId: "target-1",
			workspaceId: "workspace-1",
			lifecycle: "unavailable",
			health: "unprobed",
			hostBuildVersion: "build-1",
			stopFence: {
				runnerPrincipal: "principal-1",
				terminalEpoch: "terminal-1",
			},
		});
	});

	it("keeps only a catalog projection with the exact target fence", () => {
		const matching = {
			sessionId: "target-1",
			workspaceId: "workspace-1",
			sessionClass: "managed" as const,
			lifecycle: "ready" as const,
			health: "current_healthy" as const,
			terminalEpoch: "terminal-1",
			stopFence: {
				runnerPrincipal: "principal-1",
				runnerInstance: "runner-1",
				channelEpoch: "7",
				hostInstanceId: "host-1",
				terminalEpoch: "terminal-1",
			},
			outputSeq: "42",
			capabilities: [],
		};
		expect(projectManagedRehostReplacement(target, matching, undefined)).toBe(
			matching,
		);

		const mismatched = {
			...matching,
			stopFence: { ...matching.stopFence, terminalEpoch: "terminal-other" },
		};
		expect(
			projectManagedRehostReplacement(target, mismatched, undefined),
		).toMatchObject({
			sessionId: "target-1",
			lifecycle: "unavailable",
			terminalEpoch: "terminal-1",
		});
	});
});
