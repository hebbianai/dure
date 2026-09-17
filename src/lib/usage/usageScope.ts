// 설정 > 통계 및 사용량의 스코프·스캔 대상 계산 (Figma 448-31665 / 527-26486).
// 컴포넌트가 아니라 여기에 두는 이유는 "무엇을 집계하는가"가 렌더링과 무관한
// 순수 규칙이기 때문이다 — PTY/Tauri 없이 검증할 수 있어야 한다.

/** 로컬 로그 스캔이 실제로 구현된 공급자.
 *
 *  Rust `usage_stats`(src-tauri/src/usage.rs)가 읽는 것은 `~/.claude/projects`와
 *  Codex 로그 둘뿐이다. 디자인의 빈 상태에는 OpenCode 버튼도 있지만 스캔하는
 *  코드가 없으므로 여기에 넣지 않는다 — 넣으면 영원히 0인 카드가 생긴다. */
export const SCANNABLE_PROVIDERS = ["claude", "codex"] as const;

export type ScannableProvider = (typeof SCANNABLE_PROVIDERS)[number];

/** 사용량 화면이 보고 있는 범위 — 전체 개요이거나 공급자 하나. */
export type UsageScope = "overview" | ScannableProvider;

function isScannableProvider(value: string): value is ScannableProvider {
  return (SCANNABLE_PROVIDERS as readonly string[]).includes(value);
}

export function isUsageScope(value: string): value is UsageScope {
  return value === "overview" || isScannableProvider(value);
}

/** 저장된 목록이 없으면(=한 번도 끄지 않았으면) 전부 켜진 것으로 본다.
 *  기본값을 '꺼짐'으로 두면 지금까지 집계되던 사용자의 화면이 갑자기 비어
 *  버린다. 모르는 값은 버리고, 순서는 SCANNABLE_PROVIDERS를 따른다. */
export function scanningProviders(saved: readonly string[] | undefined): ScannableProvider[] {
  if (!saved) return [...SCANNABLE_PROVIDERS];
  return SCANNABLE_PROVIDERS.filter((p) => saved.includes(p));
}

export function isScanning(saved: readonly string[] | undefined, p: ScannableProvider): boolean {
  return scanningProviders(saved).includes(p);
}

/** 버튼 토글 결과. 저장 형식은 항상 정규화된 목록이라 이후 읽기가 단순해진다. */
export function toggleScanning(
  saved: readonly string[] | undefined,
  p: ScannableProvider,
): ScannableProvider[] {
  const on = scanningProviders(saved);
  return on.includes(p) ? on.filter((x) => x !== p) : SCANNABLE_PROVIDERS.filter((x) => on.includes(x) || x === p);
}

/** 스코프가 고른 공급자 중 스캔이 켜진 것만. 개요는 켜진 전부. */
export function providersInScope(
  scope: UsageScope,
  saved: readonly string[] | undefined,
): ScannableProvider[] {
  const on = scanningProviders(saved);
  return scope === "overview" ? on : on.filter((p) => p === scope);
}

/** 공급자 섹션 헤더의 "{a} 활성화됨 · {b} 데이터 있음".
 *  '활성화됨'은 스캔 대상 수이고 '데이터 있음'은 그중 토큰이 잡힌 수다 —
 *  둘을 같은 값으로 세면 꺼둔 공급자가 있다는 사실이 화면에서 사라진다. */
export function providerSummaryCounts(
  saved: readonly string[] | undefined,
  totals: Partial<Record<ScannableProvider, number>>,
): { enabled: number; withData: number } {
  const on = scanningProviders(saved);
  return {
    enabled: on.length,
    withData: on.filter((p) => (totals[p] ?? 0) > 0).length,
  };
}

/** 고를 수 있는 집계 기간(일).
 *
 *  기본이 7일인 이유: 42일 창은 이 머신에서 6,438개 파일 3.86GB였고 캐시가
 *  비어 있을 때 62초가 걸렸다. 첫 실행에서 1분을 기다리게 하는 기본값은
 *  잘못된 기본값이다. 더 긴 기간은 명시적으로 고른 사람만 받는다. */
export const SCAN_DAY_OPTIONS = [7, 14, 30, 42, 90] as const;

export const DEFAULT_SCAN_DAYS = 7;

/** 저장값이 없거나 목록 밖이면 기본값. Rust 쪽은 1..365로 clamp하지만
 *  화면이 고를 수 없는 값을 저장하고 있으면 셀렉트가 빈 채로 뜬다. */
export function normalizeScanDays(saved: number | undefined): number {
  return (SCAN_DAY_OPTIONS as readonly number[]).includes(saved ?? -1)
    ? (saved as number)
    : DEFAULT_SCAN_DAYS;
}

/** 스캔 상태 — '진행 중'과 '실패'와 '취소'를 구별한다.
 *
 *  이전 구현은 성공 시각(updatedAt)만 들고 있어서, 스캔이 실패해도 화면은
 *  영원히 "스캔 중…"이었다. 진행 중인지 죽었는지 알 수 없는 표시는 거짓말이다. */
export type ScanState =
  | { phase: "idle" }
  | { phase: "scanning"; startedAt: number; days: number }
  | { phase: "done" }
  | { phase: "failed"; message: string }
  | { phase: "cancelled" };

/** 캐시 재사용률 = 캐시 읽기 / (입력 + 캐시 읽기). 분모가 0이면 알 수 없음. */
export function cacheReuseRate(input: number, cacheRead: number): number | null {
  const denom = input + cacheRead;
  return denom > 0 ? (cacheRead / denom) * 100 : null;
}
