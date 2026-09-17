import { describe, expect, it } from "vitest";
import {
	commitVerdictCoverage,
	percentile,
	queueStats,
	summarizeRuns,
	verifyWaitMinutes,
} from "./ci-latency-report.mjs";

describe("summarizeRuns", () => {
	it("push run만 세고 취소율을 push당으로 정규화한다", () => {
		const runs = [
			{ event: "push", conclusion: "success", createdAt: "2026-08-01T00:00:00Z" },
			{ event: "push", conclusion: "cancelled", createdAt: "2026-08-01T01:00:00Z" },
			{ event: "push", conclusion: "cancelled", createdAt: "2026-08-01T02:00:00Z" },
			{ event: "push", conclusion: "failure", createdAt: "2026-08-01T04:00:00Z" },
			{ event: "workflow_dispatch", conclusion: "success", createdAt: "2026-08-01T05:00:00Z" },
		];
		const summary = summarizeRuns(runs);
		expect(summary.pushRuns).toBe(4);
		expect(summary.counts).toMatchObject({ success: 1, cancelled: 2, failure: 1 });
		expect(summary.spanHours).toBe(4);
		expect(summary.pushesPerHour).toBe(1);
		expect(summary.cancelledPerPush).toBe(0.5);
	});

	it("빈 입력은 null 비율", () => {
		const summary = summarizeRuns([]);
		expect(summary.cancelledPerPush).toBeNull();
		expect(summary.pushesPerHour).toBeNull();
	});
});

describe("commitVerdictCoverage", () => {
	it("success/failure 판정을 받은 커밋만 센다", () => {
		const runs = [
			{ headSha: "a", conclusion: "success" },
			{ headSha: "b", conclusion: "cancelled" },
			{ headSha: "c", conclusion: "failure" },
		];
		expect(commitVerdictCoverage(["a", "b", "c", "d"], runs)).toEqual({
			total: 4,
			judged: 2,
			coverage: 0.5,
		});
	});
});

describe("queueStats/percentile", () => {
	it("p50/p90/max를 계산한다", () => {
		const stats = queueStats([1, 22, 3, 5, 8, 2, 13, 4, 6, 9]);
		expect(stats.samples).toBe(10);
		expect(stats.p50).toBe(5);
		expect(stats.p90).toBe(13);
		expect(stats.max).toBe(22);
	});
	it("빈 표본은 null", () => {
		expect(queueStats([])).toEqual({ samples: 0, p50: null, p90: null, max: null });
	});
	it("percentile 경계", () => {
		expect(percentile([10], 90)).toBe(10);
		expect(percentile([], 50)).toBeNull();
	});
});

describe("verifyWaitMinutes", () => {
	it("run 생성→verify 시작을 분으로", () => {
		expect(
			verifyWaitMinutes({
				createdAt: "2026-08-01T00:00:00Z",
				jobs: [
					{ name: "classify", startedAt: "2026-08-01T00:01:00Z" },
					{ name: "verify (heavy)", startedAt: "2026-08-01T00:22:30Z" },
				],
			}),
		).toBeCloseTo(22.5);
	});
	it("verify job이 없으면 null", () => {
		expect(verifyWaitMinutes({ createdAt: "2026-08-01T00:00:00Z", jobs: [] })).toBeNull();
	});
});
