import { emit } from "@tauri-apps/api/event";
import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { isHmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { agentAccount, providerRunCmd } from "@/lib/agents/providers";
import { resolvePaneById } from "@/lib/workspace/dock";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { paneContentComponent } from "@/lib/workspace/layout/persistedPaneLayout";
import {
	HmuxAgentPanePromotionError,
	hmuxManagedPromotionAgentId,
	type HmuxManagedAgentPromotion,
	projectHmuxManagedAgentPaneLayout,
	resolveHmuxManagedAgentPromotion,
} from "@/lib/hmux/conversion/hmuxAgentPanePromotion";
import {
	hmux,
	type HmuxSessionConversionReceipt,
	type HmuxSessionSummary,
} from "@/lib/ipc";
import {
	type ConvertibleHmuxBinding,
	type HmuxSessionConversionTarget,
	hmuxSessionConversionId,
	recoverConvertedStandaloneSourceBinding,
	sameHmuxConversionBinding,
	selectHmuxConversionSourceBinding,
} from "@/lib/hmux/conversion/hmuxSessionConversionIdentity";
import {
	bindingFromPane,
	hmuxManagedBinding,
	hmuxStandaloneBinding,
	isTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { sameTerminalEnvironment } from "@/lib/terminal/terminalEnvironmentEquality";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { supportsStandaloneManagedPromotion } from "@/lib/sessions/managed/managedProviderCapabilities";
import { useStore } from "@/store";
import type { Agent, Provider, TerminalEnvironment } from "@/types";

export { hmuxSessionConversionId, selectHmuxConversionSourceBinding };
export type { ConvertibleHmuxBinding, HmuxSessionConversionTarget };

export interface HmuxSessionConversionInspection {
	desktopId: string;
	panelId: string;
	resolvedPanelId: string;
	agentId?: string;
	promotion?: HmuxManagedAgentPromotion;
	sourceBinding: ConvertibleHmuxBinding;
	target: HmuxSessionConversionTarget;
	providerId: Provider;
	expectedConversationId?: string;
	cwd: string;
	conversionId: string;
	permissionMode: "default" | "bypass_approvals";
	credentialId?: string;
	credentialDirectory?: string;
	credentialGeneration?: number;
	terminalEnvironment: TerminalEnvironment;
}

export interface HmuxSessionConversionPaneReceipt {
	desktopId: string;
	panelId: string;
	sessionId: string;
	workspaceId: string;
	runtime: "hmux_managed_v1" | "hmux_standalone_v1";
	providerId: Provider;
	conversationId: string;
	cwd: string;
}

export interface HmuxSessionConversionSyncPayload {
	schemaVersion: 1;
	desktopId: string;
	panelId: string;
	agentId?: string;
	promotion?: HmuxManagedAgentPromotion;
	providerId: Provider;
	cwd: string;
	conversationId: string;
	sourceBinding: ConvertibleHmuxBinding;
	binding: ConvertibleHmuxBinding;
}

export const HMUX_SESSION_CONVERTED_EVENT = "hmux:session-converted:v1";

export type HmuxConversionConsumerState =
	| "source"
	| "target"
	| "missing"
	| "conflict";

export function classifyHmuxConversionBinding(
	value: unknown,
	source: ConvertibleHmuxBinding,
	target: ConvertibleHmuxBinding,
): HmuxConversionConsumerState {
	if (!isTerminalPaneBindingV1(value)) return "missing";
	const binding = convertibleBinding(value);
	if (!binding) return "conflict";
	if (sameHmuxConversionBinding(binding, source)) return "source";
	if (sameHmuxConversionBinding(binding, target)) return "target";
	return "conflict";
}

export function projectHmuxConversionLayout(
	layout: unknown,
	payload: HmuxSessionConversionSyncPayload,
): { state: HmuxConversionConsumerState; layout: unknown } {
	if (payload.promotion) {
		if (
			!isHmuxProviderSessionSourceBinding(
				payload.sourceBinding,
				"terminal",
			) ||
			payload.binding.runtime !== "hmux_managed_v1"
		) {
			return { state: "conflict", layout };
		}
		return projectHmuxManagedAgentPaneLayout(
			layout,
			payload.promotion,
			payload.sourceBinding,
			payload.binding,
		);
	}
	let next: Record<string, unknown>;
	try {
		next = JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
	} catch {
		return { state: "conflict", layout };
	}
	const panels =
		next.panels && typeof next.panels === "object"
			? (next.panels as Record<string, unknown>)
			: undefined;
	const panel =
		panels?.[payload.panelId] && typeof panels[payload.panelId] === "object"
			? (panels[payload.panelId] as Record<string, unknown>)
			: undefined;
	if (!panel) return { state: "missing", layout: next };
	const params =
		panel.params && typeof panel.params === "object"
			? (panel.params as Record<string, unknown>)
			: {};
	const component = paneContentComponent(panel);
	if (component === "agent") {
		const agentId = agentIdFromPaneParameters(params);
		if (
			!agentId ||
			(payload.agentId !== undefined && payload.agentId !== agentId)
		) {
			return { state: "conflict", layout: next };
		}
		panel.params = { agentRef: { agentId } };
		return { state: "target", layout: next };
	}
	if (component !== "terminal") return { state: "conflict", layout: next };
	const state = classifyHmuxConversionBinding(
		params.binding,
		payload.sourceBinding,
		payload.binding,
	);
	if (state === "source") {
		panel.params = {
			...params,
			sessionId: payload.binding.sessionId,
			binding: payload.binding,
		};
	}
	return { state, layout: next };
}

function convertibleBinding(
	value: unknown,
): ConvertibleHmuxBinding | undefined {
	if (!isTerminalPaneBindingV1(value)) return undefined;
	return value.source === "local" &&
		(value.runtime === "hmux_managed_v1" ||
			value.runtime === "hmux_standalone_v1")
		? value
		: undefined;
}

function sourceAgent(agentId: unknown): Agent | undefined {
	if (typeof agentId !== "string") return undefined;
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	if (!agent) {
		throw new PaneCommandError(
			"pane_changed",
			"agent pane disappeared before Hmux conversion",
		);
	}
	return agent;
}

function persistedPaneBinding(
	layout: unknown,
	panelId: string,
): ConvertibleHmuxBinding | undefined {
	if (!layout || typeof layout !== "object" || Array.isArray(layout))
		return undefined;
	const panels = (layout as { panels?: Record<string, unknown> }).panels;
	const panel = panels?.[panelId];
	if (!panel || typeof panel !== "object" || Array.isArray(panel))
		return undefined;
	if (paneContentComponent(panel) !== "terminal") return undefined;
	const params = (panel as { params?: Record<string, unknown> }).params;
	return convertibleBinding(params?.binding);
}

async function resolveHmuxConversionPane(
	sourceSessionId: string,
	panelId: string,
	target: HmuxSessionConversionTarget,
	sourceWorkspaceId?: string,
) {
	try {
		return await resolvePaneById(panelId);
	} catch (error) {
		// Pre-neutral promotions renamed the source pane. Resolve only that
		// historical command spelling at ingress; new conversions keep the slot.
		if (
			!(error instanceof PaneCommandError) ||
			error.code !== "pane_not_found" ||
			target !== "managed" ||
			!panelId.startsWith("term:")
		) {
			throw error;
		}
		if (!sourceWorkspaceId) throw error;
		const source = hmuxStandaloneBinding(sourceSessionId, sourceWorkspaceId);
		const conversionId = hmuxSessionConversionId(panelId, source, "managed");
		const promotedPanelId = `agent:${hmuxManagedPromotionAgentId(conversionId)}`;
		return resolvePaneById(promotedPanelId);
	}
}

export async function inspectHmuxSessionConversion(
	sourceSessionId: string,
	panelId: string,
	target: HmuxSessionConversionTarget,
	sourceWorkspaceId?: string,
	sourceSessionName?: string,
	requestedAgentName?: string,
): Promise<HmuxSessionConversionInspection> {
	const resolved = await resolveHmuxConversionPane(
		sourceSessionId,
		panelId,
		target,
		sourceWorkspaceId,
	);
	const panel = resolved.api.getPanel(resolved.panelId);
	if (!panel) {
		throw new PaneCommandError(
			"pane_not_found",
			`pane ${panelId} detached during conversion inspection`,
		);
	}
	const state = useStore.getState();
	const pane = dockPanelReference(panel);
	const params = pane.params;
	const paneBinding = convertibleBinding(
		bindingFromPane(pane, state.agents, state.projects),
	);
	if (!paneBinding) {
		const rawBinding =
			params.binding && typeof params.binding === "object"
				? (params.binding as Record<string, unknown>)
				: undefined;
		throw new PaneCommandError(
			"pane_changed",
			`pane ${panelId} is not bound to Hmux (mounted=${panel.id}, session=${String(
				params.sessionId ?? "missing",
			)}, binding=${String(rawBinding?.runtime ?? "missing")}:${String(
				rawBinding?.sessionId ?? "missing",
			)}@${String(rawBinding?.workspaceId ?? "missing")})`,
		);
	}
	const agent = sourceAgent(
		pane.component === "agent"
			? agentIdFromPaneParameters(params)
			: undefined,
	);
	const consumerBindings = [
		paneBinding,
		convertibleBinding(agent?.runtimeBinding),
		persistedPaneBinding(state.layouts[resolved.desktopId], panel.id),
	];
	let sourceBinding: ConvertibleHmuxBinding;
	try {
		sourceBinding = selectHmuxConversionSourceBinding(
			consumerBindings,
			target,
			sourceSessionId,
			sourceWorkspaceId,
			{ id: panelId, component: pane.component },
		);
	} catch (error) {
		const recovered =
			target === "managed"
				? recoverConvertedStandaloneSourceBinding(
						consumerBindings,
						sourceSessionId,
						sourceWorkspaceId,
					)
				: undefined;
		if (!recovered) throw error;
		sourceBinding = recovered;
	}
	const cwd =
		agent?.worktreePath ||
		state.sessionCwd[sourceBinding.sessionId] ||
		state.sessionCwd[paneBinding.sessionId] ||
		(typeof params.cwd === "string" ? params.cwd : "") ||
		resolved.cwd;
	if (!cwd) {
		throw new PaneCommandError(
			"invalid_request",
			`pane ${panelId} has no verified working directory`,
		);
	}
	const providerId =
		agent?.provider ??
		state.sessionAgentPin[sourceBinding.sessionId] ??
		state.sessionAgent[sourceBinding.sessionId] ??
		state.sessionAgentPin[paneBinding.sessionId] ??
		state.sessionAgent[paneBinding.sessionId];
	if (!providerId || !supportsStandaloneManagedPromotion(providerId)) {
		throw new PaneCommandError(
			"invalid_request",
			providerId
				? `${providerId} has no reviewed exact-resume conversion adapter`
				: "pane has no detected provider for exact-resume conversion",
		);
	}
	if (
		target === "standalone" &&
		sourceBinding.runtime === "hmux_managed_v1" &&
		!sourceBinding.stopFence
	) {
		throw new PaneCommandError(
			"invalid_request",
			"managed conversion requires the source session's complete stop fence",
		);
	}
	const account = agent ? agentAccount(agent) : undefined;
	if (
		target === "standalone" &&
		sourceBinding.runtime === "hmux_managed_v1" &&
		(sourceBinding.credentialId || agent?.credentialId)
	) {
		throw new PaneCommandError(
			"invalid_request",
			"a managed session with an explicit credential cannot be released to standalone yet",
		);
	}
	const conversionId = hmuxSessionConversionId(panelId, sourceBinding, target);
	let promotion: HmuxManagedAgentPromotion | undefined;
	if (
		target === "managed" &&
		isHmuxProviderSessionSourceBinding(sourceBinding, pane.component) &&
		(pane.component === "terminal" || resolved.panelId !== panelId)
	) {
		try {
			promotion = resolveHmuxManagedAgentPromotion({
				sourcePanelId: panelId,
				conversionId,
				providerId,
				cwd,
				sourceBinding,
				currentBinding:
					consumerBindings.find(
						(binding) => binding?.runtime === "hmux_managed_v1",
					) ?? paneBinding,
				preferredName: requestedAgentName || sourceSessionName,
				terminalEnvironment: { ...(agent?.terminalEnv ?? {}) },
				projects: state.projects,
				detected: state.detected,
				agents: state.agents,
			});
			if (resolved.panelId !== panelId) {
				promotion = { ...promotion, targetPanelId: resolved.panelId };
			}
		} catch (error) {
			if (error instanceof HmuxAgentPanePromotionError) {
				throw new PaneCommandError(
					error.code === "agent_name_conflict"
						? "agent_name_conflict"
						: error.code === "agent_identity_conflict"
							? "agent_identity_conflict"
							: "invalid_request",
					error.message,
				);
			}
			throw error;
		}
	}
	return {
		desktopId: resolved.desktopId,
		panelId,
		resolvedPanelId: resolved.panelId,
		agentId: agent?.id,
		promotion,
		sourceBinding,
		target,
		providerId,
		expectedConversationId: agent?.conversationId,
		cwd,
		conversionId,
		permissionMode: agent
			? effectiveAgentPermissionMode(agent, state.skipPermissions)
			: state.skipPermissions[providerId]
				? "bypass_approvals"
				: "default",
		credentialId:
			target === "managed" ? (agent?.credentialId ?? account?.id) : undefined,
		credentialDirectory: target === "managed" ? account?.dir : undefined,
		credentialGeneration:
			target === "managed" && sourceBinding.runtime === "hmux_managed_v1"
				? sourceBinding.credentialGeneration
				: undefined,
		terminalEnvironment: { ...(agent?.terminalEnv ?? {}) },
	};
}

export async function executeHmuxSessionConversion(
	inspection: HmuxSessionConversionInspection,
	confirmed: boolean,
): Promise<HmuxSessionConversionReceipt> {
	return hmux.convertSession({
		conversionId: inspection.conversionId,
		sourceSessionId: inspection.sourceBinding.sessionId,
		sourceWorkspaceId: inspection.sourceBinding.workspaceId,
		expectedSourceFence:
			inspection.sourceBinding.runtime === "hmux_managed_v1"
				? inspection.sourceBinding.stopFence
				: undefined,
		target: inspection.target,
		providerId: inspection.providerId,
		expectedConversationId: inspection.expectedConversationId,
		cwd: inspection.cwd,
		confirmed,
		permissionMode: inspection.permissionMode,
		credentialId: inspection.credentialId,
		credentialDirectory: inspection.credentialDirectory,
		credentialGeneration: inspection.credentialGeneration,
		rows: 30,
		columns: 120,
		terminalEnvironment: inspection.terminalEnvironment,
		terminalDefaultColors: currentTerminalDefaultColors(),
	});
}

function replacementBinding(
	inspection: HmuxSessionConversionInspection,
	receipt: HmuxSessionConversionReceipt,
	replacement: HmuxSessionSummary,
): ConvertibleHmuxBinding {
	if (inspection.target === "standalone") {
		return hmuxStandaloneBinding(
			replacement.sessionId,
			replacement.workspaceId,
		);
	}
	const idempotencyKey = receipt.replacementIdempotencyKey?.trim();
	if (!idempotencyKey) {
		throw new PaneCommandError(
			"pane_changed",
			"managed conversion receipt lost its idempotency identity",
		);
	}
	if (!replacement.stopFence) {
		throw new PaneCommandError(
			"pane_changed",
			"managed conversion receipt lost its durable stop fence",
		);
	}
	return {
		...hmuxManagedBinding(
			replacement.sessionId,
			replacement.workspaceId,
			inspection.credentialId,
			inspection.credentialGeneration,
			replacement.stopFence,
		),
		createIdempotencyKey: idempotencyKey,
	};
}

export function hmuxSessionConversionSyncPayload(
	inspection: HmuxSessionConversionInspection,
	receipt: HmuxSessionConversionReceipt,
): HmuxSessionConversionSyncPayload {
	const replacement = receipt.replacementSession;
	const conversationId = receipt.conversationId?.trim();
	if (
		receipt.outcome !== "converted" ||
		receipt.sourceSessionId !== inspection.sourceBinding.sessionId ||
		receipt.sourceWorkspaceId !== inspection.sourceBinding.workspaceId ||
		receipt.targetClass !== inspection.target ||
		!replacement ||
		replacement.sessionClass !== inspection.target ||
		replacement.lifecycle !== "ready" ||
		!conversationId
	) {
		throw new PaneCommandError(
			"pane_changed",
			"Hmux conversion receipt does not match the fenced pane",
		);
	}
	return {
		schemaVersion: 1,
		desktopId: inspection.desktopId,
		panelId: inspection.panelId,
		agentId: inspection.promotion?.agentId ?? inspection.agentId,
		promotion: inspection.promotion,
		providerId: inspection.providerId,
		cwd: inspection.cwd,
		conversationId,
		sourceBinding: inspection.sourceBinding,
		binding: replacementBinding(inspection, receipt, replacement),
	};
}

function applyAgentBinding(
	agent: Agent,
	payload: HmuxSessionConversionSyncPayload,
): Agent {
	return {
		...agent,
		sessionId: payload.binding.sessionId,
		runtimeBinding: payload.binding,
		conversationId: payload.conversationId,
		started: true,
		pendingCredentialSwitch: undefined,
		pendingCmd: providerRunCmd(payload.providerId, {
			convId: payload.conversationId,
		}),
	};
}

const TERMINAL_ENVIRONMENT_KEYS = new Set([
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"FORCE_COLOR",
]);

function validTerminalEnvironment(
	value: unknown,
): value is TerminalEnvironment {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).every(
		([key, entry]) =>
			TERMINAL_ENVIRONMENT_KEYS.has(key) &&
			(typeof entry === "string" || entry === null),
	);
}

function validManagedAgentPromotion(
	value: unknown,
	panelId: string,
	sourceBinding: ConvertibleHmuxBinding,
	binding: ConvertibleHmuxBinding,
): value is HmuxManagedAgentPromotion {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!isHmuxProviderSessionSourceBinding(sourceBinding, "terminal") ||
		binding.runtime !== "hmux_managed_v1"
	) {
		return false;
	}
	const promotion = value as Partial<HmuxManagedAgentPromotion>;
	return (
		typeof promotion.agentId === "string" &&
		promotion.agentId.startsWith("agent-") &&
		typeof promotion.agentName === "string" &&
		promotion.agentName.trim() === promotion.agentName &&
		promotion.agentName.length > 0 &&
		!promotion.agentName.includes("/") &&
		typeof promotion.projectId === "string" &&
		promotion.projectId.length > 0 &&
		typeof promotion.branch === "string" &&
		promotion.sourcePanelId === panelId &&
		(promotion.targetPanelId === panelId ||
			promotion.targetPanelId === `agent:${promotion.agentId}`) &&
		promotion.conversionId ===
			hmuxSessionConversionId(panelId, sourceBinding, "managed") &&
		validTerminalEnvironment(promotion.terminalEnvironment)
	);
}

