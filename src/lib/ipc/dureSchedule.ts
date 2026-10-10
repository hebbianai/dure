import {
	type AutomationSchedule,
	parseOccurrence,
	parseSchedule,
	type ScheduleDraft,
	scheduleContractError,
} from "@/lib/automations/scheduleContract";
import {
	createDureBackendRequester,
	DureBackendRequestError,
	type DureBackendInvoke,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { readDureProjects } from "@/lib/ipc/dureProjects";

export type { DureProjectOption as ScheduleProject } from "@/lib/ipc/dureProjects";

export interface ScheduleSnapshot {
	authority: DureBackendRouteAuthorityV1;
	schedules: AutomationSchedule[];
	complete: boolean;
}

export interface SchedulePutIntent extends ScheduleDraft {
	schemaVersion: 1;
	scheduleId: string;
	expectedRevision: number;
	idempotencyKey: string;
}

export function createScheduleClient(
	options: { profileId?: string; invokeCommand?: DureBackendInvoke } = {},
) {
	const request = createDureBackendRequester({
		...options,
		invalidResponseCode: "schedule_response_invalid",
		invalidResponseMessage: "automations.invalidResponse",
		backendChangedCode: "schedule_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "schedule_request_failed",
		requestFailedMessage: "automations.requestFailed",
	});
	const exact = (authority: DureBackendRouteAuthorityV1) => ({
		kind: "exact" as const,
		authority,
	});
	const observe = async (
		operation: string,
		body: Record<string, unknown>,
		authority: DureBackendRouteAuthorityV1,
	) => {
		try {
			return await request(
				operation,
				{ ...body, includeRuntime: true },
				exact(authority),
			);
		} catch (error) {
			// This is a read-only extension. Older backends keep their original
			// report contract; transport/authority failures are never hidden.
			if (
				!(error instanceof DureBackendRequestError) ||
				![
					"backend_transport_capability_missing",
					"backend_transport_profile_capability_missing",
				].includes(error.code) ||
				error.details?.capability !== "schedule.runtime_observation_v1"
			)
				throw error;
			return request(operation, body, exact(authority));
		}
	};
	return {
		async list(): Promise<ScheduleSnapshot> {
			const { result, routeAuthority } = await request(
				"schedule.list",
				{ schemaVersion: 1, maxItems: 128 },
				{ kind: "complete_selected_snapshot" },
			);
			if (
				!Array.isArray(result.schedules) ||
				typeof result.complete !== "boolean"
			)
				scheduleContractError();
			const schedules = result.schedules.map(parseSchedule);
			if (
				new Set(schedules.map((schedule) => schedule.scheduleId)).size !==
				schedules.length
			)
				scheduleContractError();
			return {
				authority: routeAuthority,
				schedules: schedules.filter(
					(schedule) => schedule.deletedAtMs === undefined,
				),
				complete: result.complete,
			};
		},
		projects: (authority: DureBackendRouteAuthorityV1) =>
			readDureProjects(request, authority, scheduleContractError),
		async put(
			intent: SchedulePutIntent,
			authority: DureBackendRouteAuthorityV1,
		) {
			const { result } = await request(
				"schedule.put",
				{ ...intent },
				exact(authority),
			);
			const schedule = parseSchedule(result.schedule);
			if (
				schedule.scheduleId !== intent.scheduleId ||
				schedule.revision !== intent.expectedRevision + 1
			)
				scheduleContractError();
			return schedule;
		},
		async runOnce(
			schedule: AutomationSchedule,
			idempotencyKey: string,
			authority: DureBackendRouteAuthorityV1,
		) {
			const { result } = await request(
				"schedule.run_once",
				{
					schemaVersion: 1,
					scheduleId: schedule.scheduleId,
					expectedRevision: schedule.revision,
					idempotencyKey,
				},
				exact(authority),
			);
			const occurrence = parseOccurrence(result.occurrence);
			if (
				occurrence.scheduleId !== schedule.scheduleId ||
				occurrence.scheduleRevision !== schedule.revision ||
				occurrence.idempotencyKey !== idempotencyKey ||
				occurrence.trigger.kind !== "manual"
			)
				scheduleContractError();
			return occurrence;
		},
		async occurrences(
			scheduleId: string,
			authority: DureBackendRouteAuthorityV1,
		) {
			const { result } = await observe(
				"schedule.occurrences",
				{ schemaVersion: 1, scheduleId, maxItems: 128 },
				authority,
			);
			if (!Array.isArray(result.occurrences)) scheduleContractError();
			const occurrences = result.occurrences.map(parseOccurrence);
			if (occurrences.some((item) => item.scheduleId !== scheduleId))
				scheduleContractError();
			return occurrences;
		},
		async inspect(
			idempotencyKey: string,
			authority: DureBackendRouteAuthorityV1,
		) {
			const { result } = await observe(
				"schedule.inspect",
				{ schemaVersion: 1, idempotencyKey },
				authority,
			);
			const occurrence = parseOccurrence(result.occurrence);
			if (
				occurrence.idempotencyKey !== idempotencyKey ||
				(result.resultMarkdown !== null &&
					typeof result.resultMarkdown !== "string")
			)
				scheduleContractError();
			return {
				occurrence,
				resultMarkdown: result.resultMarkdown as string | null,
			};
		},
	};
}

export type ScheduleClient = ReturnType<typeof createScheduleClient>;
