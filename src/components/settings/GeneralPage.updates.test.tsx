// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralPage } from "@/components/settings/GeneralPage";
import { Toaster } from "@/components/Toaster";
import { setLang } from "@/lib/i18n";
import { startUpdateChecks } from "@/lib/platform/updater";
import {
	dismissUpdateNotice,
	resetUpdateNotices,
	upsertUpdateNotice,
} from "@/lib/updates/updateNotice";

const mocks = vi.hoisted(() => ({
	check: vi.fn(),
	download: vi.fn(),
	relaunch: vi.fn(),
	backendCapabilities: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@/lib/ipc/core", async (original) => ({
	...(await original<typeof import("@/lib/ipc/core")>()),
	backendCapabilities: mocks.backendCapabilities,
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("General app updates", () => {
	beforeEach(() => {
		setLang("en");
		mocks.check.mockReset().mockResolvedValue(null);
		mocks.download.mockReset().mockResolvedValue(undefined);
		mocks.relaunch.mockReset().mockResolvedValue(undefined);
		mocks.backendCapabilities
			.mockReset()
			.mockResolvedValue({ packageVersion: "91.2.3" });
	});
	afterEach(() => {
		cleanup();
		resetUpdateNotices();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		setLang("ko");
	});

	it("shows the running app version in Basic-only and confirms current only after a manual check", async () => {
		vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "basic-only");
		const pending = deferred<null>();
		mocks.check.mockReturnValue(pending.promise);
		await act(async () => {
			render(<GeneralPage />);
		});
		const button = screen.getByRole("button", { name: "Check for updates" });
		expect(screen.getByText("91.2.3")).toBeTruthy();
		expect(screen.queryByText("Dure is up to date.")).toBeNull();
		expect(mocks.check).not.toHaveBeenCalled();
		await act(async () => {
			fireEvent.click(button);
		});
		expect(
			(
				screen.getByRole("button", {
					name: "Checking for updates…",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(screen.queryByText("Dure is up to date.")).toBeNull();
		await act(async () => {
			pending.resolve(null);
		});
		expect(screen.getByRole("status").textContent).toBe("Dure is up to date.");
		expect(mocks.check).toHaveBeenCalledOnce();
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});

	it("keeps a failed check local and retries without claiming the 404 feed is current", async () => {
		mocks.check.mockRejectedValueOnce(new Error("HTTP 404 latest.json"));
		await act(async () => {
			render(<GeneralPage />);
		});
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: "Check for updates" }),
			);
		});
		expect(screen.getByRole("alert").textContent).toBe(
			"Could not check for updates. Try again.",
		);
		expect(screen.queryByText("Dure is up to date.")).toBeNull();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("Dure is up to date.");
		expect(mocks.check).toHaveBeenCalledTimes(2);
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});

	it("leaves an unavailable running version unknown instead of using the frontend version", async () => {
		mocks.backendCapabilities.mockResolvedValue(null);
		await act(async () => {
			render(<GeneralPage />);
		});
		expect(screen.getByText("Version unavailable")).toBeTruthy();
		expect(mocks.check).not.toHaveBeenCalled();
	});

	it("keeps the app action in General behind an earlier tooling card, including a dismissed app notice", async () => {
		const toolingAction = vi.fn();
		upsertUpdateNotice({
			sourceRef: "tooling",
			revision: "1",
			title: "Tooling update",
			description: "Tooling ready",
			impact: "Tooling impact",
			primaryAction: {
				label: "Update tooling",
				progressLabel: "Updating tooling",
				completion: "retain",
				run: toolingAction,
			},
		});
		mocks.check.mockResolvedValue({
			currentVersion: "91.2.3",
			version: "91.2.4",
			body: "Release notes",
			download: mocks.download,
			install: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		});
		let page!: ReturnType<typeof render>;
		await act(async () => {
			page = render(<GeneralPage />);
			render(<Toaster />);
		});
		await act(async () => {
			fireEvent.click(
				within(page.container).getByRole("button", {
					name: "Check for updates",
				}),
			);
		});
		expect(screen.getAllByRole("heading", { name: "Update available" })).toHaveLength(2);
		expect(
			within(page.container).getByText("Dure 91.2.4 is ready."),
		).toBeTruthy();
		expect(
			within(page.container).queryByRole("button", { name: "Close" }),
		).toBeNull();
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.relaunch).not.toHaveBeenCalled();
		act(() => {
			dismissUpdateNotice("dure.app");
		});
		expect(screen.getByRole("heading", { name: "Tooling update" })).toBeTruthy();
		await act(async () => {
			fireEvent.click(
				within(page.container).getByRole("button", {
					name: "Check for updates",
				}),
			);
		});
		await act(async () => {
			fireEvent.click(
				within(page.container).getByRole("button", { name: "Download update" }),
			);
		});
		expect(mocks.download).toHaveBeenCalledOnce();
		expect(mocks.relaunch).not.toHaveBeenCalled();
		expect(within(page.container).getByRole("button", { name: "Install and restart" })).toBeTruthy();
		expect(toolingAction).not.toHaveBeenCalled();
	});

	it("coalesces a manual request with the existing automatic check and keeps its result after remount", async () => {
		vi.useFakeTimers();
		const pending = deferred<null>();
		mocks.check.mockReturnValue(pending.promise);
		const stop = startUpdateChecks();
		try {
			let page!: ReturnType<typeof render>;
			await act(async () => {
				page = render(<GeneralPage />);
			});
			await act(async () => {
				fireEvent.click(
					screen.getByRole("button", { name: "Check for updates" }),
				);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(30_000);
			});
			expect(mocks.check).toHaveBeenCalledOnce();
			page.unmount();
			await act(async () => {
				pending.resolve(null);
			});
			await act(async () => {
				render(<GeneralPage />);
			});
			expect(screen.getByRole("status").textContent).toBe(
				"Dure is up to date.",
			);
			expect(mocks.check).toHaveBeenCalledOnce();
		} finally {
			stop();
		}
	});
});
