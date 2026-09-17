import { emit } from "@tauri-apps/api/event";
import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { PROVIDER_IDS } from "@/lib/agents/providers";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import { containsCliControlCharacter } from "@/lib/cli/cliTextBoundary";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { hmux } from "@/lib/ipc";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import {
	observeManagedRehostLineage,
	resolveManagedAgentDurableSuccessor,
	sessionMatchesManagedRehostGeneration,
} from "@/lib/sessions/managed/managedAgentDurableSuccessor";
import {
	inspectExistingManagedWriter,
	type ManagedAgentDurableSuccessorSource,
	managedAgentDurableSuccessorSyncPayload,
} from "@/lib/sessions/managed/managedAgentExistingWriter";
import { sendHmuxAgentCommandInput } from "@/lib/sessions/managed/managedAgentInput";
import { resolveFencedManagedAgentPanel } from "@/lib/sessions/managed/managedAgentRehostInspection";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import { commitManagedAgentRehostReceipt } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { resolveManagedAgentTarget } from "@/lib/sessions/managed/managedAgentTarget";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import {
	bindingForAgent,
	sameHmuxManagedLaunchBinding,
} from "@/lib/terminal/terminalBinding";
import { openAgentPanel } from "@/lib/workspace/dock";
import { waitForDesktopDockview } from "@/lib/workspace/dock/dockRegistry";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { Agent, Provider } from "@/types";

const CLI_REUSE_REQUEST_KEYS = new Set([
	"schemaVersion",
	"project",
	"provider",
	"name",
	"prompt",
	"idempotencyKey",
	"windowLabel",
]);
const CLI_REUSE_IDEMPOTENCY_KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const CLI_REUSE_WINDOW_LABEL = /^[A-Za-z0-9_-]{1,128}$/;

interface ExactManagedAgentPane {
	agent: Agent;
	source: ManagedAgentDurableSuccessorSource;
	activate(): void;
}

interface CliManagedAgentReuseRuntime {
	state: typeof useStore.getState;
	resolveSuccessor: typeof hmux.resolveManagedRehost;
	inspectSession: typeof inspectHmuxSessionExact;
	inspectExistingWriter: typeof inspectExistingManagedWriter;
	syncPayload: typeof managedAgentDurableSuccessorSyncPayload;
	commitReceipt: typeof commitManagedAgentRehostReceipt;
	emit: typeof emit;
	sendInput: typeof sendHmuxAgentCommandInput;
	inspectExactPane: typeof inspectExactManagedAgentPane;
}

const runtime: CliManagedAgentReuseRuntime = {
	state: useStore.getState,
	resolveSuccessor: hmux.resolveManagedRehost,
	inspectSession: inspectHmuxSessionExact,
	inspectExistingWriter: inspectExistingManagedWriter,
	syncPayload: managedAgentDurableSuccessorSyncPayload,
	commitReceipt: commitManagedAgentRehostReceipt,
	emit,
	sendInput: sendHmuxAgentCommandInput,
	inspectExactPane: inspectExactManagedAgentPane,
};

export interface CliAgentReuseRequest {
	projectId: string;
	projectName: string;
	name: string;
	provider?: Provider;
	prompt: string;
}

function sameOptionalIdentity(
	expected: string | undefined,
	observed: string,
): boolean {
	return expected === undefined || expected === observed;
}

async function inspectExactManagedAgentPane(
	agent: Agent,
	durableConversationId?: string,
): Promise<ExactManagedAgentPane> {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
		throw new PaneCommandError(
			"pane_changed",
			`agent ${agent.name} is no longer locally managed`,
		);
	}
	const target = resolveManagedAgentTarget(agent.id);
	if (!sameHmuxManagedLaunchBinding(target.binding, binding)) {
		throw new PaneCommandError(
			"pane_changed",
			`agent ${agent.name} changed before reuse`,
		);
	}
	const panel = await resolveFencedManagedAgentPanel(agent.id);
	const { panelId } = panel;
	const state = useStore.getState();
	const current = state.agents.find((candidate) => candidate.id === agent.id);
	const sourceConversationId = current
		? managedConversationId(current)
		: undefined;
	const initialConversationId = managedConversationId(agent);
	const authoritativeConversationId =
		durableConversationId?.trim() || undefined;
	const conversationId = authoritativeConversationId ?? sourceConversationId;
	const conversationMatches = authoritativeConversationId
		? initialConversationId === undefined ||
			sourceConversationId === undefined ||
			sourceConversationId === initialConversationId
		: initialConversationId !== undefined &&
			sourceConversationId === initialConversationId;
	if (
		!current ||
		current.name !== agent.name ||
		current.projectId !== agent.projectId ||
		current.provider !== agent.provider ||
		current.worktreePath !== agent.worktreePath ||
		!conversationId ||
		!conversationMatches ||
		!sameHmuxManagedLaunchBinding(current.runtimeBinding, binding)
	) {
		throw new PaneCommandError(
			"pane_changed",
			`agent pane ${panelId} changed before reuse`,
		);
	}
	const backendRouteAuthority = await resolveSelectedDureBackendRouteAuthority(
		binding.backendProfileId ?? "local",
	);
	const sourcePermissionMode = effectiveAgentPermissionMode(
		current,
		state.skipPermissions,
	);
	return {
		agent: current,
		source: {
			agentId: current.id,
			agentName: current.name,
			projectId: current.projectId,
			providerId: current.provider,
			sourceBinding: { ...binding },
			sourceConversationId,
			sourcePaneState: "present",
			backendRouteAuthority,
			conversationId,
			cwd: current.worktreePath,
			desktopId: panel.desktopId,
			panelId,
			permissionMode: sourcePermissionMode,
			sourcePermissionMode,
			credentialId:
				binding.credentialId ??
				current.credentialId ??
				(typeof current.accountId === "string" ? current.accountId : undefined),
			accounts: state.accounts,
		},
		activate: () => {
			panel.livePanel.api.setActive();
			useStore.getState().saveLayout(panel.desktopId, panel.api.toJSON());
		},
	};
}

