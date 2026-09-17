/**
 * requestAnimationFrame 기반 프레임 타임 샘플러 — 연속 렌더링(스크롤, 스트리밍
 * 터미널 출력, 애니메이션) 중 실제 체감 부드러움을 잰다. 전환/pane-open 지연이
 * "한 번 열 때"의 비용이라면, 이건 "열려 있는 동안"의 비용이다.
 *
 * jank = 프레임 간격이 목표(60fps=16.7ms)를 크게 넘는 프레임. worst/jankRatio가
 * 낮을수록 스트리밍 중에도 UI가 매끄럽다.
 */

export interface FrameStats {
  /** 샘플된 프레임 수(간격 개수). */
  frames: number;
  /** 실제 샘플링 구간(ms). */
  durationMs: number;
  /** 평균 프레임레이트(frames / duration). */
  fps: number | null;
  /** 프레임 간격 중앙값(ms). */
  medianFrameMs: number | null;
  /** 95퍼센타일 프레임 간격(ms) — 가끔 튀는 정도. */
  p95FrameMs: number | null;
  /** 최악 프레임 간격(ms). */
  worstFrameMs: number | null;
  /** 33ms(=30fps 미만)를 넘긴 프레임 수 — 눈에 띄는 끊김. */
  longFrames: number;
  /** longFrames / frames — 0에 가까울수록 매끄럽다. */
  jankRatio: number | null;
}

const LONG_FRAME_MS = 33;

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** 프레임 간격 배열을 통계로. 순수 함수라 단위 테스트에서 직접 검증한다. */
export function summarizeFrameIntervals(
  intervals: readonly number[],
  durationMs: number,
): FrameStats {
  const sorted = [...intervals].sort((a, b) => a - b);
  const longFrames = intervals.filter((ms) => ms > LONG_FRAME_MS).length;
  return {
    frames: intervals.length,
    durationMs,
    fps: durationMs > 0 ? (intervals.length / durationMs) * 1000 : null,
    medianFrameMs: percentile(sorted, 50),
    p95FrameMs: percentile(sorted, 95),
    worstFrameMs: sorted.length ? sorted[sorted.length - 1] : null,
    longFrames,
    jankRatio: intervals.length ? longFrames / intervals.length : null,
  };
}

/**
 * `durationMs` 동안 rAF 간격을 모아 통계로 돌려준다. 브라우저 전용(rAF 필요).
 * 테스트 주입을 위해 raf/now를 파라미터화한다.
 */
export function sampleFrames(
  durationMs = 3000,
  raf: (cb: (t: number) => void) => number = requestAnimationFrame,
  now: () => number = () => performance.now(),
): Promise<FrameStats> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    const start = now();
    let last = start;
    const tick = (t: number) => {
      intervals.push(t - last);
      last = t;
      if (t - start >= durationMs) {
        // 첫 간격은 스케줄 지연이 섞여 편향되므로 버린다.
        resolve(summarizeFrameIntervals(intervals.slice(1), t - start));
        return;
      }
      raf(tick);
    };
    raf(tick);
  });
}
