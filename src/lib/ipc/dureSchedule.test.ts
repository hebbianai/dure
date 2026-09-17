import { describe, expect, it, vi } from "vitest";
import { createScheduleClient } from "@/lib/ipc/dureSchedule";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

const authority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-local", generation: "g1" },
	target: { source: "local", hostId: "local" },
};
const schedule = {
	schemaVersion: 1 as const,
	scheduleId: "daily",
	revision: 1,
	name: "Review",
	enabled: false,
	expression: "0 9 * * 1-5",
	timezone: "UTC",
	createdAtMs: 1,
	updatedAtMs: 1,
	runTemplate: {
		projectId: "dure",
		providerId: "claude",
		prompt: "Review",
		permissionMode: "default" as const,
	},
};
function envelope(result: Record<string, unknown>) {
	return {
		schemaVersion: 1,
		routeAuthority: authority,
		backendId: authority.backend.id,
		backendGeneration: authority.backend.generation,
		result: { schemaVersion: 1, ...result },
	};
}
describe("schedule IPC", () => {
	it("binds effects to the route and revision that supplied the schedule", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(
				envelope({ schedules: [schedule], complete: true }),
			)
			.mockResolvedValueOnce(
				envelope({
					occurrence: {
						schemaVersion: 2,
						scheduleId: "daily",
						scheduleRevision: 1,
						trigger: { kind: "manual" },
						idempotencyKey: "test-1",
						launchState: "pending",
						createdAtMs: 2,
						updatedAtMs: 2,
					},
				}),
			);
		const client = createScheduleClient({ invokeCommand });
		const snapshot = await client.list();
		await client.runOnce(snapshot.schedules[0], "test-1", snapshot.authority);
		expect(invokeCommand.mock.calls[1]).toEqual([
			"dure_backend_request",
			{
				route: { kind: "exact", authority },
				operation: "schedule.run_once",
				body: {
					schemaVersion: 1,
					scheduleId: "daily",
					expectedRevision: 1,
					idempotencyKey: "test-1",
				},
			},
		]);
	});
	it("rejects reports belonging to another test request", async () => {
		const invokeCommand = vi.fn().mockResolvedValue(
			envelope({
				occurrence: {
					schemaVersion: 2,
					scheduleId: "daily",
					scheduleRevision: 1,
					trigger: { kind: "manual" },
					idempotencyKey: "another-run",
					launchState: "pending",
					createdAtMs: 2,
					updatedAtMs: 2,
				},
				resultMarkdown: "Wrong report",
			}),
		);
		await expect(
			createScheduleClient({ invokeCommand }).inspect("test-1", authority),
		).rejects.toMatchObject({ code: "schedule_response_invalid" });
	});
	it("does not overwrite the schedule from a receipt for a different revision", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValue(envelope({ schedule: { ...schedule, revision: 8 } }));
		await expect(
			createScheduleClient({ invokeCommand }).put(
				{
					schemaVersion: 1,
					scheduleId: "daily",
					expectedRevision: 1,
					idempotencyKey: "edit-1",
					name: schedule.name,
					enabled: false,
					expression: schedule.expression,
					timezone: "UTC",
					runTemplate: schedule.runTemplate,
				},
				authority,
			),
		).rejects.toMatchObject({ code: "schedule_response_invalid" });
	});
});
