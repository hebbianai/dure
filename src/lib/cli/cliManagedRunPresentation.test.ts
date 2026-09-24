import { describe, expect, it, vi } from "vitest";
import {
	type CliManagedRunPresentationDependencies,
	handleCliManagedRunPresentation,
	presentManagedRun,
} from "@/lib/cli/cliManagedRunPresentation";
import {
	CliManagedRunPresentationError,
	type CliManagedRunPresentationRequest,
	type CliManagedRunPresentationState,
	parseCliManagedRunPresentationRequest,
	projectManagedRunPresentationAgent,
	requireManagedRunPresentationGeneration,
} from "@/lib/cli/managedRunPresentationModel";
import { refreshManagedRunProjection } from "@/lib/cli/refreshManagedRunProjection";
import type { DureAgentRuntimeProjectionInspectResultV1 } from "@/lib/ipc/dureAgentRuntime";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "HebbianIDE",
	path: "/workspace/dure",
	kind: "local",
	isRepo: true,
};

const request: CliManagedRunPresentationRequest = {
	schemaVersion: 1,
	runtime: "hmux_managed_v1",
	source: "local",
	hostId: "local",
	backendProfileId: "local-primary",
	operationId: "spawn-operation-1",
	agentId: "agent-1",
	agentName: "codex-feature",
	projectId: "dure-internal",
	projectPath: project.path,
	providerId: "codex",
	executionProfile: { kind: "provider_default" },
	preparedSessionId: "session-operation-1",
	sessionId: "session-operation-1",
	launchIdempotencyKey: "spawn-runtime:spawn-operation-1",
	workspaceId: "workspace-1",
	providerConversationRef: null,
	worktree: { kind: "project_root" },
	generation: {
		runnerPrincipal: "runner-principal",
		runnerInstance: "runner-instance",
		channelEpoch: "1",
		hostInstanceId: "host-instance",
		terminalEpoch: "terminal-epoch",
	},
	permissionMode: "default",
	spaceId: "space-1",
	windowLabel: "main",
	referencePanelId: "agent:source",
};

function binding() {
	return {
		...hmuxManagedBinding(
			request.sessionId,
			request.workspaceId,
			undefined,
			undefined,
			request.generation,
			request.backendProfileId,
		),
		createIdempotencyKey: `spawn-runtime:${request.operationId}`,
	};
}

function state(agents: Agent[] = []): CliManagedRunPresentationState {
	return {
		agents,
		projects: [project],
		sshHosts: [],
		spaces: [{ id: "space-1", name: "Build" }],
		agentActivity: {},
		sessionCwd: {},
		stats: {
			agentsStarted: 3,
			prsCreated: 0,
			activeMs: 0,
			since: 1,
		},
	};
}

function applyPatch(
	current: CliManagedRunPresentationState,
	patch: Partial<CliManagedRunPresentationState>,
) {
	return { ...current, ...patch };
}

describe("managed Run presentation request", () => {
	it("accepts only one exact non-secret managed runtime identity", () => {
		expect(parseCliManagedRunPresentationRequest({ ...request })).toEqual(
			request,
		);
		expect(
			parseCliManagedRunPresentationRequest({
				...request,
				permissionMode: "auto_edit",
			}).permissionMode,
		).toBe("auto_edit");

		for (const invalid of [
			{ ...request, unexpected: true },
			{ ...request, backendProfileId: "SSH-Team" },
			{ ...request, operationId: `a${"b".repeat(160)}` },
			{ ...request, source: "local", hostId: "ssh-1" },
			{ ...request, source: "ssh", hostId: "ssh-1" },
			{
				...request,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-work",
				},
			},
			{
				...request,
				worktree: {
					kind: "dedicated",
					branch: "agent/feature-x",
					directoryName: "another-directory",
				},
			},
		]) {
			expect(() => parseCliManagedRunPresentationRequest(invalid)).toThrow(
				CliManagedRunPresentationError,
			);
		}
	});

	it("preserves only canonical path-shaped provider conversation identities", () => {
		const providerConversationRef = "threads/2026-08-30:turn_1";

		expect(
			parseCliManagedRunPresentationRequest({
				...request,
				providerConversationRef,
			}).providerConversationRef,
		).toBe(providerConversationRef);

		for (const invalid of ["conversation+alias", `/${"a".repeat(160)}`]) {
			expect(() =>
				parseCliManagedRunPresentationRequest({
					...request,
					providerConversationRef: invalid,
				}),
			).toThrow(CliManagedRunPresentationError);
		}
	});

	it("rejects a replacement Host generation", () => {
		expect(() =>
			requireManagedRunPresentationGeneration(
				{ ...request.generation, terminalEpoch: "replacement-epoch" },
				request.generation,
			),
		).toThrow("generation changed");
	});

	it("restores only a prepared legacy create key and rejects successor/root mismatches", () => {
		expect(
			parseCliManagedRunPresentationRequest({
				...request,
				preparedSessionId: undefined,
				launchIdempotencyKey: undefined,
			}),
		).toMatchObject({
			preparedSessionId: request.preparedSessionId,
			launchIdempotencyKey: `spawn-runtime:${request.operationId}`,
		});
		for (const invalid of [
			{
				...request,
				sessionId: "session-successor",
				launchIdempotencyKey: undefined,
			},
			{
				...request,
				sessionId: "session-successor",
				launchIdempotencyKey: `spawn-runtime:${request.operationId}`,
			},
		]) {
			expect(() => parseCliManagedRunPresentationRequest(invalid)).toThrow(
				CliManagedRunPresentationError,
			);
		}
	});
});

