// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	scan: vi.fn(),
	reclaim: vi.fn(),
	openSettingsPage: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	scanReclaimableWorktrees: (path: string) => mocks.scan(path),
	reclaimWorktrees: (path: string, instances: unknown[]) =>
		mocks.reclaim(path, instances),
}));
vi.mock("@/lib/settings/settingsBus", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/settings/settingsBus")>()),
	openSettingsPage: (page?: string) => mocks.openSettingsPage(page),
}));

import { LowDiskSpaceNotice } from "@/components/scm/LowDiskSpaceNotice";
import { FinishedWorktreesSection } from "@/components/settings/FinishedWorktreesSection";
import { setLang } from "@/lib/i18n";
import {
	resetWorktreeReclaimStoreForTest,
	scanProjectWorktrees,
	setLowDiskSpace,
} from "@/lib/scm/worktrees/worktreeReclaimStore";
import { useStore } from "@/store";

function instance(name: string) {
	return {
		schemaVersion: 1 as const,
		canonicalPath: `/work/app/.worktrees/${name}`,
		gitCommonDir: "/work/app/.git",
		gitDir: `/work/app/.git/worktrees/${name}`,
		instanceToken: `dwt1_${"a".repeat(31)}${name}`,
	};
}

const MIB = 1024 ** 2;
const SCAN = {
	repositoryPath: "/work/app",
	checkouts: [
		{ instance: instance("1"), branch: "run-1", hold: null, sizeBytes: 300 * MIB },
		{ instance: instance("2"), branch: null, hold: null, sizeBytes: 200 * MIB },
		{ instance: instance("3"), branch: "run-3", hold: "dirty", sizeBytes: null },
		{ instance: instance("4"), branch: "run-4", hold: "locked", sizeBytes: null },
	],
};

beforeEach(() => {
	setLang("en");
	useStore.setState({
		projects: [
			{ id: "app", name: "app", path: "/work/app", kind: "local", isRepo: true },
			{ id: "remote", name: "remote", path: "/srv/app", kind: "ssh", sshHostId: "h", isRepo: true },
		],
	});
});

afterEach(() => {
	cleanup();
	resetWorktreeReclaimStoreForTest();
	mocks.scan.mockReset();
	mocks.reclaim.mockReset();
	mocks.openSettingsPage.mockReset();
	useStore.setState({ projects: [] });
	setLang("ko");
});

describe("FinishedWorktreesSection", () => {
	it("scans local projects and lists what is safe to remove and what is kept, with reasons", async () => {
		mocks.scan.mockResolvedValue(SCAN);
		render(<FinishedWorktreesSection />);
		expect(await screen.findByText("2 worktrees are safe to remove · 500MB")).toBeTruthy();
		expect(mocks.scan.mock.calls).toEqual([["/work/app"]]);
		expect(screen.getByText(".worktrees/1")).toBeTruthy();
		expect(screen.getByText("Detached HEAD")).toBeTruthy();
		expect(screen.getByText("Uncommitted or untracked changes")).toBeTruthy();
		expect(screen.getByText("Locked")).toBeTruthy();
	});

	it("removes them only after the in-place confirmation, then reports what it freed", async () => {
		mocks.scan.mockResolvedValueOnce(SCAN);
		render(<FinishedWorktreesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
		expect(mocks.reclaim).not.toHaveBeenCalled();
		const confirm = screen.getByRole("alertdialog", {
			name: "Remove 2 worktrees and free 500MB? Their branches are kept.",
		});
		mocks.reclaim.mockResolvedValue([
			{ outcome: "removed", freedBytes: 300 * MIB },
			{ outcome: "kept", hold: "in_use" },
		]);
		mocks.scan.mockResolvedValueOnce({
			...SCAN,
			checkouts: SCAN.checkouts.slice(1).map((checkout, index) =>
				index === 0 ? { ...checkout, hold: "in_use", sizeBytes: null } : checkout,
			),
		});
		fireEvent.click(
			Array.from(confirm.querySelectorAll("button")).find(
				(button) => button.textContent === "Remove",
			) as HTMLButtonElement,
		);
		await waitFor(() =>
			expect(screen.getByText("Removed 1 worktree and freed 300MB.")).toBeTruthy(),
		);
		expect(mocks.reclaim).toHaveBeenCalledWith("/work/app", [
			SCAN.checkouts[0].instance,
			SCAN.checkouts[1].instance,
		]);
		expect(
			screen.getByText(
				`Kept ${SCAN.checkouts[1].instance.canonicalPath}: In use by a session or agent`,
			),
		).toBeTruthy();
		expect(screen.getByText("No finished worktrees to remove")).toBeTruthy();
	});

	it("draws nothing without a local Git project", () => {
		useStore.setState({ projects: [] });
		const { container } = render(<FinishedWorktreesSection />);
		expect(container.textContent).toBe("");
		expect(mocks.scan).not.toHaveBeenCalled();
	});
});

describe("LowDiskSpaceNotice", () => {
	it("offers the removable worktrees on a low volume and opens Storage", async () => {
		mocks.scan.mockResolvedValue(SCAN);
		await scanProjectWorktrees("/work/app");
		setLowDiskSpace({ projectPaths: ["/work/app"], freeBytes: 4 * 1024 * MIB });
		render(<LowDiskSpaceNotice />);
		expect(screen.getByText("Low disk space: 4GB left")).toBeTruthy();
		expect(
			screen.getByText(
				"2 finished worktrees take 500MB and are safe to remove. Their branches are kept.",
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Review worktrees" }));
		expect(mocks.openSettingsPage).toHaveBeenCalledWith("storage");
		expect(screen.queryByText("Low disk space: 4GB left")).toBeNull();
	});

	it("stays away while there is nothing safe to remove", async () => {
		mocks.scan.mockResolvedValue({ ...SCAN, checkouts: SCAN.checkouts.slice(2) });
		await scanProjectWorktrees("/work/app");
		setLowDiskSpace({ projectPaths: ["/work/app"], freeBytes: 1024 });
		const { container } = render(<LowDiskSpaceNotice />);
		expect(container.textContent).toBe("");
	});
});
