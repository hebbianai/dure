import {
	type AgentChatInput,
	createAgentChatActionRequests,
	fingerprintAgentChatAnswer,
	parseAgentChatInput,
} from "@/lib/agents/chat/agentChatActionRequests";
import {
	agentChatErrorMessage,
	shouldReconnectAgentChat,
} from "@/lib/agents/chat/agentChatConnectionError";
import {
	activeAgentChatTurn,
	convergeAgentChatDelta,
	convergeAgentChatHistory,
	convergeAgentChatPage,
} from "@/lib/agents/chat/agentChatProjection";
import {
	type AgentChatRuntimeInvalidationListener,
	AgentChatRuntimeInvalidationRelay,
} from "@/lib/agents/chat/agentChatRuntimeInvalidationRelay";
import type { AgentChatSessionSnapshot } from "@/lib/agents/chat/agentChatSessionView";
import type {
	AgentGoalUpdateV1,
	AgentPendingRequestV1,
	AgentTimelinePageV1,
	AgentTimelineReadV1,
} from "@/lib/agents/chat/agentConversationContract";
import type {
	AgentConversationAnswerPendingV1,
	AgentConversationInterruptTurnV1,
	AgentConversationInvalidationV1,
	AgentConversationStartTurnV1,
	AgentConversationSubscriptionV1,
	DureAgentConversationClient,
} from "@/lib/ipc/dureAgentConversation";
import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

const TIMELINE_TAIL_ROWS = 128;
type TimerHandle = ReturnType<typeof setTimeout> | number;
type AgentChatReconnectPlan = "backoff" | "reobserve" | "recover_runtime";

interface ConversationEffectLease<Request> {
	request: Request;
	routeAuthority: DureBackendRouteAuthorityV1;
}

interface RetryablePendingAnswer
	extends ConversationEffectLease<AgentConversationAnswerPendingV1> {
	answerFingerprint: string;
}

export interface AgentChatSessionControllerOptions {
	agentId: string;
	interactionSessionId: string;
	client: DureAgentConversationClient;
	now?: () => number;
	id?: (scope: string) => string;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (timer: TimerHandle) => void;
}

export class AgentChatSessionController {
	private readonly agentId: string;
	private readonly interactionSessionId: string;
	private readonly client: DureAgentConversationClient;
	private readonly id: (scope: string) => string;
	private readonly actionRequests: ReturnType<
		typeof createAgentChatActionRequests
	>;
	private readonly setTimer: AgentChatSessionControllerOptions["setTimer"];
	private readonly clearTimer: AgentChatSessionControllerOptions["clearTimer"];
	private readonly listeners = new Set<() => void>();
	private readonly runtimeInvalidation =
		new AgentChatRuntimeInvalidationRelay();
	private queued: AgentChatInput[] = [];
	private steerUnsupported = false;
	/** Turn proven dead by a provider_failed action: its provider process is
	 * gone, so no terminal row will ever arrive from it. The projection stops
	 * treating it as active, which unfences send/queue/permission actions —
	 * otherwise a zombie turn deadlocks the whole composer (2026-09-01: a
	 * backend replacement orphaned a codex stream and every escape hatch was
	 * gated on the turn ending). The next send relaunches the provider and the
	 * backend converges the dead turn server-side. */
	private deadTurnId: string | undefined;
	private snapshot: AgentChatSessionSnapshot = {
		phase: "detached",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		retryTurnAvailable: false,
		queuedMessages: [],
		interrupting: false,
		loadingOlder: false,
	};
	private active = false;
	private connectionAttempt = 0;
	private reconnectAttempts = 0;
	private reconnectTimer?: TimerHandle;
	private subscription?: AgentConversationSubscriptionV1;
	private routeAuthority?: DureBackendRouteAuthorityV1;
	private refreshRequested = false;
	private refreshing?: Promise<void>;
	private loadingOlder?: Promise<void>;
	private retainExpandedHistory = false;
	private retryableTurn?: ConversationEffectLease<AgentConversationStartTurnV1>;
	private readonly retryableAnswers = new Map<string, RetryablePendingAnswer>();
	private retryableInterrupt?: ConversationEffectLease<AgentConversationInterruptTurnV1>;

