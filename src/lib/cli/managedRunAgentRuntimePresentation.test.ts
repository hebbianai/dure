import { describe, expect, it, vi } from "vitest";
import {
	type CliManagedRunPresentationDependencies,
	handleCliManagedRunPresentation,
} from "@/lib/cli/cliManagedRunPresentation";
import {
	type ManagedRunLaunchKeyDependencies,
	resolveManagedRunLaunchKey,
} from "@/lib/cli/managedRunLaunchKey";
import {
	CliManagedRunPresentationError,
	type CliManagedRunPresentationState,
	parseCliManagedRunPresentationRequest,
	parseManagedRunProjectionInput,
} from "@/lib/cli/managedRunPresentationModel";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "dure",
	path: "/workspace/dure",
	kind: "local",
	isRepo: true,
};

const generation = {
	runnerPrincipal: "runner-principal",
	runnerInstance: "runner-instance",
	channelEpoch: "1",
	hostInstanceId: "host-instance",
	terminalEpoch: "terminal-epoch",
};

/** What `dure runs open` sends for an app-launched Agent (no Run record). */
const wire = {
	schemaVersion: 1,
	runtime: "hmux_managed_v1",
	identity: "agent_runtime",
	source: "local",
	hostId: "local",
	backendProfileId: "local",
	agentId: "agent-app-resumed",
	agentName: "worker-resumed",
	projectId: "hmux-project:proj-app",
	projectPath: project.path,
	providerId: "claude",
	executionProfile: { kind: "provider_default" },
	providerConversationRef: "conversation-7",
	sessionId: "runtime-native-app-1",
	workspaceId: "proj-app",
	workspaceRootPath: project.path,
	generation,
	permissionMode: "skip_permissions",
	spaceId: "space-1",
	windowLabel: "main",
};

function state(agents: Agent[] = []): CliManagedRunPresentationState {
	return {
		agents,
		projects: [project],
		sshHosts: [],
		spaces: [{ id: "space-1", name: "Build" }],
		agentActivity: {},
		sessionCwd: {},
		stats: { agentsStarted: 0, prsCreated: 0, activeMs: 0, since: 1 },
	};
}

function liveBinding(createIdempotencyKey = "spawn_app_root") {
	return {
		...hmuxManagedBinding(
			wire.sessionId,
			wire.workspaceId,
			undefined,
			undefined,
			generation,
			wire.backendProfileId,
		),
		createIdempotencyKey,
	};
}

function fixture(agents: Agent[] = []) {
	let current = state(agents);
	const openAgent = vi.fn(() => "presented-pane");
	const inspectBinding = vi.fn(async () => liveBinding());
	const dependencies: CliManagedRunPresentationDependencies = {
		claim: vi.fn(async () => true),
		windowLabel: () => "main",
		readState: () => current,
		setState: (produce) => {
			current = { ...current, ...produce(current) };
		},
		ensureProject: vi.fn(async () => project),
		inspectBinding,
		resolveReference: vi.fn(),
		requestSpaceMount: vi.fn(),
		waitForSpace: vi.fn(async () => ({})),
		openAgent,
		waitForAttachment: vi.fn(async () => ({ state: "attached" })),
	};
	return { dependencies, openAgent, inspectBinding, readState: () => current };
}

describe("Agent runtime presentation request", () => {
	it("derives the workspace from the backend runtime root instead of a spawn receipt", () => {
		const parsed = parseCliManagedRunPresentationRequest({ ...wire });
		expect(parsed).toMatchObject({
			identity: "agent_runtime",
			agentId: wire.agentId,
			sessionId: wire.sessionId,
			worktree: { kind: "project_root" },
		});
		expect(parsed.operationId).toBeUndefined();
		expect(parsed.launchIdempotencyKey).toBeUndefined();
		expect(
			parseCliManagedRunPresentationRequest({
				...wire,
				workspaceRootPath: "/workspace/dure-feature",
				launchIdempotencyKey: "runtime-transition-launch",
			}),
		).toMatchObject({
			worktree: {
				kind: "existing_checkout",
				branch: "",
				rootPath: "/workspace/dure-feature",
			},
			launchIdempotencyKey: "runtime-transition-launch",
		});
	});

	it("refuses spawn-receipt fields, a relative root or a missing backend route", () => {
		for (const invalid of [
			{ ...wire, operationId: "spawn-operation-1" },
			{ ...wire, worktree: { kind: "project_root" } },
			{ ...wire, workspaceRootPath: "relative/root" },
			{ ...wire, workspaceRootPath: undefined },
			{ ...wire, backendProfileId: undefined },
			{ ...wire, identity: "agent" },
		]) {
			expect(() => parseCliManagedRunPresentationRequest(invalid)).toThrow(
				CliManagedRunPresentationError,
			);
		}
	});

	it("is never accepted as a background Run registration", () => {
		const { spaceId: _space, windowLabel: _window, ...projection } = wire;
		expect(() => parseManagedRunProjectionInput(projection)).toThrow(
			CliManagedRunPresentationError,
		);
	});
});

