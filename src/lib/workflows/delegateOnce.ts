import { nanoid } from "nanoid";
import {
	isHmuxManagedGenerationV1,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import { t } from "@/lib/i18n";
import {
	type DureBackendRouteAuthorityV1,
	parseDureBackendRouteAuthority,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";
import type { DelegateOnceReceiptV1 } from "@/lib/ipc/dureWorkflow";
import { positiveInteger, asRecord as record } from "@/lib/payloadGuards";
import {
	type Agent,
	type HmuxManagedStopFenceV1,
	PROVIDERS,
	type Provider,
} from "@/types";

const STORAGE_KEY = "dure:workflow-delegate-intents:v1";
const MAX_INTENTS = 16;
const MAX_STORAGE_BYTES = 512 * 1024;
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const WORKFLOW_RUN = /^run\.([0-9a-f]{64})$/;
const WORKFLOW_TASK = /^task\.([0-9a-f]{64})$/;
const WORKFLOW_DISPATCH = /^dispatch\.([0-9a-f]{64})$/;
const LEGACY_CORE_CONTRIBUTION_ID = "dure.core.delegate-once";

export interface DelegateOnceIntentStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface DelegateOnceIntentV1 {
	schemaVersion: 1;
	idempotencyKey: string;
	createdAtMs: number;
	desktopId: string;
	coordinator: {
		agentId: string;
		displayName: string;
		projectId: string;
		worktreePath: string;
		branch: string;
		sessionId: string;
		workspaceId: string;
		stopFence: HmuxManagedStopFenceV1;
		bindingGeneration?: number;
	};
	task: { summary: string; instructions: string };
	providerId: Provider;
	target?: ExistingDelegateTargetV1;
	/** Exact non-secret backend route leased before the first backend effect.
	 * Missing only before initial execution or in a legacy route-less journal. */
	routeAuthority?: DureBackendRouteAuthorityV1;
	/** schema-v1 journals written before declarative workflow contributions imply
	 * the bundled core contribution. Every new intent persists this exact input. */
	contributionId?: string;
}

export interface ExistingDelegateTargetContextV1 {
	runId: string;
	taskId: string;
	dispatchId: string;
	generation: number;
	endpointRef: string;
	sessionIdentity: string;
	endpointGeneration: number;
	workerParticipant: string;
	coordinatorParticipant: string;
}

interface ExistingDelegateTargetV1 {
	agentId: string;
	displayName: string;
	projectId: string;
	sessionId: string;
	workspaceId: string;
	providerId: Provider;
	stopFence: HmuxManagedStopFenceV1;
	context?: ExistingDelegateTargetContextV1;
}

export interface NewDelegateOnceIntent {
	desktopId: string;
	coordinator: Agent;
	task: DelegateOnceIntentV1["task"];
	providerId: Provider;
	contributionId: string;
	target?: Agent;
}

function browserStorage(): DelegateOnceIntentStorage | undefined {
	if (typeof globalThis.localStorage === "undefined") return undefined;
	return globalThis.localStorage;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const observed = Object.keys(value);
	return (
		observed.length === keys.length &&
		keys.every((key) => observed.includes(key))
	);
}

function token(value: unknown): value is string {
	return typeof value === "string" && TOKEN.test(value);
}

function domainId(value: unknown): value is string {
	return typeof value === "string" && DOMAIN_ID.test(value);
}

function boundedText(
	value: unknown,
	maximumBytes: number,
	controls: "none" | "lines",
): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		new TextEncoder().encode(value).length > maximumBytes
	) {
		return false;
	}
	return [...value].every((character) => {
		const code = character.charCodeAt(0);
		return code >= 32 && code !== 127
			? true
			: controls === "lines" && (character === "\n" || character === "\t");
	});
}

