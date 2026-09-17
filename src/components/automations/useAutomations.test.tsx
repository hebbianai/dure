// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAutomations } from "@/components/automations/useAutomations";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

function authority(id: string): DureBackendRouteAuthorityV1 {
	return {
		schemaVersion: 1,
		profileId: id,
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id, generation: "g1" },
		target: { source: "local", hostId: "local" },
	};
}

function envelope(route: DureBackendRouteAuthorityV1, result: object) {
	return {
		schemaVersion: 1,
		routeAuthority: route,
		backendId: route.backend.id,
		backendGeneration: route.backend.generation,
		result: { schemaVersion: 1, ...result },
	};
}

function graphs(route: DureBackendRouteAuthorityV1) {
	return envelope(route, {
		apiVersion: "dure.orchestration/v1",
		method: "workflow.graph.list",
		receipt: {
			schemaVersion: 1,
			workflows: [
				{
					schemaVersion: 1,
					workflowId: route.profileId,
					revision: 1,
					name: route.profileId,
					enabled: false,
					nodeCount: 1,
				},
			],
		},
	});
}

function pendingResponse() {
	let resolve!: (value: unknown) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<unknown>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function catalogTransport() {
	const routes = [authority("first"), authority("second"), authority("third")];
	const pending = pendingResponse();
	let lists = 0;
	invoke.mockImplementation(async (_command, args) => {
		if (args.operation === "schedule.list") {
			return envelope(routes[lists++], { schedules: [], complete: true });
		}
		const route = args.route.authority;
		if (route.profileId === "second") return pending.promise;
		return graphs(route);
	});
	return { routes, pending };
}

it("publishes schedules and graphs from the same backend together during refresh", async () => {
	const { routes, pending } = catalogTransport();
	const { result } = renderHook(() => useAutomations());
	await waitFor(() => expect(result.current.loading).toBe(false));
	expect(result.current.graphs?.workflows[0].workflowId).toBe("first");
	act(() => result.current.refresh());
	await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
	expect(result.current.loading).toBe(true);
	expect(result.current.snapshot?.authority).toEqual(routes[0]);
	expect(result.current.graphs?.authority).toEqual(routes[0]);
	await act(async () => pending.resolve(graphs(routes[1])));
	expect(result.current.loading).toBe(false);
	expect(result.current.snapshot?.authority).toEqual(routes[1]);
	expect(result.current.graphs?.authority).toEqual(routes[1]);
	expect(result.current.graphs?.workflows[0].workflowId).toBe("second");
	expect(invoke.mock.calls[3][1].route).toEqual({
		kind: "exact",
		authority: routes[1],
	});
});

it.each(["success", "failure"])(
	"ignores a superseded graph %s",
	async (outcome) => {
		const { routes, pending } = catalogTransport();
		const { result } = renderHook(() => useAutomations());
		await waitFor(() => expect(result.current.loading).toBe(false));
		act(() => result.current.refresh());
		await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
		act(() => result.current.refresh());
		await waitFor(() =>
			expect(result.current.graphs?.authority).toEqual(routes[2]),
		);
		await act(async () => {
			if (outcome === "success") pending.resolve(graphs(routes[1]));
			else pending.reject(new Error("retired graph request"));
		});
		expect(result.current.snapshot?.authority).toEqual(routes[2]);
		expect(result.current.graphs?.authority).toEqual(routes[2]);
		expect(result.current.graphError).toBeUndefined();
		expect(result.current.loading).toBe(false);
	},
);

it("publishes new schedules without old graphs when the graph read fails", async () => {
	const { routes, pending } = catalogTransport();
	const { result } = renderHook(() => useAutomations());
	await waitFor(() => expect(result.current.loading).toBe(false));
	act(() => result.current.refresh());
	await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
	await act(async () => pending.reject(new Error("graph unavailable")));
	expect(result.current.snapshot?.authority).toEqual(routes[1]);
	expect(result.current.graphs).toBeUndefined();
	expect(result.current.graphError).toBeDefined();
	expect(result.current.error).toBeUndefined();
	expect(result.current.loading).toBe(false);
});

it("keeps the last catalog when schedule refresh fails", async () => {
	const { routes } = catalogTransport();
	const { result } = renderHook(() => useAutomations());
	await waitFor(() => expect(result.current.loading).toBe(false));
	invoke.mockRejectedValueOnce(new Error("schedules unavailable"));
	act(() => result.current.refresh());
	await waitFor(() => expect(result.current.error).toBeDefined());
	expect(result.current.snapshot?.authority).toEqual(routes[0]);
	expect(result.current.graphs?.authority).toEqual(routes[0]);
	expect(invoke).toHaveBeenCalledTimes(3);
});

it("does not start a graph request after the view is retired", async () => {
	const pending = pendingResponse();
	invoke.mockReturnValue(pending.promise);
	const { unmount } = renderHook(() => useAutomations());
	unmount();
	await act(async () =>
		pending.resolve(
			envelope(authority("first"), {
				schedules: [],
				complete: true,
			}),
		),
	);
	expect(invoke).toHaveBeenCalledOnce();
});
