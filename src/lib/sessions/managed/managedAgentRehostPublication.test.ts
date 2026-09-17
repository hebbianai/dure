import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { MANAGED_AGENT_REHOSTED_EVENT } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { managedBindingFixture } from "@/test/agentFixtures";

const payload: ManagedAgentRehostSyncPayload = {
	schemaVersion: 2,
	operationId: "rehost-1",
	launchKind: "fresh",
	agentId: "agent-1",
	agentName: "worker",
	projectId: "project-1",
	providerId: "codex",
	sourcePermissionMode: "default",
	permissionMode: "default",
	sourceBinding: managedBindingFixture({ sessionId: "source" }),
	sourceConversationId: null,
	cwd: "/repo",
	conversationId: null,
	desktopId: "desktop-1",
	panelId: "agent:agent-1",
	binding: managedBindingFixture({ sessionId: "successor-1" }),
	targetCredentialId: null,
};

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("managed rehost publication", () => {
	it.each(["throw", "reject"])(
		"diagnoses a %s without retrying",
		async (kind) => {
			const error = new Error("notification transport disconnected");
			const broadcast = vi.fn(() => {
				if (kind === "throw") throw error;
				return Promise.reject(error);
			});

			publishManagedAgentRehostProjection(payload, broadcast);

			await vi.waitFor(() =>
				expect(console.warn).toHaveBeenCalledWith(
					expect.stringContaining("Rehost committed"),
					{
						agentId: "agent-1",
						operationId: "rehost-1",
						sessionId: "successor-1",
					},
					error,
				),
			);
			expect(broadcast).toHaveBeenCalledExactlyOnceWith(
				MANAGED_AGENT_REHOSTED_EVENT,
				payload,
			);
		},
	);

	it("keeps a delayed failure tied to its completed operation, not the next one", async () => {
		let reject!: (error: Error) => void;
		const pending = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		const broadcast = vi
			.fn()
			.mockReturnValueOnce(pending)
			.mockResolvedValue(undefined);
		const next = {
			...payload,
			operationId: "rehost-2",
			binding: managedBindingFixture({ sessionId: "successor-2" }),
		};

		publishManagedAgentRehostProjection(payload, broadcast);
		publishManagedAgentRehostProjection(next, broadcast);
		await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
		expect(console.warn).not.toHaveBeenCalled();
		const error = new Error("earlier window notification lost");
		reject(error);
		await vi.waitFor(() => expect(console.warn).toHaveBeenCalledOnce());

		expect(console.warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				operationId: "rehost-1",
				sessionId: "successor-1",
			}),
			error,
		);
		expect(broadcast).toHaveBeenLastCalledWith(
			MANAGED_AGENT_REHOSTED_EVENT,
			next,
		);
		expect(broadcast).toHaveBeenCalledTimes(2);
	});
});
