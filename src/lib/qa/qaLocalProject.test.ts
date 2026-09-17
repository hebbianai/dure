import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureProjectForPath: vi.fn(),
	reconcile: vi.fn(),
}));

vi.mock("@/store", () => ({
	useStore: {
		getState: () => ({ ensureProjectForPath: mocks.ensureProjectForPath }),
	},
	durableAppStorage: { reconcile: mocks.reconcile },
	DURABLE_APP_STORE_NAME: "agent-ide",
}));

import {
	ensureQaLocalProject,
	qaLocalProjectPath,
} from "@/lib/qa/qaLocalProject";

describe("QA local project bootstrap", () => {
	beforeEach(() => {
		mocks.ensureProjectForPath.mockReset();
		mocks.reconcile.mockReset();
	});

	it("parses one project flag from a multi-line QA request", () => {
		expect(qaLocalProjectPath("full\nlocalproject=/tmp/example///\nperf")).toBe(
			"/tmp/example",
		);
	});

	it("ignores a flag without a local project", () => {
		expect(qaLocalProjectPath("full\nperf")).toBeUndefined();
	});

	it("reconciles the registered project before reporting readiness", async () => {
		mocks.ensureProjectForPath.mockResolvedValue({
			id: "project-1",
			path: "/tmp/example",
		});

		await expect(ensureQaLocalProject(" /tmp/example/ ")).resolves.toEqual({
			ready: true,
			projectId: "project-1",
			path: "/tmp/example",
		});
		expect(mocks.ensureProjectForPath).toHaveBeenCalledWith("/tmp/example");
		expect(mocks.reconcile).toHaveBeenCalledWith("agent-ide");
	});
});
