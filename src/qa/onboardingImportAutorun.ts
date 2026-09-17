// qa.ts와의 순환을 피해 구조적 타입 사용 (onboardingImportProbe와 같은 관례)
type QaLogger = (...args: unknown[]) => void;

export async function runOnboardingImportAutorun(
	flag: string,
	log: QaLogger,
): Promise<boolean> {
	if (flag.includes("onboardingimport")) {
		const { runOnboardingImportProbe, seedOnboardingSshHostFromQaFlag } =
			await import("@/qa/onboardingImportProbe");
		if (await seedOnboardingSshHostFromQaFlag(flag)) {
			window.location.reload();
			return true;
		}
		await runOnboardingImportProbe(log, flag);
	}
	if (flag.includes("onboardingcleanup")) {
		const { runOnboardingImportCleanup } = await import(
			"@/qa/onboardingImportProbe"
		);
		await runOnboardingImportCleanup(log);
	}
	return false;
}
