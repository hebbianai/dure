import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n";
import { formatRelativeAge } from "@/lib/ui/relativeAge";

const NOW = new Date("2026-09-14T12:00:00Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeAge", () => {
	beforeEach(() => setLang("en"));

	it("climbs one ladder from just now to days", () => {
		expect(formatRelativeAge(NOW, NOW)).toBe("just now");
		expect(formatRelativeAge(NOW - 59_999, NOW)).toBe("just now");
		expect(formatRelativeAge(NOW - MINUTE, NOW)).toBe("1m ago");
		expect(formatRelativeAge(NOW - (HOUR - 1), NOW)).toBe("59m ago");
		expect(formatRelativeAge(NOW - HOUR, NOW)).toBe("1h ago");
		expect(formatRelativeAge(NOW - (DAY - 1), NOW)).toBe("23h ago");
		expect(formatRelativeAge(NOW - DAY, NOW)).toBe("1d ago");
		expect(formatRelativeAge(NOW - (7 * DAY - 1), NOW)).toBe("6d ago");
	});

	it("names the date once a week has passed", () => {
		const weekOld = NOW - 7 * DAY;
		expect(formatRelativeAge(weekOld, NOW)).toBe(
			new Date(weekOld).toLocaleDateString([], {
				month: "numeric",
				day: "numeric",
			}),
		);
	});

	it("reads a future instant as just now instead of a negative age", () => {
		expect(formatRelativeAge(NOW + 5 * MINUTE, NOW)).toBe("just now");
	});

	it("speaks the active language", () => {
		setLang("ko");
		expect(formatRelativeAge(NOW - 3 * MINUTE, NOW)).toBe("3분 전");
		expect(formatRelativeAge(NOW - 13 * HOUR, NOW)).toBe("13시간 전");
	});
});
