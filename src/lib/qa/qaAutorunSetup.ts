type QaLogger = (...args: unknown[]) => void;

/** Run the asynchronous fixture setup shared by native QA autoruns. Keeping
 * these branches here leaves qa.ts as probe wiring instead of another fixture
 * owner. */
export async function prepareQaAutorun(
	flag: string,
	log: QaLogger,
): Promise<"ready" | "reloading"> {
	const { runOnboardingImportAutorun } = await import(
		"@/qa/onboardingImportAutorun"
	);
	if (await runOnboardingImportAutorun(flag, log)) return "reloading";

	if (/^localproject=/mu.test(flag)) {
		const { runQaLocalProjectFlag } = await import("@/lib/qa/qaLocalProject");
		await runQaLocalProjectFlag(flag, log);
	}
	if (/(?:^|\s)sshproject=/u.test(flag)) {
		const { runQaSshProjectFlag } = await import("@/lib/qa/qaSshProject");
		await runQaSshProjectFlag(flag, log);
	}
	if (flag.startsWith("hmuxconversion-project=")) {
		const { runHmuxSessionConversionQaFlag } = await import(
			"@/lib/hmux/conversion/hmuxSessionConversionQa"
		);
		await runHmuxSessionConversionQaFlag(flag, log);
	}
	if (flag.startsWith("agentremoval=")) {
		const { runAgentRemovalQa } = await import("@/qa/agentRemoval");
		await runAgentRemovalQa(flag.slice("agentremoval=".length));
	}
	return "ready";
}
