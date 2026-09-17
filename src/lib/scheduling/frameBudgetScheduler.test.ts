import { describe, expect, it } from "vitest";
import {
	type FrameBudgetHost,
	FrameBudgetScheduler,
} from "./frameBudgetScheduler";

class FakeHost implements FrameBudgetHost {
	nowMs = 0;
	private frameCallbacks = new Map<number, (frameStartMs: number) => void>();
	private timers = new Map<number, { at: number; callback: () => void }>();
	private nextHandle = 1;

	now(): number {
		return this.nowMs;
	}

	requestFrame(callback: (frameStartMs: number) => void): number {
		const handle = this.nextHandle++;
		this.frameCallbacks.set(handle, callback);
		return handle;
	}

	cancelFrame(handle: number): void {
		this.frameCallbacks.delete(handle);
	}

	setTimeout(callback: () => void, delayMs: number): number {
		const handle = this.nextHandle++;
		this.timers.set(handle, { at: this.nowMs + delayMs, callback });
		return handle;
	}

	clearTimeout(handle: number): void {
		this.timers.delete(handle);
	}

	pendingWakeCount(): number {
		return this.frameCallbacks.size + this.timers.size;
	}

	pendingFrameCount(): number {
		return this.frameCallbacks.size;
	}

	pendingTimerCount(): number {
		return this.timers.size;
	}

	/** 다음 프레임 도착 — 등록된 rAF 콜백만 실행(슬라이스 중 재등록은 다음 펌프). */
	pumpFrame(advanceMs = 16): void {
		this.nowMs += advanceMs;
		const callbacks = [...this.frameCallbacks.values()];
		this.frameCallbacks.clear();
		for (const callback of callbacks) callback(this.nowMs);
	}

	/** rAF 콜백이 프레임 타임스탬프보다 늦게 실행되는 혼잡 프레임. */
	pumpLateFrame(latenessMs: number): void {
		this.nowMs += 16;
		const frameStartMs = this.nowMs;
		this.nowMs += latenessMs;
		const callbacks = [...this.frameCallbacks.values()];
		this.frameCallbacks.clear();
		for (const callback of callbacks) callback(frameStartMs);
	}

	/** 프레임 없이 시간만 진행 — 만기 타이머(fallback)를 순서대로 실행. */
	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.nowMs = Math.max(this.nowMs, due[1].at);
			due[1].callback();
		}
		this.nowMs = target;
	}
}

function setup() {
	const host = new FakeHost();
	const scheduler = new FrameBudgetScheduler(host);
	return { host, scheduler };
}

