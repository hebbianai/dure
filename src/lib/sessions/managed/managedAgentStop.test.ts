import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { agentRemovalRegistrationIdentity } from "@/lib/agents/agentRemovalRegistration";
import { handleCliHmuxStop } from "@/lib/cli/cliHmuxStop";
import { managedCreateChainStopLegacyOrderedV1EventProjection } from "@/lib/hmux/managed/managedCreateChainStopReceipt";
import type { ManagedStopReceiptV2 } from "@/lib/hmux/managed/managedRehostTargetReceipt";
import type {
	HmuxManagedCreateChainStopReceipt,
	HmuxManagedStopReceipt,
} from "@/lib/ipc";
import type { Agent, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	emit: vi.fn(),
	removeMountedPanels: vi.fn(),
	removePanels: vi.fn(),
	probeSessions: vi.fn(),
	prepareTrustedSsh: vi.fn(),
	stopManaged: vi.fn(),
	readCompletedManagedStop: vi.fn(),
	readManagedSessionRetirement: vi.fn(),
	stopManagedCreateChain: vi.fn(),
	reconcileManagedClose: vi.fn(),
	remoteCatalog: vi.fn(),
	remoteManagedCreateChainStop: vi.fn(),
	remoteManagedStop: vi.fn(),
	recoverProjection: vi.fn(),
}));

import { emitCallsFor } from "@/test/emitCalls";

const stopCalls = () => emitCallsFor(mocks.emit, MANAGED_AGENT_STOPPED_EVENT);

vi.mock("@tauri-apps/api/event", () => ({
	emit: mocks.emit,
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		probeSessions: mocks.probeSessions,
		stopManaged: mocks.stopManaged,
		readCompletedManagedStop: mocks.readCompletedManagedStop,
		readManagedSessionRetirement: mocks.readManagedSessionRetirement,
		stopManagedCreateChain: mocks.stopManagedCreateChain,
	},
	prepareTrustedSshTarget: mocks.prepareTrustedSsh,
	remoteHmuxCatalog: mocks.remoteCatalog,
	remoteHmuxManagedCreateChainStop: mocks.remoteManagedCreateChainStop,
	remoteHmuxManagedStop: mocks.remoteManagedStop,
	reconcileManagedCreateChainStop: mocks.reconcileManagedClose,
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: async (target: {
		sessionId: string;
		workspaceId: string;
	}) =>
		(await mocks.probeSessions([target.sessionId])).find(
			(session: { sessionId: string; workspaceId: string }) =>
				session.sessionId === target.sessionId &&
				session.workspaceId === target.workspaceId,
		),
}));

vi.mock("@/lib/persistence/currentDurableProjectionRecovery", () => ({
	recoverCurrentDurableStoreProjection: mocks.recoverProjection,
}));

vi.mock(
	"@/lib/workspace/pane/paneCloseCoordinator",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/workspace/pane/paneCloseCoordinator")
		>()),
		removePanelsWithoutSessionTeardown: mocks.removePanels,
		removeMountedPanelsWithoutSessionTeardown: mocks.removeMountedPanels,
	}),
);

import { settleDurableAppState } from "@/lib/persistence/durableAppStateSettlement";
import {
	applyManagedAgentChainStoppedSync,
	applyManagedAgentStoppedSync,
	finalizeManagedAgentRemoval,
	LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT,
	MANAGED_AGENT_CHAIN_STOPPED_EVENT,
	MANAGED_AGENT_STOPPED_EVENT,
	type ManagedAgentStopTarget,
	ManagedSessionAbsentError,
	prepareManagedAgentStopOperation,
	prepareManagedAgentStopTarget,
	reconcileManagedAgentStop,
	resolveManagedAgentStopTarget,
	stopManagedAgentProvider,
	stopPreparedManagedAgentProvider,
} from "@/lib/sessions/managed/managedAgentStop";
import { durableAppStorage, useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const stopFence = stopFenceFixture();

const replacementFence = stopFenceFixture({
	runnerInstance: "runner-2",
	hostInstanceId: "host-instance-2",
	terminalEpoch: "terminal-epoch-2",
});

function managedAgent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		id: "agent-managed",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "session-managed",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			createIdempotencyKey: undefined,
			stopFence,
		}),
		...patch,
	});
}

function managedChainAgent(patch: Partial<Agent> = {}): Agent {
	return managedAgent({
		runtimeBinding: managedBindingFixture({
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			createIdempotencyKey: "create-managed",
			stopFence,
		}),
		...patch,
	});
}

function stopReceipt(
	patch: Partial<HmuxManagedStopReceipt> = {},
): ManagedStopReceiptV2 {
	return {
		schema: "hmux-managed-stop-v1",
		schemaVersion: 2,
		stopId: "stop-placeholder",
		sessionId: "session-managed",
		workspaceId: "workspace-managed",
		runnerPrincipal: stopFence.runnerPrincipal,
		runnerInstance: stopFence.runnerInstance,
		channelEpoch: Number(stopFence.channelEpoch),
		hostInstanceId: "host-instance-1",
		terminalEpoch: "terminal-epoch-1",
		outcome: "stopped",
		exitReason: "managed_provider_stop",
		...patch,
	};
}

function chainStopReceipt(
	patch: Partial<HmuxManagedCreateChainStopReceipt> = {},
): HmuxManagedCreateChainStopReceipt {
	return {
		schema: "hmux-managed-create-chain-stop-v2",
		schemaVersion: 2,
		chain: [
			{
				schema: "hmux-managed-create-reconcile-v1",
				schemaVersion: 1,
				idempotencyKey: "create-managed",
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
			},
		],
		stopReceipt: stopReceipt({ stopId: "chain-stop" }),
		...patch,
	};
}

