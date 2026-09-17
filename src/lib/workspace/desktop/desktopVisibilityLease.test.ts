// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
	assessDesktopVisibilityLeases,
	DESKTOP_VISIBILITY_LEASE_TTL_MS,
	desktopVisibilityLeaseStorageKey,
	isDesktopWorkspaceWindowLabel,
	parseDesktopVisibilityLease,
	readDesktopVisibilityLease,
	writeDesktopVisibilityLease,
} from "@/lib/workspace/desktop/desktopVisibilityLease";

beforeEach(() => localStorage.clear());

describe("desktop visibility leases", () => {
	it("recognizes only windows that can render a workspace desktop", () => {
		expect(isDesktopWorkspaceWindowLabel("main")).toBe(true);
		expect(isDesktopWorkspaceWindowLabel("win-1722330000000-0")).toBe(true);
		expect(isDesktopWorkspaceWindowLabel("win-popout-desktop-1")).toBe(true);
		expect(isDesktopWorkspaceWindowLabel("win-diff-agent-1")).toBe(false);
		expect(isDesktopWorkspaceWindowLabel("win-source-control")).toBe(false);
	});

	it("fails closed when any live workspace window has no fresh lease", () => {
		const now = 10_000;
		writeDesktopVisibilityLease({
			schemaVersion: 1,
			windowLabel: "main",
			desktopId: "desktop-main",
			visible: true,
			updatedAtMs: now,
		});

		expect(
			assessDesktopVisibilityLeases(["main", "win-1722330000000-0"], now),
		).toEqual({ complete: false, reason: "missing_window_lease" });

		writeDesktopVisibilityLease({
			schemaVersion: 1,
			windowLabel: "win-1722330000000-0",
			desktopId: "desktop-second",
			visible: true,
			updatedAtMs: now - DESKTOP_VISIBILITY_LEASE_TTL_MS - 1,
		});
		expect(
			assessDesktopVisibilityLeases(["main", "win-1722330000000-0"], now),
		).toEqual({ complete: false, reason: "stale_window_lease" });
	});

	it("protects every visible desktop and ignores a minimized window only after a fresh report", () => {
		const now = 20_000;
		for (const lease of [
			{
				schemaVersion: 1 as const,
				windowLabel: "main",
				desktopId: "desktop-main",
				visible: true,
				updatedAtMs: now,
			},
			{
				schemaVersion: 1 as const,
				windowLabel: "win-popout-desktop-2",
				desktopId: "desktop-popout",
				visible: false,
				updatedAtMs: now,
			},
		]) {
			writeDesktopVisibilityLease(lease);
		}

		const assessment = assessDesktopVisibilityLeases(
			["main", "win-popout-desktop-2"],
			now,
		);
		expect(assessment.complete).toBe(true);
		if (assessment.complete) {
			expect([...assessment.visibleDesktopIds]).toEqual(["desktop-main"]);
		}
	});

	it("protects a natively visible window when its publisher still says minimized", () => {
		const now = 30_000;
		writeDesktopVisibilityLease({
			schemaVersion: 1,
			windowLabel: "main",
			desktopId: "desktop-main",
			visible: false,
			updatedAtMs: now,
		});

		const assessment = assessDesktopVisibilityLeases(
			["main"],
			now,
			new Set(["main"]),
		);

		expect(assessment.complete).toBe(true);
		if (assessment.complete) {
			expect([...assessment.visibleDesktopIds]).toEqual(["desktop-main"]);
		}
	});

	it("does not let a stale hidden popout block a fresh visible desktop", () => {
		const now = 40_000;
		writeDesktopVisibilityLease({
			schemaVersion: 1,
			windowLabel: "main",
			desktopId: "desktop-main",
			visible: true,
			updatedAtMs: now,
		});
		writeDesktopVisibilityLease({
			schemaVersion: 1,
			windowLabel: "win-popout-old",
			desktopId: "desktop-old",
			visible: true,
			updatedAtMs: now - DESKTOP_VISIBILITY_LEASE_TTL_MS - 1,
		});

		const assessment = assessDesktopVisibilityLeases(
			["main", "win-popout-old"],
			now,
			new Set(["main"]),
		);

		expect(assessment.complete).toBe(true);
		if (assessment.complete) {
			expect([...assessment.visibleDesktopIds]).toEqual(["desktop-main"]);
		}
	});

	it("validates stored identities instead of trusting corrupted cross-window data", () => {
		localStorage.setItem(
			desktopVisibilityLeaseStorageKey("main"),
			JSON.stringify({
				schemaVersion: 1,
				windowLabel: "other",
				desktopId: "desktop-main",
				visible: true,
				updatedAtMs: 1,
			}),
		);
		expect(readDesktopVisibilityLease("main")).toBeUndefined();
		expect(parseDesktopVisibilityLease("{broken")).toBeUndefined();
	});
});