function plainText(value: unknown, maximumBytes: number): value is string {
	return (
		typeof value === "string" &&
		new TextEncoder().encode(value).length <= maximumBytes &&
		[...value].every((character) => {
			const code = character.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
	);
}

function targetContext(
	value: unknown,
): value is ExistingDelegateTargetContextV1 {
	const candidate = record(value);
	const run =
		typeof candidate?.runId === "string"
			? WORKFLOW_RUN.exec(candidate.runId)
			: null;
	const task =
		typeof candidate?.taskId === "string"
			? WORKFLOW_TASK.exec(candidate.taskId)
			: null;
	const dispatch =
		typeof candidate?.dispatchId === "string"
			? WORKFLOW_DISPATCH.exec(candidate.dispatchId)
			: null;
	return (
		!!candidate &&
		exactKeys(candidate, [
			"runId",
			"taskId",
			"dispatchId",
			"generation",
			"endpointRef",
			"sessionIdentity",
			"endpointGeneration",
			"workerParticipant",
			"coordinatorParticipant",
		]) &&
		!!run &&
		!!task &&
		!!dispatch &&
		run[1] === task[1] &&
		task[1] === dispatch[1] &&
		positiveInteger(candidate.generation) &&
		candidate.endpointGeneration === candidate.generation &&
		[
			candidate.endpointRef,
			candidate.sessionIdentity,
			candidate.workerParticipant,
			candidate.coordinatorParticipant,
		].every(token) &&
		candidate.workerParticipant !== candidate.coordinatorParticipant
	);
}

function existingTarget(value: unknown): value is ExistingDelegateTargetV1 {
	const candidate = record(value);
	return (
		!!candidate &&
		exactKeys(
			candidate,
			candidate.context === undefined
				? [
						"agentId",
						"displayName",
						"projectId",
						"sessionId",
						"workspaceId",
						"providerId",
						"stopFence",
					]
				: [
						"agentId",
						"displayName",
						"projectId",
						"sessionId",
						"workspaceId",
						"providerId",
						"stopFence",
						"context",
					],
		) &&
		domainId(candidate.agentId) &&
		boundedText(candidate.displayName, 512, "none") &&
		domainId(candidate.projectId) &&
		token(candidate.sessionId) &&
		token(candidate.workspaceId) &&
		typeof candidate.providerId === "string" &&
		Object.keys(PROVIDERS).includes(candidate.providerId) &&
		PROVIDERS[candidate.providerId as Provider].workflowDelegate === true &&
		isHmuxManagedGenerationV1(candidate.stopFence) &&
		(candidate.context === undefined || targetContext(candidate.context))
	);
}

function validIntent(value: unknown): value is DelegateOnceIntentV1 {
	const candidate = record(value);
	const coordinator = record(candidate?.coordinator);
	const task = record(candidate?.task);
	const rootKeys = [
		"schemaVersion",
		"idempotencyKey",
		"createdAtMs",
		"desktopId",
		"coordinator",
		"task",
		"providerId",
		...(candidate?.routeAuthority === undefined ? [] : ["routeAuthority"]),
		...(candidate?.contributionId === undefined ? [] : ["contributionId"]),
		...(candidate?.target === undefined ? [] : ["target"]),
	];
	return (
		candidate?.schemaVersion === 1 &&
		exactKeys(candidate, rootKeys) &&
		token(candidate.idempotencyKey) &&
		Number.isSafeInteger(candidate.createdAtMs) &&
		Number(candidate.createdAtMs) >= 0 &&
		domainId(candidate.desktopId) &&
		!!coordinator &&
		exactKeys(
			coordinator,
			coordinator.bindingGeneration === undefined
				? [
						"agentId",
						"displayName",
						"projectId",
						"worktreePath",
						"branch",
						"sessionId",
						"workspaceId",
						"stopFence",
					]
				: [
						"agentId",
						"displayName",
						"projectId",
						"worktreePath",
						"branch",
						"sessionId",
						"workspaceId",
						"stopFence",
						"bindingGeneration",
					],
		) &&
		domainId(coordinator.agentId) &&
		boundedText(coordinator.displayName, 512, "none") &&
		domainId(coordinator.projectId) &&
		plainText(coordinator.worktreePath, 4096) &&
		coordinator.worktreePath.startsWith("/") &&
		plainText(coordinator.branch, 512) &&
		token(coordinator.sessionId) &&
		token(coordinator.workspaceId) &&
		isHmuxManagedGenerationV1(coordinator.stopFence) &&
		(coordinator.bindingGeneration === undefined ||
			positiveInteger(coordinator.bindingGeneration)) &&
		!!task &&
		exactKeys(task, ["summary", "instructions"]) &&
		boundedText(task.summary, 512, "none") &&
		boundedText(task.instructions, 16 * 1024, "lines") &&
		typeof candidate.providerId === "string" &&
		Object.keys(PROVIDERS).includes(candidate.providerId) &&
		PROVIDERS[candidate.providerId as Provider].workflowDelegate === true &&
		(candidate.routeAuthority === undefined ||
			parseDureBackendRouteAuthority(candidate.routeAuthority)?.profileId ===
				"local") &&
		(candidate.contributionId === undefined ||
			domainId(candidate.contributionId)) &&
		(candidate.target === undefined ||
			(existingTarget(candidate.target) &&
				candidate.target.agentId !== coordinator.agentId &&
				candidate.target.providerId === candidate.providerId))
	);
}

function loadIntents(storage = browserStorage()): DelegateOnceIntentV1[] {
	if (!storage)
		throw new Error(t("workflows.delegation.recoveryStoreUnavailable"));
	const raw = storage.getItem(STORAGE_KEY);
	if (!raw) return [];
	if (new TextEncoder().encode(raw).length > MAX_STORAGE_BYTES) {
		throw new Error(t("workflows.delegation.storedRequestTooLarge"));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(t("workflows.delegation.storedRequestUnreadable"));
	}
	const journal = record(parsed);
	if (
		journal?.schemaVersion !== 1 ||
		!exactKeys(journal, ["schemaVersion", "intents"]) ||
		!Array.isArray(journal.intents) ||
		journal.intents.length > MAX_INTENTS ||
		!journal.intents.every(validIntent)
	) {
		throw new Error(t("workflows.delegation.storedRequestInvalidFormat"));
	}
	const agents = new Set<string>();
	const targets = new Set<string>();
	const keys = new Set<string>();
	for (const intent of journal.intents) {
		if (
			agents.has(intent.coordinator.agentId) ||
			keys.has(intent.idempotencyKey) ||
			(intent.target !== undefined && targets.has(intent.target.agentId))
		) {
			throw new Error(t("workflows.delegation.storedRequestIdConflict"));
		}
		agents.add(intent.coordinator.agentId);
		keys.add(intent.idempotencyKey);
		if (intent.target) targets.add(intent.target.agentId);
	}
	return journal.intents;
}

function saveIntents(
	intents: readonly DelegateOnceIntentV1[],
	storage = browserStorage(),
): void {
	if (!storage)
		throw new Error(t("workflows.delegation.recoveryStoreUnavailable"));
	if (intents.length === 0) {
		storage.removeItem(STORAGE_KEY);
		return;
	}
	const serialized = JSON.stringify({ schemaVersion: 1, intents });
	if (new TextEncoder().encode(serialized).length > MAX_STORAGE_BYTES) {
		throw new Error(t("workflows.delegation.requestTooLarge"));
	}
	storage.setItem(STORAGE_KEY, serialized);
	if (storage.getItem(STORAGE_KEY) !== serialized) {
		throw new Error(t("workflows.delegation.requestCommitFailed"));
	}
}

export function readDelegateOnceIntents(
	storage = browserStorage(),
): DelegateOnceIntentV1[] {
	return loadIntents(storage);
}

export function pendingDelegateOnceIntent(
	agentId: string,
	storage = browserStorage(),
): DelegateOnceIntentV1 | undefined {
	return loadIntents(storage).find(
		(intent) => intent.coordinator.agentId === agentId,
	);
}

function exactLocalManagedSessionKey(agent: Agent): string | undefined {
	const binding = agent.runtimeBinding;
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		!binding.stopFence ||
		binding.sessionId !== agent.sessionId ||
		!PROVIDERS[agent.provider].workflowDelegate
	) {
		return undefined;
	}
	const fence = binding.stopFence;
	return [
		binding.sessionId,
		binding.workspaceId,
		fence.runnerPrincipal,
		fence.runnerInstance,
		fence.channelEpoch,
		fence.hostInstanceId,
		fence.terminalEpoch,
	].join("\0");
}

export function eligibleExistingDelegateTargets(
	coordinator: Agent,
	agents: readonly Agent[],
	providers: readonly Provider[],
): Agent[] {
	const sessionCounts = new Map<string, number>();
	for (const agent of agents) {
		const key = exactLocalManagedSessionKey(agent);
		if (key) sessionCounts.set(key, (sessionCounts.get(key) ?? 0) + 1);
	}
	return agents.filter((agent) => {
		const key = exactLocalManagedSessionKey(agent);
		return (
			agent.id !== coordinator.id &&
			agent.workflowDispatch === undefined &&
			providers.includes(agent.provider) &&
			key !== undefined &&
			sessionCounts.get(key) === 1
		);
	});
}

export function beginDelegateOnceIntent(
	input: NewDelegateOnceIntent,
	storage = browserStorage(),
): DelegateOnceIntentV1 {
	const intents = loadIntents(storage);
	const pending = intents.find(
		(intent) => intent.coordinator.agentId === input.coordinator.id,
	);
	if (pending) return pending;
	if (intents.length >= MAX_INTENTS) {
		throw new Error(t("workflows.delegation.tooManyPendingRecovery"));
	}
	const binding = input.coordinator.runtimeBinding;
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		binding.sessionId !== input.coordinator.sessionId ||
		!binding.stopFence
	) {
		throw new Error(t("workflows.delegation.localManagedSessionOnly"));
	}
	let target: ExistingDelegateTargetV1 | undefined;
	if (input.target) {
		const targetBinding = input.target.runtimeBinding;
		if (
			input.target.id === input.coordinator.id ||
			input.target.workflowDispatch !== undefined ||
			input.target.provider !== input.providerId ||
			targetBinding?.runtime !== "hmux_managed_v1" ||
			targetBinding.source !== "local" ||
			targetBinding.sessionId !== input.target.sessionId ||
			!targetBinding.stopFence
		) {
			throw new Error(t("workflows.delegation.selectedAgentNotDurableTarget"));
		}
		if (
			intents.some(
				(candidate) => candidate.target?.agentId === input.target?.id,
			)
		) {
			throw new Error(
				t("workflows.delegation.selectedAgentTaskPendingRecovery"),
			);
		}
		target = {
			agentId: input.target.id,
			displayName: input.target.displayName ?? input.target.name,
			projectId: input.target.projectId,
			sessionId: input.target.sessionId,
			workspaceId: targetBinding.workspaceId,
			providerId: input.target.provider,
			stopFence: targetBinding.stopFence,
		};
	}
	const intent: DelegateOnceIntentV1 = {
		schemaVersion: 1,
		idempotencyKey: `delegate-once-${nanoid(24)}`,
		createdAtMs: Date.now(),
		desktopId: input.desktopId,
		coordinator: {
			agentId: input.coordinator.id,
			displayName: input.coordinator.displayName ?? input.coordinator.name,
			projectId: input.coordinator.projectId,
			worktreePath: input.coordinator.worktreePath,
			branch: input.coordinator.branch,
			sessionId: input.coordinator.sessionId,
			workspaceId: binding.workspaceId,
			stopFence: binding.stopFence,
		},
		task: input.task,
		providerId: input.providerId,
		contributionId: input.contributionId,
		...(target ? { target } : {}),
	};
	if (!validIntent(intent)) {
		throw new Error(t("workflows.delegation.requestInvalidInput"));
	}
	saveIntents([...intents, intent], storage);
	return intent;
}

