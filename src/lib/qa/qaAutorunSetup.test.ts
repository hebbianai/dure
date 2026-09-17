import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runRemoval: vi.fn(),
	runConversion: vi.fn(),
	runLocalProject: vi.fn(),
	runOnboarding: vi.fn(),
	runSshProject: vi.fn(),
}));

vi.mock("@/qa/agentRemoval", () => ({ runAgentRemovalQa: mocks.runRemoval }));
vi.mock("@/qa/onboardingImportAutorun", () => ({
	runOnboardingImportAutorun: mocks.runOnboarding,
}));
vi.mock("@/lib/qa/qaLocalProject", () => ({
	runQaLocalProjectFlag: mocks.runLocalProject,
}));
vi.mock("@/lib/qa/qaSshProject", () => ({
	runQaSshProjectFlag: mocks.runSshProject,
}));
vi.mock("@/lib/hmux/conversion/hmuxSessionConversionQa", () => ({
	runHmuxSessionConversionQaFlag: mocks.runConversion,
}));

import { prepareQaAutorun } from "@/lib/qa/qaAutorunSetup";

describe("QA autorun setup", () => {
	beforeEach(() => {
		mocks.runRemoval.mockReset();
		mocks.runConversion.mockReset();
		mocks.runLocalProject.mockReset();
		mocks.runOnboarding.mockReset().mockResolvedValue(false);
		mocks.runSshProject.mockReset();
	});

	it("runs native removal only for its explicit fixture flag", async () => {
		await prepareQaAutorun("", vi.fn());
		expect(mocks.runRemoval).not.toHaveBeenCalled();
		await prepareQaAutorun('agentremoval={"runId":"fixture"}', vi.fn());
		expect(mocks.runRemoval).toHaveBeenCalledExactlyOnceWith(
			'{"runId":"fixture"}',
		);
	});

	it("stops setup when onboarding is reloading the WebView", async () => {
		mocks.runOnboarding.mockResolvedValue(true);

		await expect(
			prepareQaAutorun("localproject=/tmp/example", vi.fn()),
		).resolves.toBe("reloading");
		expect(mocks.runLocalProject).not.toHaveBeenCalled();
	});

	it("composes local-project and conversion fixtures through one setup path", async () => {
		const flag =
			"hmuxconversion-project=/tmp/example\nlocalproject=/tmp/example";
		const log = vi.fn();

		await expect(prepareQaAutorun(flag, log)).resolves.toBe("ready");
		expect(mocks.runLocalProject).toHaveBeenCalledWith(flag, log);
		expect(mocks.runConversion).toHaveBeenCalledWith(flag, log);
	});

	it("registers an SSH project without opting into the onboarding probe", async () => {
		const flag = "sshproject=fixture";
		const log = vi.fn();

		await expect(prepareQaAutorun(flag, log)).resolves.toBe("ready");
		expect(mocks.runSshProject).toHaveBeenCalledWith(flag, log);
	});
});
