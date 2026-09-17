// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProviderCatalog } from "./useProviderCatalog";
import { codexModelCatalog } from "@/test/providerModelCatalogFixtures";

describe("useProviderCatalog", () => {
	it("shares an in-flight catalog between model and effort menus, then refreshes on the next open", async () => {
		let complete: (value: typeof codexModelCatalog) => void = () => {};
		const source = {
			key: "backend-a:account-a",
			load: vi.fn(
				() =>
					new Promise<typeof codexModelCatalog>((resolve) => {
						complete = resolve;
					}),
			),
		};
		const { result } = renderHook(() => useProviderCatalog(source));
		act(() => result.current.onOpenChange(true));
		act(() => result.current.onOpenChange(false));
		act(() => result.current.onOpenChange(true));
		expect(source.load).toHaveBeenCalledTimes(1);
		await act(async () => complete(codexModelCatalog));
		expect(result.current.models).toEqual(codexModelCatalog);
		act(() => result.current.onOpenChange(true));
		expect(source.load).toHaveBeenCalledTimes(2);
		await act(async () => complete(codexModelCatalog));
	});

	it("starts a new credential scope immediately without letting the older request replace it", async () => {
		let completeOld: (value: typeof codexModelCatalog) => void = () => {};
		const old = {
			key: "backend-a:account-a",
			load: vi.fn(
				() =>
					new Promise<typeof codexModelCatalog>((resolve) => {
						completeOld = resolve;
					}),
			),
		};
		const next = {
			key: "backend-a:account-b",
			load: vi.fn().mockResolvedValue([]),
		};
		const { result, rerender } = renderHook(
			({ source }) => useProviderCatalog(source),
			{ initialProps: { source: old } },
		);
		act(() => result.current.onOpenChange(true));
		rerender({ source: next });
		act(() => result.current.onOpenChange(true));
		await waitFor(() => expect(result.current.models).toEqual([]));
		await act(async () => completeOld(codexModelCatalog));
		expect(result.current.models).toEqual([]);
		expect(next.load).toHaveBeenCalledTimes(1);
	});

	it("loads only on open, discards other credential scopes, and clears failed refreshes", async () => {
		let resolveOld: (value: typeof codexModelCatalog) => void = () => {};
		const old = {
			key: "backend-a:account-a",
			load: vi.fn(
				() =>
					new Promise<typeof codexModelCatalog>((resolve) => {
						resolveOld = resolve;
					}),
			),
		};
		const next = {
			key: "backend-b:account-b",
			load: vi.fn().mockResolvedValue([]),
		};
		const { result, rerender } = renderHook(
			({ source }) => useProviderCatalog(source),
			{ initialProps: { source: old } },
		);
		expect(old.load).not.toHaveBeenCalled();
		act(() => result.current.onOpenChange(true));
		rerender({ source: next });
		await act(async () => resolveOld(codexModelCatalog));
		expect(result.current.models).toBeUndefined();
		act(() => result.current.onOpenChange(true));
		await waitFor(() => expect(result.current.models).toEqual([]));
		next.load.mockRejectedValueOnce(new Error("unavailable"));
		act(() => result.current.onOpenChange(true));
		await waitFor(() => expect(result.current.error).toBe(true));
		expect(result.current.models).toBeUndefined();
	});
});
