// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGitAvailability } from "./useGitAvailability";
import { useStore } from "@/store";
import type { GitAvailability } from "@/lib/ipc/git";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const remote = {
	id: "remote",
	name: "Remote",
	host: "remote.example.test",
	user: "dev",
	port: 2222,
	auth: "auto" as const,
};
beforeEach(() => {
	invoke.mockReset();
	useStore.setState({ sshHosts: [remote] });
});
afterEach(cleanup);

it("ignores a late local result after selecting an available SSH host", async () => {
	let resolveLocal!: (value: GitAvailability) => void;
	invoke.mockImplementation(async (_command, args) =>
		args.opts
			? { status: "available" }
			: new Promise<GitAvailability>((resolve) => {
					resolveLocal = resolve;
				}),
	);
	const { result, rerender } = renderHook(
		({ hostId }) => useGitAvailability(hostId),
		{ initialProps: { hostId: null as string | null } },
	);
	expect(result.current.state.status).toBe("checking");
	rerender({ hostId: remote.id });
	await waitFor(() => expect(result.current.state.status).toBe("available"));
	await act(async () => resolveLocal({ status: "missing" }));
	expect(result.current.state.status).toBe("available");
	expect(invoke).toHaveBeenLastCalledWith("git_availability", {
		opts: expect.objectContaining({
			host: remote.host,
			port: 2222,
			user: "dev",
		}),
	});
});

it("discards a delayed older check when an explicit recheck succeeds", async () => {
	let resolveFirst!: (value: GitAvailability) => void;
	invoke
		.mockImplementationOnce(
			() =>
				new Promise<GitAvailability>((resolve) => {
					resolveFirst = resolve;
				}),
		)
		.mockResolvedValue({ status: "available" });
	const { result } = renderHook(() => useGitAvailability(null));
	act(() => result.current.recheck());
	await waitFor(() => expect(result.current.state.status).toBe("available"));
	await act(async () => resolveFirst({ status: "missing" }));
	expect(result.current.state.status).toBe("available");
});

it("keeps transport rejection and malformed responses unknown, then allows recheck", async () => {
	invoke
		.mockRejectedValueOnce(new Error("connection lost"))
		.mockResolvedValueOnce({})
		.mockResolvedValue({ status: "available" });
	const { result } = renderHook(() => useGitAvailability(remote.id));
	await waitFor(() =>
		expect(result.current.state).toEqual({
			status: "unknown",
			detail: "Error: connection lost",
		}),
	);
	act(() => result.current.recheck());
	await waitFor(() => expect(result.current.state.status).toBe("unknown"));
	act(() => result.current.recheck());
	await waitFor(() => expect(result.current.state.status).toBe("available"));
});

it("does not probe for hidden consumers or substitute local Git for an unregistered host", () => {
	const { result, rerender } = renderHook(
		({ hostId, enabled }) => useGitAvailability(hostId, enabled),
		{ initialProps: { hostId: null as string | null, enabled: false } },
	);
	expect(invoke).not.toHaveBeenCalled();
	rerender({ hostId: "removed-host", enabled: true });
	expect(result.current.state.status).toBe("unknown");
	expect(invoke).not.toHaveBeenCalled();
});
