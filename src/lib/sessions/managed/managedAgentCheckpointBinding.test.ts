import { beforeEach, describe, expect, it, vi } from "vitest";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { DureWorkflowError } from "@/lib/ipc/dureWorkflow";

const mocks = vi.hoisted(() => ({ registerCredential: vi.fn() }));

vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.registerCredential,
}));

import {
	adoptCurrentManagedAgentCheckpoint,
	commitManagedAgentCheckpointBinding,
} from "@/lib/sessions/managed/managedAgentCheckpointBinding";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

describe("managed Agent checkpoint binding", () => {
	beforeEach(() => {
		mocks.registerCredential.mockReset();
		useStore.setState({ agents: [], projects: [], accounts: [], sshHosts: [] });
	});

	it("adopts one exact local managed checkpoint", async () => {
		const binding = managedBindingFixture({
			backendProfileId: "local",
			stopFence: stopFenceFixture(),
		});
		const agent = managedAgentFixture({
			id: "agent-local",
			projectId: "project-local",
			runtimeBinding: binding,
		});
		const routeAuthority = testDureBackendRouteAuthority(
			"backend-local",
			"generation-1",
		);
		const commit = vi.fn().mockResolvedValue(agent);
		useStore.setState({
			agents: [agent],
			projects: [
				{
					id: "project-local",
					name: "Local",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
		});

		await expect(
			adoptCurrentManagedAgentCheckpoint(agent.id, routeAuthority, commit),
		).resolves.toBeUndefined();
		expect(commit).toHaveBeenCalledWith(routeAuthority, agent.id, binding);
	});

	it("does not submit a checkpoint without an exact stop fence", async () => {
		const agent = managedAgentFixture({
			id: "agent-local",
			projectId: "project-local",
			runtimeBinding: managedBindingFixture({ backendProfileId: "local" }),
		});
		const commit = vi.fn();
		useStore.setState({
			agents: [agent],
			projects: [
				{
					id: "project-local",
					name: "Local",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
		});

		await expect(
			adoptCurrentManagedAgentCheckpoint(
				agent.id,
				testDureBackendRouteAuthority("backend-local", "generation-1"),
				commit,
			),
		).rejects.toMatchObject({
			code: "agent_runtime_checkpoint_adoption_unsupported",
			failure: { kind: "operation", disposition: "terminal" },
		});
		expect(commit).not.toHaveBeenCalled();
	});

	it.each([
		"agent_checkpoint_binding_launch_authority_stale",
		"agent_checkpoint_binding_credential_authority_unsupported",
	])(
		"surfaces permanent adoption incompatibility without fallback %s",
		async (code) => {
			const agent = managedAgentFixture({
				id: "agent-local",
				projectId: "project-local",
				runtimeBinding: managedBindingFixture({
					backendProfileId: "local",
					stopFence: stopFenceFixture(),
				}),
			});
			useStore.setState({
				agents: [agent],
				projects: [
					{
						id: "project-local",
						name: "Local",
						path: "/repo",
						kind: "local",
						isRepo: true,
					},
				],
			});
			const error = new DureWorkflowError(code, code, {
				kind: "operation",
				disposition: "terminal",
			});

			await expect(
				adoptCurrentManagedAgentCheckpoint(
					agent.id,
					testDureBackendRouteAuthority("backend-local", "generation-1"),
					vi.fn().mockRejectedValue(error),
				),
			).rejects.toBe(error);
		},
	);

	it.each([
		"agent_checkpoint_binding_launch_authority_unavailable",
		"agent_checkpoint_binding_credential_unavailable",
		"agent_checkpoint_binding_runtime_owned",
	])("surfaces retryable or conflicting adoption failure %s", async (code) => {
		const agent = managedAgentFixture({
			id: "agent-local",
			projectId: "project-local",
			runtimeBinding: managedBindingFixture({
				backendProfileId: "local",
				stopFence: stopFenceFixture(),
			}),
		});
		useStore.setState({
			agents: [agent],
			projects: [
				{
					id: "project-local",
					name: "Local",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
		});
		const error = new DureWorkflowError(code, code, {
			kind: "operation",
			disposition: "terminal",
		});

		await expect(
			adoptCurrentManagedAgentCheckpoint(
				agent.id,
				testDureBackendRouteAuthority("backend-local", "generation-1"),
				vi.fn().mockRejectedValue(error),
			),
		).rejects.toBe(error);
	});

	it("does not hide credential-profile registration failures", async () => {
		const agent = managedAgentFixture({
			id: "agent-local",
			projectId: "project-local",
			runtimeBinding: managedBindingFixture({
				backendProfileId: "local",
				stopFence: stopFenceFixture(),
			}),
		});
		useStore.setState({
			agents: [agent],
			projects: [
				{
					id: "project-local",
					name: "Local",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
		});
		const error = new DureBackendRequestError(
			"provider_credential_profile_unavailable",
			"profile is not available",
			{ kind: "operation", disposition: "retry_same" },
		);

		await expect(
			adoptCurrentManagedAgentCheckpoint(
				agent.id,
				testDureBackendRouteAuthority("backend-local", "generation-1"),
				vi.fn().mockRejectedValue(error),
			),
		).rejects.toBe(error);
	});

	it("commits the accepted successor through its routed backend profile", async () => {
		const stages: string[] = [];
		mocks.registerCredential.mockImplementationOnce(async () => {
			stages.push("register");
			return {
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "generation-a-1",
			};
		});
		const ensureCoordinatorBinding = vi.fn(async () => {
			stages.push("ensure");
			return {
				agentId: "agent-1",
				sessionId: "session-new",
				bindingGeneration: 2,
			};
		});
		const createTransport = vi.fn(() => ({
			ensureCoordinatorBinding,
			delegateOnce: vi.fn(),
			inspectDispatchSession: vi.fn(),
			rebindDispatchSession: vi.fn(),
			reconcileDispatchSession: vi.fn(),
		}));
		const binding = managedBindingFixture({
			sessionId: "session-new",
			workspaceId: "workspace-runtime",
			backendProfileId: "remote-a",
			stopFence: stopFenceFixture({ channelEpoch: "9" }),
			credentialId: "account-a",
		});

		useStore.setState({
			agents: [
				managedAgentFixture({
					id: "agent-1",
					name: "agent-slug",
					displayName: "Research agent",
					worktreePath: "/repo/research",
				}),
			],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "A",
					dir: "/profiles/codex-a",
				},
			],
		});

		await commitManagedAgentCheckpointBinding(
			testDureBackendRouteAuthority(
				"backend-remote-a",
				"generation-1",
				"remote-a",
			),
			"agent-1",
			binding,
			createTransport,
		);

		expect(createTransport).toHaveBeenCalledWith({ profileId: "remote-a" });
		expect(mocks.registerCredential).toHaveBeenCalledWith(
			{
				providerId: "codex",
				referenceId: "account-a",
				profileDirectoryName: "codex-a",
			},
			{
				profileId: "remote-a",
				routeAuthority: testDureBackendRouteAuthority(
					"backend-remote-a",
					"generation-1",
					"remote-a",
				),
			},
		);
		expect(stages).toEqual(["register", "ensure"]);
		expect(ensureCoordinatorBinding).toHaveBeenCalledWith(
			testDureBackendRouteAuthority(
				"backend-remote-a",
				"generation-1",
				"remote-a",
			),
			{
				schemaVersion: 1,
				agentId: "agent-1",
				sessionId: "session-new",
				workspaceId: "workspace-runtime",
				displayName: "Research agent",
				worktreePath: "/repo/research",
				stopFence: binding.stopFence,
			},
		);
	});

	it("never guesses the local backend profile for an SSH checkpoint", async () => {
		const createTransport = vi.fn();
		useStore.setState({
			agents: [
				managedAgentFixture({
					id: "agent-remote",
					worktreePath: "/srv/repo",
				}),
			],
		});

		await expect(
			commitManagedAgentCheckpointBinding(
				testDureBackendRouteAuthority("backend-local", "generation-1", "local"),
				"agent-remote",
				{
					schemaVersion: 1,
					runtime: "hmux_managed_v1",
					source: "ssh",
					hostId: "host-1",
					sessionId: "session-remote",
					workspaceId: "workspace-remote",
					createIdempotencyKey: "create-remote",
					commandBridgeNonce: "bridge-remote",
					stopFence: stopFenceFixture(),
				},
				createTransport,
			),
		).rejects.toThrow(
			"managed_agent_checkpoint_binding_route_profile_mismatch",
		);
		expect(createTransport).not.toHaveBeenCalled();
	});

	it("registers an exact SSH binding profile without a frontend account row", async () => {
		mocks.registerCredential.mockResolvedValueOnce({
			kind: "credential_reference",
			reference_id: "remote-account",
			credential_generation: "remote-generation-1",
		});
		const ensureCoordinatorBinding = vi.fn().mockResolvedValue({
			agentId: "agent-remote",
			sessionId: "session-remote",
			bindingGeneration: 1,
		});
		const createTransport = vi.fn(() => ({
			ensureCoordinatorBinding,
			delegateOnce: vi.fn(),
			inspectDispatchSession: vi.fn(),
			rebindDispatchSession: vi.fn(),
			reconcileDispatchSession: vi.fn(),
		}));
		const routeAuthority = testDureBackendRouteAuthority(
			"backend-remote",
			"generation-1",
			"remote-primary",
		);
		const binding = {
			schemaVersion: 1 as const,
			runtime: "hmux_managed_v1" as const,
			source: "ssh" as const,
			hostId: "host-1",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			createIdempotencyKey: "create-remote",
			commandBridgeNonce: "bridge-remote",
			backendProfileId: "remote-primary",
			stopFence: stopFenceFixture(),
			credentialId: "remote-account",
			credentialProfileDirectory: ".dure/accounts/codex-remote",
		};
		useStore.setState({
			agents: [
				managedAgentFixture({
					id: "agent-remote",
					worktreePath: "/srv/repo",
				}),
			],
			accounts: [],
		});

		await commitManagedAgentCheckpointBinding(
			routeAuthority,
			"agent-remote",
			binding,
			createTransport,
		);

		expect(mocks.registerCredential).toHaveBeenCalledWith(
			{
				providerId: "codex",
				referenceId: "remote-account",
				profileDirectoryName: "codex-remote",
			},
			{ profileId: "remote-primary", routeAuthority },
		);
		expect(ensureCoordinatorBinding).toHaveBeenCalledOnce();
	});

	it("lets the backend decide a missing frontend account from durable credential authority", async () => {
		const ensureError = new Error(
			"agent_checkpoint_binding_credential_authority_unsupported",
		);
		const ensureCoordinatorBinding = vi.fn().mockRejectedValue(ensureError);
		const createTransport = vi.fn(() => ({
			ensureCoordinatorBinding,
			delegateOnce: vi.fn(),
			inspectDispatchSession: vi.fn(),
			rebindDispatchSession: vi.fn(),
			reconcileDispatchSession: vi.fn(),
		}));
		const binding = managedBindingFixture({
			credentialId: "account-not-loaded",
			stopFence: stopFenceFixture(),
		});
		useStore.setState({
			agents: [managedAgentFixture({ id: "agent-legacy" })],
			accounts: [],
		});

		await expect(
			commitManagedAgentCheckpointBinding(
				testDureBackendRouteAuthority("backend-local", "generation-1"),
				"agent-legacy",
				binding,
				createTransport,
			),
		).rejects.toBe(ensureError);
		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(ensureCoordinatorBinding).toHaveBeenCalledOnce();
	});
});
