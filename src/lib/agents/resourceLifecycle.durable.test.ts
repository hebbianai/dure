// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { DurableWriteCoordinator } from "@/lib/persistence/durableWriteCoordinator";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import { subscribeDurableStoreLayoutProjection } from "@/lib/persistence/durableStoreRehydration";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { remoteHmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import type { Agent, Project, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	applyCanonicalStop: vi.fn(),
	createCanonicalStopClient: vi.fn(),
	createRuntimeClient: vi.fn(),
	inspectCanonicalStop: vi.fn(),
	inspectRuntime: vi.fn(),
	previewCanonicalStop: vi.fn(),
	publishLayoutPush: vi.fn(),
	removeLegacyPanels: vi.fn(),
	removeMountedPanels: vi.fn(),
	reloadCurrentPage: vi.fn(),
	sshCredentialClaimRetire: vi.fn(),
	stopRuntime: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	sshCredentialClaimRetire: mocks.sshCredentialClaimRetire,
}));

vi.mock("@/lib/ipc/dureAgentRuntime", () => ({
	createDureAgentRuntimeClient: mocks.createRuntimeClient,
}));

vi.mock("@/lib/ipc/dureAgentStop", () => ({
	createDureAgentStopClient: mocks.createCanonicalStopClient,
}));

vi.mock(
	"@/lib/workspace/pane/paneCloseCoordinator",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/workspace/pane/paneCloseCoordinator")
		>()),
		removeMountedPanelsWithoutSessionTeardown: mocks.removeMountedPanels,
		removePanelsWithoutSessionTeardown: mocks.removeLegacyPanels,
	}),
);

vi.mock("@/lib/workspace/layout/layoutPushChannel", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/layout/layoutPushChannel")
	>()),
	publishLayoutPush: mocks.publishLayoutPush,
}));

vi.mock("@/lib/platform/pageReload", () => ({
	reloadCurrentPage: mocks.reloadCurrentPage,
}));

import {
	executeProjectRemoval,
	executeSshHostRemoval,
	planProjectRemoval,
	removeProjectWithResources,
	removeSshHostWithResources,
} from "@/lib/agents/resourceLifecycle";
import { planSshHostRemoval } from "@/lib/agents/sshHostRemovalPlan";
import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";
import { rollbackCreatedAgentRegistration } from "@/lib/agents/agentRegistrationRollback";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
	rehydrateAppStoreFromDurableStorage,
	useStore,
} from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	managedAgentFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const spaceId = "desk-1";
const collisionSpaceId = "desk-2";

function localProject(id: string, path: string): Project {
	return {
		id,
		name: id,
		path,
		kind: "local",
		isRepo: true,
	};
}

function remoteProject(id: string, path: string, hostId: string): Project {
	return {
		id,
		name: id,
		path,
		kind: "ssh",
		sshHostId: hostId,
		isRepo: true,
	};
}

function host(id: string, hostname: string): SshHostConfig {
	return {
		id,
		name: id,
		host: hostname,
		port: 22,
		user: "dure",
		auth: "auto",
	};
}

function structuredAgent(
	id: string,
	projectId: string,
	sessionId: string,
	backendProfileId: string,
): Agent {
	return agentFixture({
		id,
		name: id,
		projectId,
		worktreePath: `/repo/.worktrees/${id}`,
		branch: id,
		sessionId,
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId,
			interactionSessionId: `interaction-${id}`,
		},
	});
}

function withSshRuntime(agent: Agent, hostId: string): Agent {
	return {
		...agent,
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId,
			sessionId: agent.sessionId,
			workspaceId: `workspace-${agent.id}`,
			createIdempotencyKey: `create-${agent.id}`,
			commandBridgeNonce: `nonce-${agent.id}`,
		},
	};
}

function panelDefinition(
	id: string,
	{ component, ...params }: Record<string, unknown> = {},
): Record<string, unknown> {
	if (component === undefined && id.startsWith("git:")) {
		return { id, component: "git", params: { projectId: id.slice(4), ...params } };
	}
	return { id, component: component ?? "test", params };
}

function layout(
	panels: Readonly<Record<string, Record<string, unknown>>> = {},
): Record<string, unknown> {
	return {
		panels: Object.fromEntries(
			Object.entries(panels).map(([id, params]) => [
				id,
				panelDefinition(id, params),
			]),
		),
	};
}

function addPanel(
	value: unknown,
	id: string,
	params: Record<string, unknown> = {},
): unknown {
	const current = value as {
		panels: Record<string, unknown>;
	};
	return {
		...current,
		panels: {
			...current.panels,
			[id]: panelDefinition(id, params),
		},
	};
}

function persistedState(patch: Partial<PersistedAppState>): PersistedAppState {
	return {
		...normalizePersistedState({}),
		spaces: [{ id: spaceId, name: "Main" }],
		...patch,
	};
}

function readDurableState(): PersistedAppState {
	return (
		JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null") as {
			state: PersistedAppState;
		}
	).state;
}

async function installBaseline(
	state: PersistedAppState,
	sessionCwd: Record<string, string>,
): Promise<void> {
	await durableAppStorage.flush();
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: { state, version: PERSIST_VERSION },
		result: undefined,
	}));
	await rehydrateAppStoreFromDurableStorage();
	useStore.setState({
		agentActivity: {},
		agentRuntimeLaunchPresentation: {},
		detected: {},
		diffComments: {},
		gitStatuses: {},
		gitStatusErrors: {},
		restartRequests: {},
		sessionActivity: {},
		sessionAgent: {},
		sessionAgentPin: {},
		sessionAgentRuntimeState: {},
		sessionCwd,
		sessionTitle: {},
		sshMessages: {},
		sshStates: {},
	});
	await durableAppStorage.flush();
}

function secondRealm(state: PersistedAppState) {
	const storage = createReferenceAwareLocalStorage<PersistedAppState>({
		coordinator: new DurableWriteCoordinator(),
		convergeState: convergePersistedAppState,
	});
	const observed = storage.getItem(DURABLE_APP_STORE_NAME);
	if (!observed) throw new Error("expected durable baseline");
	return {
		publish: async (next: PersistedAppState) => {
			storage.setItem(DURABLE_APP_STORE_NAME, {
				state: next,
				version: PERSIST_VERSION,
			});
			await storage.flush();
		},
		state,
	};
}

function panelIds(state: PersistedAppState): string[] {
	return panelsFromLayout(state.layouts[spaceId])
		.map((panel) => panel.id)
		.sort();
}

