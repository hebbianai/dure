import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	agentAccount: vi.fn(),
	preflight: vi.fn(),
	knownHostTrust: vi.fn(),
	create: vi.fn(),
	openAgentPanel: vi.fn(),
	providerRunCmd: vi.fn(
		(
			provider: string,
			options: { convId?: string; skipPermissions?: boolean },
		) => {
			const base = options.convId
				? `${provider} resume ${options.convId}`
				: provider;
			return options.skipPermissions ? `${base} --bypass` : base;
		},
	),
}));

vi.mock("@/lib/agents/providers", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/providers")>()),
	agentAccount: mocks.agentAccount,
	providerRunCmd: mocks.providerRunCmd,
	remoteAccountDir: vi.fn(() => ".dure/accounts/codex-work"),
}));

vi.mock("@/lib/agents/remoteAccountOverlay", () => ({
	preflightRemoteAccountLaunch: mocks.preflight,
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	remoteHmuxKnownHostTrust: mocks.knownHostTrust,
	remoteHmuxManagedCreateAdvance: mocks.create,
}));

vi.mock("@/lib/workspace/dock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock")>()),
	openAgentPanel: mocks.openAgentPanel,
}));

import { launchDiscoveredRemoteConversationPane } from "@/lib/sessions/launch/discoveredConversationLaunch";
import { ensureRemoteManagedAgentRuntime } from "@/lib/sessions/launch/remoteManagedAgentRuntime";
import { useStore } from "@/store";
import { agentFixture, stopFenceFixture } from "@/test/agentFixtures";

const oldFence = stopFenceFixture({
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
});

const hostTrust = {
	schemaVersion: 1,
	hostId: "host-1",
	hostKeyFingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
};

function remoteAgent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		name: "codex-remote",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-remote",
		sessionKind: "ssh",
		conversationId: "conversation-1",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-1",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-1",
			commandBridgeNonce: "bridge-1",
		},
		...patch,
	});
}

function receipt() {
	return {
		idempotencyKey: "create-1",
		bridgeNonce: "bridge-1",
		outcome: "created" as const,
		session: {
			sessionId: "session-1",
			workspaceId: "workspace-1",
			sessionClass: "managed" as const,
			lifecycle: "ready" as const,
			runnerPrincipal: "principal-1",
			runnerInstance: "runner-1",
			channelEpoch: "7",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-created",
		},
	};
}

function currentReceipt() {
	return { state: "current" as const, receipt: receipt() };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.openAgentPanel.mockReturnValue(true);
	mocks.agentAccount.mockReturnValue(undefined);
	mocks.preflight.mockResolvedValue(undefined);
	mocks.knownHostTrust.mockResolvedValue(hostTrust);
	mocks.create.mockResolvedValue(currentReceipt());
	const agent = remoteAgent({ skipPermissions: false });
	useStore.setState({
		agents: [agent],
		projects: [
			{
				id: "project-1",
				name: "repo",
				path: "/repo",
				kind: "ssh",
				isRepo: true,
				sshHostId: "host-1",
			},
		],
		sshHosts: [
			{
				id: "host-1",
				name: "host",
				host: "example.test",
				port: 22,
				user: "user",
				auth: "key",
				keyPath: "/tmp/test-key",
			},
		],
		skipPermissions: { codex: true },
	});
});

