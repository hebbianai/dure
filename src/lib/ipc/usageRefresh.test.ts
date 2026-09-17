import { expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

it("sends manual provider refresh through the shared native snapshot owner", async () => {
	const { usageRecent, usageRefresh } = await import("./system");
	const initial = {
		fiveHours: { marker: "old" },
		twentyFourHours: { marker: "old-day" },
	};
	const next = {
		fiveHours: { marker: "new" },
		twentyFourHours: { marker: "new-day" },
	};
	invokeMock.mockResolvedValueOnce(initial).mockResolvedValue(next);
	await expect(usageRecent(5)).resolves.toEqual(initial.fiveHours);
	await expect(usageRefresh("codex")).resolves.toEqual(next);
	expect(invokeMock).toHaveBeenLastCalledWith("usage_recent_snapshot", {
		refresh: "codex",
	});
	await expect(usageRecent(24)).resolves.toEqual(next.twentyFourHours);
	expect(invokeMock).toHaveBeenCalledTimes(2);
	await usageRefresh("claude");
	expect(invokeMock).toHaveBeenLastCalledWith("usage_recent_snapshot", {
		refresh: "claude",
	});
});
