import {
	ForegroundInteractionBudget,
	type ForegroundInteractionKind,
	getForegroundInteractionBudget,
} from "./foregroundInteractionBudget";

/**
 * 전역 프레임 예산 스케줄러 — 지연 가능한(deferrable) 백그라운드 작업의 단일
 * 승인기. 서브시스템별 자체 타이머가 합산 부하를 못 보는 구조 문제를 해소한다.
 *
 * 레인은 우선순위 순으로 소비되고, 슬라이스당 레인별 예산(ms)을 초과하면 다음
 * wake로 양보한다. 상호작용(입력·데스크탑 전환) 중에는 reveal 외 레인이
 * 정지하되, 레인별 기아 상한이 지나면 1유닛을 강제 실행한다(bounded progress —
 * WKWebView는 부하 중 idle/rAF 전달을 멈출 수 있으므로 순수 콜백 의존 금지).
 */

export type SchedulerLane =
	| "reveal"
	| "catchup"
	| "maintenance";

const SCHEDULER_LANES: readonly SchedulerLane[] = [
	"reveal",
	"catchup",
	"maintenance",
];
const REVEAL_LANES: readonly SchedulerLane[] = ["reveal"];
const BACKGROUND_LANES: readonly SchedulerLane[] = [
	"catchup",
	"maintenance",
];

export interface FrameBudgetHost {
	now(): number;
	requestFrame(callback: (frameStartMs: number) => void): number;
	cancelFrame(handle: number): void;
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
}

interface LanePolicy {
	/** 한 슬라이스에서 이 레인이 소비할 수 있는 최대 시간. */
	budgetMsPerSlice: number;
	/** 상호작용 일시정지 대상 여부. reveal은 전환 그 자체이므로 계속 실행. */
	pausedByInteraction: boolean;
	/** 이 시간 이상 대기한 유닛은 정지 신호를 무시하고 1유닛 강제 실행. */
	starvationMaxDelayMs: number;
}

const LANE_POLICIES: Record<SchedulerLane, LanePolicy> = {
	reveal: {
		budgetMsPerSlice: 12,
		pausedByInteraction: false,
		starvationMaxDelayMs: 0,
	},
	catchup: {
		budgetMsPerSlice: 6,
		pausedByInteraction: true,
		starvationMaxDelayMs: 10_000,
	},
	maintenance: {
		budgetMsPerSlice: 3,
		pausedByInteraction: true,
		starvationMaxDelayMs: 60_000,
	},
};

/** 한 슬라이스 전체(모든 레인 합)의 상한. */
const GLOBAL_SLICE_BUDGET_MS = 12;
/** rAF가 이 시간 안에 오지 않으면 타이머로 슬라이스를 강제 구동한다. */
const FRAME_FALLBACK_DELAY_MS = 250;

export interface LaneTelemetry {
	unitsRun: number;
	msSpent: number;
	/** 예산 소진으로 다음 슬라이스에 양보한 횟수. */
	yields: number;
	/** 기아 상한 도달로 정지를 뚫고 강제 실행한 유닛 수. */
	starvationRescues: number;
	pending: number;
	sources: Record<string, FrameBudgetSourceTelemetry>;
}

interface FrameBudgetSourceTelemetry {
	unitsRun: number;
	msSpent: number;
	pending: number;
}

export type FrameBudgetTelemetry = Record<SchedulerLane, LaneTelemetry>;

export type FrameBudgetUnitPolicy =
	| { readonly completion: "inline" }
	| { readonly completion: "deferred"; readonly burst?: boolean };

const INLINE_UNIT_POLICY: FrameBudgetUnitPolicy = { completion: "inline" };

interface QueuedUnit {
	run: (() => void) | undefined;
	source: string;
	policy: FrameBudgetUnitPolicy;
	enqueuedAtMs: number;
}

