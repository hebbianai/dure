import { expect, it } from "vitest";
import { t } from "@/lib/i18n";
import {
	idleObservationReason,
	idleObservationState,
	observedIdleDuration,
} from "./agentIdleDiagnostics";

it("keeps unknown idle duration distinct from observed zero", () => {
	expect(observedIdleDuration(null)).toBe(t("common.unknown"));
	expect(observedIdleDuration(0)).toBe(t("usage.cleanup.seconds", { n: 0 }));
	expect(observedIdleDuration(86_400_000)).toBe(
		`${t("usage.duration.days", { n: 1 })} ${t("usage.duration.hours", { n: 0 })}`,
	);
});
it("does not promote a request or unknown state to completed hibernation", () => {
	expect(idleObservationState("hibernate_requested")).toBe(
		t("usage.cleanup.requested"),
	);
	expect(idleObservationState("new_state")).toBe(t("common.unknown"));
	expect(idleObservationReason("new_reason")).toBe(
		t("usage.cleanup.otherReason"),
	);
});
