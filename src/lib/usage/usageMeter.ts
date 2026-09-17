// 사용량 배지(DesktopBar)의 순수 파생 로직 (hebbian-frontend-ow9).
//
// 배경: Claude 로그에는 provider가 계산한 rate-limit %가 없다(서버측, /usage로만
// 노출). 그래서 ccusage 같은 로컬 트래커는 %가 아니라 토큰/코스트를 보여준다.
// Codex 로그에는 실제 rate_limits(primary/secondary.{used_percent,window_minutes,
// resets_at})가 있으니 그 %를 그대로 쓴다. 이 모듈은 그 차이를 정직하게 반영한다.

interface CodexRateLimitUsage {
  /** Provider가 보고한 안정적인 bucket id. 일반 Codex는 "codex". */
  limitId: string;
  /** 사용자에게 보여줄 모델/한도 이름. 일반 한도는 null일 수 있다. */
  limitName: string | null;
  usedPercent: number | null;
  usedPercentWeekly: number | null;
  resetsAt: number | null;
  weeklyResetsAt: number | null;
}

export interface ProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** 단기(5h) 한도 사용률(%) — Codex는 세션 로그 실측, Claude는 statusLine
   *  수집기 캐시 실측(수집기 미설치면 null). */
  usedPercent: number | null;
  /** 주간(7일) 한도 사용률(%). */
  usedPercentWeekly: number | null;
  /** 단기 한도 리셋 시각(epoch seconds). */
  resetsAt: number | null;
  /** 주간 한도 리셋 시각(epoch seconds). */
  weeklyResetsAt: number | null;
  /** 실측 % 수집 시각(epoch seconds). Claude는 이 시점 기준 하한,
   * Codex는 App Server의 마지막 성공 snapshot. */
  usedPercentCapturedAt: number | null;
  /** Codex가 별도 예산으로 보고한 limit_id별 최신 한도. */
  rateLimits: readonly CodexRateLimitUsage[];
}

/** Compact decimal units; promote rounded boundaries instead of showing 1000M. */
export function fmtTokens(n: number): string {
  if (n < 1_000 || !Number.isFinite(n)) return String(n);
  const units = ["k", "M", "B", "T"];
  for (let i = 0; i < units.length; i++) {
    const digits = Math.min(i, 2);
    const value = Number((n / 1000 ** (i + 1)).toFixed(digits));
    if (value < 1000 || i === units.length - 1) return `${value}${units[i]}`;
  }
  return String(n);
}

/** epoch(초) 리셋 시각 → "23m" / "3h 40m" / "2d 5h". 과거·부재면 null.
 *  단위 하나로 뭉개면(예: 3h 40m → "4h") 리셋 임박 판단이 어긋난다는
 *  사용자 피드백으로 두 단위 조합 표시 (2026-07-29). */
