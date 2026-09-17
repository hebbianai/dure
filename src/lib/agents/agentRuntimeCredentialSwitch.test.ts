import { describe, expect, it, vi } from "vitest";
import {
	type AgentRuntimeCredentialPreparation,
	type AgentRuntimeCredentialPreparationInput,
	createAgentRuntimeCredentialPreparation,
} from "@/lib/agents/agentRuntimeCredentialSwitch";
import type { AgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import type { RemoteAccountLaunchPreflight } from "@/lib/agents/remoteAccountOverlay";
import { assertDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import type { AccountProfile, SshHostConfig } from "@/types";

const account: AccountProfile = {
	id: "account-b",
	provider: "claude",
	name: "Claude B",
	dir: "/profiles/claude-account-b",
};

const remoteHost: SshHostConfig = {
	id: "ssh-host-1",
	name: "Remote",
	host: "example.test",
	port: 22,
	user: "developer",
	auth: "auto",
};

function routeAuthority(
	profileId = "local",
	host: SshHostConfig = remoteHost,
): DureBackendRouteAuthorityV1 {
	return {
		schemaVersion: 1,
		profileId,
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "backend-1", generation: "generation-1" },
		target:
			profileId === "local"
				? { source: "local", hostId: "local" }
				: {
						source: "ssh",
						hostId: profileId,
						remote: {
							host: host.host,
							port: host.port,
							user: host.user,
						},
					},
	};
}

function preparationLease(
	authority: DureBackendRouteAuthorityV1,
	assertRouteAuthority: () => Promise<void> = vi.fn(async () => {}),
	checkpoint: () => void = vi.fn(),
) {
	return {
		routeAuthority: authority,
		checkpoint,
		assertRouteAuthority,
	};
}

type CredentialPreparationDependencies = NonNullable<
	Parameters<typeof createAgentRuntimeCredentialPreparation>[1]
>;

function credentialDependencies(
	register: CredentialPreparationDependencies["register"],
	preflightRemote: CredentialPreparationDependencies["preflightRemote"],
): CredentialPreparationDependencies {
	return {
		register,
		preflightRemote,
	};
}

type PreparedCredentialTransition = (
	agentId: string,
	backendProfileId: string,
	prepare: AgentRuntimeCredentialPreparation,
) => Promise<void>;

async function exerciseCredentialPreparation(
	input: AgentRuntimeCredentialPreparationInput,
	transition: PreparedCredentialTransition,
	dependencies: CredentialPreparationDependencies,
) {
	await transition(
		input.agentId,
		input.backendProfileId,
		createAgentRuntimeCredentialPreparation(input, dependencies),
	);
}

describe("agent runtime credential switch", () => {
	it.each(["claude", "codex"] as const)(
		"registers %s on its exact route without a separate route query",
		async (provider) => {
			const authority = routeAuthority();
			const invoke = vi.fn(async (command: string) =>
				command === "dure_backend_route_assert"
					? authority
					: {
							schemaVersion: 1,
							backendId: authority.backend.id,
							backendGeneration: authority.backend.generation,
							routeAuthority: authority,
							result: {
								schemaVersion: 1,
								profile: {
									schemaVersion: 1,
									providerId: provider,
									referenceId: account.id,
									credentialGeneration: "credential-b-9",
								},
							},
						},
			);
			const prepare = createAgentRuntimeCredentialPreparation(
				{
					agentId: "agent-1",
					provider,
					backendProfileId: "local",
					account: { ...account, provider, dir: `/profiles/${provider}-work` },
				},
				credentialDependencies(
					(request, options) =>
						registerDureProviderCredentialProfile(request, {
							...options,
							invokeCommand: invoke,
						}),
					vi.fn(),
				),
			);

			await expect(
				prepare(
					preparationLease(authority, async () => {
						await assertDureBackendRouteAuthority(authority, invoke);
					}),
				),
			).resolves.toEqual({
				kind: "credential_reference",
				reference_id: account.id,
				credential_generation: "credential-b-9",
			});
			expect(invoke.mock.calls.map(([command]) => command)).toEqual([
				"dure_backend_request",
			]);
			expect(invoke).toHaveBeenCalledWith("dure_backend_request", {
				route: { kind: "exact", authority },
				operation: "provider_credential_profile.register",
				body: {
					schemaVersion: 1,
					providerId: provider,
					referenceId: account.id,
					profileDirectoryName: `${provider}-work`,
				},
			});
		},
	);

	it("does not transition when registration rejects the captured route", async () => {
		const authority = routeAuthority();
		const invoke = vi.fn().mockRejectedValue({
			code: "backend_transport_authority_changed",
			message: "the backend route changed",
		});
		const runtimeTransition = vi.fn();
		const prepare = createAgentRuntimeCredentialPreparation(
			{
				agentId: "agent-1",
				provider: "claude",
				backendProfileId: "local",
				account,
			},
			credentialDependencies(
				(request, options) =>
					registerDureProviderCredentialProfile(request, {
						...options,
						invokeCommand: invoke,
					}),
				vi.fn(),
			),
		);

		await expect(
			prepare(preparationLease(authority)).then(runtimeTransition),
		).rejects.toMatchObject({ code: "backend_transport_authority_changed" });
		expect(invoke).toHaveBeenCalledOnce();
		expect(invoke).toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({ route: { kind: "exact", authority } }),
		);
		expect(runtimeTransition).not.toHaveBeenCalled();
	});

	it("registers one exact local generation before requesting replacement", async () => {
		const authority = routeAuthority();
		const register = vi.fn().mockResolvedValue({
			kind: "credential_reference",
			reference_id: "account-b",
			credential_generation: "credential-b-9",
		});
		const runtimeTransition = vi.fn().mockResolvedValue(undefined);
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				expect(prepare.targetCredentialId).toBe(account.id);
				const executionProfile = await prepare(preparationLease(authority));
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);
		const preflightRemote = vi.fn();

		await exerciseCredentialPreparation(
			{
				agentId: "agent-1",
				provider: "claude",
				backendProfileId: "local",
				account,
			},
			transition,
			credentialDependencies(register, preflightRemote),
		);

		expect(preflightRemote).not.toHaveBeenCalled();
		expect(register).toHaveBeenCalledWith(
			{
				providerId: "claude",
				referenceId: "account-b",
				profileDirectoryName: "claude-account-b",
			},
			{ profileId: "local", routeAuthority: authority },
		);
		expect(transition).toHaveBeenCalledWith(
			"agent-1",
			"local",
			expect.any(Function),
		);
		expect(runtimeTransition).toHaveBeenCalledWith("agent-1", "local", {
			kind: "credential_reference",
			reference_id: "account-b",
			credential_generation: "credential-b-9",
		});
	});

	it("registers a fresh generation when the same account is reselected", async () => {
		const authority = routeAuthority();
		const register = vi
			.fn()
			.mockResolvedValueOnce({
				kind: "credential_reference",
				reference_id: account.id,
				credential_generation: "credential-b-9",
			})
			.mockResolvedValueOnce({
				kind: "credential_reference",
				reference_id: account.id,
				credential_generation: "credential-b-10",
			});
		const submitted: AgentExecutionProfileV1[] = [];
		const transition: PreparedCredentialTransition = vi.fn(
			async (_agentId, _backendProfileId, prepare) => {
				submitted.push(await prepare(preparationLease(authority)));
			},
		);
		const input = {
			agentId: "agent-1",
			provider: "claude" as const,
			backendProfileId: "local",
			account,
		};

		await exerciseCredentialPreparation(
			input,
			transition,
			credentialDependencies(register, vi.fn()),
		);
		await exerciseCredentialPreparation(
			input,
			transition,
			credentialDependencies(register, vi.fn()),
		);

		expect(register).toHaveBeenCalledTimes(2);
		expect(submitted).toEqual([
			{
				kind: "credential_reference",
				reference_id: account.id,
				credential_generation: "credential-b-9",
			},
			{
				kind: "credential_reference",
				reference_id: account.id,
				credential_generation: "credential-b-10",
			},
		]);
	});

	it("preflights the remote account before registering and transitioning", async () => {
		const authority = routeAuthority("ssh-profile-1");
		const assertRouteAuthority = vi.fn(async () => {});
		const order: string[] = [];
		const preflightRemote = vi
			.fn()
			.mockImplementation(async (_host, _provider, _cwd, _account, options) => {
				order.push("preflight");
				await options.beforeOverlay();
			});
		const register = vi.fn().mockImplementation(async () => {
			order.push("register");
			return {
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "credential-b-remote-1",
			};
		});
		const runtimeTransition = vi.fn().mockImplementation(async () => {
			order.push("transition");
		});
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				expect(prepare.targetCredentialId).toBe(account.id);
				const executionProfile = await prepare(
					preparationLease(authority, assertRouteAuthority),
				);
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);

		await exerciseCredentialPreparation(
			{
				agentId: "agent-remote",
				provider: "claude",
				backendProfileId: "ssh-profile-1",
				account,
				remote: {
					host: remoteHost,
					workingDirectory: "/srv/repo",
				},
			},
			transition,
			credentialDependencies(register, preflightRemote),
		);

		expect(order).toEqual(["preflight", "register", "transition"]);
		expect(assertRouteAuthority).toHaveBeenCalledTimes(2);
		expect(preflightRemote).toHaveBeenCalledWith(
			remoteHost,
			"claude",
			"/srv/repo",
			account,
			{
				requireCredential: true,
				beforeOverlay: expect.any(Function),
			},
		);
		expect(register).toHaveBeenCalledWith(expect.any(Object), {
			profileId: "ssh-profile-1",
			routeAuthority: authority,
		});
		expect(runtimeTransition).toHaveBeenCalledWith(
			"agent-remote",
			"ssh-profile-1",
			{
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "credential-b-remote-1",
			},
		);
	});

	it("selects provider default without registering a profile", async () => {
		const authority = routeAuthority();
		const register = vi.fn();
		const runtimeTransition = vi.fn().mockResolvedValue(undefined);
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				expect(prepare.targetCredentialId).toBeNull();
				const executionProfile = await prepare(preparationLease(authority));
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);
		const preflightRemote = vi.fn();

		await exerciseCredentialPreparation(
			{
				agentId: "agent-1",
				provider: "claude",
				backendProfileId: "local",
			},
			transition,
			credentialDependencies(register, preflightRemote),
		);

		expect(register).not.toHaveBeenCalled();
		expect(runtimeTransition).toHaveBeenCalledWith("agent-1", "local", {
			kind: "provider_default",
		});
	});

	it("does not prepare credentials before a stale route is admitted", async () => {
		const preflightRemote = vi.fn();
		const register = vi.fn().mockResolvedValue({
			kind: "credential_reference",
			reference_id: "account-b",
			credential_generation: "credential-b-remote-1",
		});
		const runtimeTransition = vi.fn();
		const transition: PreparedCredentialTransition = vi.fn(async () => {
			throw new Error("client_agent_runtime_transition_conflict");
		});

		await expect(
			exerciseCredentialPreparation(
				{
					agentId: "agent-remote",
					provider: "claude",
					backendProfileId: "ssh-profile-a",
					account,
					remote: {
						host: remoteHost,
						workingDirectory: "/srv/repo",
					},
				},
				transition,
				credentialDependencies(register, preflightRemote),
			),
		).rejects.toThrow("client_agent_runtime_transition_conflict");

		expect(transition).toHaveBeenCalledOnce();
		expect(preflightRemote).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
		expect(runtimeTransition).not.toHaveBeenCalled();
	});

	it("performs no SSH or backend effects when exact authority changes before preflight", async () => {
		const authority = routeAuthority("ssh-profile-1");
		const authorityChanged = new Error("backend_transport_authority_changed");
		const assertRouteAuthority = vi.fn().mockRejectedValue(authorityChanged);
		const preflightRemote = vi.fn();
		const register = vi.fn();
		const runtimeTransition = vi.fn();
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				const executionProfile = await prepare(
					preparationLease(authority, assertRouteAuthority),
				);
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);

		await expect(
			exerciseCredentialPreparation(
				{
					agentId: "agent-remote",
					provider: "claude",
					backendProfileId: "ssh-profile-1",
					account,
					remote: { host: remoteHost, workingDirectory: "/srv/repo" },
				},
				transition,
				credentialDependencies(register, preflightRemote),
			),
		).rejects.toBe(authorityChanged);

		expect(assertRouteAuthority).toHaveBeenCalledOnce();
		expect(preflightRemote).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
		expect(runtimeTransition).not.toHaveBeenCalled();
	});

	it("performs no effects when the exact route does not own the project host", async () => {
		const mismatchedHost: SshHostConfig = {
			...remoteHost,
			id: "other-host",
			host: "other.example.test",
		};
		const authority = routeAuthority("ssh-profile-1", mismatchedHost);
		const preflightRemote = vi.fn();
		const register = vi.fn();
		const runtimeTransition = vi.fn();
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				const executionProfile = await prepare(preparationLease(authority));
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);

		await expect(
			exerciseCredentialPreparation(
				{
					agentId: "agent-remote",
					provider: "claude",
					backendProfileId: "ssh-profile-1",
					account,
					remote: { host: remoteHost, workingDirectory: "/srv/repo" },
				},
				transition,
				credentialDependencies(register, preflightRemote),
			),
		).rejects.toMatchObject({ code: "client_backend_host_unmapped" });

		expect(preflightRemote).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
		expect(runtimeTransition).not.toHaveBeenCalled();
	});

	it("performs no overlay or backend effects when authority changes before overlay", async () => {
		const authority = routeAuthority("ssh-profile-1");
		const authorityChanged = new Error("backend_transport_authority_changed");
		const assertRouteAuthority = vi
			.fn()
			.mockResolvedValueOnce(authority)
			.mockRejectedValueOnce(authorityChanged);
		const order: string[] = [];
		const preflightRemote = vi.fn(
			async (_host, _provider, _cwd, _account, options) => {
				order.push("ssh");
				await options.beforeOverlay?.();
				order.push("overlay");
				return { version: "2.1.234" };
			},
		);
		const register = vi.fn().mockImplementation(async () => {
			order.push("register");
			return { kind: "provider_default" as const };
		});
		const runtimeTransition = vi.fn().mockImplementation(async () => {
			order.push("transition");
		});
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				const executionProfile = await prepare(
					preparationLease(authority, assertRouteAuthority),
				);
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);

		await expect(
			exerciseCredentialPreparation(
				{
					agentId: "agent-remote",
					provider: "claude",
					backendProfileId: "ssh-profile-1",
					account,
					remote: { host: remoteHost, workingDirectory: "/srv/repo" },
				},
				transition,
				credentialDependencies(register, preflightRemote),
			),
		).rejects.toBe(authorityChanged);

		expect(order).toEqual(["ssh"]);
		expect(assertRouteAuthority).toHaveBeenCalledTimes(2);
		expect(register).not.toHaveBeenCalled();
		expect(runtimeTransition).not.toHaveBeenCalled();
	});

	it("stops after a route changes during remote preflight", async () => {
		const authority = routeAuthority("ssh-profile-a");
		let current = true;
		let finishPreflight!: () => void;
		const preflightRemote = vi.fn(
			() =>
				new Promise<RemoteAccountLaunchPreflight>((resolve) => {
					finishPreflight = () => resolve({ version: "2.1.234" });
				}),
		);
		const register = vi.fn();
		const runtimeTransition = vi.fn();
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				const checkpoint = () => {
					if (!current) {
						throw new Error("client_agent_runtime_transition_conflict");
					}
				};
				checkpoint();
				const executionProfile = await prepare(
					preparationLease(authority, undefined, checkpoint),
				);
				checkpoint();
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);

		const switching = exerciseCredentialPreparation(
			{
				agentId: "agent-remote",
				provider: "claude",
				backendProfileId: "ssh-profile-a",
				account,
				remote: { host: remoteHost, workingDirectory: "/srv/repo" },
			},
			transition,
			credentialDependencies(register, preflightRemote),
		);
		await vi.waitFor(() => expect(preflightRemote).toHaveBeenCalledOnce());
		current = false;
		finishPreflight();

		await expect(switching).rejects.toThrow(
			"client_agent_runtime_transition_conflict",
		);
		expect(preflightRemote).toHaveBeenCalledOnce();
		expect(register).not.toHaveBeenCalled();
		expect(runtimeTransition).not.toHaveBeenCalled();
	});

	it("stops before runtime transition when the route changes during register", async () => {
		const authority = routeAuthority("ssh-profile-a");
		let current = true;
		let finishRegister!: (value: {
			kind: "credential_reference";
			reference_id: string;
			credential_generation: string;
		}) => void;
		const preflightRemote = vi.fn().mockResolvedValue(undefined);
		const register = vi.fn(
			() =>
				new Promise<{
					kind: "credential_reference";
					reference_id: string;
					credential_generation: string;
				}>((resolve) => {
					finishRegister = resolve;
				}),
		);
		const runtimeTransition = vi.fn();
		const transition: PreparedCredentialTransition = vi.fn(
			async (agentId, backendProfileId, prepare) => {
				const checkpoint = () => {
					if (!current) {
						throw new Error("client_agent_runtime_transition_conflict");
					}
				};
				checkpoint();
				const executionProfile = await prepare(
					preparationLease(authority, undefined, checkpoint),
				);
				checkpoint();
				await runtimeTransition(agentId, backendProfileId, executionProfile);
			},
		);

		const switching = exerciseCredentialPreparation(
			{
				agentId: "agent-remote",
				provider: "claude",
				backendProfileId: "ssh-profile-a",
				account,
				remote: { host: remoteHost, workingDirectory: "/srv/repo" },
			},
			transition,
			credentialDependencies(register, preflightRemote),
		);
		await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
		current = false;
		finishRegister({
			kind: "credential_reference",
			reference_id: "account-b",
			credential_generation: "credential-b-remote-1",
		});

		await expect(switching).rejects.toThrow(
			"client_agent_runtime_transition_conflict",
		);
		expect(preflightRemote).toHaveBeenCalledOnce();
		expect(register).toHaveBeenCalledOnce();
		expect(runtimeTransition).not.toHaveBeenCalled();
	});
});
