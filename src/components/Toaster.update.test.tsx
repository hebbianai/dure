// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/Toaster";
import { setLang } from "@/lib/i18n";
import { registerOpenModal } from "@/lib/ui/modalPresence";
import { startUpdateChecks } from "@/lib/platform/updater";
import { resetUpdateNotices, upsertUpdateNotice, updateNoticeSnapshot, performUpdateNoticeAction } from "@/lib/updates/updateNotice";

const mocks = vi.hoisted(() => ({
	ask: vi.fn(),
	check: vi.fn(),
	download: vi.fn(),
	message: vi.fn(),
	relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	ask: mocks.ask,
	message: mocks.message,
}));

describe("app update notices", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setLang("en");
		mocks.ask.mockReset().mockResolvedValue(false);
		mocks.check.mockReset().mockResolvedValue({
			currentVersion: "1.4.181",
			version: "1.4.182",
			body: "A quieter update flow.",
			download: mocks.download,
			install: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		});
		mocks.download.mockReset().mockResolvedValue(undefined);
		mocks.message.mockReset().mockResolvedValue(undefined);
		mocks.relaunch.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		resetUpdateNotices();
		setLang("ko");
		vi.useRealTimers();
	});

	it("shows a new app offer without dismissing earlier tooling maintenance", async () => {
		upsertUpdateNotice({
			sourceRef: "tooling.fixture",
			revision: "1",
			title: "Tooling maintenance",
			description: "Review tooling",
			impact: "No restart",
			primaryAction: { label: "Open Settings", progressLabel: "Opening", completion: "retain", run: vi.fn() },
		});
		const stop = startUpdateChecks();
		try {
			render(<Toaster />);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(screen.getByRole("heading", { name: "Update available" })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "Next update" }));
			expect(screen.getByRole("heading", { name: "Tooling maintenance" })).toBeTruthy();
			expect(updateNoticeSnapshot().notices.every((notice) => !notice.dismissed)).toBe(true);
			fireEvent.click(screen.getByRole("button", { name: "Previous update" }));
			expect(screen.getByRole("heading", { name: "Update available" })).toBeTruthy();
		} finally {
			stop();
		}
	});

	it("keeps an already-running maintenance action visible until it finishes", async () => {
		let finish!: () => void;
		upsertUpdateNotice({ sourceRef: "running.tool", revision: "1", title: "Active tool update", description: "Updating tool", impact: "No restart", primaryAction: { label: "Update tool", progressLabel: "Working", completion: "retain", run: () => new Promise<void>((resolve) => { finish = resolve; }) } });
		const action = performUpdateNoticeAction("running.tool");
		const stop = startUpdateChecks();
		try {
			render(<Toaster />);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(screen.getByRole("heading", { name: "Active tool update" })).toBeTruthy();
			expect((screen.getByRole("button", { name: "Next update" }) as HTMLButtonElement).disabled).toBe(true);
			finish();
			await action;
			await vi.advanceTimersByTimeAsync(0);
			expect(screen.getByRole("heading", { name: "Update available" })).toBeTruthy();
		} finally { finish(); await action; stop(); }
	});

	it("projects an available update as a nonblocking actionable card", async () => {
		const stop = startUpdateChecks();
		render(<Toaster />);

		await vi.advanceTimersByTimeAsync(30_000);

		expect(
			screen.getByRole("heading", { name: "Update available" }),
		).toBeTruthy();
		expect(screen.getByText("Dure 1.4.182 is ready.")).toBeTruthy();
		expect(
			screen.getByText(
				"Download while you work. Choose when to install and restart.",
			),
		).toBeTruthy();
		expect(
			screen.getByText("1.4.181 → 1.4.182", { exact: false }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Download update" })).toBeTruthy();
		expect(mocks.ask).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Download update" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.download).toHaveBeenCalledOnce();
		expect(mocks.relaunch).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Install and restart" })).toBeTruthy();

		stop();
	});

	it("holds the card while a modal is up and shows it again after", async () => {
		const stop = startUpdateChecks();
		const { rerender } = render(<Toaster />);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(
			screen.getByRole("heading", { name: "Update available" }),
		).toBeTruthy();

		// A modal claims the window: the card cannot be acted on behind it, and
		// as the brightest thing on screen it takes the eye off the modal.
		const release = registerOpenModal();
		rerender(<Toaster />);
		expect(screen.queryByRole("heading", { name: "Update available" })).toBeNull();

		// Held, not dropped — it is still waiting once the modal leaves.
		release();
		rerender(<Toaster />);
		expect(
			screen.getByRole("heading", { name: "Update available" }),
		).toBeTruthy();

		stop();
	});

	it("counts nested modals so the inner one closing does not unhide the card", async () => {
		const stop = startUpdateChecks();
		const { rerender } = render(<Toaster />);
		await vi.advanceTimersByTimeAsync(30_000);

		const releaseOuter = registerOpenModal();
		const releaseInner = registerOpenModal();
		releaseInner();
		rerender(<Toaster />);
		expect(screen.queryByRole("heading", { name: "Update available" })).toBeNull();

		releaseOuter();
		rerender(<Toaster />);
		expect(
			screen.getByRole("heading", { name: "Update available" }),
		).toBeTruthy();

		stop();
	});
});
