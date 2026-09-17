// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	gitExecLocal: vi.fn(),
	gitStatus: vi.fn(),
	codexTrustWorkspace: vi.fn(),
	inspectLocalDirectory: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	...mocks,
}));

async function boot() {
	vi.resetModules();
	const store = await import("@/store");
	await store.rehydrateAppStoreFromDurableStorage();
	const { handleCliProjectRegistration } = await import(
		"./cliProjectRegistration"
	);
	return {
		store,
		add: (path: string, reqId = "add") =>
			handleCliProjectRegistration({ path }, reqId, {
				isMainWindow: () => true,
				claim: async () => true,
				state: () => store.useStore.getState(),
			}),
	};
}

describe("project registration through the GUI durable owner", () => {
	let run: Awaited<ReturnType<typeof boot>>;
	beforeEach(async () => {
		localStorage.clear();
		mocks.gitExecLocal
			.mockReset()
			.mockResolvedValue({ code: 1, stdout: "", stderr: "not a repository" });
		mocks.gitStatus.mockReset().mockResolvedValue({ isRepo: false });
		mocks.codexTrustWorkspace.mockReset().mockResolvedValue(true);
		mocks.inspectLocalDirectory.mockReset().mockImplementation(async (path: string) => path);
		run = await boot();
	});

	afterEach(async () => {
		try {
			const { durableAppStorage } = await import("@/store");
			await durableAppStorage.flush();
		} finally {
			vi.restoreAllMocks();
			localStorage.clear();
			vi.resetModules();
		}
	});

	it.each(["/plain", "/"])(
		"reuses the saved project on a fresh module/store boot: %s",
		async (path) => {
			const first = run;
			const receipt = await first.add(path);
			expect(receipt?.ok).toBe(true);
			const saved = JSON.parse(
				localStorage.getItem(first.store.DURABLE_APP_STORE_NAME)!,
			);
			expect(saved.state.projects).toEqual([receipt?.registration?.project]);
			await first.store.durableAppStorage.flush();
			const second = await boot();
			expect(
				await second.add(path === "/" ? path : `${path}/`, "after-reload"),
			).toEqual(receipt);
			expect(second.store.useStore.getState().projects).toHaveLength(1);
		},
	);

	it("shares duplicate handling with a simultaneous GUI add even when reads finish in reverse order", async () => {
		const reads: Array<() => void> = [];
		mocks.gitStatus.mockImplementation(
			() =>
				new Promise((resolve) => reads.push(() => resolve({ isRepo: false }))),
		);
		const cli = run.add("/plain", "cli");
		const gui = run.store.useStore.getState().addLocalProject("/plain/");
		await vi.waitFor(() => expect(reads).toHaveLength(2));
		reads[1]();
		reads[0]();
		const [receipt, project] = await Promise.all([cli, gui]);
		expect(receipt?.registration?.project.id).toBe(project.id);
		expect(run.store.useStore.getState().projects).toHaveLength(1);
		const saved = JSON.parse(
			localStorage.getItem(run.store.DURABLE_APP_STORE_NAME)!,
		);
		expect(saved.state.projects).toHaveLength(1);
	});

	it("returns the persisted canonical project when another window has already saved the folder", async () => {
		await run.store.durableAppStorage.reconcile(
			run.store.DURABLE_APP_STORE_NAME,
		);
		const remote = {
			id: "project-from-other-window",
			name: "Chosen name",
			path: "/plain",
			kind: "local",
			isRepo: false,
		};
		const persisted = await import("@/lib/persistence/persistedAppState");
		localStorage.setItem(
			run.store.DURABLE_APP_STORE_NAME,
			JSON.stringify({
				version: run.store.PERSIST_VERSION,
				state: {
					...persisted.persistedSlice(run.store.useStore.getState()),
					projects: [remote],
				},
			}),
		);
		const receipt = await run.add("/plain");
		const saved = JSON.parse(
			localStorage.getItem(run.store.DURABLE_APP_STORE_NAME)!,
		);
		expect(receipt?.ok).toBe(true);
		expect(saved.state.projects).toHaveLength(1);
		expect(receipt?.registration?.project).toEqual(saved.state.projects[0]);
	});
});
