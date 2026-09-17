import { t } from "@/lib/i18n";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** How long ago something happened, in the app's one compact form: "just
 * now", then minutes, hours and days up to a week, then the locale's numeric
 * month and day. A future instant reads as "just now". Callers keep their own
 * policy for a missing or unparseable timestamp and pass a finite epoch-ms
 * instant. */
export function formatRelativeAge(
	timestampMs: number,
	nowMs: number = Date.now(),
): string {
	const elapsed = Math.max(0, nowMs - timestampMs);
	if (elapsed < MINUTE_MS) return t("common.time.justNow");
	if (elapsed < HOUR_MS)
		return t("common.time.minutesAgo", { n: Math.floor(elapsed / MINUTE_MS) });
	if (elapsed < DAY_MS)
		return t("common.time.hoursAgo", { n: Math.floor(elapsed / HOUR_MS) });
	if (elapsed < WEEK_MS)
		return t("common.time.daysAgo", { n: Math.floor(elapsed / DAY_MS) });
	return new Date(timestampMs).toLocaleDateString([], {
		month: "numeric",
		day: "numeric",
	});
}
