import { describe, expect, it } from "vitest";
import {
	type ClaudeAccountRateLimit,
	type CodexAccountUsage,
	claudeAccountRateLimit,
	claudeUsageForAccount,
	codexAccountUsage,
	codexUnattributedUsage,
	codexUsageForAccount,
	profileKeyForDir,
} from "@/lib/usage/usageAccounts";
import type { ProviderUsage } from "@/lib/usage/usageMeter";

const usage = (input: number): ProviderUsage => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: input,
	usedPercent: null,
	usedPercentWeekly: null,
	resetsAt: null,
	weeklyResetsAt: null,
	usedPercentCapturedAt: null,
	rateLimits: [],
});

const limit = (
	profileKey: string,
	usedPercent: number | null,
): ClaudeAccountRateLimit => ({
	profileKey,
	usedPercent,
	usedPercentWeekly: null,
	resetsAt: null,
	weeklyResetsAt: null,
	usedPercentCapturedAt: null,
});

/** 저널로 귀속된 Codex 묶음. observedOnly는 근거 등급 — 기본은 증명된 귀속. */
function codexBucket(
	credentialId: string | null,
	value: ProviderUsage,
	observedOnly = false,
): CodexAccountUsage {
	return { credentialId, attributed: true, observedOnly, usage: value };
}

describe("profileKeyForDir", () => {
	it("계정 디렉터리의 마지막 이름을 키로 쓴다", () => {
		expect(profileKeyForDir("/Users/x/.hebbian/accounts/claude-second")).toBe(
			"claude-second",
		);
	});

	it("후행 슬래시가 있어도 같은 키다 — 수집기 쪽 정규화와 어긋나면 매칭이 깨진다", () => {
		expect(profileKeyForDir("/Users/x/.hebbian/accounts/claude-second/")).toBe(
			"claude-second",
		);
	});

	it("계정 미선택은 수집기가 쓰는 default 키로 떨어진다", () => {
		expect(profileKeyForDir(undefined)).toBe("default");
		expect(profileKeyForDir("")).toBe("default");
		expect(profileKeyForDir(null)).toBe("default");
	});
});

describe("claudeAccountRateLimit", () => {
	it("그 계정의 실측 한도만 고른다", () => {
		const accounts = [limit("default", 7), limit("claude-second", 61)];
		expect(
			claudeAccountRateLimit(accounts, "/h/.hebbian/accounts/claude-second")
				?.usedPercent,
		).toBe(61);
		expect(claudeAccountRateLimit(accounts, undefined)?.usedPercent).toBe(7);
	});

	it("수집 이력이 없는 계정은 undefined — 다른 계정 값을 빌려오지 않는다", () => {
		const accounts = [limit("default", 7)];
		expect(
			claudeAccountRateLimit(accounts, "/h/.hebbian/accounts/claude-third"),
		).toBeUndefined();
		expect(claudeAccountRateLimit(undefined, undefined)).toBeUndefined();
	});
});

describe("codexAccountUsage", () => {
	const accounts: CodexAccountUsage[] = [
		codexBucket("acct-a", usage(100)),
		codexBucket(null, usage(20)),
		{
			credentialId: null,
			attributed: false,
			observedOnly: false,
			usage: usage(999),
		},
	];

	it("credential id로 귀속 묶음을 고른다", () => {
		expect(codexAccountUsage(accounts, "acct-a")?.usage.input).toBe(100);
	});

	it("기본 credential(null)은 미분류 묶음과 구분된다 — 둘 다 credentialId가 null이다", () => {
		expect(codexAccountUsage(accounts, undefined)?.usage.input).toBe(20);
		expect(codexUnattributedUsage(accounts)?.usage.input).toBe(999);
	});

	it("귀속 근거가 없는 계정은 undefined", () => {
		expect(codexAccountUsage(accounts, "acct-zz")).toBeUndefined();
		expect(codexAccountUsage(undefined, "acct-a")).toBeUndefined();
	});
});