async function reuseManagedAgent(
	agent: Agent,
	prompt: string,
	deps: CliManagedAgentReuseRuntime = runtime,
): Promise<Agent> {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
		throw new PaneCommandError(
			"invalid_request",
			`agent ${agent.name} cannot resolve a local durable successor`,
		);
	}

	const resolution = await observeManagedRehostLineage(
		binding,
		deps.resolveSuccessor,
	);

	let reused: Agent;
	if (resolution.state === "resolved") {
		const exactPane = await deps.inspectExactPane(
			agent,
			resolution.launchIdentity?.conversationId,
		);
		const successorSource: ManagedAgentDurableSuccessorSource = {
			...exactPane.source,
			providerId: resolution.providerId,
			permissionMode: resolution.permissionMode,
		};
		const successor = await resolveManagedAgentDurableSuccessor(
			successorSource,
			{
				resolveManagedRehost: deps.resolveSuccessor,
				inspectExistingWriter: deps.inspectExistingWriter,
			},
			resolution,
		);
		if (successor.state !== "resolved") {
			throw new PaneCommandError(
				"pane_changed",
				`agent ${agent.name} durable successor changed during reuse`,
			);
		}
		const payload = deps.syncPayload(
			successorSource,
			successor,
			successor.operationId,
		);
		const committed = await deps.commitReceipt(payload);
		if (!committed) {
			throw new PaneCommandError(
				"pane_changed",
				`agent ${agent.name} pane changed before durable successor handoff`,
			);
		}
		const committedPayload = committed.payload;
		publishManagedAgentRehostProjection(committedPayload, deps.emit);
		const current = deps
			.state()
			.agents.find((candidate) => candidate.id === agent.id);
		if (
			!current ||
			current.sessionId !== committedPayload.binding.sessionId ||
			!sameHmuxManagedLaunchBinding(
				current.runtimeBinding,
				committedPayload.binding,
			) ||
			(managedConversationId(current) ?? null) !==
				committedPayload.conversationId
		) {
			throw new PaneCommandError(
				"pane_changed",
				`agent ${agent.name} successor projection did not commit`,
			);
		}
		reused = current;
	} else {
		if (resolution.state === "retry_required") {
			throw new PaneCommandError(
				"pane_changed",
				`agent ${agent.name} rehost ${resolution.operationId} is incomplete`,
			);
		}
		const source = await deps.inspectSession({
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		});
		const sourceReady = binding.stopFence
			? source !== undefined &&
				sessionMatchesManagedRehostGeneration(source, {
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					...binding.stopFence,
				})
			: source?.sessionClass === "managed" &&
				source.lifecycle === "ready" &&
				source.inputAllowed !== false;
		if (!sourceReady) {
			throw new PaneCommandError(
				"pane_changed",
				`agent ${agent.name} source exited without a durable successor`,
			);
		}
		const exactPane = await deps.inspectExactPane(agent);
		exactPane.activate();
		reused = exactPane.agent;
	}

	if (prompt) await deps.sendInput(reused, prompt, true);
	return reused;
}

/** Reuse one exact same-name registration. Managed registrations fail closed;
 * the legacy dead-session replacement behavior remains unchanged. */
