import { describe, expect, it } from "vitest";
import {
	createGitHubActionsClient,
	DEFAULT_GHOST_RUN_AGE_MS,
	reconcileQueuedCiRuns,
} from "./ci-run-lifecycle-reconciler.mjs";

const CURRENT_HEAD = "b059aefce06f75ec9173363cc8ffd27daba751ff";
const INCIDENT_HEAD = "81ee462e373ecadbd70fb9f8ab48eab9b7f48bcd";
const INCIDENT_RUN_ID = 32985740443;

function queuedRun(overrides = {}) {
	return {
		id: INCIDENT_RUN_ID,
		name: "CI",
		path: ".github/workflows/ci.yml",
		event: "push",
		head_branch: "main",
		head_sha: INCIDENT_HEAD,
		status: "queued",
		conclusion: null,
		run_attempt: 1,
		created_at: "2026-08-26T15:38:51Z",
		...overrides,
	};
}

function cancelledUnassignedJob(overrides = {}) {
	return {
		id: 98231376879,
		status: "completed",
		conclusion: "cancelled",
		runner_id: 0,
		...overrides,
	};
}

function fakeClient({
	listed = [queuedRun()],
	exactRuns = new Map([[INCIDENT_RUN_ID, queuedRun()]]),
	jobs = new Map([
		[
			`${INCIDENT_RUN_ID}:1`,
			{ total_count: 1, jobs: [cancelledUnassignedJob()] },
		],
	]),
} = {}) {
	const calls = [];
	return {
		calls,
		async currentMainHead() {
			calls.push(["currentMainHead"]);
			return CURRENT_HEAD;
		},
		async queuedMainPushRuns() {
			calls.push(["queuedMainPushRuns"]);
			return listed;
		},
		async run(runId) {
			calls.push(["run", runId]);
			const response = exactRuns.get(runId);
			return Array.isArray(response) ? response.shift() : response;
		},
		async attemptJobs(runId, attempt) {
			calls.push(["attemptJobs", runId, attempt]);
			return jobs.get(`${runId}:${attempt}`);
		},
		async forceCancel(runId) {
			calls.push(["forceCancel", runId]);
		},
	};
}