export function recordExistingDelegateTargetContext(
	intent: DelegateOnceIntentV1,
	context: ExistingDelegateTargetContextV1,
	storage = browserStorage(),
): DelegateOnceIntentV1 {
	if (!intent.target || !targetContext(context)) {
		throw new Error(
			t("workflows.delegation.existingAgentDispatchContextInvalid"),
		);
	}
	const intents = loadIntents(storage);
	const current = intents.find(
		(candidate) => candidate.idempotencyKey === intent.idempotencyKey,
	);
	if (!current?.target) {
		throw new Error(t("workflows.delegation.recoverExistingAgentTaskNotFound"));
	}
	if (
		current.target.context !== undefined &&
		JSON.stringify(current.target.context) !== JSON.stringify(context)
	) {
		throw new Error(
			t("workflows.delegation.selectedAgentDispatchGenerationChanged"),
		);
	}
	const updated: DelegateOnceIntentV1 = {
		...current,
		target: { ...current.target, context },
	};
	saveIntents(
		intents.map((candidate) =>
			candidate.idempotencyKey === updated.idempotencyKey ? updated : candidate,
		),
		storage,
	);
	return updated;
}

export function recordDelegateOnceBinding(
	intent: DelegateOnceIntentV1,
	bindingGeneration: number,
	storage = browserStorage(),
): DelegateOnceIntentV1 {
	if (!positiveInteger(bindingGeneration)) {
		throw new Error(t("workflows.delegation.bindingGenerationInvalid"));
	}
	const intents = loadIntents(storage);
	const current = intents.find(
		(candidate) => candidate.idempotencyKey === intent.idempotencyKey,
	);
	if (!current)
		throw new Error(t("workflows.delegation.recoverRequestNotFound"));
	if (
		current.coordinator.bindingGeneration !== undefined &&
		current.coordinator.bindingGeneration !== bindingGeneration
	) {
		throw new Error(t("workflows.delegation.storedBindingGenerationConflict"));
	}
	const updated: DelegateOnceIntentV1 = {
		...current,
		coordinator: { ...current.coordinator, bindingGeneration },
	};
	saveIntents(
		intents.map((candidate) =>
			candidate.idempotencyKey === updated.idempotencyKey ? updated : candidate,
		),
		storage,
	);
	return updated;
}