export function fmtReset(resetsAtSec: number | null | undefined, nowSec: number): string | null {
  if (!resetsAtSec) return null;
  const dsec = resetsAtSec - nowSec;
  if (dsec <= 0) return null;
  if (dsec < 3600) return `${Math.max(1, Math.round(dsec / 60))}m`;
  if (dsec < 86400) {
    const hours = Math.floor(dsec / 3600);
    const minutes = Math.round((dsec % 3600) / 60);
    if (minutes === 60) return `${hours + 1}h`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(dsec / 86400);
  const hours = Math.round((dsec % 86400) / 3600);
  if (hours === 24) return `${days + 1}d`;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** Claude 헤드라인 토큰: 입력+출력만. 캐시 생성은 컨텍스트 관리 부산물이라
 *  전체의 80%+를 차지하며 체감 사용량과 동떨어진 거대 수치를 만든다
 *  (2026-07-29 실측: 5h 3.3M 중 84%가 cacheWrite — 사용자 "너무 많아 보임").
 *  캐시 생성·읽기는 팝오버 분해 행에 따로 보여준다. 실제 한도 %는 statusLine
 *  수집기 실측이 담당한다(가짜 % 금지 원칙 유지). */
export function claudeUsedTokens(u: ProviderUsage): number {
  return u.input + u.output;
}

type CompactUsageLevel = "unknown" | "normal" | "warning" | "danger";

export interface CompactUsageIndicator {
  /** Ring에 그릴 0..100 사용률. null은 provider 실측이 없다는 뜻이다. */
  pct: number | null;
  level: CompactUsageLevel;
  /** 상단 공간을 쓰는 숫자는 주의 구간부터만 노출한다. */
  showLabel: boolean;
}

/** DesktopBar의 compact usage ring 파생값. 상단은 위험도만 빠르게 알리고,
 *  정상 구간의 정확한 수치와 reset/token 정보는 tooltip/popover에 남긴다. */
export function compactUsageIndicator(pct: number | null): CompactUsageIndicator {
  if (pct == null || !Number.isFinite(pct)) {
    return { pct: null, level: "unknown", showLabel: false };
  }
  const clamped = Math.min(100, Math.max(0, pct));
  if (clamped >= 85) return { pct: clamped, level: "danger", showLabel: true };
  if (clamped >= 60) return { pct: clamped, level: "warning", showLabel: true };
  return { pct: clamped, level: "normal", showLabel: false };
}

export interface CodexMeter {
  /** 표시할 사용률(%) — 5h가 있으면 5h, 없으면 weekly, 둘 다 없으면 null. */
  pct: number | null;
  /** 어느 창의 값인지 — null이면 데이터 없음. */
  window: "5h" | "weekly" | null;
  /** 리셋까지 남은 시간 라벨(있으면). */
  resetLabel: string | null;
}

function rateLimitMeter(
  usedPercent: number | null,
  usedPercentWeekly: number | null,
  resetsAt: number | null,
  weeklyResetsAt: number | null,
  nowSec: number,
): CodexMeter {
  if (usedPercent != null) {
    return { pct: usedPercent, window: "5h", resetLabel: fmtReset(resetsAt, nowSec) };
  }
  if (usedPercentWeekly != null) {
    return {
      pct: usedPercentWeekly,
      window: "weekly",
      resetLabel: fmtReset(weeklyResetsAt, nowSec),
    };
  }
  return { pct: null, window: null, resetLabel: null };
}

/** provider가 보고한 실제 rate-limit %를 고른다. 5h 창을 우선하되, weekly만
 *  있으면 weekly를 쓴다. 데이터가 없으면 null — 절대 0%/100%로 위장하지 않는다. */
export function codexMeter(u: ProviderUsage, nowSec: number): CodexMeter {
  return rateLimitMeter(
    u.usedPercent,
    u.usedPercentWeekly,
    u.resetsAt,
    u.weeklyResetsAt,
    nowSec,
  );
}

export interface NamedCodexMeter extends CodexMeter {
  limitId: string;
  limitName: string | null;
  weeklyPct: number | null;
  weeklyResetLabel: string | null;
}

/** 일반 codex 예산과 독립적인 모델별 bucket만 반환한다. 이름을 하드코딩하지
 *  않아 새 모델 limit_id가 추가돼도 백엔드가 보고한 이름으로 바로 표시된다. */
export function codexModelMeters(u: ProviderUsage, nowSec: number): NamedCodexMeter[] {
  return (u.rateLimits ?? [])
    .filter((limit) => limit.limitId !== "codex")
    .map((limit) => ({
      limitId: limit.limitId,
      limitName: limit.limitName,
      weeklyPct: limit.usedPercentWeekly,
      weeklyResetLabel: fmtReset(limit.weeklyResetsAt, nowSec),
      ...rateLimitMeter(
        limit.usedPercent,
        limit.usedPercentWeekly,
        limit.resetsAt,
        limit.weeklyResetsAt,
        nowSec,
      ),
    }))
    .filter((limit) => limit.pct != null);
}

/** Claude: statusLine 수집기 캐시의 실측 %가 있으면 Codex와 같은 의미의 미터.
 *  없으면 pct=null — 호출자가 토큰 표시로 폴백한다(가짜 % 금지). */
export function claudeMeter(u: ProviderUsage, nowSec: number): CodexMeter {
  return codexMeter(u, nowSec);
}

/** 경과 시간 라벨 — "1m" / "34m" / "2h" / "3d" (fmtReset과 같은 어휘).
 *  부재·미래면 null. 문장("N 전 수집")은 호출자가 i18n으로 감싼다. */
export function fmtAgo(pastSec: number | null | undefined, nowSec: number): string | null {
  if (!pastSec) return null;
  const dsec = nowSec - pastSec;
  if (dsec < 0) return null;
  if (dsec < 3600) return `${Math.max(1, Math.round(dsec / 60))}m`;
  if (dsec < 86400) return `${Math.round(dsec / 3600)}h`;
  return `${Math.round(dsec / 86400)}d`;
}
