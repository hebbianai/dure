import { beforeEach, describe, expect, it } from "vitest";
import { t } from "./i18n";
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
		]) {
			expect(t(id)).not.toBe(id);
		}
		},
	);
});
