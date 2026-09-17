import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APP_UPDATE_SOURCE_REF,
	appUpdateCheckSnapshot,
	checkForAppUpdates,
	startUpdateChecks,
	subscribeAppUpdateChecks,
} from "@/lib/platform/updater";
import {
	performUpdateNoticeAction,
	resetUpdateNotices,
	updateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

const mocks = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	resetUpdateNotices();
	vi.clearAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("shared app update checks", () => {
	it.each([null, "1.0.2"])("retires the old action before closing its resource for %s", async (version) => {
		const closing = deferred<void>();
		const previous = { currentVersion: "1.0.0", version: "1.0.1", download: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockReturnValue(closing.promise) };
		mocks.check.mockResolvedValueOnce(previous);
		await checkForAppUpdates();
		const next = version ? { currentVersion: "1.0.0", version, download: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) } : null;
		mocks.check.mockResolvedValueOnce(next);
		const pending = checkForAppUpdates();
		try {
			await vi.waitFor(() => expect(previous.close).toHaveBeenCalledOnce());
			await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
			expect(previous.download).not.toHaveBeenCalled();
			if (next) {
				expect(next.download).toHaveBeenCalledOnce();
				expect(updateNoticeSnapshot().notices[0].revision).toBe(JSON.stringify(["1.0.0", version]));
			} else expect(updateNoticeSnapshot().notices).toHaveLength(0);
		} finally {
			closing.resolve();
			await pending;
		}
	});

	it("keeps the action-owned status when an older check fails late", async () => {
		mocks.check.mockResolvedValue({ currentVersion: "1.0.0", version: "1.0.1", download: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) });
		await checkForAppUpdates();
		let reject!: (error: Error) => void;
		mocks.check.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
		const pending = checkForAppUpdates();
		await Promise.resolve();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		reject(new Error("late network error"));
		expect(await pending).toBe("available");
		expect(appUpdateCheckSnapshot()).toBe("available");
		expect(updateNoticeSnapshot().notices[0].phase).toBe("ready");
	});
	it("never queries or schedules stable updates for a worktree release build", async () => {
		vi.stubEnv(
			"VITE_DURE_WORKTREE_RELEASE_PROFILE",
			JSON.stringify({
				sourceChannel: "dev-task-0123456789",
				targetChannel: "release-task-0123456789",
				identifier: "io.hebbian.ade.release.0123456789",
				dataStoreIdentifier: Array(16).fill(42),
			}),
		);
		vi.useFakeTimers();
		const stop = startUpdateChecks();
		expect(await checkForAppUpdates()).toBe("unsupported");
		expect(appUpdateCheckSnapshot()).toBe("unsupported");
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(mocks.check).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		stop();
	});
	it.each([null, "1.0.2"])(
		"preserves a failed action when a superseded check returns %s",
		async (nextVersion) => {
			const download = vi
				.fn()
				.mockRejectedValue(new Error("install failed"));
			mocks.check.mockResolvedValue({
				currentVersion: "1.0.0",
				version: "1.0.1",
				download,
				close: vi.fn().mockResolvedValue(undefined),
			});
			await checkForAppUpdates();
			const pending = deferred<unknown>();
			const close = vi.fn().mockResolvedValue(undefined);
			mocks.check.mockReturnValue(pending.promise);
			const request = checkForAppUpdates();
			await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
			pending.resolve(
				nextVersion === null
					? null
					: {
							currentVersion: "1.0.0",
							version: nextVersion,
							download,
							close,
						},
			);
			expect(await request).toBe("available");
			expect(appUpdateCheckSnapshot()).toBe("available");
			expect(updateNoticeSnapshot().notices[0]).toMatchObject({
				revision: JSON.stringify(["1.0.0", "1.0.1"]),
				phase: "failed",
				error: expect.stringContaining("install failed"),
			});
			expect(close).toHaveBeenCalledTimes(nextVersion === null ? 0 : 1);
		},
	);

	it.each([null, "1.0.2"])(
		"preserves a running action when a pending check returns %s",
		async (nextVersion) => {
			const installation = deferred<void>();
			const download = vi.fn().mockReturnValue(installation.promise);
			mocks.relaunch.mockResolvedValue(undefined);
			mocks.check.mockResolvedValue({
				currentVersion: "1.0.0",
				version: "1.0.1",
				download,
				close: vi.fn().mockResolvedValue(undefined),
			});
			await checkForAppUpdates();
			const pending = deferred<unknown>();
			const close = vi.fn().mockResolvedValue(undefined);
			mocks.check.mockReturnValue(pending.promise);
			const request = checkForAppUpdates();
			const action = performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
			pending.resolve(
				nextVersion === null
					? null
					: {
							currentVersion: "1.0.0",
							version: nextVersion,
							download,
							close,
						},
			);
			try {
				expect(await request).toBe("available");
				expect(updateNoticeSnapshot().notices[0]).toMatchObject({
					revision: JSON.stringify(["1.0.0", "1.0.1"]),
					phase: "running",
				});
				await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
				expect(download).toHaveBeenCalledOnce();
				expect(close).toHaveBeenCalledTimes(nextVersion === null ? 0 : 1);
			} finally {
				installation.resolve();
				await action;
			}
		},
	);

	it("registers one request before notifying subscribers and shares it with automatic checks", async () => {
		vi.useFakeTimers();
		const pending = deferred<null>();
		mocks.check.mockReturnValue(pending.promise);
		let reentrant: ReturnType<typeof checkForAppUpdates> | undefined;
		const unsubscribe = subscribeAppUpdateChecks(() => {
			if (appUpdateCheckSnapshot() === "checking")
				reentrant = checkForAppUpdates();
		});
		const stop = startUpdateChecks();
		try {
			const request = checkForAppUpdates();
			expect(reentrant).toBe(request);
			expect(checkForAppUpdates()).toBe(request);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(mocks.check).toHaveBeenCalledOnce();
			stop();
			pending.resolve(null);
			expect(await request).toBe("current");
			expect(appUpdateCheckSnapshot()).toBe("current");
			await vi.advanceTimersByTimeAsync(3_600_000);
			expect(mocks.check).toHaveBeenCalledOnce();
		} finally {
			stop();
			unsubscribe();
		}
	});

	it("keeps downloading in the notice action, suppresses checks during it, and recovers from failure", async () => {
		const installation = deferred<void>();
		const download = vi.fn(async () => { await installation.promise; throw new Error("download failed"); });
		mocks.check.mockResolvedValue({
			currentVersion: "1.0.0",
			version: "1.0.1",
			download,
			close: vi.fn().mockResolvedValue(undefined),
		});
		expect(await checkForAppUpdates()).toBe("available");
		expect(download).not.toHaveBeenCalled();
		expect(mocks.relaunch).not.toHaveBeenCalled();

		const action = performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(download).toHaveBeenCalledOnce();
		expect(await checkForAppUpdates()).toBe("available");
		expect(mocks.check).toHaveBeenCalledOnce();
		installation.resolve();
		await action;
		expect(updateNoticeSnapshot().notices[0]).toMatchObject({
			phase: "failed",
			error: expect.stringContaining("download failed"),
		});

		mocks.check.mockRejectedValueOnce(new Error("HTTP 404"));
		expect(await checkForAppUpdates()).toBe("error");
		expect(appUpdateCheckSnapshot()).toBe("error");
		expect(updateNoticeSnapshot().notices[0]?.sourceRef).toBe(
			APP_UPDATE_SOURCE_REF,
		);
		mocks.check.mockResolvedValueOnce(null);
		expect(await checkForAppUpdates()).toBe("current");
		expect(updateNoticeSnapshot().notices).toEqual([]);
	});
});