describe("claudeUsageForAccount", () => {
	const total = { ...usage(500), usedPercent: 63 };

	it("계정별 캐시가 없으면 전체 합계로 폴백하고 scoped=false로 알린다", () => {
		const resolved = claudeUsageForAccount(total, [], undefined);
		expect(resolved.scoped).toBe(false);
		expect(resolved.usage.usedPercent).toBe(63);
	});

	it("활성 계정 캐시의 한도를 쓰고 토큰은 공유 합계 그대로 둔다", () => {
		const resolved = claudeUsageForAccount(
			total,
			[limit("claude-second", 12)],
			"/h/a/claude-second",
		);
		expect(resolved.scoped).toBe(true);
		expect(resolved.usage.usedPercent).toBe(12);
		expect(resolved.usage.total).toBe(500);
	});

	// 사용자 보고(2026-07-29)의 핵심: 계정을 바꿔도 다른 계정 %가 그대로 보였다.
	it("이 계정 수집 이력이 없으면 다른 계정 %를 빌려오지 않는다", () => {
		const resolved = claudeUsageForAccount(
			total,
			[limit("claude-second", 12)],
			undefined,
		);
		expect(resolved.scoped).toBe(true);
		expect(resolved.usage.usedPercent).toBeNull();
		expect(resolved.usage.usedPercentCapturedAt).toBeNull();
	});
});

describe("codexUsageForAccount", () => {
	const total = { ...usage(300), usedPercent: 78 };

	it("귀속된 세션이 하나도 없으면 전체 합계로 폴백한다", () => {
		const resolved = codexUsageForAccount(
			total,
			[
				{
					credentialId: null,
					attributed: false,
					observedOnly: false,
					usage: usage(300),
				},
			],
			"acct-a",
		);
		expect(resolved.scoped).toBe(false);
		expect(resolved.usage.usedPercent).toBe(78);
	});

	it("귀속이 시작되면 그 계정 세션만 센다", () => {
		const accounts: CodexAccountUsage[] = [
			codexBucket("acct-a", { ...usage(100), usedPercent: 12 }),
			{
				credentialId: null,
				attributed: false,
				observedOnly: false,
				usage: usage(200),
			},
		];
		expect(
			codexUsageForAccount(total, accounts, "acct-a").usage.usedPercent,
		).toBe(12);
	});

	it("이 계정 세션이 없으면 전체 합계의 모델별 한도도 빌려오지 않는다", () => {
		const totalWithModelLimit: ProviderUsage = {
			...total,
			rateLimits: [
				{
					limitId: "codex_bengalfox",
					limitName: "GPT-5.3-Codex-Spark",
					usedPercent: 77,
					usedPercentWeekly: 81,
					resetsAt: null,
					weeklyResetsAt: null,
				},
			],
		};
		const resolved = codexUsageForAccount(
			totalWithModelLimit,
			[codexBucket("acct-a", usage(100))],
			"acct-b",
		);
		expect(resolved.scoped).toBe(true);
		expect(resolved.usage.rateLimits).toEqual([]);
	});

	// 재부착만 있는 장수 세션(codex-crispy 사례): 숫자는 쓰되 근거 등급을 넘긴다.
	it("관측 전용 묶음도 계정 숫자로 쓰되 observedOnly로 표시한다", () => {
		const accounts = [
			codexBucket("acct-crispy", { ...usage(80), usedPercent: 21 }, true),
		];
		const resolved = codexUsageForAccount(total, accounts, "acct-crispy");
		expect(resolved.scoped).toBe(true);
		expect(resolved.observedOnly).toBe(true);
		expect(resolved.usage.usedPercent).toBe(21);
	});

	it("증명된 묶음은 observedOnly가 아니다", () => {
		const accounts = [
			codexBucket("acct-a", { ...usage(100), usedPercent: 12 }),
		];
		expect(codexUsageForAccount(total, accounts, "acct-a").observedOnly).toBe(
			false,
		);
	});

	it("귀속은 시작됐지만 이 계정 세션이 없으면 0이고, 합계를 빌려오지 않는다", () => {
		const accounts: CodexAccountUsage[] = [
			codexBucket("acct-a", { ...usage(100), usedPercent: 12 }),
		];
		const resolved = codexUsageForAccount(total, accounts, "acct-b");
		expect(resolved.scoped).toBe(true);
		expect(resolved.usage.total).toBe(0);
		expect(resolved.usage.usedPercent).toBeNull();
	});
});
