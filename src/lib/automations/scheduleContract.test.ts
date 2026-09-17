import { describe, expect, it } from "vitest";
import {
	isScheduleDraftValid,
	newScheduleDraft,
	occurrenceStatus,
	parseOccurrence,
	parseSchedule,
	scheduleDraft,
} from "@/lib/automations/scheduleContract";
import { t } from "@/lib/i18n";

const schedule = {
	schemaVersion: 1,
	scheduleId: "daily",
	revision: 3,
	name: "Daily review",
	enabled: true,
	expression: "0 9 * * 1-5",
	timezone: "UTC",
	createdAtMs: 1,
	updatedAtMs: 2,
	runTemplate: {
		projectId: "dure",
		providerId: "claude",
		prompt: "Review",
		model: "opus",
		effort: "high",
		permissionMode: "default",
		executionProfile: {
			kind: "credential_reference",
			reference_id: "cred_work",
			credential_generation: "g1",
		},
		worktree: { kind: "dedicated", baseCommitSha: "a".repeat(40) },
	},
};
const occurrence = {
	schemaVersion: 2,
	scheduleId: "daily",
	scheduleRevision: 3,
	trigger: { kind: "manual" },
	idempotencyKey: "run-1",
	launchState: "started",
	operationId: "op-1",
	createdAtMs: 1,
	updatedAtMs: 2,
};

describe("schedule contracts", () => {
	it("leaves new schedules on provider permission defaults and preserves explicit overrides", () => {
		const draft = newScheduleDraft();
		expect(draft.runTemplate.permissionMode).toBeUndefined();
		const runTemplate = { ...schedule.runTemplate };
		Reflect.deleteProperty(runTemplate, "permissionMode");
		expect(
			scheduleDraft(parseSchedule({ ...schedule, runTemplate })).runTemplate
				.permissionMode,
		).toBeUndefined();
		expect(
			scheduleDraft(parseSchedule(schedule)).runTemplate.permissionMode,
		).toBe("default");
	});
	it("accepts provider defaults and rejects invalid model or effort selections", () => {
		const draft = scheduleDraft(parseSchedule(schedule));
		expect(isScheduleDraftValid(draft)).toBe(true);
		draft.runTemplate.model = undefined;
		draft.runTemplate.effort = undefined;
		expect(isScheduleDraftValid(draft)).toBe(true);
		for (const selection of [{ model: "bad model" }, { effort: "x high" }]) {
			const runTemplate = { ...draft.runTemplate, ...selection };
			expect(isScheduleDraftValid({ ...draft, runTemplate })).toBe(false);
			expect(() => parseSchedule({ ...schedule, runTemplate })).toThrow();
		}
	});
	it("keeps account and base commit bindings when editing a name or pausing", () => {
		const parsed = parseSchedule(schedule);
		const draft = scheduleDraft(parsed);
		draft.name = "Weekly review";
		draft.enabled = false;
		expect(draft.runTemplate).toEqual(schedule.runTemplate);
		expect(parsed.name).toBe("Daily review");
		expect(draft).not.toHaveProperty("revision");
	});
	it("rejects malformed execution identity before an edit can drop it", () => {
		expect(() =>
			parseSchedule({
				...schedule,
				runTemplate: {
					...schedule.runTemplate,
					executionProfile: { kind: "unknown" },
				},
			}),
		).toThrow();
		expect(() => parseSchedule({ ...schedule, revision: 0 })).toThrow();
	});
	it("keeps launch acknowledgement distinct from receiving a report", () => {
		expect(occurrenceStatus(parseOccurrence(occurrence))).toBe(
			t("automations.awaitingReport"),
		);
		const completed = parseOccurrence({
			...occurrence,
			run: {
				runId: "run-1",
				taskId: "task-1",
				dispatchId: "dispatch-1",
				generation: 1,
				workspaceId: "workspace-1",
				completed: true,
			},
		});
		expect(occurrenceStatus(completed)).toBe(t("automations.reportReceived"));
		expect(() =>
			parseOccurrence({ ...occurrence, operationId: undefined }),
		).toThrow();
	});
});
