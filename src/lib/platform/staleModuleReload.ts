// 스테일 번들의 lazy 청크 로드 실패는 결정적으로 리로드가 답이다 — 배포·재설치
// 뒤 vite 모듈 그래프가 바뀌면 떠 있던 페이지의 dynamic import가 옛 URL로
// 죽는다(2026-08-03 "Importing a module script failed" 제보). 사용자에게
// Refresh를 누르게 하는 대신 1회 자동 리로드하되, 서버가 정말 죽은 경우의
// 리로드 루프는 쿨다운으로 막는다.

import { reloadCurrentPage } from "@/lib/platform/pageReload";

const STALE_MODULE_PATTERNS = [
	// WebKit
	/importing a module script failed/i,
	// Chromium/Firefox 계열 (팝아웃·미래 플랫폼 대비)
	/failed to fetch dynamically imported module/i,
	/error loading dynamically imported module/i,
	/unable to preload css/i,
];

export function isStaleModuleError(message: string): boolean {
	return STALE_MODULE_PATTERNS.some((pattern) => pattern.test(message));
}

export const STALE_RELOAD_COOLDOWN_MS = 60_000;
const STORAGE_KEY = "dure:stale-module-reload-at";

/** Fire-and-forget marker into qa.log. The 2026-08-04 reload storm was
 *  undiagnosable because this module reloaded silently (the unhandled
 *  rejection handler even suppresses the console line) — every reload
 *  decision must leave a trace with the failing module URL. */
function markReload(tag: "reload" | "suppressed", message: string): void {
	try {
		fetch("/__qa_log", {
			method: "POST",
			body: JSON.stringify([
				"[staleModule]",
				tag,
				message.slice(0, 512),
			]),
		}).catch(() => {});
	} catch {
		/* instrumentation must never affect app behavior */
	}
}

/** 쿨다운 안의 재발은 자동 리로드하지 않는다 — 리로드로 안 낫는 오류
 *  (서버 다운·진짜 버그)를 새로고침 루프로 만들지 않는다. */
export function shouldAutoReload(nowMs: number, lastReloadAtMs: number | null): boolean {
	return lastReloadAtMs === null || nowMs - lastReloadAtMs >= STALE_RELOAD_COOLDOWN_MS;
}

/** 스테일 모듈 오류면 1회 자동 리로드를 건다. 리로드를 걸었으면 true. */
export function autoReloadForStaleModule(
	error: { message?: string },
	options?: {
		storage?: Pick<Storage, "getItem" | "setItem">;
		reload?: () => void;
		nowMs?: number;
	},
): boolean {
	if (!isStaleModuleError(error.message ?? "")) return false;
	const storage = options?.storage ?? window.sessionStorage;
	const nowMs = options?.nowMs ?? Date.now();
	let last: number | null = null;
	try {
		const raw = storage.getItem(STORAGE_KEY);
		last = raw === null ? null : Number.parseInt(raw, 10) || null;
	} catch {
		/* storage 접근 불가 — 쿨다운 없이 1회 시도 */
	}
	if (!shouldAutoReload(nowMs, last)) {
		markReload("suppressed", error.message ?? "");
		return false;
	}
	try {
		storage.setItem(STORAGE_KEY, String(nowMs));
	} catch {
		/* noop */
	}
	markReload("reload", error.message ?? "");
	(options?.reload ?? reloadCurrentPage)();
	return true;
}