describe("reconcileQueuedCiRuns", () => {
	it("force-cancels the exact incident only after re-reading its child and parent fence", async () => {
		const client = fakeClient();

		await expect(
			reconcileQueuedCiRuns({
				client,
				nowMs: Date.parse("2026-08-26T17:38:51Z"),
			}),
		).resolves.toEqual([
			{
				runId: INCIDENT_RUN_ID,
				headSha: INCIDENT_HEAD,
				attempt: 1,
			},
		]);
		expect(client.calls).toEqual([
			["currentMainHead"],
			["queuedMainPushRuns"],
			["run", INCIDENT_RUN_ID],
			["attemptJobs", INCIDENT_RUN_ID, 1],
			["run", INCIDENT_RUN_ID],
			["forceCancel", INCIDENT_RUN_ID],
		]);
	});

	it("leaves invalid identities, the current head, live jobs, young runs, and other workflows untouched", async () => {
		const invalidIdentity = queuedRun({ id: 5, head_sha: null });
		const current = queuedRun({ id: 1, head_sha: CURRENT_HEAD });
		const young = queuedRun({
			id: 2,
			created_at: "2026-08-26T17:20:00Z",
		});
		const otherWorkflow = queuedRun({
			id: 3,
			path: ".github/workflows/release.yml",
		});
		const live = queuedRun({ id: 4 });
		const client = fakeClient({
			listed: [invalidIdentity, current, young, otherWorkflow, live],
			exactRuns: new Map([[4, live]]),
			jobs: new Map([
				[
					"4:1",
					{
						total_count: 1,
						jobs: [
							cancelledUnassignedJob({
								status: "queued",
								conclusion: null,
							}),
						],
					},
				],
			]),
		});

		await expect(
			reconcileQueuedCiRuns({
				client,
				nowMs: Date.parse("2026-08-26T17:38:51Z"),
			}),
		).resolves.toEqual([]);
		expect(client.calls.filter(([kind]) => kind === "forceCancel")).toEqual(
			[],
		);
		expect(client.calls).not.toContainEqual(["run", 3]);
		expect(client.calls).not.toContainEqual(["run", 5]);
	});

	it("does not cancel a newer attempt that starts after the jobs read", async () => {
		const client = fakeClient({
			exactRuns: new Map([
				[
					INCIDENT_RUN_ID,
					[
						queuedRun(),
						queuedRun({
							run_attempt: 2,
							status: "in_progress",
						}),
					],
				],
			]),
		});

		await expect(
			reconcileQueuedCiRuns({
				client,
				nowMs: Date.parse("2026-08-26T17:38:51Z"),
			}),
		).resolves.toEqual([]);
		expect(client.calls).not.toContainEqual(["forceCancel", INCIDENT_RUN_ID]);
	});

	it("does not act when the parent converges between discovery and the exact re-read", async () => {
		const client = fakeClient({
			exactRuns: new Map([
				[
					INCIDENT_RUN_ID,
					queuedRun({ status: "completed", conclusion: "cancelled" }),
				],
			]),
		});

		await expect(
			reconcileQueuedCiRuns({
				client,
				nowMs: Date.parse("2026-08-26T17:38:51Z"),
			}),
		).resolves.toEqual([]);
		expect(client.calls).not.toContainEqual(["forceCancel", INCIDENT_RUN_ID]);
	});

	it("does not act when the exact parent loses its SHA fence", async () => {
		const client = fakeClient({
			exactRuns: new Map([
				[INCIDENT_RUN_ID, queuedRun({ head_sha: null })],
			]),
		});

		await expect(
			reconcileQueuedCiRuns({
				client,
				nowMs: Date.parse("2026-08-26T17:38:51Z"),
			}),
		).resolves.toEqual([]);
		expect(client.calls).not.toContainEqual(["forceCancel", INCIDENT_RUN_ID]);
	});

	it("fails closed when the exact attempt job page is incomplete", async () => {
		const client = fakeClient({
			jobs: new Map([
				[
					`${INCIDENT_RUN_ID}:1`,
					{ total_count: 2, jobs: [cancelledUnassignedJob()] },
				],
			]),
		});

		await expect(
			reconcileQueuedCiRuns({
				client,
				nowMs:
					Date.parse("2026-08-26T15:38:51Z") +
					DEFAULT_GHOST_RUN_AGE_MS,
			}),
		).resolves.toEqual([]);
		expect(client.calls).not.toContainEqual(["forceCancel", INCIDENT_RUN_ID]);
	});
});

describe("createGitHubActionsClient", () => {
	it("uses attempt-scoped jobs and the exact force-cancel endpoint", async () => {
		const requests = [];
		const responses = [
			{ object: { sha: CURRENT_HEAD } },
			{ workflow_runs: [queuedRun()] },
			queuedRun(),
			{ total_count: 1, jobs: [cancelledUnassignedJob()] },
		];
		const client = createGitHubActionsClient({
			repository: "hebbianai/HebbianIDE",
			token: "fixture-token",
			fetchImpl: async (url, options) => {
				requests.push({ url: url.toString(), ...options });
				const body = responses.shift();
				return {
					ok: true,
					status: body === undefined ? 202 : 200,
					async json() {
						return body;
					},
				};
			},
		});

		await client.currentMainHead();
		await client.queuedMainPushRuns();
		await client.run(INCIDENT_RUN_ID);
		await client.attemptJobs(INCIDENT_RUN_ID, 1);
		await client.forceCancel(INCIDENT_RUN_ID);

		expect(
			requests.map(({ url, method }) => [
				new URL(url).pathname + new URL(url).search,
				method,
			]),
		).toEqual([
			["/repos/hebbianai/HebbianIDE/git/ref/heads/main", "GET"],
			[
				"/repos/hebbianai/HebbianIDE/actions/workflows/ci.yml/runs?branch=main&event=push&status=queued&per_page=100",
				"GET",
			],
			[
				`/repos/hebbianai/HebbianIDE/actions/runs/${INCIDENT_RUN_ID}`,
				"GET",
			],
			[
				`/repos/hebbianai/HebbianIDE/actions/runs/${INCIDENT_RUN_ID}/attempts/1/jobs?per_page=100`,
				"GET",
			],
			[
				`/repos/hebbianai/HebbianIDE/actions/runs/${INCIDENT_RUN_ID}/force-cancel`,
				"POST",
			],
		]);
	});
});
