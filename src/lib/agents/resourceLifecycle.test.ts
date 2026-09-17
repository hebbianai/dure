import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DurableProjectionRemovalRequest,
} from "@/lib/agents/durableAgentRemoval";
import type { HmuxManagedStopReceipt } from "@/lib/ipc";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { GitCheckoutCommandError } from "@/lib/scm/worktrees/gitCheckoutInstance";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { Agent, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	captureGitCheckoutInstance: vi.fn(),
	locateGitCheckoutPaths: vi.fn(),
	createRuntimeClient: vi.fn(),
	durableRemove: vi.fn(),
  finalizeManaged: vi.fn(),
	managedReceiptApplies: vi.fn(),
	prepareManaged: vi.fn(),
	prepareManagedOperation: vi.fn(),
	inspectExact: vi.fn(),
	inspectCanonicalStop: vi.fn(),
  inspectRuntime: vi.fn(),
	removeGitCheckoutInstance: vi.fn(),
	prepareRemoteGitCheckoutHelper: vi.fn(),
	prepareTrustedSsh: vi.fn(),
  removePanels: vi.fn(),
  resolveManaged: vi.fn(),
	sshExecOnce: vi.fn(),
  stopManaged: vi.fn(),
	previewCanonicalStop: vi.fn(),
	applyCanonicalStop: vi.fn(),
	createCanonicalStopClient: vi.fn(),
  stopStructured: vi.fn(),
	terminateExact: vi.fn(),
  terminateStandalone: vi.fn(),
}));

vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: mocks.inspectExact,
}));

vi.mock("@/lib/agents/durableAgentRemoval", () => ({
	removeAgentProjectionDurably: mocks.durableRemove,
}));

vi.mock("@/lib/workspace/desktop/desktopLifecycle", () => ({
  desktopLayoutSnapshot: vi.fn(() => undefined),
}));

vi.mock(
	"@/lib/workspace/pane/paneCloseCoordinator",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/workspace/pane/paneCloseCoordinator")
		>()),
  removePanelsWithoutSessionTeardown: mocks.removePanels,
	}),
);

vi.mock("@/lib/workspace/layout/layoutLifecycle", () => ({
  panelsFromLayout: vi.fn(() => []),
}));

vi.mock("@/lib/sessions/managed/managedAgentStop", () => {
  class ManagedSessionAbsentError extends Error {
    constructor(
      readonly sessionId: string,
      readonly workspaceId: string,
    ) {
      super(`managed Hmux session ${sessionId} is absent`);
      this.name = "ManagedSessionAbsentError";
    }
  }
  return {
    ManagedSessionAbsentError,
    finalizeManagedAgentRemoval: mocks.finalizeManaged,
		managedAgentStopReceiptAppliesToAgent: mocks.managedReceiptApplies,
		prepareManagedAgentStopOperation: mocks.prepareManagedOperation,
		prepareManagedAgentStopTarget: mocks.prepareManaged,
    resolveManagedAgentStopTarget: mocks.resolveManaged,
    stopManagedAgentProvider: mocks.stopManaged,
		stopPreparedManagedAgentProvider: (operation: { target: unknown }) =>
			mocks.stopManaged(operation.target),
  };
});

vi.mock("@/lib/ipc/dureAgentRuntime", () => ({
  createDureAgentRuntimeClient: mocks.createRuntimeClient,
}));

vi.mock("@/lib/ipc/dureAgentStop", () => ({
	createDureAgentStopClient: mocks.createCanonicalStopClient,
}));

vi.mock("@/lib/ipc/hmux", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/ipc/hmux")>();
  return {
    ...original,
    hmux: {
      ...original.hmux,
			terminateExact: mocks.terminateExact,
      terminateStandalone: mocks.terminateStandalone,
    },
  };
});

vi.mock("@/lib/ipc/git", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/git")>()),
	captureGitCheckoutInstance: mocks.captureGitCheckoutInstance,
	locateGitCheckoutPaths: mocks.locateGitCheckoutPaths,
	prepareRemoteGitCheckoutHelper: mocks.prepareRemoteGitCheckoutHelper,
	removeGitCheckoutInstance: mocks.removeGitCheckoutInstance,
}));

vi.mock("@/lib/ipc/sessions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/sessions")>()),
	prepareTrustedSshTarget: mocks.prepareTrustedSsh,
	sshExecOnce: mocks.sshExecOnce,
}));

