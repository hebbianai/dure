export const DEFAULT_GHOST_RUN_AGE_MS = 30 * 60 * 1_000;

const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const SHA = /^[0-9a-f]{40}$/u;

function isAgedSupersededParent(run, currentHeadSha, nowMs, minimumAgeMs) {
	const createdAtMs = Date.parse(run?.created_at ?? "");
	return (
		Number.isSafeInteger(run?.id) &&
		run.id > 0 &&
		run.path === CI_WORKFLOW_PATH &&
		run.event === "push" &&
		run.head_branch === "main" &&
		SHA.test(run.head_sha ?? "") &&
		run.head_sha !== currentHeadSha &&
		run.status === "queued" &&
		run.conclusion === null &&
		Number.isFinite(createdAtMs) &&
		nowMs - createdAtMs >= minimumAgeMs
	);
}

function hasOnlyCancelledUnassignedJobs(page) {
	return (
		Number.isSafeInteger(page?.total_count) &&
		page.total_count > 0 &&
		Array.isArray(page.jobs) &&
		page.jobs.length === page.total_count &&
		page.jobs.every(
			(job) =>
				job?.status === "completed" &&
				job.conclusion === "cancelled" &&
				job.runner_id === 0,
		)
	);
}

export function createGitHubActionsClient({
	apiUrl = "https://api.github.com",
	repository,
	token,
	fetchImpl = fetch,
}) {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) {
		throw new Error("github_repository_invalid");
	}
	if (typeof token !== "string" || token.length === 0) {
		throw new Error("github_token_missing");
	}
	const base = new URL(
		`${String(apiUrl).replace(/\/+$/u, "")}/repos/${repository}/`,
	);
	if (base.protocol !== "https:") throw new Error("github_api_url_invalid");

	const request = async (path, { method = "GET", json = true } = {}) => {
		const response = await fetchImpl(new URL(path, base), {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) {
			throw new Error(`github_actions_request_failed:${method}:${response.status}`);
		}
		return json ? response.json() : undefined;
	};

	return {
		async currentMainHead() {
			const result = await request("git/ref/heads/main");
			const sha = result?.object?.sha;
			if (!SHA.test(sha ?? "")) throw new Error("github_main_head_invalid");
			return sha;
		},
		async queuedMainPushRuns() {
			const result = await request(
				"actions/workflows/ci.yml/runs?branch=main&event=push&status=queued&per_page=100",
			);
			if (!Array.isArray(result?.workflow_runs)) {
				throw new Error("github_workflow_runs_invalid");
			}
			return result.workflow_runs;
		},
		run(runId) {
			return request(`actions/runs/${runId}`);
		},
		attemptJobs(runId, attempt) {
			return request(
				`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
			);
		},
		forceCancel(runId) {
			return request(`actions/runs/${runId}/force-cancel`, {
				method: "POST",
				json: false,
			});
		},
	};
}

/**
 * Converge the one GitHub-owned contradiction this maintenance task can prove:
 * an old queued CI parent whose exact attempt already contains only terminal,
 * unassigned cancelled jobs. The exact parent and jobs are re-read immediately
 * before the force-cancel; there is no local journal or retry authority.
 */
export async function reconcileQueuedCiRuns({
	client,
	nowMs = Date.now(),
	minimumAgeMs = DEFAULT_GHOST_RUN_AGE_MS,
}) {
	const currentHeadSha = await client.currentMainHead();
	const discovered = await client.queuedMainPushRuns();
	const reconciled = [];

	for (const candidate of discovered) {
		if (
			!isAgedSupersededParent(
				candidate,
				currentHeadSha,
				nowMs,
				minimumAgeMs,
			)
		) {
			continue;
		}

		const exact = await client.run(candidate.id);
		if (
			exact?.id !== candidate.id ||
			!Number.isSafeInteger(exact.run_attempt) ||
			exact.run_attempt < 1 ||
			!isAgedSupersededParent(
				exact,
				currentHeadSha,
				nowMs,
				minimumAgeMs,
			)
		) {
			continue;
		}

		const jobs = await client.attemptJobs(exact.id, exact.run_attempt);
		if (!hasOnlyCancelledUnassignedJobs(jobs)) continue;

		const beforeMutation = await client.run(exact.id);
		if (
			beforeMutation?.id !== exact.id ||
			beforeMutation.head_sha !== exact.head_sha ||
			beforeMutation.run_attempt !== exact.run_attempt ||
			!isAgedSupersededParent(
				beforeMutation,
				currentHeadSha,
				nowMs,
				minimumAgeMs,
			)
		) {
			continue;
		}

		await client.forceCancel(beforeMutation.id);
		reconciled.push({
			runId: beforeMutation.id,
			headSha: beforeMutation.head_sha,
			attempt: beforeMutation.run_attempt,
		});
	}

	return reconciled;
}
