// 최근 연 파일 기록 — 순수 판정. 뷰어로 연 파일을 최신순으로 유지하고
// 같은 파일은 맨 앞으로 끌어올린다(중복 없음). 저장 상한을 넘으면 오래된
// 것부터 버린다.

export interface RecentFileOpen {
	path: string;
	source: "local" | "ssh";
	hostId?: string;
	/** epoch ms — 표시는 상대시간, 정렬은 이 값 */
	at: number;
}

export const RECENT_FILE_OPENS_CAP = 20;

function sameFile(a: RecentFileOpen, b: RecentFileOpen): boolean {
	return (
		a.path === b.path && a.source === b.source && (a.hostId ?? "") === (b.hostId ?? "")
	);
}

export function pushRecentFileOpen(
	entries: readonly RecentFileOpen[],
	next: RecentFileOpen,
): RecentFileOpen[] {
	return [next, ...entries.filter((entry) => !sameFile(entry, next))].slice(
		0,
		RECENT_FILE_OPENS_CAP,
	);
}

/** 저장분 검증 — 손상·구버전 레코드는 조용히 버린다(fail-open 목록). */
export function normalizeRecentFileOpens(value: unknown): RecentFileOpen[] {
	if (!Array.isArray(value)) return [];
	const entries: RecentFileOpen[] = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as Record<string, unknown>;
		if (typeof entry.path !== "string" || entry.path.length === 0) continue;
		if (entry.source !== "local" && entry.source !== "ssh") continue;
		if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
		entries.push({
			path: entry.path,
			source: entry.source,
			...(typeof entry.hostId === "string" && entry.hostId
				? { hostId: entry.hostId }
				: {}),
			at: entry.at,
		});
	}
	return entries.slice(0, RECENT_FILE_OPENS_CAP);
}
