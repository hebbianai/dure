// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProBrowserPane } from "./useProBrowserPane";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/workspace/usePaneFirstReveal", () => ({
	usePaneFirstReveal: () => true,
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeActive: () => true,
}));
afterEach(() => {
	vi.unstubAllGlobals();
	mocks.invoke.mockReset();
});

async function fixture(selected = "page:kept") {
	const route = {
		schemaVersion: 1,
		profileId: "local",
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "backend:one", generation: "generation:one" },
		target: { source: "local", hostId: "local" },
	};
	const resource = {
		resource_id: "browser:one",
		generation: "generation:one",
		workspace_id: "workspace:one",
	};
	const kept = { resource, page_id: "page:kept", document_revision: "1" };
	const removed = { ...kept, page_id: "page:removed" };
	let pages = [kept, removed];
	let present = true;
	let revision = "1";
	let nextObservation: Promise<unknown> | undefined;
	const control = () => ({
		resource,
		revision,
		phase: "ready",
		controller: null,
		requested_controller: null,
		in_flight: null,
		next_command_sequence: "1",
		current_page: kept,
	});
	const observation = () => ({
		control: control(),
		pages: pages.map((page) => ({
			page,
			url: "https://example.com/",
			title: page.page_id,
			profile_id:
				page.page_id === removed.page_id ? "profile:removed" : "default",
		})),
	});
	const requests: Record<string, unknown>[] = [];
	mocks.invoke.mockImplementation(async (command, args) => {
		if (command === "dure_backend_route_assert") return route;
		expect(command).toBe("dure_backend_request");
		expect(args.route).toEqual({ kind: "exact", authority: route });
		const body = args.body;
		requests.push(body);
		let result: unknown;
		if (body.kind === "workspaces")
			result = {
				workspaces: ["workspace:one", "workspace:other"].map(
					(workspace_id) => ({
						workspace_id,
						project_name: workspace_id,
						root_path: "/tmp/project",
					}),
				),
				next: null,
			};
		else if (body.kind === "list")
			result = {
				resources:
					present && body.workspace_id === resource.workspace_id
						? [control()]
						: [],
			};
		else if (body.kind === "observe") {
			const pending = nextObservation;
			nextObservation = undefined;
			result = pending ? await pending : observation();
		} else if (body.kind === "frame")
			result = {
				page: body.page,
				mimeType: "image/jpeg",
				base64: "/9j/2Q==",
				viewport: { width: 400, height: 600, pixel_ratio: 1 },
			};
		else throw new Error(`Unexpected request ${body.kind}`);
		return {
			schemaVersion: 1,
			backendId: route.backend.id,
			backendGeneration: route.backend.generation,
			routeAuthority: route,
			result: { schemaVersion: 1, operation_id: null, result },
		};
	});
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			naturalWidth = 400;
			naturalHeight = 600;
			async decode() {}
		},
	);
	const updateParameters = vi.fn();
	const props = {
		api: {
			isVisible: true,
			updateParameters,
			onDidVisibilityChange: () => ({ dispose() {} }),
		},
		params: {
			url: "https://example.com/",
			browserBinding: {
				authority: route,
				workspaceId: resource.workspace_id,
				resource,
				pageId: selected,
			},
		},
	} as unknown as Parameters<typeof useProBrowserPane>[0];
	const hook = renderHook(() => useProBrowserPane(props));
	await waitFor(() => expect(hook.result.current.view.frame).toBeDefined());
	return {
		...hook,
		route,
		resource,
		kept,
		removed,
		updateParameters,
		requests,
		observation,
		delayObservation: (pending: Promise<unknown>) => {
			nextObservation = pending;
		},
		retire: (entireResource: boolean) => {
			present = !entireResource;
			pages = [kept];
			revision = "2";
		},
	};
}

it.each(["last-resource", "kept-selection", "removed-selection"] as const)(
	"reconciles %s from the canonical list without retaining a deleted frame",
	async (scenario) => {
		const state = await fixture(
			scenario === "removed-selection" ? "page:removed" : "page:kept",
		);
		try {
			const previousSession = state.result.current.session!;
			const stale = state.observation();
			let resolve!: (value: unknown) => void;
			state.delayObservation(
				new Promise((done) => {
					resolve = done;
				}),
			);
			const oldRefresh = previousSession.refresh();
			state.retire(scenario === "last-resource");
			await act(async () => {
				await state.result.current.refreshAfterProfileDeletion();
			});
			await act(async () => {
				resolve(stale);
				await oldRefresh;
			});
			if (scenario === "last-resource") {
				expect(state.result.current.session).toBeUndefined();
				expect(state.result.current.view.frame).toBeUndefined();
				expect(state.result.current.resources).toEqual([]);
				expect(
					state.updateParameters.mock.calls.slice(-1)[0]?.[0].browserBinding,
				).toEqual({
					authority: state.route,
					workspaceId: state.resource.workspace_id,
				});
			} else {
				await waitFor(() =>
					expect(state.result.current.view.frame?.capture.page).toEqual(
						state.kept,
					),
				);
				expect(state.result.current.session).not.toBe(previousSession);
				expect(state.result.current.view.followingCurrent).toBe(
					scenario === "removed-selection",
				);
			}
			expect(
				state.requests.some(
					(row) => row.kind === "control" || row.kind === "action",
				),
			).toBe(false);
		} finally {
			state.unmount();
		}
	},
);

it("ignores an old deletion completion after the user changes workspace", async () => {
	const state = await fixture();
	try {
		const oldCompletion = state.result.current.refreshAfterProfileDeletion;
		await act(async () => {
			await state.result.current.selectWorkspace("workspace:other");
		});
		const calls = state.requests.length;
		await act(async () => {
			await oldCompletion();
		});
		expect(state.result.current.workspaceId).toBe("workspace:other");
		expect(state.result.current.session).toBeUndefined();
		expect(state.requests).toHaveLength(calls);
		expect(
			state.updateParameters.mock.calls.slice(-1)[0]?.[0].browserBinding
				.workspaceId,
		).toBe("workspace:other");
	} finally {
		state.unmount();
	}
});
