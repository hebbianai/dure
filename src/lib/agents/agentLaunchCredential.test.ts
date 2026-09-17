import { beforeEach, describe, expect, it } from "vitest";
import { addAgent, adoptAgent } from "@/lib/agents/agentRegistration";
import {
	AgentLaunchCredentialUnavailableError,
	agentCredentialReferenceId,
	initialAgentLaunchAccountId,
	resolveAgentLaunchCredential,
} from "@/lib/agents/agentLaunchCredential";
import { useStore } from "@/store";
import type { AccountProfile, Project } from "@/types";

const project: Project = {
	id: "project-local",
	name: "repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const codexWork: AccountProfile = {
	id: "account-codex-work",
	provider: "codex",
	name: "Work",
	dir: "/accounts/codex-work",
};

const claudePersonal: AccountProfile = {
	id: "account-claude-personal",
	provider: "claude",
	name: "Personal",
	dir: "/accounts/claude-personal",
};

describe("agent runtime credential authority", () => {
	it("prefers the committed execution profile over compatibility fields", () => {
		expect(
			agentCredentialReferenceId({
				executionProfile: {
					kind: "credential_reference",
					reference_id: codexWork.id,
					credential_generation: "generation-1",
				},
				credentialId: "stale-credential",
				accountId: "stale-account",
			}),
		).toBe(codexWork.id);
	});

	it("lets an explicit provider default override stale compatibility fields", () => {
		expect(
			agentCredentialReferenceId({
				executionProfile: { kind: "provider_default" },
				credentialId: codexWork.id,
			}),
		).toBeUndefined();
	});

	it("recovers the managed binding credential for a pre-profile pane", () => {
		expect(
			agentCredentialReferenceId({
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_managed_v1",
					source: "local",
					hostId: "local",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					credentialId: codexWork.id,
				},
			}),
		).toBe(codexWork.id);
	});
});

describe("resolveAgentLaunchCredential", () => {
	it("pins a clean user's provider default without inventing a credential id", () => {
		expect(
			resolveAgentLaunchCredential({
				provider: "codex",
				accounts: [],
			}),
		).toEqual({ accountId: null });
	});

	it("snapshots a valid active account for callers without an explicit choice", () => {
		expect(
			resolveAgentLaunchCredential({
				provider: "codex",
				activeAccountId: codexWork.id,
				accounts: [codexWork],
			}),
		).toEqual({
			accountId: codexWork.id,
			credentialId: codexWork.id,
			account: codexWork,
		});
	});

	it("lets an explicit provider default override the active profile", () => {
		expect(
			resolveAgentLaunchCredential({
				provider: "codex",
				requestedAccountId: null,
				activeAccountId: codexWork.id,
				accounts: [codexWork],
			}),
		).toEqual({ accountId: null });
	});

	it("rejects stale and cross-provider references before launch", () => {
		for (const accountId of ["missing", claudePersonal.id]) {
			expect(() =>
				resolveAgentLaunchCredential({
					provider: "codex",
					requestedAccountId: accountId,
					accounts: [claudePersonal],
				}),
			).toThrow(AgentLaunchCredentialUnavailableError);
		}
	});

	it("does not expose an account selector for runtime-default providers", () => {
		expect(
			initialAgentLaunchAccountId("gemini", [codexWork], codexWork.id),
		).toBeNull();
		expect(
			resolveAgentLaunchCredential({
				provider: "gemini",
				requestedAccountId: null,
				accounts: [codexWork],
			}),
		).toEqual({});
	});
});

describe("addAgent initial credential binding", () => {
	beforeEach(() => {
		useStore.setState({
			projects: [project],
			agents: [],
			accounts: [codexWork, claudePersonal],
			activeAccounts: { codex: codexWork.id },
		});
	});

	it("copies an explicit profile to the Agent and managed binding atomically", async () => {
		const agent = await addAgent({
			projectId: project.id,
			name: "codex-selected",
			provider: "codex",
			useWorktree: false,
			accountId: codexWork.id,
		});

		expect(agent).toMatchObject({
			accountId: codexWork.id,
			credentialId: codexWork.id,
			runtimeBinding: {
				runtime: "hmux_managed_v1",
				credentialId: codexWork.id,
			},
		});
		expect(agent.runtimeBinding).not.toHaveProperty("credentialGeneration");
	});

	it("pins the explicit default even when another account is globally active", async () => {
		const agent = await addAgent({
			projectId: project.id,
			name: "codex-default",
			provider: "codex",
			useWorktree: false,
			accountId: null,
		});

		expect(agent.accountId).toBeNull();
		expect(agent).not.toHaveProperty("credentialId");
		expect(agent.runtimeBinding).not.toHaveProperty("credentialId");
	});

	it("fails before registration when a selected account no longer exists", async () => {
		await expect(
			addAgent({
				projectId: project.id,
				name: "codex-missing",
				provider: "codex",
				useWorktree: false,
				accountId: "account-gone",
			}),
		).rejects.toBeInstanceOf(AgentLaunchCredentialUnavailableError);
		expect(useStore.getState().agents).toEqual([]);
	});
});

describe("adoptAgent runtime binding", () => {
	it("adopts an SSH-project session onto the remote managed runtime", async () => {
		useStore.setState({
			projects: [
				{
					id: "project-ssh",
					name: "remote-repo",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: "host-1",
					isRepo: true,
				},
			],
			agents: [],
			accounts: [],
			activeAccounts: {},
		});

		const agent = await adoptAgent({
			projectId: "project-ssh",
			provider: "codex",
			worktreePath: "/srv/repo/.worktrees/feature",
			branch: "feature",
			resume: true,
		});

		expect(agent.runtimeBinding).toMatchObject({
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-1",
			workspaceId: "project-ssh",
			createIdempotencyKey: agent.id,
			commandBridgeNonce: `bridge_${agent.id}`,
		});
		expect(agent.started).toBe(true);
	});
});
