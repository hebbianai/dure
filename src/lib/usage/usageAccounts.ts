/**
 * 계정별 사용량 선택 로직 (hebbian-frontend-55o4).
 *
 * 두 provider가 계정 귀속에서 알 수 있는 것이 다르고, 그 차이가 그대로 타입에
 * 드러난다 — 억지로 같은 모양으로 맞추면 없는 숫자를 지어내게 된다.
 *
 * - Codex: conversation→credential 저널(wa6s)로 세션 단위 귀속이 되므로 토큰과
 *   한도 % 모두 계정별. 저널 근거가 없는 세션은 '미분류'로 남고 활성 계정
 *   것으로 접히지 않는다.
 * - Claude: transcript 저장소(~/.claude/projects)를 계정 오버레이가 심링크로
 *   공유해 토큰 귀속이 원천 불가. 계정별로 알 수 있는 건 statusLine 수집기가
 *   프로필별로 남긴 실측 한도뿐이다.
 */
import type { ProviderUsage } from "@/lib/usage/usageMeter";

/** 수집기가 캐시 파일 이름으로 쓰는 프로필 키 — 계정 디렉터리 이름 또는 "default". */
const DEFAULT_PROFILE_KEY = "default";

export interface ClaudeAccountRateLimit {
	profileKey: string;
	usedPercent: number | null;
	usedPercentWeekly: number | null;
	resetsAt: number | null;
	weeklyResetsAt: number | null;
	usedPercentCapturedAt: number | null;
}

export interface CodexAccountUsage {
	/** attributed=true이면서 null이면 기본 credential. */
	credentialId: string | null;
	/** 저널 근거가 있는지. false면 '미분류' 묶음이다. */
	attributed: boolean;
	/** 근거가 전부 '관측'뿐인지 — 이미 돌던 runtime generation에 재부착한
	 *  launch라 그 credential이 대화를 만들었다는 증명은 아니다. 장수 세션은
	 *  generation을 다시 만들지 않으므로 이 등급이 없으면 그 계정은 영영
	 *  비어 보인다. 숫자는 쓰되 UI가 근거 등급을 밝힌다. */
	observedOnly: boolean;
	usage: ProviderUsage;
}

/** 계정 디렉터리 절대경로 → 수집기 프로필 키. 계정 미선택(기본 로그인)이면
 *  "default" — 수집기가 CLAUDE_CONFIG_DIR 없이 돌 때 쓰는 키와 같아야 한다. */
export function profileKeyForDir(dir: string | undefined | null): string {
	if (!dir) return DEFAULT_PROFILE_KEY;
	const leaf = dir.replace(/\/+$/, "").split("/").pop();
	return leaf || DEFAULT_PROFILE_KEY;
}

/** 이 계정의 Claude 실측 한도. 수집 이력이 없으면 undefined —
 *  호출자는 0%로 위장하지 말고 "수집 없음"으로 보여야 한다. */
export function claudeAccountRateLimit(
	accounts: ClaudeAccountRateLimit[] | undefined,
	dir: string | undefined | null,
): ClaudeAccountRateLimit | undefined {
	const key = profileKeyForDir(dir);
	return accounts?.find((entry) => entry.profileKey === key);
}

/** 이 계정으로 귀속된 Codex 사용량. 귀속 근거가 없으면 undefined. */
export function codexAccountUsage(
	accounts: CodexAccountUsage[] | undefined,
	credentialId: string | undefined | null,
): CodexAccountUsage | undefined {
	const id = credentialId ?? null;
	return accounts?.find(
		(entry) => entry.attributed && entry.credentialId === id,
	);
}

/** 어느 계정에도 귀속되지 않은 Codex 사용량(저널 이전·앱 밖 세션). */
export function codexUnattributedUsage(
	accounts: CodexAccountUsage[] | undefined,
): CodexAccountUsage | undefined {
	return accounts?.find((entry) => !entry.attributed);
}

/** 표시할 사용량과 그것이 계정 범위인지. scoped=false면 전체 합계이며,
 *  UI는 그 사실을 밝혀야 한다 — 합계를 계정 값인 척 보여주면 계정을 바꿔도
 *  숫자가 안 변하는 그 버그로 되돌아간다. */
export interface ScopedUsage {
	usage: ProviderUsage;
	scoped: boolean;
	/** 이 계정 숫자의 근거가 재부착 관측뿐인지 — UI가 그 등급을 밝혀야 한다. */
	observedOnly?: boolean;
}

const NO_RATE_LIMIT = {
	usedPercent: null,
	usedPercentWeekly: null,
	resetsAt: null,
	weeklyResetsAt: null,
	usedPercentCapturedAt: null,
	rateLimits: [],
} as const;

/** Claude 헤드라인: 토큰은 계정 공유 저장소라 합계 그대로 두고 한도만 활성
 *  계정 것으로 바꾼다. 계정별 캐시가 하나라도 있는데 이 계정 것이 없으면
 *  '수집 없음'이다 — 다른 계정 값을 빌려오지 않는다. 아직 아무 계정도 수집되지
 *  않았으면(구버전 수집기 등) 레거시 전역 캐시로 폴백한다. */
export function claudeUsageForAccount(
	total: ProviderUsage,
	accounts: ClaudeAccountRateLimit[] | undefined,
	dir: string | undefined | null,
): ScopedUsage {
	if (!accounts || accounts.length === 0)
		return { usage: total, scoped: false };
	const entry = claudeAccountRateLimit(accounts, dir);
	return {
		usage: {
			...total,
			...NO_RATE_LIMIT,
			...(entry && {
				usedPercent: entry.usedPercent,
				usedPercentWeekly: entry.usedPercentWeekly,
				resetsAt: entry.resetsAt,
				weeklyResetsAt: entry.weeklyResetsAt,
				usedPercentCapturedAt: entry.usedPercentCapturedAt,
			}),
		},
		scoped: true,
	};
}

/** Codex 헤드라인: 저널로 이 계정에 귀속된 세션만. 귀속 근거가 하나도 없으면
 *  (저널 도입 전 세션뿐) 전체 합계로 폴백하되 scoped=false로 알린다. */
export function codexUsageForAccount(
	total: ProviderUsage,
	accounts: CodexAccountUsage[] | undefined,
	credentialId: string | undefined | null,
): ScopedUsage {
	if (!accounts?.some((entry) => entry.attributed))
		return { usage: total, scoped: false };
	const entry = codexAccountUsage(accounts, credentialId);
	return entry
		? { usage: entry.usage, scoped: true, observedOnly: entry.observedOnly }
		: {
				usage: {
					...total,
					...NO_RATE_LIMIT,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
				scoped: true,
			};
}
