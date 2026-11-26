import { beforeEach, describe, expect, it } from "vitest";
import { continuationTimeLabel } from "@/lib/agents/chat/turnFailureReason";
import { continuesText } from "./agentRowText";
import { currentLanguage, t } from "./i18n";
import { DEFAULT_SETTINGS_PREFERENCES, saveSettingsPreferences } from "./settingsPreferences";

describe("mobile message resolution", () => {
	beforeEach(() => localStorage.clear());

	it.each([
		[
			"en",
			"Installation on AWS is unknown. It will be checked when you start.",
			"Start agent",
			"Biometric authentication for approvals",
		],
		[
			"ko",
			"AWS의 설치 여부는 아직 모릅니다. 시작할 때 확인합니다.",
			"에이전트 시작",
			"승인 시 생체 인증",
		],
	] as const)(
		"resolves semantic IDs and legacy messages in %s",
		(language, note, legacy, biometricLabel) => {
		saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language });
		expect(t("launch.provider.checkOnStart", { host: "AWS" })).toBe(note);
		expect(t("에이전트 시작")).toBe(legacy);
		expect(t("settings.security.approvalBiometric")).toBe(biometricLabel);
		for (const id of [
			"launch.worktree.unsupported",
			"launch.worktree.originalFolder",
			"settings.security.approvalBiometric",
			"settings.security.enableApprovalBiometricReason",
			"settings.security.disableApprovalBiometricReason",
			"settings.security.biometricFailed",
			"approval.biometricRequired",
			"approval.biometricCancelled",
			"approval.biometricUnavailable",
			"approval.biometricFailedToSend",
			"home.needsYou.error",
			"home.needsYou.unexpectedExit",
			"home.needsYou.signInExit",
			"home.row.manages",
			"home.row.managedNeedYou",
			"home.row.managedWorking",
			"home.row.continuesAt",
		]) {
			expect(t(id)).not.toBe(id);
		}
		},
	);

	/** The time is formatted in the language of the words around it. */
	it.each([
		["en", "Continues at"],
		["ko", "이어서 진행"],
	] as const)("says when an agent continues in %s", (language, words) => {
		saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language });
		expect(currentLanguage()).toBe(language);
		const atMs = new Date(2026, 10, 27, 15, 10).getTime();
		const text = continuesText(atMs, atMs - 60_000);
		expect(text).toContain(words);
		expect(text).toContain(continuationTimeLabel(atMs, language, atMs - 60_000));
	});

	/** A finished turn is all Dure knows, so a result never reads as "done". */
	it.each([
		["en", "Has a result"],
		["ko", "결과 있음"],
	] as const)("names a finished turn as a result in %s", (language, result) => {
		saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language });
		expect(t("home.finished.title")).toBe(result);
	});
});