import {
	agentRemovalRegistrationIdentity,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import {
	finalizeStoppedAgentRemoval,
	prepareAgentRemovalPlans,
} from "@/lib/agents/agentRemovalRuntime";
import {
	type AgentRemovalProgress,
	AgentRemovalScopeChangedError,
	AgentRemovalWorktreeUnsupportedError,
	executeAgentRemoval,
	prepareAgentRemoval,
  removeAgentWithResources,
  removeProjectWithResources,
	removeSshHostWithResources,
} from "@/lib/agents/resourceLifecycle";
import { sshHostRemovalSessionCount } from "@/lib/agents/sshHostRemovalPlan";
import { ManagedSessionAbsentError } from "@/lib/sessions/managed/managedAgentStop";
import {
	type SshCommandSource,
	sshCommandExecution,
} from "@/lib/ssh/sshCommandExecution";
import { durableAppStorage, useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const runtimeRouteAuthority = testDureBackendRouteAuthority(
  "dure-local",
  "generation-1",
);

const checkoutInstance = {
	schemaVersion: 1 as const,
	canonicalPath: "/repo/managed",
	gitCommonDir: "/repo/.git",
	gitDir: "/repo/.git/worktrees/managed",
	instanceToken: "dwt1_0123456789abcdef0123456789abcdef",
};

function removeAgentRecordForTest(agentId: string): void {
	useStore.setState((state) => {
		const agentActivity = { ...state.agentActivity };
		delete agentActivity[agentId];
		return {
			agents: state.agents.filter((agent) => agent.id !== agentId),
			agentActivity,
		};
	});
}

function remoteLocationReceipt(
	canonicalPath: string,
	gitCommonDir: string,
	count = 1,
) {
	return {
		code: 0,
		stderr: "",
		stdout: `${JSON.stringify({
			schemaVersion: 1,
			value: Array.from({ length: count }, () => ({
				schemaVersion: 1,
				canonicalPath,
				gitCommonDir,
			})),
		})}\n`,
	};
}

function sshCommandSourceText(source: SshCommandSource): string {
	const execution = sshCommandExecution(source);
	return "stdin" in execution
		? `${execution.command}\n${execution.stdin}`
		: execution.command;
}

const remoteHelperPath = `/home/developer/.local/share/dure/remote-tools/dure-git-checkout-helper/${"a".repeat(64)}`;

function remoteInstanceReceipt(instance: readonly string[]) {
	return {
		code: 0,
		stderr: "",
		stdout: `${JSON.stringify({
			schemaVersion: 1,
			value: {
				schemaVersion: 1,
				canonicalPath: instance[0],
				gitCommonDir: instance[1],
				gitDir: instance[2],
				instanceToken: instance[3],
			},
		})}\n`,
	};
}

function remoteRemovalReceipt(instance: readonly string[]) {
	return {
		code: 0,
		stderr: "",
		stdout: `${JSON.stringify({
			schemaVersion: 1,
			value: {
				schemaVersion: 1,
				outcome: "removed",
				instance: {
					schemaVersion: 1,
					canonicalPath: instance[0],
					gitCommonDir: instance[1],
					gitDir: instance[2],
					instanceToken: instance[3],
				},
			},
		})}\n`,
	};
}

function managedAgent(): Agent {
  return agentFixture({
    id: "agent-managed",
    name: "codex-1",
    worktreePath: "/repo/managed",
    branch: "agent/codex-1",
    sessionId: "session-managed",
    runtimeBinding: managedBindingFixture({
      sessionId: "session-managed",
      workspaceId: "workspace-managed",
      createIdempotencyKey: undefined,
    }),
  });
}

function colocatedManagedAgent(id: string, sessionId: string): Agent {
	return {
		...managedAgent(),
		id,
		name: id,
		sessionId,
		runtimeBinding: managedBindingFixture({
			sessionId,
			workspaceId: `workspace-${id}`,
			createIdempotencyKey: undefined,
		}),
	};
}

function legacyAgent(): Agent {
  return {
    id: "agent-legacy",
    name: "shell-1",
    provider: "codex",
    projectId: "project-1",
    worktreePath: "/repo/legacy",
    branch: "agent/shell-1",
    sessionId: "session-legacy",
    sessionKind: "pty",
    runtimeBinding: {
      schemaVersion: 1,
      runtime: "legacy_session_v1",
      source: "local",
      hostId: "local",
      sessionId: "session-legacy",
    } as unknown as Agent["runtimeBinding"],
  };
}

function structuredAgent(): Agent {
  return {
    ...managedAgent(),
    runtimeBinding: undefined,
    interactionProfile: {
      schemaVersion: 1,
      kind: "structured_protocol",
      backendProfileId: "local",
      interactionSessionId: "interaction-structured",
    },
  };
}

function standaloneAgent(): Agent {
  return {
    ...managedAgent(),
    id: "agent-standalone",
    name: "codex-standalone",
    sessionId: "session-standalone",
    worktreePath: "/repo/standalone",
    runtimeBinding: {
      schemaVersion: 1,
      runtime: "hmux_standalone_v1",
      source: "local",
      hostId: "local",
      sessionId: "session-standalone",
      workspaceId: "workspace-standalone",
    },
  };
}

function receipt(): HmuxManagedStopReceipt {
  return {
    schema: "hmux-managed-stop-v1",
    schemaVersion: 2,
    stopId: "stop-1",
    sessionId: "session-managed",
    workspaceId: "workspace-managed",
    runnerPrincipal: "principal-1",
    runnerInstance: "runner-1",
    channelEpoch: 7,
    hostInstanceId: "host-1",
    terminalEpoch: "terminal-1",
    outcome: "stopped",
    exitReason: "provider terminated by Hmux Host",
  };
}

function canonicalStopReceipt(
	status: "planned" | "authorized" | "workspace_preserved",
) {
	return {
		schemaVersion: 1 as const,
		operationId: "stop-canonical",
		spawnOperationId: "spawn-canonical",
		agentId: "agent-managed",
		planToken: `sha256:${"a".repeat(64)}`,
		journalRevision:
			status === "planned" ? 1 : status === "authorized" ? 2 : 3,
		workspaceDisposition: "preserve" as const,
		status,
	};
}

function standaloneTerminationReceipt() {
	return {
		sessionId: "session-standalone",
		workspaceId: "workspace-standalone",
		terminalEpoch: "standalone-epoch-1",
		sessionClass: "standalone" as const,
		outcome: "terminated" as const,
	};
}

describe("resource lifecycle for managed Hmux agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
		vi.spyOn(durableAppStorage, "read").mockResolvedValue(true);
    const managed = managedAgent();
    mocks.resolveManaged.mockImplementation((agentId: string) => {
      const agent = useStore
        .getState()
        .agents.find((candidate) => candidate.id === agentId);
      return {
        agent,
        binding: agent?.runtimeBinding,
      };
    });
    mocks.stopManaged.mockResolvedValue(receipt());
		mocks.prepareManagedOperation.mockImplementation(
			async (target: { binding: { stopFence?: unknown } }) => ({
				target,
				stopFence: target.binding.stopFence,
				stopId: "stop-prepared",
				authorityKey: "prepared-authority",
			}),
		);
    mocks.stopStructured.mockResolvedValue(undefined);
    mocks.inspectRuntime.mockResolvedValue({
      state: "unmanaged",
      routeAuthority: runtimeRouteAuthority,
    });
    mocks.createRuntimeClient.mockReturnValue({
      inspect: mocks.inspectRuntime,
      remove: mocks.stopStructured,
    });
		mocks.inspectCanonicalStop.mockResolvedValue({
			receipt: null,
			routeAuthority: runtimeRouteAuthority,
		});
		mocks.previewCanonicalStop.mockResolvedValue(
			canonicalStopReceipt("planned"),
		);
		mocks.applyCanonicalStop.mockResolvedValue(
			canonicalStopReceipt("workspace_preserved"),
		);
		mocks.createCanonicalStopClient.mockReturnValue({
			status: mocks.inspectCanonicalStop,
			preview: mocks.previewCanonicalStop,
			apply: mocks.applyCanonicalStop,
		});
    mocks.terminateStandalone.mockResolvedValue(undefined);
		mocks.inspectExact.mockResolvedValue({
			sessionId: "session-standalone",
			workspaceId: "workspace-standalone",
			sessionClass: "standalone",
			lifecycle: "ready",
			terminalEpoch: "standalone-epoch-1",
			outputSeq: "0",
			capabilities: [],
		});
    mocks.terminateExact.mockResolvedValue(standaloneTerminationReceipt());
    mocks.finalizeManaged.mockImplementation(async (target) => {
			removeAgentRecordForTest(target.agent.id);
    });
		mocks.managedReceiptApplies.mockImplementation(
			(target: { agent: Agent }, _receipt: unknown, current: Agent) =>
				sameAgentRemovalTarget(
					current,
					agentRemovalRegistrationIdentity(target.agent),
				),
		);
		mocks.durableRemove.mockImplementation(
			async (request: DurableProjectionRemovalRequest) => {
				const state = useStore.getState();
				if (
					request.mode === "batch" &&
					!request.applies({
						agents: state.agents,
						projects: state.projects,
						sshHosts: state.sshHosts,
						panes: [],
					})
				) {
					return false;
				}
				if (request.mode === "batch") return true;
				const target = request.agents[0];
				const current = state.agents.find(
					(agent) => agent.id === target?.agentId,
				);
				if (
					current &&
					target &&
					!target.applies(current, state.projects, state.sshHosts)
				) {
					return false;
				}
				if (target) {
					mocks.removePanels(target.panelIds);
					state.forgetSessionRuntime(target.sessionIds ?? []);
					removeAgentRecordForTest(target.agentId);
				}
				return true;
			},
		);
		mocks.prepareManaged.mockImplementation(async (target, remoteTarget) => {
			if (target.binding.source === "local") return target;
			if (remoteTarget) return { ...target, remoteTarget };
			const host = useStore
				.getState()
				.sshHosts.find((candidate) => candidate.id === target.binding.hostId);
			if (!host) throw new Error("remote host unavailable");
			return {
				...target,
				remoteTarget: {
					schemaVersion: 1,
					hostId: host.id,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: host.auth,
					...(host.secretId ? { secretId: host.secretId } : {}),
					...(host.keyPath ? { keyPath: host.keyPath } : {}),
					hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
				},
			};
		});
		mocks.captureGitCheckoutInstance.mockResolvedValue(checkoutInstance);
		mocks.locateGitCheckoutPaths.mockImplementation(async (paths: string[]) =>
			paths.map(() => ({
				schemaVersion: 1,
				canonicalPath: checkoutInstance.canonicalPath,
				gitCommonDir: checkoutInstance.gitCommonDir,
			})),
		);
		mocks.removeGitCheckoutInstance.mockResolvedValue({
			schemaVersion: 1,
			outcome: "removed",
			instance: checkoutInstance,
		});
		mocks.prepareRemoteGitCheckoutHelper.mockResolvedValue(remoteHelperPath);
		mocks.prepareTrustedSsh.mockImplementation(
			async (hosts: readonly SshHostConfig[], hostId: string) => {
				const host = hosts.find((candidate) => candidate.id === hostId);
				if (!host) throw new Error("remote host unavailable");
				return {
					schemaVersion: 1,
					hostId,
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
      agents: [managed],
			sshHosts: [],
      layouts: {},
      sessionCwd: {},
    });
  });

  it("waits for the exact managed stop receipt before registry cleanup", async () => {
    await removeAgentWithResources("agent-managed");

    expect(mocks.stopManaged).toHaveBeenCalledOnce();
    expect(mocks.finalizeManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "agent-managed" }),
        binding: expect.objectContaining({
          sessionId: "session-managed",
          workspaceId: "workspace-managed",
        }),
      }),
      receipt(),
    );
    expect(useStore.getState().agents).toEqual([]);
    expect(mocks.stopManaged.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finalizeManaged.mock.invocationCallOrder[0],
    );
  });

	it("converges a canonical Agent through dispatch stop without legacy writers", async () => {
		const canonical = {
			...managedAgent(),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		useStore.setState({ agents: [canonical] });

		await removeAgentWithResources(canonical.id);

		expect(mocks.createCanonicalStopClient).toHaveBeenCalledWith({
			profileId: "local",
		});
		expect(mocks.inspectCanonicalStop).toHaveBeenCalledWith(
			"spawn-canonical",
		);
		expect(mocks.previewCanonicalStop).toHaveBeenCalledOnce();
		expect(mocks.applyCanonicalStop).toHaveBeenCalledOnce();
		expect(mocks.inspectRuntime).not.toHaveBeenCalled();
		expect(mocks.stopStructured).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([]);
	});

	it.each([managedAgent, structuredAgent])(
		"removes a canonical Agent with missing spawn history through durable runtime removal (%#)",
		async (agent) => {
			const canonical = {
				...agent(),
				canonicalSpawn: {
					schemaVersion: 1 as const,
					backendProfileId: "local",
					operationId: "spawn-canonical",
				},
			};
			useStore.setState({ agents: [canonical] });
			mocks.previewCanonicalStop.mockRejectedValue(
				new DureBackendRequestError(
					"agent_dispatch_stop_not_found",
					"agent_dispatch_stop_not_found",
					{ kind: "contract" },
				),
			);

			await removeAgentWithResources(canonical.id);

			expect(mocks.stopStructured).toHaveBeenCalledWith(
				canonical.id,
				runtimeRouteAuthority,
			);
			expect(mocks.stopManaged).not.toHaveBeenCalled();
			expect(mocks.applyCanonicalStop).not.toHaveBeenCalled();
			expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
			expect(useStore.getState().agents).toEqual([]);
			expect(mocks.stopStructured.mock.invocationCallOrder[0]).toBeLessThan(
				mocks.durableRemove.mock.invocationCallOrder[0],
			);
		},
	);

	describe("missing canonical preview recovery", () => {
		let canonical: Agent;
		const missing = () =>
			new DureBackendRequestError(
				"agent_dispatch_stop_not_found",
				"agent_dispatch_stop_not_found",
				{ kind: "contract" },
			);
		beforeEach(() => {
			canonical = {
				...managedAgent(),
				canonicalSpawn: {
					schemaVersion: 1,
					backendProfileId: "local",
					operationId: "spawn-canonical",
				},
			};
			useStore.setState({ agents: [canonical] });
			mocks.previewCanonicalStop.mockRejectedValue(missing());
		});

		it.each([
			"agent_runtime_stop_not_found",
			"agent_runtime_stop_conflict",
			"agent_runtime_stop_source_retained",
			"agent_runtime_remove_failed",
		])(
			"retains the projection when backend removal refuses with %s",
			async (code) => {
				mocks.stopStructured.mockRejectedValueOnce(new Error(code));
				await expect(removeAgentWithResources(canonical.id)).rejects.toThrow(
					code,
				);
				expect(useStore.getState().agents).toEqual([canonical]);
				expect(mocks.durableRemove).not.toHaveBeenCalled();
				expect(mocks.stopManaged).not.toHaveBeenCalled();
			},
		);

		it("retries the same prepared removal after losing the backend response", async () => {
			mocks.stopStructured.mockRejectedValueOnce(new Error("response lost"));
			const operation = await prepareAgentRemoval(canonical.id, {
				deleteWorktree: false,
			});
			await expect(executeAgentRemoval(operation)).rejects.toThrow(
				"response lost",
			);
			expect(useStore.getState().agents).toEqual([canonical]);
			const resumedRoute = {
				...runtimeRouteAuthority,
				revision: `sha256:${"b".repeat(64)}`,
				backend: { id: "dure-local", generation: "generation-2" },
			};
			mocks.inspectCanonicalStop.mockResolvedValueOnce({
				receipt: null,
				routeAuthority: resumedRoute,
			});
			await executeAgentRemoval(operation);
			expect(mocks.stopStructured).toHaveBeenCalledTimes(2);
			expect(mocks.stopStructured).toHaveBeenNthCalledWith(
				1,
				canonical.id,
				runtimeRouteAuthority,
			);
			expect(mocks.stopStructured).toHaveBeenNthCalledWith(
				2,
				canonical.id,
				resumedRoute,
			);
			expect(useStore.getState().agents).toEqual([]);
		});

		it("refuses recovery if the target changes while preview fails", async () => {
			const successor = { ...canonical, sessionId: "session-successor" };
			mocks.previewCanonicalStop.mockImplementationOnce(async () => {
				useStore.setState({ agents: [successor] });
				throw missing();
			});
			await expect(removeAgentWithResources(canonical.id)).rejects.toThrow();
			expect(mocks.stopStructured).not.toHaveBeenCalled();
			expect(useStore.getState().agents).toEqual([successor]);
		});

		it("preserves a replacement projection published during backend removal", async () => {
			const successor = { ...canonical, sessionId: "session-successor" };
			mocks.stopStructured.mockImplementationOnce(async () => {
				useStore.setState({ agents: [successor] });
			});
			await removeAgentWithResources(canonical.id);
			expect(useStore.getState().agents).toEqual([successor]);
		});

		it.each(["status", "apply", "existing-preview", "transport", "untyped"])(
			"does not bypass a %s failure",
			async (phase) => {
				if (phase === "status")
					mocks.inspectCanonicalStop.mockRejectedValueOnce(missing());
				if (phase === "apply") {
					mocks.previewCanonicalStop.mockResolvedValueOnce(
						canonicalStopReceipt("planned"),
					);
					mocks.applyCanonicalStop.mockRejectedValueOnce(missing());
				}
				if (phase === "existing-preview")
					mocks.inspectCanonicalStop.mockResolvedValueOnce({
						receipt: {
							...canonicalStopReceipt("workspace_preserved"),
							status: "source_retained",
						},
						routeAuthority: runtimeRouteAuthority,
					});
				if (phase === "transport")
					mocks.previewCanonicalStop.mockRejectedValueOnce(
						new DureBackendRequestError(
							"agent_dispatch_stop_transport_failed",
							"unavailable",
							{ kind: "contract" },
						),
					);
				if (phase === "untyped")
					mocks.previewCanonicalStop.mockRejectedValueOnce(
						new Error("agent_dispatch_stop_not_found"),
					);
				await expect(removeAgentWithResources(canonical.id)).rejects.toThrow();
				expect(mocks.stopStructured).not.toHaveBeenCalled();
				expect(mocks.durableRemove).not.toHaveBeenCalled();
				expect(useStore.getState().agents).toEqual([canonical]);
			},
		);
	});

	it("recovers canonical stop response loss from status after a reload", async () => {
		const canonical = {
			...managedAgent(),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		useStore.setState({ agents: [canonical] });
		mocks.inspectCanonicalStop
			.mockResolvedValueOnce({
				receipt: null,
				routeAuthority: runtimeRouteAuthority,
			})
			.mockResolvedValueOnce({
				receipt: canonicalStopReceipt("workspace_preserved"),
				routeAuthority: {
					...runtimeRouteAuthority,
					revision: `sha256:${"b".repeat(64)}`,
					backend: { id: "dure-local", generation: "generation-2" },
				},
			});
		mocks.applyCanonicalStop.mockRejectedValueOnce(
			new Error("canonical stop response lost"),
		);

		const operation = await prepareAgentRemoval(canonical.id, {
			deleteWorktree: false,
		});
		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"canonical stop response lost",
		);
		expect(useStore.getState().agents).toEqual([canonical]);

		await executeAgentRemoval(operation);

		expect(mocks.inspectCanonicalStop).toHaveBeenCalledTimes(2);
		expect(mocks.previewCanonicalStop).toHaveBeenCalledOnce();
		expect(mocks.applyCanonicalStop).toHaveBeenCalledOnce();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([]);
	});

	it("refuses a canonical stop retry when durable status retargets its route", async () => {
		const canonical = {
			...managedAgent(),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		const retargetedRoute = {
			...runtimeRouteAuthority,
			revision: `sha256:${"b".repeat(64)}`,
			backend: { id: "dure-remote", generation: "generation-2" },
			target: {
				source: "ssh" as const,
				hostId: "replacement-host",
				remote: {
					host: "replacement.example.test",
					port: 22,
					user: "dure",
				},
			},
		};
		useStore.setState({ agents: [canonical] });
		mocks.inspectCanonicalStop
			.mockResolvedValueOnce({
				receipt: null,
				routeAuthority: runtimeRouteAuthority,
			})
			.mockResolvedValueOnce({
				receipt: canonicalStopReceipt("authorized"),
				routeAuthority: retargetedRoute,
			});
		mocks.applyCanonicalStop.mockRejectedValueOnce(
			new Error("canonical stop response lost"),
		);

		const operation = await prepareAgentRemoval(canonical.id, {
			deleteWorktree: false,
		});
		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"canonical stop response lost",
		);

		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			name: "CanonicalAgentStopRouteTargetChangedError",
			code: "agent_dispatch_stop_route_target_changed",
		});

		expect(mocks.applyCanonicalStop).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([canonical]);
	});

	it("refuses raw worktree removal when expanded scope contains a canonical Agent", async () => {
		const legacy = legacyAgent();
		const canonical = {
			...managedAgent(),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		useStore.setState({ agents: [legacy, canonical] });

		const error = await prepareAgentRemoval(legacy.id, {
			deleteWorktree: true,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(AgentRemovalWorktreeUnsupportedError);
		expect(error).toMatchObject({
			preview: { agents: [canonical, legacy] },
		});

		expect(mocks.inspectCanonicalStop).not.toHaveBeenCalled();
		expect(mocks.previewCanonicalStop).not.toHaveBeenCalled();
		expect(mocks.applyCanonicalStop).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([legacy, canonical]);
	});

	it("preserves a same-ID canonical successor after the source stop", async () => {
		const source = {
			...managedAgent(),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		const successor = {
			...source,
			canonicalSpawn: {
				...source.canonicalSpawn,
				operationId: "spawn-successor",
			},
		};
		useStore.setState({ agents: [source] });
		mocks.applyCanonicalStop.mockImplementationOnce(async () => {
			useStore.setState({ agents: [successor] });
			return canonicalStopReceipt("workspace_preserved");
		});

		await removeAgentWithResources(source.id);

		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removePanels).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([successor]);
	});

	it("refuses canonical worktree deletion before Git or stop preparation", async () => {
		const canonical = {
			...managedAgent(),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		useStore.setState({ agents: [canonical] });

		await expect(
			prepareAgentRemoval(canonical.id, { deleteWorktree: true }),
		).rejects.toThrow();

		expect(mocks.inspectCanonicalStop).not.toHaveBeenCalled();
		expect(mocks.captureGitCheckoutInstance).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
	});

  it("stops an exact structured runtime before removing its Agent projection", async () => {
    const structured = structuredAgent();
    useStore.setState({ agents: [structured] });
    mocks.inspectRuntime.mockResolvedValue({
      state: "stable",
      routeAuthority: runtimeRouteAuthority,
    });

    await removeAgentWithResources(structured.id);

    expect(mocks.createRuntimeClient).toHaveBeenCalledWith({
      profileId: "local",
    });
    expect(mocks.inspectRuntime).toHaveBeenCalledWith(structured.id);
    expect(mocks.stopStructured).toHaveBeenCalledWith(
      structured.id,
      runtimeRouteAuthority,
    );
    expect(mocks.stopStructured.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removePanels.mock.invocationCallOrder[0],
    );
    expect(useStore.getState().agents).toEqual([]);
  });

  it("lets the backend close Chat when the local projection still looks native", async () => {
    const staleNative = {
      ...managedAgent(),
      executionProfile: { kind: "provider_default" as const },
    };
    useStore.setState({ agents: [staleNative] });
    mocks.inspectRuntime.mockResolvedValue({
      state: "stable",
      routeAuthority: runtimeRouteAuthority,
    });

    await removeAgentWithResources(staleNative.id);

    expect(mocks.createRuntimeClient).toHaveBeenCalledWith({
      profileId: "local",
    });
    expect(mocks.stopStructured).toHaveBeenCalledWith(
      staleNative.id,
      runtimeRouteAuthority,
    );
    expect(mocks.stopManaged).not.toHaveBeenCalled();
    expect(useStore.getState().agents).toEqual([]);
  });

  it("keeps a pre-feature native Agent on the exact Hmux stop path", async () => {
    const legacyNative = {
      ...managedAgent(),
      executionProfile: { kind: "provider_default" as const },
    };
    useStore.setState({ agents: [legacyNative] });

    await removeAgentWithResources(legacyNative.id);

    expect(mocks.inspectRuntime).toHaveBeenCalledWith(legacyNative.id);
    expect(mocks.stopStructured).not.toHaveBeenCalled();
    expect(mocks.stopManaged).toHaveBeenCalledOnce();
    expect(useStore.getState().agents).toEqual([]);
  });

  it("preserves a structured Agent when its exact runtime cannot stop", async () => {
    const structured = structuredAgent();
    useStore.setState({ agents: [structured] });
    mocks.inspectRuntime.mockResolvedValue({
      state: "stable",
      routeAuthority: runtimeRouteAuthority,
    });
    mocks.stopStructured.mockRejectedValue(
      new Error("structured stop refused"),
    );

    await expect(removeAgentWithResources(structured.id)).rejects.toThrow(
      "structured stop refused",
    );

    expect(mocks.removePanels).not.toHaveBeenCalled();
    expect(useStore.getState().agents).toEqual([structured]);
  });

	it("preserves a replacement registered while registry finalization yields", async () => {
		const source = legacyAgent();
		const replacement: Agent = {
			...source,
			sessionId: "session-replacement",
			runtimeBinding: {
				...source.runtimeBinding,
				sessionId: "session-replacement",
			} as Agent["runtimeBinding"],
		};
		useStore.setState({ agents: [source] });
		const [plan] = await prepareAgentRemovalPlans([source]);
		if (!plan) throw new Error("agent_removal_plan_missing");
		queueMicrotask(() => useStore.setState({ agents: [replacement] }));

		await finalizeStoppedAgentRemoval({
			kind: "registry",
			plan,
			finalizationIdentity: agentRemovalRegistrationIdentity(source),
		});

		expect(useStore.getState().agents).toEqual([replacement]);
		expect(mocks.removePanels).toHaveBeenCalledOnce();
		expect(mocks.removePanels).toHaveBeenCalledWith(["agent:agent-legacy"]);
	});

	it("preserves a newer projection installed while a backend stop is in flight", async () => {
		const source = {
			...managedAgent(),
			interactionProfile: {
				schemaVersion: 1 as const,
				kind: "structured_protocol" as const,
				backendProfileId: "local",
				interactionSessionId: "interaction-structured",
			},
		};
		const replacement: Agent = {
			...source,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-later" }),
			}),
		};
		useStore.setState({ agents: [source] });
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: runtimeRouteAuthority,
		});
		mocks.stopStructured.mockImplementationOnce(async () => {
			useStore.setState({ agents: [replacement] });
		});

		await removeAgentWithResources(source.id);

		expect(mocks.stopStructured).toHaveBeenCalledOnce();
		expect(mocks.removePanels).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([replacement]);
	});

	it("replays an ambiguous backend stop without adopting a newer projection", async () => {
		const source = {
			...managedAgent(),
			interactionProfile: {
				schemaVersion: 1 as const,
				kind: "structured_protocol" as const,
				backendProfileId: "local",
				interactionSessionId: "interaction-structured",
			},
		};
		const replacement: Agent = {
			...source,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-later" }),
			}),
		};
		useStore.setState({ agents: [source] });
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: runtimeRouteAuthority,
		});
		mocks.stopStructured
			.mockImplementationOnce(async () => {
				useStore.setState({ agents: [replacement] });
				throw new Error("backend stop response lost");
			})
			.mockResolvedValueOnce(undefined);
		const operation = await prepareAgentRemoval(source.id, {
			deleteWorktree: false,
		});

		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"backend stop response lost",
		);
		await executeAgentRemoval(operation);

		expect(mocks.stopStructured).toHaveBeenCalledTimes(2);
		expect(mocks.removePanels).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([replacement]);
	});

	it("preserves a same-binding successor installed during a managed stop", async () => {
		const source = managedAgent();
		const replacement: Agent = {
			...source,
			projectId: "project-2",
			worktreePath: "/successor/managed",
		};
		useStore.setState({ agents: [source] });
		mocks.stopManaged.mockImplementationOnce(async () => {
			useStore.setState({ agents: [replacement] });
			return receipt();
		});
		mocks.finalizeManaged.mockRejectedValueOnce(
			new PaneCommandError("pane_changed", "superseded"),
		);

		await removeAgentWithResources(source.id);

		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
		expect(mocks.removePanels).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([replacement]);
	});

	it("replays an ambiguous managed dispatch before evaluating its successor", async () => {
		const source = managedAgent();
		const successor: Agent = {
			...source,
			projectId: "project-2",
			worktreePath: "/successor/managed",
		};
		useStore.setState({ agents: [source] });
		mocks.stopManaged
			.mockImplementationOnce(async () => {
				useStore.setState({ agents: [successor] });
				throw new Error("managed stop response lost");
			})
			.mockResolvedValueOnce(receipt());
		mocks.finalizeManaged.mockRejectedValueOnce(
			new PaneCommandError("pane_changed", "superseded"),
		);
		const operation = await prepareAgentRemoval(source.id, {
			deleteWorktree: true,
		});

		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"managed stop response lost",
		);
		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			retry: "same_operation",
		});

		expect(mocks.stopManaged).toHaveBeenCalledTimes(2);
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([successor]);
	});

	it("does not dispatch when managed fence preparation observes a newer projection", async () => {
		const source = managedAgent();
		const successorFence = stopFenceFixture({
			terminalEpoch: "terminal-successor",
		});
		const successor: Agent = {
			...source,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: successorFence,
			}),
		};
		useStore.setState({ agents: [source] });
		mocks.prepareManagedOperation.mockImplementationOnce(async (target) => {
			useStore.setState({ agents: [successor] });
			return {
				target,
				stopFence: successorFence,
				stopId: "stop-successor",
				authorityKey: "successor-authority",
			};
		});

		await expect(removeAgentWithResources(source.id)).rejects.toThrow(
			"워크트리를 사용하는 에이전트가 변경되어",
		);

		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([successor]);
	});

  it("does not stop a replacement registration discovered during preparation", async () => {
    const source = managedAgent();
    const replacement: Agent = {
      ...source,
      sessionId: "session-replacement",
      runtimeBinding: managedBindingFixture({
        sessionId: "session-replacement",
        workspaceId: "workspace-replacement",
        createIdempotencyKey: undefined,
      }),
    };
    useStore.setState({ agents: [source] });
    mocks.inspectRuntime.mockImplementationOnce(async () => {
      useStore.setState({ agents: [replacement] });
      return {
        state: "unmanaged",
        routeAuthority: runtimeRouteAuthority,
      };
    });

    await expect(removeAgentWithResources(source.id)).rejects.toThrow(
      "워크트리를 사용하는 에이전트가 변경되어",
    );

    expect(mocks.stopManaged).not.toHaveBeenCalled();
    expect(useStore.getState().agents).toEqual([replacement]);
  });

	it("rejects a replacement that superseded the caller's Agent snapshot", async () => {
		const source = managedAgent();
		const replacement: Agent = {
			...source,
			sessionId: "session-replacement",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-replacement",
				workspaceId: "workspace-replacement",
			}),
		};
		useStore.setState({ agents: [replacement] });

		await expect(
			prepareAgentRemoval(source.id, {
				deleteWorktree: false,
				expectedIdentity: agentRemovalRegistrationIdentity(source),
			}),
		).rejects.toThrow("워크트리를 사용하는 에이전트가 변경되어");

		expect(mocks.inspectRuntime).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([replacement]);
	});

  it("continues removal when the managed session never existed on its host", async () => {
    // A spawn that died before Host create has no provider to stop. Exact
    // catalog absence authorizes registration finalization.
    mocks.stopManaged.mockRejectedValue(
      new ManagedSessionAbsentError("session-managed", "workspace-managed"),
    );

    await removeAgentWithResources("agent-managed");

    expect(mocks.stopManaged).toHaveBeenCalledOnce();
    expect(mocks.finalizeManaged).not.toHaveBeenCalled();
    expect(mocks.removePanels).toHaveBeenCalledWith(["agent:agent-managed"]);
    expect(useStore.getState().agents).toEqual([]);
  });

	it("continues fenced worktree deletion after an already-absent stop", async () => {
		mocks.stopManaged.mockRejectedValue(
			new ManagedSessionAbsentError("session-managed", "workspace-managed"),
		);
		const operation = await prepareAgentRemoval("agent-managed", {
			deleteWorktree: true,
		});

		await executeAgentRemoval(operation);

		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledWith(
			"/repo",
			checkoutInstance,
			"discard_changes",
		);
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(mocks.removePanels).toHaveBeenCalledWith(["agent:agent-managed"]);
		expect(useStore.getState().agents).toEqual([]);
	});

  it("still fails removal on non-absent managed stop errors", async () => {
    mocks.stopManaged.mockRejectedValue(new Error("stop refused"));

    await expect(removeAgentWithResources("agent-managed")).rejects.toThrow(
      "stop refused",
    );
    expect(useStore.getState().agents).toHaveLength(1);
  });

  it("removes a remote registration when its exact managed session never existed", async () => {
    const remote: Agent = {
      ...managedAgent(),
      sessionKind: "ssh",
      started: false,
      runtimeBinding: {
        schemaVersion: 1,
        runtime: "hmux_managed_v1",
        source: "ssh",
        hostId: "host-1",
        sessionId: "session-managed",
        workspaceId: "workspace-managed",
        createIdempotencyKey: "create-1",
        commandBridgeNonce: "bridge-1",
      },
    };
    useStore.setState({
      agents: [remote],
      projects: [
        {
          id: "project-1",
          name: "Remote",
          path: "/repo",
          kind: "ssh",
          sshHostId: "host-1",
          isRepo: true,
        },
      ],
			sshHosts: [
				{
					id: "host-1",
					name: "remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
				},
			],
    });
    mocks.stopManaged.mockRejectedValue(
      new ManagedSessionAbsentError("session-managed", "workspace-managed"),
    );

    await removeAgentWithResources(remote.id);

    expect(mocks.stopManaged).toHaveBeenCalledOnce();
    expect(mocks.finalizeManaged).not.toHaveBeenCalled();
    expect(useStore.getState().agents).toEqual([]);
  });

  it("removes every agent sharing a worktree before deleting it once", async () => {
    const managed = managedAgent();
    const shared: Agent = {
      ...legacyAgent(),
      id: "agent-shared",
      name: "claude-review",
      provider: "claude",
      worktreePath: managed.worktreePath,
    };
    useStore.setState({ agents: [managed, shared] });
    const progress: AgentRemovalProgress[] = [];
		const operation = await prepareAgentRemoval(managed.id, {
      deleteWorktree: true,
		});

		await executeAgentRemoval(operation, {
      onProgress: (event) => progress.push(event),
    });

    expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.captureGitCheckoutInstance).toHaveBeenCalledWith(
      "/repo",
      managed.worktreePath,
    );
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledWith(
			"/repo",
			checkoutInstance,
			"discard_changes",
    );
		expect(
			mocks.captureGitCheckoutInstance.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.stopManaged.mock.invocationCallOrder[0] ?? 0);
		expect(mocks.stopManaged.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.removeGitCheckoutInstance.mock.invocationCallOrder[0] ?? 0,
    );
		expect(
			mocks.removeGitCheckoutInstance.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.finalizeManaged.mock.invocationCallOrder[0] ?? 0);
    expect(useStore.getState().agents).toEqual([]);
    expect(progress).toEqual([
      { kind: "agent", agentId: shared.id, status: "started" },
      { kind: "agent", agentId: managed.id, status: "started" },
      { kind: "worktree", path: managed.worktreePath, status: "started" },
      { kind: "worktree", path: managed.worktreePath, status: "completed" },
      { kind: "agent", agentId: shared.id, status: "completed" },
      { kind: "agent", agentId: managed.id, status: "completed" },
    ]);
  });

	it("preserves checkout retry authority after finalizing a stopped Agent", async () => {
		const managed = managedAgent();
		mocks.stopManaged.mockImplementationOnce(async () => {
			mocks.removeGitCheckoutInstance.mockRejectedValueOnce(
				new GitCheckoutCommandError(
					"worktree_identity_changed",
					"replacement checkout observed",
				),
			);
			return receipt();
		});
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});

		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			code: "worktree_identity_changed",
		});

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledWith(
			"/repo",
			checkoutInstance,
			"discard_changes",
		);
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([]);
	});

	it("shares one in-flight execution for the same prepared operation", async () => {
		const managed = managedAgent();
		let releaseStop: ((value: HmuxManagedStopReceipt) => void) | undefined;
		mocks.stopManaged.mockImplementationOnce(
			() =>
				new Promise<HmuxManagedStopReceipt>((resolve) => {
					releaseStop = resolve;
				}),
		);
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});

		const first = executeAgentRemoval(operation);
		const second = executeAgentRemoval(operation);

		expect(first).toBe(second);
		await vi.waitFor(() => expect(mocks.stopManaged).toHaveBeenCalledOnce());
		releaseStop?.(receipt());
		await Promise.all([first, second]);

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
	});

	it("shares the prepared execution with a synchronous progress callback", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		let reentrant: ReturnType<typeof executeAgentRemoval> | undefined;
		const first = executeAgentRemoval(operation, {
			onProgress: () => {
				reentrant ??= executeAgentRemoval(operation);
			},
		});

		await first;

		expect(reentrant).toBe(first);
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
	});

	it("refuses a newcomer before stopping any prepared provider", async () => {
		const managed = managedAgent();
		const newcomer: Agent = {
			...legacyAgent(),
			id: "agent-newcomer",
			worktreePath: managed.worktreePath,
		};
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		useStore.setState({ agents: [managed, newcomer] });

		const error = await executeAgentRemoval(operation).catch(
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(AgentRemovalScopeChangedError);
		expect(error).toMatchObject({ retry: "reprepare" });
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([managed, newcomer]);
	});

	it("finalizes an earlier stop when a newcomer blocks the next provider", async () => {
		const first = colocatedManagedAgent("agent-first", "session-first");
		const target = managedAgent();
		const newcomer: Agent = {
			...legacyAgent(),
			id: "agent-newcomer-after-first-stop",
			worktreePath: target.worktreePath,
		};
		useStore.setState({ agents: [first, target] });
		mocks.stopManaged.mockImplementationOnce(async () => {
			useStore.setState({ agents: [first, target, newcomer] });
			return receipt();
		});
		const operation = await prepareAgentRemoval(target.id, {
			deleteWorktree: true,
		});

		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			retry: "same_operation",
		});

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledWith(
			expect.objectContaining({ agent: first }),
			receipt(),
		);
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([target, newcomer]);
	});

	it("finalizes an earlier stop when the next dispatch target changes", async () => {
		const first = colocatedManagedAgent("agent-first", "session-first");
		const target = managedAgent();
		const successor: Agent = {
			...target,
			sessionId: "session-successor",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-successor",
				workspaceId: "workspace-successor",
				createIdempotencyKey: undefined,
			}),
		};
		useStore.setState({ agents: [first, target] });
		let preparation = 0;
		mocks.prepareManagedOperation.mockImplementation(async (preparedTarget) => {
			preparation += 1;
			if (preparation === 2) {
				useStore.setState({ agents: [first, successor] });
			}
			return {
				target: preparedTarget,
				stopFence: stopFenceFixture(),
				stopId: `stop-${preparation}`,
				authorityKey: `authority-${preparation}`,
			};
		});
		const operation = await prepareAgentRemoval(target.id, {
			deleteWorktree: true,
		});

		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			retry: "same_operation",
		});

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledWith(
			expect.objectContaining({ agent: first }),
			receipt(),
		);
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([successor]);
	});

	it("includes a newcomer introduced while checkout authority is captured", async () => {
		const managed = managedAgent();
		const newcomer: Agent = {
			...legacyAgent(),
			id: "agent-newcomer",
			worktreePath: managed.worktreePath,
		};
		mocks.captureGitCheckoutInstance.mockImplementationOnce(async () => {
			useStore.setState({ agents: [managed, newcomer] });
			return checkoutInstance;
		});

		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});

		expect(operation.preview.agents.map((agent) => agent.id)).toEqual([
			newcomer.id,
			managed.id,
		]);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([managed, newcomer]);
	});

	it("rejects a catalog change during canonical scope inspection", async () => {
		const managed = managedAgent();
		const newcomer: Agent = {
			...legacyAgent(),
			id: "agent-newcomer",
			worktreePath: managed.worktreePath,
		};
		mocks.locateGitCheckoutPaths.mockImplementationOnce(
			async (paths: string[]) => {
				useStore.setState({ agents: [managed, newcomer] });
				return paths.map(() => ({
					schemaVersion: 1,
					canonicalPath: checkoutInstance.canonicalPath,
					gitCommonDir: checkoutInstance.gitCommonDir,
				}));
			},
		);

		await expect(
			prepareAgentRemoval(managed.id, { deleteWorktree: true }),
		).rejects.toMatchObject({ retry: "reprepare" });
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
	});

	it("accepts a benign clone of the prepared Agent registration", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		useStore.setState({
			agents: [{ ...managed, displayName: "Renamed while confirming" }],
		});

		await executeAgentRemoval(operation);

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([]);
	});

	it("accepts a refreshed local Host generation for the same Agent", async () => {
		const managed = {
			...managedAgent(),
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-old" }),
			}),
		};
		useStore.setState({ agents: [managed] });
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		useStore.setState({
			agents: [
				{
					...managed,
					runtimeBinding: {
						...managed.runtimeBinding,
						stopFence: stopFenceFixture({
							terminalEpoch: "terminal-current",
						}),
					},
				},
			],
		});

		await executeAgentRemoval(operation);

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([]);
	});

	it.each(["unavailable", "absent"] as const)("converges a lost deletion response with %s paths without recapture or restop", async (observation) => {
    const managed = managedAgent();
		let checkoutPresent = true;
		mocks.locateGitCheckoutPaths.mockImplementation(async (paths: string[]) =>
			paths.map((path) =>
				checkoutPresent
					? {
							schemaVersion: 1,
							canonicalPath: checkoutInstance.canonicalPath,
							gitCommonDir: checkoutInstance.gitCommonDir,
						}
					: observation === "absent" ? { schemaVersion: 1, absentPath: path } : undefined,
			),
		);
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		mocks.removeGitCheckoutInstance
			.mockImplementationOnce(async () => {
				checkoutPresent = false;
				throw new Error("transport response lost");
			})
			.mockResolvedValueOnce({
				schemaVersion: 1,
				outcome: "already_absent",
				instance: checkoutInstance,
			});

		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"transport response lost",
		);

    expect(mocks.stopManaged).toHaveBeenCalledOnce();
    expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
    expect(useStore.getState().agents).toEqual([]);
		const locationCallsAfterLostResponse =
			mocks.locateGitCheckoutPaths.mock.calls.length;

		await executeAgentRemoval(operation);

		expect(mocks.captureGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledTimes(2);
		expect(mocks.removeGitCheckoutInstance).toHaveBeenNthCalledWith(
			2,
			"/repo",
			checkoutInstance,
			"discard_changes",
		);
		expect(mocks.locateGitCheckoutPaths).toHaveBeenCalledTimes(
			locationCallsAfterLostResponse,
		);
    expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
    expect(useStore.getState().agents).toEqual([]);
  });

	it("replays a dispatched checkout deletion after absence and failed registration finalization", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, { deleteWorktree: true });
		mocks.removeGitCheckoutInstance
			.mockImplementationOnce(async () => {
				mocks.locateGitCheckoutPaths.mockImplementation(async (paths: string[]) =>
					paths.map((path) => ({ schemaVersion: 1, absentPath: path })),
				);
				throw new Error("deletion response lost");
			})
			.mockResolvedValueOnce({
				schemaVersion: 1,
				outcome: "already_absent",
				instance: checkoutInstance,
			});
		mocks.finalizeManaged.mockRejectedValueOnce(new Error("finalization unavailable"));

		await expect(executeAgentRemoval(operation)).rejects.toThrow("finalization unavailable");
		expect(useStore.getState().agents).toEqual([managed]);
		await executeAgentRemoval(operation);

		expect(mocks.captureGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledTimes(2);
		expect(mocks.removeGitCheckoutInstance).toHaveBeenLastCalledWith(
			"/repo", checkoutInstance, "discard_changes",
		);
		expect(mocks.finalizeManaged).toHaveBeenCalledTimes(2);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("rechecks newcomers after a refused worktree removal", async () => {
		const managed = managedAgent();
		const newcomer: Agent = {
			...legacyAgent(),
			id: "agent-newcomer-after-refusal",
			worktreePath: managed.worktreePath,
		};
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		mocks.removeGitCheckoutInstance.mockRejectedValueOnce(
			new GitCheckoutCommandError(
				"worktree_remove_failed",
				"dirty checkout was preserved",
			),
		);

		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			code: "worktree_remove_failed",
		});
		expect(useStore.getState().agents).toEqual([]);
		useStore.setState({ agents: [newcomer] });

		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			retry: "same_operation",
		});
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([newcomer]);
	});

	it("finalizes stopped Agents while optional worktree cleanup retries", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		mocks.removeGitCheckoutInstance
			.mockRejectedValueOnce(
				new GitCheckoutCommandError(
					"worktree_remove_failed",
					"dirty checkout was preserved",
				),
			)
			.mockResolvedValueOnce({
				schemaVersion: 1,
				outcome: "removed",
				instance: checkoutInstance,
			});

		await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
			code: "worktree_remove_failed",
		});

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([]);

		await expect(executeAgentRemoval(operation)).resolves.toMatchObject({
			agentIds: [managed.id],
		});
		expect(mocks.captureGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledTimes(2);
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
	});

	it("caches a removal receipt while finalization retries preserve a replacement Agent", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		mocks.finalizeManaged
			.mockRejectedValueOnce(new Error("event bridge failed"))
			.mockRejectedValueOnce(
				new PaneCommandError("pane_changed", "superseded"),
			);

		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"event bridge failed",
		);

		const replacement: Agent = {
			...managed,
			name: "replacement",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-later" }),
			}),
		};
		useStore.setState({ agents: [replacement] });

		await expect(executeAgentRemoval(operation)).resolves.toMatchObject({
			agentIds: [managed.id],
		});

		expect(mocks.captureGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledTimes(2);
		expect(useStore.getState().agents).toEqual([replacement]);
	});

	it("converges when managed finalization committed before its response was lost", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		mocks.finalizeManaged.mockImplementationOnce(async (target) => {
			removeAgentRecordForTest(target.agent.id);
			throw new Error("event response lost");
		});

		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"event response lost",
		);
		await executeAgentRemoval(operation);

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).toHaveBeenCalledTimes(2);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("does not swallow a finalization failure for the same cloned registration", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		mocks.finalizeManaged.mockImplementationOnce(async () => {
			useStore.setState({
				agents: [{ ...managed, displayName: "Still here" }],
			});
			throw new Error("event bridge failed");
		});

		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"event bridge failed",
		);

		expect(useStore.getState().agents).toHaveLength(1);
	});

	describe("removal scope across asynchronous observations", () => {
		const phases = ["prepare", "stop", "worktree"] as const;
		const refreshes = {
			agents: () =>
				useStore.setState((state) => ({
					agents: state.agents.map((agent) => ({
						...agent,
						displayName: "Updated title",
					})),
				})),
			projects: () =>
				useStore.setState((state) => ({
					projects: state.projects.map((project) => ({
						...project,
						name: "Updated project",
					})),
				})),
			sshHosts: () =>
				useStore.setState((state) => ({ sshHosts: [...state.sshHosts] })),
		};

		function duringNextLookup(update: () => void): void {
			const locate = mocks.locateGitCheckoutPaths.getMockImplementation();
			mocks.locateGitCheckoutPaths.mockImplementationOnce(
				async (paths: string[]) => {
					const result = await locate?.(paths);
					update();
					return result;
				},
			);
		}

		it.each(
			phases.flatMap((phase) =>
				Object.entries(refreshes).map(([field, refresh]) => ({
					phase,
					field,
					refresh,
				})),
			),
		)(
			"accepts a $field display refresh during $phase checkout lookup",
			async ({ phase, refresh }) => {
				if (phase === "prepare") duringNextLookup(refresh);
				const operation = await prepareAgentRemoval("agent-managed", {
					deleteWorktree: true,
				});
				if (phase === "stop") duringNextLookup(refresh);
				await executeAgentRemoval(operation, {
					onProgress: (progress) => {
						if (
							phase === "worktree" &&
							progress.kind === "worktree" &&
							progress.status === "started"
						) {
							duringNextLookup(refresh);
						}
					},
				});
				expect(mocks.stopManaged).toHaveBeenCalledOnce();
				expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
				expect(useStore.getState().agents).toEqual([]);
			},
		);

		it("accepts a display refresh while awaiting stop receipt ownership", async () => {
			const operation = await prepareAgentRemoval("agent-managed", {
				deleteWorktree: true,
			});
			const applies = mocks.managedReceiptApplies.getMockImplementation();
			mocks.managedReceiptApplies.mockImplementationOnce(
				async (...args: unknown[]) => {
					const result = await applies?.(...args);
					refreshes.agents();
					refreshes.projects();
					refreshes.sshHosts();
					return result;
				},
			);
			await executeAgentRemoval(operation);
			expect(mocks.stopManaged).toHaveBeenCalledOnce();
			expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		});

		it.each(phases)(
			"rejects a new checkout user during %s lookup",
			async (phase) => {
				const newcomer = { ...managedAgent(), id: "agent-newcomer" };
				const addNewcomer = () =>
					useStore.setState((state) => ({ agents: [...state.agents, newcomer] }));
				if (phase === "prepare") {
					duringNextLookup(addNewcomer);
					await expect(
						prepareAgentRemoval("agent-managed", { deleteWorktree: true }),
					).rejects.toBeInstanceOf(AgentRemovalScopeChangedError);
				} else {
					const operation = await prepareAgentRemoval("agent-managed", {
						deleteWorktree: true,
					});
					if (phase === "stop") duringNextLookup(addNewcomer);
					await expect(
						executeAgentRemoval(operation, {
							onProgress: (progress) => {
								if (
									phase === "worktree" &&
									progress.kind === "worktree" &&
									progress.status === "started"
								) {
									duringNextLookup(addNewcomer);
								}
							},
						}),
					).rejects.toBeInstanceOf(AgentRemovalScopeChangedError);
				}
				expect(mocks.stopManaged).toHaveBeenCalledTimes(
					phase === "worktree" ? 1 : 0,
				);
				expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
				expect(useStore.getState().agents).toContainEqual(newcomer);
			},
		);

		it("ignores an unrelated runtime and host update during checkout lookup", async () => {
			const other = {
				...managedAgent(),
				id: "other",
				worktreePath: "/repo/other",
			};
			useStore.setState((state) => ({ agents: [...state.agents, other] }));
			mocks.locateGitCheckoutPaths.mockImplementation(async (paths: string[]) =>
				paths.map((path) => ({
					schemaVersion: 1,
					canonicalPath: path,
					gitCommonDir: checkoutInstance.gitCommonDir,
				})),
			);
			const operation = await prepareAgentRemoval("agent-managed", {
				deleteWorktree: true,
			});
			const updatedOther = { ...other, sessionId: "other-successor" };
			duringNextLookup(() =>
				useStore.setState((state) => ({
					agents: [
						updatedOther,
						...state.agents.filter((agent) => agent.id !== other.id),
					],
					sshHosts: [
						{
							id: "unrelated-host",
							name: "Unrelated",
							host: "example.test",
							port: 22,
							user: "test",
							auth: "auto",
						},
					],
				})),
			);
			await executeAgentRemoval(operation);
			expect(mocks.stopManaged).toHaveBeenCalledOnce();
			expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
			expect(useStore.getState().agents).toEqual([updatedOther]);
		});

		it("rejects a project root change during checkout lookup", async () => {
			const operation = await prepareAgentRemoval("agent-managed", {
				deleteWorktree: true,
			});
			duringNextLookup(() =>
				useStore.setState((state) => ({
					projects: state.projects.map((project) => ({
						...project,
						path: "/replacement-repo",
					})),
				})),
			);
			await expect(executeAgentRemoval(operation)).rejects.toBeInstanceOf(
				AgentRemovalScopeChangedError,
			);
			expect(mocks.stopManaged).not.toHaveBeenCalled();
			expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		});

		it("rejects a successor generation published while awaiting stop receipt ownership", async () => {
			const operation = await prepareAgentRemoval("agent-managed", {
				deleteWorktree: true,
			});
			mocks.managedReceiptApplies.mockImplementationOnce(async () => {
				await Promise.resolve();
				useStore.setState({
					agents: [
						{
							...managedAgent(),
							runtimeBinding: managedBindingFixture({
								sessionId: "session-managed",
								workspaceId: "workspace-managed",
								createIdempotencyKey: undefined,
								stopFence: stopFenceFixture({
									terminalEpoch: "successor-terminal",
								}),
							}),
						},
					],
				});
				return true;
			});
			await expect(executeAgentRemoval(operation)).rejects.toMatchObject({
				retry: "same_operation",
			});
			expect(mocks.stopManaged).toHaveBeenCalledOnce();
			expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		});

		it.each(["prepare", "stop"])(
			"rejects a replaced runtime during %s lookup",
			async (phase) => {
				const replacement = {
					...managedAgent(),
					sessionId: "replacement-session",
				};
				const replace = () => useStore.setState({ agents: [replacement] });
				if (phase === "prepare") {
					duringNextLookup(replace);
					await expect(
						prepareAgentRemoval("agent-managed", { deleteWorktree: true }),
					).rejects.toBeInstanceOf(AgentRemovalScopeChangedError);
				} else {
					const operation = await prepareAgentRemoval("agent-managed", {
						deleteWorktree: true,
					});
					duringNextLookup(replace);
					await expect(executeAgentRemoval(operation)).rejects.toBeInstanceOf(
						AgentRemovalScopeChangedError,
					);
				}
				expect(mocks.stopManaged).not.toHaveBeenCalled();
				expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
				expect(useStore.getState().agents).toEqual([replacement]);
			},
		);
	});

	it("never stops a replacement registration under the prepared Agent id", async () => {
		const managed = managedAgent();
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		const replacement: Agent = {
			...managed,
			name: "replacement",
			sessionId: "replacement-session",
			runtimeBinding: managedBindingFixture({
				sessionId: "replacement-session",
				workspaceId: "replacement-workspace",
			}),
		};
		useStore.setState({ agents: [replacement] });

		const error = await executeAgentRemoval(operation).catch(
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(AgentRemovalScopeChangedError);
		expect(error).toMatchObject({ retry: "reprepare" });
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([replacement]);
	});

	it("reprepares a no-worktree operation after its registration is replaced", async () => {
		const source = {
			...managedAgent(),
			branch: "",
			worktreePath: "/repo",
		};
		useStore.setState({ agents: [source] });
		const operation = await prepareAgentRemoval(source.id, {
			deleteWorktree: false,
		});
		const replacement: Agent = {
			...source,
			sessionId: "replacement-session",
			runtimeBinding: managedBindingFixture({
				sessionId: "replacement-session",
				workspaceId: "replacement-workspace",
			}),
		};
		useStore.setState({ agents: [replacement] });

		const error = await executeAgentRemoval(operation).catch(
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(AgentRemovalScopeChangedError);
		expect(error).toMatchObject({ retry: "reprepare" });
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("uses the Host-canonical checkout instead of revalidating raw path spelling", async () => {
		const canonicalAlias = {
			...checkoutInstance,
			canonicalPath: "/repo/replacement",
		};
		mocks.captureGitCheckoutInstance.mockResolvedValueOnce(canonicalAlias);
		mocks.locateGitCheckoutPaths.mockImplementation(async (paths: string[]) =>
			paths.map(() => ({
				schemaVersion: 1,
				canonicalPath: canonicalAlias.canonicalPath,
				gitCommonDir: canonicalAlias.gitCommonDir,
			})),
		);
		mocks.removeGitCheckoutInstance.mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "removed",
			instance: canonicalAlias,
		});

		const operation = await prepareAgentRemoval("agent-managed", {
			deleteWorktree: true,
		});
		await executeAgentRemoval(operation);

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledWith(
			"/repo",
			canonicalAlias,
			"discard_changes",
		);
	});

	it("groups distinct Agent path aliases by their Host-canonical checkout", async () => {
		const managed = {
			...managedAgent(),
			worktreePath: "/repo/linked-alias",
		};
		const shared: Agent = {
			...legacyAgent(),
			id: "agent-shared-alias",
			worktreePath: "/repo/managed/nested",
		};
		useStore.setState({ agents: [managed, shared] });

		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		await executeAgentRemoval(operation);

		expect(operation.preview.agents.map((agent) => agent.id)).toEqual([
			shared.id,
			managed.id,
		]);
		expect(mocks.locateGitCheckoutPaths).toHaveBeenCalledWith([
			managed.worktreePath,
			shared.worktreePath,
		]);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("uses one pinned remote authority after the host registration changes", async () => {
		const host = {
			id: "host-1",
			name: "devbox",
			host: "devbox.example",
			port: 22,
			user: "developer",
			auth: "key" as const,
			keyPath: "/keys/devbox",
		};
		const remote: Agent = {
			...managedAgent(),
			id: "agent-remote-worktree",
			projectId: "project-remote",
			sessionKind: "ssh",
			worktreePath: "/srv/repo/.worktrees/agent",
			branch: "agent/remote",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: host.id,
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-remote",
				stopFence: stopFenceFixture(),
			},
		};
		useStore.setState({
			agents: [remote],
			projects: [
				{
					id: "project-remote",
					name: "Remote",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: host.id,
					isRepo: true,
				},
			],
			sshHosts: [host],
		});
		const remoteInstance = [
			remote.worktreePath,
			"/srv/repo/.git",
			"/srv/repo/.git/worktrees/agent",
			"dwt1_0123456789abcdef0123456789abcdef",
		] as const;
		mocks.sshExecOnce.mockImplementation(
			async (_ssh, command: SshCommandSource) => {
				const commandSource = sshCommandSourceText(command);
				if (commandSource.includes(" capture-v1")) {
					return remoteInstanceReceipt(remoteInstance);
				}
				if (commandSource.includes(" locations-v1")) {
					return remoteLocationReceipt(
						remote.worktreePath,
						remoteInstance[1],
					);
				}
				if (commandSource.includes(" remove-v1")) {
					return remoteRemovalReceipt(remoteInstance);
				}
				throw new Error("unexpected SSH command");
			},
		);

		const operation = await prepareAgentRemoval(remote.id, {
			deleteWorktree: true,
		});
		useStore.setState({
			sshHosts: [{ ...host, host: "replacement.example" }],
		});

		await executeAgentRemoval(operation);

		expect(mocks.sshExecOnce).toHaveBeenCalledTimes(6);
		expect(mocks.prepareRemoteGitCheckoutHelper).toHaveBeenCalledOnce();
		for (const [ssh] of mocks.sshExecOnce.mock.calls) {
			expect(ssh).toEqual(
				expect.objectContaining({
					host: host.host,
					port: host.port,
					user: host.user,
					keyPath: host.keyPath,
					hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
				}),
			);
		}
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteTarget: expect.objectContaining({ host: host.host }),
			}),
		);
		expect(
			mocks.sshExecOnce.mock.calls.some(([, command]) =>
				sshCommandSourceText(command).includes(" remove-v1"),
			),
		).toBe(true);
		expect(mocks.terminateStandalone).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([]);
	});

	it("rejects a managed runtime on a different Host than its checkout", async () => {
		const mismatched: Agent = {
			...managedAgent(),
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "host-remote",
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-remote",
				stopFence: stopFenceFixture(),
			},
		};
		useStore.setState({
			agents: [mismatched],
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

		await expect(
			prepareAgentRemoval(mismatched.id, { deleteWorktree: true }),
		).rejects.toBeInstanceOf(AgentRemovalScopeChangedError);

		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([mismatched]);
	});

	it("fails before runtime stop or checkout removal when remote standalone has no adapter", async () => {
		const host = {
			id: "host-1",
			name: "devbox",
			host: "devbox.example",
			port: 22,
			user: "developer",
			auth: "key" as const,
			keyPath: "/keys/devbox",
		};
		const remote: Agent = {
			...legacyAgent(),
			id: "agent-remote-standalone",
			projectId: "project-remote",
			sessionKind: "ssh",
			worktreePath: "/srv/repo/.worktrees/agent",
			branch: "agent/remote",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_standalone_v1",
				source: "ssh",
				hostId: host.id,
				sessionId: "remote-session",
				workspaceId: "remote-workspace",
				commandBridgeNonce: "bridge-1",
			} as unknown as Agent["runtimeBinding"],
		};
		useStore.setState({
			agents: [remote],
			projects: [
				{
					id: "project-remote",
					name: "Remote",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: host.id,
					isRepo: true,
				},
			],
			sshHosts: [host],
		});
		const remoteInstance = [
			remote.worktreePath,
			"/srv/repo/.git",
			"/srv/repo/.git/worktrees/agent",
			"dwt1_0123456789abcdef0123456789abcdef",
		] as const;
		mocks.sshExecOnce.mockImplementation(
			async (_ssh, command: SshCommandSource) => {
				const commandSource = sshCommandSourceText(command);
				if (commandSource.includes(" capture-v1")) {
					return remoteInstanceReceipt(remoteInstance);
				}
				if (commandSource.includes(" locations-v1")) {
					return remoteLocationReceipt(
						remote.worktreePath,
						remoteInstance[1],
					);
				}
				throw new Error("unexpected destructive SSH command");
			},
		);

		await expect(
			prepareAgentRemoval(remote.id, { deleteWorktree: true }),
		).rejects.toThrow();

		expect(mocks.sshExecOnce).toHaveBeenCalledTimes(2);
		expect(
			mocks.sshExecOnce.mock.calls.some(([, command]) =>
				sshCommandSourceText(command).includes(" remove-v1"),
			),
		).toBe(false);
		expect(mocks.terminateStandalone).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([remote]);
	});

	it("accepts equivalent Windows spellings across scope and capture", async () => {
		const managed = {
			...managedAgent(),
			worktreePath: "C:\\Repo\\managed",
		};
		const shared: Agent = {
			...legacyAgent(),
			id: "agent-shared",
			worktreePath: "c:/repo/managed/",
		};
		const windowsInstance = {
			...checkoutInstance,
			canonicalPath: "c:/repo/managed/",
			gitCommonDir: "C:\\Repo\\.git",
			gitDir: "C:\\Repo\\.git\\worktrees\\managed",
		};
		useStore.setState({
			agents: [managed, shared],
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "C:\\Repo",
					kind: "local",
					isRepo: true,
				},
			],
		});
		mocks.captureGitCheckoutInstance.mockResolvedValueOnce(windowsInstance);
		mocks.locateGitCheckoutPaths.mockImplementation(async (paths: string[]) =>
			paths.map(() => ({
				schemaVersion: 1,
				canonicalPath: windowsInstance.canonicalPath,
				gitCommonDir: windowsInstance.gitCommonDir,
			})),
		);
		mocks.removeGitCheckoutInstance.mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "removed",
			instance: windowsInstance,
		});

		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});
		await executeAgentRemoval(operation);

		expect(operation.preview.agents.map((agent) => agent.id)).toEqual([
			shared.id,
			managed.id,
		]);
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledWith(
			"C:\\Repo",
			windowsInstance,
			"discard_changes",
		);
		expect(useStore.getState().agents).toEqual([]);
	});

  it("keeps shared agents and the worktree when disk deletion is not selected", async () => {
    const managed = managedAgent();
    const shared: Agent = {
      ...legacyAgent(),
      id: "agent-shared",
      worktreePath: managed.worktreePath,
    };
    useStore.setState({ agents: [managed, shared] });

    await removeAgentWithResources(managed.id);

    expect(useStore.getState().agents).toEqual([shared]);
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
  });

  it("fails closed when a worktree retry no longer has its target registration", async () => {
    useStore.setState({ agents: [] });

    await expect(
			prepareAgentRemoval("agent-managed", { deleteWorktree: true }),
    ).rejects.toThrow("워크트리를 사용하는 에이전트가 변경되어");

    expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
  });

  it("fails closed before stopping sessions when shared worktree scope is unresolved", async () => {
    const managed = managedAgent();
    const unresolved: Agent = {
      ...legacyAgent(),
      id: "agent-unresolved",
      projectId: "missing-project",
			worktreePath: "/repo/missing-alias",
    };
    useStore.setState({ agents: [managed, unresolved] });
		mocks.locateGitCheckoutPaths.mockResolvedValueOnce([
			{
				schemaVersion: 1,
				canonicalPath: checkoutInstance.canonicalPath,
				gitCommonDir: checkoutInstance.gitCommonDir,
			},
			undefined,
		]);

    await expect(
			prepareAgentRemoval(managed.id, { deleteWorktree: true }),
		).rejects.toThrow("워크트리를 사용하는 에이전트가 변경되어");

    expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
    expect(useStore.getState().agents).toEqual([managed, unresolved]);
  });

	it("removes the selected agent when its dedicated checkout is already absent", async () => {
		const managed = managedAgent();
		useStore.setState({ agents: [managed] });
		mocks.locateGitCheckoutPaths.mockResolvedValue([
			{ schemaVersion: 1, absentPath: managed.worktreePath },
		]);
		mocks.captureGitCheckoutInstance.mockRejectedValue(new Error("checkout location: No such file"));
		const operation = await prepareAgentRemoval(managed.id, { deleteWorktree: true });
		await executeAgentRemoval(operation);
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([]);
	});

	it("does not let a proven absent unrelated checkout block removal", async () => {
		const managed = managedAgent();
		const absent = { ...legacyAgent(), id: "absent-other", worktreePath: "/repo/removed-other" };
		useStore.setState({ agents: [managed, absent] });
		mocks.locateGitCheckoutPaths.mockImplementation(async (paths: string[]) => paths.map(path =>
			path === absent.worktreePath ? { schemaVersion: 1, absentPath: path } : {
				schemaVersion: 1, canonicalPath: checkoutInstance.canonicalPath, gitCommonDir: checkoutInstance.gitCommonDir,
			},
		));
		const operation = await prepareAgentRemoval(managed.id, { deleteWorktree: true });
		await executeAgentRemoval(operation);
		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([absent]);
	});

  it("rechecks the shared scope and preserves the worktree when a new agent appears", async () => {
    const managed = managedAgent();
    const newcomer: Agent = {
      ...legacyAgent(),
      id: "agent-newcomer",
      worktreePath: managed.worktreePath,
    };
    mocks.stopManaged.mockImplementation(async () => {
      useStore.setState((state) => ({ agents: [...state.agents, newcomer] }));
      return receipt();
    });

		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});

		const error = await executeAgentRemoval(operation).catch(
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(AgentRemovalScopeChangedError);
		expect(error).toMatchObject({ retry: "same_operation" });
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
    expect(useStore.getState().agents).toEqual([newcomer]);
  });

	it("rechecks scope after a worktree progress observer runs", async () => {
		const managed = managedAgent();
		const newcomer: Agent = {
			...legacyAgent(),
			id: "agent-newcomer-from-progress",
			worktreePath: managed.worktreePath,
		};
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});

		await expect(
			executeAgentRemoval(operation, {
				onProgress: (progress) => {
					if (progress.kind === "worktree" && progress.status === "started") {
						useStore.setState({ agents: [managed, newcomer] });
					}
				},
			}),
		).rejects.toBeInstanceOf(AgentRemovalScopeChangedError);

		expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(mocks.finalizeManaged).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([newcomer]);
	});

	it("rechecks scope after an agent progress observer runs", async () => {
		const managed = managedAgent();
		const newcomer: Agent = {
			...legacyAgent(),
			id: "agent-newcomer-from-agent-progress",
			worktreePath: managed.worktreePath,
		};
		const operation = await prepareAgentRemoval(managed.id, {
			deleteWorktree: true,
		});

		await expect(
			executeAgentRemoval(operation, {
				onProgress: (progress) => {
					if (progress.kind === "agent" && progress.status === "started") {
						useStore.setState({ agents: [managed, newcomer] });
					}
				},
			}),
		).rejects.toBeInstanceOf(AgentRemovalScopeChangedError);

		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([managed, newcomer]);
	});

  it("stops managed providers while retired-legacy registrations need no teardown", async () => {
    useStore.setState((state) => ({
      agents: [...state.agents, legacyAgent()],
    }));

    await removeProjectWithResources("project-1");

    expect(mocks.stopManaged).toHaveBeenCalledOnce();
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(mocks.durableRemove).toHaveBeenCalledOnce();
		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				agents: [
					expect.objectContaining({ agentId: "agent-managed" }),
					expect.objectContaining({ agentId: "agent-legacy" }),
				],
				projects: [
					expect.objectContaining({ projectId: "project-1" }),
				],
			}),
		);
		expect(mocks.removePanels).not.toHaveBeenCalled();
  });

	it("does not partially delete a Project when a later Agent stop fails", async () => {
		const first = managedAgent();
		const second = colocatedManagedAgent("agent-second", "session-second");
		useStore.setState({ agents: [first, second] });
		mocks.stopManaged
			.mockResolvedValueOnce(receipt())
			.mockRejectedValueOnce(new Error("second stop failed"));

		await expect(removeProjectWithResources("project-1")).rejects.toThrow(
			"second stop failed",
		);

		expect(mocks.stopManaged).toHaveBeenCalledTimes(2);
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(mocks.durableRemove).not.toHaveBeenCalled();
		expect(useStore.getState().projects).toHaveLength(1);
		expect(useStore.getState().agents).toEqual([first, second]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("prepares every Project Agent dispatch before stopping any provider", async () => {
		const first = managedAgent();
		const second = colocatedManagedAgent("agent-second", "session-second");
		useStore.setState({ agents: [first, second] });
		mocks.prepareManagedOperation
			.mockImplementationOnce(async (target) => ({
				target,
				stopFence: target.binding.stopFence,
				stopId: "stop-first",
				authorityKey: "authority-first",
			}))
			.mockRejectedValueOnce(new Error("second dispatch preparation failed"));

		await expect(removeProjectWithResources("project-1")).rejects.toThrow(
			"second dispatch preparation failed",
		);

		expect(mocks.prepareManagedOperation).toHaveBeenCalledTimes(2);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(mocks.durableRemove).not.toHaveBeenCalled();
		expect(useStore.getState().projects).toHaveLength(1);
		expect(useStore.getState().agents).toEqual([first, second]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

  it("terminates standalone through Hmux and never through the legacy session adapter", async () => {
    useStore.setState({
      agents: [standaloneAgent()],
    });

    await removeAgentWithResources("agent-standalone");

		expect(mocks.terminateExact).toHaveBeenCalledWith(
      "session-standalone",
      "workspace-standalone",
			"standalone-epoch-1",
			"standalone",
    );
		expect(mocks.terminateStandalone).not.toHaveBeenCalled();
    expect(useStore.getState().agents).toEqual([]);
  });

	it("replays an ambiguous standalone stop against its frozen terminal generation", async () => {
		const source = standaloneAgent();
		const successor: Agent = {
			...source,
			projectId: "project-successor",
			worktreePath: "/repo/successor",
		};
		useStore.setState({ agents: [source] });
		let attempts = 0;
		const ambiguousStop = async () => {
			attempts += 1;
			if (attempts === 1) {
				useStore.setState({ agents: [successor] });
				throw new Error("standalone stop response lost");
			}
			return {
				sessionId: "session-standalone",
				workspaceId: "workspace-standalone",
				terminalEpoch: "standalone-epoch-1",
				sessionClass: "standalone" as const,
				outcome: "already_exited" as const,
			};
		};
		mocks.terminateExact.mockImplementation(ambiguousStop);
		const operation = await prepareAgentRemoval(source.id, {
			deleteWorktree: false,
		});

		await expect(executeAgentRemoval(operation)).rejects.toThrow(
			"standalone stop response lost",
		);
		await executeAgentRemoval(operation);

		expect(mocks.inspectExact).toHaveBeenCalledOnce();
		expect(mocks.terminateExact).toHaveBeenCalledTimes(2);
		expect(mocks.terminateExact.mock.calls[1]).toEqual(
			mocks.terminateExact.mock.calls[0],
		);
		expect(mocks.terminateExact).toHaveBeenCalledWith(
			"session-standalone",
			"workspace-standalone",
			"standalone-epoch-1",
			"standalone",
		);
		expect(mocks.terminateStandalone).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([successor]);
	});

  it("removes a project only after standalone Hmux agents are terminated and unbound", async () => {
    useStore.setState({
      agents: [standaloneAgent()],
    });

    await removeProjectWithResources("project-1");

		expect(mocks.terminateExact).toHaveBeenCalledWith(
      "session-standalone",
      "workspace-standalone",
			"standalone-epoch-1",
			"standalone",
    );
		expect(mocks.terminateStandalone).not.toHaveBeenCalled();
		expect(mocks.durableRemove).toHaveBeenCalledOnce();
		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				agents: [
					expect.objectContaining({ agentId: "agent-standalone" }),
				],
				projects: [
					expect.objectContaining({ projectId: "project-1" }),
				],
			}),
		);
		expect(mocks.removePanels).not.toHaveBeenCalled();
  });

	it("routes canonical SSH-host removal through dispatch stop", async () => {
		const host: SshHostConfig = {
			id: "remote-1",
			name: "Remote",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "auto",
		};
		const remote = {
			...managedAgent(),
			projectId: "project-remote",
			sessionKind: "ssh" as const,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: host.id,
				operationId: "spawn-canonical",
			},
		};
		const remoteRoute = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-1",
			host.id,
		);
		useStore.setState({
			agents: [remote],
			projects: [
				{
					id: "project-remote",
					name: "Remote",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: host.id,
					isRepo: true,
				},
			],
			sshHosts: [host],
		});
		mocks.inspectCanonicalStop.mockResolvedValue({
			receipt: null,
			routeAuthority: remoteRoute,
		});

		await removeSshHostWithResources(host.id);

		expect(mocks.createCanonicalStopClient).toHaveBeenCalledWith({
			profileId: host.id,
		});
		expect(mocks.inspectCanonicalStop).toHaveBeenCalledWith(
			"spawn-canonical",
		);
		expect(mocks.previewCanonicalStop).toHaveBeenCalledOnce();
		expect(mocks.applyCanonicalStop).toHaveBeenCalledOnce();
		expect(mocks.stopStructured).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(mocks.durableRemove).toHaveBeenCalledOnce();
		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				agents: [expect.objectContaining({ agentId: remote.id })],
				projects: [
					expect.objectContaining({ projectId: "project-remote" }),
				],
				sshHosts: [expect.objectContaining({ hostId: host.id })],
			}),
		);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("counts Agent and loose-pane sessions once in Host-removal consent", () => {
		const agent = {
			...managedAgent(),
			sessionKind: "ssh" as const,
			sessionId: "shared-session",
		};

		expect(
			sshHostRemovalSessionCount({
				hostId: "remote-1",
				scope: {
					hostId: "remote-1",
					projects: [],
					agents: [],
				},
				projectIds: [],
				agents: [agent],
				panes: [
					{
						spaceId: "space-1",
						panelId: "ssh:shared",
						params: {},
						sessions: [
							{
								kind: "ssh",
								sessionId: "shared-session",
								panelId: "ssh:shared",
								persistent: true,
							},
							{
								kind: "pty",
								sessionId: "shared-session",
								panelId: "local:shared",
								persistent: false,
							},
						],
					},
				],
			}),
		).toBe(2);
	});

	it("refuses an SSH-host cascade when a project is added during Agent stop", async () => {
		const host: SshHostConfig = {
			id: "remote-1",
			name: "Remote",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "auto",
		};
		const source = {
			...managedAgent(),
			projectId: "project-remote",
			sessionKind: "ssh" as const,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: host.id,
				operationId: "spawn-canonical",
			},
		};
		const newcomer = {
			...legacyAgent(),
			id: "agent-newcomer",
			projectId: "project-new",
			sessionKind: "ssh" as const,
		};
		const originalProject = {
			id: "project-remote",
			name: "Remote",
			path: "/srv/repo",
			kind: "ssh" as const,
			sshHostId: host.id,
			isRepo: true,
		};
		const newProject = {
			...originalProject,
			id: "project-new",
			path: "/srv/new",
		};
		useStore.setState({
			agents: [source],
			projects: [originalProject],
			sshHosts: [host],
		});
		mocks.inspectCanonicalStop.mockResolvedValue({
			receipt: null,
			routeAuthority: testDureBackendRouteAuthority(
				"dure-remote",
				"generation-1",
				host.id,
			),
		});
		mocks.applyCanonicalStop.mockImplementationOnce(async () => {
			useStore.setState({
				agents: [source, newcomer],
				projects: [originalProject, newProject],
			});
			return canonicalStopReceipt("workspace_preserved");
		});

		await expect(removeSshHostWithResources(host.id)).rejects.toMatchObject({
			code: "pane_changed",
		});

		expect(useStore.getState().sshHosts).toEqual([host]);
		expect(useStore.getState().projects).toEqual([originalProject, newProject]);
		expect(useStore.getState().agents).toEqual([source, newcomer]);
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(mocks.durableRemove).toHaveBeenCalledOnce();
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("preserves the credential until reference-aware cleanup exists", async () => {
		const host: SshHostConfig = {
			id: "remote-1",
			name: "Remote",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "password",
			secretId: "secret-old",
		};
		useStore.setState({ agents: [], projects: [], sshHosts: [host] });

		await expect(removeSshHostWithResources(host.id)).resolves.toBeDefined();

		expect(mocks.durableRemove).toHaveBeenCalledOnce();
		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				sshHosts: [expect.objectContaining({ hostId: host.id })],
			}),
		);
	});

	it("keeps a project when standalone termination is superseded", async () => {
		const source = standaloneAgent();
		const replacement: Agent = {
			...source,
			runtimeBinding: {
				...source.runtimeBinding,
				commandBridgeNonce: "bridge-later",
			} as Agent["runtimeBinding"],
		};
		useStore.setState({ agents: [source] });
		mocks.terminateExact.mockImplementationOnce(async () => {
			useStore.setState({ agents: [replacement] });
			return standaloneTerminationReceipt();
		});

		await expect(removeProjectWithResources("project-1")).rejects.toMatchObject(
			{
				code: "pane_changed",
			},
		);

		expect(useStore.getState().projects).toHaveLength(1);
		expect(useStore.getState().agents).toEqual([replacement]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("removes a project while preserving a same-id successor moved elsewhere", async () => {
		const source = standaloneAgent();
		const replacement: Agent = {
			...source,
			projectId: "project-2",
			runtimeBinding: {
				...source.runtimeBinding,
				commandBridgeNonce: "bridge-later",
			} as Agent["runtimeBinding"],
		};
		useStore.setState((state) => ({
			projects: [
				...state.projects,
				{
					id: "project-2",
					name: "Successor",
					path: "/successor",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [source],
		}));
		mocks.terminateExact.mockImplementationOnce(async () => {
			useStore.setState({ agents: [replacement] });
			return standaloneTerminationReceipt();
		});

		await expect(removeProjectWithResources("project-1")).resolves.toBeDefined();

		expect(useStore.getState().agents).toEqual([replacement]);
		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(mocks.durableRemove).toHaveBeenCalledOnce();
		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				agents: [expect.objectContaining({ agentId: source.id })],
				projects: [expect.objectContaining({ projectId: "project-1" })],
			}),
		);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("preserves a Project when its Host authority is superseded during stop", async () => {
		const host: SshHostConfig = {
			id: "host-project",
			name: "Project host",
			host: "source.example.test",
			port: 22,
			user: "dure",
			auth: "auto",
		};
		const replacement = { ...host, host: "successor.example.test" };
		const project = {
			id: "project-remote",
			name: "Remote",
			path: "/srv/repo",
			kind: "ssh" as const,
			sshHostId: host.id,
			isRepo: true,
		};
		const remote: Agent = {
			...managedAgent(),
			id: "agent-remote",
			projectId: project.id,
			sessionKind: "ssh",
			worktreePath: "/srv/repo/.worktrees/agent-remote",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: host.id,
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-remote",
				stopFence: stopFenceFixture(),
			},
		};
		useStore.setState({
			agents: [remote],
			projects: [project],
			sshHosts: [host],
		});
		mocks.managedReceiptApplies.mockImplementationOnce(async () => {
			useStore.setState({ sshHosts: [replacement] });
			return true;
		});

		await expect(removeProjectWithResources(project.id)).rejects.toMatchObject({
			code: "pane_changed",
		});

		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				agents: [expect.objectContaining({ agentId: remote.id })],
				projects: [expect.objectContaining({ projectId: project.id })],
			}),
		);
		expect(useStore.getState().projects).toEqual([project]);
		expect(useStore.getState().agents).toEqual([remote]);
		expect(useStore.getState().sshHosts).toEqual([replacement]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

  it("removes a backend-owned native projection after its authoritative stop", async () => {
    const backendOwnedNative = {
      ...managedAgent(),
      executionProfile: { kind: "provider_default" as const },
    };
    useStore.setState({ agents: [backendOwnedNative] });
    mocks.inspectRuntime.mockResolvedValue({
      state: "stable",
      routeAuthority: runtimeRouteAuthority,
    });

    await removeProjectWithResources("project-1");

    expect(mocks.stopStructured).toHaveBeenCalledWith(
      backendOwnedNative.id,
      runtimeRouteAuthority,
    );
    expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				agents: [expect.objectContaining({ agentId: backendOwnedNative.id })],
				projects: [expect.objectContaining({ projectId: "project-1" })],
			}),
		);
		expect(mocks.removePanels).not.toHaveBeenCalled();
  });

	it("rejects a backend stop route on a different transport before deletion", async () => {
		const backendOwnedNative = {
			...managedAgent(),
			executionProfile: { kind: "provider_default" as const },
		};
		const remoteRoute = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-1",
			"remote-a",
		);
		useStore.setState({ agents: [backendOwnedNative] });
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: remoteRoute,
		});

		await expect(
			prepareAgentRemoval(backendOwnedNative.id, { deleteWorktree: true }),
		).rejects.toThrow("client_backend_host_mismatch");

		expect(mocks.stopStructured).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([backendOwnedNative]);
	});

	it("binds a backend stop to the SSH target frozen with worktree capture", async () => {
		const hostA: SshHostConfig = {
			id: "host-remote",
			name: "A",
			host: "a.example.test",
			port: 22,
			user: "dure",
			auth: "auto",
		};
		const hostB: SshHostConfig = {
			...hostA,
			name: "B",
			host: "backend.example.test",
		};
		const remote: Agent = {
			...structuredAgent(),
			id: "agent-remote-backend",
			projectId: "project-remote",
			sessionKind: "ssh",
			worktreePath: "/srv/repo/.worktrees/agent",
			branch: "agent/remote",
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "remote-b",
				interactionSessionId: "interaction-remote",
			},
		};
		const routeB = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-1",
			"remote-b",
		);
		const remoteInstance = [
			remote.worktreePath,
			"/srv/repo/.git",
			"/srv/repo/.git/worktrees/agent",
			"dwt1_0123456789abcdef0123456789abcdef",
		] as const;
		useStore.setState({
			agents: [remote],
			projects: [
				{
					id: "project-remote",
					name: "Remote",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: hostA.id,
					isRepo: true,
				},
			],
			sshHosts: [hostA],
		});
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: routeB,
		});
		mocks.sshExecOnce.mockImplementation(
			async (_ssh, command: SshCommandSource) => {
				const commandSource = sshCommandSourceText(command);
				if (commandSource.includes(" capture-v1")) {
					useStore.setState({ sshHosts: [hostB] });
					return remoteInstanceReceipt(remoteInstance);
				}
				if (commandSource.includes(" locations-v1")) {
					return remoteLocationReceipt(
						remote.worktreePath,
						remoteInstance[1],
					);
				}
				throw new Error("unexpected destructive SSH command");
			},
		);

		await expect(
			prepareAgentRemoval(remote.id, { deleteWorktree: true }),
		).rejects.toThrow("client_backend_host_mismatch");

		expect(mocks.stopStructured).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(
			mocks.sshExecOnce.mock.calls.some(([, command]) =>
				sshCommandSourceText(command).includes(" remove-v1"),
			),
		).toBe(false);
		expect(useStore.getState().agents).toEqual([remote]);
	});

	it("rejects an equal-address backend route owned by another SSH host", async () => {
		const projectHost: SshHostConfig = {
			id: "host-project",
			name: "Project host",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "auto",
		};
		const backendHost: SshHostConfig = {
			...projectHost,
			id: "host-backend",
			name: "Backend host",
		};
		const remote: Agent = {
			...structuredAgent(),
			id: "agent-equal-address-backend",
			projectId: "project-remote",
			sessionKind: "ssh",
			worktreePath: "/srv/repo/.worktrees/agent",
			branch: "agent/remote",
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: backendHost.id,
				interactionSessionId: "interaction-remote",
			},
		};
		useStore.setState({
			agents: [remote],
			projects: [
				{
					id: "project-remote",
					name: "Remote",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: projectHost.id,
					isRepo: true,
				},
			],
			sshHosts: [projectHost, backendHost],
		});
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: testDureBackendRouteAuthority(
				"dure-remote",
				"generation-1",
				backendHost.id,
			),
		});
		mocks.prepareTrustedSsh.mockResolvedValue({
			schemaVersion: 1,
			hostId: projectHost.id,
			host: projectHost.host,
			port: projectHost.port,
			user: projectHost.user,
			auth: projectHost.auth,
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		});
		mocks.sshExecOnce.mockImplementation(
			async (_ssh, command: SshCommandSource) => {
				const commandSource = sshCommandSourceText(command);
				if (commandSource.includes(" capture-v1")) {
					return remoteInstanceReceipt([
						remote.worktreePath,
						"/srv/repo/.git",
						"/srv/repo/.git/worktrees/agent",
						"dwt1_0123456789abcdef0123456789abcdef",
					]);
				}
				if (commandSource.includes(" locations-v1")) {
					return remoteLocationReceipt(
						remote.worktreePath,
						"/srv/repo/.git",
					);
				}
				throw new Error("unexpected destructive SSH command");
			},
		);

		await expect(
			prepareAgentRemoval(remote.id, { deleteWorktree: true }),
		).rejects.toThrow("client_backend_host_mismatch");

		expect(mocks.stopStructured).not.toHaveBeenCalled();
		expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([remote]);
	});

	it("keeps a project when a backend stop is superseded by a new projection", async () => {
		const source = {
			...managedAgent(),
			interactionProfile: {
				schemaVersion: 1 as const,
				kind: "structured_protocol" as const,
				backendProfileId: "local",
				interactionSessionId: "interaction-structured",
			},
		};
		const replacement: Agent = {
			...source,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-later" }),
			}),
		};
		useStore.setState({ agents: [source] });
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: runtimeRouteAuthority,
		});
		mocks.stopStructured.mockImplementationOnce(async () => {
			useStore.setState({ agents: [replacement] });
		});

		await expect(removeProjectWithResources("project-1")).rejects.toMatchObject(
			{
				code: "pane_changed",
			},
		);

		expect(useStore.getState().projects).toHaveLength(1);
		expect(useStore.getState().agents).toEqual([replacement]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("keeps a project when an absent stop is superseded by a new generation", async () => {
		const source = managedAgent();
		const replacement: Agent = {
			...source,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-later" }),
			}),
		};
		mocks.stopManaged.mockImplementationOnce(async () => {
			useStore.setState({ agents: [replacement] });
			throw new ManagedSessionAbsentError(
				"session-managed",
				"workspace-managed",
			);
		});

		await expect(removeProjectWithResources("project-1")).rejects.toMatchObject(
			{
				code: "pane_changed",
			},
		);

		expect(useStore.getState().projects).toHaveLength(1);
		expect(useStore.getState().agents).toEqual([replacement]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

	it("keeps a project when a managed stop receipt is superseded", async () => {
		const source = managedAgent();
		const replacement: Agent = {
			...source,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				createIdempotencyKey: undefined,
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-later" }),
			}),
		};
		mocks.stopManaged.mockImplementationOnce(async () => {
			useStore.setState({ agents: [replacement] });
			return receipt();
		});
		mocks.managedReceiptApplies.mockResolvedValueOnce(false);

		await expect(removeProjectWithResources("project-1")).rejects.toMatchObject(
			{
				code: "pane_changed",
			},
		);

		expect(mocks.finalizeManaged).not.toHaveBeenCalled();
		expect(useStore.getState().projects).toHaveLength(1);
		expect(useStore.getState().agents).toEqual([replacement]);
		expect(mocks.removePanels).not.toHaveBeenCalled();
	});

  it("does not stop a stale standalone projection after the backend closes its exact runtime", async () => {
    const backendOwned = {
      ...structuredAgent(),
      runtimeBinding: standaloneAgent().runtimeBinding,
    };
    useStore.setState({ agents: [backendOwned] });
    mocks.inspectRuntime.mockResolvedValue({
      state: "stable",
      routeAuthority: runtimeRouteAuthority,
    });

    await removeProjectWithResources("project-1");

    expect(mocks.stopStructured).toHaveBeenCalledWith(
      backendOwned.id,
      runtimeRouteAuthority,
    );
    expect(mocks.terminateStandalone).not.toHaveBeenCalled();
		expect(mocks.durableRemove).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "batch",
				agents: [expect.objectContaining({ agentId: backendOwned.id })],
				projects: [expect.objectContaining({ projectId: "project-1" })],
			}),
		);
		expect(mocks.removePanels).not.toHaveBeenCalled();
  });
});
