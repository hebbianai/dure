// 자동 저장 스케줄러 — 설정 › 일반 › 편집기 › 자동 저장 파일 / 지연.
// 타이머만 다루는 순수 모듈이라 vitest 가짜 타이머로 그대로 검증한다
// (파일 쓰기는 호출자가 onSave에서 한다).

/** 지연을 아무리 짧게 잡아도 한 글자마다 저장하지는 않는다 — 디스크 쓰기와
 *  파일 감시자(에디터·에이전트 양쪽)가 타이핑을 따라 튀는 것을 막는 하한. */
export const AUTO_SAVE_MIN_DELAY_MS = 200;
/** 설정 인풋에 손이 미끄러져 큰 수가 들어가도 저장이 사실상 멈추지는 않게. */
export const AUTO_SAVE_MAX_DELAY_MS = 60_000;

/** 설정값을 실제로 쓸 지연으로 다듬는다. 값이 없거나(빈 인풋·undefined) 숫자가
 *  아니면 기본값을 쓰고, 숫자면 하한/상한 안으로 잘라낸다. 빈 문자열을 0으로
 *  읽지 않는 것이 중요하다 — 인풋을 비운 것은 "0ms"가 아니라 "아직 안 정함"이다. */
export function normalizeAutoSaveDelay(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(AUTO_SAVE_MAX_DELAY_MS, Math.max(AUTO_SAVE_MIN_DELAY_MS, Math.round(raw)));
}

export interface AutoSaveScheduler {
  /** 편집이 있었다고 알린다. 마지막 호출로부터 delayMs 뒤에 onSave가 돈다. */
  schedule: () => void;
  /** 예약을 취소한다(저장됨·닫힘·되돌리기). */
  cancel: () => void;
  /** 예약이 걸려 있으면 지금 즉시 실행한다(수동 저장·pane 닫기 직전). */
  flush: () => void;
  /** 예약이 걸려 있는지 — 테스트와 UI 표시용. */
  pending: () => boolean;
  /** 타이머를 정리한다(언마운트). */
  dispose: () => void;
}

export interface AutoSaveOptions {
  delayMs: number;
  onSave: () => void;
  /** 테스트 주입용 — 기본은 전역 타이머. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/** 마지막 편집 이후 delayMs 동안 조용하면 저장하는 debounce 스케줄러.
 *  타이핑 도중에는 계속 뒤로 밀린다 — "잠시 후 저장"이라는 설정 문구 그대로다. */
export function createAutoSaveScheduler(options: AutoSaveOptions): AutoSaveScheduler {
  const setTimer =
    options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const delay = normalizeAutoSaveDelay(options.delayMs, AUTO_SAVE_MIN_DELAY_MS);

  let handle: number | null = null;
  let disposed = false;

  const cancel = () => {
    if (handle === null) return;
    clearTimer(handle);
    handle = null;
  };

  return {
    schedule: () => {
      if (disposed) return;
      cancel();
      handle = setTimer(() => {
        handle = null;
        options.onSave();
      }, delay);
    },
    cancel,
    flush: () => {
      if (handle === null) return;
      cancel();
      options.onSave();
    },
    pending: () => handle !== null,
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}
