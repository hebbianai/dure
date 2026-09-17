import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { parseAgentChatInput } from "@/lib/agents/chat/agentChatActionRequests";
import {
	type PreparedAgentChatDraftTarget,
	parseAgentChatDraftTarget,
} from "@/lib/agents/chat/agentChatDraftInput";
import type { AgentChatDraftMoveReceipt } from "@/lib/agents/chat/agentChatDraftMove";
import {
	type AgentChatDraftMoveRequest,
	parseAgentChatDraftMoveRequest,
} from "@/lib/agents/chat/agentChatDraftMoveRequest";
import type { AgentChatDraftRecoveryRequest } from "@/lib/agents/chat/agentChatDraftTypes";
import {
	type AgentChatPaneDropRequest,
	type AgentChatPaneMoveRequest,
	type AgentChatPaneMoveResult,
	isChatPaneMoveResult,
	parseAgentChatPaneDropRequest,
	parseAgentChatPaneMoveRequest,
} from "@/lib/agents/chat/agentChatPaneDropRequest";
import {
	type DroppedFilePayload,
	MAX_EXTERNAL_DROP_BYTES,
	MAX_EXTERNAL_DROP_FILES,
} from "@/lib/files/externalFileDrop";
import { isRecord } from "@/lib/payloadGuards";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { parseLargeViewSourcePaneOwnerId } from "./largeViewReturnSourceCoordinator";
import {
	type MountedPaneWindow,
	parseMountedPaneWindow,
} from "./mountedPaneWindow";

const COMMAND_EVENT = "dure://agent-session/source-command";
const RESULT_EVENT = "dure://agent-session/source-command-result";
const COMMAND_TIMEOUT_MS = 120_000;

type AgentSessionCredentialCommand =
	| { action: "switch"; targetCredentialId: string | null }
	| { action: "apply_pending" }
	| { action: "cancel_pending" };

type AgentSessionForkPresentationCommand = {
	action: "present_fork";
	forkedAgentId: string;
};

export interface AgentSessionDraftAppendRequest {
	readonly target: PreparedAgentChatDraftTarget;
	readonly owner: MountedPaneWindow;
	readonly text: string;
	readonly attachments: readonly DroppedFilePayload[];
}

type AgentSessionDraftAppendCommand = AgentSessionDraftAppendRequest & {
	action: "append_draft";
};

type AgentSessionDraftMoveCommand = AgentChatDraftMoveRequest & {
	action: "draft_move";
};

type AgentSessionPaneMoveCommand = AgentChatPaneMoveRequest & {
	action: "move_chat_pane";
};
type AgentSessionPaneDropCommand = AgentChatPaneDropRequest & {
	action: "drop_chat_pane";
};

type AgentSessionDraftRecoveryCommand = AgentChatDraftRecoveryRequest & {
	action: "recover_chat_draft";
};

type AgentSessionWindowCommand =
	| AgentSessionDraftRecoveryCommand
	| AgentSessionPaneMoveCommand
	| AgentSessionPaneDropCommand
	| AgentSessionDraftMoveCommand
	| AgentSessionCredentialCommand
	| AgentSessionForkPresentationCommand
	| AgentSessionDraftAppendCommand;

export type AgentSessionCredentialCommandResult =
	| {
			kind: "completed" | "scheduled";
			conversationId: string | null;
	  }
	| { kind: "applied" }
	| { kind: "cancelled"; cancelled: boolean };

export type AgentSessionForkPresentationResult = { kind: "presented" };

export type AgentSessionWindowCommandResult =
	| AgentSessionCredentialCommandResult
	| AgentSessionForkPresentationResult
	| { kind: "drafted" }
	| AgentChatDraftMoveReceipt
	| AgentChatPaneMoveResult;

export type AgentSessionCredentialCommandRequest =
	AgentSessionCredentialCommand & {
		agentId: string;
		sourceWindowLabel: string;
		sourcePaneOwnerId: string;
	};

export type AgentSessionForkPresentationRequest = {
	agentId: string;
	forkedAgentId: string;
	sourceWindowLabel: string;
	sourcePaneOwnerId: string;
};

type CommandPayload = AgentSessionWindowCommand & {
	generation: string;
	agentId: string;
	sourcePaneOwnerId: string;
	replyWindowLabel: string;
	expiresAtMs: number;
};