describe("remote managed create commit", () => {
	it.each(["current", "advanced"] as const)(
		"history resume accepts the ledger's %s receipt for a fenced SSH generation",
		async (state) => {
			const agent = remoteAgent({
				runtimeBinding: {
					...remoteAgent().runtimeBinding,
					stopFence: oldFence,
				} as Agent["runtimeBinding"],
			});
			useStore.setState({
				agents: [agent],
				layouts: {},
				agentActivity: { [agent.id]: "exited" },
			});
			const sessionId = state === "current" ? "session-1" : "successor-session";
			const idempotencyKey =
				state === "current" ? "create-1" : "successor-create";
			mocks.create.mockResolvedValueOnce({
				state,
				receipt: {
					...receipt(),
					idempotencyKey,
					session: { ...receipt().session, sessionId },
				},
			});
			const resumed = await launchDiscoveredRemoteConversationPane({
				provider: agent.provider,
				conversationId: "conversation-1",
				cwd: agent.worktreePath,
				workspaceRoot: "/repo",
				hostId: "host-1",
				desktopId: "desktop-active",
			});
			expect(mocks.create).toHaveBeenCalledWith(
				expect.objectContaining({
					idempotencyKey: "create-1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					conversationId: "conversation-1",
					bridgeNonce: "bridge-1",
				}),
			);
			expect(resumed.id).toBe(agent.id);
			expect(resumed).toMatchObject({
				started: true,
				sessionId,
				runtimeBinding: { sessionId, createIdempotencyKey: idempotencyKey },
			});
			expect(useStore.getState().agents).toEqual([resumed]);
			expect(mocks.openAgentPanel).toHaveBeenCalledWith(
				"desktop-active",
				resumed,
			);
		},
	);

	describe.each(["preflight", "trust", "receipt"] as const)(
		"presentation changes during %s",
		(phase) => {
			it.each(["project name", "repository metadata", "host name"] as const)(
				"preserves %s without refusing the same create",
				async (field) => {
					const agent = remoteAgent({
						conversationId: undefined,
						skipPermissions: false,
					});
					useStore.setState({ agents: [agent] });
					const changePresentation = () => {
						useStore.setState((state) => ({
							projects: state.projects.map((project) => ({
								...project,
								...(field === "project name" ? { name: "Renamed repo" } : {}),
								...(field === "repository metadata" ? { isRepo: false } : {}),
							})),
							sshHosts: state.sshHosts.map((host) => ({
								...host,
								...(field === "host name" ? { name: "Renamed host" } : {}),
							})),
						}));
					};
					if (phase === "preflight") {
						mocks.preflight.mockImplementationOnce(async () =>
							changePresentation(),
						);
					} else if (phase === "trust") {
						mocks.knownHostTrust.mockImplementationOnce(async () => {
							changePresentation();
							return hostTrust;
						});
					} else {
						mocks.create.mockImplementationOnce(async () => {
							changePresentation();
							return currentReceipt();
						});
					}

					await expect(
						ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
					).resolves.toMatchObject({
						agent: { id: agent.id, started: true },
						sessionId: "session-1",
						idempotencyKey: "create-1",
						stopFence: { ...oldFence, terminalEpoch: "terminal-created" },
					});
					expect(mocks.create).toHaveBeenCalledOnce();
					expect(mocks.create).toHaveBeenCalledWith(
						expect.objectContaining({
							target: expect.objectContaining({
								hostId: "host-1",
								host: "example.test",
								user: "user",
								port: 22,
								keyPath: "/tmp/test-key",
								hostKeyFingerprints: hostTrust.hostKeyFingerprints,
							}),
						}),
					);
					expect(useStore.getState().agents).toHaveLength(1);
					expect(useStore.getState().projects[0]).toMatchObject({
						name: field === "project name" ? "Renamed repo" : "repo",
						isRepo: field !== "repository metadata",
					});
					expect(useStore.getState().sshHosts[0].name).toBe(
						field === "host name" ? "Renamed host" : "host",
					);
				},
			);
		},
	);

	describe.each(["trust", "receipt"] as const)(
		"SSH authority changes during %s",
		(phase) => {
			it.each([
				{ host: "replacement.test" },
				{ registrationGeneration: "replacement-generation" },
				{ keyPath: "/tmp/replacement-key" },
			] satisfies Partial<SshHostConfig>[])(
				"retains the original Agent after %j",
				async (change) => {
					const agent = useStore.getState().agents[0];
					const changeAuthority = () =>
						useStore.setState((state) => ({
							sshHosts: state.sshHosts.map((host) => ({ ...host, ...change })),
						}));
					if (phase === "trust") {
						mocks.knownHostTrust.mockImplementationOnce(async () => {
							changeAuthority();
							return hostTrust;
						});
					} else {
						mocks.create.mockImplementationOnce(async () => {
							changeAuthority();
							return currentReceipt();
						});
					}

					await expect(
						ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
					).rejects.toThrow(
						phase === "trust"
							? "source changed before create"
							: "source changed before receipt commit",
					);
					expect(mocks.create).toHaveBeenCalledTimes(phase === "trust" ? 0 : 1);
					expect(useStore.getState().agents[0]).toEqual(agent);
				},
			);
		},
	);

	it("recovers one delayed, lost reply from the same key in a fresh client module", async () => {
		const agent = remoteAgent({
			conversationId: undefined,
			skipPermissions: false,
		});
		useStore.setState({ agents: [agent] });
		let loseReply!: (error: Error) => void;
		mocks.create.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					loseReply = reject;
				}),
		);
		const first = ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		const duplicate = ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		const lostResponses = Promise.all([
			expect(first).rejects.toThrow("remote_transport_failed"),
			expect(duplicate).rejects.toThrow("remote_transport_failed"),
		]);
		await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
		useStore.setState((state) => ({
			projects: state.projects.map((project) => ({
				...project,
				name: "Renamed while waiting",
			})),
			sshHosts: state.sshHosts.map((host) => ({
				...host,
				name: "Renamed host",
			})),
		}));
		loseReply(new Error("remote_transport_failed"));
		await lostResponses;
		expect(useStore.getState().agents).toEqual([agent]);
		const state = useStore.getState();
		const persisted = JSON.stringify({
			agents: state.agents,
			projects: state.projects,
			sshHosts: state.sshHosts,
			accounts: state.accounts,
			skipPermissions: state.skipPermissions,
		});

		// The backend retained its receipt; reload only the client and its pending registration.
		vi.resetModules();
		const { useStore: reopenedStore } = await import("@/store");
		const { ensureRemoteManagedAgentRuntime: reopenedEnsure } = await import(
			"@/lib/sessions/launch/remoteManagedAgentRuntime"
		);
		reopenedStore.setState(JSON.parse(persisted));
		mocks.create.mockResolvedValueOnce(currentReceipt());
		await expect(
			reopenedEnsure(reopenedStore.getState().agents[0], {
				columns: 100,
				rows: 40,
			}),
		).resolves.toMatchObject({
			sessionId: "session-1",
			idempotencyKey: "create-1",
		});
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(mocks.create.mock.calls[1][0]).toEqual(
			mocks.create.mock.calls[0][0],
		);
		expect(reopenedStore.getState().agents).toHaveLength(1);
		expect(reopenedStore.getState().agents[0].runtimeBinding).toMatchObject({
			sessionId: "session-1",
			createIdempotencyKey: "create-1",
			stopFence: { ...oldFence, terminalEpoch: "terminal-created" },
		});
		expect(reopenedStore.getState().projects[0].name).toBe(
			"Renamed while waiting",
		);
		expect(reopenedStore.getState().sshHosts[0].name).toBe("Renamed host");
	});

	it.each([
		{ host: "replacement.test" },
		{ registrationGeneration: "replacement-generation" },
		{ keyPath: "/tmp/replacement-key" },
	] satisfies Partial<SshHostConfig>[])(
		"does not use preflight from a different SSH authority: %j",
		async (change) => {
			const agent = useStore.getState().agents[0];
			mocks.preflight.mockImplementationOnce(async () => {
				useStore.setState((state) => ({
					sshHosts: state.sshHosts.map((host) => ({ ...host, ...change })),
				}));
			});

			await expect(
				ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
			).rejects.toThrow("source changed during preflight");
			expect(mocks.create).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0]).toEqual(agent);
		},
	);

	it.each(["codex", "claude"] as const)(
		"starts a genuinely fresh %s provider without an invented conversation seed",
		async (provider) => {
			const agent = remoteAgent({
				provider,
				conversationId: undefined,
				skipPermissions: false,
			});
			useStore.setState({ agents: [agent] });

			await expect(
				ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
			).resolves.toMatchObject({
				agent: { id: agent.id, started: true },
				stopFence: { ...oldFence, terminalEpoch: "terminal-created" },
			});

			expect(mocks.create).toHaveBeenCalledWith(
				expect.objectContaining({ providerId: provider, command: provider }),
			);
			expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty(
				"conversationId",
			);
		},
	);

	it("keeps an explicit conversation identity as the exact resume seed", async () => {
		const agent = useStore.getState().agents[0];

		await ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 });

		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-1",
				command: "codex resume conversation-1",
			}),
		);
	});

	it("passes the first prompt through the remote managed launch receipt", async () => {
		const agent = useStore.getState().agents[0];
		mocks.create.mockResolvedValueOnce({
			state: "current",
			receipt: { ...receipt(), initialPromptAccepted: true },
		});

		await expect(
			ensureRemoteManagedAgentRuntime(agent, {
				columns: 100,
				rows: 40,
				initialPrompt: "ship it",
			}),
		).resolves.toMatchObject({ initialPromptAccepted: true });
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({ initialPrompt: "ship it" }),
		);
	});

	it("retains accepted input across retry and rejects a different prompt digest", async () => {
		const agent = useStore.getState().agents[0];
		mocks.create.mockResolvedValueOnce({ state: "current", receipt: { ...receipt(), initialPromptAccepted: true } });
		const options = { columns: 100, rows: 40, initialPrompt: "ship it", launchOptions: { model: "gpt-test", effort: "high" } };
		const first = await ensureRemoteManagedAgentRuntime(agent, options);
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ launchOptions: options.launchOptions }));
		expect(first.agent.runtimeBinding).toHaveProperty("initialPromptDigest", expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
		expect((await ensureRemoteManagedAgentRuntime(first.agent, options)).initialPromptAccepted).toBe(true);
		expect((await ensureRemoteManagedAgentRuntime(first.agent, { ...options, initialPrompt: "different" })).initialPromptAccepted).not.toBe(true);
		expect(mocks.create).toHaveBeenCalledOnce();
	});

	it("joins identical launch options but refuses a different model during create", async () => {
		const agent = useStore.getState().agents[0];
		const options = { columns: 100, rows: 40, initialPrompt: "ship it", launchOptions: { model: "gpt-test", effort: "high" } };
		const first = ensureRemoteManagedAgentRuntime(agent, options);
		const joined = ensureRemoteManagedAgentRuntime(agent, { ...options, launchOptions: { effort: "high", model: "gpt-test" } });
		await expect(ensureRemoteManagedAgentRuntime(agent, { ...options, launchOptions: { model: "different" } })).rejects.toThrow("managed_create_launch_options_conflict");
		await Promise.all([first, joined]);
		expect(mocks.create).toHaveBeenCalledOnce();
	});

	it("joins a surface-owned remote launch and leaves the prompt for fallback", async () => {
		const agent = useStore.getState().agents[0];
		const surface = ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		const launch = ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
			initialPrompt: "ship it",
		});

		const [joined, launched] = await Promise.all([surface, launch]);
		expect(mocks.create).toHaveBeenCalledOnce();
		expect(mocks.create).toHaveBeenCalledWith(
			expect.not.objectContaining({ initialPrompt: expect.anything() }),
		);
		expect(joined.initialPromptAccepted).not.toBe(true);
		expect(launched.initialPromptAccepted).not.toBe(true);
	});

	it("atomically commits the remote ledger successor without minting an identity", async () => {
		const agent = remoteAgent({
			runtimeBinding: {
				...remoteAgent().runtimeBinding,
				credentialId: "credential-work",
				credentialProfileDirectory: ".dure/accounts/codex-work",
			} as Agent["runtimeBinding"],
		});
		useStore.setState({
			agents: [agent],
			sessionCwd: { "session-1": "/repo/worktree" },
			sshMessages: { "session-1": "old transport" },
		});
		mocks.create.mockResolvedValueOnce({
			state: "advanced",
			receipt: {
				...receipt(),
				idempotencyKey: "ledger-successor-create",
				session: {
					...receipt().session,
					sessionId: "ledger-successor-session",
				},
			},
		});

		const ensured = await ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		expect(ensured).toMatchObject({
			agent: {
				sessionId: "ledger-successor-session",
				runtimeBinding: {
					createIdempotencyKey: "ledger-successor-create",
				},
			},
			stopFence: { terminalEpoch: "terminal-created" },
		});

		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "create-1",
				sessionId: "session-1",
			}),
		);
		const committed = useStore.getState();
		expect(committed.agents[0]).toMatchObject({
			sessionId: "ledger-successor-session",
			runtimeBinding: {
				sessionId: "ledger-successor-session",
				createIdempotencyKey: "ledger-successor-create",
				credentialId: "credential-work",
				credentialProfileDirectory: ".dure/accounts/codex-work",
			},
		});
		expect(committed.sessionCwd).toEqual({
			"ledger-successor-session": "/repo/worktree",
		});
		expect(committed.sshMessages).not.toHaveProperty("session-1");
	});

	it("rejects a malformed explicit identity instead of treating it as fresh", async () => {
		const agent = remoteAgent({ conversationId: "   " });
		useStore.setState({ agents: [agent] });

		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).rejects.toThrow("invalid explicit conversation id");
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("revalidates the source after host trust before creating remotely", async () => {
		const agent = useStore.getState().agents[0];
		mocks.knownHostTrust.mockImplementationOnce(async () => {
			useStore.setState({ agents: [] });
			return hostTrust;
		});

		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).rejects.toThrow("source changed before create");
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("runs the caller's final ownership fence immediately before create", async () => {
		const agent = useStore.getState().agents[0];
		const changed = new Error("remote conversation owner appeared");
		const beforeCreate = vi.fn(() => {
			throw changed;
		});

		await expect(
			ensureRemoteManagedAgentRuntime(agent, {
				columns: 100,
				rows: 40,
				beforeCreate,
			}),
		).rejects.toBe(changed);

		expect(beforeCreate).toHaveBeenCalledOnce();
		expect(mocks.knownHostTrust).toHaveBeenCalledOnce();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("revalidates the exact remote project snapshot after preflight", async () => {
		const agent = useStore.getState().agents[0];
		mocks.preflight.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				projects: state.projects.map((project) => ({
					...project,
					path: "/replacement/repo",
				})),
			}));
		});

		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).rejects.toThrow("source changed during preflight");
		expect(mocks.knownHostTrust).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("does not replay managed create for an already-fenced generation", async () => {
		const agent = remoteAgent({
			runtimeBinding: {
				...remoteAgent().runtimeBinding,
				stopFence: oldFence,
			} as Agent["runtimeBinding"],
		});
		useStore.setState({ agents: [agent] });

		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).resolves.toEqual({
			agent,
			stopFence: oldFence,
			sessionId: "session-1",
			workspaceId: "workspace-1",
			idempotencyKey: "create-1",
		});
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("uses an explicit safe Agent permission override", async () => {
		const agent = useStore.getState().agents[0];
		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).resolves.toMatchObject({
			agent: { id: agent.id, started: true },
			stopFence: { ...oldFence, terminalEpoch: "terminal-created" },
		});

		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				permissionMode: "default",
				command: "codex resume conversation-1",
			}),
		);
	});

	it("deduplicates an in-flight failure and permits one exact retry", async () => {
		let fail: ((error: Error) => void) | undefined;
		mocks.create.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		const agent = useStore.getState().agents[0];
		const first = ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		const concurrent = ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
		fail?.(new Error("remote_transport_failed"));

		await expect(first).rejects.toThrow("remote_transport_failed");
		await expect(concurrent).rejects.toThrow("remote_transport_failed");
		expect(mocks.create).toHaveBeenCalledTimes(1);

		mocks.create.mockResolvedValueOnce(currentReceipt());
		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).resolves.toMatchObject({
			agent: { id: agent.id, started: true },
			stopFence: { ...oldFence, terminalEpoch: "terminal-created" },
		});
		expect(mocks.create).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			{
				state: "retry_same",
				reason: "authority_unavailable",
				code: "remote_authority_unavailable",
				message: "retry the exact identity",
			},
			"managed_create_retry_same",
		],
		[
			{
				state: "rejected",
				code: "request_invalid",
				message: "invalid policy",
			},
			"managed_create_rejected",
		],
	] as const)(
		"preserves the exact remote binding for non-current create state %#",
		async (resolution, code) => {
			const agent = useStore.getState().agents[0];
			const before = structuredClone(agent);
			mocks.create.mockResolvedValueOnce(resolution);

			await expect(
				ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
			).rejects.toMatchObject({ code });
			expect(useStore.getState().agents[0]).toEqual(before);
		},
	);

	it("prepares and binds a selected remote credential before managed create", async () => {
		const account = {
			id: "credential-work",
			name: "work",
			provider: "codex" as const,
			dir: "/local/accounts/codex-work",
		};
		mocks.agentAccount.mockReturnValue(account);
		const agent = remoteAgent({
			credentialId: account.id,
			accountId: account.id,
		});
		useStore.setState({ agents: [agent], accounts: [account] });

		await ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 });

		expect(mocks.preflight).toHaveBeenCalledWith(
			expect.anything(),
			"codex",
			"/repo/worktree",
			account,
			{
				requireCredential: true,
				remoteProfileDirectory: ".dure/accounts/codex-work",
			},
		);
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: account.id,
				credentialProfileDirectory: ".dure/accounts/codex-work",
			}),
		);
		expect(useStore.getState().agents[0].runtimeBinding).toMatchObject({
			credentialId: account.id,
			credentialProfileDirectory: ".dure/accounts/codex-work",
		});
	});

	it("reuses the binding profile when the local account registry entry is gone", async () => {
		const binding = {
			...remoteAgent().runtimeBinding,
			credentialId: "credential-work",
			credentialProfileDirectory: ".dure/accounts/codex-work",
		} as Agent["runtimeBinding"];
		const agent = remoteAgent({
			credentialId: "credential-work",
			accountId: "credential-work",
			runtimeBinding: binding,
		});
		mocks.agentAccount.mockReturnValue(undefined);
		useStore.setState({ agents: [agent], accounts: [] });

		await ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 });

		expect(mocks.preflight).toHaveBeenCalledWith(
			expect.anything(),
			"codex",
			"/repo/worktree",
			undefined,
			{
				requireCredential: true,
				remoteProfileDirectory: ".dure/accounts/codex-work",
			},
		);
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "credential-work",
				credentialProfileDirectory: ".dure/accounts/codex-work",
			}),
		);
	});

	it("never pairs a binding credential id with a different active account profile", async () => {
		const activeAccount = {
			id: "credential-other",
			name: "other",
			provider: "codex" as const,
			dir: "/local/accounts/codex-other",
		};
		const agent = remoteAgent({
			runtimeBinding: {
				...remoteAgent().runtimeBinding,
				credentialId: "credential-work",
			} as Agent["runtimeBinding"],
		});
		mocks.agentAccount.mockReturnValue(activeAccount);
		useStore.setState({ agents: [agent], accounts: [activeAccount] });

		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).rejects.toThrow(
			"remote managed credential reference is missing its exact profile directory",
		);
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("refuses create when the selected profile mapping changes during preflight", async () => {
		const account = {
			id: "credential-work",
			name: "work",
			provider: "codex" as const,
			dir: "/local/accounts/codex-work",
		};
		mocks.agentAccount.mockReturnValue(account);
		const agent = remoteAgent({
			credentialId: account.id,
			accountId: account.id,
		});
		useStore.setState({ agents: [agent], accounts: [account] });
		mocks.preflight.mockImplementationOnce(async () => {
			useStore.setState({
				accounts: [{ ...account, dir: "/local/accounts/codex-other" }],
			});
		});

		await expect(
			ensureRemoteManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).rejects.toThrow("remote managed create source changed during preflight");
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("does not overwrite a newer generation after an in-flight create", async () => {
		let release:
			| ((value: ReturnType<typeof currentReceipt>) => void)
			| undefined;
		mocks.create.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const agent = useStore.getState().agents[0];
		const pending = ensureRemoteManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
		const newerFence = { ...oldFence, terminalEpoch: "terminal-2" };
		useStore.setState({
			agents: [
				remoteAgent({
					skipPermissions: false,
					runtimeBinding: {
						...remoteAgent().runtimeBinding,
						stopFence: newerFence,
					} as Agent["runtimeBinding"],
				}),
			],
		});
		release?.(currentReceipt());

		await expect(pending).rejects.toMatchObject({
			code: "managed_create_retry_same",
			reason: "authority_inconsistent",
			backendCode: "remote_managed_create_receipt_commit_changed",
			message: "remote managed create source changed before receipt commit",
		});
		expect(useStore.getState().agents[0].runtimeBinding).toMatchObject({
			stopFence: newerFence,
		});
	});
});
