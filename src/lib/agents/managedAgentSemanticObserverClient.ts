import { semanticObserverFailureEvidence } from "@/lib/agents/managedAgentSemanticObserverRetry";
import { isHmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	type HmuxAgentRuntimeState,
	type HmuxProviderConversationIdentity,
	type HmuxStructuredTerminalAttachReceipt,
	hmux,
} from "@/lib/ipc";
import type { StructuredTerminalCarrierRecord } from "@/lib/terminal/structuredTerminalRecord";
import { attachStructuredTerminalRecords } from "@/lib/terminal/structuredTerminalRecordAdapter";
import type { AgentRuntimeBindingV1, SshHostConfig } from "@/types";

export type ManagedAgentRuntimeBinding = Extract<
	AgentRuntimeBindingV1,
	{ runtime: "hmux_managed_v1" }
>;

export interface ManagedAgentSemanticObserverConnection {
	readonly terminalEpoch: string;
	close(): Promise<void>;
}

export interface ManagedAgentSemanticObserverClient {
	connect(request: {
		readonly binding: ManagedAgentRuntimeBinding;
		readonly sshHosts: readonly SshHostConfig[];
		readonly onRuntimeState: (state: HmuxAgentRuntimeState) => void;
		readonly onConversationIdentity: (
			identity: HmuxProviderConversationIdentity,
		) => void;
		readonly onDisconnected: () => void;
	}): Promise<ManagedAgentSemanticObserverConnection>;
}

const REQUIRED_SEMANTIC_CAPABILITIES = [
	"terminal_state_binary_v1",
	"terminal_viewport_projection_v1",
	"agent_runtime_state_v1",
	"provider_conversation_identity_v1",
] as const;
const TERMINAL_INPUT_CAPABILITY = "terminal_input_intent_v1";

