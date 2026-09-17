import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { setLang } from "@/lib/i18n";
import {
	checkForAppUpdates,
	APP_UPDATE_SOURCE_REF,
} from "@/lib/platform/updater";
import {
	dismissUpdateNotice,
	performUpdateNoticeAction,
	resetUpdateNotices,
	subscribeUpdateNotices,
	updateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

const mocks = vi.hoisted(() => ({
	check: vi.fn(),
	relaunch: vi.fn(),
	prepare: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@/lib/workspace/window/appRestart", () => ({
	withPreparedAppRestart: mocks.prepare,
}));

beforeEach(() => {
	setLang("en");
	mocks.check.mockReset();
	mocks.prepare
		.mockReset()
		.mockImplementation(
			async (commit: (verify: () => Promise<void>) => Promise<void>) =>
				commit(async () => {}),
		);
	mocks.relaunch.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
	resetUpdateNotices();
	vi.clearAllMocks();
	setLang("ko");
});

function resource() {
	const update = {
		currentVersion: "0.2.4",
		version: "0.2.5",
		download: vi
			.fn<(event?: (event: DownloadEvent) => void) => Promise<void>>()
			.mockResolvedValue(undefined),
		install: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	};
	mocks.check.mockResolvedValue(update);
	return update;
}

describe("user-owned update stages", () => {
	it("coalesces chunk progress without inventing bytes or a timer", async () => {
		const update = resource();
		update.download.mockImplementationOnce(async (event) => {
			event?.({ event: "Started", data: { contentLength: 1000 } });
			for (let index = 0; index < 1000; index++)
				event?.({ event: "Progress", data: { chunkLength: 1 } });
			expect(updateNoticeSnapshot().notices[0].progress).toEqual({
				label: "1000B of 1000B downloaded",
				percent: 100,
			});
		});
		await checkForAppUpdates();
		const changed = vi.fn();
		const stop = subscribeUpdateNotices(changed);
		try {
			await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
			expect(changed.mock.calls.length).toBeLessThan(110);
		} finally {
			stop();
		}
	});
	it("downloads only on request and waits for a separate install/restart choice", async () => {
		const update = {
			currentVersion: "0.2.4",
			version: "0.2.5",
			download: vi.fn().mockResolvedValue(undefined),
			install: vi.fn().mockResolvedValue(undefined),
			downloadAndInstall: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		};
		mocks.check.mockResolvedValue(update);
		await checkForAppUpdates();
		expect(update.download).not.toHaveBeenCalled();
		expect(update.install).not.toHaveBeenCalled();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(update.download).toHaveBeenCalledOnce();
		expect(update.install).not.toHaveBeenCalled();
		expect(update.downloadAndInstall).not.toHaveBeenCalled();
		expect(mocks.relaunch).not.toHaveBeenCalled();
		expect(updateNoticeSnapshot().notices[0]?.phase).toBe("ready");
	});

	it("projects actual byte progress, stays indeterminate for missing lengths and waits for signature verification", async () => {
		const update = resource();
		let event!: (event: DownloadEvent) => void;
		let finish!: () => void;
		update.download.mockImplementationOnce((onEvent) => {
			event = onEvent!;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		await checkForAppUpdates();
		const action = performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		try {
			event({ event: "Started", data: {} });
			event({ event: "Progress", data: { chunkLength: 512 } });
			expect(updateNoticeSnapshot().notices[0].progress).toEqual({
				label: "512B downloaded",
			});
			event({ event: "Started", data: { contentLength: 1024 } });
			event({ event: "Progress", data: { chunkLength: 512 } });
			expect(updateNoticeSnapshot().notices[0].progress).toEqual({
				label: "512B of 1KB downloaded",
				percent: 50,
			});
			event({ event: "Finished" });
			expect(updateNoticeSnapshot().notices[0]).toMatchObject({
				phase: "running",
				progress: { label: "Verifying download…" },
			});
			expect(update.install).not.toHaveBeenCalled();
		} finally {
			finish();
			await action;
		}
		expect(updateNoticeSnapshot().notices[0]).toMatchObject({
			phase: "ready",
			primaryAction: { label: "Install and restart" },
		});
		expect(updateNoticeSnapshot().notices[0].progress).toBeUndefined();
	});

	it("does not offer installation when the transport finished but signature verification failed", async () => {
		const update = resource();
		update.download.mockImplementationOnce(async (event) => {
			event?.({ event: "Finished" });
			throw new Error("invalid signature");
		});
		await checkForAppUpdates();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(updateNoticeSnapshot().notices[0]).toMatchObject({
			phase: "failed",
			primaryAction: { label: "Download update" },
			error: expect.stringContaining("invalid signature"),
		});
		expect(update.install).not.toHaveBeenCalled();
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it("retains the verified download when the feed changes or the notice is dismissed", async () => {
		const update = resource();
		await checkForAppUpdates();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		dismissUpdateNotice(APP_UPDATE_SOURCE_REF);
		mocks.check.mockResolvedValueOnce(null);
		expect(await checkForAppUpdates()).toBe("available");
		expect(mocks.check).toHaveBeenCalledOnce();
		expect(update.close).not.toHaveBeenCalled();
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});

	it("retries a refused install using the verified bytes without downloading again", async () => {
		const update = resource();
		await checkForAppUpdates();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		update.install.mockRejectedValueOnce(new Error("permission denied"));
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(mocks.relaunch).not.toHaveBeenCalled();
		expect(updateNoticeSnapshot().notices[0]).toMatchObject({
			phase: "failed",
			error: expect.stringContaining("permission denied"),
		});
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(update.download).toHaveBeenCalledOnce();
		expect(update.install).toHaveBeenCalledTimes(2);
		expect(mocks.relaunch).toHaveBeenCalledOnce();
	});

	it("preserves downloaded bytes when preparation fails, then installs once after successful preparation", async () => {
		const update = resource();
		await checkForAppUpdates();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		mocks.prepare.mockRejectedValueOnce(
			new Error("secondary window disk full"),
		);
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(update.install).not.toHaveBeenCalled();
		expect(mocks.relaunch).not.toHaveBeenCalled();
		expect(updateNoticeSnapshot().notices[0]).toMatchObject({
			phase: "failed",
			primaryAction: { label: "Install and restart" },
		});
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(update.download).toHaveBeenCalledOnce();
		expect(update.install).toHaveBeenCalledOnce();
		expect(mocks.relaunch).toHaveBeenCalledOnce();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(mocks.relaunch).toHaveBeenCalledOnce();
	});

	it("retries restart without reinstalling after installation succeeded but relaunch failed", async () => {
		const update = resource();
		await checkForAppUpdates();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		mocks.relaunch.mockRejectedValueOnce(new Error("restart refused"));
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(updateNoticeSnapshot().notices[0]).toMatchObject({
			phase: "failed",
			primaryAction: { label: "Restart Dure" },
		});
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(update.download).toHaveBeenCalledOnce();
		expect(update.install).toHaveBeenCalledOnce();
		expect(mocks.relaunch).toHaveBeenCalledTimes(2);
	});

	it("does not reinstall when final window verification refuses the restart", async () => {
		const update = resource();
		await checkForAppUpdates();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		mocks.prepare.mockImplementationOnce(async (commit) =>
			commit(async () => {
				throw new Error("window changed");
			}),
		);
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(update.install).toHaveBeenCalledOnce();
		expect(mocks.relaunch).not.toHaveBeenCalled();
		await performUpdateNoticeAction(APP_UPDATE_SOURCE_REF);
		expect(update.install).toHaveBeenCalledOnce();
		expect(mocks.relaunch).toHaveBeenCalledOnce();
	});
});