describe("managed Agent provider stop", () => {
	beforeEach(() => {
		mocks.emit.mockReset();
		mocks.removeMountedPanels.mockReset();
		mocks.removePanels.mockReset();
		mocks.probeSessions.mockReset();
		mocks.probeSessions.mockResolvedValue([
			{
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				sessionClass: "managed",
				lifecycle: "ready",
				manifestLifecycle: "ready",
				terminalEpoch: stopFence.terminalEpoch,
				stopFence,
				outputSeq: "0",
				capabilities: [],
			},
		]);
		mocks.stopManaged.mockReset();
		mocks.readCompletedManagedStop.mockReset().mockResolvedValue(null);
		mocks.readManagedSessionRetirement
			.mockReset()
			.mockResolvedValue({ kind: "no_ledger" });
		mocks.stopManagedCreateChain.mockReset();
		mocks.stopManagedCreateChain.mockResolvedValue(chainStopReceipt());
		mocks.reconcileManagedClose.mockReset().mockResolvedValue(null);
		mocks.prepareTrustedSsh.mockReset();
		mocks.prepareTrustedSsh.mockImplementation(
			async (hosts: readonly SshHostConfig[], hostId: string) => {
				const host = hosts.find((candidate) => candidate.id === hostId);
				if (!host) throw new Error("trusted_ssh_host_not_registered");
				return {
					schemaVersion: 1 as const,
					hostId: host.id,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: host.auth,
					...(host.secretId ? { secretId: host.secretId } : {}),
					...(host.keyPath ? { keyPath: host.keyPath } : {}),
					hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
				};
			},
		);
		mocks.remoteCatalog.mockReset();
		mocks.remoteManagedCreateChainStop.mockReset();
		mocks.remoteManagedStop.mockReset();
		mocks.recoverProjection
			.mockReset()
			.mockImplementation(async (_options, additionalDepartures) => {
				await settleDurableAppState(additionalDepartures);
				return true;
			});
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [managedAgent()],
			sshHosts: [],
			sessionCwd: { "session-managed": "/repo/worktree" },
		});
	});

	it("reads an accepted chain stop without inspecting a Host or submitting another stop", async () => {
		const target = resolveManagedAgentStopTarget(managedChainAgent());
		const receipt = chainStopReceipt();
		mocks.reconcileManagedClose.mockResolvedValue(receipt);
		await expect(reconcileManagedAgentStop(target)).resolves.toEqual({
			target,
			receipt,
		});
		expect(mocks.reconcileManagedClose).toHaveBeenCalledWith({
			idempotencyKey: "create-managed",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
		});
		expect(mocks.probeSessions).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.stopManagedCreateChain).not.toHaveBeenCalled();
	});

	it("keeps an absent completion distinct from a failed observation", async () => {
		const target = resolveManagedAgentStopTarget(managedChainAgent());
		await expect(reconcileManagedAgentStop(target)).resolves.toBeUndefined();
		mocks.reconcileManagedClose.mockRejectedValue(
			new Error("receipt observation unavailable"),
		);
		await expect(reconcileManagedAgentStop(target)).rejects.toThrow(
			"receipt observation unavailable",
		);
		expect(mocks.stopManagedCreateChain).not.toHaveBeenCalled();
	});

	it("does not manufacture a create lineage for a legacy exact-stop binding", async () => {
		await expect(
			reconcileManagedAgentStop(resolveManagedAgentStopTarget(managedAgent())),
		).resolves.toBeUndefined();
		expect(mocks.reconcileManagedClose).not.toHaveBeenCalled();
	});

	it("reuses the exact historical stop after confirmed catalog absence without stopping again", async () => {
		const target = resolveManagedAgentStopTarget(managedAgent());
		const operation = await prepareManagedAgentStopOperation(target);
		if (operation.kind !== "exact")
			throw new Error("Expected exact stop fixture");
		const receipt = stopReceipt({ stopId: operation.stopId });
		mocks.probeSessions.mockReset().mockResolvedValue([]);
		mocks.readCompletedManagedStop.mockResolvedValue(receipt);

		await expect(reconcileManagedAgentStop(target)).resolves.toEqual({
			target,
			receipt,
		});
		expect(mocks.readCompletedManagedStop).toHaveBeenCalledWith(
			operation.stopId,
			"session-managed",
			"workspace-managed",
			stopFence,
		);
		expect(mocks.probeSessions).toHaveBeenCalledExactlyOnceWith([
			"session-managed",
		]);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.reconcileManagedClose).not.toHaveBeenCalled();
	});

	it("does not turn an unavailable exact completion read into absence", async () => {
		const target = resolveManagedAgentStopTarget(managedAgent());
		mocks.readCompletedManagedStop.mockRejectedValue(
			new Error("stop outcome unavailable"),
		);
		await expect(reconcileManagedAgentStop(target)).rejects.toThrow(
			"stop outcome unavailable",
		);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("replays the accepted advanced generation after publication failure with an unchanged binding", async () => {
		const target = resolveManagedAgentStopTarget(managedAgent());
		mocks.probeSessions.mockResolvedValue([
			{
				sessionId: target.binding.sessionId,
				workspaceId: target.binding.workspaceId,
				sessionClass: "managed",
				lifecycle: "exited",
				terminalEpoch: replacementFence.terminalEpoch,
				stopFence: replacementFence,
			},
		]);
		mocks.stopManaged.mockImplementation(async (stopId: string) =>
			stopReceipt({
				stopId,
				...replacementFence,
				channelEpoch: Number(replacementFence.channelEpoch),
			}),
		);
		const stopped = await stopManagedAgentProvider(target);
		if ("chain" in stopped.receipt) throw new Error("Expected exact receipt");
		const accepted = stopped.receipt;
		mocks.emit.mockRejectedValueOnce(new Error("publication unavailable"));
		await expect(
			finalizeManagedAgentRemoval(stopped.target, accepted),
		).rejects.toThrow("publication unavailable");
		expect(
			resolveManagedAgentStopTarget("agent-managed").binding.stopFence,
		).toEqual(stopFence);
		mocks.readCompletedManagedStop.mockImplementation(async (stopId: string) =>
			stopId === accepted.stopId ? accepted : null,
		);

		const replay = await reconcileManagedAgentStop(
			resolveManagedAgentStopTarget("agent-managed"),
		);
		expect(replay).toEqual({ target, receipt: accepted });
		if (!replay) throw new Error("Accepted stop was not recovered");
		await finalizeManagedAgentRemoval(replay.target, replay.receipt);
		expect(useStore.getState().agents).toEqual([]);
		expect(mocks.stopManaged).toHaveBeenCalledTimes(1);
	});

	it("does not replay a historical stop as completion of a newer catalog generation", async () => {
		const target = resolveManagedAgentStopTarget(managedAgent());
		const historical = await prepareManagedAgentStopOperation(target);
		if (historical.kind !== "exact")
			throw new Error("Expected exact operation");
		const receipt = stopReceipt({ stopId: historical.stopId });
		mocks.readCompletedManagedStop.mockImplementation(async (stopId: string) =>
			stopId === historical.stopId ? receipt : null,
		);
		mocks.probeSessions.mockResolvedValue([
			{
				sessionId: target.binding.sessionId,
				workspaceId: target.binding.workspaceId,
				sessionClass: "managed",
				lifecycle: "ready",
				terminalEpoch: replacementFence.terminalEpoch,
				stopFence: replacementFence,
			},
		]);

		await expect(reconcileManagedAgentStop(target)).resolves.toBeUndefined();
		expect(useStore.getState().agents).toEqual([target.agent]);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("does not let a stored fence hide an unknown current generation", async () => {
		const target = resolveManagedAgentStopTarget(managedAgent());
		const operation = await prepareManagedAgentStopOperation(target);
		if (operation.kind !== "exact") throw new Error("Expected exact operation");
		mocks.readCompletedManagedStop.mockResolvedValue(
			stopReceipt({ stopId: operation.stopId }),
		);
		mocks.probeSessions.mockRejectedValue(
			new Error("exact lookup unavailable"),
		);

		await expect(reconcileManagedAgentStop(target)).rejects.toThrow(
			"exact lookup unavailable",
		);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([target.agent]);
	});

	it.each(["stale", "missing"] as const)(
		"reuses permanent retirement with a %s binding fence and unavailable discovery",
		async (fenceState) => {
			const agent = managedAgent({
				runtimeBinding: managedBindingFixture({
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					createIdempotencyKey: undefined,
					stopFence: fenceState === "stale" ? stopFence : undefined,
				}),
			});
			useStore.setState({ agents: [agent] });
			const target = resolveManagedAgentStopTarget(agent);
			const receipt = stopReceipt({
				stopId: "the-accepted-operation",
				...replacementFence,
				channelEpoch: Number(replacementFence.channelEpoch),
			});
			mocks.readManagedSessionRetirement.mockResolvedValue({
				kind: "finalized",
				receipt,
			});
			mocks.probeSessions.mockRejectedValue(
				new Error("discovery no longer available"),
			);
			const stopped = await reconcileManagedAgentStop(target);
			expect(stopped).toEqual({ target, receipt });
			if (!stopped) throw new Error("Permanent retirement was not recovered");
			await finalizeManagedAgentRemoval(stopped.target, stopped.receipt);
			expect(useStore.getState().agents).toEqual([]);
			expect(mocks.probeSessions).not.toHaveBeenCalled();
			expect(mocks.readCompletedManagedStop).not.toHaveBeenCalled();
			expect(mocks.stopManaged).not.toHaveBeenCalled();
		},
	);

	it("does not replace an unfinished permanent retirement with an old journal receipt", async () => {
		const target = resolveManagedAgentStopTarget(managedAgent());
		const operation = await prepareManagedAgentStopOperation(target);
		if (operation.kind !== "exact") throw new Error("Expected exact operation");
		mocks.readCompletedManagedStop
			.mockClear()
			.mockResolvedValue(stopReceipt({ stopId: operation.stopId }));
		mocks.readManagedSessionRetirement.mockResolvedValue({
			kind: "not_finalized",
		});
		await expect(reconcileManagedAgentStop(target)).resolves.toBeUndefined();
		expect(mocks.readCompletedManagedStop).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([target.agent]);
	});

	it.each(["stale", "missing"] as const)(
		"prepares and executes a completed GUI stop with a %s saved fence after discovery loss",
		async (fenceState) => {
			const agent = managedAgent({
				runtimeBinding: managedBindingFixture({
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					createIdempotencyKey: undefined,
					stopFence: fenceState === "stale" ? stopFence : undefined,
				}),
			});
			useStore.setState({ agents: [agent] });
			const receipt = stopReceipt({
				stopId: "accepted-before-reopen",
				...replacementFence,
				channelEpoch: Number(replacementFence.channelEpoch),
			});
			mocks.readManagedSessionRetirement.mockResolvedValue({
				kind: "finalized",
				receipt,
			});
			mocks.probeSessions.mockRejectedValue(new Error("discovery unavailable"));

			const operation = await prepareManagedAgentStopOperation(agent);
			await expect(
				stopPreparedManagedAgentProvider(operation),
			).resolves.toEqual(receipt);
			expect(mocks.stopManaged).not.toHaveBeenCalled();
			expect(mocks.probeSessions).not.toHaveBeenCalled();
			await finalizeManagedAgentRemoval(operation.target, receipt);
			expect(useStore.getState().agents).toEqual([]);
		},
	);

	it("prepares the accepted chain receipt for GUI cleanup without a second stop", async () => {
		const agent = managedChainAgent();
		const receipt = chainStopReceipt();
		mocks.reconcileManagedClose.mockResolvedValue(receipt);
		const operation = await prepareManagedAgentStopOperation(agent);
		await expect(stopPreparedManagedAgentProvider(operation)).resolves.toEqual(
			receipt,
		);
		expect(mocks.stopManagedCreateChain).not.toHaveBeenCalled();
		expect(mocks.probeSessions).not.toHaveBeenCalled();
	});

	it("does not prepare a new GUI stop when the completion owner is unavailable", async () => {
		mocks.readManagedSessionRetirement.mockRejectedValue(
			new Error("retirement unavailable"),
		);
		await expect(
			prepareManagedAgentStopOperation(managedAgent()),
		).rejects.toThrow("retirement unavailable");
		expect(mocks.probeSessions).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("does not treat unreadable permanent retirement as a legacy session", async () => {
		const target = resolveManagedAgentStopTarget(managedAgent());
		mocks.readManagedSessionRetirement.mockRejectedValue(
			new Error("retirement ledger unreadable"),
		);
		await expect(reconcileManagedAgentStop(target)).rejects.toThrow(
			"retirement ledger unreadable",
		);
		expect(mocks.probeSessions).not.toHaveBeenCalled();
		expect(mocks.readCompletedManagedStop).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it.each([
		"stopId",
		"sessionId",
		"workspaceId",
		"runnerInstance",
		"terminalEpoch",
	] as const)(
		"rejects an observed exact completion with a different %s",
		async (field) => {
			const target = resolveManagedAgentStopTarget(managedAgent());
			const operation = await prepareManagedAgentStopOperation(target);
			if (operation.kind !== "exact")
				throw new Error("Expected exact stop fixture");
			mocks.readCompletedManagedStop.mockResolvedValue(
				stopReceipt({
					stopId: operation.stopId,
					[field]: "another-identity",
				}),
			);
			await expect(reconcileManagedAgentStop(target)).rejects.toMatchObject({
				code: "pane_changed",
			});
			expect(mocks.stopManaged).not.toHaveBeenCalled();
		},
	);

	it("keeps a missing exact generation unknown without deriving one from the pane", async () => {
		const agent = managedAgent({
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: undefined,
			}),
		});
		mocks.probeSessions.mockResolvedValue([]);
		await expect(
			reconcileManagedAgentStop(resolveManagedAgentStopTarget(agent)),
		).resolves.toBeUndefined();
		expect(mocks.readCompletedManagedStop).not.toHaveBeenCalled();
	});

	it("resolves a missing legacy generation from the same exact catalog owner used by stop", async () => {
		const agent = managedAgent({
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: undefined,
			}),
		});
		const target = resolveManagedAgentStopTarget(agent);
		const operation = await prepareManagedAgentStopOperation(target);
		if (operation.kind !== "exact")
			throw new Error("Expected exact stop fixture");
		const receipt = stopReceipt({ stopId: operation.stopId });
		mocks.readCompletedManagedStop.mockResolvedValue(receipt);
		await expect(reconcileManagedAgentStop(target)).resolves.toEqual({
			target,
			receipt,
		});
		expect(mocks.readCompletedManagedStop).toHaveBeenCalledWith(
			operation.stopId,
			"session-managed",
			"workspace-managed",
			stopFence,
		);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(target.binding.stopFence).toBeUndefined();
	});

	it("keeps an unobserved legacy generation distinct from catalog absence", async () => {
		const agent = managedAgent({
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: undefined,
			}),
		});
		mocks.probeSessions.mockRejectedValue(
			new Error("exact lookup unavailable"),
		);
		await expect(
			reconcileManagedAgentStop(resolveManagedAgentStopTarget(agent)),
		).rejects.toThrow("exact lookup unavailable");
		expect(mocks.readCompletedManagedStop).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("retains frozen SSH authority while reconciling completion", async () => {
		const local = resolveManagedAgentStopTarget(managedChainAgent());
		const remoteTarget = {
			schemaVersion: 1 as const,
			hostId: "host-remote",
			host: "remote.test",
			port: 22,
			user: "agent",
			auth: "auto" as const,
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		};
		const target: ManagedAgentStopTarget = {
			...resolveManagedAgentStopTarget(
				managedChainAgent({
					runtimeBinding: {
						...local.binding,
						source: "ssh",
						hostId: remoteTarget.hostId,
						commandBridgeNonce: "bridge",
						createIdempotencyKey: "create-managed",
					},
				}),
			),
			remoteTarget,
		};
		mocks.reconcileManagedClose.mockResolvedValue(chainStopReceipt());
		expect((await reconcileManagedAgentStop(target))?.target).toBe(target);
		expect(mocks.reconcileManagedClose).toHaveBeenCalledWith({
			idempotencyKey: "create-managed",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			target: remoteTarget,
		});
		expect(mocks.prepareTrustedSsh).not.toHaveBeenCalled();
		expect(mocks.remoteCatalog).not.toHaveBeenCalled();
		expect(mocks.remoteManagedStop).not.toHaveBeenCalled();
		expect(mocks.remoteManagedCreateChainStop).not.toHaveBeenCalled();
	});

	it.each(["completion", "cleanup"] as const)(
		"keeps the CLI's SSH target when host configuration changes during %s",
		async (phase) => {
			const host: SshHostConfig = {
				id: "host-remote",
				name: "Remote",
				host: "original.test",
				port: 22,
				user: "agent",
				auth: "auto",
			};
			const source = managedChainAgent({
				sessionKind: "ssh",
				runtimeBinding: {
					...managedBindingFixture(),
					source: "ssh",
					hostId: host.id,
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					createIdempotencyKey: "create-managed",
					commandBridgeNonce: "bridge",
				},
			});
			useStore.setState({ agents: [source], sshHosts: [host] });
			const changeHost = () =>
				useStore.setState({
					sshHosts: [{ ...host, host: "replacement.test", port: 2222 }],
				});
			mocks.reconcileManagedClose.mockImplementation(async () => {
				if (phase === "completion") changeHost();
				return null;
			});
			const cleanupExited = vi.fn(async () => {
				if (phase === "cleanup") changeHost();
				return undefined;
			});
			mocks.remoteManagedCreateChainStop.mockResolvedValue(chainStopReceipt());
			const target = resolveManagedAgentStopTarget(source);
			const finalize = vi.fn().mockResolvedValue(undefined);
			await expect(
				handleCliHmuxStop({ name: source.id }, `ssh-target-${phase}`, {
					claim: async () => true,
					prepare: prepareManagedAgentStopTarget,
					resolve: () => ({
						target,
						selection: { kind: "agent", agentId: source.id },
					}),
					reconcile: reconcileManagedAgentStop,
					cleanupExited,
					stop: stopManagedAgentProvider,
					finalize,
				}),
			).resolves.toMatchObject({ ok: true });
			const observedTarget =
				mocks.reconcileManagedClose.mock.calls[0][0].target;
			expect(observedTarget.host).toBe("original.test");
			expect(mocks.remoteManagedCreateChainStop.mock.calls[0][0].target).toBe(
				observedTarget,
			);
			expect(finalize.mock.calls[0][0].remoteTarget).toBe(observedTarget);
			expect(mocks.prepareTrustedSsh).toHaveBeenCalledOnce();
		},
	);

	it("stops only the exact managed session and validates its receipt", async () => {
		mocks.stopManaged.mockImplementation(async (stopId: string) =>
			stopReceipt({ stopId }),
		);

		const target = resolveManagedAgentStopTarget("HebbianIDE/codex-1");
		const { receipt } = await stopManagedAgentProvider(target);

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.stringMatching(/^stop_[0-9a-f]{16}$/),
			"session-managed",
			"workspace-managed",
			stopFence,
		);
		expect(receipt).toMatchObject({
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
		});
	});

	it.each([
		{ kind: "exact", create: managedAgent },
		{ kind: "chain", create: managedChainAgent },
	])(
		"preserves $kind stop authority for direct and named Agent selection",
		async ({ kind, create }) => {
			const agent = create();
			useStore.setState({ agents: [agent], layouts: {} });
			const named = await prepareManagedAgentStopOperation(
				resolveManagedAgentStopTarget(agent.id),
			);
			const direct = await prepareManagedAgentStopOperation(agent);
			expect(named.kind).toBe(kind);
			expect(direct).toEqual(named);
			expect(direct.target.agent).toBe(agent);
			expect(direct.target).not.toHaveProperty("panelId");
			expect(mocks.stopManaged).not.toHaveBeenCalled();
			expect(mocks.stopManagedCreateChain).not.toHaveBeenCalled();
		},
	);

	it("keeps pane constraints out of the runtime target contract", () => {
		expectTypeOf<keyof ManagedAgentStopTarget>().toEqualTypeOf<
			"agent" | "binding" | "remoteTarget"
		>();
		expectTypeOf<
			typeof resolveManagedAgentStopTarget
		>().parameters.toEqualTypeOf<[string | Agent]>();
	});

	it("preserves an already-selected Agent snapshot without another name lookup", () => {
		const selected = managedAgent();
		const replacement = managedAgent({
			sessionId: "replacement-session",
			runtimeBinding: managedBindingFixture({
				sessionId: "replacement-session",
			}),
		});
		useStore.setState({ agents: [replacement] });
		const target = resolveManagedAgentStopTarget(selected);
		expect(target.agent).toBe(selected);
		expect(target.binding.sessionId).toBe("session-managed");
		expect(resolveManagedAgentStopTarget(selected.id).agent).toBe(replacement);
	});

	it("refuses a canonical Agent before catalog or provider effects", async () => {
		const canonical = managedAgent({
			canonicalSpawn: {
				schemaVersion: 1,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		});
		useStore.setState({ agents: [canonical] });

		await expect(stopManagedAgentProvider(canonical)).rejects.toMatchObject({
			code: "canonical_agent_legacy_writer_refused",
		});
		expect(mocks.probeSessions).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("routes a ledger-backed binding through the successor-chain authority", async () => {
		useStore.setState({ agents: [managedChainAgent()] });
		const target = resolveManagedAgentStopTarget("agent-managed");

		const stopped = await stopManagedAgentProvider(target);
		await finalizeManagedAgentRemoval(stopped.target, stopped.receipt);

		expect(mocks.stopManagedCreateChain).toHaveBeenCalledWith(
			"create-managed",
			"session-managed",
			"workspace-managed",
		);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.probeSessions).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledWith(
			MANAGED_AGENT_CHAIN_STOPPED_EVENT,
			expect.objectContaining({
				schemaVersion: 4,
				registration: expect.objectContaining({ id: "agent-managed" }),
			}),
		);
		expect(mocks.emit).toHaveBeenCalledWith(
			LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT,
			expect.objectContaining({
				schemaVersion: 2,
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				stopFence,
				receipt: expect.objectContaining({ stopId: "chain-stop" }),
			}),
		);
		expect(mocks.emit).toHaveBeenCalledWith(
			LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT,
			expect.objectContaining({
				schemaVersion: 3,
				receipt: expect.objectContaining({
					schemaVersion: 1,
					root: expect.objectContaining({ sessionId: "session-managed" }),
				}),
			}),
		);
		expect(mocks.emit).toHaveBeenCalledWith(
			LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT,
			expect.objectContaining({
				schemaVersion: 3,
				receipt: expect.objectContaining({
					schemaVersion: 1,
					chain: expect.any(Array),
				}),
			}),
		);
		expect(mocks.emit).not.toHaveBeenCalledWith(
			MANAGED_AGENT_STOPPED_EVENT,
			expect.anything(),
		);
		expect(useStore.getState().agents).toEqual([]);
	});

	it.each([
		new Error(
			"hmux_managed_create_chain_stop_not_found: managed create root is absent from the durable ledger",
		),
		"hmux_remote_managed_create_chain_stop_not_found: managed create root is absent from the durable ledger",
		new Error(
			"session_checkout_failed: hmux_managed_create_chain_stop_not_found: managed create root is absent from the durable ledger",
		),
		"session_checkout_failed: hmux_remote_managed_create_chain_stop_not_found: managed create root is absent from the durable ledger",
	])(
		"normalizes an already-absent create chain into a no-op stop",
		async (error) => {
			mocks.stopManagedCreateChain.mockRejectedValue(error);
			useStore.setState({ agents: [managedChainAgent()] });
			const operation = await prepareManagedAgentStopOperation(
				resolveManagedAgentStopTarget("agent-managed"),
			);

			await expect(stopPreparedManagedAgentProvider(operation)).rejects.toEqual(
				new ManagedSessionAbsentError("session-managed", "workspace-managed"),
			);
		},
	);

	it.each([
		"session_checkout_failed: hmux_managed_create_chain_stop_pending: creation is still pending",
		"session_checkout_failed: hmux_managed_create_chain_stop_authority_unavailable: ledger unavailable",
		"session_checkout_failed: hmux_managed_create_chain_stop_refused: hmux_managed_create_chain_stop_not_found",
		"transport_failed: session_checkout_failed: hmux_managed_create_chain_stop_not_found",
	])("preserves non-absence create-chain failures: %s", async (message) => {
		const error = new Error(message);
		mocks.stopManagedCreateChain.mockRejectedValue(error);
		const agent = managedChainAgent();
		useStore.setState({ agents: [agent] });

		await expect(stopManagedAgentProvider(agent)).rejects.toBe(error);
		expect(useStore.getState().agents).toEqual([agent]);
	});

	it("keeps exact-only v3 WebViews from mis-deleting on a chain payload", async () => {
		useStore.setState({ agents: [managedChainAgent()] });
		const payload = {
			schemaVersion: 4,
			registration: agentRemovalRegistrationIdentity(managedChainAgent()),
			authority: { source: "local" },
			receipt: chainStopReceipt(),
		};

		await expect(applyManagedAgentStoppedSync(payload)).resolves.toBe(false);
		expect(useStore.getState().agents).toHaveLength(1);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("keeps current WebViews from adopting registration-free legacy cleanup", async () => {
		useStore.setState({ agents: [managedChainAgent()] });
		const legacy = {
			schemaVersion: 3,
			agentId: "agent-managed",
			source: "local",
			hostId: "local",
			receipt: managedCreateChainStopLegacyOrderedV1EventProjection(
				chainStopReceipt(),
			),
		};

		await expect(applyManagedAgentChainStoppedSync(legacy)).resolves.toBe(
			false,
		);
		expect(useStore.getState().agents).toHaveLength(1);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("removes a chain that closed before any provider generation completed", async () => {
		const { stopReceipt: _stopReceipt, ...closed } = chainStopReceipt();
		mocks.stopManagedCreateChain.mockResolvedValue(closed);
		useStore.setState({ agents: [managedChainAgent()] });
		const target = resolveManagedAgentStopTarget("agent-managed");

		const stopped = await stopManagedAgentProvider(target);
		await finalizeManagedAgentRemoval(stopped.target, stopped.receipt);

		expect(mocks.stopManagedCreateChain).toHaveBeenCalledOnce();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([]);
	});

	it("removes root, intermediate, and effective projections named by a three-hop chain", async () => {
		const source = managedChainAgent();
		useStore.setState({ agents: [source] });
		const target = resolveManagedAgentStopTarget(source.id);
		const identities = [
			chainStopReceipt().chain[0],
			{
				schema: "hmux-managed-create-reconcile-v1" as const,
				schemaVersion: 1 as const,
				idempotencyKey: "create-intermediate",
				sessionId: "session-intermediate",
				workspaceId: "workspace-managed",
			},
			{
				schema: "hmux-managed-create-reconcile-v1" as const,
				schemaVersion: 1 as const,
				idempotencyKey: "create-effective",
				sessionId: "session-effective",
				workspaceId: "workspace-managed",
			},
		] as const;
		const receipt = chainStopReceipt({
			chain: [...identities],
			stopReceipt: stopReceipt({
				sessionId: identities[2].sessionId,
			}),
		});

		for (const identity of identities) {
			useStore.setState({
				agents: [
					managedChainAgent({
						sessionId: identity.sessionId,
						runtimeBinding: managedBindingFixture({
							sessionId: identity.sessionId,
							workspaceId: identity.workspaceId,
							createIdempotencyKey: identity.idempotencyKey,
							stopFence: replacementFence,
						}),
					}),
				],
			});

			await finalizeManagedAgentRemoval(target, receipt);
			expect(useStore.getState().agents).toEqual([]);
		}
	});

	it("removes a successor projected while canonical chain cleanup is applying", async () => {
		const host = {
			id: "host-remote",
			name: "remote",
			host: "remote.test",
			port: 22,
			user: "agent",
			auth: "auto" as const,
		};
		const authority = {
			schemaVersion: 1 as const,
			hostId: host.id,
			host: host.host,
			port: host.port,
			user: host.user,
			auth: host.auth,
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		};
		const source = managedChainAgent({
			sessionKind: "ssh",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: host.id,
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-managed",
				commandBridgeNonce: "bridge-managed",
				stopFence,
			},
		});
		const effectiveIdentity = {
			schema: "hmux-managed-create-reconcile-v1" as const,
			schemaVersion: 1 as const,
			idempotencyKey: "create-effective",
			sessionId: "session-effective",
			workspaceId: "workspace-managed",
		};
		const receipt = chainStopReceipt({
			chain: [chainStopReceipt().chain[0], effectiveIdentity],
			stopReceipt: stopReceipt({ sessionId: effectiveIdentity.sessionId }),
		});
		const payload = {
			schemaVersion: 4,
			registration: agentRemovalRegistrationIdentity(source),
			authority: { source: "ssh", target: authority },
			receipt,
		};
		useStore.setState({ agents: [source], sshHosts: [host] });
		let releaseAuthority: (() => void) | undefined;
		mocks.prepareTrustedSsh.mockImplementationOnce(
			() =>
				new Promise<typeof authority>((resolve) => {
					releaseAuthority = () => resolve(authority);
				}),
		);

		const applying = applyManagedAgentChainStoppedSync(payload);
		await vi.waitFor(() =>
			expect(mocks.prepareTrustedSsh).toHaveBeenCalledOnce(),
		);
		useStore.setState({
			agents: [
				managedChainAgent({
					sessionKind: "ssh",
					sessionId: effectiveIdentity.sessionId,
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "ssh",
						hostId: host.id,
						sessionId: effectiveIdentity.sessionId,
						workspaceId: effectiveIdentity.workspaceId,
						createIdempotencyKey: effectiveIdentity.idempotencyKey,
						commandBridgeNonce: "bridge-managed",
						stopFence: replacementFence,
					},
				}),
			],
		});
		releaseAuthority?.();

		await expect(applying).resolves.toBe(true);
		expect(useStore.getState().agents).toEqual([]);
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("does not clean a remote stopped chain when projection recovery fails", async () => {
		const host = {
			id: "host-remote",
			name: "remote",
			host: "remote.test",
			port: 22,
			user: "agent",
			auth: "auto" as const,
		};
		const authority = {
			schemaVersion: 1 as const,
			hostId: host.id,
			host: host.host,
			port: host.port,
			user: host.user,
			auth: host.auth,
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		};
		const source = managedChainAgent({
			sessionKind: "ssh",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: host.id,
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-managed",
				commandBridgeNonce: "bridge-managed",
				stopFence,
			},
		});
		useStore.setState({ agents: [source], sshHosts: [host] });
		mocks.recoverProjection.mockResolvedValue(false);

		await expect(
			applyManagedAgentChainStoppedSync({
				schemaVersion: 4,
				registration: agentRemovalRegistrationIdentity(source),
				authority: { source: "ssh", target: authority },
				receipt: chainStopReceipt(),
			}),
		).resolves.toBe(false);

		expect(useStore.getState().agents).toEqual([source]);
		expect(mocks.prepareTrustedSsh).not.toHaveBeenCalled();
	});

	it("preserves a later binding outside the stopped chain", async () => {
		const source = managedChainAgent();
		useStore.setState({ agents: [source] });
		const target = resolveManagedAgentStopTarget(source.id);
		const later = managedChainAgent({
			sessionId: "session-later",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-later",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-later",
				stopFence: replacementFence,
			}),
		});
		useStore.setState({ agents: [later] });

		await expect(
			finalizeManagedAgentRemoval(target, chainStopReceipt()),
		).rejects.toMatchObject({ code: "pane_changed" });

		expect(useStore.getState().agents).toEqual([later]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("preserves a newer cross-WebView successor outside the stopped chain", async () => {
		const source = managedChainAgent();
		useStore.setState({
			agents: [source],
			layouts: {
				"space-managed": {
					panels: {
						"agent:agent-managed": { generation: "source", params: {} },
					},
				},
			},
		});
		await durableAppStorage.flush();
		const durable = JSON.parse(localStorage.getItem("agent-ide") ?? "null") as {
			state: { agents: Agent[]; layouts: Record<string, unknown> };
			version: number;
		};
		const successor = managedChainAgent({
			sessionId: "session-later",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-later",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-later",
				stopFence: replacementFence,
			}),
		});
		localStorage.setItem(
			"agent-ide",
			JSON.stringify({
				...durable,
				state: {
					...durable.state,
					agents: [successor],
					layouts: {
						"space-managed": {
							panels: {
								"agent:agent-managed": { generation: "successor", params: {} },
							},
						},
					},
				},
			}),
		);

		const applied = await applyManagedAgentChainStoppedSync({
			schemaVersion: 4,
			registration: agentRemovalRegistrationIdentity(source),
			authority: { source: "local" },
			receipt: chainStopReceipt(),
		});

		const persisted = JSON.parse(
			localStorage.getItem("agent-ide") ?? "null",
		) as {
			state: { agents: Agent[]; layouts: Record<string, unknown> };
		};
		expect(applied).toBe(false);
		expect(persisted.state.agents).toEqual([successor]);
		expect(persisted.state.layouts).toEqual({
			"space-managed": {
				panels: {
					"agent:agent-managed": {
						generation: "successor",
						params: {},
					},
				},
			},
		});
	});

	it("atomically removes a newer cross-WebView successor inside the stopped chain", async () => {
		const source = managedChainAgent();
		const sourceLayout = {
			panels: {
				"agent:agent-managed": {
					id: "agent:agent-managed",
					component: "agent",
				},
				"file:keep": { id: "file:keep" },
			},
		};
		const otherLayout = {
			panels: {
				"agent:agent-managed": {
					id: "agent:agent-managed",
					component: "agent",
				},
				"file:other": { id: "file:other" },
			},
		};
		useStore.setState({
			agents: [source],
			layouts: {
				"space-managed": sourceLayout,
				"space-other": otherLayout,
			},
		});
		await durableAppStorage.flush();
		const durable = JSON.parse(localStorage.getItem("agent-ide") ?? "null") as {
			state: { agents: Agent[]; layouts: Record<string, unknown> };
			version: number;
		};
		const effectiveIdentity = {
			schema: "hmux-managed-create-reconcile-v1" as const,
			schemaVersion: 1 as const,
			idempotencyKey: "create-effective",
			sessionId: "session-effective",
			workspaceId: "workspace-managed",
		};
		const successor = managedChainAgent({
			sessionId: effectiveIdentity.sessionId,
			runtimeBinding: managedBindingFixture({
				sessionId: effectiveIdentity.sessionId,
				workspaceId: effectiveIdentity.workspaceId,
				createIdempotencyKey: effectiveIdentity.idempotencyKey,
				stopFence: replacementFence,
			}),
		});
		localStorage.setItem(
			"agent-ide",
			JSON.stringify({
				...durable,
				state: {
					...durable.state,
					agents: [successor],
					layouts: {
						"space-managed": sourceLayout,
						"space-other": otherLayout,
					},
				},
			}),
		);

		const applied = await applyManagedAgentChainStoppedSync({
			schemaVersion: 4,
			registration: agentRemovalRegistrationIdentity(source),
			authority: { source: "local" },
			receipt: chainStopReceipt({
				chain: [chainStopReceipt().chain[0], effectiveIdentity],
				stopReceipt: stopReceipt({ sessionId: effectiveIdentity.sessionId }),
			}),
		});

		const persisted = JSON.parse(
			localStorage.getItem("agent-ide") ?? "null",
		) as {
			state: {
				agents: Agent[];
				layouts: Record<string, { panels: Record<string, unknown> }>;
			};
		};
		expect(applied).toBe(true);
		expect(persisted.state.agents).toEqual([]);
		expect(persisted.state.layouts["space-managed"].panels).toEqual({
			"file:keep": { id: "file:keep" },
		});
		expect(persisted.state.layouts["space-other"].panels).toEqual({
			"file:other": { id: "file:other" },
		});
		expect(useStore.getState().agents).toEqual([]);
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("preserves a newer durable exact-stop generation over a stale WebView", async () => {
		const source = managedAgent();
		useStore.setState({ agents: [source] });
		await durableAppStorage.flush();
		const durable = JSON.parse(localStorage.getItem("agent-ide") ?? "null") as {
			state: { agents: Agent[] };
			version: number;
		};
		const successor = managedAgent({
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: replacementFence,
			}),
		});
		localStorage.setItem(
			"agent-ide",
			JSON.stringify({
				...durable,
				state: { ...durable.state, agents: [successor] },
			}),
		);

		const applied = await applyManagedAgentStoppedSync({
			schemaVersion: 3,
			registration: agentRemovalRegistrationIdentity(source),
			receipt: stopReceipt({ stopId: "stop-stale-webview" }),
		});

		const persisted = JSON.parse(
			localStorage.getItem("agent-ide") ?? "null",
		) as {
			state: { agents: Agent[] };
		};
		expect(applied).toBe(false);
		expect(persisted.state.agents).toEqual([successor]);
		expect(useStore.getState().agents).toEqual([successor]);
	});

	it("removes a dangling durable pane when the stopped Agent is already absent", async () => {
		const source = managedAgent();
		useStore.setState({
			agents: [],
			layouts: {
				"space-managed": {
					panels: {
						"agent:agent-managed": {
							id: "agent:agent-managed",
							component: "agent",
						},
						"file:keep": { id: "file:keep" },
					},
				},
			},
		});
		await durableAppStorage.flush();

		await expect(
			applyManagedAgentStoppedSync({
				schemaVersion: 3,
				registration: agentRemovalRegistrationIdentity(source),
				receipt: stopReceipt(),
			}),
		).resolves.toBe(true);

		const persisted = JSON.parse(
			localStorage.getItem("agent-ide") ?? "null",
		) as {
			state: { layouts: Record<string, { panels: Record<string, unknown> }> };
		};
		expect(persisted.state.layouts["space-managed"].panels).toEqual({
			"file:keep": { id: "file:keep" },
		});
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("converges the current store to a successor committed after the durable stop transaction", async () => {
		const source = managedChainAgent();
		useStore.setState({
			agents: [source],
			layouts: {
				"space-managed": {
					panels: { "agent:agent-managed": { id: "agent:agent-managed" } },
				},
			},
		});
		await durableAppStorage.flush();
		const successor = managedChainAgent({
			sessionId: "session-successor",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-successor",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-successor",
				stopFence: replacementFence,
			}),
		});
		const transact = durableAppStorage.transact.bind(durableAppStorage);
		const transaction = vi
			.spyOn(durableAppStorage, "transact")
			.mockImplementationOnce(async (name, mutation) => {
				const result = await transact(name, mutation);
				const committed = JSON.parse(
					localStorage.getItem("agent-ide") ?? "null",
				) as {
					state: { agents: Agent[]; layouts: Record<string, unknown> };
					version: number;
				};
				localStorage.setItem(
					"agent-ide",
					JSON.stringify({
						...committed,
						state: {
							...committed.state,
							agents: [successor],
							layouts: {
								"space-managed": {
									panels: {
										"agent:agent-managed": {
											id: "agent:agent-managed",
										},
									},
								},
							},
						},
					}),
				);
				return result;
			});

		try {
			await expect(
				applyManagedAgentChainStoppedSync({
					schemaVersion: 4,
					registration: agentRemovalRegistrationIdentity(source),
					authority: { source: "local" },
					receipt: chainStopReceipt(),
				}),
			).resolves.toBe(true);
		} finally {
			transaction.mockRestore();
		}

		expect(useStore.getState().agents).toEqual([successor]);
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("stops the exact current catalog generation when a persisted fence is stale", async () => {
		const stale = managedAgent({
			conversationId: undefined,
			runtimeBinding: {
				...managedAgent().runtimeBinding,
				stopFence,
			} as Agent["runtimeBinding"],
		});
		mocks.probeSessions.mockResolvedValue([
			{
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				sessionClass: "managed",
				lifecycle: "ready",
				manifestLifecycle: "ready",
				terminalEpoch: replacementFence.terminalEpoch,
				stopFence: replacementFence,
				outputSeq: "0",
				capabilities: [],
			},
		]);
		mocks.stopManaged.mockImplementation(
			async (
				stopId: string,
				_sessionId: string,
				_workspaceId: string,
				fence: typeof stopFence,
			) => {
				if (fence.terminalEpoch !== replacementFence.terminalEpoch) {
					throw new Error(
						"hmux_managed_stop_refused: managed session generation changed before provider stop",
					);
				}
				return stopReceipt({
					stopId,
					runnerInstance: replacementFence.runnerInstance,
					hostInstanceId: replacementFence.hostInstanceId,
					terminalEpoch: replacementFence.terminalEpoch,
				});
			},
		);
		useStore.setState({ agents: [stale] });
		const target = resolveManagedAgentStopTarget("agent-managed");

		const stopped = await stopManagedAgentProvider(target);
		await finalizeManagedAgentRemoval(stopped.target, stopped.receipt);

		expect(mocks.probeSessions).toHaveBeenCalledWith(["session-managed"]);
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.stringMatching(/^stop_[0-9a-f]{16}$/),
			"session-managed",
			"workspace-managed",
			replacementFence,
		);
		expect(mocks.emit).toHaveBeenCalledWith(
			MANAGED_AGENT_STOPPED_EVENT,
			expect.objectContaining({
				registration: expect.objectContaining({
					runtimeBinding: expect.objectContaining({ stopFence }),
				}),
				receipt: expect.objectContaining({
					terminalEpoch: replacementFence.terminalEpoch,
				}),
			}),
		);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("retries with a refreshed catalog fence when the generation advances again", async () => {
		const recovered = managedAgent({
			conversationId: "conversation-current",
			runtimeBinding: {
				...managedAgent().runtimeBinding,
				stopFence,
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					...replacementFence,
					revision: "1",
					observedThroughOutputSeq: "0",
					providerId: "codex",
					conversationId: "conversation-current",
					source: "launch_request",
				},
			} as Agent["runtimeBinding"],
		});
		const differentLiveFence = {
			...replacementFence,
			terminalEpoch: "terminal-other",
		};
		mocks.probeSessions
			.mockResolvedValueOnce([
				{
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					sessionClass: "managed",
					lifecycle: "ready",
					manifestLifecycle: "ready",
					terminalEpoch: differentLiveFence.terminalEpoch,
					stopFence: differentLiveFence,
					outputSeq: "0",
					capabilities: [],
				},
			])
			.mockResolvedValueOnce([
				{
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					sessionClass: "managed",
					lifecycle: "ready",
					manifestLifecycle: "ready",
					terminalEpoch: replacementFence.terminalEpoch,
					stopFence: replacementFence,
					outputSeq: "0",
					capabilities: [],
				},
			]);
		mocks.stopManaged.mockImplementation(async (stopId: string) =>
			stopReceipt({
				stopId,
				runnerInstance: replacementFence.runnerInstance,
				hostInstanceId: replacementFence.hostInstanceId,
				terminalEpoch: replacementFence.terminalEpoch,
			}),
		);
		useStore.setState({ agents: [recovered] });
		const target = resolveManagedAgentStopTarget("agent-managed");

		await expect(stopManagedAgentProvider(target)).rejects.toMatchObject({
			code: "pane_changed",
		});
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.stringMatching(/^stop_[0-9a-f]{16}$/),
			"session-managed",
			"workspace-managed",
			differentLiveFence,
		);
		const stopped = await stopManagedAgentProvider(target);
		await finalizeManagedAgentRemoval(stopped.target, stopped.receipt);

		expect(mocks.probeSessions).toHaveBeenCalledTimes(2);
		expect(mocks.probeSessions).toHaveBeenCalledWith(["session-managed"]);
		expect(mocks.stopManaged).toHaveBeenLastCalledWith(
			expect.stringMatching(/^stop_[0-9a-f]{16}$/),
			"session-managed",
			"workspace-managed",
			replacementFence,
		);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("uses the exact catalog fence when its conversation projection is stale", async () => {
		const staleConversationFence = {
			...replacementFence,
			terminalEpoch: "terminal-predecessor",
		};
		const recovered = managedAgent({
			conversationId: "conversation-current",
			runtimeBinding: {
				...managedAgent().runtimeBinding,
				stopFence,
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					...staleConversationFence,
					revision: "1",
					observedThroughOutputSeq: "0",
					providerId: "codex",
					conversationId: "conversation-current",
					source: "launch_request",
				},
			} as Agent["runtimeBinding"],
		});
		mocks.probeSessions.mockResolvedValue([
			{
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				sessionClass: "managed",
				lifecycle: "ready",
				manifestLifecycle: "ready",
				terminalEpoch: stopFence.terminalEpoch,
				stopFence,
				outputSeq: "0",
				capabilities: [],
			},
		]);
		mocks.stopManaged.mockImplementation(async (stopId: string) =>
			stopReceipt({ stopId }),
		);
		useStore.setState({ agents: [recovered] });
		const target = resolveManagedAgentStopTarget("agent-managed");

		const stopped = await stopManagedAgentProvider(target);
		await finalizeManagedAgentRemoval(stopped.target, stopped.receipt);

		expect(mocks.probeSessions).toHaveBeenCalledWith(["session-managed"]);
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.stringMatching(/^stop_[0-9a-f]{16}$/),
			"session-managed",
			"workspace-managed",
			stopFence,
		);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("resolves and rechecks the exact manifest fence for a pre-ledger binding", async () => {
		const legacy = managedAgent({
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
			}),
		});
		mocks.probeSessions.mockResolvedValue([
			{
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				sessionClass: "managed",
				lifecycle: "ready",
				manifestLifecycle: "ready",
				terminalEpoch: stopFence.terminalEpoch,
				stopFence,
				outputSeq: "42",
				capabilities: [],
			},
		]);
		mocks.stopManaged.mockImplementation(async (stopId: string) =>
			stopReceipt({ stopId }),
		);
		useStore.setState({ agents: [legacy] });
		const target = resolveManagedAgentStopTarget("agent-managed");

		const stopped = await stopManagedAgentProvider(target);

		expect(mocks.probeSessions).toHaveBeenCalledWith(["session-managed"]);
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.stringMatching(/^stop_[0-9a-f]{16}$/),
			"session-managed",
			"workspace-managed",
			stopFence,
		);
		await finalizeManagedAgentRemoval(stopped.target, stopped.receipt);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("uses the exact catalog generation when a legacy binding has no stop fence", async () => {
		const legacy = managedAgent({
			conversationId: "conversation-current",
			runtimeBinding: {
				...managedAgent().runtimeBinding,
				stopFence: undefined,
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					...stopFence,
					revision: "1",
					observedThroughOutputSeq: "0",
					providerId: "codex",
					conversationId: "conversation-current",
					source: "launch_request",
				},
			} as Agent["runtimeBinding"],
		});
		mocks.stopManaged.mockImplementation(async (stopId: string) =>
			stopReceipt({ stopId }),
		);
		useStore.setState({ agents: [legacy] });
		const target = resolveManagedAgentStopTarget("agent-managed");

		const { receipt } = await stopManagedAgentProvider(target);

		expect(mocks.probeSessions).toHaveBeenCalledWith(["session-managed"]);
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.stringMatching(/^stop_[0-9a-f]{16}$/),
			"session-managed",
			"workspace-managed",
			stopFence,
		);
		expect(receipt).toMatchObject({ outcome: "stopped" });
	});

	it("delegates remote fence resolution and durable replay to the backend", async () => {
		const remote = managedAgent({
			sessionKind: "ssh",
			worktreePath: "/home/agent/repo",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "host-remote",
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-remote",
				stopFence,
			},
		});
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "Remote",
					path: "/home/agent/repo",
					kind: "ssh",
					sshHostId: "host-remote",
					isRepo: true,
				},
			],
			agents: [remote],
			sshHosts: [
				{
					id: "host-remote",
					name: "remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
				},
			],
		});
		mocks.remoteManagedCreateChainStop.mockResolvedValue(
			chainStopReceipt({
				chain: [
					{
						schema: "hmux-managed-create-reconcile-v1",
						schemaVersion: 1,
						idempotencyKey: "create-remote",
						sessionId: "session-managed",
						workspaceId: "workspace-managed",
					},
				],
			}),
		);

		const stopped = await stopManagedAgentProvider(remote);
		const { receipt } = stopped;
		await finalizeManagedAgentRemoval(stopped.target, receipt);

		expect(receipt).toMatchObject({
			schema: "hmux-managed-create-chain-stop-v2",
		});
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.remoteManagedStop).not.toHaveBeenCalled();
		expect(mocks.remoteManagedCreateChainStop).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "create-remote",
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
			}),
		);
		expect(useStore.getState().agents).toEqual([]);
	});

	it.each([
		["endpoint", "replacement.test", "SHA256:source"],
		["trust", "source.test", "SHA256:replacement"],
	] as const)(
		"preserves a same-hostId SSH rebound when %s changes during stop",
		async (_change, replacementEndpoint, replacementFingerprint) => {
			const sourceHost = {
				id: "host-remote",
				name: "remote",
				host: "source.test",
				port: 22,
				user: "agent",
				auth: "auto" as const,
			};
			const remote = managedAgent({
				sessionKind: "ssh",
				worktreePath: "/home/agent/repo",
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_managed_v1",
					source: "ssh",
					hostId: sourceHost.id,
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					createIdempotencyKey: "create-remote",
					commandBridgeNonce: "bridge-remote",
				},
			});
			const replacementHost = { ...sourceHost, host: replacementEndpoint };
			const remoteReceipt = chainStopReceipt({
				chain: [
					{
						schema: "hmux-managed-create-reconcile-v1",
						schemaVersion: 1,
						idempotencyKey: "create-remote",
						sessionId: "session-managed",
						workspaceId: "workspace-managed",
					},
				],
			});
			useStore.setState({ agents: [remote], sshHosts: [sourceHost] });
			let authorityResolution = 0;
			mocks.prepareTrustedSsh.mockImplementation(
				async (hosts: readonly SshHostConfig[], hostId: string) => {
					const host = hosts.find((candidate) => candidate.id === hostId);
					if (!host) throw new Error("trusted_ssh_host_not_registered");
					return {
						schemaVersion: 1 as const,
						hostId: host.id,
						host: host.host,
						port: host.port,
						user: host.user,
						auth: host.auth,
						...(host.secretId ? { secretId: host.secretId } : {}),
						...(host.keyPath ? { keyPath: host.keyPath } : {}),
						hostKeyFingerprints: [
							authorityResolution++ === 0
								? "SHA256:source"
								: replacementFingerprint,
						],
					};
				},
			);
			let release: (() => void) | undefined;
			mocks.remoteManagedCreateChainStop.mockImplementation(
				() =>
					new Promise<HmuxManagedCreateChainStopReceipt>((resolve) => {
						release = () => resolve(remoteReceipt);
					}),
			);

			const stopping = stopManagedAgentProvider(remote);
			await vi.waitFor(() =>
				expect(mocks.remoteManagedCreateChainStop).toHaveBeenCalledOnce(),
			);
			const rebound = { ...remote };
			useStore.setState({
				agents: [rebound],
				sshHosts: [replacementHost],
			});
			release?.();
			const stopped = await stopping;

			await expect(
				finalizeManagedAgentRemoval(stopped.target, stopped.receipt),
			).rejects.toMatchObject({ code: "pane_changed" });

			expect(mocks.prepareTrustedSsh).toHaveBeenCalledTimes(2);
			expect(mocks.remoteCatalog).not.toHaveBeenCalled();
			expect(mocks.remoteManagedCreateChainStop).toHaveBeenCalledWith(
				expect.objectContaining({
					target: expect.objectContaining({ host: sourceHost.host }),
				}),
			);
			expect(useStore.getState().agents).toEqual([rebound]);
			expect(mocks.removePanels).not.toHaveBeenCalled();
			expect(mocks.emit).toHaveBeenCalledWith(
				MANAGED_AGENT_CHAIN_STOPPED_EVENT,
				expect.objectContaining({
					authority: {
						source: "ssh",
						target: expect.objectContaining({
							host: sourceHost.host,
							hostKeyFingerprints: ["SHA256:source"],
						}),
					},
				}),
			);
			expect(mocks.emit).not.toHaveBeenCalledWith(
				LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT,
				expect.anything(),
			);
		},
	);

	it("does not coalesce stops prepared for different remote authorities", async () => {
		const remote = managedAgent({
			sessionKind: "ssh",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "host-remote",
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-remote",
				stopFence,
			},
		});
		useStore.setState({ agents: [remote] });
		const resolved = resolveManagedAgentStopTarget(remote.id);
		const authority = (host: string) => ({
			schemaVersion: 1 as const,
			hostId: "host-remote",
			host,
			port: 22,
			user: "agent",
			auth: "auto" as const,
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		});
		const releases: Array<() => void> = [];
		mocks.remoteManagedCreateChainStop.mockImplementation(
			() =>
				new Promise<HmuxManagedCreateChainStopReceipt>((resolve) => {
					releases.push(() =>
						resolve(
							chainStopReceipt({
								chain: [
									{
										schema: "hmux-managed-create-reconcile-v1",
										schemaVersion: 1,
										idempotencyKey: "create-remote",
										sessionId: "session-managed",
										workspaceId: "workspace-managed",
									},
								],
							}),
						),
					);
				}),
		);

		const first = stopManagedAgentProvider({
			...resolved,
			remoteTarget: authority("source.test"),
		});
		const second = stopManagedAgentProvider({
			...resolved,
			remoteTarget: authority("replacement.test"),
		});

		await vi.waitFor(() =>
			expect(mocks.remoteManagedCreateChainStop).toHaveBeenCalledTimes(2),
		);
		expect(
			mocks.remoteManagedCreateChainStop.mock.calls.map(
				([request]) => request.target.host,
			),
		).toEqual(["source.test", "replacement.test"]);
		for (const release of releases) release();
		await Promise.all([first, second]);
	});

	it("coalesces concurrent retries onto one provider-stop operation", async () => {
		let release: ((receipt: HmuxManagedStopReceipt) => void) | undefined;
		mocks.stopManaged.mockImplementation(
			(stopId: string) =>
				new Promise<HmuxManagedStopReceipt>((resolve) => {
					release = (receipt) => resolve({ ...receipt, stopId });
				}),
		);
		const target = resolveManagedAgentStopTarget("agent-managed");

		const first = stopManagedAgentProvider(target);
		const second = stopManagedAgentProvider(target);
		await vi.waitFor(() => expect(mocks.stopManaged).toHaveBeenCalledOnce());
		release?.(stopReceipt());

		await expect(first).resolves.toMatchObject({
			receipt: { outcome: "stopped" },
		});
		await expect(second).resolves.toMatchObject({
			receipt: { outcome: "stopped" },
		});
	});

	it("retries an ambiguous remote stop through the same durable root identity", async () => {
		const remote = managedAgent({
			sessionKind: "ssh",
			worktreePath: "/home/agent/repo",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "host-remote",
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-remote",
				stopFence,
			},
		});
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "Remote",
					path: "/home/agent/repo",
					kind: "ssh",
					sshHostId: "host-remote",
					isRepo: true,
				},
			],
			agents: [remote],
			sshHosts: [
				{
					id: "host-remote",
					name: "remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
				},
			],
		});
		const remoteReceipt = chainStopReceipt({
			chain: [
				{
					schema: "hmux-managed-create-reconcile-v1",
					schemaVersion: 1,
					idempotencyKey: "create-remote",
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
				},
			],
		});
		mocks.remoteManagedCreateChainStop
			.mockRejectedValueOnce(new Error("remote stop outcome is ambiguous"))
			.mockResolvedValueOnce(remoteReceipt);

		await expect(stopManagedAgentProvider(remote)).rejects.toThrow(
			"remote stop outcome is ambiguous",
		);
		await expect(stopManagedAgentProvider(remote)).resolves.toMatchObject({
			receipt: remoteReceipt,
		});

		expect(mocks.remoteManagedCreateChainStop).toHaveBeenCalledTimes(2);
		expect(mocks.remoteManagedCreateChainStop.mock.calls[1][0]).toEqual(
			mocks.remoteManagedCreateChainStop.mock.calls[0][0],
		);
		expect(mocks.remoteManagedCreateChainStop.mock.calls[1][0]).toMatchObject({
			idempotencyKey: "create-remote",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
		});
	});

	it("replays a prepared local stop against its frozen generation", async () => {
		const operation = await prepareManagedAgentStopOperation(
			resolveManagedAgentStopTarget("agent-managed"),
		);
		mocks.stopManaged
			.mockRejectedValueOnce(new Error("stop response lost"))
			.mockImplementationOnce(async (stopId: string) =>
				stopReceipt({ stopId, outcome: "already_exited" }),
			);

		await expect(stopPreparedManagedAgentProvider(operation)).rejects.toThrow(
			"stop response lost",
		);
		useStore.setState({
			agents: [
				managedAgent({
					runtimeBinding: managedBindingFixture({
						stopFence: replacementFence,
					}),
				}),
			],
		});
		await expect(
			stopPreparedManagedAgentProvider(operation),
		).resolves.toMatchObject({ outcome: "already_exited" });

		expect(mocks.probeSessions).toHaveBeenCalledOnce();
		expect(mocks.stopManaged).toHaveBeenCalledTimes(2);
		expect(mocks.stopManaged.mock.calls[1]).toEqual(
			mocks.stopManaged.mock.calls[0],
		);
	});

	it("fails closed on ambiguous names and mismatched receipts", async () => {
		useStore.setState((state) => ({
			agents: [
				...state.agents,
				managedAgent({
					id: "agent-other",
					projectId: "project-2",
					sessionId: "session-other",
					runtimeBinding: managedBindingFixture({
						sessionId: "session-other",
						workspaceId: "workspace-other",
						createIdempotencyKey: undefined,
					}),
				}),
			],
			projects: [
				...state.projects,
				{
					id: "project-2",
					name: "Other",
					path: "/other",
					kind: "local" as const,
					isRepo: true,
				},
			],
		}));

		expect(() => resolveManagedAgentStopTarget("codex-1")).toThrowError(
			expect.objectContaining({ code: "pane_ambiguous" }),
		);
		const target = resolveManagedAgentStopTarget("HebbianIDE/codex-1");
		mocks.stopManaged.mockImplementation(async (stopId: string) =>
			stopReceipt({
				stopId,
				sessionId: "session-other",
				hostInstanceId: "replacement-host",
			}),
		);
		await expect(stopManagedAgentProvider(target)).rejects.toMatchObject({
			code: "pane_changed",
		});
	});

	it("treats a host-catalog absence as a definitive no-op stop", async () => {
		// 생성 전에 죽은 스폰의 등록 잔해: stopFence도 conversationIdentity도 없다.
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				started: false,
				conversationId: undefined,
				runtimeBinding: managedBindingFixture({
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					createIdempotencyKey: undefined,
				}),
			})),
		}));
		mocks.probeSessions.mockResolvedValue([]);

		const target = resolveManagedAgentStopTarget("HebbianIDE/codex-1");
		await expect(stopManagedAgentProvider(target)).rejects.toMatchObject({
			name: "ManagedSessionAbsentError",
			sessionId: "session-managed",
		});
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("treats another workspace's equal id as exact-target absence", async () => {
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				started: false,
				conversationId: undefined,
				runtimeBinding: managedBindingFixture({
					sessionId: "session-managed",
					workspaceId: "workspace-managed",
					createIdempotencyKey: undefined,
				}),
			})),
		}));
		mocks.probeSessions.mockResolvedValue([
			{
				sessionId: "session-managed",
				workspaceId: "workspace-other",
				sessionClass: "managed",
				terminalEpoch: "terminal-epoch-9",
			},
		]);

		const target = resolveManagedAgentStopTarget("HebbianIDE/codex-1");
		await expect(stopManagedAgentProvider(target)).rejects.toMatchObject({
			name: "ManagedSessionAbsentError",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
		});
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("removes registry and panes idempotently across WebViews after stop", async () => {
		const target = resolveManagedAgentStopTarget("agent-managed");
		const receipt = stopReceipt({ stopId: "stop-exact" });

		await finalizeManagedAgentRemoval(target, receipt);

		expect(useStore.getState().agents).toEqual([]);
		expect(useStore.getState().sessionCwd).not.toHaveProperty(
			"session-managed",
		);
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
		expect(mocks.removePanels).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledWith(
			MANAGED_AGENT_STOPPED_EVENT,
			expect.objectContaining({
				registration: expect.objectContaining({ id: "agent-managed" }),
			}),
		);
		await expect(
			applyManagedAgentStoppedSync(stopCalls()[0]?.[1]),
		).resolves.toBe(true);
	});

	it("preserves a same-binding canonical successor before sync or broadcast", async () => {
		const source = managedAgent();
		const target = resolveManagedAgentStopTarget(source.id);
		const operation = await prepareManagedAgentStopOperation(target);
		const successor = {
			...source,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-successor",
			},
		};
		const receipt = stopReceipt({ stopId: "stop-predecessor" });
		useStore.setState({ agents: [successor] });

		expect(() => stopPreparedManagedAgentProvider(operation)).toThrowError(
			"canonical Agent agent-managed must use dispatch.stop",
		);
		await expect(
			applyManagedAgentStoppedSync({
				schemaVersion: 3,
				registration: agentRemovalRegistrationIdentity(source),
				receipt,
			}),
		).resolves.toBe(false);
		await expect(
			finalizeManagedAgentRemoval(target, receipt),
		).rejects.toMatchObject({
			code: "canonical_agent_legacy_writer_refused",
		});
		expect(stopCalls()).toHaveLength(0);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removePanels).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([successor]);
	});

	it("preserves a canonical successor from a delayed chain broadcast", async () => {
		const source = managedChainAgent();
		const successor = {
			...source,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-chain-successor",
			},
		};
		useStore.setState({ agents: [successor] });

		await expect(
			applyManagedAgentChainStoppedSync({
				schemaVersion: 4,
				registration: agentRemovalRegistrationIdentity(source),
				authority: { source: "local" },
				receipt: chainStopReceipt(),
			}),
		).resolves.toBe(false);
		expect(useStore.getState().agents).toEqual([successor]);
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
	});

	it("ignores a delayed stopped event after the same logical session is rebound", async () => {
		useStore.setState({
			agents: [
				managedAgent({
					runtimeBinding: managedBindingFixture({
						sessionId: "session-managed",
						workspaceId: "workspace-managed",
						createIdempotencyKey: "create-replacement",
						stopFence: stopFenceFixture({
							runnerPrincipal: "principal-2",
							runnerInstance: "runner-2",
							channelEpoch: "8",
							hostInstanceId: "host-instance-2",
							terminalEpoch: "terminal-epoch-2",
						}),
					}),
				}),
			],
		});

		await expect(
			applyManagedAgentStoppedSync({
				schemaVersion: 3,
				registration: agentRemovalRegistrationIdentity(managedAgent()),
				receipt: stopReceipt({ stopId: "stop-old-generation" }),
			}),
		).resolves.toBe(false);
		expect(useStore.getState().agents).toHaveLength(1);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("preserves a later rebound when a stale projection reports the stopped transition", async () => {
		const laterFence = {
			...replacementFence,
			runnerInstance: "runner-3",
			hostInstanceId: "host-instance-3",
			terminalEpoch: "terminal-epoch-3",
		};
		useStore.setState({
			agents: [
				managedAgent({
					runtimeBinding: {
						...managedAgent().runtimeBinding,
						createIdempotencyKey: "create-later",
						stopFence: laterFence,
					} as Agent["runtimeBinding"],
				}),
			],
		});
		const receipt = stopReceipt({
			stopId: "stop-current-generation",
			runnerInstance: replacementFence.runnerInstance,
			hostInstanceId: replacementFence.hostInstanceId,
			terminalEpoch: replacementFence.terminalEpoch,
		});

		await expect(
			applyManagedAgentStoppedSync({
				schemaVersion: 3,
				registration: agentRemovalRegistrationIdentity(managedAgent()),
				receipt,
			}),
		).resolves.toBe(false);
		expect(useStore.getState().agents).toHaveLength(1);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("reports a superseding generation without deleting it", async () => {
		const target = resolveManagedAgentStopTarget("agent-managed");
		useStore.setState({
			agents: [
				managedAgent({
					runtimeBinding: managedBindingFixture({
						createIdempotencyKey: "create-later",
						stopFence: replacementFence,
					}),
				}),
			],
		});

		await expect(
			finalizeManagedAgentRemoval(
				target,
				stopReceipt({ stopId: "stop-superseded" }),
			),
		).rejects.toMatchObject({ code: "pane_changed" });

		expect(useStore.getState().agents).toHaveLength(1);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("broadcasts predecessor cleanup without deleting a same-binding successor", async () => {
		const source = managedAgent();
		const target = resolveManagedAgentStopTarget(source.id);
		const successor = {
			...source,
			projectId: "project-successor",
			worktreePath: "/repo/successor",
		};
		useStore.setState((state) => ({
			projects: [
				...state.projects,
				{
					id: "project-successor",
					name: "Successor",
					path: "/repo/successor",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [successor],
		}));

		await expect(
			finalizeManagedAgentRemoval(
				target,
				stopReceipt({ stopId: "stop-predecessor" }),
			),
		).rejects.toMatchObject({ code: "pane_changed" });
		expect(useStore.getState().agents).toEqual([successor]);

		const payload = stopCalls()[0]?.[1];
		useStore.setState({ agents: [source] });
		await expect(applyManagedAgentStoppedSync(payload)).resolves.toBe(true);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("rejects a cross-WebView receipt for a different runtime identity", async () => {
		await expect(
			applyManagedAgentStoppedSync({
				schemaVersion: 3,
				registration: agentRemovalRegistrationIdentity(managedAgent()),
				receipt: stopReceipt({ sessionId: "session-other" }),
			}),
		).resolves.toBe(false);
		expect(useStore.getState().agents).toHaveLength(1);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("rejects redundant fence authority that could delete a successor", async () => {
		const successor = managedAgent({
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-managed",
				stopFence: replacementFence,
			}),
		});
		useStore.setState({ agents: [successor] });

		await expect(
			applyManagedAgentStoppedSync({
				schemaVersion: 3,
				registration: agentRemovalRegistrationIdentity(managedAgent()),
				stopFence,
				sourceStopFence: replacementFence,
				receipt: stopReceipt({ stopId: "stop-predecessor" }),
			}),
		).resolves.toBe(false);
		expect(useStore.getState().agents).toEqual([successor]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("keeps the stopped binding retryable when WebView synchronization fails", async () => {
		const target = resolveManagedAgentStopTarget("agent-managed");
		mocks.emit.mockRejectedValueOnce(new Error("event bridge unavailable"));

		await expect(
			finalizeManagedAgentRemoval(
				target,
				stopReceipt({ stopId: "stop-retryable" }),
			),
		).rejects.toThrow("event bridge unavailable");

		expect(useStore.getState().agents).toHaveLength(1);
		expect(mocks.removePanels).not.toHaveBeenCalled();
		expect(() => resolveManagedAgentStopTarget("agent-managed")).not.toThrow();
	});
});
