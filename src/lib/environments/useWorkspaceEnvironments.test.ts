// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceEnvironments } from "./useWorkspaceEnvironments";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc/dureWorkspaceEnvironment", () => ({
	listEnvironments: list,
}));
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.resetAllMocks();
});

it("waits for a slow observation before polling again and stops after completion", async () => {
	vi.useFakeTimers();
	const pending = {
		proAvailable: true,
		environments: [{ id: "fixture", status: "creating" }],
	};
	const running = {
		proAvailable: true,
		environments: [{ id: "fixture", status: "running" }],
	};
	let finish: (value: unknown) => void = () => {};
	list.mockResolvedValueOnce(pending).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const view = renderHook(() => useWorkspaceEnvironments());
	await act(async () => {});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1500);
	});
	expect(list).toHaveBeenCalledTimes(2);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(15000);
	});
	expect(list).toHaveBeenCalledTimes(2);
	await act(async () => {
		finish(running);
	});
	expect(view.result.current.snapshot).toEqual(running);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(15000);
	});
	expect(list).toHaveBeenCalledTimes(2);
});
