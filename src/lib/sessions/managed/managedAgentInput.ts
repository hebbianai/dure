import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	appendAgentChatDraft,
	type PreparedAgentChatDraftTarget,
	prepareAgentChatDraftTarget,
} from "@/lib/agents/chat/agentChatDraftInput";
import { sendAgentChatMessage } from "@/lib/agents/chat/agentChatSessionRuntime";
import {
	type AgentStructuredInteractionProfileV1,
	normalizeAgentInteractionProfileV1,
} from "@/lib/agents/chat/agentInteractionProfile";
import {
	type HmuxAgentTarget,
	resolveAgentByName,
	resolveHmuxAgentTarget,
} from "@/lib/hmux/identity/hmuxAgentTarget";
import {
	type HmuxExactInputTarget,
	resolveHmuxAgentInputTarget,
	resolveHmuxExactInputTarget,
	revalidateHmuxExactInputTarget,
} from "@/lib/hmux/identity/hmuxExactInputTarget";
import { requireRemoteHmuxAttachGeneration } from "@/lib/hmux/remote/remoteHmuxAttachGeneration";
import { resolveRemoteHmuxStandaloneController } from "@/lib/hmux/remote/remoteHmuxControllerResolution";
import {
	type HmuxCommandInputReceipt,
	type HmuxInitialAgentPromptReceipt,
	hmux,
	remoteHmuxCommandInput,
	remoteHmuxInitialAgentPrompt,
} from "@/lib/ipc";
import {
	type ManagedAgentInputDeliveryState,
	ManagedAgentInputError,
} from "@/lib/sessions/managed/managedAgentInputError";
import { resolveLegacyAgentPaneTarget } from "@/lib/sessions/managed/managedAgentTarget";
import { sameRemoteManagedBinding } from "@/lib/sessions/managed/remoteManagedBindingEquality";
import {
	isRemoteHmuxPaneBinding,
	sameHmuxManagedLaunchBinding,
} from "@/lib/terminal/terminalBinding";
import {
	type AgentPaneSelection,
	resolveNamedAgentPaneSelection,
	revalidateAgentPaneSelection,
} from "@/lib/workspace/pane/agentPaneSelection";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { PaneOwner } from "@/lib/workspace/pane/paneOwnership";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export const MAX_MANAGED_AGENT_INPUT_BYTES = 48 * 1024;

interface PreparedHmuxAgentInput extends PreparedExactHmuxInput {
	kind: "hmux";
}

/** A structured chat agent has no terminal: input is a chat message sent
 * through the same session controller the composer uses. */
interface PreparedStructuredAgentInput {
	kind: "structured";
	agent: Agent;
	selection: AgentPaneSelection;
	profile: AgentStructuredInteractionProfileV1;
	text: string;
	byteLength: number;
}

export type PreparedManagedAgentInput =
	| PreparedHmuxAgentInput
	| PreparedStructuredAgentInput
	| {
			kind: "structured_draft";
			target: PreparedAgentChatDraftTarget;
			targetPanelId?: string;
			text: string;
			byteLength: number;
			enter: false;
	  };

export interface PreparedExactHmuxInput {
	target: HmuxExactInputTarget;
	text: string;
	byteLength: number;
	enter: boolean;
}

export interface ManagedAgentInputResult {
	agentId: string;
	name: string;
	panelId: string;
	sessionId: string;
	workspaceId: string;
	byteLength: number;
	enter: boolean;
	receipt: HmuxCommandInputReceipt;
}

export interface ExactHmuxInputResult extends ManagedAgentInputResult {
	hostId: string;
}

interface StructuredAgentInputResultIdentity {
	agentId: string;
	name: string;
	panelId: string;
	sessionId: string;
	byteLength: number;
}
export type StructuredAgentInputResult = StructuredAgentInputResultIdentity &
	(
		| {
				enter: true;
				receipt: {
					kind: "structured_chat";
					delivery: "sent" | "steered" | "queued";
				};
		  }
		| {
				enter: false;
				receipt: { kind: "structured_chat"; delivery: "drafted" };
		  }
	);

