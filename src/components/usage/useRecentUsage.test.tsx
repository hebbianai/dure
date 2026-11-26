// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile } from "@/types";

const usageRecentMock = vi.fn();
const collectorStatusMock = vi.fn();
const profilesSyncMock = vi.fn();
const usageRefreshMock = vi.fn();

vi.mock("@/lib/ipc", () => ({
	usageRecent: (hours: number) => usageRecentMock(hours),
	usageRefresh: (provider: string) => usageRefreshMock(provider),
	claudeCollectorStatus: () => collectorStatusMock(),
	accountUsageProfilesSync: (profiles: unknown) => profilesSyncMock(profiles),
}));

import { useRecentUsage } from "@/components/usage/useRecentUsage";

// The hook stores the reports untouched, so identity markers are enough.
const r5 = { marker: "5h" };
const r24 = { marker: "24h" };

afterEach(() => {
	vi.clearAllMocks();
});

describe("useRecentUsage", () => {
	it("requires a synchronized account catalog for either provider's manual check", async () => {
		profilesSyncMock.mockRejectedValue(new Error("catalog unavailable"));
		collectorStatusMock.mockResolvedValue("installed");
		usageRecentMock.mockImplementation((hours: number) =>
			Promise.resolve(hours <= 5 ? r5 : r24),
		);
		usageRefreshMock.mockResolvedValue({ fiveHours: r5, twentyFourHours: r24 });
		const accounts: AccountProfile[] = [];
		const rendered = renderHook(() => useRecentUsage(accounts));
		await waitFor(() => expect(rendered.result.current.u5).toBe(r5));
		for (const provider of ["codex", "claude"] as const) {
			await act(() => rendered.result.current.refresh(provider));
			expect(rendered.result.current.refreshError).toBe(provider);
		}
		expect(usageRefreshMock).not.toHaveBeenCalled();
		profilesSyncMock.mockResolvedValue(undefined);
		for (const provider of ["codex", "claude"] as const) {
			await act(() => rendered.result.current.refresh(provider));
			expect(usageRefreshMock).toHaveBeenLastCalledWith(provider);
			expect(rendered.result.current.refreshError).toBeNull();
		}
	});

	it("does not apply a refresh from a retired account catalog", async () => {
		profilesSyncMock.mockResolvedValue(undefined);
		collectorStatusMock.mockResolvedValue("installed");
		usageRecentMock.mockImplementation((hours: number) =>
			Promise.resolve(hours <= 5 ? r5 : r24),
		);
		let finish!: (value: unknown) => void;
		usageRefreshMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const accounts: AccountProfile[] = [];
		const rendered = renderHook(({ accounts }) => useRecentUsage(accounts), {
			initialProps: { accounts },
		});
		await waitFor(() => expect(rendered.result.current.u5).toBe(r5));
		let pending!: Promise<void>;
		await act(async () => {
			pending = rendered.result.current.refresh("codex");
		});
		expect(rendered.result.current.refreshing).toBe("codex");
		const fresh = { marker: "new catalog" };
		usageRecentMock.mockResolvedValue(fresh);
		rendered.rerender({
			accounts: [
				{ id: "new", provider: "codex", name: "new", dir: "/accounts/new" },
			],
		});
		await waitFor(() => expect(rendered.result.current.u5).toBe(fresh));
		await act(async () => {
			finish({ fiveHours: r5, twentyFourHours: r24 });
			await pending;
		});
		expect(rendered.result.current.u5).toBe(fresh);
		expect(rendered.result.current.refreshing).toBeNull();
	});

	it("계정 사용량 확인 카탈로그 동기화를 먼저 끝낸 뒤 5h/24h 창과 수집기 상태를 채운다", async () => {
		let releaseSync!: () => void;
		profilesSyncMock.mockReturnValue(
			new Promise<void>((resolve) => {
				releaseSync = resolve;
			}),
		);
		usageRecentMock.mockImplementation((hours: number) =>
			Promise.resolve(hours <= 5 ? r5 : r24),
		);
		collectorStatusMock.mockResolvedValue("installed");
		const accounts: AccountProfile[] = [
			{ id: "acc-cx", provider: "codex", name: "work", dir: "/accounts/work" },
			{
				id: "acc-cl",
				provider: "claude",
				name: "fable",
				dir: "/accounts/fable",
			},
		];

		const rendered = renderHook(() => useRecentUsage(accounts));
		expect(profilesSyncMock).toHaveBeenCalledWith([
			{ providerId: "codex", credentialId: null, directory: null },
			{
				providerId: "codex",
				credentialId: "acc-cx",
				directory: "/accounts/work",
			},
			{ providerId: "claude", credentialId: null, directory: null },
			{
				providerId: "claude",
				credentialId: "acc-cl",
				directory: "/accounts/fable",
			},
		]);
		// Reports load only after the catalog sync settles.
		expect(usageRecentMock).not.toHaveBeenCalled();

		releaseSync();
		await waitFor(() => expect(rendered.result.current.u5).toBe(r5));
		expect(rendered.result.current.u24).toBe(r24);
		expect(rendered.result.current.collector).toBe("installed");
	});

	it("카탈로그 동기화가 실패해도 보고서는 그대로 불러온다", async () => {
		profilesSyncMock.mockRejectedValue(new Error("sync down"));
		usageRecentMock.mockImplementation((hours: number) =>
			Promise.resolve(hours <= 5 ? r5 : r24),
		);
		collectorStatusMock.mockRejectedValue(new Error("no collector"));

		const rendered = renderHook(() => useRecentUsage([]));
		await waitFor(() => expect(rendered.result.current.u5).toBe(r5));
		expect(rendered.result.current.u24).toBe(r24);
		expect(rendered.result.current.collector).toBeNull();
	});

	it("usage_recent 실패는 침묵하고 상태를 null로 남긴다", async () => {
		profilesSyncMock.mockResolvedValue(undefined);
		usageRecentMock.mockRejectedValue(new Error("backend missing"));
		collectorStatusMock.mockResolvedValue("not_installed");

		const rendered = renderHook(() => useRecentUsage([]));
		await waitFor(() =>
			expect(rendered.result.current.collector).toBe("not_installed"),
		);
		expect(rendered.result.current.u5).toBeNull();
		expect(rendered.result.current.u24).toBeNull();
	});
});