export class FrameBudgetScheduler {
	private readonly queues: Record<SchedulerLane, Set<QueuedUnit>> = {
		reveal: new Set(),
		catchup: new Set(),
		maintenance: new Set(),
	};
	private readonly telemetry: FrameBudgetTelemetry = {
		reveal: emptyLaneTelemetry(),
		catchup: emptyLaneTelemetry(),
		maintenance: emptyLaneTelemetry(),
	};
	private frameHandle: number | undefined;
	private fallbackHandle: number | undefined;
	private lastRevealRunAtMs: number | undefined;
	private disposed = false;

	constructor(
		private readonly host: FrameBudgetHost,
		private readonly interactionBudget = new ForegroundInteractionBudget({
			now: () => host.now(),
		}),
	) {}

	/**
	 * Inline units must be chunked to a few milliseconds. Deferred units move
	 * their material cost past the callback boundary, so one sustained unit is
	 * admitted per lane slice; a caller-owned cold burst may share that slice.
	 * Cancellation releases pending work immediately. Retaining its handle does
	 * not retain the callback after cancellation, execution or disposal.
	 */
	schedule(
		lane: SchedulerLane,
		run: () => void,
		source = "unattributed",
		policy: FrameBudgetUnitPolicy = INLINE_UNIT_POLICY,
	): () => void {
		if (this.disposed) return () => {};
		if (lane === "reveal" && !this.hasPendingIn(REVEAL_LANES)) {
			// Start the shared stalled-rAF deadline at this reveal burst, not at
			// the last frame from an older interaction.
			this.lastRevealRunAtMs = this.host.now();
		}
		const unit: QueuedUnit = {
			run,
			source,
			policy,
			enqueuedAtMs: this.host.now(),
		};
		this.queues[lane].add(unit);
		this.reconcileWake();
		return () => {
			if (!this.queues[lane].delete(unit)) return;
			unit.run = undefined;
			this.reconcileWake();
		};
	}

	notifyInteraction(kind: ForegroundInteractionKind): void {
		this.interactionBudget.note(kind);
	}

	getTelemetry(): FrameBudgetTelemetry {
		const snapshot = {} as FrameBudgetTelemetry;
		for (const lane of SCHEDULER_LANES) {
			const sources = Object.fromEntries(
				Object.entries(this.telemetry[lane].sources).map(([source, stats]) => [
					source,
					{ ...stats, pending: 0 },
				]),
			);
			for (const unit of this.queues[lane]) {
				let sourceStats = sources[unit.source];
				if (!sourceStats) {
					sourceStats = emptySourceTelemetry();
					sources[unit.source] = sourceStats;
				}
				sourceStats.pending += 1;
			}
			snapshot[lane] = {
				...this.telemetry[lane],
				pending: this.queues[lane].size,
				sources,
			};
		}
		return snapshot;
	}

	hasPendingWork(): boolean {
		return this.hasPendingIn(SCHEDULER_LANES);
	}

	dispose(): void {
		this.disposed = true;
		this.disarm();
		for (const lane of SCHEDULER_LANES) {
			for (const unit of this.queues[lane]) unit.run = undefined;
			this.queues[lane].clear();
		}
	}