	constructor(options: AgentChatSessionControllerOptions) {
		this.agentId = options.agentId;
		this.interactionSessionId = options.interactionSessionId;
		this.client = options.client;
		this.id = options.id ?? ((scope) => `${scope}-${crypto.randomUUID()}`);
		this.actionRequests = createAgentChatActionRequests({
			interactionSessionId: options.interactionSessionId,
			now: options.now ?? Date.now,
			id: this.id,
		});
		const setTimer = options.setTimer;
		const clearTimer = options.clearTimer;
		this.setTimer = setTimer
			? (callback, delayMs) => setTimer(callback, delayMs)
			: (callback, delayMs) => globalThis.setTimeout(callback, delayMs);
		this.clearTimer = clearTimer
			? (timer) => clearTimer(timer)
			: (timer) => globalThis.clearTimeout(timer);
	}

	async putGoal(update: AgentGoalUpdateV1): Promise<boolean> {
		if (this.snapshot.savingGoal || !this.active || !this.routeAuthority)
			return false;
		const attempt = this.connectionAttempt;
		const authority = this.routeAuthority;
		this.update({ savingGoal: true, goalError: undefined });
		try {
			await this.client.putGoal(
				{
					schemaVersion: 1,
					agentId: this.agentId,
					...update,
					idempotencyKey: this.id("chat-goal"),
					detail: null,
				},
				authority,
			);
			if (!this.active || attempt !== this.connectionAttempt) return false;
			await this.refresh();
			return true;
		} catch (error) {
			if (this.active && attempt === this.connectionAttempt) {
				this.update({
					goalError:
						error instanceof DureBackendRequestError &&
						error.code === "agent_goal_conflict"
							? t("agents.goal.conflict")
							: agentChatErrorMessage(error),
				});
				// Reobserve the actual result/conflict; never repeat the write.
				await this.refresh();
			}
			return false;
		} finally {
			this.update({ savingGoal: false });
		}
	}

	getSnapshot = (): AgentChatSessionSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	subscribeRuntimeInvalidation = (
		listener: AgentChatRuntimeInvalidationListener,
	): (() => void) => this.runtimeInvalidation.subscribe(listener);

	start(): void {
		if (this.active) return;
		this.active = true;
		void this.connect();
	}

	stop(): void {
		if (!this.active && this.snapshot.phase === "detached") return;
		this.active = false;
		this.connectionAttempt += 1;
		this.loadingOlder = undefined;
		this.clearReconnectTimer();
		const subscription = this.subscription;
		this.subscription = undefined;
		if (subscription) void subscription.close().catch(() => {});
		this.update({
			phase: "detached",
			reconnecting: false,
			error: undefined,
			loadingOlder: false,
			olderHistoryError: undefined,
		});
	}

	retryConnection(): void {
		if (!this.active) return;
		this.reconnectAttempts = 0;
		this.clearReconnectTimer();
		void this.connect(true);
	}

	loadOlder(): Promise<void> {
		if (this.loadingOlder) return this.loadingOlder;
		this.requireConversationAuthority();
		const requested = this.snapshot.page;
		if (!requested?.hasMore) return Promise.resolve();
		const cursor = requested.rows[0]?.cursor;
		if (!cursor)
			return Promise.reject(new Error("agent_chat_history_cursor_unavailable"));
		const attempt = this.connectionAttempt;
		this.update({ loadingOlder: true, olderHistoryError: undefined });
		const run = this.loadOlderPage(requested, cursor, attempt);
		const operation = run.finally(() => {
			if (this.loadingOlder !== operation) return;
			this.loadingOlder = undefined;
			this.update({ loadingOlder: false });
		});
		this.loadingOlder = operation;
		return operation;
	}

