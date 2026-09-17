import { describe, expect, it, vi } from "vitest";
import {
	type ManagedAgentRehostSyncPayload,
	parseManagedAgentRehostSyncPayload,
	resolveManagedAgentRehostRouteAuthority,
} from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { managedBindingFixture, stopFenceFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const routeAuthority = testDureBackendRouteAuthority(
	"backend-local",
	"generation-1",
);

function payload(
	patch: Partial<ManagedAgentRehostSyncPayload> = {},
): ManagedAgentRehostSyncPayload {
	return {
		schemaVersion: 2,
		operationId: "rehost-operation-1",
		launchKind: "exact_resume",
		sourcePermissionMode: "default",
		permissionMode: "default",
		agentId: "agent-1",
		agentName: "worker",
		projectId: "project-1",
		providerId: "codex",
		sourceBinding: managedBindingFixture({
			sessionId: "session-old",
			stopFence: stopFenceFixture({ terminalEpoch: "terminal-old" }),
		}),
		sourceConversationId: "conversation-1",
		backendRouteAuthority: routeAuthority,
		cwd: "/repo/worktree",
		conversationId: "conversation-1",
		desktopId: "desktop-1",
		panelId: "agent:agent-1",
		binding: managedBindingFixture({
			sessionId: "session-new",
			createIdempotencyKey: "rehost-1",
			stopFence: stopFenceFixture({ terminalEpoch: "terminal-new" }),
		}),
		targetCredentialId: null,
		...patch,
	};
}

describe("managed Agent rehost sync contract", () => {
	it("parses and retains the exact route captured by a live rehost", async () => {
		const parsed = parseManagedAgentRehostSyncPayload(payload());
		if (!parsed) throw new Error("live rehost payload did not parse");

		expect(parsed.backendRouteAuthority).toEqual(routeAuthority);
		await expect(
			resolveManagedAgentRehostRouteAuthority(parsed),
		).resolves.toEqual(routeAuthority);
	});

	it("parses a target-first Resume without requiring a source stop fence", () => {
		const sourceBinding = payload().sourceBinding;
		const parsed = parseManagedAgentRehostSyncPayload(
			payload({
				launchKind: "resume_new_host",
				sourceBinding: { ...sourceBinding, stopFence: undefined },
				binding: managedBindingFixture({
					sessionId: "session-new",
					workspaceId: "workspace-new",
					createIdempotencyKey: "create-new",
					stopFence: stopFenceFixture({ terminalEpoch: "terminal-new" }),
				}),
			}),
		);

		expect(parsed).toMatchObject({
			launchKind: "resume_new_host",
			conversationId: "conversation-1",
			backendRouteAuthority: routeAuthority,
			binding: { workspaceId: "workspace-new" },
		});
	});

	it("rejects a carried route from a different backend profile", () => {
		expect(
			parseManagedAgentRehostSyncPayload(
				payload({
					backendRouteAuthority: {
						...routeAuthority,
						profileId: "remote-a",
					},
				}),
			),
		).toBeUndefined();
	});

	it("resolves selection only after a launch reaches its first Dure effect", async () => {
		const routeLessResume = parseManagedAgentRehostSyncPayload(
			payload({
				launchKind: "resume_new_host",
				backendRouteAuthority: undefined,
			}),
		);
		const resolveSelected = vi.fn(async () => routeAuthority);
		if (!routeLessResume) throw new Error("route-less Resume did not parse");
		await expect(
			resolveManagedAgentRehostRouteAuthority(routeLessResume, resolveSelected),
		).resolves.toEqual(routeAuthority);
		expect(resolveSelected).toHaveBeenCalledOnce();
		expect(resolveSelected).toHaveBeenLastCalledWith("local");

		const fresh = parseManagedAgentRehostSyncPayload(
			payload({
				launchKind: "fresh",
				backendRouteAuthority: undefined,
				sourceConversationId: null,
				conversationId: null,
			}),
		);
		if (!fresh) throw new Error("fresh rehost payload did not parse");
		await expect(
			resolveManagedAgentRehostRouteAuthority(fresh, resolveSelected),
		).resolves.toEqual(routeAuthority);
		expect(resolveSelected).toHaveBeenCalledTimes(2);
		expect(resolveSelected).toHaveBeenLastCalledWith("local");
	});

	it("parses a Control Plane conversation refinement for a committed fresh operation", () => {
		expect(
			parseManagedAgentRehostSyncPayload(
				payload({
					launchKind: "fresh",
					sourceConversationId: null,
					conversationId: "conversation-live",
				}),
			),
		).toMatchObject({
			launchKind: "fresh",
			conversationId: "conversation-live",
		});
	});
});
