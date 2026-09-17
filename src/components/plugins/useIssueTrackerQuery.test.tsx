// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIssueTrackerQuery } from "@/components/plugins/useIssueTrackerQuery";
import type { IssueTrackerQueryResultV1 } from "@/contracts/generated/extensionContracts";
import type { DureIssueTrackerQueryRequest } from "@/lib/ipc/plugins";
import {
	issueTrackerCountsResult,
	issueTrackerListResult,
} from "@/lib/plugins/issueTrackerUi";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ dureIssueTrackerQuery: mocks.query }));

const request: DureIssueTrackerQueryRequest = {
	plugin_id: "example.tracker",
	contribution_id: "example.issues",
	workspace_root: "/work/first",
	query: { kind: "counts" },
};
const counts = { ready: 1, open: 2, blocked: 3 };
const response: IssueTrackerQueryResultV1 = { kind: "counts", counts };

function deferred() {
	let resolve!: (value: IssueTrackerQueryResultV1) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<IssueTrackerQueryResultV1>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

describe("useIssueTrackerQuery", () => {
	it("reads nothing until the caller supplies an admitted request", async () => {
		mocks.query.mockResolvedValue(response);
		const initialProps: { input: DureIssueTrackerQueryRequest | null } = {
			input: null,
		};
		const { result, rerender } = renderHook(
			({ input }: { input: DureIssueTrackerQueryRequest | null }) =>
				useIssueTrackerQuery(input, issueTrackerCountsResult),
			{ initialProps },
		);
		expect(mocks.query).not.toHaveBeenCalled();
		expect(result.current.loading).toBe(false);
		rerender({ input: request });
		await waitFor(() => expect(result.current.data).toEqual(counts));
		expect(mocks.query).toHaveBeenCalledExactlyOnceWith(request);
	});

	it.each(["resolve", "reject"] as const)(
		"does not let an older workspace %s into the replacement read",
		async (settle) => {
			const old = deferred();
			const next = deferred();
			mocks.query
				.mockReturnValueOnce(old.promise)
				.mockReturnValueOnce(next.promise);
			const { result, rerender } = renderHook(
				({ input }) => useIssueTrackerQuery(input, issueTrackerCountsResult),
				{ initialProps: { input: request } },
			);
			const replacement = { ...request, workspace_root: "/work/second" };
			rerender({ input: replacement });
			await act(async () => {
				if (settle === "resolve") old.resolve(response);
				else old.reject(new Error("old workspace failed"));
			});
			expect(result.current.data).toBeNull();
			expect(result.current.error).toBeNull();
			expect(result.current.loading).toBe(true);
			await act(async () => next.resolve(response));
			expect(result.current.data).toEqual(counts);
		},
	);

	it("drops a pending completion after permission disables the request", async () => {
		const pending = deferred();
		mocks.query.mockReturnValue(pending.promise);
		const initialProps: { input: DureIssueTrackerQueryRequest | null } = {
			input: request,
		};
		const { result, rerender } = renderHook(
			({ input }: { input: DureIssueTrackerQueryRequest | null }) =>
				useIssueTrackerQuery(input, issueTrackerCountsResult),
			{ initialProps },
		);
		rerender({ input: null });
		await act(async () => pending.resolve(response));
		expect(result.current.data).toBeNull();
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it("replaces a pending read with a watcher snapshot without querying again", async () => {
		const pending = deferred();
		mocks.query.mockReturnValue(pending.promise);
		const { result } = renderHook(() =>
			useIssueTrackerQuery(request, issueTrackerCountsResult),
		);
		const watched = { ready: 4, open: 5, blocked: 6 };
		act(() => result.current.replace(watched));
		await act(async () => pending.resolve(response));
		expect(result.current.data).toEqual(watched);
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it("retains counts across refresh failure but never across workspace replacement", async () => {
		const refresh = deferred();
		mocks.query
			.mockResolvedValueOnce(response)
			.mockReturnValue(refresh.promise);
		const { result, rerender } = renderHook(
			({ input }) =>
				useIssueTrackerQuery(input, issueTrackerCountsResult, {
					keepDataOnRefresh: true,
				}),
			{ initialProps: { input: request } },
		);
		await waitFor(() => expect(result.current.data).toEqual(counts));
		act(() => result.current.refresh());
		expect(result.current.data).toEqual(counts);
		expect(result.current.loading).toBe(true);
		const failure = new Error("counts unavailable");
		await act(async () => refresh.reject(failure));
		expect(result.current.data).toEqual(counts);
		expect(result.current.error).toBe(failure);
		mocks.query.mockReturnValue(deferred().promise);
		rerender({ input: { ...request, workspace_root: "/work/second" } });
		expect(result.current.data).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("reports response projection failures through the same read result", async () => {
		mocks.query.mockResolvedValue(response);
		const listRequest: DureIssueTrackerQueryRequest = {
			...request,
			query: { kind: "list", limit: 100 },
		};
		const { result } = renderHook(() =>
			useIssueTrackerQuery(listRequest, issueTrackerListResult),
		);
		await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
		expect(result.current.loading).toBe(false);
		expect(result.current.data).toBeNull();
	});
});
