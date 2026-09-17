import {
	type AgentExecutionProfileV1,
	parseAgentExecutionProfileV1,
} from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { asRecord } from "@/lib/payloadGuards";
import {
	isProviderEffortSelection,
	isProviderModelSelection,
} from "../../../cli/lib/contracts/provider-launch-selection.mjs";

interface ScheduleTemplate {
	projectId: string;
	providerId: string;
	prompt: string;
	model?: string;
	effort?: string;
	permissionMode?: "default" | "skip_permissions";
	executionProfile?: AgentExecutionProfileV1;
	worktree?: { kind: "dedicated"; baseCommitSha?: string };
}

export interface AutomationSchedule {
	schemaVersion: 1;
	scheduleId: string;
	revision: number;
	name: string;
	enabled: boolean;
	expression: string;
	timezone: string;
	runTemplate: ScheduleTemplate;
	createdAtMs: number;
	updatedAtMs: number;
	deletedAtMs?: number;
}

export type ScheduleDraft = Pick<
	AutomationSchedule,
	"name" | "enabled" | "expression" | "timezone" | "runTemplate"
>;

export interface ScheduleOccurrence {
	schemaVersion: 2;
	scheduleId: string;
	scheduleRevision: number;
	trigger: { kind: "manual" } | { kind: "scheduled"; scheduledForMs: number };
	idempotencyKey: string;
	launchState: "pending" | "started" | "failed";
	run?: {
		runId: string;
		taskId: string;
		dispatchId: string;
		generation: number;
		workspaceId: string;
		completed: boolean;
		blockedBy?: string;
	};
	operationId?: string;
	errorCode?: string;
	createdAtMs: number;
	updatedAtMs: number;
}

export function scheduleContractError(): never {
	throw new DureBackendRequestError(
		"schedule_response_invalid",
		t("automations.invalidResponse"),
		{ kind: "contract" },
	);
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
	);
}

export function parseSchedule(value: unknown): AutomationSchedule {
	const record = asRecord(value);
	const template = asRecord(record?.runTemplate);
	const worktree =
		template?.worktree === undefined ? undefined : asRecord(template.worktree);
	if (
		record?.schemaVersion !== 1 ||
		!text(record.scheduleId) ||
		!integer(record.revision, 1) ||
		!text(record.name) ||
		typeof record.enabled !== "boolean" ||
		!text(record.expression) ||
		!text(record.timezone) ||
		!integer(record.createdAtMs) ||
		!integer(record.updatedAtMs) ||
		(record.deletedAtMs !== undefined && !integer(record.deletedAtMs)) ||
		!template ||
		!text(template.projectId) ||
		!text(template.providerId) ||
		!text(template.prompt) ||
		(template.model !== undefined &&
			!isProviderModelSelection(template.model)) ||
		(template.effort !== undefined &&
			!isProviderEffortSelection(template.effort)) ||
		(template.permissionMode !== undefined &&
			!["default", "skip_permissions"].includes(
				String(template.permissionMode),
			)) ||
		(template.executionProfile !== undefined &&
			!parseAgentExecutionProfileV1(template.executionProfile)) ||
		(template.worktree !== undefined &&
			(worktree?.kind !== "dedicated" ||
				(worktree.baseCommitSha !== undefined &&
					(typeof worktree.baseCommitSha !== "string" ||
						!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(
							worktree.baseCommitSha,
						)))))
	)
		scheduleContractError();
	// Preserve optional execution identity and worktree fields on every edit.
	return record as unknown as AutomationSchedule;
}

export function parseOccurrence(value: unknown): ScheduleOccurrence {
	const record = asRecord(value);
	const trigger = asRecord(record?.trigger);
	const run = record?.run === undefined ? undefined : asRecord(record.run);
	if (
		record?.schemaVersion !== 2 ||
		!text(record.scheduleId) ||
		!integer(record.scheduleRevision, 1) ||
		!text(record.idempotencyKey) ||
		!integer(record.createdAtMs) ||
		!integer(record.updatedAtMs) ||
		!trigger ||
		!(
			trigger.kind === "manual" ||
			(trigger.kind === "scheduled" && integer(trigger.scheduledForMs))
		) ||
		!["pending", "started", "failed"].includes(String(record.launchState)) ||
		(record.operationId !== undefined && !text(record.operationId)) ||
		(record.errorCode !== undefined && !text(record.errorCode)) ||
		(record.launchState === "started" &&
			(!text(record.operationId) || record.errorCode !== undefined)) ||
		(record.launchState === "failed" && !text(record.errorCode)) ||
		(record.launchState === "pending" && record.errorCode !== undefined) ||
		(record.run !== undefined &&
			(!run ||
				!text(run.runId) ||
				!text(run.taskId) ||
				!text(run.dispatchId) ||
				!integer(run.generation, 1) ||
				!text(run.workspaceId) ||
				typeof run.completed !== "boolean" ||
				(run.blockedBy !== undefined && !text(run.blockedBy))))
	)
		scheduleContractError();
	return record as unknown as ScheduleOccurrence;
}

export function occurrenceStatus(occurrence: ScheduleOccurrence): string {
	if (occurrence.run?.completed) return t("automations.reportReceived");
	if (occurrence.run?.blockedBy) return t("automations.awaitingDecision");
	if (occurrence.launchState === "failed") return t("automations.startFailed");
	if (occurrence.launchState === "pending") return t("automations.queued");
	return t("automations.awaitingReport");
}

export function scheduleErrorMessage(error: unknown): string {
	if (
		error instanceof DureBackendRequestError &&
		error.code === "schedule_revision_conflict"
	)
		return t("automations.conflict");
	return error instanceof Error
		? error.message
		: t("automations.requestFailed");
}

export function scheduleDraft(schedule: AutomationSchedule): ScheduleDraft {
	const { name, enabled, expression, timezone, runTemplate } = schedule;
	return {
		name,
		enabled,
		expression,
		timezone,
		runTemplate: structuredClone(runTemplate),
	};
}

export function isScheduleDraftValid(draft: ScheduleDraft): boolean {
	const template = draft.runTemplate;
	return !!(
		draft.name.trim() &&
		draft.expression.trim() &&
		draft.timezone.trim() &&
		template.projectId &&
		template.prompt.trim() &&
		(template.model === undefined ||
			isProviderModelSelection(template.model)) &&
		(template.effort === undefined ||
			isProviderEffortSelection(template.effort))
	);
}

export function newScheduleDraft(): ScheduleDraft {
	return {
		name: "",
		enabled: false,
		expression: "0 9 * * 1-5",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		runTemplate: {
			projectId: "",
			providerId: "claude",
			prompt: "",
		},
	};
}