describe("managed Run Agent projection", () => {
	it("creates one projection and reuses it without a second writer", () => {
		const initial = state();
		const created = projectManagedRunPresentationAgent(
			initial,
			request,
			project,
			binding(),
		);
		expect(created).toMatchObject({
			outcome: "created",
			agent: {
				id: request.agentId,
				canonicalSpawn: {
					schemaVersion: 1,
					backendProfileId: request.backendProfileId,
					operationId: request.operationId,
				},
				provider: request.providerId,
				started: true,
				executionProfile: { kind: "provider_default" },
				runtimeBinding: {
					runtime: "hmux_managed_v1",
					createIdempotencyKey: `spawn-runtime:${request.operationId}`,
					stopFence: { hostInstanceId: "host-instance" },
				},
			},
			patch: {
				agentActivity: { [request.agentId]: "connecting" },
				sessionCwd: { [request.sessionId]: project.path },
				stats: { agentsStarted: 4 },
			},
		});

		const once = applyPatch(initial, created.patch);
		const reused = projectManagedRunPresentationAgent(
			once,
			request,
			project,
			binding(),
		);
		expect(reused.outcome).toBe("reused");
		expect(reused.agent.canonicalSpawn).toEqual(created.agent.canonicalSpawn);
		expect(reused.patch.agents).toHaveLength(1);
		expect(reused.patch.stats).toBeUndefined();
	});

	it("projects a dedicated workspace from the durable lease directory", () => {
		const dedicated = {
			...request,
			worktree: {
				kind: "dedicated" as const,
				branch: "agent/feature-x",
				directoryName: "feature-x",
			},
		};

		const projected = projectManagedRunPresentationAgent(
			state(),
			dedicated,
			project,
			binding(),
		);

		expect(projected.agent).toMatchObject({
			worktreePath: "/workspace/dure/.worktrees/feature-x",
			branch: "agent/feature-x",
		});
		expect(projected.patch.sessionCwd).toEqual({
			[request.sessionId]: "/workspace/dure/.worktrees/feature-x",
		});
	});

	it("refuses duplicate owners and name conflicts", () => {
		const projected = projectManagedRunPresentationAgent(
			state(),
			request,
			project,
			binding(),
		).agent;
		const duplicateRuntime = {
			...projected,
			id: "agent-2",
			name: "other",
		};
		expect(() =>
			projectManagedRunPresentationAgent(
				state([projected, duplicateRuntime]),
				request,
				project,
				binding(),
			),
		).toThrow("multiple Agent projections");

		const nameOwner = {
			...projected,
			id: "agent-other",
			sessionId: "session-other",
			runtimeBinding: {
				...binding(),
				sessionId: "session-other",
			},
		};
		expect(() =>
			projectManagedRunPresentationAgent(
				state([nameOwner]),
				request,
				project,
				binding(),
			),
		).toThrow("name is already in use");
	});

	it("reopens a Run after the exact Host learns or continues its conversation", () => {
		const created = projectManagedRunPresentationAgent(
			state(),
			request,
			project,
			binding(),
		).agent;
		const identity = {
			schemaVersion: 1 as const,
			...request.generation,
			sessionId: request.sessionId,
			workspaceId: request.workspaceId,
			providerId: request.providerId,
			conversationId: "continued-conversation",
			revision: "2",
			observedThroughOutputSeq: "5",
			source: "provider_event" as const,
		};
		const existing: Agent = {
			...created,
			conversationId: identity.conversationId,
			runtimeBinding: { ...binding(), conversationIdentity: identity },
		};
		const reopened = projectManagedRunPresentationAgent(
			state([existing]),
			request,
			project,
			binding(),
		);
		expect(reopened.agent.conversationId).toBe(identity.conversationId);
		expect(reopened.agent.runtimeBinding).toMatchObject({
			conversationIdentity: identity,
		});
		expect(() =>
			projectManagedRunPresentationAgent(
				state([
					{
						...existing,
						runtimeBinding: {
							...binding(),
							conversationIdentity: { ...identity, terminalEpoch: "stale" },
						},
					},
				]),
				request,
				project,
				binding(),
			),
		).toThrow("canonical Agent identity");
	});

	it("refuses to reuse another canonical Agent on the same runtime", () => {
		const existing = projectManagedRunPresentationAgent(
			state(),
			request,
			project,
			binding(),
		).agent;
		const replacement = {
			...request,
			agentId: "agent-2",
			agentName: "codex-other",
		};

		expect(() =>
			projectManagedRunPresentationAgent(
				state([existing]),
				replacement,
				project,
				binding(),
			),
		).toThrow("canonical Agent identity");
	});

	it("backfills a legacy projection only from an exact canonical replay", () => {
		const { backendProfileId: _backendProfileId, ...legacyRequest } = request;
		const legacy = projectManagedRunPresentationAgent(
			state(),
			legacyRequest,
			project,
			binding(),
		);
		expect("canonicalSpawn" in legacy.agent).toBe(false);

		const backfilled = projectManagedRunPresentationAgent(
			state([legacy.agent]),
			request,
			project,
			binding(),
		);
		expect(backfilled.agent.canonicalSpawn).toEqual({
			schemaVersion: 1,
			backendProfileId: request.backendProfileId,
			operationId: request.operationId,
		});

		expect(() =>
			projectManagedRunPresentationAgent(
				state([backfilled.agent]),
				legacyRequest,
				project,
				binding(),
			),
		).toThrow("canonical Agent identity");
	});

	it("rejects another spawn on the same projected runtime", () => {
		const existing = projectManagedRunPresentationAgent(
			state(),
			request,
			project,
			binding(),
		).agent;

		expect(() =>
			projectManagedRunPresentationAgent(
				state([existing]),
				{ ...request, operationId: "spawn-operation-2" },
				project,
				binding(),
			),
		).toThrow("canonical Agent identity");
	});
});

