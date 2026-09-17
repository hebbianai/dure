import { t } from "@/lib/i18n";

/** Pretty-prints an opaque provider payload for a disclosure body; a payload
 * that cannot serialize degrades to the localized opaque-value notice instead
 * of throwing mid-render. */
export function opaqueJsonText(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return t("agents.chat.opaqueValue");
	}
}

/** Formats a real worked-duration span for the turn footer: "45s", "2m 05s",
 * "1h 02m". Input is milliseconds from backend timestamps, never invented. */
export function formatWorkedDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
