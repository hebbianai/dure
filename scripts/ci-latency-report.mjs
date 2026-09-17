// CI 지연·판정 커버리지 리포트 (최소본) — 2026-08-01 CI 감사 P1-6.
//
// 목적: CI 개선(러너 라벨, 도구 캐시, 코얼레스 backfill 등)의 before/after를
// 같은 잣대로 재는 baseline 4수치를 출력한다:
//   ① 취소율(push-rate 정규화 — 취소는 부하의 함수라 원시 %는 교란된다)
//   ② per-commit 판정 커버리지(최근 main 커밋 중 자기 SHA로 success/failure
//      판정을 받은 비율 — 코얼레싱이 지우는 bisect 신호의 측정)
//   ③ promotion skipped 수
//   ④ verify 대기(p50/p90/max — run 생성→verify job 시작; classify 포함
//      근사치임을 라벨에 명시)
//
// receipt 아티팩트 기반의 정밀 4-phase 분해는 후속 — 이 최소본은 gh CLI만
// 사용하고 cron 부하원을 추가하지 않는 수동 실행 도구다.
//
// 사용: node scripts/ci-latency-report.mjs [--limit 200] [--queue-sample 12] [--json]
import { execFileSync } from "node:child_process";

export function percentile(sortedValues, p) {
	if (sortedValues.length === 0) return null;
	const index = Math.min(
		sortedValues.length - 1,
		Math.ceil((p / 100) * sortedValues.length) - 1,
	);
	return sortedValues[Math.max(0, index)];
}

/** CI run 목록 요약 — 결론 분포와 push 부하, 부하 정규화 취소율. */
export function summarizeRuns(runs) {
	const pushRuns = runs.filter((run) => run.event === "push");
	const counts = { success: 0, failure: 0, cancelled: 0, skipped: 0, other: 0 };
	for (const run of pushRuns) {
		if (run.conclusion in counts) counts[run.conclusion] += 1;
		else counts.other += 1;
	}
	const times = pushRuns
		.map((run) => Date.parse(run.createdAt))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const spanHours =
		times.length >= 2 ? (times[times.length - 1] - times[0]) / 3_600_000 : 0;
	return {
		pushRuns: pushRuns.length,
		counts,
		spanHours,
		pushesPerHour: spanHours > 0 ? pushRuns.length / spanHours : null,
		cancelledPerPush:
			pushRuns.length > 0 ? counts.cancelled / pushRuns.length : null,
	};
}

/** 최근 main 커밋 중 자기 SHA의 CI run이 success/failure 판정을 남긴 비율. */
export function commitVerdictCoverage(commitShas, runs) {
	const judged = new Set();
	for (const run of runs) {
		if (run.conclusion !== "success" && run.conclusion !== "failure") continue;
		if (typeof run.headSha === "string") judged.add(run.headSha);
	}
	const judgedCount = commitShas.filter((sha) => judged.has(sha)).length;
	return {
		total: commitShas.length,
		judged: judgedCount,
		coverage: commitShas.length > 0 ? judgedCount / commitShas.length : null,
	};
}

/** verify job 시작 지연(분) 표본의 p50/p90/max. */
export function queueStats(waitMinutes) {
	const sorted = [...waitMinutes].sort((a, b) => a - b);
	return {
		samples: sorted.length,
		p50: percentile(sorted, 50),
		p90: percentile(sorted, 90),
		max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
	};
}

/** run 상세(jobs 포함)에서 verify 대기 분을 뽑는다 — 없으면 null. */
export function verifyWaitMinutes(runDetail) {
	const created = Date.parse(runDetail.createdAt ?? "");
	const verify = (runDetail.jobs ?? []).find(
		(job) => typeof job.name === "string" && job.name.startsWith("verify"),
	);
	const started = Date.parse(verify?.startedAt ?? "");
	if (!Number.isFinite(created) || !Number.isFinite(started)) return null;
	return Math.max(0, (started - created) / 60_000);
}

function gh(args) {
	return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function gitMainCommits(count) {
	return execFileSync(
		"git",
		["log", "origin/main", `-${count}`, "--format=%H"],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean);
}

async function main() {
	const args = process.argv.slice(2);
	const flag = (name, fallback) => {
		const index = args.indexOf(`--${name}`);
		return index >= 0 ? Number(args[index + 1]) : fallback;
	};
	const limit = flag("limit", 200);
	const queueSample = flag("queue-sample", 12);

	const ciRuns = gh([
		"run", "list", "--workflow", "CI", "--limit", String(limit),
		"--json", "databaseId,conclusion,status,createdAt,headSha,event",
	]);
	const promotionRuns = gh([
		"run", "list", "--workflow", "Hmux release promotion", "--limit", "50",
		"--json", "conclusion",
	]);
	const summary = summarizeRuns(ciRuns);
	const coverage = commitVerdictCoverage(gitMainCommits(30), ciRuns);

	const successIds = ciRuns
		.filter((run) => run.conclusion === "success")
		.slice(0, queueSample)
		.map((run) => run.databaseId);
	const waits = [];
	for (const id of successIds) {
		try {
			const detail = gh([
				"run", "view", String(id), "--json", "jobs,createdAt",
			]);
			const wait = verifyWaitMinutes(detail);
			if (wait !== null) waits.push(wait);
		} catch {
			// 조회 실패한 표본은 건너뛴다 — 리포트는 관측 도구다.
		}
	}
	const queue = queueStats(waits);
	const promotionSkipped = promotionRuns.filter(
		(run) => run.conclusion === "skipped",
	).length;

	const report = {
		generatedAt: new Date().toISOString(),
		window: { ciRuns: ciRuns.length, spanHours: summary.spanHours },
		cancelRate: {
			cancelled: summary.counts.cancelled,
			pushRuns: summary.pushRuns,
			cancelledPerPush: summary.cancelledPerPush,
			pushesPerHour: summary.pushesPerHour,
		},
		conclusions: summary.counts,
		perCommitVerdict: coverage,
		promotionSkippedLast50: promotionSkipped,
		verifyStartWait: { note: "run 생성→verify 시작(분), classify 포함 근사", ...queue },
	};

	if (args.includes("--json")) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
	const min = (value) => (value === null ? "n/a" : `${value.toFixed(1)}m`);
	process.stdout.write(
		[
			`CI runs ${report.window.ciRuns} (${report.window.spanHours.toFixed(1)}h 창)`,
			`push ${summary.pushRuns} · 시간당 ${summary.pushesPerHour?.toFixed(1) ?? "n/a"}`,
			`결론: success ${summary.counts.success} / failure ${summary.counts.failure} / cancelled ${summary.counts.cancelled} / skipped ${summary.counts.skipped}`,
			`취소율(정규화): push당 ${pct(summary.cancelledPerPush)}`,
			`per-commit 판정(최근 30): ${coverage.judged}/${coverage.total} (${pct(coverage.coverage)})`,
			`promotion skipped(최근 50): ${promotionSkipped}`,
			`verify 시작 대기: p50 ${min(queue.p50)} · p90 ${min(queue.p90)} · max ${min(queue.max)} (표본 ${queue.samples})`,
			"",
		].join("\n"),
	);
}

const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
	await main();
}