function agentMatchesConversion(
	agent: Agent,
	payload: HmuxSessionConversionSyncPayload,
): boolean {
	const binding = convertibleBinding(agent.runtimeBinding);
	if (
		agent.provider !== payload.providerId ||
		agent.worktreePath !== payload.cwd ||
		(agent.conversationId !== undefined &&
			agent.conversationId.trim() !== payload.conversationId) ||
		(!sameHmuxConversionBinding(binding, payload.sourceBinding) &&
			!sameHmuxConversionBinding(binding, payload.binding))
	) {
		return false;
	}
	const promotion = payload.promotion;
	if (!promotion) return true;
	const credentialId =
		payload.binding.runtime === "hmux_managed_v1"
			? payload.binding.credentialId
			: undefined;
	return (
		agent.id === promotion.agentId &&
		agent.name === promotion.agentName &&
		agent.projectId === promotion.projectId &&
		agent.branch === promotion.branch &&
		agent.sessionId === binding?.sessionId &&
		agent.credentialId === credentialId &&
		sameTerminalEnvironment(agent.terminalEnv, promotion.terminalEnvironment)
	);
}

function createPromotedAgent(
	payload: HmuxSessionConversionSyncPayload,
	promotion: HmuxManagedAgentPromotion,
): Agent {
	const credentialId =
		payload.binding.runtime === "hmux_managed_v1"
			? payload.binding.credentialId
			: undefined;
	return {
		id: promotion.agentId,
		name: promotion.agentName,
		provider: payload.providerId,
		projectId: promotion.projectId,
		worktreePath: payload.cwd,
		branch: promotion.branch,
		sessionId: payload.binding.sessionId,
		sessionKind: "pty",
		runtimeBinding: payload.binding,
		started: true,
		pendingCmd: providerRunCmd(payload.providerId, {
			convId: payload.conversationId,
		}),
		terminalEnv: { ...promotion.terminalEnvironment },
		accountId: credentialId ? undefined : null,
		credentialId,
		conversationId: payload.conversationId,
	};
}