type ResultPayload =
	| {
			generation: string;
			ok: true;
			result: AgentSessionWindowCommandResult;
	  }
	| { generation: string; ok: false; error: string };

export interface AgentSessionWindowCommandBackend {
	currentWindowLabel(): string;
	listenCommand(listener: (payload: unknown) => void): Promise<() => void>;
	listenResult(listener: (payload: unknown) => void): Promise<() => void>;
	emitCommand(
		targetWindowLabel: string,
		payload: CommandPayload,
	): Promise<void>;
	emitResult(targetWindowLabel: string, payload: ResultPayload): Promise<void>;
}

const backend: AgentSessionWindowCommandBackend = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	listenCommand: (listener) =>
		listenWhenReady<unknown>(
			COMMAND_EVENT,
			(event) => listener(event.payload),
			{
				target: {
					kind: "WebviewWindow",
					label: getCurrentWebviewWindow().label,
				},
			},
		),
	listenResult: (listener) =>
		listenWhenReady<unknown>(RESULT_EVENT, (event) => listener(event.payload), {
			target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label },
		}),
	emitCommand: (targetWindowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: targetWindowLabel },
			COMMAND_EVENT,
			payload,
		),
	emitResult: (targetWindowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: targetWindowLabel },
			RESULT_EVENT,
			payload,
		),
};

function nonEmptyString(value: unknown, maximumLength = 512): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximumLength
	);
}

function parseCommand(value: unknown): CommandPayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	const payload = value as Record<string, unknown>;
	if (
		!nonEmptyString(payload.generation) ||
		!nonEmptyString(payload.agentId) ||
		!nonEmptyString(payload.sourcePaneOwnerId) ||
		!nonEmptyString(payload.replyWindowLabel, 128) ||
		typeof payload.expiresAtMs !== "number" ||
		!Number.isFinite(payload.expiresAtMs)
	) {
		return undefined;
	}
	if (payload.action === "recover_chat_draft") {
		const move = parseAgentChatDraftMoveRequest({
			step: "status",
			transfer: payload.transfer,
		});
		return move &&
			move.transfer.target.identity.agentId === payload.agentId &&
			(payload.intent === "finish" || payload.intent === "cancel") &&
			move.transfer.destination.windowLabel === payload.replyWindowLabel
			? ({ ...payload, transfer: move.transfer } as CommandPayload)
			: undefined;
	}
	if (payload.action === "move_chat_pane") {
		const move = parseAgentChatPaneMoveRequest(payload);
		return move &&
			move.target.identity.agentId === payload.agentId &&
			move.destination.windowLabel === payload.replyWindowLabel
			? ({ ...payload, ...move } as CommandPayload)
			: undefined;
	}
	if (payload.action === "drop_chat_pane") {
		const drop = parseAgentChatPaneDropRequest(payload);
		return drop &&
			drop.transfer.target.identity.agentId === payload.agentId &&
			drop.transfer.source.windowLabel === payload.replyWindowLabel
			? ({ ...payload, ...drop } as CommandPayload)
			: undefined;
	}
	if (payload.action === "draft_move") {
		const move = parseAgentChatDraftMoveRequest(payload);
		return move &&
			move.transfer.target.identity.agentId === payload.agentId &&
			move.transfer.source.windowLabel === payload.replyWindowLabel
			? ({ ...payload, ...move } as CommandPayload)
			: undefined;
	}
	if (payload.action === "append_draft") {
		const draft = parseDraftAppend(payload);
		return draft && draft.target.identity.agentId === payload.agentId
			? ({ ...payload, ...draft } as CommandPayload)
			: undefined;
	}
	if (payload.action === "present_fork") {
		return nonEmptyString(payload.forkedAgentId)
			? (payload as unknown as CommandPayload)
			: undefined;
	}
	if (payload.action === "switch") {
		if (
			payload.targetCredentialId !== null &&
			!nonEmptyString(payload.targetCredentialId)
		) {
			return undefined;
		}
		return payload as unknown as CommandPayload;
	}
	if (
		payload.action !== "apply_pending" &&
		payload.action !== "cancel_pending"
	) {
		return undefined;
	}
	return payload as unknown as CommandPayload;
}