	private reconcileWake(): void {
		if (this.disposed) return;
		if (!this.hasPendingWork()) {
			this.disarm();
			return;
		}
		const revealPending = this.queues.reveal.size > 0;
		if (revealPending && this.frameHandle === undefined) {
			this.frameHandle = this.host.requestFrame((frameStartMs) => {
				this.frameHandle = undefined;
				this.lastRevealRunAtMs = this.host.now();
				this.runSlice(frameStartMs, REVEAL_LANES);
				// When reveal is the only work, this timer is its stalled-rAF
				// watchdog. A delivered frame renews that deadline. Lower lanes keep
				// their original bounded deadline instead of being pulled forward by
				// (or postponed behind) continuous reveal frames.
				if (!this.hasPendingIn(BACKGROUND_LANES)) {
					this.resetFallbackWake();
				}
			});
		} else if (!revealPending && this.frameHandle !== undefined) {
			this.host.cancelFrame(this.frameHandle);
			this.frameHandle = undefined;
		}
		if (this.fallbackHandle === undefined) {
			this.fallbackHandle = this.host.setTimeout(() => {
				this.fallbackHandle = undefined;
				const now = this.host.now();
				const revealStalled =
					this.queues.reveal.size > 0 &&
					(this.lastRevealRunAtMs === undefined ||
						now - this.lastRevealRunAtMs >= FRAME_FALLBACK_DELAY_MS);
				if (revealStalled && this.frameHandle !== undefined) {
					this.host.cancelFrame(this.frameHandle);
					this.frameHandle = undefined;
				}
				if (revealStalled) this.lastRevealRunAtMs = now;
				// Background work never borrows a display-frame wake. This same
				// existing timer includes reveal only when rAF itself stopped making
				// progress, so no second watchdog or producer-local timer is needed.
				this.runSlice(
					now,
					revealStalled ? SCHEDULER_LANES : BACKGROUND_LANES,
				);
			}, this.nextFallbackDelayMs());
		}
	}

	private nextFallbackDelayMs(): number {
		if (this.queues.reveal.size === 0 || this.lastRevealRunAtMs === undefined) {
			return FRAME_FALLBACK_DELAY_MS;
		}
		return Math.max(
			0,
			FRAME_FALLBACK_DELAY_MS -
				(this.host.now() - this.lastRevealRunAtMs),
		);
	}

	private resetFallbackWake(): void {
		if (this.fallbackHandle !== undefined) {
			this.host.clearTimeout(this.fallbackHandle);
			this.fallbackHandle = undefined;
		}
		this.reconcileWake();
	}

	private disarm(): void {
		if (this.frameHandle !== undefined) {
			this.host.cancelFrame(this.frameHandle);
			this.frameHandle = undefined;
		}
		if (this.fallbackHandle !== undefined) {
			this.host.clearTimeout(this.fallbackHandle);
			this.fallbackHandle = undefined;
		}
	}

	private runSlice(
		sliceStartMs: number,
		lanes: readonly SchedulerLane[],
	): void {
		if (this.disposed) return;
		const deadline = sliceStartMs + GLOBAL_SLICE_BUDGET_MS;
		const paused = this.isPaused();
		// 슬라이스당 최소 1유닛은 보장한다 — rAF 콜백이 프레임 타임스탬프보다
		// 늦게 도는 혼잡 상황(40-pane 렌더러가 앞서는, 이 스케줄러가 겨냥하는
		// 바로 그 상황)에서 최상위 레인마저 0 진행으로 굶는 것을 막는다.
		let ranAnyUnit = false;

		for (const lane of lanes) {
			const policy = LANE_POLICIES[lane];
			const queue = this.queues[lane];
			const laneStats = this.telemetry[lane];
			const laneDeadline = Math.min(
				deadline,
				sliceStartMs + policy.budgetMsPerSlice,
			);
			// Drain the work that was waiting when this lane's slice began. A unit
			// may enqueue its successor synchronously; that successor belongs to the
			// next slice so a zero-cost continuous producer cannot spin in one wake.
			const batch = [...queue];
			let batchEntriesRemaining = batch.length;
			let ranLaneUnit = false;
			let ranDeferredUnit = false;
			const lanePaused = paused && policy.pausedByInteraction;

			for (const head of batch) {
				const run = head.run;
				if (!run) {
					batchEntriesRemaining -= 1;
					continue;
				}
				const now = this.host.now();
				const starving =
					policy.starvationMaxDelayMs > 0 &&
					now - head.enqueuedAtMs >= policy.starvationMaxDelayMs;
				if (lanePaused && !starving) break;
				if (
					head.policy.completion === "deferred" &&
					!head.policy.burst &&
					ranDeferredUnit
				) {
					laneStats.yields += 1;
					break;
				}
				if (now >= laneDeadline && ranLaneUnit) {
					laneStats.yields += 1;
					break;
				}
				if (now >= deadline && !starving && ranAnyUnit) {
					laneStats.yields += 1;
					break;
				}
				queue.delete(head);
				head.run = undefined;
				batchEntriesRemaining -= 1;
				const started = this.host.now();
				try {
					run();
				} catch (error) {
					// 한 유닛의 실패가 슬라이스 전체·다른 서브시스템을 멈추면 안 된다.
					console.error("[frame-budget] unit failed", lane, error);
				} finally {
					const elapsed = this.host.now() - started;
					let sourceStats = laneStats.sources[head.source];
					if (!sourceStats) {
						sourceStats = emptySourceTelemetry();
						laneStats.sources[head.source] = sourceStats;
					}
					laneStats.unitsRun += 1;
					laneStats.msSpent += elapsed;
					sourceStats.unitsRun += 1;
					sourceStats.msSpent += elapsed;
					if (lanePaused && starving) laneStats.starvationRescues += 1;
					if (
						head.policy.completion === "deferred" &&
						!head.policy.burst
					) {
						ranDeferredUnit = true;
					}
					ranLaneUnit = true;
					ranAnyUnit = true;
				}
				// 기아 구제는 레인당 1유닛만 — 정지의 의미를 지키면서 진행만 보장.
				if (lanePaused) break;
			}
			if (batchEntriesRemaining === 0 && queue.size > 0) {
				laneStats.yields += 1;
			}
		}

		this.reconcileWake();
	}