function projectConversionAgents(
	agents: readonly Agent[],
	payload: HmuxSessionConversionSyncPayload,
): Agent[] | undefined {
	if (!payload.agentId) return [...agents];
	const current = agents.find((candidate) => candidate.id === payload.agentId);
	if (current && !agentMatchesConversion(current, payload)) return undefined;
	if (!payload.promotion) {
		if (!current) return undefined;
		return agents.map((candidate) =>
			candidate.id === payload.agentId
				? applyAgentBinding(candidate, payload)
				: candidate,
		);
	}
	if (
		agents.some(
			(candidate) =>
				candidate.id !== payload.agentId &&
				candidate.projectId === payload.promotion?.projectId &&
				candidate.name === payload.promotion.agentName,
		)
	) {
		return undefined;
	}
	if (!current) {
		if (
			payload.promotion.agentId !==
			hmuxManagedPromotionAgentId(payload.promotion.conversionId)
		) {
			return undefined;
		}
		return [...agents, createPromotedAgent(payload, payload.promotion)];
	}
	return agents.map((candidate) =>
		candidate.id === payload.agentId
			? applyAgentBinding(candidate, payload)
			: candidate,
	);
}

export function applyHmuxSessionConversionSync(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Partial<HmuxSessionConversionSyncPayload>;
	const sourceBinding = convertibleBinding(payload.sourceBinding);
	const binding = convertibleBinding(payload.binding);
	const validDirection =
		sourceBinding &&
		binding &&
		!sameHmuxConversionBinding(sourceBinding, binding) &&
		(binding.runtime === "hmux_managed_v1"
			? isHmuxProviderSessionSourceBinding(
					sourceBinding,
					payload.promotion ? "terminal" : undefined,
				)
			: sourceBinding.runtime === "hmux_managed_v1");
	const promotion =
		payload.promotion === undefined
			? undefined
			: sourceBinding &&
					binding &&
					validManagedAgentPromotion(
						payload.promotion,
						String(payload.panelId ?? ""),
						sourceBinding,
						binding,
					)
				? payload.promotion
				: null;
	if (
		payload.schemaVersion !== 1 ||
		!payload.desktopId ||
		!payload.panelId ||
		!payload.providerId ||
		!payload.cwd ||
		!payload.conversationId ||
		!supportsStandaloneManagedPromotion(payload.providerId) ||
		!sourceBinding ||
		!binding ||
		!validDirection ||
		(sourceBinding.runtime === "hmux_managed_v1" &&
			binding.runtime === "hmux_managed_v1" &&
			promotion === undefined) ||
		promotion === null
	) {
		return false;
	}
	const validPayload = {
		...payload,
		sourceBinding,
		binding,
		promotion,
	} as HmuxSessionConversionSyncPayload;
	const state = useStore.getState();
	const projectedAgents = projectConversionAgents(state.agents, validPayload);
	if (!projectedAgents) return false;
	const projected = projectHmuxConversionLayout(
		state.layouts[validPayload.desktopId],
		validPayload,
	);
	if (projected.state === "conflict") return false;
	useStore.setState((current) => {
		const sessionCwd = { ...current.sessionCwd };
		delete sessionCwd[validPayload.sourceBinding.sessionId];
		sessionCwd[validPayload.binding.sessionId] = validPayload.cwd;
		return {
			agents: projectedAgents,
			agentActivity:
				validPayload.promotion &&
				!current.agentActivity[validPayload.promotion.agentId]
					? {
							...current.agentActivity,
							[validPayload.promotion.agentId]: "waiting",
						}
					: current.agentActivity,
			layouts:
				projected.state === "missing"
					? current.layouts
					: {
							...current.layouts,
							[validPayload.desktopId]: projected.layout,
						},
			sessionCwd,
		};
	});
	return true;
}