function inputPayload(params: Record<string, unknown>) {
	if (typeof params.text !== "string") {
		throw new PaneCommandError("invalid_request", "text must be a string");
	}
	if (params.enter !== undefined && typeof params.enter !== "boolean") {
		throw new PaneCommandError("invalid_request", "enter must be a boolean");
	}
	const enter = params.enter !== false;
	if (!params.text && !enter) {
		throw new PaneCommandError("invalid_request", "input must not be empty");
	}
	const byteLength =
		new TextEncoder().encode(params.text).byteLength + (enter ? 1 : 0);
	if (byteLength > MAX_MANAGED_AGENT_INPUT_BYTES) {
		throw new ManagedAgentInputError(
			"input_too_large",
			`Hmux input exceeds ${MAX_MANAGED_AGENT_INPUT_BYTES} bytes`,
		);
	}
	return { text: params.text, byteLength, enter };
}

export function prepareManagedAgentInput(
	params: Record<string, unknown>,
): PreparedManagedAgentInput {
	if (typeof params.name !== "string") {
		throw new PaneCommandError("invalid_request", "name is required");
	}
	if (
		params.targetPanelId !== undefined &&
		typeof params.targetPanelId !== "string"
	) {
		throw new PaneCommandError(
			"invalid_request",
			"targetPanelId must be a string",
		);
	}
	const targetPanelId =
		typeof params.targetPanelId === "string" && params.targetPanelId.trim()
			? params.targetPanelId.trim()
			: undefined;
	const agent = resolveAgentByName(params.name);
	const profile = agent.interactionProfile;
	if (params.expectedInteractionProfile !== undefined) {
		const expected = normalizeAgentInteractionProfileV1(
			params.expectedInteractionProfile,
		);
		if (!expected)
			throw new PaneCommandError(
				"invalid_request",
				"The expected interaction profile is invalid.",
			);
		if (
			profile?.kind !== "structured_protocol" ||
			profile.backendProfileId !== expected.backendProfileId ||
			profile.interactionSessionId !== expected.interactionSessionId
		) {
			throw new PaneCommandError(
				"pane_changed",
				"The structured input recipient changed since it was selected.",
			);
		}
	}
	if (profile?.kind === "structured_protocol") {
		const payload = inputPayload(params);
		if (!payload.enter) {
			return {
				kind: "structured_draft",
				target: prepareAgentChatDraftTarget(agent),
				targetPanelId,
				...payload,
				enter: false,
			};
		}
		if (!payload.text.trim()) {
			throw new PaneCommandError(
				"invalid_request",
				"chat input must not be empty",
			);
		}
		return {
			kind: "structured",
			agent,
			selection: resolveNamedAgentPaneSelection(agent.id, targetPanelId),
			profile,
			text: payload.text,
			byteLength: payload.byteLength,
		};
	}
	return {
		kind: "hmux",
		...prepareHmuxInputForTarget(
			resolveHmuxAgentInputTarget(agent.id, targetPanelId),
			params,
		),
	};
}

export function prepareExactHmuxInput(
	params: Record<string, unknown>,
): PreparedExactHmuxInput {
	return prepareHmuxInputForTarget(
		resolveHmuxExactInputTarget(params.target),
		params,
	);
}

/** Validate the final payload while retaining the recipient chosen before
 * asynchronous file preparation. Execution rechecks that exact recipient. */
export function prepareHmuxInputForTarget(
	target: HmuxExactInputTarget,
	params: Record<string, unknown>,
): PreparedExactHmuxInput {
	return { target, ...inputPayload(params) };
}

function rethrowCommandInputFailure(error: unknown): never {
	if (error && typeof error === "object") {
		const failure = error as Record<string, unknown>;
		if (
			typeof failure.code === "string" &&
			failure.code &&
			typeof failure.message === "string"
		) {
			const wrapped = new ManagedAgentInputError(failure.code, failure.message);
			wrapped.deliveryState = commandDeliveryState(failure.deliveryState);
			wrapped.bodyDelivered =
				wrapped.deliveryState === "body_written_submit_unknown";
			throw wrapped;
		}
	}
	throw error;
}

function initialPromptFailure(error: unknown): ManagedAgentInputError | null {
	if (!error || typeof error !== "object") return null;
	const failure = error as Record<string, unknown>;
	if (
		typeof failure.code !== "string" ||
		!failure.code ||
		typeof failure.message !== "string"
	) {
		return null;
	}
	const wrapped = new ManagedAgentInputError(failure.code, failure.message);
	wrapped.deliveryState =
		failure.deliveryState === "not_written" ? "not_written" : "unknown";
	return wrapped;
}

