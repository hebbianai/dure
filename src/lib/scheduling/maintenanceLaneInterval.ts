// setInterval 계약을 유지한 채 각 틱을 maintenance 레인 유닛으로 실행한다.
//
// 폴러들은 각자 setInterval로 자기 페이스만 지켰다 — 합산 부하를 보는 주체가
// 없어 상호작용 프레임에 여러 폴이 겹친다(2026-08-04 전수조사: 비협조 폴링
// 시계). 이 래퍼는 틱 발화는 타이머에 맡기되 실행을 maintenance 레인이
// 승인하게 한다: 상호작용 중 정지, 프레임당 3ms 예산, 기아 상한 60s. 유닛이
// 아직 대기 중이면 다음 틱을 접는다(폴 자체가 최신 상태 조회라 접기 안전).

import {
	type FrameBudgetScheduler,
	getFrameBudgetScheduler,
} from "./frameBudgetScheduler";

type IntervalHandle = ReturnType<typeof setInterval>;

interface PendingUnit {
	cancel: () => void;
	/** 유닛을 등록한 스케줄러 — dispose(HMR·테스트)로 교체되면 옛 유닛은
	 *  실행 없이 버려지므로, 같은 timer의 다음 틱이 stale 대기를 걷어내고
	 *  새 스케줄러에 재승인해야 접힘이 영구화되지 않는다(2026-08-05 리뷰 P1). */
	scheduler: FrameBudgetScheduler;
}

interface MaintenanceInterval {
	callback: () => void;
	source: string;
	pending?: PendingUnit;
}

const intervals = new Map<IntervalHandle, MaintenanceInterval>();

/** Event wakes and periodic ticks share one pending unit and disposal owner. */
export function requestMaintenanceLaneInterval(timer: IntervalHandle): void {
	const interval = intervals.get(timer);
	if (!interval) return;
	const scheduler = getFrameBudgetScheduler();
	const pending = interval.pending;
	if (pending) {
		if (pending.scheduler === scheduler) return;
		pending.cancel();
	}
	const cancel = scheduler.schedule(
		"maintenance",
		() => {
			interval.pending = undefined;
			interval.callback();
		},
		interval.source,
	);
	interval.pending = { cancel, scheduler };
}

export function setMaintenanceLaneInterval(
	callback: () => void,
	delayMs: number,
	source = "maintenance-interval",
): IntervalHandle {
	const timer = setInterval(
		() => requestMaintenanceLaneInterval(timer),
		delayMs,
	);
	intervals.set(timer, { callback, source });
	return timer;
}

export function clearMaintenanceLaneInterval(timer: IntervalHandle): void {
	clearInterval(timer);
	intervals.get(timer)?.pending?.cancel();
	intervals.delete(timer);
}