export async function retargetConvertedHmuxPane(
	inspection: HmuxSessionConversionInspection,
	receipt: HmuxSessionConversionReceipt,
): Promise<HmuxSessionConversionPaneReceipt> {
	const payload = hmuxSessionConversionSyncPayload(inspection, receipt);
	const resolved = await resolveHmuxConversionPane(
		inspection.sourceBinding.sessionId,
		inspection.panelId,
		inspection.target,
		inspection.sourceBinding.workspaceId,
	);
	const allowedPanelIds = new Set([
		inspection.resolvedPanelId,
		inspection.panelId,
		...(inspection.promotion ? [inspection.promotion.targetPanelId] : []),
	]);
	if (
		resolved.desktopId !== inspection.desktopId ||
		!allowedPanelIds.has(resolved.panelId)
	) {
		throw new PaneCommandError(
			"pane_changed",
			`pane ${inspection.panelId} moved before Hmux conversion handoff`,
		);
	}
	const panel = resolved.api.getPanel(resolved.panelId);
	if (!panel) {
		throw new PaneCommandError(
			"pane_not_found",
			`pane ${inspection.panelId} detached before Hmux conversion handoff`,
		);
	}
	const state = useStore.getState();
	const pane = dockPanelReference(panel);
	const params = pane.params;
	const currentBinding = convertibleBinding(
		bindingFromPane(pane, state.agents, state.projects),
	);
	const paneState = classifyHmuxConversionBinding(
		currentBinding,
		inspection.sourceBinding,
		payload.binding,
	);
	const projectedAgents = projectConversionAgents(state.agents, payload);
	if ((paneState !== "source" && paneState !== "target") || !projectedAgents) {
		throw new PaneCommandError(
			"pane_changed",
			`pane ${inspection.panelId} changed before Hmux conversion handoff`,
		);
	}

	const snapshot = resolved.api.toJSON();
	const projected = projectHmuxConversionLayout(snapshot, payload);
	if (projected.state !== "source" && projected.state !== "target") {
		throw new PaneCommandError(
			"pane_changed",
			`persisted pane ${inspection.panelId} changed before Hmux conversion handoff`,
		);
	}
	useStore.setState((current) => {
		const sessionCwd = { ...current.sessionCwd };
		delete sessionCwd[payload.sourceBinding.sessionId];
		sessionCwd[payload.binding.sessionId] = payload.cwd;
		return {
			agents: projectedAgents,
			agentActivity:
				payload.promotion && !current.agentActivity[payload.promotion.agentId]
					? {
							...current.agentActivity,
							[payload.promotion.agentId]: "waiting",
						}
					: current.agentActivity,
			layouts: {
				...current.layouts,
				[inspection.desktopId]: projected.layout,
			},
			sessionCwd,
		};
	});
	let activePanel = panel;
	if (payload.promotion) {
		if (projected.state === "source") {
			resolved.api.fromJSON(
				projected.layout as Parameters<typeof resolved.api.fromJSON>[0],
				{ reuseExistingPanels: true },
			);
		}
		const promotedPanel = resolved.api.getPanel(
			payload.promotion.targetPanelId,
		);
		if (!promotedPanel) {
			throw new PaneCommandError(
				"pane_changed",
				`Agent pane ${payload.promotion.targetPanelId} was not mounted after Hmux conversion`,
			);
		}
		activePanel = promotedPanel;
	} else if (paneState === "source") {
		panel.api.updateParameters(
			pane.component === "agent"
				? { agentRef: { agentId: agentIdFromPaneParameters(params) } }
				: {
						...params,
						sessionId: payload.binding.sessionId,
						binding: payload.binding,
					},
		);
	}
	activePanel.api.setActive();
	await emit(HMUX_SESSION_CONVERTED_EVENT, payload);
	return {
		desktopId: inspection.desktopId,
		panelId: payload.promotion?.targetPanelId ?? inspection.panelId,
		sessionId: payload.binding.sessionId,
		workspaceId: payload.binding.workspaceId,
		runtime: payload.binding.runtime,
		providerId: payload.providerId,
		conversationId: payload.conversationId,
		cwd: payload.cwd,
	};
}