function handlerFixture(referenceSpaceId = request.spaceId) {
	let current = state();
	const openAgent = vi.fn(() => "presented-pane");
	const waitForAttachment = vi.fn(async () => ({ state: "attached" }));
	const ensureProject = vi.fn(async () => project);
	const dependencies: CliManagedRunPresentationDependencies = {
		claim: vi.fn(async () => true),
		windowLabel: () => "main",
		readState: () => current,
		setState: (projectState) => {
			current = applyPatch(current, projectState(current));
		},
		ensureProject,
		inspectBinding: vi.fn(async () => binding()),
		resolveReference: vi.fn(async (panelId) => ({
			desktopId: referenceSpaceId,
			panelId,
		})),
		requestSpaceMount: vi.fn(),
		waitForSpace: vi.fn(async () => ({})),
		openAgent,
		waitForAttachment,
	};
	return {
		dependencies,
		ensureProject,
		openAgent,
		waitForAttachment,
		readState: () => current,
	};
}

describe("managed Run pane transaction", () => {
	it.each(["main", "win-popout-space-1"])(
		"leaves the claim to %s when another WebView receives the request first",
		async (targetWindow) => {
			const target = handlerFixture();
			const peer = handlerFixture();
			target.dependencies.windowLabel = () => targetWindow;
			peer.dependencies.windowLabel = () =>
				targetWindow === "main" ? "win-popout-other-space" : "main";
			if (targetWindow !== "main") {
				target.dependencies.setState((current) => ({
					spaces: current.spaces.map((space) => ({
						...space,
						kind: "popout" as const,
					})),
				}));
			}
			const claimedRequests = new Set<string>();
			const claim = async (reqId: string) => {
				if (claimedRequests.has(reqId)) return false;
				claimedRequests.add(reqId);
				return true;
			};
			target.dependencies.claim = vi.fn(claim);
			peer.dependencies.claim = vi.fn(claim);
			const params = { ...request, windowLabel: targetWindow };

			// Native cli:request delivery can reach every WebView. A faster peer
			// must not consume a succeeded Run's presentation or its exact replay.
			for (const [reqId, outcome] of [
				["request-first", "created"],
				["request-replay", "reused"],
			]) {
				expect(
					await handleCliManagedRunPresentation(
						params,
						reqId,
						peer.dependencies,
					),
				).toBeNull();
				expect(
					await handleCliManagedRunPresentation(
						params,
						reqId,
						target.dependencies,
					),
				).toMatchObject({
					ok: true,
					pane: {
						outcome,
						sessionId: request.sessionId,
						workspaceId: request.workspaceId,
					},
				});
			}
			expect(peer.dependencies.claim).not.toHaveBeenCalled();
			expect(peer.dependencies.inspectBinding).not.toHaveBeenCalled();
			expect(peer.openAgent).not.toHaveBeenCalled();
			expect(peer.readState().agents).toEqual([]);
			expect(target.dependencies.claim).toHaveBeenCalledTimes(2);
			expect(target.readState().agents).toHaveLength(1);
			expect(target.readState().stats.agentsStarted).toBe(4);
		},
	);

	it("lets only main claim malformed requests and return the typed refusal", async () => {
		const main = handlerFixture();
		const peer = handlerFixture();
		peer.dependencies.windowLabel = () => "win-popout-other-space";
		const invalid = { ...request, unexpected: true };

		expect(
			await handleCliManagedRunPresentation(
				invalid,
				"request-invalid",
				peer.dependencies,
			),
		).toBeNull();
		expect(peer.dependencies.claim).not.toHaveBeenCalled();
		expect(
			await handleCliManagedRunPresentation(
				invalid,
				"request-invalid",
				main.dependencies,
			),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(main.dependencies.claim).toHaveBeenCalledExactlyOnceWith(
			"request-invalid",
		);
		expect(main.dependencies.inspectBinding).not.toHaveBeenCalled();
		expect(main.openAgent).not.toHaveBeenCalled();
	});

	it("does not present when the addressed window loses the broker claim", async () => {
		const fixture = handlerFixture();
		fixture.dependencies.claim = vi.fn(async () => false);
		expect(
			await handleCliManagedRunPresentation(
				{ ...request },
				"request-lost",
				fixture.dependencies,
			),
		).toBeNull();
		expect(fixture.dependencies.claim).toHaveBeenCalledExactlyOnceWith(
			"request-lost",
		);
		expect(fixture.dependencies.inspectBinding).not.toHaveBeenCalled();
		expect(fixture.openAgent).not.toHaveBeenCalled();
	});

	it("requires the backend's canonical project root instead of reinterpreting its ID", async () => {
		const fixture = handlerFixture();
		const { projectPath: _projectPath, ...withoutProjectRoot } = request;

		const result = await handleCliManagedRunPresentation(
			withoutProjectRoot,
			"request-without-project-root",
			fixture.dependencies,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "client_project_root_unavailable" },
		});
		expect(fixture.openAgent).not.toHaveBeenCalled();
	});

	it("lets the in-app caller reuse the transaction without a CLI broker claim", async () => {
		const fixture = handlerFixture();

		await expect(
			presentManagedRun({ ...request }, fixture.dependencies),
		).resolves.toMatchObject({ ok: true });
		expect(fixture.dependencies.claim).not.toHaveBeenCalled();
		expect(fixture.readState().agents).toHaveLength(1);
	});

	it("projects the existing runtime and opens beside the invoking pane", async () => {
		const fixture = handlerFixture();
		const result = await handleCliManagedRunPresentation(
			{ ...request },
			"request-1",
			fixture.dependencies,
		);

		expect(result).toMatchObject({
			ok: true,
			pane: {
				spaceId: request.spaceId,
				panelId: "presented-pane",
				outcome: "created",
			},
		});
		expect(fixture.openAgent).toHaveBeenCalledWith(
			request.spaceId,
			expect.objectContaining({ id: request.agentId, started: true }),
			{ referencePanel: request.referencePanelId, direction: "right" },
		);
		expect(fixture.dependencies.requestSpaceMount).toHaveBeenCalledWith(
			request.spaceId,
		);
		expect(fixture.waitForAttachment).toHaveBeenCalledWith({
			desktopId: request.spaceId,
			panelId: "presented-pane",
			sessionId: request.sessionId,
			workspaceId: request.workspaceId,
		});
		expect(fixture.readState().agents).toHaveLength(1);
	});

	it("uses the full in-app drop placement without reducing it to a right split", async () => {
		const fixture = handlerFixture();
		const panePosition = {
			referenceGroup: { id: "drop-group" },
			direction: "above",
		};

		await presentManagedRun({ ...request, panePosition }, fixture.dependencies);

		expect(fixture.openAgent).toHaveBeenCalledWith(
			request.spaceId,
			expect.objectContaining({ id: request.agentId }),
			panePosition,
		);
		expect(fixture.dependencies.resolveReference).not.toHaveBeenCalled();
	});

	it("marks an attachment failure after open as a committed pane outcome", async () => {
		const fixture = handlerFixture();
		fixture.waitForAttachment.mockRejectedValueOnce(
			Object.assign(new Error("attachment timed out"), {
				code: "hmux_pane_attachment_timeout",
			}),
		);

		const failure = await presentManagedRun(
			{ ...request },
			fixture.dependencies,
		).then(
			() => null,
			(error: unknown) => error,
		);

		expect(fixture.openAgent).toHaveBeenCalledOnce();
		expect(fixture.readState().agents).toHaveLength(1);
		expect(failure).toMatchObject({
			name: "ManagedRunPaneCommittedError",
			code: "hmux_pane_attachment_timeout",
			phase: "pane_committed",
			pane: {
				spaceId: request.spaceId,
				panelId: "presented-pane",
				agentId: request.agentId,
			},
		});
	});

	it("returns the committed pane to the CLI when only attachment confirmation times out", async () => {
		const fixture = handlerFixture();
		fixture.waitForAttachment.mockRejectedValueOnce(
			Object.assign(new Error("attachment timed out"), {
				code: "hmux_pane_attachment_timeout",
			}),
		);

		const result = await handleCliManagedRunPresentation(
			{ ...request },
			"request-attachment-timeout",
			fixture.dependencies,
		);

		expect(result).toMatchObject({
			ok: true,
			pane: {
				spaceId: request.spaceId,
				panelId: "presented-pane",
				agentId: request.agentId,
				outcome: "created",
			},
		});
		expect(fixture.openAgent).toHaveBeenCalledOnce();
		expect(fixture.readState().agents).toHaveLength(1);
	});

	it("does not project or change selection when the target Space stays cold", async () => {
		const fixture = handlerFixture();
		fixture.dependencies.waitForSpace = vi.fn(async () => undefined);

		const result = await handleCliManagedRunPresentation(
			{ ...request },
			"request-cold-space",
			fixture.dependencies,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "client_space_mount_timeout" },
		});
		expect(fixture.dependencies.requestSpaceMount).toHaveBeenCalledWith(
			request.spaceId,
		);
		expect(fixture.openAgent).not.toHaveBeenCalled();
		expect(fixture.readState().agents).toEqual([]);
	});

	it("fails before any client projection when the source pane moved", async () => {
		const fixture = handlerFixture("space-other");
		const result = await handleCliManagedRunPresentation(
			{ ...request, projectPath: project.path },
			"request-2",
			fixture.dependencies,
		);

		expect(result).toEqual({
			ok: false,
			error: {
				code: "client_source_pane_changed",
				message: "invoking pane moved to another Space before presentation",
			},
		});
		expect(fixture.openAgent).not.toHaveBeenCalled();
		expect(fixture.readState().agents).toEqual([]);
	});

	it("resolves the source pane at the final placement boundary", async () => {
		const fixture = handlerFixture();
		let referenceSpaceId = request.spaceId;
		fixture.dependencies.resolveReference = vi.fn(async (panelId) => ({
			desktopId: referenceSpaceId,
			panelId,
		}));
		fixture.dependencies.ensureProject = vi.fn(async () => {
			referenceSpaceId = "space-other";
			return project;
		});

		const result = await handleCliManagedRunPresentation(
			{ ...request, projectPath: project.path },
			"request-source-race",
			fixture.dependencies,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "client_source_pane_changed" },
		});
		expect(fixture.openAgent).not.toHaveBeenCalled();
		expect(fixture.readState().agents).toEqual([]);
	});

	it("fails before mutation when the Space moved to another window", async () => {
		const fixture = handlerFixture();
		fixture.dependencies.windowLabel = () => "win-popout-space-1";
		const result = await handleCliManagedRunPresentation(
			{ ...request, windowLabel: "win-popout-space-1" },
			"request-window-moved",
			fixture.dependencies,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "client_space_window_changed" },
		});
		expect(fixture.ensureProject).not.toHaveBeenCalled();
		expect(fixture.openAgent).not.toHaveBeenCalled();
		expect(fixture.readState().agents).toEqual([]);
	});

	it("revalidates the Space window after asynchronous runtime inspection", async () => {
		const fixture = handlerFixture();
		fixture.dependencies.inspectBinding = vi.fn(async () => {
			fixture.dependencies.setState((current) => ({
				spaces: current.spaces.map((space) =>
					space.id === request.spaceId
						? { ...space, kind: "popout" as const }
						: space,
				),
			}));
			return binding();
		});

		const result = await handleCliManagedRunPresentation(
			{ ...request },
			"request-window-race",
			fixture.dependencies,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "client_space_window_changed" },
		});
		expect(fixture.openAgent).not.toHaveBeenCalled();
		expect(fixture.readState().agents).toEqual([]);
	});
});