export function recordDelegateOnceRouteAuthority(
	intent: DelegateOnceIntentV1,
	authority: DureBackendRouteAuthorityV1,
	storage = browserStorage(),
): DelegateOnceIntentV1 {
	const parsed = parseDureBackendRouteAuthority(authority);
	if (parsed?.profileId !== "local") {
		throw new Error(t("workflows.delegation.storedRequestInvalidFormat"));
	}
	const intents = loadIntents(storage);
	const current = intents.find(
		(candidate) => candidate.idempotencyKey === intent.idempotencyKey,
	);
	if (!current)
		throw new Error(t("workflows.delegation.recoverRequestNotFound"));
	if (
		current.routeAuthority &&
		!sameDureBackendRouteAuthority(current.routeAuthority, parsed)
	) {
		throw new Error(t("ipc.dureBackend.generationChanged"));
	}
	if (current.routeAuthority) return current;
	const updated: DelegateOnceIntentV1 = {
		...current,
		routeAuthority: parsed,
	};
	saveIntents(
		intents.map((candidate) =>
			candidate.idempotencyKey === updated.idempotencyKey ? updated : candidate,
		),
		storage,
	);
	return updated;
}

export function completeDelegateOnceIntent(
	idempotencyKey: string,
	storage = browserStorage(),
): void {
	const intents = loadIntents(storage);
	if (!intents.some((intent) => intent.idempotencyKey === idempotencyKey)) {
		throw new Error(t("workflows.delegation.completeRequestNotFound"));
	}
	saveIntents(
		intents.filter((intent) => intent.idempotencyKey !== idempotencyKey),
		storage,
	);
}

