import { beforeEach, expect, it, vi } from "vitest";

const routeA = {
	schemaVersion: 1 as const,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-a", generation: "generation-a" },
	target: { source: "local" as const, hostId: "local" as const },
};

const { state } = vi.hoisted(() => ({
	state: {
		selectedBackend: "backend-a",
		effects: {
			"backend-a": [] as string[],
			"backend-b": [] as string[],
		},
		spawnRequests: [] as Array<Record<string, unknown>>,
		spawnAttempts: 0,
		resolveRoute: vi.fn(),
		backendRequest: vi.fn(),
		run: vi.fn(),
	},
}));

function selectedEffects(): string[] {
	return state.effects[state.selectedBackend as keyof typeof state.effects];
}

function exactEffects(
	routeAuthority: { readonly backend: { readonly id: string } } | undefined,
): string[] {
	return routeAuthority
		? state.effects[routeAuthority.backend.id as keyof typeof state.effects]
		: selectedEffects();
}

vi.mock("@/lib/agents/promptIdentity", () => ({
	computePromptIdentity: vi.fn().mockResolvedValue({
		promptDigest: `sha256:${"c".repeat(64)}`,
	}),
}));
vi.mock("@/lib/cli/managedRunBackgroundPresentation", () => ({
	presentManagedRunInBackground: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/cli/cliManagedRunPresentation", () => ({
	presentManagedRun: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/agents/structuredRunPresentation", () => ({
	presentStructuredRun: vi.fn().mockResolvedValue({}),
	presentStructuredRunInBackground: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/ipc/git", () => ({
	gitExecLocal: vi.fn().mockResolvedValue({
		stdout: "d".repeat(40),
		stderr: "",
		code: 0,
	}),
}));
vi.mock("@/lib/ipc/dureBackend", () => ({
	createDureBackendRequester: () => state.backendRequest,
	resolveSelectedDureBackendRouteAuthority: state.resolveRoute,
}));
vi.mock("@/lib/ipc/dureAgentRun", () => ({
	canonicalAddAgentRunIdempotencyKey: (actionId = "action-1") =>
		`add-agent:${actionId}`,
	createDureAgentRunTransport: () => ({ run: state.run }),
}));
import { runCanonicalAddAgentInBackground } from "@/lib/agents/addAgentCanonicalRun";

beforeEach(() => {
	state.selectedBackend = "backend-a";
	state.effects["backend-a"] = [];
	state.effects["backend-b"] = [];
	state.spawnRequests = [];
	state.spawnAttempts = 0;
	state.resolveRoute.mockReset().mockResolvedValue(routeA);
	state.backendRequest.mockReset().mockImplementation(
		async (
			operation: string,
			_body: Record<string, unknown>,
			request?: {
				kind: "exact";
				authority: typeof routeA;
			},
		) => {
			exactEffects(request?.authority).push(operation);
			if (operation === "provider_credential_profile.register") {
				state.selectedBackend = "backend-b";
				return {
					result: {
						schemaVersion: 1,
						profile: {
							schemaVersion: 1,
							providerId: "claude",
							referenceId: "acc-hebbian98",
							credentialGeneration: "credential-hebbian98-exact",
						},
					},
				};
			}
			return { result: { schemaVersion: 1 } };
		},
	);
	state.run
		.mockReset()
		.mockImplementation(
			async (
				request: Record<string, unknown>,
				routeAuthority?: typeof routeA,
			) => {
				state.spawnRequests.push(request);
				const backendId = routeAuthority?.backend.id ?? state.selectedBackend;
				const effects = exactEffects(routeAuthority);
				effects.push("agent_spawn.preview");
				state.spawnAttempts += 1;
				if (state.spawnAttempts === 1) {
					throw Object.assign(new Error("agent_spawn_project_not_found"), {
						code: "agent_spawn_project_not_found",
					});
				}
				effects.push("agent_spawn.apply");
				return {
					schemaVersion: 1,
					backend: { id: backendId, generation: `generation-${backendId}` },
					operationId: "operation-1",
					agentId: "agent-1",
					agentName: "fix-route",
					projectId: "project-1",
					providerId: "claude",
					executionProfile: request.executionProfile,
					interactionProfile: "native_cli",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					worktree: { kind: "project_root" },
					generation: {},
					permissionMode: "default",
				};
			},
		);
});

it("keeps credential, project admission, and spawn effects on one leased route when selection changes", async () => {
	const result = await runCanonicalAddAgentInBackground({
		project: {
			id: "project-1",
			name: "Project",
			path: "/repo",
			kind: "local",
			isRepo: true,
		},
		actionId: "action-route-1",
		agentName: "fix-route",
		provider: "claude",
		accountId: "acc-hebbian98",
		account: {
			id: "acc-hebbian98",
			provider: "claude",
			name: "hebbian98",
			dir: "/Users/test/.dure/accounts/claude-hebbian98",
		},
		useWorktree: false,
		setupCommand: null,
	});

	expect(state.effects["backend-b"]).toEqual([]);
	expect(state.effects["backend-a"]).toEqual([
		"provider_credential_profile.register",
		"agent_spawn.preview",
		"projects.register",
		"agent_spawn.preview",
		"agent_spawn.apply",
	]);
	expect(state.resolveRoute).toHaveBeenCalledTimes(1);
	expect(state.resolveRoute).toHaveBeenCalledWith("local");
	expect(state.resolveRoute.mock.invocationCallOrder[0]).toBeLessThan(
		state.backendRequest.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
	);
	expect(state.spawnRequests).toHaveLength(2);
	expect(state.spawnRequests).toEqual([
		expect.objectContaining({
			executionProfile: {
				kind: "credential_reference",
				reference_id: "acc-hebbian98",
				credential_generation: "credential-hebbian98-exact",
			},
		}),
		expect.objectContaining({
			executionProfile: {
				kind: "credential_reference",
				reference_id: "acc-hebbian98",
				credential_generation: "credential-hebbian98-exact",
			},
		}),
	]);
	expect(result.executionProfile).toEqual({
		kind: "credential_reference",
		reference_id: "acc-hebbian98",
		credential_generation: "credential-hebbian98-exact",
	});
});