describe("backend-owned Run successor presentation", () => {
	const selected = {
		state: "stable",
		agentId: request.agentId,
		providerId: request.providerId,
		interactionProfile: "native_cli",
		sessionId: request.sessionId,
		workspaceId: request.workspaceId,
		launchIdempotencyKey: request.launchIdempotencyKey,
		stopFence: request.generation,
		executionProfile: { kind: "provider_default" },
		providerConversationRef: null,
		launchSelection: { model: null, effort: null, permissionMode: "default" },
		selectionRevision: 2,
		backendProfileId: request.backendProfileId!,
		backend: { id: "local", generation: "1" },
		routeAuthority: testDureBackendRouteAuthority("local", "1"),
		projectionContext: {
			schemaVersion: 1,
			identity: { kind: "registered" },
			agent: {
				agentId: request.agentId,
				providerId: request.providerId,
				workspaceId: "workspace-domain",
			},
			workspace: {
				workspaceId: "workspace-domain",
				projectId: project.id,
				rootPath: project.path,
			},
			project: { projectId: project.id, rootPath: project.path },
		},
	} satisfies DureAgentRuntimeProjectionInspectResultV1;
	function fixture() {
		const agent = projectManagedRunPresentationAgent(
			state(),
			request,
			project,
			binding(),
		).agent;
		agent.sessionId = "predecessor";
		agent.runtimeBinding = { ...binding(), sessionId: "predecessor" };
		return {
			readAgents: () => [agent],
			inspect: vi.fn(
				async () => selected as DureAgentRuntimeProjectionInspectResultV1,
			),
			project: vi.fn(),
			agent,
		};
	}
	it("refreshes a registered successor through the authoritative projection writer", async () => {
		const deps = fixture();
		await refreshManagedRunProjection(request, deps);
		expect(deps.inspect).toHaveBeenCalledWith({
			agentId: request.agentId,
			backendProfileId: request.backendProfileId,
		});
		expect(deps.project).toHaveBeenCalledWith(request.agentId, selected);
	});
	it("refuses a mismatched generation or another runtime selection", async () => {
		for (const change of [
			{ sessionId: "another-session" },
			{ providerId: "claude" },
			{ stopFence: { ...request.generation, terminalEpoch: "replaced" } },
			{
				executionProfile: {
					kind: "credential_reference",
					reference_id: "other",
					credential_generation: "1",
				},
			},
			{ state: "unmanaged" },
		]) {
			const deps = fixture();
			deps.inspect.mockResolvedValue({
				...selected,
				...change,
			} as DureAgentRuntimeProjectionInspectResultV1);
			await expect(refreshManagedRunProjection(request, deps)).rejects.toThrow(
				"runtime changed",
			);
			expect(deps.project).not.toHaveBeenCalled();
		}
	});
	it("leaves unrelated IDs to the existing identity conflict check", async () => {
		const deps = fixture();
		deps.agent.canonicalSpawn = {
			...deps.agent.canonicalSpawn!,
			operationId: "other-spawn",
		};
		await refreshManagedRunProjection(request, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
		expect(deps.project).not.toHaveBeenCalled();
	});
	it("does not overwrite a projection changed during inspection", async () => {
		const deps = fixture();
		deps.inspect.mockImplementation(async () => {
			deps.readAgents = () => [{ ...deps.agent, sessionId: "changed" }];
			return selected;
		});
		await expect(refreshManagedRunProjection(request, deps)).rejects.toThrow(
			"runtime changed",
		);
		expect(deps.project).not.toHaveBeenCalled();
	});
});