	private async loadOlderPage(
		requested: AgentTimelinePageV1,
		cursor: AgentTimelinePageV1["finalCursor"],
		attempt: number,
	): Promise<void> {
		try {
			const response = await this.client.read({
				schemaVersion: 1,
				interactionSessionId: this.interactionSessionId,
				direction: "before",
				cursor,
				limit: TIMELINE_TAIL_ROWS,
			});
			if (!this.active || attempt !== this.connectionAttempt) return;
			if (response.read.type === "reset") {
				await this.disconnectAndReconnect(
					new Error("agent_chat_timeline_reset_required"),
				);
				return;
			}
			const current = this.snapshot.page;
			if (!current) throw new Error("agent_chat_page_unavailable");
			const page = convergeAgentChatHistory(
				current,
				requested,
				response.read.page,
				{
					agentId: this.agentId,
					interactionSessionId: this.interactionSessionId,
				},
			);
			this.retainExpandedHistory = true;
			this.applyPage(page, response.routeAuthority);
		} catch (error) {
			if (!this.active || attempt !== this.connectionAttempt) return;
			this.update({ olderHistoryError: agentChatErrorMessage(error) });
			this.reconnectAfterActionFailure(error);
			throw error;
		}
	}

	private async recoverAndConnect(
		binding: AgentTimelinePageV1["binding"],
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void> {
		const attempt = ++this.connectionAttempt;
		this.update({
			phase: "connecting",
			reconnecting: true,
			error: undefined,
		});
		try {
			await this.client.recover(binding, routeAuthority);
			if (!this.active || attempt !== this.connectionAttempt) return;
			await this.connect(false);
		} catch (error) {
			if (!this.active || attempt !== this.connectionAttempt) return;
			if (
				error instanceof DureBackendRequestError &&
				(error.code === "agent_conversation_conflict" ||
					error.failure.kind === "authority_changed")
			) {
				await this.connect(false);
				return;
			}
			const reconnect = shouldReconnectAgentChat(error);
			this.update({
				phase: reconnect ? "connecting" : "error",
				reconnecting: reconnect,
				error: agentChatErrorMessage(error),
			});
			if (reconnect) {
				// Recovery is an effect against the inspected binding, not a new
				// authority source. Re-enter inspect on the next attempt so a runtime
				// replacement that completed during backoff can converge directly;
				// if the binding is unchanged, connect will request the same exact
				// recovery again after subscribe proves it is still unavailable.
				this.scheduleReconnect();
			}
		}
	}

	async send(input: string): Promise<void> {
		const parsedInput = parseAgentChatInput(input);
		if (this.retryableTurn || this.snapshot.sending) {
			throw new Error("agent_chat_turn_already_pending");
		}
		const { binding, routeAuthority } = this.requireConversationAuthority();
		this.retryableTurn = {
			routeAuthority,
			request: this.actionRequests.startTurn(binding.runtime, parsedInput),
		};
		await this.submitRetryableTurn();
	}

	/** Tries to deliver the message into the RUNNING turn at the provider's
	 * next tool boundary; any failure parks it in the queue instead, so the
	 * message is never lost. A provider without a mid-turn channel is
	 * remembered and skipped straight to the queue afterwards. */
	async steerOrQueue(input: string): Promise<"steered" | "queued"> {
		const parsedInput = parseAgentChatInput(input);
		const activeTurn = this.snapshot.activeTurn;
		if (!activeTurn || this.steerUnsupported) {
			this.queueParsedMessage(parsedInput);
			return "queued";
		}
		try {
			const { binding, routeAuthority } = this.requireConversationAuthority();
			await this.client.steerTurn(
				this.actionRequests.steerTurn(binding.runtime, activeTurn, parsedInput),
				routeAuthority,
			);
			void this.refresh();
			return "steered";
		} catch (error) {
			if (agentChatErrorMessage(error).includes("steer_unsupported")) {
				this.steerUnsupported = true;
			}
			if (providerFailedAgentChatError(error)) {
				this.deadTurnId = activeTurn.turnId;
				this.update({ activeTurn: undefined });
			}
			this.reconnectAfterActionFailure(error);
			this.queueParsedMessage(parsedInput);
			return "queued";
		}
	}

	queueMessage(input: string): void {
		this.queueParsedMessage(parseAgentChatInput(input));
	}

	private queueParsedMessage(input: AgentChatInput): void {
		this.queued = [...this.queued, input];
		this.update({ queuedMessages: this.queued });
		// The turn may have finished while the user was typing.
		this.maybeDrainQueue();
	}

	/** Removes one queued message (for edit-back or discard); returns it. */
	/** Acknowledges a transient action failure; a parked retryable turn keeps
	 * its banner, since dismissing would abandon the turn silently. */
	dismissActionError(): void {
		if (this.retryableTurn) return;
		this.update({ actionError: undefined });
	}

	dequeueMessage(index: number): string | undefined {
		const removed = this.queued[index];
		if (removed === undefined) return undefined;
		this.queued = this.queued.filter((_, at) => at !== index);
		this.update({ queuedMessages: this.queued });
		return removed;
	}

	private maybeDrainQueue(): void {
		if (
			this.queued.length === 0 ||
			this.snapshot.phase !== "ready" ||
			this.snapshot.activeTurn ||
			this.snapshot.sending ||
			this.retryableTurn
		) {
			return;
		}
		const drained = this.queued;
		this.queued = [];
		this.update({ queuedMessages: this.queued });
		void this.send(drained.join("\n\n")).catch(() => {
			// A failed send that retained its retry intent owns the text; only
			// a send that never formed a turn restores the queue so nothing is
			// silently lost.
			if (!this.retryableTurn) {
				this.queued = [...drained, ...this.queued];
				this.update({ queuedMessages: this.queued });
			}
		});
	}

	async retryTurn(): Promise<void> {
		this.requireConversationAuthority();
		if (!this.retryableTurn || this.snapshot.sending) {
			throw new Error("agent_chat_turn_retry_unavailable");
		}
		await this.submitRetryableTurn();
	}

	editRetryableTurn(): string | undefined {
		if (this.snapshot.sending) return undefined;
		const turn = this.retryableTurn;
		if (!turn) return undefined;
		this.retryableTurn = undefined;
		this.update({ retryTurnAvailable: false, actionError: undefined });
		return turn.request.input;
	}

	async answerPending(requestId: string, answer: unknown): Promise<void> {
		const { routeAuthority } = this.requireConversationAuthority();
		if (this.snapshot.answeringRequestId) {
			throw new Error("agent_chat_pending_answer_busy");
		}
		const pending = this.pendingRequest(requestId);
		const fingerprint = fingerprintAgentChatAnswer(answer);
		if (!fingerprint) throw new Error("agent_chat_pending_answer_invalid");
		let retryable = this.retryableAnswers.get(requestId);
		if (retryable && retryable.answerFingerprint !== fingerprint) {
			throw new Error("agent_chat_pending_answer_retry_mismatch");
		}
		if (!retryable) {
			retryable = {
				answerFingerprint: fingerprint,
				routeAuthority,
				request: this.actionRequests.answerPending(pending, answer),
			};
			this.retryableAnswers.set(requestId, retryable);
		}
		this.update({ answeringRequestId: requestId, actionError: undefined });
		try {
			await this.client.answerPending(
				retryable.request,
				retryable.routeAuthority,
			);
			this.retryableAnswers.delete(requestId);
			this.update({ answeringRequestId: undefined });
			void this.refresh();
		} catch (error) {
			this.update({
				answeringRequestId: undefined,
				actionError: agentChatErrorMessage(error),
			});
			this.reconnectAfterActionFailure(error);
			throw error;
		}
	}

	async interrupt(): Promise<void> {
		if (this.snapshot.interrupting) {
			throw new Error("agent_chat_interrupt_busy");
		}
		const activeTurn = this.snapshot.activeTurn;
		if (!activeTurn) throw new Error("agent_chat_interrupt_unavailable");
		const { binding, routeAuthority } = this.requireConversationAuthority();
		this.retryableInterrupt ??= {
			routeAuthority,
			request: this.actionRequests.interruptTurn(binding.runtime, activeTurn),
		};
		this.update({ interrupting: true, actionError: undefined });
		try {
			await this.client.interruptTurn(
				this.retryableInterrupt.request,
				this.retryableInterrupt.routeAuthority,
			);
			this.retryableInterrupt = undefined;
			this.update({ interrupting: false });
			void this.refresh();
		} catch (error) {
			this.update({
				interrupting: false,
				actionError: agentChatErrorMessage(error),
				...(providerFailedAgentChatError(error)
					? { activeTurn: undefined }
					: {}),
			});
			if (providerFailedAgentChatError(error)) {
				this.deadTurnId = activeTurn.turnId;
				this.maybeDrainQueue();
			}
			this.reconnectAfterActionFailure(error);
			throw error;
		}
	}

	private update(patch: Partial<AgentChatSessionSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of this.listeners) listener();
	}