	private hasPendingIn(lanes: readonly SchedulerLane[]): boolean {
		return lanes.some((lane) => this.queues[lane].size > 0);
	}

	private isPaused(): boolean {
		return this.interactionBudget.isBackgroundPaused();
	}
}

function emptyLaneTelemetry(): LaneTelemetry {
	return {
		unitsRun: 0,
		msSpent: 0,
		yields: 0,
		starvationRescues: 0,
		pending: 0,
		sources: {},
	};
}

function emptySourceTelemetry(): FrameBudgetSourceTelemetry {
	return { unitsRun: 0, msSpent: 0, pending: 0 };
}

/** 브라우저는 rAF, rAF가 없는 환경(node 테스트 등)은 16ms 타이머 근사.
 *  전역 함수는 호출 시점에 조회한다 — 가짜 타이머 설치 전에 참조를 붙잡아
 *  두면 테스트가 시간을 진행해도 슬라이스가 영영 돌지 않는다. */
function createDefaultHost(): FrameBudgetHost {
	return {
		now: () => performance.now(),
		requestFrame: (callback) => {
			const g = globalThis as Partial<{
				requestAnimationFrame: (cb: (t: number) => void) => number;
			}>;
			if (typeof g.requestAnimationFrame === "function") {
				return g.requestAnimationFrame(callback);
			}
			return setTimeout(
				() => callback(performance.now()),
				16,
			) as unknown as number;
		},
		cancelFrame: (handle) => {
			const g = globalThis as Partial<{
				cancelAnimationFrame: (h: number) => void;
			}>;
			if (typeof g.cancelAnimationFrame === "function") {
				g.cancelAnimationFrame(handle);
			} else {
				clearTimeout(handle);
			}
		},
		setTimeout: (callback, delayMs) =>
			setTimeout(callback, delayMs) as unknown as number,
		clearTimeout: (handle) => clearTimeout(handle),
	};
}

let sharedScheduler: FrameBudgetScheduler | undefined;

/** 앱 전역 싱글턴. 테스트/HMR에서는 reset으로 교체한다. */
export function getFrameBudgetScheduler(): FrameBudgetScheduler {
	if (!sharedScheduler) {
		sharedScheduler = new FrameBudgetScheduler(
			createDefaultHost(),
			getForegroundInteractionBudget(),
		);
	}
	return sharedScheduler;
}

export function resetFrameBudgetSchedulerForTest(
	replacement?: FrameBudgetScheduler,
): void {
	sharedScheduler?.dispose();
	sharedScheduler = replacement;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		sharedScheduler?.dispose();
		sharedScheduler = undefined;
	});
}