function parseDraftAppend(
	value: AgentSessionDraftAppendRequest | Record<string, unknown>,
): AgentSessionDraftAppendRequest | undefined {
	const target = parseAgentChatDraftTarget(value.target);
	const owner = parseMountedPaneWindow(value.owner);
	if (
		!target ||
		!owner ||
		typeof value.text !== "string" ||
		!Array.isArray(value.attachments) ||
		value.attachments.length > MAX_EXTERNAL_DROP_FILES
	)
		return undefined;
	try {
		parseAgentChatInput(value.text);
	} catch {
		return undefined;
	}
	const attachments: DroppedFilePayload[] = [];
	let totalEncoded = 0;
	for (const file of value.attachments) {
		if (
			!isRecord(file) ||
			!nonEmptyString(file.fileName, 4096) ||
			typeof file.dataB64 !== "string"
		)
			return undefined;
		totalEncoded += file.dataB64.length;
		if (
			totalEncoded >
			4 * Math.ceil(MAX_EXTERNAL_DROP_BYTES / 3) + MAX_EXTERNAL_DROP_FILES * 4
		)
			return undefined;
		attachments.push({ fileName: file.fileName, dataB64: file.dataB64 });
	}
	return { target, owner, text: value.text, attachments };
}

function parseResult(value: unknown): ResultPayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	const payload = value as Record<string, unknown>;
	if (!nonEmptyString(payload.generation) || typeof payload.ok !== "boolean") {
		return undefined;
	}
	if (payload.ok) {
		return payload.result && typeof payload.result === "object"
			? (payload as unknown as ResultPayload)
			: undefined;
	}
	return {
		generation: payload.generation,
		ok: false,
		error: nonEmptyString(payload.error, 4_096)
			? payload.error
			: "source window command failed",
	};
}

function requestAgentSessionWindowCommand(
	request:
		| AgentSessionCredentialCommandRequest
		| (AgentSessionForkPresentationRequest & {
				action: "present_fork";
		  })
		| ((
				| AgentSessionDraftAppendCommand
				| AgentSessionDraftMoveCommand
				| AgentSessionPaneMoveCommand
				| AgentSessionPaneDropCommand
				| AgentSessionDraftRecoveryCommand
		  ) & {
				agentId: string;
				sourceWindowLabel: string;
				sourcePaneOwnerId: string;
		  }),
	transport: AgentSessionWindowCommandBackend,
	now: () => number = Date.now,
): Promise<AgentSessionWindowCommandResult> {
	const generation =
		globalThis.crypto?.randomUUID?.() ??
		`agent-session-${now()}-${Math.random().toString(36).slice(2)}`;
	const expiresAtMs = now() + COMMAND_TIMEOUT_MS;
	let disposed = false;
	let stop: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	return new Promise<AgentSessionWindowCommandResult>((resolve, reject) => {
		const finish = (settle: () => void) => {
			if (disposed) return;
			disposed = true;
			if (timer) clearTimeout(timer);
			stop?.();
			settle();
		};
		timer = setTimeout(
			() =>
				finish(() =>
					reject(new Error("source window command response timed out")),
				),
			COMMAND_TIMEOUT_MS,
		);
		void transport
			.listenResult((candidate) => {
				const result = parseResult(candidate);
				if (!result || result.generation !== generation) return;
				if (!result.ok) {
					finish(() => reject(new Error(result.error)));
					return;
				}
				finish(() => resolve(result.result));
			})
			.then((unlisten) => {
				if (disposed) {
					unlisten();
					return;
				}
				stop = unlisten;
				const { sourceWindowLabel, ...command } = request;
				return transport.emitCommand(sourceWindowLabel, {
					...command,
					generation,
					replyWindowLabel: transport.currentWindowLabel(),
					expiresAtMs,
				});
			})
			.catch((error) => finish(() => reject(error)));
	});
}

export function requestAgentSessionCredentialCommand(
	request: AgentSessionCredentialCommandRequest,
	transport: AgentSessionWindowCommandBackend = backend,
	now: () => number = Date.now,
): Promise<AgentSessionCredentialCommandResult> {
	return requestAgentSessionWindowCommand(request, transport, now).then(
		(result) => result as AgentSessionCredentialCommandResult,
	);
}