function sameDispatchAgent(left: Agent, right: Agent): boolean {
	const leftBinding = left.runtimeBinding;
	const rightBinding = right.runtimeBinding;
	const leftFence =
		leftBinding?.runtime === "hmux_managed_v1" && leftBinding.source === "local"
			? leftBinding.stopFence
			: undefined;
	const rightFence =
		rightBinding?.runtime === "hmux_managed_v1" &&
		rightBinding.source === "local"
			? rightBinding.stopFence
			: undefined;
	const leftDispatch = left.workflowDispatch;
	const rightDispatch = right.workflowDispatch;
	return (
		left.id === right.id &&
		left.sessionId === right.sessionId &&
		left.provider === right.provider &&
		left.projectId === right.projectId &&
		left.worktreePath === right.worktreePath &&
		leftBinding?.runtime === "hmux_managed_v1" &&
		leftBinding.source === "local" &&
		rightBinding?.runtime === "hmux_managed_v1" &&
		rightBinding.source === "local" &&
		leftBinding.sessionId === rightBinding.sessionId &&
		leftBinding.workspaceId === rightBinding.workspaceId &&
		leftBinding.createIdempotencyKey === rightBinding.createIdempotencyKey &&
		leftFence !== undefined &&
		rightFence !== undefined &&
		sameHmuxManagedGeneration(leftFence, rightFence) &&
		leftDispatch?.schemaVersion === 1 &&
		rightDispatch?.schemaVersion === 1 &&
		leftDispatch.taskId === rightDispatch.taskId &&
		leftDispatch.dispatchId === rightDispatch.dispatchId &&
		leftDispatch.generation === rightDispatch.generation
	);
}