export async function reuseAgentByName(
	request: CliAgentReuseRequest,
): Promise<Agent | undefined> {
	const matches = useStore
		.getState()
		.agents.filter(
			(agent) =>
				agent.projectId === request.projectId && agent.name === request.name,
		);
	if (matches.length > 1) {
		throw new PaneCommandError(
			"pane_ambiguous",
			`project ${request.projectName} has ${matches.length} agents named ${request.name}`,
		);
	}
	const [existing] = matches;
	if (!existing) return undefined;
	if (!sameOptionalIdentity(request.provider, existing.provider)) {
		throw new PaneCommandError(
			"pane_changed",
			`agent ${request.name} belongs to provider ${existing.provider}`,
		);
	}

	const binding = existing.runtimeBinding;
	if (binding?.runtime === "hmux_managed_v1") {
		if (binding.source !== "local") {
			throw new PaneCommandError(
				"pane_changed",
				`agent ${request.name} has no local durable successor resolver`,
			);
		}
		return reuseManagedAgent(existing, request.prompt);
	}
	// The legacy PTY/SSH runtime is retired (2026-08-16): an unbound record has
	// no live session to reuse, so only a standalone Hmux binding can revive an
	// existing registration here.
	if (binding?.runtime !== "hmux_standalone_v1") return undefined;
	const alive =
		(
			await inspectHmuxSessionExact({
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
			})
		)?.lifecycle === "ready";
	if (!alive) return undefined;

	const desktopId = useStore.getState().activeSpaceId;
	await waitForDesktopDockview(desktopId);
	if (!openAgentPanel(desktopId, existing)) {
		throw new PaneCommandError(
			"pane_not_found",
			`desktop ${desktopId} is not mounted`,
		);
	}
	if (request.prompt) {
		await sendHmuxAgentCommandInput(existing, request.prompt, true);
	}
	return existing;
}

export interface CliAgentReuseDependencies {
	claim(reqId: string): Promise<boolean>;
	state(): ReturnType<typeof useStore.getState>;
	reuse(request: CliAgentReuseRequest): Promise<Agent | undefined>;
}

const cliAgentReuseDependencies: CliAgentReuseDependencies = {
	claim: claimCliRequest,
	state: useStore.getState,
	reuse: reuseAgentByName,
};

function boundedReuseLabel(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		!containsCliControlCharacter(value, { rejectC1: true })
	);
}

function boundedReusePrompt(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length <= maximum &&
		!containsCliControlCharacter(value, {
			allowLayout: true,
			rejectC1: true,
		})
	);
}

function optionalKnownProvider(value: unknown): value is Provider | undefined {
	return (
		value === undefined ||
		(typeof value === "string" && PROVIDER_IDS.includes(value as Provider))
	);
}

function cliAgentReuseError(error: unknown) {
	return {
		code:
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: "agent_reuse_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}

export async function handleCliAgentReuse(
	params: Record<string, unknown>,
	reqId: string,
	dependencies: CliAgentReuseDependencies = cliAgentReuseDependencies,
) {
	let claimed = false;
	const claim = async () => {
		if (claimed) return true;
		claimed = await dependencies.claim(reqId);
		return claimed;
	};
	try {
		if (
			Object.keys(params).some((key) => !CLI_REUSE_REQUEST_KEYS.has(key)) ||
			params.schemaVersion !== 1 ||
			!boundedReuseLabel(params.project, 256) ||
			!boundedReuseLabel(params.name, 64) ||
			!boundedReusePrompt(params.prompt, 16 * 1024) ||
			!optionalKnownProvider(params.provider) ||
			typeof params.idempotencyKey !== "string" ||
			!CLI_REUSE_IDEMPOTENCY_KEY.test(params.idempotencyKey) ||
			(params.windowLabel !== undefined &&
				(typeof params.windowLabel !== "string" ||
					!CLI_REUSE_WINDOW_LABEL.test(params.windowLabel)))
		) {
			throw new PaneCommandError(
				"invalid_request",
				"exact project and Agent name, prompt, and idempotency key are required; provider is an optional identity check",
			);
		}
		const state = dependencies.state();
		const idMatch = state.projects.find(
			(project) => project.id === params.project,
		);
		const projects = idMatch
			? [idMatch]
			: state.projects.filter((project) => project.name === params.project);
		if (projects.length !== 1) {
			throw new PaneCommandError(
				projects.length === 0 ? "project_not_found" : "project_ambiguous",
				`project ${params.project} does not resolve to one Dure project`,
			);
		}
		if (!(await claim())) return null;
		const agent = await dependencies.reuse({
			projectId: projects[0].id,
			projectName: projects[0].name,
			name: params.name,
			provider: params.provider as Provider | undefined,
			prompt: params.prompt,
		});
		if (!agent) {
			throw new PaneCommandError(
				"agent_reuse_not_found",
				`agent ${params.project}/${params.name} is not safely reusable`,
			);
		}
		const binding = bindingForAgent(agent, dependencies.state().projects);
		if (!binding) {
			throw new PaneCommandError(
				"agent_reuse_runtime_unavailable",
				`agent ${params.project}/${params.name} has no exact runtime binding`,
			);
		}
		return {
			ok: true,
			agent: {
				id: agent.id,
				name: agent.name,
				projectId: agent.projectId,
				provider: agent.provider,
				sessionId: agent.sessionId,
				runtime: binding.runtime,
			},
		};
	} catch (error) {
		if (!(await claim())) return null;
		return { ok: false, error: cliAgentReuseError(error) };
	}
}