export function requestAgentSessionForkPresentation(
	request: AgentSessionForkPresentationRequest,
	transport: AgentSessionWindowCommandBackend = backend,
	now: () => number = Date.now,
): Promise<AgentSessionForkPresentationResult> {
	return requestAgentSessionWindowCommand(
		{ ...request, action: "present_fork" },
		transport,
		now,
	).then((result) => result as AgentSessionForkPresentationResult);
}

export async function requestAgentSessionDraftAppend(
	request: AgentSessionDraftAppendRequest,
	transport: AgentSessionWindowCommandBackend = backend,
	now: () => number = Date.now,
): Promise<{ kind: "drafted" }> {
	const draft = parseDraftAppend(request);
	if (!draft) throw new Error("The chat draft window request is invalid.");
	const result = await requestAgentSessionWindowCommand(
		{
			...draft,
			action: "append_draft",
			agentId: draft.target.identity.agentId,
			sourceWindowLabel: draft.owner.windowLabel,
			sourcePaneOwnerId: `${draft.owner.desktopId}:${draft.owner.paneId}`,
		},
		transport,
		now,
	);
	if (result.kind !== "drafted")
		throw new Error(
			"The chat draft receipt is invalid; delivery is uncertain.",
		);
	return result;
}

export async function requestAgentSessionDraftMove(
	request: AgentChatDraftMoveRequest,
	transport: AgentSessionWindowCommandBackend = backend,
	now: () => number = Date.now,
): Promise<AgentChatDraftMoveReceipt> {
	const move = parseAgentChatDraftMoveRequest(request);
	if (!move) throw new Error("The chat draft transfer request is invalid.");
	const { transfer } = move;
	const result = await requestAgentSessionWindowCommand(
		{
			...move,
			action: "draft_move",
			agentId: transfer.target.identity.agentId,
			sourceWindowLabel: transfer.destination.windowLabel,
			sourcePaneOwnerId: `${transfer.destination.desktopId}:${transfer.source.paneId}`,
		},
		transport,
		now,
	);
	if (
		result.kind !== "draft_move" ||
		result.id !== transfer.id ||
		result.digest !== transfer.digest ||
		!["staged", "moved", "committed", "aborted"].includes(result.status)
	)
		throw new Error(
			"The chat draft transfer receipt is invalid; delivery is uncertain.",
		);
	return result;
}

export async function requestAgentSessionPaneMove(
	request: AgentChatPaneMoveRequest,
	transport: AgentSessionWindowCommandBackend = backend,
): Promise<AgentChatPaneMoveResult> {
	const move = parseAgentChatPaneMoveRequest(request);
	if (!move) throw new Error("The chat pane move request is invalid.");
	const result = await requestAgentSessionWindowCommand(
		{
			...move,
			action: "move_chat_pane",
			agentId: move.target.identity.agentId,
			sourceWindowLabel: move.source.windowLabel,
			sourcePaneOwnerId: `${move.source.desktopId}:${move.source.paneId}`,
		},
		transport,
	);
	if (!isChatPaneMoveResult(result, move.source.paneId))
		throw new Error(
			"The chat pane move receipt is invalid; the outcome is uncertain.",
		);
	return result;
}

export async function requestAgentSessionPaneDrop(
	request: AgentChatPaneDropRequest,
	transport: AgentSessionWindowCommandBackend = backend,
): Promise<AgentChatPaneMoveResult> {
	const drop = parseAgentChatPaneDropRequest(request);
	if (!drop) throw new Error("The chat pane drop request is invalid.");
	const result = await requestAgentSessionWindowCommand(
		{
			...drop,
			action: "drop_chat_pane",
			agentId: drop.transfer.target.identity.agentId,
			sourceWindowLabel: drop.transfer.destination.windowLabel,
			sourcePaneOwnerId: `${drop.transfer.destination.desktopId}:${drop.transfer.source.paneId}`,
		},
		transport,
	);
	if (
		!isChatPaneMoveResult(result, drop.transfer.source.paneId) ||
		result.id !== drop.transfer.id
	)
		throw new Error(
			"The chat pane drop receipt is invalid; the outcome is uncertain.",
		);
	return result;
}

