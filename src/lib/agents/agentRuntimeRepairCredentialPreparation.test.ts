import { describe, expect, it } from "vitest";
import { createAgentRuntimeRepairCredentialPreparation } from "@/lib/agents/agentRuntimeRepairCredentialPreparation";
import type { AgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import type {
	DureAgentRuntimeProjectionContextV1,
	DureAgentRuntimeRepairIntentV1,
} from "@/lib/ipc/dureAgentRuntime";
import { agentFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent } from "@/types";

const project = {
	id: "project-1",
	name: "Project",
	path: "/repo",
	kind: "local" as const,
	isRepo: true,
};

const accounts = [
	{
		id: "account-a",
		provider: "codex" as const,
		name: "Codex A",
		dir: "/profiles/codex-account-a",
	},
	{
		id: "account-b",
		provider: "codex" as const,
		name: "Codex B",
		dir: "/profiles/codex-account-b",
	},
];

function repairIntent(
	sourceExecutionProfile: AgentExecutionProfileV1,
): DureAgentRuntimeRepairIntentV1 {
	const routeAuthority = testDureBackendRouteAuthority(
		"dure-local",
		"generation-1",
	);
	return {
		state: "repair_required",
		agentId: "agent-1",
		operationId: "operation-1",
		journalRevision: 3,
		sourceSelectionRevision: 2,
		sourceInteractionProfile: "native_cli",
		targetInteractionProfile: "native_cli",
		sourceExecutionProfile,
		targetExecutionProfile: sourceExecutionProfile,
		sourceLaunchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
		targetLaunchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
		failureKind: "credential_stale",
		providerCode: "credential_generation_stale",
		backend: {
			id: "dure-local",
			generation: "generation-1",
		},
		backendProfileId: "local",
		routeAuthority,
	};
}

function projectionContext(): DureAgentRuntimeProjectionContextV1 {
	return {
		schemaVersion: 1,
		identity: { kind: "registered" },
		agent: {
			agentId: "agent-1",
			workspaceId: "workspace-1",
			providerId: "codex",
		},
		workspace: {
			workspaceId: "workspace-1",
			projectId: project.id,
			rootPath: "/repo/.worktrees/agent-1",
		},
		project: { projectId: project.id, rootPath: project.path },
	};
}

describe("agent runtime repair credential preparation", () => {
	it("selects the backend source credential instead of the stale frontend projection", () => {
		const preparation = createAgentRuntimeRepairCredentialPreparation({
			required: repairIntent({
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "credential-generation-7",
			}),
			agent: agentFixture({
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-b",
					credential_generation: "credential-generation-4",
				},
			}),
			accounts,
			sshHosts: [],
		});

		expect(preparation?.targetCredentialId).toBe("account-a");
	});

	it("uses projection context material for a route-less Agent", () => {
		const routeLessAgent = agentFixture({
			projectId: undefined,
			worktreePath: undefined,
		}) as unknown as Agent;
		const preparation = createAgentRuntimeRepairCredentialPreparation({
			required: repairIntent({
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "credential-generation-7",
			}),
			projectionContext: projectionContext(),
			agent: routeLessAgent,
			accounts,
			sshHosts: [],
		});

		expect(preparation?.targetCredentialId).toBe("account-a");
	});

	it("keeps missing account material explicit only when preparation is needed", async () => {
		const required = repairIntent({
			kind: "credential_reference",
			reference_id: "account-missing",
			credential_generation: "credential-generation-7",
		});
		const preparation = createAgentRuntimeRepairCredentialPreparation({
			required,
			agent: agentFixture(),
			accounts,
			sshHosts: [],
		});

		expect(preparation.targetCredentialId).toBe("account-missing");
		await expect(
			preparation({
				routeAuthority: required.routeAuthority,
				checkpoint: () => {},
				assertRouteAuthority: async () => {},
			}),
		).rejects.toThrow("credential_reference_unavailable");
	});
});
