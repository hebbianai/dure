// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProjectRepository } from "./useProjectRepository";
import { useStore } from "@/store";
import type { Project } from "@/types";
import type { RepositoryStatus } from "@/lib/ipc/git";

const { probe, observe } = vi.hoisted(() => ({
	probe: vi.fn(),
	observe: vi.fn(),
}));
vi.mock("@/lib/ipc/git", async (original) => ({
	...(await original<object>()),
	localRepositoryStatus: probe,
}));
const project: Project = {
	id: "repo",
	name: "Chosen name",
	path: "/repo",
	kind: "local",
	isRepo: false,
};
beforeEach(() => {
	probe.mockReset();
	observe.mockReset().mockResolvedValue(undefined);
	useStore.setState({ observeProjectRepository: observe });
});
afterEach(cleanup);

it("ignores delayed results after switching projects or closing the dialog", async () => {
	const finish: Array<(value: RepositoryStatus) => void> = [];
	probe.mockImplementation(
		() => new Promise((resolve) => finish.push(resolve)),
	);
	const { result, rerender } = renderHook(
		({ selected, enabled }) => useProjectRepository(selected, enabled),
		{
			initialProps: { selected: project, enabled: true },
		},
	);
	const next = { ...project, id: "next", path: "/next" };
	rerender({ selected: next, enabled: true });
	await act(async () => finish[0]({ status: "repository" }));
	expect(observe).not.toHaveBeenCalled();
	expect(result.current.state?.status).toBe("checking");
	rerender({ selected: next, enabled: false });
	await act(async () => finish[1]({ status: "repository" }));
	expect(observe).not.toHaveBeenCalled();
	expect(result.current.state).toBeNull();
});

it("rechecks on reopen and does not loop when recovered metadata is published", async () => {
	probe.mockResolvedValue({ status: "repository" });
	const { result, rerender } = renderHook(
		({ selected, enabled }) => useProjectRepository(selected, enabled),
		{
			initialProps: { selected: project, enabled: true },
		},
	);
	await waitFor(() => expect(result.current.state?.status).toBe("repository"));
	expect(observe).toHaveBeenCalledWith(project, true);
	const updated = { ...project, isRepo: true };
	rerender({ selected: updated, enabled: true });
	expect(probe).toHaveBeenCalledTimes(1);
	rerender({ selected: updated, enabled: false });
	rerender({ selected: updated, enabled: true });
	await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
});

it("does not downgrade a known repository after an unavailable check", async () => {
	probe.mockRejectedValue(new Error("toolchain unavailable"));
	const { result } = renderHook(() =>
		useProjectRepository({ ...project, isRepo: true }),
	);
	await waitFor(() => expect(result.current.state?.status).toBe("unknown"));
	expect(observe).not.toHaveBeenCalled();
});

it("never probes remote project paths locally or runs while hidden", () => {
	const { rerender } = renderHook(
		({ selected, enabled }) => useProjectRepository(selected, enabled),
		{
			initialProps: { selected: project, enabled: false },
		},
	);
	rerender({
		selected: { ...project, kind: "ssh", sshHostId: "remote" },
		enabled: true,
	});
	expect(probe).not.toHaveBeenCalled();
});