export async function requestAgentSessionDraftRecovery(
	request: AgentChatDraftRecoveryRequest,
	transport: AgentSessionWindowCommandBackend = backend,
): Promise<AgentChatDraftMoveReceipt> {
	const parsed = parseAgentChatDraftMoveRequest({
		step: "status",
		transfer: request.transfer,
	});
	if (!parsed || (request.intent !== "finish" && request.intent !== "cancel"))
		throw new Error("The draft recovery request is invalid.");
	const { transfer } = parsed;
	const result = await requestAgentSessionWindowCommand(
		{
			action: "recover_chat_draft",
			transfer,
			intent: request.intent,
			agentId: transfer.target.identity.agentId,
			sourceWindowLabel: transfer.source.windowLabel,
			sourcePaneOwnerId: `${transfer.source.desktopId}:${transfer.source.paneId}`,
		},
		transport,
	);
	if (
		result.kind !== "draft_move" ||
		result.id !== transfer.id ||
		result.digest !== transfer.digest ||
		!["staged", "moved", "committed", "aborted"].includes(result.status)
	)
		throw new Error(
			"The draft recovery receipt is invalid; the outcome is uncertain.",
		);
	return result;
}

export type AgentSessionWindowCommandExecution =
	| (AgentSessionDraftRecoveryCommand & {
			agentId: string;
			desktopId: string;
			panelId: string;
	  })
	| ((AgentSessionPaneMoveCommand | AgentSessionPaneDropCommand) & {
			agentId: string;
			desktopId: string;
			panelId: string;
	  })
	| (AgentSessionDraftMoveCommand & {
			agentId: string;
			desktopId: string;
			panelId: string;
	  })
	| (AgentSessionCredentialCommand & {
			agentId: string;
			desktopId: string;
			panelId: string;
	  })
	| (AgentSessionForkPresentationCommand & {
			agentId: string;
			desktopId: string;
			panelId: string;
	  })
	| (AgentSessionDraftAppendCommand & {
			agentId: string;
			desktopId: string;
			panelId: string;
	  });

/** Installs commands executed by the window that owns the selected pane. */
export function subscribeAgentSessionWindowCommands(
	execute: (
		command: AgentSessionWindowCommandExecution,
	) => Promise<AgentSessionWindowCommandResult>,
	transport: AgentSessionWindowCommandBackend = backend,
	now: () => number = Date.now,
): () => void {
	let disposed = false;
	let stop: (() => void) | undefined;
	void transport
		.listenCommand((candidate) => {
			const payload = parseCommand(candidate);
			if (!payload || payload.expiresAtMs <= now()) return;
			const source = parseLargeViewSourcePaneOwnerId(payload.sourcePaneOwnerId);
			if (!source) return;
			const command: AgentSessionWindowCommandExecution =
				payload.action === "draft_move" ||
				payload.action === "move_chat_pane" ||
				payload.action === "drop_chat_pane" ||
				payload.action === "recover_chat_draft"
					? { ...payload, desktopId: source.desktopId, panelId: source.panelId }
					: payload.action === "append_draft"
						? {
								action: "append_draft",
								agentId: payload.agentId,
								desktopId: source.desktopId,
								panelId: source.panelId,
								target: payload.target,
								owner: payload.owner,
								text: payload.text,
								attachments: payload.attachments,
							}
						: payload.action === "present_fork"
							? {
									action: "present_fork",
									agentId: payload.agentId,
									desktopId: source.desktopId,
									panelId: source.panelId,
									forkedAgentId: payload.forkedAgentId,
								}
							: payload.action === "switch"
								? {
										action: "switch",
										agentId: payload.agentId,
										desktopId: source.desktopId,
										panelId: source.panelId,
										targetCredentialId: payload.targetCredentialId,
									}
								: {
										action: payload.action,
										agentId: payload.agentId,
										desktopId: source.desktopId,
										panelId: source.panelId,
									};
			void execute(command)
				.then(
					(result) =>
						transport.emitResult(payload.replyWindowLabel, {
							generation: payload.generation,
							ok: true,
							result,
						}),
					(error) =>
						transport.emitResult(payload.replyWindowLabel, {
							generation: payload.generation,
							ok: false,
							error: String(error),
						}),
				)
				.catch(() => {});
		})
		.then((unlisten) => {
			if (disposed) unlisten();
			else stop = unlisten;
		})
		.catch(() => {});
	return () => {
		disposed = true;
		stop?.();
	};
}
