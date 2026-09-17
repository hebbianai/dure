/** pane 카드의 시각 표기 — 문구는 로케일에 맡기고 여기서는 어떤 형태로 읽을지만
 *  정한다(오늘/어제는 시계, 그 뒤로는 경과일, 더 오래되면 날짜). */
export type OnboardingImportPaneTime =
	| { kind: "today"; clock: string }
	| { kind: "yesterday"; clock: string }
	| { kind: "days"; days: number }
	| { kind: "date"; month: number; day: number };

function clockLabel(at: Date): string {
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function startOfDay(at: Date): number {
	return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

export function onboardingImportPaneTime(
	mtimeSeconds: number,
	now: Date,
): OnboardingImportPaneTime {
	const at = new Date(mtimeSeconds * 1000);
	// 달력 기준으로 센다 — 23시간 전이라도 날짜가 넘어갔으면 "어제"다.
	const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
	if (days <= 0) return { kind: "today", clock: clockLabel(at) };
	if (days === 1) return { kind: "yesterday", clock: clockLabel(at) };
	if (days <= 7) return { kind: "days", days };
	return { kind: "date", month: at.getMonth() + 1, day: at.getDate() };
}

export function compactOnboardingImportCwd(cwd: string): string {
	const normalized = cwd.replace(/\/+$/, "") || "/";
	if (normalized === "/") return normalized;
	const segments = normalized.split("/").filter(Boolean);
	if (segments.length <= 3) {
		return `${normalized.startsWith("/") ? "/" : ""}${segments.join("/")}`;
	}
	return `…/${segments.slice(-3).join("/")}`;
}
