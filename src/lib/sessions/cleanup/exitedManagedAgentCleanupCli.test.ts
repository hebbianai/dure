import { describe, expect, it, vi } from "vitest";
import {
	type ExitedManagedAgentCleanupCliRuntime,
	handleExitedManagedAgentCleanupCliRequest,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCli";

describe("exited managed Agent cleanup CLI bridge", () => {
	it("claims the destructive request and completes it with exact receipts", async () => {
		const candidate = {
			agentId: "agent-1",
			agentName: "exited-agent",
			projectName: "Dure",
			binding: {
				schemaVersion: 1 as const,
				runtime: "hmux_managed_v1" as const,
				source: "local" as const,
				hostId: "local" as const,
				sessionId: "session-1",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-1",
			},
			sourceState: "absent" as const,
		};
		const complete = vi.fn();
		const runtime = {
			claim: vi.fn(async () => true),
			complete,
			preview: vi.fn(async () => ({
				candidates: [candidate],
				protectedManagedCount: 2,
			})),
			execute: vi.fn(async () => [
				{
					agentId: "agent-1",
					agentName: "exited-agent",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					outcome: "cleaned" as const,
					sourceState: "absent" as const,
				},
			]),
		} satisfies ExitedManagedAgentCleanupCliRuntime;

		await handleExitedManagedAgentCleanupCliRequest("request-1", runtime);

		expect(runtime.execute).toHaveBeenCalledWith([candidate]);
		expect(complete).toHaveBeenCalledWith(
			"request-1",
			expect.objectContaining({
				ok: true,
				cleanup: expect.objectContaining({
					candidateCount: 1,
					protectedManagedCount: 2,
				}),
			}),
			"hmux.cleanup-exited",
		);
	});

	it("does nothing in WebViews that do not win the request claim", async () => {
		const runtime = {
			claim: vi.fn(async () => false),
			complete: vi.fn(),
			preview: vi.fn(),
			execute: vi.fn(),
		} satisfies ExitedManagedAgentCleanupCliRuntime;

		await handleExitedManagedAgentCleanupCliRequest("request-2", runtime);

		expect(runtime.preview).not.toHaveBeenCalled();
		expect(runtime.execute).not.toHaveBeenCalled();
		expect(runtime.complete).not.toHaveBeenCalled();
	});
});