describe("FrameBudgetScheduler", () => {
	it("keeps lower-priority lanes on the bounded fallback", () => {
		const { host, scheduler } = setup();
		const order: string[] = [];
		scheduler.schedule("maintenance", () => order.push("maintenance"));
		scheduler.schedule("catchup", () => order.push("catchup"));
		scheduler.schedule("reveal", () => order.push("reveal"));
		host.pumpFrame();
		expect(order).toEqual(["reveal"]);

		host.advance(250 - 16);
		expect(order).toEqual(["reveal", "catchup", "maintenance"]);
	});

	it("drains cheap catchup units within one fallback slice budget", () => {
		const { host, scheduler } = setup();
		const ran: number[] = [];
		for (let index = 0; index < 3; index++) {
			scheduler.schedule("catchup", () => {
				ran.push(index);
			});
		}
		host.advance(250);
		expect(ran).toEqual([0, 1, 2]);
		expect(scheduler.getTelemetry().catchup.yields).toBe(0);
	});

	it("paces sustained deferred work without serializing a cold burst", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		for (let index = 0; index < 4; index++) {
			scheduler.schedule(
				"catchup",
				() => ran.push(`cold-${index}`),
				"deferred-presentation",
				{ completion: "deferred", burst: true },
			);
		}
		host.advance(250);
		expect(ran).toEqual(["cold-0", "cold-1", "cold-2", "cold-3"]);

		for (let index = 0; index < 4; index++) {
			scheduler.schedule(
				"catchup",
				() => ran.push(`steady-${index}`),
				"deferred-presentation",
				{ completion: "deferred" },
			);
		}
		host.advance(250);
		expect(ran).toEqual([
			"cold-0",
			"cold-1",
			"cold-2",
			"cold-3",
			"steady-0",
		]);
		expect(scheduler.getTelemetry().catchup.yields).toBe(1);

		host.advance(750);
		expect(ran).toEqual([
			"cold-0",
			"cold-1",
			"cold-2",
			"cold-3",
			"steady-0",
			"steady-1",
			"steady-2",
			"steady-3",
		]);
		expect(scheduler.getTelemetry().catchup.yields).toBe(3);
	});

	it("yields catchup work after its existing time budget", () => {
		const { host, scheduler } = setup();
		const ran: number[] = [];
		for (let index = 0; index < 3; index++) {
			scheduler.schedule("catchup", () => {
				ran.push(index);
				host.nowMs += 3;
			});
		}

		host.advance(250);
		expect(ran).toEqual([0, 1]);
		expect(scheduler.getTelemetry().catchup.yields).toBe(1);

		host.advance(256);
		expect(ran).toEqual([0, 1, 2]);
	});

	it("attributes queued and completed work to bounded producer names", () => {
		const { host, scheduler } = setup();
		scheduler.schedule("catchup", () => {}, "terminal-render-write");
		scheduler.schedule("catchup", () => {}, "hmux-snapshot-refresh");

		expect(scheduler.getTelemetry().catchup.sources).toMatchObject({
			"terminal-render-write": { unitsRun: 0, pending: 1 },
			"hmux-snapshot-refresh": { unitsRun: 0, pending: 1 },
		});
		host.advance(250);
		expect(scheduler.getTelemetry().catchup.sources).toMatchObject({
			"terminal-render-write": { unitsRun: 1, pending: 0 },
			"hmux-snapshot-refresh": { unitsRun: 1, pending: 0 },
		});
	});

	it("does not keep display frames armed for background-only continuous work", () => {
		const { host, scheduler } = setup();
		const scheduleNext = () => {
			scheduler.schedule("catchup", scheduleNext, "continuous-background");
		};

		scheduleNext();

		expect(host.pendingFrameCount()).toBe(0);
		expect(host.pendingTimerCount()).toBe(1);
		host.advance(250);
		expect(scheduler.getTelemetry().catchup.unitsRun).toBe(1);
		expect(host.pendingFrameCount()).toBe(0);
		expect(host.pendingTimerCount()).toBe(1);
	});

	it("keeps catchup on its bounded fallback while reveal frames continue", () => {
		const { host, scheduler } = setup();
		let reveals = 0;
		const scheduleReveal = () => {
			scheduler.schedule("reveal", () => {
				reveals += 1;
				scheduleReveal();
			});
		};
		let catchupRuns = 0;

		scheduleReveal();
		scheduler.schedule("catchup", () => {
			catchupRuns += 1;
		});
		host.pumpFrame();
		host.pumpFrame();

		expect(reveals).toBe(2);
		expect(catchupRuns).toBe(0);
		expect(host.pendingTimerCount()).toBe(1);

		host.advance(250 - 32);
		expect(catchupRuns).toBe(1);
		expect(reveals).toBe(2);

		// The lower-lane deadline arrived 218ms after the last frame. The same
		// timer keeps the remaining 32ms reveal watchdog instead of starting a
		// second 250ms wait when rAF has stopped.
		host.advance(32);
		expect(reveals).toBe(3);
	});

	it("promotes arriving reveal work to the next display frame", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("catchup", () => ran.push("catchup"));
		expect(host.pendingFrameCount()).toBe(0);

		const cancelReveal = scheduler.schedule("reveal", () =>
			ran.push("cancelled-reveal"),
		);
		expect(host.pendingFrameCount()).toBe(1);
		cancelReveal();
		expect(host.pendingFrameCount()).toBe(0);
		expect(host.pendingTimerCount()).toBe(1);

		scheduler.schedule("reveal", () => ran.push("reveal"));
		expect(host.pendingFrameCount()).toBe(1);
		host.pumpFrame();

		expect(ran).toEqual(["reveal"]);
		expect(host.pendingWakeCount()).toBe(1);
		host.advance(250 - 16);
		expect(ran).toEqual(["reveal", "catchup"]);
		expect(host.pendingWakeCount()).toBe(0);
	});

	it("uses the existing fallback when a reveal frame never arrives", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("reveal", () => ran.push("reveal"));

		expect(host.pendingFrameCount()).toBe(1);
		expect(host.pendingTimerCount()).toBe(1);
		host.advance(250);

		expect(ran).toEqual(["reveal"]);
		expect(host.pendingWakeCount()).toBe(0);
	});

	it("starts a fresh reveal watchdog after an idle gap", () => {
		const { host, scheduler } = setup();
		let reveals = 0;
		scheduler.schedule("reveal", () => {
			reveals += 1;
		});
		host.pumpFrame();
		host.advance(1_000);

		scheduler.schedule("reveal", () => {
			reveals += 1;
		});
		host.advance(0);
		expect(reveals).toBe(1);

		host.advance(250);
		expect(reveals).toBe(2);
	});

	it("disarms both reveal wakes when the last unit is cancelled", () => {
		const { host, scheduler } = setup();
		const cancel = scheduler.schedule("reveal", () => {});
		expect(host.pendingFrameCount()).toBe(1);
		expect(host.pendingTimerCount()).toBe(1);

		cancel();

		expect(host.pendingWakeCount()).toBe(0);
		expect(scheduler.hasPendingWork()).toBe(false);
	});

	it("defers lower lanes when the global frame budget is spent", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		for (let index = 0; index < 3; index++) {
			scheduler.schedule("reveal", () => {
				ran.push(`reveal${index}`);
				host.nowMs += 5;
			});
		}
		scheduler.schedule("catchup", () => ran.push("catchup"));
		host.pumpFrame();
		expect(ran).toEqual(["reveal0", "reveal1", "reveal2"]);
		host.advance(250);
		expect(ran).toContain("catchup");
	});

	it("runs at least one unit even on a late congested frame", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("reveal", () => ran.push("reveal"));
		scheduler.schedule("catchup", () => ran.push("catchup"));
		// 진입 시점에 이미 전역 예산(12ms)을 지난 프레임 — 최상위 레인의
		// 첫 유닛은 그래도 실행돼야 한다(0 진행 기아 방지).
		host.pumpLateFrame(20);
		expect(ran).toEqual(["reveal"]);
		host.advance(250);
		expect(ran).toEqual(["reveal", "catchup"]);
	});

	it("pauses background lanes on input but keeps reveal running", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("catchup", () => ran.push("catchup"));
		scheduler.schedule("reveal", () => ran.push("reveal"));
		scheduler.notifyInteraction("input");
		host.pumpFrame();
		expect(ran).toEqual(["reveal"]);
		// 100ms 정지 경과 후 재개.
		host.advance(250);
		expect(ran).toEqual(["reveal", "catchup"]);
	});

	it("pauses for a desktop switch until settled plus tail", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("catchup", () => ran.push("catchup"));
		scheduler.notifyInteraction("desktop-switch-start");
		host.advance(250);
		expect(ran).toEqual([]);
		scheduler.notifyInteraction("desktop-switch-settled");
		host.advance(249);
		expect(ran).toEqual([]);
		host.advance(1);
		expect(ran).toEqual(["catchup"]);
	});

	it("resumes after the switch pause ceiling even without a settled signal", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("catchup", () => ran.push("catchup"));
		scheduler.notifyInteraction("desktop-switch-start");
		host.advance(1_900);
		expect(ran).toEqual([]);
		host.advance(100);
		expect(ran).toEqual(["catchup"]);
	});

	it("rescues one starving unit through a persistent pause", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("catchup", () => ran.push("catchup"));
		// 정지를 계속 갱신하면서 기아 상한(10s)을 넘긴다.
		for (let elapsed = 0; elapsed <= 10_050; elapsed += 50) {
			scheduler.notifyInteraction("input");
			host.advance(50);
		}
		expect(ran).toEqual(["catchup"]);
		expect(scheduler.getTelemetry().catchup.starvationRescues).toBe(1);
	});

	it("drives slices from the fallback timer when frames stop arriving", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("maintenance", () => ran.push("maintenance"));
		host.advance(300);
		expect(ran).toEqual(["maintenance"]);
	});

	it("cancelling a unit prevents it from running", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		const cancel = scheduler.schedule("catchup", () => ran.push("catchup"));
		expect(host.pendingWakeCount()).toBe(1);
		cancel();
		expect(host.pendingWakeCount()).toBe(0);
		host.pumpFrame();
		expect(ran).toEqual([]);
		expect(scheduler.hasPendingWork()).toBe(false);
	});

	it("contains a throwing unit and keeps draining", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("catchup", () => {
			throw new Error("boom");
		});
		scheduler.schedule("catchup", () => ran.push("after"));
		host.advance(250);
		expect(ran).toEqual(["after"]);
	});

	it("keeps successors in the next slice when a running unit cancels queued work", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		let cancelQueued = () => {};
		scheduler.schedule("catchup", () => {
			ran.push("first");
			cancelQueued();
			scheduler.schedule("catchup", () => ran.push("successor"));
		});
		cancelQueued = scheduler.schedule("catchup", () => ran.push("cancelled"));
		scheduler.schedule("catchup", () => ran.push("tail"));

		host.advance(250);
		expect(ran).toEqual(["first", "tail"]);
		host.advance(250);
		expect(ran).toEqual(["first", "tail", "successor"]);
	});

	it("dispose drops pending work and stops scheduling", () => {
		const { host, scheduler } = setup();
		const ran: string[] = [];
		scheduler.schedule("catchup", () => ran.push("catchup"));
		scheduler.dispose();
		host.pumpFrame();
		host.advance(1_000);
		expect(ran).toEqual([]);
		expect(scheduler.schedule("catchup", () => ran.push("late"))).toBeTypeOf(
			"function",
		);
		host.pumpFrame();
		expect(ran).toEqual([]);
	});
});
