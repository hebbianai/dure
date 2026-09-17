// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/files/directoryListing", () => ({ loadDirectory: vi.fn() }));
import { loadDirectory } from "@/lib/files/directoryListing";
import { useDirectoryListing } from "./useDirectoryListing";

const target = { path: "/repo", source: "local" as const, showGitIgnored: true };
const entries = [{ path: "/repo/a", name: "a", isDir: false, isRepo: false }];
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("caches closed folders and refreshes only when their input revision changes", async () => {
  vi.mocked(loadDirectory).mockResolvedValue(entries);
  const view = renderHook(({ open, revision }) => useDirectoryListing(target, revision, open), { initialProps: { open: false, revision: 0 } });
  expect(loadDirectory).not.toHaveBeenCalled();
  view.rerender({ open: true, revision: 0 });
  await waitFor(() => expect(view.result.current.entries).toBe(entries));
  view.rerender({ open: false, revision: 0 });
  view.rerender({ open: true, revision: 0 });
  expect(loadDirectory).toHaveBeenCalledTimes(1);
  vi.mocked(loadDirectory).mockRejectedValueOnce(new Error("denied"));
  view.rerender({ open: true, revision: 1 });
  await waitFor(() => expect(view.result.current.error).toBe("Error: denied"));
  expect(view.result.current.entries).toEqual([]);
  act(() => view.result.current.reload());
  await waitFor(() => expect(view.result.current.entries).toBe(entries));
  expect(view.result.current.error).toBeNull();
});

it("ignores the abandoned StrictMode request and accepts the replayed request", async () => {
  const pending: Array<(value: typeof entries) => void> = [];
  vi.mocked(loadDirectory).mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  const view = renderHook(() => useDirectoryListing(target, 0), { wrapper: StrictMode });
  expect(pending).toHaveLength(2);
  await act(async () => pending[0](entries));
  expect(view.result.current.entries).toBeNull();
  await act(async () => pending[1](entries));
  expect(view.result.current.entries).toBe(entries);
});