function rethrowInitialAgentPromptFailure(error: unknown): never {
	throw initialPromptFailure(error) ?? error;
}

function notWrittenBeforeDispatch(
	error: unknown,
	fallbackCode: string,
): ManagedAgentInputError {
	const candidate = error as { code?: unknown };
	const wrapped = new ManagedAgentInputError(
		typeof candidate?.code === "string" ? candidate.code : fallbackCode,
		error instanceof Error ? error.message : String(error),
	);
	wrapped.deliveryState = "not_written";
	return wrapped;
}

function commandDeliveryState(value: unknown): ManagedAgentInputDeliveryState {
	return value === "not_written" || value === "body_written_submit_unknown"
		? value
		: "unknown";
}

async function sendLocalCommandInput(
	target: HmuxAgentTarget | HmuxExactInputTarget,
	text: string,
	submit: boolean,
): Promise<HmuxCommandInputReceipt> {
	const binding = target.binding;
	if (binding.source !== "local") {
		throw new PaneCommandError(
			"invalid_request",
			"local Hmux command input requires a local binding",
		);
	}
	const expectedFence =
		binding.runtime === "hmux_managed_v1" ? binding.stopFence : undefined;
	if (binding.runtime === "hmux_managed_v1" && !expectedFence) {
		throw new PaneCommandError(
			"pane_changed",
			"managed Hmux command input requires a complete generation fence",
		);
	}
	const receipt = await hmux
		.commandInput({
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			expectedFence,
			text,
			submit,
		})
		.catch(rethrowCommandInputFailure);
	return receipt;
}

/** Provider-neutral one-shot command input for local Hmux Agents. Callers pass
 * semantic text and submit separately; the shared Hmux client owns ordering,
 * the provider-read boundary, and both final receipts. */
export async function sendHmuxAgentCommandInput(
	agent: Agent,
	text: string,
	submit: boolean,
): Promise<HmuxCommandInputReceipt> {
	const current = resolveHmuxAgentTarget(agent.id);
	const observed = agent.runtimeBinding;
	if (
		(observed?.runtime !== "hmux_managed_v1" &&
			observed?.runtime !== "hmux_standalone_v1") ||
		observed.source !== "local" ||
		observed.hostId !== current.binding.hostId ||
		observed.sessionId !== current.binding.sessionId ||
		observed.workspaceId !== current.binding.workspaceId ||
		current.agent.sessionId !== agent.sessionId
	) {
		throw new PaneCommandError(
			"pane_changed",
			"Hmux Agent binding changed before command input dispatch",
		);
	}
	return sendLocalCommandInput(current, text, submit);
}

/** Delivers the first managed-agent turn as one Host-admitted compound write.
 * This is intentionally separate from ordinary steering and cannot target a
 * standalone session. */
export async function sendHmuxInitialAgentPrompt(
	agent: Agent,
	prompt: string,
): Promise<HmuxInitialAgentPromptReceipt> {
	const launchBinding = agent.runtimeBinding;
	if (launchBinding?.runtime !== "hmux_managed_v1") {
		throw notWrittenBeforeDispatch(
			new Error("initial agent prompt requires a managed Hmux session"),
			"hmux_initial_agent_prompt_requires_managed",
		);
	}

	let current: HmuxAgentTarget;
	try {
		current = resolveHmuxAgentTarget(agent.id);
	} catch (error) {
		throw notWrittenBeforeDispatch(error, "hmux_input_target_unavailable");
	}

	if (isRemoteHmuxPaneBinding(launchBinding)) {
		if (!sameRemoteManagedBinding(current.binding, launchBinding)) {
			throw notWrittenBeforeDispatch(
				new Error("remote managed Hmux generation changed before dispatch"),
				"pane_changed",
			);
		}
		let resolution: Awaited<
			ReturnType<typeof resolveRemoteHmuxStandaloneController>
		>;
		try {
			resolution = await resolveRemoteHmuxStandaloneController(
				useStore.getState().sshHosts,
				launchBinding,
			);
			current = resolveHmuxAgentTarget(agent.id);
		} catch (error) {
			throw notWrittenBeforeDispatch(error, "remote_hmux_session_unavailable");
		}
		if (!sameRemoteManagedBinding(current.binding, launchBinding)) {
			throw notWrittenBeforeDispatch(
				new Error(
					"remote managed Hmux generation changed during route resolution",
				),
				"pane_changed",
			);
		}
		try {
			requireRemoteHmuxAttachGeneration(
				resolution.session,
				launchBinding.stopFence,
			);
		} catch (error) {
			throw notWrittenBeforeDispatch(
				error,
				"remote_hmux_managed_generation_unavailable",
			);
		}
		return remoteHmuxInitialAgentPrompt({
			target: resolution.target,
			session: resolution.session,
			prompt,
		}).catch(rethrowInitialAgentPromptFailure);
	}

	if (
		!sameHmuxManagedLaunchBinding(current.binding, launchBinding) ||
		!launchBinding.stopFence
	) {
		throw notWrittenBeforeDispatch(
			new Error("managed Hmux generation changed before dispatch"),
			"pane_changed",
		);
	}
	return hmux
		.initialAgentPrompt({
			sessionId: launchBinding.sessionId,
			workspaceId: launchBinding.workspaceId,
			expectedFence: launchBinding.stopFence,
			prompt,
		})
		.catch(rethrowInitialAgentPromptFailure);
}