describe("durable Project and SSH-host removal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createRuntimeClient.mockReturnValue({
			inspect: mocks.inspectRuntime,
			remove: mocks.stopRuntime,
		});
		mocks.createCanonicalStopClient.mockReturnValue({
			status: mocks.inspectCanonicalStop,
			preview: mocks.previewCanonicalStop,
			apply: mocks.applyCanonicalStop,
		});
		mocks.sshCredentialClaimRetire.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rolls back one exact Agent registration with every canonical pane and runtime projection", async () => {
		const targetProject = localProject("project-agent", "/repo/agent");
		const target = managedAgentFixture({
			id: "agent-created",
			projectId: targetProject.id,
			sessionId: "session-created",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-created",
				workspaceId: "workspace-created",
				createIdempotencyKey: "create-created",
				stopFence: stopFenceFixture(),
			}),
		});
		const panelId = `agent:${target.id}`;
		const baseline = persistedState({
			spaces: [
				{ id: spaceId, name: "Main" },
				{ id: collisionSpaceId, name: "Other" },
			],
			projects: [targetProject],
			agents: [target],
			layouts: {
				[spaceId]: layout({ [panelId]: { component: "agent" } }),
				[collisionSpaceId]: layout({ [panelId]: { component: "agent" } }),
			},
			pinnedPanes: {
				[`${spaceId}:${panelId}`]: true,
				[`${collisionSpaceId}:${panelId}`]: true,
			},
		});
		await installBaseline(baseline, {
			[target.sessionId]: target.worktreePath,
			"session-keep": "/repo/keep",
		});
		useStore.setState({
			agentActivity: { [target.id]: "connecting" },
			sessionAgent: { [target.sessionId]: target.provider },
		});

		await expect(rollbackCreatedAgentRegistration(target)).resolves.toBe(true);

		const final = readDurableState();
		expect(final.agents).toEqual([]);
		expect(
			Object.values(final.layouts).flatMap((entry) =>
				panelsFromLayout(entry).map((panel) => panel.id),
			),
		).not.toContain(panelId);
		expect(final.pinnedPanes).toEqual({});
		expect(useStore.getState().agentActivity).not.toHaveProperty(target.id);
		expect(useStore.getState().sessionAgent).not.toHaveProperty(target.sessionId);
		expect(useStore.getState().sessionCwd).toEqual({
			"session-keep": "/repo/keep",
		});
	});

	it("preserves a same-id Agent generation successor during registration rollback", async () => {
		const targetProject = localProject("project-agent", "/repo/agent");
		const target = managedAgentFixture({
			id: "agent-created",
			projectId: targetProject.id,
			sessionId: "session-created",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-created",
				workspaceId: "workspace-created",
				createIdempotencyKey: "create-created",
				stopFence: stopFenceFixture(),
			}),
		});
		const successor: Agent = {
			...target,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-created",
				workspaceId: "workspace-created",
				createIdempotencyKey: "create-created",
				stopFence: stopFenceFixture({ runnerInstance: "runner-successor" }),
			}),
		};
		const panelId = `agent:${target.id}`;
		const baseline = persistedState({
			projects: [targetProject],
			agents: [target],
			layouts: { [spaceId]: layout({ [panelId]: { component: "agent" } }) },
			pinnedPanes: { [`${spaceId}:${panelId}`]: true },
		});
		await installBaseline(baseline, {
			[target.sessionId]: target.worktreePath,
		});
		await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => ({
			value: current
				? {
						...current,
						state: { ...normalizePersistedState(current.state), agents: [successor] },
					}
				: current,
			result: undefined,
		}));
		const project = vi.fn(() => true);
		const stopProjection = subscribeDurableStoreLayoutProjection(
			spaceId,
			project,
			() => true,
		);

		try {
			await expect(rollbackCreatedAgentRegistration(target)).resolves.toBe(false);
		} finally {
			stopProjection();
		}

		const final = readDurableState();
		expect(final.agents).toEqual([successor]);
		expect(panelIds(final)).toContain(panelId);
		expect(final.pinnedPanes).toEqual({ [`${spaceId}:${panelId}`]: true });
		expect(useStore.getState().sessionCwd).toEqual({
			[target.sessionId]: target.worktreePath,
		});
		expect(project).toHaveBeenCalledOnce();
	});

	it("fences a stale source realm when successor projection fails after rollback rejection", async () => {
		const targetProject = localProject("project-agent", "/repo/agent");
		const target = managedAgentFixture({
			id: "agent-created",
			projectId: targetProject.id,
			sessionId: "session-created",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-created",
				workspaceId: "workspace-created",
				createIdempotencyKey: "create-created",
				stopFence: stopFenceFixture(),
			}),
		});
		const successor: Agent = {
			...target,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-created",
				workspaceId: "workspace-created",
				createIdempotencyKey: "create-created",
				stopFence: stopFenceFixture({ runnerInstance: "runner-successor" }),
			}),
		};
		const panelId = `agent:${target.id}`;
		await installBaseline(
			persistedState({
				projects: [targetProject],
				agents: [target],
				layouts: { [spaceId]: layout({ [panelId]: { component: "agent" } }) },
			}),
			{ [target.sessionId]: target.worktreePath },
		);
		await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => ({
			value: current
				? {
						...current,
						state: { ...normalizePersistedState(current.state), agents: [successor] },
					}
				: current,
			result: undefined,
		}));
		const rehydrate = vi
			.spyOn(useStore.persist, "rehydrate")
			.mockRejectedValue(new Error("successor projection failed"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const freezeProjectionAncestor = durableAppStorage.freezeProjectionAncestor.bind(
			durableAppStorage,
		);
		let releaseProjectionWrites: (() => void) | undefined;
		const freeze = vi
			.spyOn(durableAppStorage, "freezeProjectionAncestor")
			.mockImplementation(() => {
				releaseProjectionWrites = freezeProjectionAncestor();
				return releaseProjectionWrites;
			});

		try {
			await expect(rollbackCreatedAgentRegistration(target)).resolves.toBe(false);
			expect(rehydrate).toHaveBeenCalledTimes(2);
			expect(freeze).toHaveBeenCalledOnce();
			expect(mocks.reloadCurrentPage).toHaveBeenCalledOnce();
			expect(readDurableState().agents).toEqual([successor]);
		} finally {
			releaseProjectionWrites?.();
		}
	});

	it("atomically removes an exact Project while preserving a cross-WebView same-ID successor", async () => {
		const target = localProject("project-remove", "/repo/remove");
		const survivor = localProject("project-survive", "/repo/survive");
		const concurrent = localProject("project-concurrent", "/repo/concurrent");
		const doomed = structuredAgent(
			"agent-doomed",
			target.id,
			"session-doomed",
			"local",
		);
		const source = structuredAgent(
			"agent-source",
			target.id,
			"session-shared",
			"local",
		);
		const successor: Agent = {
			...source,
			projectId: survivor.id,
			worktreePath: "/repo/survive/.worktrees/successor",
			branch: "successor",
			sessionId: "session-successor",
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-successor",
			},
		};
		const baseline = persistedState({
			projects: [target, survivor],
			pinnedProjects: [target.id, survivor.id],
			agents: [doomed, source],
			layouts: {
				[spaceId]: layout({
					[`git:${target.id}`]: {},
					[`agent:${doomed.id}`]: { component: "agent" },
					[`agent:${source.id}`]: { component: "agent" },
					"file:base": {},
				}),
			},
			pinnedPanes: {
				[`${spaceId}:git:${target.id}`]: true,
				[`${spaceId}:agent:${doomed.id}`]: true,
				[`${spaceId}:agent:${source.id}`]: true,
				[`${spaceId}:file:base`]: true,
			},
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: "/repo/remove/doomed",
			[source.sessionId]: "/repo/remove/source",
			[successor.sessionId]: "/repo/survive/successor",
			"session-keep": "/repo/keep",
		});
		const remote = secondRealm(baseline);
		const concurrentState = {
			...baseline,
			projects: [target, survivor, concurrent],
			pinnedProjects: [target.id, survivor.id, concurrent.id],
			agents: [doomed, successor],
			layouts: {
				...baseline.layouts,
				[spaceId]: addPanel(baseline.layouts[spaceId], "file:concurrent"),
			},
			pinnedPanes: {
				...baseline.pinnedPanes,
				[`${spaceId}:file:concurrent`]: true,
			},
		};
		const route = testDureBackendRouteAuthority("dure-local", "generation-1");
		mocks.inspectRuntime.mockImplementation(async (agentId: string) =>
			agentId === doomed.id
				? { state: "unmanaged" }
				: { state: "stable", routeAuthority: route },
		);
		mocks.stopRuntime.mockImplementation(async (agentId: string) => {
			if (agentId === source.id) await remote.publish(concurrentState);
		});
		const projectedPanels: string[][] = [];
		const stopProjection = subscribeDurableStoreLayoutProjection(
			spaceId,
			() => {
				projectedPanels.push(
					panelsFromLayout(useStore.getState().layouts[spaceId])
						.map((panel) => panel.id)
						.sort(),
				);
				return true;
			},
			() => true,
		);
		const transaction = vi.spyOn(durableAppStorage, "transact");

		try {
			await expect(removeProjectWithResources(target.id)).resolves.toBeDefined();
		} finally {
			stopProjection();
		}
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(final.projects).toEqual([survivor, concurrent]);
		expect(final.pinnedProjects).toEqual([survivor.id, concurrent.id]);
		expect(final.agents).toEqual([successor]);
		expect(panelIds(final)).toEqual(
			[`agent:${successor.id}`, "file:base", "file:concurrent"].sort(),
		);
		expect(final.pinnedPanes).toEqual({
			[`${spaceId}:agent:${successor.id}`]: true,
			[`${spaceId}:file:base`]: true,
			[`${spaceId}:file:concurrent`]: true,
		});
		expect(useStore.getState().sessionCwd).toEqual({
			[successor.sessionId]: "/repo/survive/successor",
			"session-keep": "/repo/keep",
		});
		expect(projectedPanels).toEqual([
			[`agent:${successor.id}`, "file:base", "file:concurrent"].sort(),
		]);
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
		expect(mocks.removeLegacyPanels).not.toHaveBeenCalled();
			expect(mocks.publishLayoutPush).not.toHaveBeenCalled();
		});

		it("does not let armed Project consent target a same-ID successor", async () => {
			const source = localProject("project-remove", "/repo/source");
			const successor = { ...source, path: "/repo/successor" };
			const baseline = persistedState({ projects: [source] });
			await installBaseline(baseline, {});
			const plan = planProjectRemoval(source.id);
			useStore.setState({ projects: [successor] });

			await expect(executeProjectRemoval(plan)).rejects.toMatchObject({
				code: "pane_changed",
			});

			expect(mocks.stopRuntime).not.toHaveBeenCalled();
			expect(readDurableState().projects).toEqual([successor]);
			expect(useStore.getState().projects).toEqual([successor]);
		});

		it("rejects a remote Project when its SSH Host generation changes after consent", async () => {
			const sourceHost = {
				...host("host-remote", "backend.example.test"),
				registrationGeneration: "host-generation-source",
			};
			const successorHost = {
				...sourceHost,
				registrationGeneration: "host-generation-successor",
			};
			const project = remoteProject(
				"project-remove",
				"/srv/source",
				sourceHost.id,
			);
			const agent = structuredAgent(
				"agent-doomed",
				project.id,
				"session-doomed",
				sourceHost.id,
			);
			const baseline = persistedState({
				sshHosts: [sourceHost],
				projects: [project],
				agents: [agent],
			});
			await installBaseline(baseline, {
				[agent.sessionId]: agent.worktreePath,
			});
			const plan = planProjectRemoval(project.id);
			useStore.setState({ sshHosts: [successorHost] });
			const transaction = vi.spyOn(durableAppStorage, "transact");

			await expect(executeProjectRemoval(plan)).rejects.toMatchObject({
				code: "pane_changed",
			});

			expect(mocks.stopRuntime).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
		});

		it("freezes an Agent runtime Host outside its Project ancestry", async () => {
			const runtimeHost = {
				...host("host-runtime", "backend.example.test"),
				registrationGeneration: "host-generation-source",
			};
			const project = localProject("project-remove", "/repo/source");
			const agent = withSshRuntime(
				structuredAgent(
					"agent-doomed",
					project.id,
					"session-doomed",
					runtimeHost.id,
				),
				runtimeHost.id,
			);
			const baseline = persistedState({
				sshHosts: [runtimeHost],
				projects: [project],
				agents: [agent],
			});
			await installBaseline(baseline, {
				[agent.sessionId]: agent.worktreePath,
			});
			const plan = planProjectRemoval(project.id);
			useStore.setState({
				sshHosts: [
					{
						...runtimeHost,
						registrationGeneration: "host-generation-successor",
					},
				],
			});
			const transaction = vi.spyOn(durableAppStorage, "transact");

			await expect(executeProjectRemoval(plan)).rejects.toMatchObject({
				code: "pane_changed",
			});

			expect(mocks.stopRuntime).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
		});

		it("preserves a remote Project when its Host changes during Agent stop", async () => {
			const sourceHost = {
				...host("host-remote", "backend.example.test"),
				registrationGeneration: "host-generation-source",
			};
			const successorHost = {
				...sourceHost,
				registrationGeneration: "host-generation-successor",
			};
			const project = remoteProject(
				"project-remove",
				"/srv/source",
				sourceHost.id,
			);
			const agent = structuredAgent(
				"agent-doomed",
				project.id,
				"session-doomed",
				sourceHost.id,
			);
			const baseline = persistedState({
				sshHosts: [sourceHost],
				projects: [project],
				agents: [agent],
			});
			await installBaseline(baseline, {
				[agent.sessionId]: agent.worktreePath,
			});
			const remote = secondRealm(baseline);
			mocks.inspectRuntime.mockResolvedValue({
				state: "stable",
				routeAuthority: testDureBackendRouteAuthority(
					"dure-remote",
					"generation-1",
					sourceHost.id,
				),
			});
			mocks.stopRuntime.mockImplementationOnce(async () => {
				await remote.publish({ ...baseline, sshHosts: [successorHost] });
			});

			await expect(removeProjectWithResources(project.id)).rejects.toMatchObject({
				code: "pane_changed",
			});
			await durableAppStorage.flush();

			expect(readDurableState().sshHosts).toEqual([successorHost]);
			expect(readDurableState().projects).toEqual([project]);
			expect(readDurableState().agents).toEqual([agent]);
		});

		it("preserves a Project successor committed before exact descendant cleanup", async () => {
		const source = localProject("project-remove", "/repo/source");
		const successor = { ...source, path: "/repo/successor" };
		const doomed = structuredAgent(
			"agent-doomed",
			source.id,
			"session-doomed",
			"local",
		);
		const projectPaneId = `git:${source.id}`;
		const agentPaneId = `agent:${doomed.id}`;
		const baseline = persistedState({
			projects: [source],
			agents: [doomed],
			layouts: {
				[spaceId]: layout({ [projectPaneId]: {}, [agentPaneId]: { component: "agent" } }),
			},
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: doomed.worktreePath,
		});
		const remote = secondRealm(baseline);
		const route = testDureBackendRouteAuthority("local", "generation-1");
		mocks.inspectRuntime.mockResolvedValue({ state: "stable", routeAuthority: route });
		mocks.stopRuntime.mockImplementationOnce(async () => {
			await remote.publish({ ...baseline, projects: [successor] });
		});

		await expect(removeProjectWithResources(source.id)).resolves.toBeDefined();
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(final.projects).toEqual([successor]);
		expect(final.agents).toEqual([]);
		expect(panelIds(final)).toEqual([projectPaneId]);
	});

	it("preserves a new Agent owned by a Project successor", async () => {
		const source = localProject("project-remove", "/repo/source");
		const successor = { ...source, path: "/repo/successor" };
		const doomed = structuredAgent(
			"agent-doomed",
			source.id,
			"session-doomed",
			"local",
		);
		const newcomer = structuredAgent(
			"agent-new",
			source.id,
			"session-new",
			"local",
		);
		const projectPaneId = `git:${source.id}`;
		const doomedPaneId = `agent:${doomed.id}`;
		const newcomerPaneId = `agent:${newcomer.id}`;
		const baseline = persistedState({
			projects: [source],
			agents: [doomed],
			layouts: {
				[spaceId]: layout({ [projectPaneId]: {}, [doomedPaneId]: { component: "agent" } }),
			},
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: doomed.worktreePath,
			[newcomer.sessionId]: newcomer.worktreePath,
		});
		const remote = secondRealm(baseline);
		const route = testDureBackendRouteAuthority("local", "generation-1");
		mocks.inspectRuntime.mockResolvedValue({ state: "stable", routeAuthority: route });
		mocks.stopRuntime.mockImplementationOnce(async () => {
			await remote.publish({
				...baseline,
				projects: [successor],
				agents: [doomed, newcomer],
				layouts: {
					[spaceId]: addPanel(
						baseline.layouts[spaceId],
						newcomerPaneId,
						{ component: "agent" },
					),
				},
			});
		});

		await expect(removeProjectWithResources(source.id)).resolves.toBeDefined();
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(final.projects).toEqual([successor]);
		expect(final.agents).toEqual([newcomer]);
		expect(panelIds(final)).toEqual([projectPaneId, newcomerPaneId].sort());
	});

	it("preserves runtime discovery for a same-id Project successor installed during rehydrate", async () => {
		const source = localProject("project-replaced", "/repo/source");
		const successor = { ...source, path: "/repo/successor" };
		const baseline = persistedState({ projects: [source] });
		await installBaseline(baseline, {});
		useStore.setState({ detected: { [source.id]: [] } });
		vi.spyOn(useStore.persist, "rehydrate").mockImplementationOnce(async () => {
			useStore.setState({ projects: [successor] });
		});

		await expect(
			removeAgentProjectionDurably({
				agents: [],
				projects: [
					{
						projectId: source.id,
						applies: (project) => project.path === source.path,
					},
				],
			}),
		).resolves.toBe(true);

		expect(useStore.getState().projects).toEqual([successor]);
		expect(useStore.getState().detected).toEqual({ [source.id]: [] });
	});

	it("keeps a committed removal successful when its first local rehydrate fails", async () => {
		const target = localProject("project-remove", "/repo/remove");
		const baseline = persistedState({ projects: [target] });
		await installBaseline(baseline, {});
		const rehydrate = vi
			.spyOn(useStore.persist, "rehydrate")
			.mockRejectedValueOnce(new Error("transient projection failure"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			removeAgentProjectionDurably({
				agents: [],
				projects: [
					{
						projectId: target.id,
						applies: (project) => project.path === target.path,
					},
				],
			}),
		).resolves.toBe(true);

		expect(rehydrate).toHaveBeenCalledTimes(2);
		expect(readDurableState().projects).toEqual([]);
		expect(useStore.getState().projects).toEqual([]);
		expect(warning).toHaveBeenCalledWith(
			"Failed to project durable app state; retrying",
			expect.any(Error),
		);
	});

	it("stages an owned Host credential claim before removing its durable reference", async () => {
		const credential = {
			schemaVersion: 1 as const,
			id: "ssh-rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
			hostId: "host-remove",
			registrationGeneration: "host-generation-remove",
		};
		const target = {
			...host(credential.hostId, "remove.example.test"),
			registrationGeneration: credential.registrationGeneration,
			auth: "password" as const,
			credential,
		};
		await installBaseline(persistedState({ sshHosts: [target] }), {});
		let stateAtRetirement: PersistedAppState | undefined;
		mocks.sshCredentialClaimRetire.mockImplementationOnce(async () => {
			stateAtRetirement = readDurableState();
		});

		await expect(
			removeAgentProjectionDurably({
				agents: [],
				sshHosts: [
					{
						hostId: target.id,
						applies: (candidate) =>
							candidate.registrationGeneration ===
							target.registrationGeneration,
					},
				],
			}),
		).resolves.toBe(true);

		expect(stateAtRetirement?.sshHosts).toEqual([]);
		expect(mocks.sshCredentialClaimRetire).toHaveBeenCalledWith([credential]);
		expect(readDurableState().sshHosts).toEqual([]);
	});

	it("keeps Host removal successful when retirement persistence fails safely", async () => {
		const credential = {
			schemaVersion: 1 as const,
			id: "ssh-tttttttttttttttttttttttttttttttt",
			hostId: "host-remove",
			registrationGeneration: "host-generation-remove",
		};
		const target = {
			...host(credential.hostId, "remove.example.test"),
			registrationGeneration: credential.registrationGeneration,
			auth: "password" as const,
			credential,
		};
		await installBaseline(persistedState({ sshHosts: [target] }), {});
		mocks.sshCredentialClaimRetire.mockRejectedValueOnce(
			new Error("registry unavailable"),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			removeAgentProjectionDurably({
				agents: [],
				sshHosts: [
					{
						hostId: target.id,
						applies: (candidate) =>
							candidate.registrationGeneration ===
							target.registrationGeneration,
					},
				],
			}),
		).resolves.toBe(true);

		expect(readDurableState().sshHosts).toEqual([]);
	});

	it("retries a failed mounted projection after the durable commit", async () => {
		const target = localProject("project-remove", "/repo/remove");
		const baseline = persistedState({
			projects: [target],
			layouts: {
				[spaceId]: layout({ [`git:${target.id}`]: {} }),
			},
		});
		await installBaseline(baseline, {});
		let attempts = 0;
		const project = vi.fn(() => {
			attempts += 1;
			return attempts > 1;
		});
		const stopProjection = subscribeDurableStoreLayoutProjection(
			spaceId,
			project,
			() => true,
		);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			await expect(
				removeAgentProjectionDurably({
					agents: [],
					projects: [
						{
							projectId: target.id,
							panelIds: [`git:${target.id}`],
							applies: (project) => project.path === target.path,
						},
					],
				}),
			).resolves.toBe(true);
		} finally {
			stopProjection();
		}

		expect(project).toHaveBeenCalledTimes(2);
		expect(warning).toHaveBeenCalledWith(
			"Failed to project durable app state; retrying",
			expect.any(Error),
		);
	});

	it("retains a newly discovered failed desktop across projection retry", async () => {
		const target = localProject("project-remove", "/repo/remove");
		const baseline = persistedState({
			spaces: [
				{ id: spaceId, name: "Main" },
				{ id: collisionSpaceId, name: "Other" },
			],
			projects: [target],
			layouts: {
				[spaceId]: layout({ [`git:${target.id}`]: {} }),
				[collisionSpaceId]: layout(),
			},
		});
		await installBaseline(baseline, {});
		useStore.getState().layouts[collisionSpaceId] = addPanel(
			baseline.layouts[collisionSpaceId],
			"file:stale",
		);
		const project = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
		const stopProjection = subscribeDurableStoreLayoutProjection(
			collisionSpaceId,
			project,
			() => true,
		);

		try {
			await expect(
				removeAgentProjectionDurably({
					agents: [],
					projects: [
						{
							projectId: target.id,
							panelIds: [`git:${target.id}`],
							applies: (project) => project.path === target.path,
						},
					],
				}),
			).resolves.toBe(true);
		} finally {
			stopProjection();
		}

		expect(project).toHaveBeenCalledTimes(2);
	});

	it("does not let a stale mounted layout resurrect a committed removal after projection fails", async () => {
		const target = localProject("project-remove", "/repo/remove");
		const baseline = persistedState({
			projects: [target],
			layouts: {
				[spaceId]: layout({ [`git:${target.id}`]: {} }),
			},
		});
		await installBaseline(baseline, {});
		const project = vi.fn(() => false);
		const stopProjection = subscribeDurableStoreLayoutProjection(
			spaceId,
			project,
			() => true,
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const freezeProjectionAncestor = durableAppStorage.freezeProjectionAncestor.bind(
			durableAppStorage,
		);
		let releaseProjectionWrites: (() => void) | undefined;
		vi.spyOn(
			durableAppStorage,
			"freezeProjectionAncestor",
		).mockImplementation(() => {
			releaseProjectionWrites = freezeProjectionAncestor();
			return releaseProjectionWrites;
		});

		try {
			await expect(
				removeAgentProjectionDurably({
					agents: [],
					projects: [
						{
							projectId: target.id,
							panelIds: [`git:${target.id}`],
							applies: (project) => project.path === target.path,
						},
					],
				}),
			).resolves.toBe(true);
			stopProjection();
			useStore.getState().saveLayout(spaceId, baseline.layouts[spaceId]);
			await durableAppStorage.flush();

			expect(project).toHaveBeenCalledTimes(2);
			expect(mocks.reloadCurrentPage).toHaveBeenCalledOnce();
			expect(readDurableState().projects).toEqual([]);
			expect(panelIds(readDurableState())).toEqual([]);
		} finally {
			stopProjection();
			releaseProjectionWrites?.();
		}
	});

	it("projects a concurrent Agent pane and rejects Project removal before stopping the planned Agent", async () => {
		const target = localProject("project-remove", "/repo/remove");
		const planned = structuredAgent(
			"agent-planned",
			target.id,
			"session-planned",
			"local",
		);
		const newcomer = structuredAgent(
			"agent-concurrent",
			target.id,
			"session-concurrent",
			"local",
		);
		const projectPaneId = `git:${target.id}`;
		const plannedAgentPaneId = `agent:${planned.id}`;
		const agentPaneId = `agent:${newcomer.id}`;
		const baseline = persistedState({
			projects: [target],
			agents: [planned],
			layouts: {
				[spaceId]: layout({
					[projectPaneId]: {},
					[plannedAgentPaneId]: { component: "agent" },
				}),
			},
		});
		await installBaseline(baseline, {
			[planned.sessionId]: planned.worktreePath,
		});
		const plan = planProjectRemoval(target.id);
		const remote = secondRealm(baseline);
		await remote.publish({
			...baseline,
			agents: [planned, newcomer],
			layouts: {
				[spaceId]: layout({
					[projectPaneId]: {},
					[plannedAgentPaneId]: { component: "agent" },
					[agentPaneId]: { component: "agent" },
				}),
			},
		});
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: testDureBackendRouteAuthority(
				"dure-local",
				"generation-1",
			),
		});
		const project = vi.fn(() => true);
		const stopProjection = subscribeDurableStoreLayoutProjection(
			spaceId,
			project,
			() => true,
		);
		const transaction = vi.spyOn(durableAppStorage, "transact");

		try {
			await expect(executeProjectRemoval(plan)).rejects.toMatchObject({
				code: "pane_changed",
			});
		} finally {
			stopProjection();
		}

		expect(mocks.stopRuntime).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		expect(project).toHaveBeenCalledOnce();
		expect(readDurableState().agents).toEqual([planned, newcomer]);
		expect(useStore.getState().agents).toEqual([planned, newcomer]);
		expect(panelIds(readDurableState())).toEqual(
			[projectPaneId, plannedAgentPaneId, agentPaneId].sort(),
		);
	});

	it("rejects Host removal when a new owned pane appears after consent", async () => {
		const targetHost = host("host-remove", "backend.example.test");
		const survivorHost = host("host-survive", "survivor.example.test");
		const targetProject = remoteProject(
			"project-remove",
			"/srv/remove",
			targetHost.id,
		);
		const survivorProject = remoteProject(
			"project-survive",
			"/srv/survive",
			survivorHost.id,
		);
		const concurrentProject = remoteProject(
			"project-concurrent",
			"/srv/concurrent",
			survivorHost.id,
		);
		const doomed = structuredAgent(
			"agent-doomed",
			targetProject.id,
			"session-doomed",
			targetHost.id,
		);
		const source = structuredAgent(
			"agent-source",
			targetProject.id,
			"session-shared",
			targetHost.id,
		);
		const successor: Agent = {
			...source,
			projectId: survivorProject.id,
			worktreePath: "/srv/survive/.worktrees/successor",
			branch: "successor",
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: survivorHost.id,
				interactionSessionId: "interaction-successor",
			},
		};
		const baseline = persistedState({
			spaces: [
				{ id: spaceId, name: "Main" },
				{ id: collisionSpaceId, name: "Collision" },
			],
			sshHosts: [targetHost, survivorHost],
			projects: [targetProject, survivorProject],
			pinnedProjects: [targetProject.id, survivorProject.id],
			agents: [doomed, source],
			layouts: {
				[spaceId]: layout({
					[`git:${targetProject.id}`]: {},
					[`agent:${doomed.id}`]: { component: "agent" },
					[`agent:${source.id}`]: { component: "agent" },
					"ssh:loose": {
						sessionId: "session-loose",
						binding: remoteHmuxStandaloneBinding(
							"session-loose",
							targetProject.id,
							targetHost.id,
							"bridge-loose",
						),
					},
					"ssh:keep": {
						hostId: survivorHost.id,
						sessionId: "session-keep",
					},
				}),
				[collisionSpaceId]: layout({
					"ssh:loose": {
						hostId: survivorHost.id,
						sessionId: "session-collision",
					},
				}),
			},
			pinnedPanes: {
				[`${spaceId}:git:${targetProject.id}`]: true,
				[`${spaceId}:agent:${doomed.id}`]: true,
				[`${spaceId}:agent:${source.id}`]: true,
				[`${spaceId}:ssh:loose`]: true,
				[`${spaceId}:ssh:keep`]: true,
				[`${collisionSpaceId}:ssh:loose`]: true,
			},
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: "/srv/remove/doomed",
			[source.sessionId]: "/srv/remove/source",
			"session-loose": "/srv/remove",
			"session-concurrent": "/srv/remove/concurrent",
			"session-collision": "/srv/keep/collision",
			"session-keep": "/srv/keep",
		});
		const remote = secondRealm(baseline);
		const updatedSurvivorHost = {
			...survivorHost,
			name: "Survivor updated elsewhere",
		};
		const concurrentState = {
			...baseline,
			sshHosts: [targetHost, updatedSurvivorHost],
			projects: [targetProject, survivorProject, concurrentProject],
			pinnedProjects: [
				targetProject.id,
				survivorProject.id,
				concurrentProject.id,
			],
			agents: [doomed, successor],
			layouts: {
				...baseline.layouts,
				[spaceId]: addPanel(
					addPanel(baseline.layouts[spaceId], "file:concurrent"),
					"ssh:concurrent",
					{
						hostId: targetHost.id,
						sessionId: "session-concurrent",
					},
				),
			},
			pinnedPanes: {
				...baseline.pinnedPanes,
				[`${spaceId}:ssh:concurrent`]: true,
			},
		};
		const route = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-1",
			targetHost.id,
		);
		mocks.inspectRuntime.mockImplementation(async (agentId: string) =>
			agentId === doomed.id
				? { state: "unmanaged" }
				: { state: "stable", routeAuthority: route },
		);
		mocks.stopRuntime.mockImplementation(async (agentId: string) => {
			if (agentId === source.id) await remote.publish(concurrentState);
		});
		const projectedPanels: string[][] = [];
		const stopProjection = subscribeDurableStoreLayoutProjection(
			spaceId,
			() => {
				projectedPanels.push(
					panelsFromLayout(useStore.getState().layouts[spaceId])
						.map((panel) => panel.id)
						.sort(),
				);
				return true;
			},
			() => true,
		);
		const transaction = vi.spyOn(durableAppStorage, "transact");

		try {
			await expect(
				removeSshHostWithResources(targetHost.id),
			).rejects.toMatchObject({ code: "pane_changed" });
		} finally {
			stopProjection();
		}
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(final.sshHosts).toEqual([targetHost, updatedSurvivorHost]);
		expect(final.projects).toEqual([
			targetProject,
			survivorProject,
			concurrentProject,
		]);
		expect(final.pinnedProjects).toEqual([
			targetProject.id,
			survivorProject.id,
			concurrentProject.id,
		]);
		expect(final.agents).toEqual([doomed, successor]);
		expect(panelIds(final)).toEqual(
			[
				`git:${targetProject.id}`,
				`agent:${doomed.id}`,
				`agent:${successor.id}`,
				"file:concurrent",
				"ssh:loose",
				"ssh:keep",
				"ssh:concurrent",
			].sort(),
		);
		expect(
			panelsFromLayout(final.layouts[collisionSpaceId]).map((panel) => panel.id),
		).toEqual(["ssh:loose"]);
		expect(final.pinnedPanes).toEqual({
			[`${spaceId}:git:${targetProject.id}`]: true,
			[`${spaceId}:agent:${doomed.id}`]: true,
			[`${spaceId}:agent:${successor.id}`]: true,
			[`${spaceId}:ssh:loose`]: true,
			[`${spaceId}:ssh:keep`]: true,
			[`${spaceId}:ssh:concurrent`]: true,
			[`${collisionSpaceId}:ssh:loose`]: true,
		});
		expect(projectedPanels).toEqual([
			[
				`git:${targetProject.id}`,
				`agent:${doomed.id}`,
				`agent:${successor.id}`,
				"file:concurrent",
				"ssh:loose",
				"ssh:keep",
				"ssh:concurrent",
			].sort(),
		]);
		expect(mocks.removeMountedPanels).not.toHaveBeenCalled();
		expect(mocks.removeLegacyPanels).not.toHaveBeenCalled();
		expect(mocks.publishLayoutPush).not.toHaveBeenCalled();
		});

	it("removes only the frozen pane occurrence when panel ids collide across spaces", async () => {
		const targetHost = host("host-remove", "backend.example.test");
		const survivorHost = host("host-survive", "survivor.example.test");
		const panelId = "ssh:shared";
		const baseline = persistedState({
			spaces: [
				{ id: spaceId, name: "Main" },
				{ id: collisionSpaceId, name: "Collision" },
			],
			sshHosts: [targetHost, survivorHost],
			layouts: {
				[spaceId]: layout({
					[panelId]: {
						binding: remoteHmuxStandaloneBinding(
							"session-remove",
							"workspace-remove",
							targetHost.id,
							"bridge-remove",
						),
					},
				}),
				[collisionSpaceId]: layout({
					[panelId]: { hostId: survivorHost.id, sessionId: "session-keep" },
				}),
			},
			pinnedPanes: {
				[`${spaceId}:${panelId}`]: true,
				[`${collisionSpaceId}:${panelId}`]: true,
			},
		});
		await installBaseline(baseline, {
			"session-remove": "/srv/remove",
			"session-keep": "/srv/keep",
		});

		await expect(removeSshHostWithResources(targetHost.id)).resolves.toBeDefined();
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(final.sshHosts).toEqual([survivorHost]);
		expect(panelsFromLayout(final.layouts[spaceId])).toEqual([]);
		expect(
			panelsFromLayout(final.layouts[collisionSpaceId]).map((pane) => pane.id),
		).toEqual([panelId]);
		expect(final.pinnedPanes).toEqual({
			[`${collisionSpaceId}:${panelId}`]: true,
		});
	});

	it("removes an owned pane from a durable layout whose Space record is absent", async () => {
		const targetHost = host("host-remove", "backend.example.test");
		const orphanSpaceId = "desk-orphan-layout";
		const panelId = "ssh:orphan";
		const baseline = persistedState({
			sshHosts: [targetHost],
			layouts: {
				[orphanSpaceId]: layout({
					[panelId]: { hostId: targetHost.id, sessionId: "session-orphan" },
				}),
			},
			pinnedPanes: { [`${orphanSpaceId}:${panelId}`]: true },
		});
		await installBaseline(baseline, { "session-orphan": "/srv/orphan" });

		await expect(removeSshHostWithResources(targetHost.id)).resolves.toBeDefined();
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(final.sshHosts).toEqual([]);
		expect(panelsFromLayout(final.layouts[orphanSpaceId])).toEqual([]);
		expect(final.pinnedPanes).toEqual({});
	});

	it("rejects a same-location pane successor created after consent", async () => {
		const targetHost = host("host-remove", "backend.example.test");
		const project = remoteProject(
			"project-remove",
			"/srv/source",
			targetHost.id,
		);
		const agent = structuredAgent(
			"agent-doomed",
			project.id,
			"session-doomed",
			targetHost.id,
		);
		const panelId = "ssh:replaceable";
		const baseline = persistedState({
			sshHosts: [targetHost],
			projects: [project],
			agents: [agent],
			layouts: {
				[spaceId]: layout({
					[panelId]: { hostId: targetHost.id, sessionId: "session-source" },
				}),
			},
		});
		await installBaseline(baseline, {
			[agent.sessionId]: agent.worktreePath,
		});
		const plan = planSshHostRemoval(targetHost.id);
		const successor = {
			...baseline,
			layouts: {
				[spaceId]: layout({
					[panelId]: { hostId: targetHost.id, sessionId: "session-successor" },
				}),
			},
		};
		await secondRealm(baseline).publish(successor);
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: testDureBackendRouteAuthority(
				"dure-remote",
				"generation-1",
				targetHost.id,
			),
		});
		const projectDurableSuccessor = vi.fn(() => true);
		const stopProjection = subscribeDurableStoreLayoutProjection(
			spaceId,
			projectDurableSuccessor,
			() => true,
		);

		try {
			await expect(executeSshHostRemoval(plan)).rejects.toMatchObject({
				code: "pane_changed",
			});
		} finally {
			stopProjection();
		}

		expect(mocks.stopRuntime).not.toHaveBeenCalled();
		expect(projectDurableSuccessor).toHaveBeenCalledOnce();
		expect(readDurableState().sshHosts).toEqual([targetHost]);
		expect(
			panelsFromLayout(readDurableState().layouts[spaceId])[0]?.params,
		).toEqual({ hostId: targetHost.id, sessionId: "session-successor" });
	});

	it("rejects a live Host-pane successor before stopping any Agent", async () => {
		const targetHost = host("host-remove", "backend.example.test");
		const project = remoteProject(
			"project-remove",
			"/srv/source",
			targetHost.id,
		);
		const agent = structuredAgent(
			"agent-doomed",
			project.id,
			"session-doomed",
			targetHost.id,
		);
		const panelId = "ssh:replaceable";
		const baseline = persistedState({
			sshHosts: [targetHost],
			projects: [project],
			agents: [agent],
			layouts: {
				[spaceId]: layout({
					[panelId]: {
						hostId: targetHost.id,
						sessionId: "session-source",
					},
				}),
			},
		});
		await installBaseline(baseline, {
			[agent.sessionId]: agent.worktreePath,
		});
		const plan = planSshHostRemoval(targetHost.id);
		useStore.setState({
			layouts: {
				...useStore.getState().layouts,
				[spaceId]: layout({
					[panelId]: {
						hostId: targetHost.id,
						sessionId: "session-successor",
					},
				}),
			},
		});
		const transaction = vi.spyOn(durableAppStorage, "transact");

		await expect(executeSshHostRemoval(plan)).rejects.toMatchObject({
			code: "pane_changed",
		});

		expect(mocks.stopRuntime).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

		it("does not let armed Host consent target a same-ID successor", async () => {
			const source = host("host-remove", "source.example.test");
			const successor = { ...source, host: "successor.example.test" };
			const baseline = persistedState({ sshHosts: [source] });
			await installBaseline(baseline, {});
			const plan = planSshHostRemoval(source.id);
			useStore.setState({ sshHosts: [successor] });

			await expect(executeSshHostRemoval(plan)).rejects.toMatchObject({
				code: "pane_changed",
			});

			expect(mocks.stopRuntime).not.toHaveBeenCalled();
			expect(readDurableState().sshHosts).toEqual([successor]);
			expect(useStore.getState().sshHosts).toEqual([successor]);
		});

		it("does not let armed consent delete an identical re-registered Host", async () => {
			const source = {
				...host("host-remove", "source.example.test"),
				sshConfigAlias: "source",
				registrationGeneration: "host-generation-source",
			};
			const successor = {
				...source,
				registrationGeneration: "host-generation-successor",
			};
			const baseline = persistedState({ sshHosts: [source] });
			await installBaseline(baseline, {});
			const plan = planSshHostRemoval(source.id);
			await secondRealm(baseline).publish({
				...baseline,
				sshHosts: [successor],
			});

			await expect(executeSshHostRemoval(plan)).rejects.toMatchObject({
				code: "pane_changed",
			});

			expect(mocks.stopRuntime).not.toHaveBeenCalled();
			expect(readDurableState().sshHosts).toEqual([successor]);
		});

		it("preserves an SSH Host successor committed before exact descendant cleanup", async () => {
		const sourceHost = host("host-remove", "backend.example.test");
		const successor = { ...sourceHost, host: "successor.example.test" };
		const sourceProject = remoteProject(
			"project-remove",
			"/srv/source",
			sourceHost.id,
		);
		const doomed = structuredAgent(
			"agent-doomed",
			sourceProject.id,
			"session-doomed",
			sourceHost.id,
		);
		const baseline = persistedState({
			sshHosts: [sourceHost],
			projects: [sourceProject],
			agents: [doomed],
			layouts: {
				[spaceId]: layout({
					[`git:${sourceProject.id}`]: {},
					[`agent:${doomed.id}`]: { component: "agent" },
				}),
			},
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: doomed.worktreePath,
		});
		const remote = secondRealm(baseline);
		const route = testDureBackendRouteAuthority(
			sourceHost.id,
			"generation-1",
			sourceHost.id,
		);
		mocks.inspectRuntime.mockResolvedValue({ state: "stable", routeAuthority: route });
		mocks.stopRuntime.mockImplementationOnce(async () => {
			await remote.publish({ ...baseline, sshHosts: [successor] });
		});

		await expect(removeSshHostWithResources(sourceHost.id)).resolves.toBeDefined();
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(final.sshHosts).toEqual([successor]);
		expect(final.projects).toEqual([]);
		expect(final.agents).toEqual([]);
		expect(panelIds(final)).toEqual([]);
	});

	it("preserves a new Project subtree owned by an SSH Host successor", async () => {
		const sourceHost = host("host-remove", "backend.example.test");
		const successorHost = {
			...sourceHost,
			host: "successor.example.test",
		};
		const sourceProject = remoteProject(
			"project-remove",
			"/srv/source",
			sourceHost.id,
		);
		const newProject = remoteProject(
			"project-new",
			"/srv/new",
			sourceHost.id,
		);
		const doomed = structuredAgent(
			"agent-doomed",
			sourceProject.id,
			"session-doomed",
			sourceHost.id,
		);
		const newcomer = structuredAgent(
			"agent-new",
			newProject.id,
			"session-new",
			sourceHost.id,
		);
		const baseline = persistedState({
			sshHosts: [sourceHost],
			projects: [sourceProject],
			agents: [doomed],
			layouts: {
				[spaceId]: layout({
					[`git:${sourceProject.id}`]: {},
					[`agent:${doomed.id}`]: { component: "agent" },
				}),
			},
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: doomed.worktreePath,
			[newcomer.sessionId]: newcomer.worktreePath,
		});
		const remote = secondRealm(baseline);
		const route = testDureBackendRouteAuthority(
			sourceHost.id,
			"generation-1",
			sourceHost.id,
		);
		mocks.inspectRuntime.mockResolvedValue({ state: "stable", routeAuthority: route });
		mocks.stopRuntime.mockImplementationOnce(async () => {
			await remote.publish({
				...baseline,
				sshHosts: [successorHost],
				projects: [sourceProject, newProject],
				agents: [doomed, newcomer],
				layouts: {
					[spaceId]: addPanel(
						addPanel(baseline.layouts[spaceId], `git:${newProject.id}`),
						`agent:${newcomer.id}`,
						{ component: "agent" },
					),
				},
			});
		});

		await expect(
			removeSshHostWithResources(sourceHost.id),
		).resolves.toBeDefined();
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(final.sshHosts).toEqual([successorHost]);
		expect(final.projects).toEqual([newProject]);
		expect(final.agents).toEqual([newcomer]);
		expect(panelIds(final)).toEqual(
			[`git:${newProject.id}`, `agent:${newcomer.id}`].sort(),
		);
	});

	it("does not orphan a new Agent under an exact Project removed from a Host successor", async () => {
		const sourceHost = host("host-remove", "backend.example.test");
		const successorHost = {
			...sourceHost,
			host: "successor.example.test",
		};
		const sourceProject = remoteProject(
			"project-remove",
			"/srv/source",
			sourceHost.id,
		);
		const doomed = structuredAgent(
			"agent-doomed",
			sourceProject.id,
			"session-doomed",
			sourceHost.id,
		);
		const newcomer = structuredAgent(
			"agent-new",
			sourceProject.id,
			"session-new",
			sourceHost.id,
		);
		const baseline = persistedState({
			sshHosts: [sourceHost],
			projects: [sourceProject],
			agents: [doomed],
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: doomed.worktreePath,
			[newcomer.sessionId]: newcomer.worktreePath,
		});
		const remote = secondRealm(baseline);
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: testDureBackendRouteAuthority(
				sourceHost.id,
				"generation-1",
				sourceHost.id,
			),
		});
		mocks.stopRuntime.mockImplementationOnce(async () => {
			await remote.publish({
				...baseline,
				sshHosts: [successorHost],
				agents: [doomed, newcomer],
			});
		});

		await expect(removeSshHostWithResources(sourceHost.id)).rejects.toMatchObject({
			code: "pane_changed",
		});
		await durableAppStorage.flush();

		expect(readDurableState().sshHosts).toEqual([successorHost]);
		expect(readDurableState().projects).toEqual([sourceProject]);
		expect(readDurableState().agents).toEqual([doomed, newcomer]);
	});

	it("does not delete a Host directly referenced by an incompatible Agent", async () => {
		const sourceHost = host("host-remove", "backend.example.test");
		const projectHost = host("host-project", "project.example.test");
		const sourceProject = remoteProject(
			"project-remote",
			"/srv/repo",
			projectHost.id,
		);
		const direct = withSshRuntime(
			{
				...structuredAgent(
					"agent-direct",
					sourceProject.id,
					"session-direct",
					sourceHost.id,
				),
				canonicalSpawn: {
					schemaVersion: 1 as const,
					backendProfileId: sourceHost.id,
					operationId: "spawn-direct",
				},
				sessionKind: "ssh" as const,
				worktreePath: "/srv/repo/.worktrees/agent-direct",
			},
			sourceHost.id,
		);
		const baseline = persistedState({
			sshHosts: [sourceHost, projectHost],
			projects: [sourceProject],
			agents: [direct],
			layouts: {
				[spaceId]: layout({ [`agent:${direct.id}`]: { component: "agent" } }),
			},
		});
		await installBaseline(baseline, {
			[direct.sessionId]: direct.worktreePath,
		});
		mocks.inspectCanonicalStop.mockResolvedValue({
			receipt: null,
			routeAuthority: testDureBackendRouteAuthority(
				sourceHost.id,
				"generation-1",
				sourceHost.id,
			),
		});
		const transaction = vi.spyOn(durableAppStorage, "transact");

		await expect(removeSshHostWithResources(sourceHost.id)).rejects.toThrow(
			"client_backend_host_mismatch: backend route and project SSH host disagree",
		);
		await durableAppStorage.flush();

		expect(mocks.createCanonicalStopClient).toHaveBeenCalledWith({
			profileId: sourceHost.id,
		});
		expect(mocks.inspectCanonicalStop).toHaveBeenCalledWith("spawn-direct");
		expect(mocks.stopRuntime).not.toHaveBeenCalled();
		expect(mocks.previewCanonicalStop).not.toHaveBeenCalled();
		expect(mocks.applyCanonicalStop).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		const final = readDurableState();
		expect(final.sshHosts).toEqual([sourceHost, projectHost]);
		expect(final.projects).toEqual([sourceProject]);
		expect(final.agents).toHaveLength(1);
		expect(final.agents[0]).toMatchObject({
			id: direct.id,
			runtimeBinding: direct.runtimeBinding,
		});
		expect(panelIds(final)).toEqual([`agent:${direct.id}`]);
	});

	it("rejects a direct Host Agent introduced beneath a preserved Project", async () => {
		const sourceHost = host("host-remove", "backend.example.test");
		const sourceProject = remoteProject(
			"project-remove",
			"/srv/source",
			sourceHost.id,
		);
		const successorProject = localProject(sourceProject.id, "/repo/successor");
		const doomed = structuredAgent(
			"agent-doomed",
			sourceProject.id,
			"session-doomed",
			sourceHost.id,
		);
		const newcomer = withSshRuntime(
			structuredAgent(
				"agent-new",
				sourceProject.id,
				"session-new",
				sourceHost.id,
			),
			sourceHost.id,
		);
		const baseline = persistedState({
			sshHosts: [sourceHost],
			projects: [sourceProject],
			agents: [doomed],
		});
		await installBaseline(baseline, {
			[doomed.sessionId]: doomed.worktreePath,
			[newcomer.sessionId]: newcomer.worktreePath,
		});
		const remote = secondRealm(baseline);
		mocks.inspectRuntime.mockResolvedValue({
			state: "stable",
			routeAuthority: testDureBackendRouteAuthority(
				sourceHost.id,
				"generation-1",
				sourceHost.id,
			),
		});
		mocks.stopRuntime.mockImplementationOnce(async () => {
			await remote.publish({
				...baseline,
				projects: [successorProject],
				agents: [doomed, newcomer],
			});
		});

		await expect(removeSshHostWithResources(sourceHost.id)).rejects.toMatchObject({
			code: "pane_changed",
		});
		await durableAppStorage.flush();

		expect(readDurableState().sshHosts).toEqual([sourceHost]);
		expect(readDurableState().projects).toEqual([successorProject]);
		expect(readDurableState().agents).toEqual([doomed, newcomer]);
	});

	it("rejects an unresolved forward Host binding before destructive effects", async () => {
		const sourceHost = host("host-remove", "backend.example.test");
		const panelId = "ssh:future";
		const baseline = persistedState({
			sshHosts: [sourceHost],
			layouts: {
				[spaceId]: layout({
					[panelId]: {
						hostId: sourceHost.id,
						binding: {
							schemaVersion: 2,
							runtime: "hmux_standalone_v1",
							source: "ssh",
							hostId: sourceHost.id,
							sessionId: "session-future",
							workspaceId: "workspace-future",
						},
					},
				}),
			},
		});
		await installBaseline(baseline, {});
		expect(() => planSshHostRemoval(sourceHost.id)).not.toThrow();

		await expect(
			removeSshHostWithResources(sourceHost.id),
		).rejects.toMatchObject({ code: "pane_changed" });
		await durableAppStorage.flush();

		expect(mocks.stopRuntime).not.toHaveBeenCalled();
		expect(readDurableState().sshHosts).toEqual([sourceHost]);
		expect(panelIds(readDurableState())).toEqual([panelId]);
	});

	it("does not orphan a Project successor beneath an exact SSH Host removal", async () => {
		const sourceHost = host("host-remove", "backend.example.test");
		const sourceProject = remoteProject(
			"project-remove",
			"/srv/source",
			sourceHost.id,
		);
		const successor = { ...sourceProject, path: "/srv/successor" };
		const projectPaneId = `git:${sourceProject.id}`;
		const baseline = persistedState({
			sshHosts: [sourceHost],
			projects: [sourceProject],
			layouts: { [spaceId]: layout({ [projectPaneId]: {} }) },
		});
		await installBaseline(baseline, {});
		const remote = secondRealm(baseline);
		await remote.publish({ ...baseline, projects: [successor] });

		await expect(removeSshHostWithResources(sourceHost.id)).rejects.toMatchObject({
			code: "pane_changed",
		});
		await durableAppStorage.flush();

		const final = readDurableState();
		expect(final.sshHosts).toEqual([sourceHost]);
		expect(final.projects).toEqual([successor]);
		expect(panelIds(final)).toEqual([projectPaneId]);
	});
});
