import { describe, expect, it } from "vitest";
import {
	type MergedTierReconcileIntent,
	resolveMergedTierReconcile,
	TierReconcileScheduler,
} from "./tierReconcileScheduler";
import type { WorkspaceCacheTiers } from "./workspaceCachePolicy";

class FakeLane {
	readonly tasks: Array<{ task: () => void; cancelled: boolean }> = [];
	readonly schedule = (task: () => void) => {
		const entry = { task, cancelled: false };
		this.tasks.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	runAll() {
		for (const entry of this.tasks.splice(0)) {
			if (!entry.cancelled) entry.task();
		}
	}
	pendingCount() {
		return this.tasks.filter((entry) => !entry.cancelled).length;
	}
}

function setup() {
	const lane = new FakeLane();
	const runs: MergedTierReconcileIntent[] = [];
	const scheduler = new TierReconcileScheduler(
		(intent) => runs.push(intent),
		lane.schedule,
	);
	return { lane, runs, scheduler };
}

describe("TierReconcileScheduler", () => {
	it("여러 트리거의 의도를 한 실행으로 병합한다", () => {
		const { lane, runs, scheduler } = setup();
		scheduler.request({ resourceChange: true });
		scheduler.request({ warmCandidates: ["a"], retainCandidates: ["a"] });
		scheduler.request({
			retainCandidates: ["b"],
			protectedWarmFromCurrent: true,
		});
		expect(lane.pendingCount()).toBe(1);
		lane.runAll();
		expect(runs).toEqual([
			{
				resourceChange: true,
				warmCandidates: ["a"],
				retainCandidates: ["a", "b"],
				protectedWarmFromCurrent: true,
			},
		]);
	});

	it("urgent 요청은 병합된 대기분을 즉시 실행하고 레인 유닛을 취소한다", () => {
		// Severe context overshoot must not wait behind a paused catchup lane
		// (WKWebView silent-kill zone — bead 9390 deferred item).
		const { lane, runs, scheduler } = setup();
		scheduler.request({ warmCandidates: ["a"] });
		expect(lane.pendingCount()).toBe(1);
		scheduler.request({ resourceChange: true }, true);
		// Consume-and-clear: the bypass ran the FULL merged intent at once.
		expect(runs).toEqual([
			{
				resourceChange: true,
				warmCandidates: ["a"],
				retainCandidates: [],
				protectedWarmFromCurrent: false,
			},
		]);
		expect(lane.pendingCount()).toBe(0);
		// The cancelled lane unit must not replay the consumed intent.
		lane.runAll();
		expect(runs).toHaveLength(1);
	});

	it("urgent 이후의 일반 요청은 다시 레인을 탄다", () => {
		const { lane, runs, scheduler } = setup();
		scheduler.request({ resourceChange: true }, true);
		expect(runs).toHaveLength(1);
		scheduler.request({ warmCandidates: ["b"] });
		expect(runs).toHaveLength(1);
		expect(lane.pendingCount()).toBe(1);
		lane.runAll();
		expect(runs).toHaveLength(2);
	});

	it("실행 후의 새 요청은 새 유닛으로 스케줄된다", () => {
		const { lane, runs, scheduler } = setup();
		scheduler.request({ resourceChange: true });
		lane.runAll();
		scheduler.request({ warmCandidates: ["x"] });
		lane.runAll();
		expect(runs).toHaveLength(2);
		expect(runs[1]?.resourceChange).toBe(false);
		expect(runs[1]?.warmCandidates).toEqual(["x"]);
	});

	it("후보 중복은 합집합으로 접힌다", () => {
		const { lane, runs, scheduler } = setup();
		scheduler.request({ warmCandidates: ["a", "b"] });
		scheduler.request({ warmCandidates: ["b", "c"] });
		lane.runAll();
		expect(runs[0]?.warmCandidates).toEqual(["a", "b", "c"]);
	});

	it("dispose는 대기 유닛과 의도를 내려놓는다", () => {
		const { lane, runs, scheduler } = setup();
		scheduler.request({ resourceChange: true });
		scheduler.dispose();
		lane.runAll();
		expect(runs).toEqual([]);
		scheduler.request({ resourceChange: true });
		expect(lane.pendingCount()).toBe(0);
	});

	it("실행 중 재진입 request는 새 유닛으로 스케줄된다", () => {
		const lane = new FakeLane();
		const runs: MergedTierReconcileIntent[] = [];
		const scheduler: TierReconcileScheduler = new TierReconcileScheduler(
			(intent) => {
				runs.push(intent);
				if (runs.length === 1) scheduler.request({ warmCandidates: ["re"] });
			},
			lane.schedule,
		);
		scheduler.request({ resourceChange: true });
		lane.runAll();
		expect(lane.pendingCount()).toBe(1);
		lane.runAll();
		expect(runs).toHaveLength(2);
		expect(runs[1]?.warmCandidates).toEqual(["re"]);
	});
});

describe("resolveMergedTierReconcile", () => {
	const tiers = (
		mounted: string[],
		warm: string[],
		frozen: string[] = [],
	): WorkspaceCacheTiers => ({ mounted, warm, frozen });
	const same = (a: WorkspaceCacheTiers, b: WorkspaceCacheTiers) =>
		JSON.stringify(a) === JSON.stringify(b);

	it("resourceChange+후보 병합은 압력 패스에 투기 후보를 넣지 않는다", () => {
		const calls: string[][][] = [];
		const pressured = tiers(["a"], ["a"]);
		const candidateNext = tiers(["a", "n"], ["a", "n"]);
		const accepted = tiers(["a", "n"], ["a"]);
		const result = resolveMergedTierReconcile({
			current: tiers(["a", "b"], ["a", "b"]),
			intent: {
				resourceChange: true,
				warmCandidates: ["n"],
				retainCandidates: ["n"],
				protectedWarmFromCurrent: false,
			},
			reconcile: (_base, warm, retain, protectedWarm) => {
				calls.push([[...warm], [...retain], [...protectedWarm]]);
				return calls.length === 1 ? pressured : candidateNext;
			},
			accept: (base, next) => {
				// 후보 패스는 압력 패스 결과 위에 수축 없는 승인으로만 얹는다.
				expect(base).toBe(pressured);
				expect(next).toBe(candidateNext);
				return accepted;
			},
			same,
		});
		expect(calls[0]).toEqual([[], [], []]);
		expect(calls[1]).toEqual([["n"], ["n"], []]);
		expect(result).toBe(accepted);
	});

	it("후보만 있으면 accept 단일 패스", () => {
		const calls: string[][][] = [];
		const next = tiers(["a", "n"], ["a"]);
		const result = resolveMergedTierReconcile({
			current: tiers(["a"], ["a"]),
			intent: {
				resourceChange: false,
				warmCandidates: ["n"],
				retainCandidates: [],
				protectedWarmFromCurrent: false,
			},
			reconcile: (_base, warm, retain, protectedWarm) => {
				calls.push([[...warm], [...retain], [...protectedWarm]]);
				return next;
			},
			accept: (_base, candidate) => candidate,
			same,
		});
		expect(calls).toHaveLength(1);
		expect(result).toBe(next);
	});

	it("resourceChange만 있으면 raw 단일 패스(수축 허용)", () => {
		const shrunk = tiers(["a"], []);
		const result = resolveMergedTierReconcile({
			current: tiers(["a", "b"], ["a"]),
			intent: {
				resourceChange: true,
				warmCandidates: [],
				retainCandidates: [],
				protectedWarmFromCurrent: false,
			},
			reconcile: () => shrunk,
			accept: () => {
				throw new Error("후보 없는 압력 패스는 accept를 타면 안 된다");
			},
			same,
		});
		expect(result).toBe(shrunk);
	});

	it("protectedWarmFromCurrent는 압력 패스 이후의 warm을 쓴다", () => {
		const pressured = tiers(["a"], ["p"]);
		const protectedSeen: string[][] = [];
		resolveMergedTierReconcile({
			current: tiers(["a", "b"], ["old"]),
			intent: {
				resourceChange: true,
				warmCandidates: [],
				retainCandidates: ["s"],
				protectedWarmFromCurrent: true,
			},
			reconcile: (_base, _warm, _retain, protectedWarm) => {
				protectedSeen.push([...protectedWarm]);
				return pressured;
			},
			accept: (_base, next) => next,
			same,
		});
		expect(protectedSeen[0]).toEqual([]);
		expect(protectedSeen[1]).toEqual(["p"]);
	});
});
