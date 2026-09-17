// 경로 문자열 유틸 — basename 7중·정규화 4중 복제를 통합(2026-08-03 구조
// 위생 감사). lib가 components를 import할 수 없어 spaceBasename(useSpaces)을
// 재사용 못 한 채 사본이 증식하던 패턴을 끊는다.
//
// scm/worktreePlan.ts의 normalizePath(`..`/`.` 세그먼트 해석)는 다른 의미론
// — 여기로 통합 금지.

/** 경로의 마지막 세그먼트(빈 세그먼트·trailing slash 무시). 세그먼트가 없으면
 *  fallback(기본: 원본 경로). */
export function pathBasename(path: string, fallback: string = path): string {
	return path.split("/").filter(Boolean).pop() ?? fallback;
}

/** The folder above the last segment ("" when there is none) — the muted
 *  hint beside a file or folder name in Spaces rows and menus. */
export function pathParentName(path: string): string {
	return path.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";
}

/** 백슬래시를 슬래시로 통일하고 trailing slash를 제거한다. 루트는 "/"로. */
export function normalizeSlashPath(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized || "/";
}

/** trim + trailing slash 제거("/" 특례 유지) — cwd 소유 판정 계열의 계약. */
export function trimTrailingSlash(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "/") return trimmed;
	return trimmed.replace(/\/+$/u, "");
}