	private requireConversationAuthority() {
		const binding = this.snapshot.page?.binding;
		const routeAuthority = this.routeAuthority;
		if (!binding || !routeAuthority || this.snapshot.phase !== "ready") {
			throw new Error("agent_chat_binding_unavailable");
		}
		return { binding, routeAuthority };
	}

	private pendingRequest(requestId: string): AgentPendingRequestV1 {
		const pending = this.snapshot.page?.pendingRequests.find(
			(candidate) => candidate.request.requestId === requestId,
		);
		if (!pending) throw new Error("agent_chat_pending_request_unavailable");
		return pending;
	}

	private async submitRetryableTurn(): Promise<void> {
		const turn = this.retryableTurn;
		if (!turn) throw new Error("agent_chat_turn_retry_unavailable");
		this.update({
			sending: true,
			retryTurnAvailable: false,
			actionError: undefined,
		});
		try {
			await this.client.startTurn(turn.request, turn.routeAuthority);
			this.retryableTurn = undefined;
			this.update({ sending: false, retryTurnAvailable: false });
			void this.refresh();
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

	private reconnectAfterActionFailure(error: unknown): void {
		if (!(error instanceof DureBackendRequestError)) return;
		if (error.code === "agent_conversation_runtime_unavailable") {
			void this.disconnectAndReconnect(error, "recover_runtime");
			return;
		}
		if (error.failure.kind === "authority_changed") {
			void this.disconnectAndReconnect(error, "reobserve");
		}
	}

	private async connect(allowRecovery = true): Promise<void> {
		if (!this.active) return;
		const attempt = ++this.connectionAttempt;
		this.loadingOlder = undefined;
		this.clearReconnectTimer();
		this.update({
			phase:
				this.snapshot.page && this.snapshot.phase !== "connecting"
					? "ready"
					: "connecting",
			reconnecting: !!this.snapshot.page,
			error: undefined,
			loadingOlder: false,
			olderHistoryError: undefined,
		});
		let opened: AgentConversationSubscriptionV1 | undefined;
		let inspected:
			| {
					binding: AgentTimelinePageV1["binding"];
					routeAuthority: DureBackendRouteAuthorityV1;
			  }
			| undefined;
		try {
			const inspection = await this.client.inspect(this.agentId);
			if (
				!inspection.binding ||
				inspection.binding.interactionSessionId !== this.interactionSessionId
			) {
				throw new Error("agent_chat_binding_unavailable");
			}
			inspected = {
				binding: inspection.binding,
				routeAuthority: inspection.routeAuthority,
			};
			if (!this.active || attempt !== this.connectionAttempt) return;
			opened = await this.client.subscribe(
				{
					schemaVersion: 1,
					interactionSessionId: this.interactionSessionId,
					direction: "tail",
					cursor: null,
					limit: 128,
				},
				(event) => this.onInvalidation(event),
			);
			if (!this.active || attempt !== this.connectionAttempt) {
				await opened.close();
				return;
			}
			this.applyRead(opened.initial, opened.routeAuthority);
			const previous = this.subscription;
			this.subscription = opened;
			opened = undefined;
			if (previous) void previous.close().catch(() => {});
			this.reconnectAttempts = 0;
			this.update({
				phase: "ready",
				reconnecting: false,
				error: undefined,
				actionError:
					this.retryableTurn ||
					this.retryableAnswers.size > 0 ||
					this.retryableInterrupt
						? this.snapshot.actionError
						: undefined,
			});
		} catch (error) {
			if (opened) void opened.close().catch(() => {});
			if (!this.active || attempt !== this.connectionAttempt) return;
			this.invalidateObservedRuntime();
			const recovery =
				inspected &&
				error instanceof DureBackendRequestError &&
				error.code === "agent_conversation_runtime_unavailable"
					? inspected
					: undefined;
			if (recovery && allowRecovery) {
				await this.recoverAndConnect(recovery.binding, recovery.routeAuthority);
				return;
			}
			const recoveryRequired = !!recovery;
			const reconnect = shouldReconnectAgentChat(error);
			this.update({
				phase: !reconnect
					? "error"
					: recoveryRequired
						? "connecting"
						: !this.snapshot.page
							? "error"
							: this.snapshot.phase === "connecting"
								? "connecting"
								: "ready",
				reconnecting: reconnect,
				error: agentChatErrorMessage(error),
			});
			if (reconnect) this.scheduleReconnect();
		}
	}

	private applyRead(
		read: AgentTimelineReadV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): void {
		if (read.type === "reset") {
			throw new Error("agent_chat_timeline_reset_required");
		}
		const page = convergeAgentChatPage(this.snapshot.page, read.page, {
			agentId: this.agentId,
			interactionSessionId: this.interactionSessionId,
		});
		this.applyPage(page, routeAuthority);
		if (page === read.page) this.retainExpandedHistory = false;
	}

	private applyPage(
		page: AgentTimelinePageV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): void {
		this.routeAuthority = routeAuthority;
		const runtimeGeneration = {
			routeAuthority,
			bindingRevision: page.binding.bindingRevision,
			runtimeGeneration: page.binding.runtime.runtimeGeneration,
			providerEpoch: page.binding.runtime.providerEpoch,
		};
		this.runtimeInvalidation.observe(runtimeGeneration);
		if (
			this.retryableTurn &&
			page.rows.some(
				(row) =>
					row.item.clientMessageId ===
					this.retryableTurn?.request.clientMessageId,
			)
		) {
			this.retryableTurn = undefined;
		}
		for (const requestId of this.retryableAnswers.keys()) {
			if (
				!page.pendingRequests.some(
					(pending) => pending.request.requestId === requestId,
				)
			) {
				this.retryableAnswers.delete(requestId);
			}
		}
		const projectedTurn = activeAgentChatTurn(page);
		// A different (or absent) projected turn means the dead one converged
		// server-side; the fence is only for the exact proven-dead turn id.
		if (this.deadTurnId && projectedTurn?.turnId !== this.deadTurnId) {
			this.deadTurnId = undefined;
		}
		const activeTurn = this.deadTurnId ? undefined : projectedTurn;
		if (
			this.retryableInterrupt &&
			activeTurn?.turnId !== this.retryableInterrupt.request.turnId
		) {
			this.retryableInterrupt = undefined;
		}
		this.update({
			page,
			activeTurn,
			retryTurnAvailable: !!this.retryableTurn,
		});
		this.maybeDrainQueue();
	}

	private onInvalidation(event: AgentConversationInvalidationV1): void {
		if (!this.active) return;
		if (event.kind === "error") {
			void this.disconnectAndReconnect(
				event.error,
				event.error instanceof DureBackendRequestError &&
					event.error.code === "agent_conversation_runtime_unavailable"
					? "reobserve"
					: "backoff",
			);
			return;
		}
		if (event.kind === "changed" && event.kinds.includes("runtime")) {
			void this.disconnectAndReconnect(
				new Error("agent_conversation_runtime_unavailable"),
				"reobserve",
			);
			return;
		}
		if (event.kind === "reset_required" && event.backendReplaced) {
			void this.disconnectAndReconnect(
				new Error("agent_chat_backend_replaced"),
				"reobserve",
			);
			return;
		}
		void this.refresh();
	}

	private invalidateObservedRuntime(): void {
		this.runtimeInvalidation.invalidate();
		// An active turn is a projection of the observed runtime, not durable
		// timeline history. A successful reobserve may project it again.
		this.update({ activeTurn: undefined });
	}

	private refresh(): Promise<void> {
		this.refreshRequested = true;
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => {
			const attempt = this.connectionAttempt;
			try {
				// Batch invalidations delivered in the same WebView task. An event
				// arriving after the read starts still schedules one follow-up read.
				await Promise.resolve();
				while (this.active && this.refreshRequested) {
					this.refreshRequested = false;
					let page = this.snapshot.page;
					if (!page || !this.routeAuthority) {
						throw new Error("agent_chat_page_unavailable");
					}
					let moreNewerRows: boolean;
					do {
						const cursor = page.finalCursor;
						const response = await this.client.read({
							schemaVersion: 1,
							interactionSessionId: this.interactionSessionId,
							direction: "after",
							cursor,
							limit: TIMELINE_TAIL_ROWS,
						});
						if (!this.active || attempt !== this.connectionAttempt) return;
						if (response.read.type === "reset") {
							throw new Error("agent_chat_timeline_reset_required");
						}
						moreNewerRows = response.read.page.hasMore;
						const latest = this.snapshot.page;
						if (
							!latest ||
							latest.finalCursor.epoch !== cursor.epoch ||
							latest.finalCursor.sequence !== cursor.sequence
						) {
							throw new Error("agent_chat_delta_base_changed");
						}
						page = convergeAgentChatDelta(
							latest,
							response.read.page,
							{
								agentId: this.agentId,
								interactionSessionId: this.interactionSessionId,
							},
							this.loadingOlder || this.retainExpandedHistory
								? undefined
								: TIMELINE_TAIL_ROWS,
						);
						this.applyPage(page, response.routeAuthority);
						if (moreNewerRows && page.finalCursor.sequence <= cursor.sequence) {
							throw new Error("agent_chat_delta_cursor_stalled");
						}
					} while (this.active && moreNewerRows);
				}
			} catch (error) {
				if (this.active && attempt === this.connectionAttempt) {
					await this.disconnectAndReconnect(error);
				}
			} finally {
				this.refreshing = undefined;
				if (this.active && this.refreshRequested) void this.refresh();
			}
		})();
		return this.refreshing;
	}

	private async disconnectAndReconnect(
		error: unknown,
		plan: AgentChatReconnectPlan = "backoff",
	): Promise<void> {
		const recovery =
			plan === "recover_runtime" && this.snapshot.page && this.routeAuthority
				? {
						binding: this.snapshot.page.binding,
						routeAuthority: this.routeAuthority,
					}
				: undefined;
		this.invalidateObservedRuntime();
		const attempt = ++this.connectionAttempt;
		this.loadingOlder = undefined;
		const subscription = this.subscription;
		this.subscription = undefined;
		if (subscription) await subscription.close().catch(() => {});
		if (!this.active || attempt !== this.connectionAttempt) return;
		this.update({
			phase:
				plan !== "backoff"
					? "connecting"
					: this.snapshot.page
						? "ready"
						: "error",
			reconnecting: true,
			error: agentChatErrorMessage(error),
			loadingOlder: false,
			olderHistoryError: undefined,
		});
		if (recovery) {
			await this.recoverAndConnect(recovery.binding, recovery.routeAuthority);
		} else if (plan !== "backoff") {
			void this.connect(true);
		} else {
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(reconnect = () => void this.connect()): void {
		if (!this.active || this.reconnectTimer) return;
		// A pane never gives up on its agent. A runtime replacement (model or
		// credential switch) legitimately outlives any fixed attempt budget —
		// a cold provider relay can take longer to boot than a whole backoff
		// ladder — and a session that stops retrying strands a live
		// conversation behind a stale page until the pane is reopened. The
		// DELAY is bounded; the attempts are not.
		const delay = Math.min(
			250 * 2 ** Math.min(this.reconnectAttempts, 4),
			4_000,
		);
		this.reconnectAttempts += 1;
		this.reconnectTimer = this.setTimer?.(() => {
			this.reconnectTimer = undefined;
			reconnect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) this.clearTimer?.(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}
}

/** True when an action failed because the provider process is proven gone —
 * the one failure that makes an open turn permanently unfinishable. */
function providerFailedAgentChatError(error: unknown): boolean {
	return (
		(typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code ===
				"agent_conversation_provider_failed") ||
		agentChatErrorMessage(error).includes("agent_conversation_provider_failed")
	);
}
