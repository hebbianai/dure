import {
	parseAgentChatInput,
	type createAgentChatActionRequests,
} from "./agentChatActionRequests";
import { agentChatErrorMessage } from "./agentChatConnectionError";
import type { AgentChatSessionSnapshot } from "./agentChatSessionView";
import {
	type AgentChatDeliverySubmission,
	type AgentChatSubmission,
	type AgentChatSubmissionStore,
	agentChatSubmissionKey,
	submissionBelongsToRoute,
} from "./agentChatSubmission";
import {
	sameAgentStartTurnIntent,
	type AgentInteractionBindingV1,
} from "./agentConversationContract";
import { t } from "@/lib/i18n";
import type { DureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

interface SubmissionControllerOptions {
	agentId: string;
	interactionSessionId: string;
	client: DureAgentConversationClient;
	submissionStore: AgentChatSubmissionStore;
	actionRequests: Pick<
		ReturnType<typeof createAgentChatActionRequests>,
		"startTurn"
	>;
	getSnapshot: () => AgentChatSessionSnapshot;
	update: (patch: Partial<AgentChatSessionSnapshot>) => void;
	requireConversationAuthority: () => {
		binding: AgentInteractionBindingV1;
		routeAuthority: DureBackendRouteAuthorityV1;
	};
	refresh: () => Promise<void>;
	reconnectAfterActionFailure: (error: unknown) => void;
}

/** Owns pending delivery receipts while the session retains authoritative UI state. */
export class AgentChatSubmissionController {
	private readonly pendingInputs = new Map<
		string,
		{ input: AgentChatSubmission; persisted: boolean }
	>();
	constructor(private readonly options: SubmissionControllerOptions) {}
	private get agentId() {
		return this.options.agentId;
	}
	private get interactionSessionId() {
		return this.options.interactionSessionId;
	}
	private get client() {
		return this.options.client;
	}
	private get submissionStore() {
		return this.options.submissionStore;
	}
	private get actionRequests() {
		return this.options.actionRequests;
	}
	private get snapshot() {
		return this.options.getSnapshot();
	}
	private update(patch: Partial<AgentChatSessionSnapshot>) {
		this.options.update(patch);
	}
	private requireConversationAuthority() {
		return this.options.requireConversationAuthority();
	}
	private refresh() {
		return this.options.refresh();
	}
	private reconnectAfterActionFailure(error: unknown) {
		this.options.reconnectAfterActionFailure(error);
	}
	get pendingSubmissions(): AgentChatSubmission[] {
		return [...this.pendingInputs.values()].map(({ input }) => input);
	}
	get retryableTurn(): AgentChatDeliverySubmission | undefined {
		return this.pendingSubmissions.find(
			(input): input is AgentChatDeliverySubmission => input.kind !== "edit",
		);
	}

	async send(input: string): Promise<void> {
		const parsedInput = parseAgentChatInput(input);
		if (this.retryableTurn || this.snapshot.sending) {
			throw new Error("agent_chat_turn_already_pending");
		}
		const { binding, routeAuthority } = this.requireConversationAuthority();
		const turn: AgentChatDeliverySubmission = {
			agentId: this.agentId,
			kind: "start",
			routeAuthority,
			request: this.actionRequests.startTurn(binding.runtime, parsedInput),
		};
		this.pendingInputs.set(agentChatSubmissionKey(turn), {
			input: turn,
			persisted: false,
		});
		await this.submitTurn(turn);
	}

	async queueMessage(input: string): Promise<void> {
		const parsedInput = parseAgentChatInput(input);
		if (this.snapshot.sending)
			throw new Error("agent_chat_turn_already_pending");
		const { binding, routeAuthority } = this.requireConversationAuthority();
		const turn: AgentChatDeliverySubmission = {
			agentId: this.agentId,
			kind: "enqueue",
			routeAuthority,
			request: this.actionRequests.startTurn(binding.runtime, parsedInput),
		};
		this.pendingInputs.set(agentChatSubmissionKey(turn), {
			input: turn,
			persisted: false,
		});
		await this.submitTurn(turn);
	}

	async dequeueMessage(
		clientMessageId: string,
		restore?: (input: string) => boolean,
	): Promise<string> {
		const { routeAuthority } = this.requireConversationAuthority();
		const request = {
			schemaVersion: 1 as const,
			interactionSessionId: this.interactionSessionId,
			clientMessageId,
		};
		let edit = this.pendingSubmissions.find(
			(input) =>
				input.kind === "edit" &&
				input.request.clientMessageId === clientMessageId,
		);
		if (this.snapshot.sending)
			throw new Error("agent_chat_turn_already_pending");
		this.update({ sending: true, actionError: undefined });
		try {
			if (edit && !submissionBelongsToRoute(edit, routeAuthority))
				throw new Error("agent_chat_queue_edit_backend_changed");
			if (restore) {
				const observed = await this.client.inspectInput(
					request,
					routeAuthority,
				);
				if (
					observed?.kind !== "queued" ||
					(edit && !sameAgentStartTurnIntent(edit.request, observed.intent))
				)
					throw new Error("agent_chat_queue_edit_input_unavailable");
				edit ??= {
					agentId: this.agentId,
					kind: "edit",
					routeAuthority,
					request: observed.intent,
				};
				// Persist the original before cancellation can remove it from the queue.
				await this.submissionStore.put(edit);
				this.pendingInputs.set(agentChatSubmissionKey(edit), {
					input: edit,
					persisted: true,
				});
				this.update({});
			}
			const receipt = await this.client.cancelQueuedTurn(
				request,
				routeAuthority,
			);
			if (edit && !sameAgentStartTurnIntent(edit.request, receipt.intent))
				throw new Error("agent_chat_queue_edit_input_unavailable");
			if (!restore || restore(receipt.intent.input)) {
				if (edit) {
					await this.submissionStore.remove(edit);
					this.pendingInputs.delete(agentChatSubmissionKey(edit));
				}
			}
			return receipt.intent.input;
		} catch (error) {
			this.update({ actionError: agentChatErrorMessage(error) });
			this.reconnectAfterActionFailure(error);
			throw error;
		} finally {
			this.update({ sending: false });
			await this.refresh();
		}
	}

	async retryTurn(): Promise<void> {
		const { routeAuthority } = this.requireConversationAuthority();
		const turn = this.retryableTurn;
		if (!turn || this.snapshot.sending)
			throw new Error("agent_chat_turn_retry_unavailable");
		this.update({ sending: true });
		try {
			if (await this.confirmSubmission(turn, routeAuthority)) {
				this.update({
					sending: false,
					retryTurnAvailable: !!this.retryableTurn,
					actionError: undefined,
				});
				await this.refresh();
				return;
			}
			await this.submitTurn(turn);
		} catch (error) {
			this.update({
				sending: false,
				retryTurnAvailable: !!this.retryableTurn,
				actionError: agentChatErrorMessage(error),
			});
			this.reconnectAfterActionFailure(error);
			throw error;
		}
	}

	async editRetryableTurn(restore: (input: string) => void): Promise<void> {
		if (this.snapshot.sending) return;
		const turn = this.retryableTurn;
		if (!turn) return;
		this.update({ sending: true });
		try {
			// Transfer the text synchronously before retiring its recovery record.
			// A window move can then capture the restored draft during persistence.
			restore(turn.request.input);
			await this.submissionStore.remove(turn);
			this.pendingInputs.delete(agentChatSubmissionKey(turn));
			this.update({
				retryTurnAvailable: !!this.retryableTurn,
				actionError: this.retryableTurn
					? t("ipc.agentConversation.deliveryUnconfirmed")
					: undefined,
			});
		} catch (error) {
			this.update({ actionError: agentChatErrorMessage(error) });
			throw error;
		} finally {
			this.update({ sending: false });
		}
	}

	mergePendingInputs(inputs: AgentChatSubmission[]): void {
		const stored = new Set(inputs.map(agentChatSubmissionKey));
		// Replace persisted projections, retaining originals that never reached storage.
		if (!this.snapshot.sending) {
			for (const [key, entry] of this.pendingInputs)
				if (entry.persisted && !stored.has(key)) this.pendingInputs.delete(key);
		}
		for (const input of inputs)
			this.pendingInputs.set(agentChatSubmissionKey(input), {
				input,
				persisted: true,
			});
		this.update({});
	}

	async confirmSubmission(
		input: AgentChatSubmission,
		authority: DureBackendRouteAuthorityV1,
	): Promise<boolean> {
		if (!submissionBelongsToRoute(input, authority)) return false;
		const observation = await this.client.inspectInput(
			{
				schemaVersion: 1,
				interactionSessionId: input.request.interactionSessionId,
				clientMessageId: input.request.clientMessageId,
			},
			authority,
		);
		if (
			!observation ||
			observation.kind !== (input.kind === "start" ? "turn" : "queued") ||
			!sameAgentStartTurnIntent(input.request, observation.intent) ||
			(observation.kind === "turn" && observation.state !== "accepted") ||
			(input.kind === "edit" && observation.state !== "dispatched")
		)
			return false;
		await this.submissionStore.remove(input);
		this.pendingInputs.delete(agentChatSubmissionKey(input));
		return true;
	}

	private async submitTurn(turn: AgentChatDeliverySubmission): Promise<void> {
		this.update({
			sending: true,
			retryTurnAvailable: false,
			actionError: undefined,
		});
		try {
			await this.submissionStore.put(turn);
			this.pendingInputs.set(agentChatSubmissionKey(turn), {
				input: turn,
				persisted: true,
			});
			let state: "prepared" | "accepted" | "failed" | "uncertain";
			if (turn.kind === "enqueue") {
				await this.client.enqueueTurn(turn.request, turn.routeAuthority);
				state = "accepted";
			} else {
				state = await this.client.startTurn(turn.request, turn.routeAuthority);
			}
			if (state !== "accepted") {
				throw new DureBackendRequestError(
					"agent_conversation_turn_unconfirmed",
					t("ipc.agentConversation.deliveryUnconfirmed"),
					{ kind: "operation", disposition: "terminal" },
					{ state },
				);
			}
			await this.submissionStore.remove(turn);
			this.pendingInputs.delete(agentChatSubmissionKey(turn));
			this.update({ sending: false, retryTurnAvailable: !!this.retryableTurn });
			await this.refresh();
		} catch (error) {
			this.update({
				sending: false,
				retryTurnAvailable: true,
				actionError: agentChatErrorMessage(error),
			});
			this.reconnectAfterActionFailure(error);
			throw error;
		}
	}
}
