// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CopyFeedbackStatus,
	type UseCopyFeedbackOptions,
	useCopyFeedback,
} from "@/components/common/useCopyFeedback";

const clipboardMocks = vi.hoisted(() => ({
	writeText: vi.fn(async (_text: string) => {}),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: clipboardMocks.writeText,
}));

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	clipboardMocks.writeText.mockClear();
});

describe("useCopyFeedback", () => {
	it("reports copied and reverts to idle after the 1.8s default", async () => {
		vi.useFakeTimers();
		const write = vi.fn(async (_text: string) => {});
		const { result } = renderHook(() => useCopyFeedback({ write }));

		expect(result.current.status).toBe("idle");
		let outcome: CopyFeedbackStatus | undefined;
		await act(async () => {
			outcome = await result.current.copy("pairing-code");
		});

		expect(write).toHaveBeenCalledWith("pairing-code");
		expect(outcome).toBe("copied");
		expect(result.current.status).toBe("copied");

		act(() => vi.advanceTimersByTime(1_799));
		expect(result.current.status).toBe("copied");
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.status).toBe("idle");
	});

	it("reports failed and honors a caller resetMs", async () => {
		vi.useFakeTimers();
		const options: UseCopyFeedbackOptions = {
			resetMs: 2_000,
			write: vi.fn(async () => {
				throw new Error("denied");
			}),
		};
		const { result } = renderHook(() => useCopyFeedback(options));

		await act(async () => {
			await result.current.copy("payload");
		});
		expect(result.current.status).toBe("failed");

		act(() => vi.advanceTimersByTime(1_999));
		expect(result.current.status).toBe("failed");
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.status).toBe("idle");
	});

	it("restarts the revert window on a rapid re-copy", async () => {
		vi.useFakeTimers();
		const write = vi.fn(async (_text: string) => {});
		const { result } = renderHook(() => useCopyFeedback({ write }));

		await act(async () => {
			await result.current.copy("first");
		});
		act(() => vi.advanceTimersByTime(1_000));
		await act(async () => {
			await result.current.copy("second");
		});

		act(() => vi.advanceTimersByTime(1_799));
		expect(result.current.status).toBe("copied");
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.status).toBe("idle");
	});

	it("clears the pending revert timer on unmount", async () => {
		vi.useFakeTimers();
		const write = vi.fn(async (_text: string) => {});
		const { result, unmount } = renderHook(() => useCopyFeedback({ write }));

		await act(async () => {
			await result.current.copy("text");
		});
		expect(vi.getTimerCount()).toBe(1);

		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("writes through the Tauri clipboard plugin by default", async () => {
		const { result } = renderHook(() => useCopyFeedback());

		await act(async () => {
			await result.current.copy("host-id");
		});

		expect(clipboardMocks.writeText).toHaveBeenCalledWith("host-id");
		expect(result.current.status).toBe("copied");
	});
});
