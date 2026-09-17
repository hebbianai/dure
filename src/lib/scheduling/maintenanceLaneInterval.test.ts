import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FrameBudgetScheduler,
	getFrameBudgetScheduler,
	resetFrameBudgetSchedulerForTest,
} from "./frameBudgetScheduler";
import {
	clearMaintenanceLaneInterval,
	requestMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "./maintenanceLaneInterval";

describe("maintenanceLaneInterval", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetFrameBudgetSchedulerForTest();
	});
	afterEach(() => {
		vi.useRealTimers();
		resetFrameBudgetSchedulerForTest();
	});

	it("틱을 maintenance 레인 슬라이스에서 실행하고 source로 계측된다", async () => {
		let ran = 0;
		const timer = setMaintenanceLaneInterval(
			() => {
				ran += 1;
			},
			1_000,
			"poll-under-test",
		);
		await vi.advanceTimersByTimeAsync(999);
		expect(ran).toBe(0);
		// 틱 발화 + 레인 슬라이스(폴백 시계 250ms 이내) 경과.
		await vi.advanceTimersByTimeAsync(1 + 300);
		expect(ran).toBe(1);
		expect(
			getFrameBudgetScheduler().getTelemetry().maintenance.sources[
				"poll-under-test"
			]?.unitsRun,
		).toBe(1);
		clearMaintenanceLaneInterval(timer);
	});

	it("유닛이 대기 중이면 다음 틱을 접는다", async () => {
		// 정지 상태를 만들어 유닛이 소진되지 않게 한다.
		const scheduler = new FrameBudgetScheduler({
			now: () => Date.now(),
			requestFrame: () => 0,
			cancelFrame: () => {},
			setTimeout: () => 0 as unknown as number,
			clearTimeout: () => {},
		});
		resetFrameBudgetSchedulerForTest(scheduler);
		let ran = 0;
		const timer = setMaintenanceLaneInterval(() => {
			ran += 1;
		}, 1_000);
		// 슬라이스가 전혀 돌지 않는 동안 틱 3회 — 유닛은 1개만 쌓여야 한다.
		await vi.advanceTimersByTimeAsync(3_100);
		expect(ran).toBe(0);
		expect(scheduler.getTelemetry().maintenance.pending).toBe(1);
		clearMaintenanceLaneInterval(timer);
		expect(scheduler.getTelemetry().maintenance.pending).toBe(0);
	});

	it("유닛 대기 중 스케줄러가 교체돼도 접힘이 영구화되지 않는다", async () => {
		// 슬라이스가 돌지 않는 죽은 스케줄러에서 유닛이 대기 상태가 된다.
		const dead = new FrameBudgetScheduler({
			now: () => Date.now(),
			requestFrame: () => 0,
			cancelFrame: () => {},
			setTimeout: () => 0 as unknown as number,
			clearTimeout: () => {},
		});
		resetFrameBudgetSchedulerForTest(dead);
		let ran = 0;
		const timer = setMaintenanceLaneInterval(() => {
			ran += 1;
		}, 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ran).toBe(0);
		// HMR·테스트 리셋과 동형: dispose + 기본(살아있는) 스케줄러 교체.
		resetFrameBudgetSchedulerForTest();
		await vi.advanceTimersByTimeAsync(1_000 + 300);
		expect(ran).toBe(1);
		clearMaintenanceLaneInterval(timer);
	});

	it("clear는 타이머와 대기 유닛을 함께 내려놓는다", async () => {
		let ran = 0;
		const timer = setMaintenanceLaneInterval(() => {
			ran += 1;
		}, 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		clearMaintenanceLaneInterval(timer);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(ran).toBe(0);
	});

	it("folds explicit wakes into a pending tick and retires their shared handle", async () => {
		const scheduler = new FrameBudgetScheduler({
			now: () => Date.now(),
			requestFrame: () => 0,
			cancelFrame: () => {},
			setTimeout: () => 0,
			clearTimeout: () => {},
		});
		resetFrameBudgetSchedulerForTest(scheduler);
		const run = vi.fn();
		const timer = setMaintenanceLaneInterval(run, 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		requestMaintenanceLaneInterval(timer);
		requestMaintenanceLaneInterval(timer);
		expect(scheduler.getTelemetry().maintenance.pending).toBe(1);
		clearMaintenanceLaneInterval(timer);
		requestMaintenanceLaneInterval(timer);
		expect(scheduler.getTelemetry().maintenance.pending).toBe(0);
		expect(run).not.toHaveBeenCalled();
	});
});