export async function executeManagedAgentInput(
	prepared: PreparedManagedAgentInput,
	draftPane?: PaneOwner,
): Promise<ManagedAgentInputResult | StructuredAgentInputResult> {
	if (prepared.kind === "structured_draft") {
		if (!draftPane)
			throw new PaneCommandError(
				"invalid_request",
				"Draft input requires its observed chat pane.",
			);
		const agent = appendAgentChatDraft(
			prepared.target,
			prepared.text,
			[],
			draftPane,
		);
		return {
			agentId: agent.id,
			name: agent.name,
			panelId: draftPane.panelId,
			sessionId: prepared.target.identity.interactionSessionId,
			byteLength: prepared.byteLength,
			enter: false,
			receipt: { kind: "structured_chat", delivery: "drafted" },
		};
	}
	if (prepared.kind === "structured") {
		revalidateAgentPaneSelection(prepared.selection);
		const { delivery } = await sendAgentChatMessage({
			agentId: prepared.agent.id,
			profile: prepared.profile,
			text: prepared.text,
		});
		return {
			agentId: prepared.agent.id,
			name: prepared.agent.name,
			panelId:
				prepared.selection.kind === "pane"
					? prepared.selection.panelId
					: resolveLegacyAgentPaneTarget(prepared.agent).panelId,
			sessionId: prepared.profile.interactionSessionId,
			byteLength: prepared.byteLength,
			enter: true,
			receipt: { kind: "structured_chat", delivery },
		};
	}
	return executeExactHmuxInput(prepared);
}

export async function executeExactHmuxInput(
	prepared: PreparedExactHmuxInput,
): Promise<ExactHmuxInputResult> {
	let current = revalidateHmuxExactInputTarget(prepared.target);
	let receipt: HmuxCommandInputReceipt;
	if (isRemoteHmuxPaneBinding(current.binding)) {
		const resolution = await resolveRemoteHmuxStandaloneController(
			useStore.getState().sshHosts,
			current.binding,
		);
		current = revalidateHmuxExactInputTarget(prepared.target);
		if (!isRemoteHmuxPaneBinding(current.binding)) {
			throw new PaneCommandError(
				"pane_changed",
				"exact Hmux pane changed while resolving its remote fence",
			);
		}
		requireRemoteHmuxAttachGeneration(
			resolution.session,
			current.binding.runtime === "hmux_managed_v1"
				? current.binding.stopFence
				: undefined,
		);
		receipt = await remoteHmuxCommandInput({
			target: resolution.target,
			session: resolution.session,
			text: prepared.text,
			submit: prepared.enter,
		}).catch(rethrowCommandInputFailure);
	} else {
		receipt = await sendLocalCommandInput(
			current,
			prepared.text,
			prepared.enter,
		);
	}
	if (prepared.enter)
		useAgentAttention.getState().armCompletion(current.agent.sessionId);
	return {
		agentId: current.agent.id,
		name: current.agent.name,
		panelId: current.identity.targetPanelId,
		hostId: current.binding.hostId,
		sessionId: current.binding.sessionId,
		workspaceId: current.binding.workspaceId,
		byteLength: prepared.byteLength,
		enter: prepared.enter,
		receipt,
	};
}