function nextObserverId(): string {
	const suffix =
		globalThis.crypto?.randomUUID?.() ??
		`${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `managed-agent-semantic-${suffix}`;
}

function requireExactManagedReceipt(
	receipt: HmuxStructuredTerminalAttachReceipt,
	binding: ManagedAgentRuntimeBinding,
): void {
	if (!receipt.terminalEpoch) {
		throw new Error("managed_agent_semantic_attach_identity_mismatch");
	}
	if (
		binding.stopFence &&
		receipt.terminalEpoch !== binding.stopFence.terminalEpoch
	) {
		throw new Error("managed_agent_semantic_attach_generation_changed");
	}
	if (binding.source === "local") {
		const session = receipt.session;
		if (
			!session ||
			session.sessionId !== binding.sessionId ||
			session.workspaceId !== binding.workspaceId ||
			session.sessionClass !== "managed" ||
			session.terminalEpoch !== receipt.terminalEpoch
		) {
			throw new Error("managed_agent_semantic_attach_identity_mismatch");
		}
		if (
			binding.stopFence &&
			(!session.stopFence ||
				!sameHmuxManagedGeneration(binding.stopFence, session.stopFence))
		) {
			throw new Error("managed_agent_semantic_attach_generation_changed");
		}
	}
	const selected = new Set(receipt.selectedCapabilities);
	if (REQUIRED_SEMANTIC_CAPABILITIES.some((value) => !selected.has(value))) {
		throw new Error("managed_agent_semantic_projection_unavailable");
	}
	if (selected.has(TERMINAL_INPUT_CAPABILITY)) {
		throw new Error("managed_agent_semantic_attach_authority_mismatch");
	}
}

function recordSemanticObserverFailure(
	binding: ManagedAgentRuntimeBinding,
	cause: unknown,
	phase: string,
): void {
	const failureEvidence = semanticObserverFailureEvidence(cause);
	const extractedCode =
		failureEvidence.code ?? "managed_agent_semantic_attach_failed";
	const terminalFailure = isHmuxSessionFailureError(cause)
		? cause.failure
		: undefined;
	const errorType =
		cause instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(cause.name)
			? cause.name
			: "unknown";
	void hmux
		.appendConnectionDiagnostics([
			{
				timestamp: new Date().toISOString(),
				event: "managed_agent_semantic_observer",
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				paneId: "main-window-semantic-observer",
				runtime: binding.runtime,
				state: "error",
				code:
					extractedCode === "managed_agent_semantic_attach_failed"
						? `managed_agent_semantic_${phase}_failed`
						: extractedCode,
				details: terminalFailure
					? {
							phase: terminalFailure.phase,
							errorType,
							observationScope: "background",
							correlationId: terminalFailure.correlationId,
							occurredUnixMs: terminalFailure.occurredUnixMs,
						}
					: {
							phase,
							errorType,
							observationScope: "background",
							...(failureEvidence.retryDirective
								? { retryDirective: failureEvidence.retryDirective }
								: {}),
						},
			},
		])
		.catch(() => undefined);
}

/** A read-only consumer of the same structured record stream used by panes. */
async function connectHmuxManagedAgentSemanticObserver(request: {
	readonly binding: ManagedAgentRuntimeBinding;
	readonly sshHosts: readonly SshHostConfig[];
	readonly onRuntimeState: (state: HmuxAgentRuntimeState) => void;
	readonly onConversationIdentity: (
		identity: HmuxProviderConversationIdentity,
	) => void;
	readonly onDisconnected: () => void;
}): Promise<ManagedAgentSemanticObserverConnection> {
	const observerId = nextObserverId();
	const surfaceId = `${observerId}-surface`;
	const abortController = new AbortController();
	let active = true;
	let ready = false;
	let transportClosed = false;
	let disconnected = false;
	let closePromise: Promise<void> | undefined;
	let phase = "initialize";
	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		active = false;
		abortController.abort();
		// Attach can fail after the native boundary accepted it. An unknown unique
		// id is intentionally harmless, so every exit converges through detach.
		closePromise = Promise.resolve()
			.then(() => hmux.detachStructuredTerminal(observerId))
			.catch(() => undefined);
		return closePromise;
	};
	const signalDisconnected = () => {
		transportClosed = true;
		if (!active || !ready || disconnected) return;
		disconnected = true;
		request.onDisconnected();
	};
	const consumeRecord = (
		record: StructuredTerminalCarrierRecord,
		terminalEpoch: string,
	): boolean => {
		if (!active) return false;
		if (record.kind === "failure") {
			throw new Error("managed_agent_semantic_record_invalid");
		}
		if (record.kind === "terminal") return true;
		const semantic = record.record;
		if (semantic.kind === "agent_runtime_state") {
			if (semantic.state.terminalEpoch === terminalEpoch) {
				request.onRuntimeState(semantic.state);
			}
			return true;
		}
		if (semantic.kind === "provider_conversation_identity") {
			const identity = semantic.identity;
			if (identity.terminalEpoch !== terminalEpoch) return true;
			if (
				identity.sessionId !== request.binding.sessionId ||
				identity.workspaceId !== request.binding.workspaceId ||
				(request.binding.stopFence &&
					!sameHmuxManagedGeneration(request.binding.stopFence, identity))
			) {
				throw new Error("managed_agent_semantic_projection_identity_mismatch");
			}
			request.onConversationIdentity(identity);
			return true;
		}
		if (
			semantic.kind === "closed" ||
			(semantic.kind === "control" && semantic.body?.kind === "exit")
		) {
			signalDisconnected();
			return false;
		}
		if (semantic.kind === "control" && semantic.body?.kind === "error") {
			throw new Error("managed_agent_semantic_host_error");
		}
		return true;
	};

	try {
		phase = "attach";
		const attachment = await attachStructuredTerminalRecords({
			observerId,
			surfaceId,
			access: "read_only",
			binding: request.binding,
			sshHosts: request.sshHosts,
			signal: abortController.signal,
			isCurrent: () => active,
		});
		phase = "validate_receipt";
		requireExactManagedReceipt(attachment, request.binding);
		phase = "install_initial_state";
		for (const record of attachment.startDelivery()) {
			if (!consumeRecord(record, attachment.terminalEpoch)) break;
		}
		if (transportClosed) {
			throw new Error("managed_agent_semantic_transport_closed_during_attach");
		}
		ready = true;
		void (async () => {
			while (active) {
				const record = await attachment.readRecord();
				if (!consumeRecord(record, attachment.terminalEpoch)) return;
			}
		})().catch((cause) => {
			if (!active) return;
			recordSemanticObserverFailure(request.binding, cause, "stream");
			signalDisconnected();
			void close();
		});
		return { terminalEpoch: attachment.terminalEpoch, close };
	} catch (cause) {
		recordSemanticObserverFailure(request.binding, cause, phase);
		await close();
		throw cause;
	}
}

export const hmuxManagedAgentSemanticObserverClient: ManagedAgentSemanticObserverClient =
	{
		connect: connectHmuxManagedAgentSemanticObserver,
	};
