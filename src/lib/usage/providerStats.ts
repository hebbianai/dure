// provider별 사용량 통계의 데이터 형태 — ipc(usage_stats 응답)와 표시 카드가
// 공유한다. 원래 ProviderUsageCard(컴포넌트)에 살아서 lib→components 역방향
// 의존을 만들었고, 그 한 엣지가 barrel을 타고 순환 ~30개를 발생시켰다
// (2026-08-01 depcruise 도입 실측). 데이터 형태는 lib이 소유한다.

export interface ProvStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	sessions: number;
	turns: number;
	usedPercent?: number | null;
	usedPercentWeekly?: number | null;
	daily: { date: string; total: number }[];
}