describe("Agent runtime pane transaction", () => {
	it("places the live Session in a pane without recording a canonical spawn", async () => {
		const f = fixture();
		const result = await handleCliManagedRunPresentation(
			{ ...wire },
			"request-1",
			f.dependencies,
		);
		expect(result).toMatchObject({
			ok: true,
			pane: {
				panelId: "presented-pane",
				agentId: wire.agentId,
				sessionId: wire.sessionId,
				workspaceId: wire.workspaceId,
				outcome: "created",
			},
		});
		const [agent] = f.readState().agents;
		expect(agent).toMatchObject({
			id: wire.agentId,
			name: wire.agentName,
			provider: "claude",
			projectId: project.id,
			worktreePath: project.path,
			branch: "",
			sessionId: wire.sessionId,
			conversationId: "conversation-7",
			started: true,
			skipPermissions: true,
			runtimeBinding: {
				runtime: "hmux_managed_v1",
				sessionId: wire.sessionId,
				createIdempotencyKey: "spawn_app_root",
				stopFence: generation,
			},
		});
		expect(agent.canonicalSpawn).toBeUndefined();
		expect(f.openAgent).toHaveBeenCalledOnce();
	});

	it("reuses the app's own projection of the same runtime and keeps its branch", async () => {
		const existing: Agent = {
			id: wire.agentId,
			name: wire.agentName,
			provider: "claude",
			projectId: project.id,
			worktreePath: "/workspace/dure-feature",
			branch: "agent/feature",
			sessionId: wire.sessionId,
			sessionKind: "pty",
			runtimeBinding: liveBinding(),
			conversationId: "conversation-7",
			started: true,
		};
		const f = fixture([existing]);
		const result = await handleCliManagedRunPresentation(
			{ ...wire, workspaceRootPath: "/workspace/dure-feature" },
			"request-1",
			f.dependencies,
		);
		expect(result).toMatchObject({ ok: true, pane: { outcome: "reused" } });
		expect(f.readState().agents).toHaveLength(1);
		expect(f.readState().agents[0]).toMatchObject({
			branch: "agent/feature",
			worktreePath: "/workspace/dure-feature",
		});
		expect(f.readState().agents[0].canonicalSpawn).toBeUndefined();
	});
});

function session(overrides: Partial<HmuxSessionSummary> = {}) {
	return {
		sessionId: wire.sessionId,
		workspaceId: wire.workspaceId,
		sessionClass: "managed",
		lifecycle: "ready",
		terminalEpoch: generation.terminalEpoch,
		stopFence: generation,
		outputSeq: "1",
		capabilities: [],
		...overrides,
	} as HmuxSessionSummary;
}

function keyDependencies(
	writerSession = session(),
): ManagedRunLaunchKeyDependencies & {
	inspectConversation: ReturnType<typeof vi.fn>;
	inspectWriter: ReturnType<typeof vi.fn>;
} {
	return {
		inspectConversation: vi.fn(async () => ({
			sessionId: wire.sessionId,
			workspaceId: wire.workspaceId,
			providerId: "claude" as const,
			conversationId: "conversation-8",
		})),
		inspectWriter: vi.fn(async () => ({
			session: writerSession,
			idempotencyKey: "spawn_app_root",
			conversationId: "conversation-8",
			permissionMode: "bypass_approvals" as const,
		})),
	};
}

function runtimeRequest(overrides: Record<string, unknown> = {}) {
	const {
		spaceId: _space,
		windowLabel: _window,
		...request
	} = parseCliManagedRunPresentationRequest({ ...wire, ...overrides });
	return request;
}

describe("Agent runtime launch key", () => {
	it("uses a key the backend reported without touching the Host", async () => {
		const deps = keyDependencies();
		await expect(
			resolveManagedRunLaunchKey(
				runtimeRequest({ launchIdempotencyKey: "runtime-transition-launch" }),
				deps,
			),
		).resolves.toBe("runtime-transition-launch");
		expect(deps.inspectWriter).not.toHaveBeenCalled();
	});

	it("reads an app-launched Session's create key through the exact existing-writer proof", async () => {
		const deps = keyDependencies();
		await expect(
			resolveManagedRunLaunchKey(
				runtimeRequest({
					workspaceRootPath: "/workspace/dure-feature",
					executionProfile: {
						kind: "credential_reference",
						reference_id: "account-work",
						credential_generation: "generation-2",
					},
				}),
				deps,
			),
		).resolves.toBe("spawn_app_root");
		expect(deps.inspectConversation).toHaveBeenCalledWith({
			sessionId: wire.sessionId,
			workspaceId: wire.workspaceId,
			providerId: "claude",
			cwd: "/workspace/dure-feature",
		});
		// The Host's current conversation wins over a stale backend reference.
		expect(deps.inspectWriter).toHaveBeenCalledWith({
			sessionId: wire.sessionId,
			workspaceId: wire.workspaceId,
			providerId: "claude",
			conversationId: "conversation-8",
			cwd: "/workspace/dure-feature",
			permissionMode: "bypass_approvals",
			launchReference: "account-work",
		});
	});

	it("falls back to the backend conversation when the Host cannot report one", async () => {
		const deps = keyDependencies();
		deps.inspectConversation.mockRejectedValue(new Error("unsupported"));
		await expect(
			resolveManagedRunLaunchKey(
				runtimeRequest({ permissionMode: "auto_edit" }),
				deps,
			),
		).resolves.toBe("spawn_app_root");
		expect(deps.inspectWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-7",
				cwd: project.path,
				permissionMode: "default",
			}),
		);
	});

	it("refuses a replaced Host generation or a remote runtime without a reported key", async () => {
		await expect(
			resolveManagedRunLaunchKey(
				runtimeRequest(),
				keyDependencies(
					session({ stopFence: { ...generation, terminalEpoch: "next" } }),
				),
			),
		).rejects.toMatchObject({ code: "managed_session_generation_mismatch" });
		const deps = keyDependencies();
		await expect(
			resolveManagedRunLaunchKey(
				runtimeRequest({
					source: "ssh",
					hostId: "ssh-1",
					backendProfileId: "ssh-1",
					remote: { host: "build.example", port: 22, user: "dure" },
				}),
				deps,
			),
		).rejects.toMatchObject({
			code: "client_agent_runtime_launch_key_unavailable",
		});
		expect(deps.inspectWriter).not.toHaveBeenCalled();
	});
});
