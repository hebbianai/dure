// Provider completion-source classification for the settings surface. Native
// lifecycle hooks are exact; legacy completion-only reports and screen
// inference are explicitly approximate.

import type { ProviderWiringStatus } from "@/lib/ipc";
import type { Provider } from "@/types";

export type CompletionSource = "hook_events" | "turn_notify" | "inference";

type SemanticVersion = readonly [number, number, number];

const CODEX_NATIVE_LIFECYCLE_MIN_VERSION: SemanticVersion = [0, 151, 0];

function parsedSemanticVersion(version: string | undefined): SemanticVersion | null {
	const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function codexSupportsNativeLifecycle(version: string | undefined): boolean {
	const parsed = parsedSemanticVersion(version);
	if (!parsed) return false;
	return (
		parsed[0] - CODEX_NATIVE_LIFECYCLE_MIN_VERSION[0] ||
		parsed[1] - CODEX_NATIVE_LIFECYCLE_MIN_VERSION[1] ||
		parsed[2] - CODEX_NATIVE_LIFECYCLE_MIN_VERSION[2]
	) >= 0;
}

/** One table owns completion-source classification. Unknown providers and
 *  unavailable wiring fall back to silent screen inference. */
const COMPLETION_RESOLVERS: Partial<
	Record<
		Provider,
		(wiring: ProviderWiringStatus, providerVersion: string | undefined) => CompletionSource
	>
> = {
	claude: (wiring) =>
		wiring.claude.managedHooksPublished ? "hook_events" : "inference",
	codex: (wiring, providerVersion) => {
		if (!wiring.codex.notifyPublished) return "inference";
		return codexSupportsNativeLifecycle(providerVersion) ? "hook_events" : "turn_notify";
	},
};

export function completionSource(
	provider: Provider,
	wiring: ProviderWiringStatus | null,
	providerVersion?: string,
): CompletionSource {
	if (!wiring) return "inference";
	return COMPLETION_RESOLVERS[provider]?.(wiring, providerVersion) ?? "inference";
}

/** 이 provider에 "완료 알림 원천"이라는 개념 자체가 있는가. 표에 없는
 *  provider는 배선할 대상이 없어 영원히 `inference`로 떨어지는데, 그걸 경고색
 *  "화면 추론(근사)"으로 그리면 사람이 해결할 수 없는 경고가 화면에 상주한다 —
 *  해결 불가능한 경고는 진짜 경고까지 무시하게 만든다. 화면이 그 구분을 물어볼
 *  수 있게 표 소속을 노출한다. */
export function hasCompletionSource(provider: Provider): boolean {
	return provider in COMPLETION_RESOLVERS;
}

/** codex 배선 세부 행 — 페이지가 그대로 그린다. `value`는 3상: 충족/미충족/
 *  해당 없음(null — 시스템 기본값 계정은 오버레이가 없어 주입 대상이 아니다). */
export interface CodexWiringRow {
	key: "notifyPublished" | "notifyMerged" | "trustRekeyed";
	value: boolean | null;
}

const WIRING_ROWS: Partial<
	Record<Provider, (wiring: ProviderWiringStatus | null) => CodexWiringRow[]>
> = {
	codex: (wiring) => {
		const overlay = wiring?.codex.overlay ?? null;
		return [
			{ key: "notifyPublished", value: wiring?.codex.notifyPublished ?? false },
			{ key: "notifyMerged", value: overlay ? overlay.notifyMerged : null },
			{ key: "trustRekeyed", value: overlay ? overlay.trustRekeyed : null },
		];
	},
};

/** provider별 배선 세부 행 — 세부가 없는 provider는 빈 배열. */
export function providerWiringRows(
	provider: Provider,
	wiring: ProviderWiringStatus | null,
): CodexWiringRow[] {
	return WIRING_ROWS[provider]?.(wiring) ?? [];
}
