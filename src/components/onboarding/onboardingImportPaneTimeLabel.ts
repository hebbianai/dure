import { t } from "@/lib/i18n";
import { onboardingImportPaneTime } from "@/lib/onboarding/onboardingImportPresentation";

/** 순수 시각 분류(lib)에 로케일 문구만 입힌다. */
export function onboardingImportPaneTimeLabel(mtimeSeconds: number): string {
	const time = onboardingImportPaneTime(mtimeSeconds, new Date());
	if (time.kind === "today") return time.clock;
	if (time.kind === "yesterday") {
		return t("onboarding.import.time.yesterday", { clock: time.clock });
	}
	if (time.kind === "days") return t("common.time.daysAgo", { n: time.days });
	return t("onboarding.import.time.monthDay", { month: time.month, day: time.day });
}
