import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import type { CodexPolledRateLimit, CodexUsageSnapshot } from "@/lib/ipc";
import { codexCreditsLabel, codexResetCreditsLabel } from "./usageLabels";

function snapshot(
	credits: CodexPolledRateLimit["credits"],
): CodexUsageSnapshot {
	return {
		credentialId: "a",
		capturedAt: 100,
		attemptedAt: 100,
		error: null,
		rateLimits: [
			{
				limitId: "codex",
				limitName: null,
				usedPercent: null,
				usedPercentWeekly: null,
				resetsAt: null,
				weeklyResetsAt: null,
				credits,
			},
		],
	};
}

describe("Codex credit labels", () => {
	it("keeps reset counts separate, including zero, unknown and stale readings", () => {
		const value = {
			...snapshot({ hasCredits: false, unlimited: false, balance: "0" }),
			rateLimitResetsAvailable: 3,
		};
		expect(codexResetCreditsLabel(value, 110)).toBe(
			t("usage.resetCredits.available", { count: "3" }),
		);
		const zero = { ...value, rateLimitResetsAvailable: 0 };
		expect(codexResetCreditsLabel(zero, 110)).toBe(
			t("usage.resetCredits.available", { count: "0" }),
		);
		for (const count of [undefined, null, -1, 1.5, Number.NaN, Infinity]) {
			expect(
				codexResetCreditsLabel(
					{ ...value, rateLimitResetsAvailable: count },
					110,
				),
			).toBe(t("usage.resetCredits.unavailable"));
		}
		expect(codexResetCreditsLabel({ ...value, capturedAt: null }, 110)).toBe(
			t("usage.resetCredits.unavailable"),
		);
		for (const stale of [value, { ...value, error: "failed" }]) {
			expect(codexResetCreditsLabel(stale, stale.error ? 110 : 2000)).toBe(
				t("usage.credits.lastKnown", {
					credits: t("usage.resetCredits.available", { count: "3" }),
				}),
			);
		}
	});
	it("retains zero and fractional balances without inferring a count from hasCredits", () => {
		for (const balance of ["0", "1250.5", "0.001"]) {
			expect(
				codexCreditsLabel(
					snapshot({ hasCredits: true, unlimited: false, balance }),
					110,
				),
			).toBe(
				t("usage.credits.remaining", {
					balance: Number(balance).toLocaleString(undefined, {
						maximumFractionDigits: 20,
					}),
				}),
			);
		}
		for (const balance of [
			null,
			"",
			" ",
			"NaN",
			"Infinity",
			"-1",
			"not a number",
		]) {
			expect(
				codexCreditsLabel(
					snapshot({ hasCredits: true, unlimited: false, balance }),
					110,
				),
			).toBe(t("usage.credits.unavailable"));
		}
	});
	it("distinguishes unlimited from an absent or model-scoped balance", () => {
		expect(
			codexCreditsLabel(
				snapshot({ hasCredits: true, unlimited: true, balance: null }),
				110,
			),
		).toBe(t("usage.credits.unlimited"));
		for (const value of [
			undefined,
			snapshot(null),
			snapshot(undefined),
			{ ...snapshot(null), capturedAt: null },
		]) {
			expect(codexCreditsLabel(value, 110)).toBe(
				t("usage.credits.unavailable"),
			);
		}
		const model = snapshot({
			hasCredits: true,
			unlimited: false,
			balance: "999",
		});
		model.rateLimits[0].limitId = "model-only";
		expect(codexCreditsLabel(model, 110)).toBe(t("usage.credits.unavailable"));
	});
	it("identifies failed or old observations as last known instead of current balances", () => {
		const value = snapshot({
			hasCredits: true,
			unlimited: false,
			balance: "12",
		});
		const label = t("usage.credits.remaining", { balance: "12" });
		expect(codexCreditsLabel(value, 2000)).toBe(
			t("usage.credits.lastKnown", { credits: label }),
		);
		expect(
			codexCreditsLabel({ ...value, attemptedAt: 110, error: "failed" }, 110),
		).toBe(t("usage.credits.lastKnown", { credits: label }));
	});
});
