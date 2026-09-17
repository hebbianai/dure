import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createHost: vi.fn(),
	ensureProjectForPath: vi.fn(),
	reconcile: vi.fn(),
}));

vi.mock("@/lib/ssh/sshCredentialLifecycle", () => ({
	createSshHostDurably: mocks.createHost,
}));
vi.mock("@/store", () => ({
	useStore: {
		getState: () => ({ ensureProjectForPath: mocks.ensureProjectForPath }),
	},
	durableAppStorage: { reconcile: mocks.reconcile },
	DURABLE_APP_STORE_NAME: "agent-ide",
}));

import { ensureQaSshProject } from "@/lib/qa/qaSshProject";

describe("QA SSH project bootstrap", () => {
	beforeEach(() => {
		mocks.createHost.mockReset();
		mocks.ensureProjectForPath.mockReset();
		mocks.reconcile.mockReset();
	});

	it("reconciles one stable Host and project before reporting readiness", async () => {
		mocks.createHost.mockResolvedValue({
			host: { id: "host-1" },
			created: true,
		});
		mocks.ensureProjectForPath.mockResolvedValue({
			id: "project-1",
			path: "/tmp/project",
		});

		await expect(
			ensureQaSshProject({
				name: "receipt-loss",
				host: "remote.internal",
				user: "dure",
				port: 22,
				keyPath: "/tmp/id_ed25519",
				expectedWorkspacePath: "/tmp/project",
			}),
		).resolves.toEqual({
			ready: true,
			hostId: "host-1",
			projectId: "project-1",
			path: "/tmp/project",
		});
		expect(mocks.createHost).toHaveBeenCalledWith({
			name: "receipt-loss",
			sshConfigAlias: "dure-qa:dure@remote.internal:22",
			host: "remote.internal",
			port: 22,
			user: "dure",
			auth: "key",
			keyPath: "/tmp/id_ed25519",
		});
		expect(mocks.ensureProjectForPath).toHaveBeenCalledWith(
			"/tmp/project",
			"host-1",
		);
		expect(mocks.reconcile).toHaveBeenCalledWith("agent-ide");
	});
});
