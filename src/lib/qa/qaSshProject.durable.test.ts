// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	remoteProjectDirectory: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	remoteProjectDirectory: mocks.remoteProjectDirectory,
}));

const fixture = {
	name: "receipt-loss",
	host: "remote.internal",
	user: "dure",
	port: 22,
	keyPath: "/tmp/id_ed25519",
	expectedWorkspacePath: "/tmp/project",
};

async function bootFromDurableStorage() {
	vi.resetModules();
	const store = await import("@/store");
	await store.rehydrateAppStoreFromDurableStorage();
	const { ensureQaSshProject } = await import("@/lib/qa/qaSshProject");
	return { ensureQaSshProject, store };
}

describe("QA SSH project durable bootstrap", () => {
	beforeEach(() => {
		localStorage.clear();
		mocks.remoteProjectDirectory.mockReset().mockResolvedValue({
			path: fixture.expectedWorkspacePath,
			isRepo: true,
			origin: "git@github.com:dure/receipt-loss.git",
		});
	});

	afterEach(async () => {
		try {
			const { durableAppStorage } = await import("@/store");
			await durableAppStorage.flush();
		} finally {
			localStorage.clear();
			vi.resetModules();
		}
	});

	it("rehydrates and reuses the exact Host and project on the second autorun", async () => {
		const firstBoot = await bootFromDurableStorage();
		const first = await firstBoot.ensureQaSshProject(fixture);
		await firstBoot.store.durableAppStorage.flush();
		expect(mocks.remoteProjectDirectory).toHaveBeenCalled();
		mocks.remoteProjectDirectory.mockClear();

		const secondBoot = await bootFromDurableStorage();
		expect(secondBoot.store.useStore.getState().sshHosts).toHaveLength(1);
		expect(secondBoot.store.useStore.getState().projects).toHaveLength(1);

		const second = await secondBoot.ensureQaSshProject(fixture);

		expect(second).toEqual(first);
		expect(secondBoot.store.useStore.getState().sshHosts).toHaveLength(1);
		expect(secondBoot.store.useStore.getState().projects).toHaveLength(1);
		expect(mocks.remoteProjectDirectory).not.toHaveBeenCalled();
	});
});