export function projectDelegateOnceWorker(
	intent: DelegateOnceIntentV1,
	receipt: DelegateOnceReceiptV1,
	existingAgents: readonly Agent[],
): { agent: Agent; inserted: boolean } {
	const match = WORKFLOW_DISPATCH.exec(receipt.dispatchId);
	if (
		!match ||
		(receipt.status !== "active" && receipt.status !== "completed") ||
		!receipt.session ||
		!receipt.effectiveLaunchIdempotencyKey ||
		receipt.session.providerId !== intent.providerId ||
		receipt.session.workspaceId !== intent.coordinator.workspaceId
	) {
		throw new Error(t("workflows.delegation.receiptNoAttachableWorker"));
	}
	const digest = match[1];
	const agent: Agent = {
		id: `agent-workflow-${digest}`,
		name: `worker-${digest.slice(0, 12)}`,
		displayName: intent.task.summary,
		provider: receipt.session.providerId,
		projectId: intent.coordinator.projectId,
		worktreePath: intent.coordinator.worktreePath,
		branch: intent.coordinator.branch,
		sessionId: receipt.session.sessionId,
		sessionKind: "pty",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: receipt.session.sessionId,
			workspaceId: receipt.session.workspaceId,
			createIdempotencyKey: receipt.effectiveLaunchIdempotencyKey,
			stopFence: {
				runnerPrincipal: receipt.session.runnerPrincipal,
				runnerInstance: receipt.session.runnerInstance,
				channelEpoch: receipt.session.channelEpoch,
				hostInstanceId: receipt.session.hostInstanceId,
				terminalEpoch: receipt.session.terminalEpoch,
			},
		},
		started: true,
		workflowDispatch: {
			schemaVersion: 1,
			taskId: receipt.taskId,
			dispatchId: receipt.dispatchId,
			generation: receipt.generation,
		},
	};
	const existing = existingAgents.find(
		(candidate) => candidate.id === agent.id,
	);
	const sessionOwner = existingAgents.find(
		(candidate) =>
			candidate.sessionId === agent.sessionId && candidate.id !== agent.id,
	);
	if (sessionOwner) {
		throw new Error(t("workflows.delegation.workerSessionAttachedElsewhere"));
	}
	if (!existing) return { agent, inserted: true };
	if (!sameDispatchAgent(existing, agent)) {
		throw new Error(t("workflows.delegation.workerIdSessionMismatch"));
	}
	return { agent: existing, inserted: false };
}

export function normalizeWorkflowDispatch(
	value: unknown,
): Agent["workflowDispatch"] {
	const candidate = record(value);
	return candidate?.schemaVersion === 1 &&
		typeof candidate.taskId === "string" &&
		WORKFLOW_TASK.test(candidate.taskId) &&
		typeof candidate.dispatchId === "string" &&
		WORKFLOW_DISPATCH.test(candidate.dispatchId) &&
		WORKFLOW_TASK.exec(candidate.taskId)?.[1] ===
			WORKFLOW_DISPATCH.exec(candidate.dispatchId)?.[1] &&
		positiveInteger(candidate.generation)
		? {
				schemaVersion: 1,
				taskId: candidate.taskId,
				dispatchId: candidate.dispatchId,
				generation: candidate.generation,
			}
		: undefined;
}

export const delegateOnceIntentStorageKey = STORAGE_KEY;
export function delegateOnceContributionId(
	intent: DelegateOnceIntentV1,
): string {
	return intent.contributionId ?? LEGACY_CORE_CONTRIBUTION_ID;
}
