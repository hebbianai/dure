// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { useProBrowserPane } from "./useProBrowserPane";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), active: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/components/workspace/usePaneFirstReveal", () => ({
	usePaneFirstReveal: () => true,
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeActive: () => mocks.active,
}));
afterEach(() => {
	mocks.invoke.mockReset();
	mocks.active = false;
});

const route = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend:one", generation: "generation:one" },
	target: { source: "local", hostId: "local" },
};
const otherRoute = {
	...route,
	revision: `sha256:${"b".repeat(64)}`,
	backend: { id: "backend:two", generation: "generation:two" },
};
const workspace = (id: string) => ({
	workspace_id: id,
	project_name: id,
	root_path: `/tmp/${id}`,
});
const resource = {
	resource_id: "browser:existing",
	generation: "generation:one",
	workspace_id: "workspace:one",
};
const control = {
	resource,
	revision: "1",
	phase: "ready",
	controller: null,
	requested_controller: null,
	in_flight: null,
	next_command_sequence: "1",
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function fixture(
	params: {
		url: string;
		browserBinding?: unknown;
		browserCreation?: unknown;
	} = { url: "about:blank" },
	handle: (body: Record<string, unknown>) => Promise<unknown> = async (
		body,
	) => {
		if (body.kind === "workspaces")
			return {
				workspaces: [workspace("workspace:one"), workspace("workspace:two")],
				next: null,
			};
		if (body.kind === "list")
			return {
				resources: body.workspace_id === resource.workspace_id ? [control] : [],
			};
		if (body.kind === "create") return { control };
		if (body.kind === "observe")
			return {
				control,
				pages: ["page:first", "page:selected"].map((page_id) => ({
					page: { resource, page_id, document_revision: "1" },
					url: "about:blank",
					title: page_id,
					profile_id: "default",
				})),
			};
		if (body.kind === "frame")
			return {
				page: body.page,
				mimeType: "image/jpeg",
				base64: "aW1hZ2U=",
				viewport: { width: 400, height: 600, pixel_ratio: 1 },
			};
		throw Error(`Unexpected request ${body.kind}`);
	},
) {
	let selected = route;
	mocks.invoke.mockImplementation(async (command, args) => {
		if (command === "dure_backend_route_assert")
			return args.route.kind === "exact" ? args.route.authority : selected;
		expect(command).toBe("dure_backend_request");
		const authority = args.route.authority;
		return {
			schemaVersion: 1,
			backendId: authority.backend.id,
			backendGeneration: authority.backend.generation,
			routeAuthority: authority,
			result: {
				schemaVersion: 1,
				operation_id: args.body.operation_id ?? null,
				result: await handle(args.body),
			},
		};
	});
	const api = {
		id: "browser:recovery",
		isVisible: true,
		updateParameters: vi.fn((update) => Object.assign(params, update)),
		onDidVisibilityChange: () => ({ dispose() {} }),
	};
	const mount = () =>
		renderHook(() =>
			useProBrowserPane({ api, params } as unknown as IDockviewPanelProps<
				typeof params
			>),
		);
	const requests = (kind: string) =>
		mocks.invoke.mock.calls
			.filter(([, args]) => args.body?.kind === kind)
			.map(([, args]) => args);
	return {
		api,
		mount,
		requests,
		selectBackend: () => {
			selected = otherRoute;
		},
	};
}

it("viewer attachment is passive and explicit workspace selection binds the inspected resource", async () => {
	const second = { ...resource, resource_id: "browser:second" };
	let selected: {
		workspace_id: string;
		generation: string;
		revision: string;
		current_resource: typeof resource | null;
	} = {
		workspace_id: resource.workspace_id,
		generation: resource.generation,
		revision: "1",
		current_resource: null,
	};
	const f = fixture({ url: "about:blank" }, async (body) => {
		if (body.kind === "workspaces")
			return { workspaces: [workspace(resource.workspace_id)], next: null };
		if (body.kind === "list")
			return {
				workspace_id: resource.workspace_id,
				resources: [control, { ...control, resource: second }],
				target: selected,
			};
		if (body.kind === "observe")
			return {
				control: {
					...control,
					resource: body.resource_id === second.resource_id ? second : resource,
				},
				pages: [],
			};
		if (body.kind === "select_resource") {
			expect(body.expected).toEqual(selected);
			selected = {
				...selected,
				revision: String(BigInt(selected.revision) + 1n),
				current_resource: body.resource as typeof resource,
			};
			return { target: selected };
		}
		throw Error(`Unexpected request ${body.kind}`);
	});
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.workspaces).toHaveLength(1));
		await act(() => pane.result.current.selectWorkspace(resource.workspace_id));
		act(() => pane.result.current.attach(second.resource_id));
		await act(() => pane.result.current.session!.refresh());
		expect(f.requests("select_resource")).toHaveLength(0);
		expect(selected.current_resource).toBeNull();
		await act(() => pane.result.current.useForWorkspace());
		expect(selected.current_resource).toEqual(second);
		const stale = pane.result.current.useForWorkspace;
		act(() => pane.result.current.attach(resource.resource_id));
		await act(stale);
		expect(f.requests("select_resource")).toHaveLength(1);
		expect(selected.current_resource).toEqual(second);
		await act(() => pane.result.current.useForWorkspace());
		expect(selected.current_resource).toEqual(resource);
		expect(f.requests("control")).toHaveLength(0);
		expect(f.requests("action")).toHaveLength(0);
	} finally {
		pane.unmount();
	}
});

it("reconnects the latest saved browser and page on its exact route", async () => {
	const f = fixture();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.workspaces).toHaveLength(2));
		await act(() => pane.result.current.selectWorkspace("workspace:one"));
		act(() => pane.result.current.attach(resource.resource_id));
		await act(() => pane.result.current.session!.refresh());
		act(() => pane.result.current.selectPage("page:selected"));
		f.selectBackend();
		act(() => pane.result.current.reconnect());
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(pane.result.current.session?.resource).toEqual(resource);
		// Observation selects the persisted page before image decoding, which is
		// outside this hook's restoration contract in the inactive test pane.
		await act(() => pane.result.current.session!.refresh());
		expect(pane.result.current.session?.read().page?.page_id).toBe(
			"page:selected",
		);
		expect(f.requests("list").slice(-1)[0]?.route.authority).toEqual(route);
		expect(
			f.api.updateParameters.mock.calls.slice(-1)[0]?.[0].browserBinding.pageId,
		).toBe("page:selected");
	} finally {
		pane.unmount();
	}
});

it.each([resource.workspace_id, null])(
	"recovers an uncertain create after remount using its original route and operation (%s)",
	async (workspaceId) => {
		const pending = {
			authority: route,
			workspaceId,
			operationId: "create:original",
		};
		const f = fixture({ url: "about:blank", browserCreation: pending });
		f.selectBackend();
		const pane = f.mount();
		try {
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			expect(f.requests("create")).toHaveLength(1);
			expect(f.requests("create")[0]).toMatchObject({
				route: { kind: "exact", authority: route },
				body: {
					...(workspaceId === null ? {} : { workspace_id: workspaceId }),
					operation_id: pending.operationId,
				},
			});
			expect(pane.result.current.session?.resource).toEqual(resource);
			expect(f.api.updateParameters.mock.calls.slice(-1)[0]?.[0]).toMatchObject(
				{
					browserCreation: undefined,
					browserBinding: { authority: route, resource },
				},
			);
		} finally {
			pane.unmount();
		}
	},
);

it("loads the saved workspace beyond the first catalog page", async () => {
	const f = fixture(
		{ url: "about:blank", browserBinding: { authority: route, resource } },
		async (body) => {
			if (body.kind === "workspaces")
				return body.after
					? { workspaces: [workspace(resource.workspace_id)], next: null }
					: {
							workspaces: [workspace("workspace:earlier")],
							next: "workspace:earlier",
						};
			if (body.kind === "list") return { resources: [control] };
			throw Error(`Unexpected request ${body.kind}`);
		},
	);
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(
			pane.result.current.workspaces.map((row) => row.workspace_id),
		).toContain(resource.workspace_id);
		expect(pane.result.current.session?.resource).toEqual(resource);
		expect(f.requests("workspaces").map((args) => args.body.after)).toEqual([
			undefined,
			"workspace:earlier",
		]);
	} finally {
		pane.unmount();
	}
});

it.each(["workspace create", "personal navigation"])(
	"does not write a completed create into a pane that has been removed (%s)",
	async (mode) => {
		mocks.active = mode === "personal navigation";
		const created = deferred<unknown>();
		const f = fixture(undefined, async (body) => {
			if (body.kind === "workspaces")
				return { workspaces: [workspace(resource.workspace_id)], next: null };
			if (body.kind === "list") return { resources: [] };
			if (body.kind === "create") return created.promise;
			throw Error(`Unexpected request ${body.kind}`);
		});
		const pane = f.mount();
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		if (mode === "workspace create")
			await act(() =>
				pane.result.current.selectWorkspace(resource.workspace_id),
			);
		let creating!: Promise<void>;
		act(() => {
			creating =
				mode === "workspace create"
					? pane.result.current.create()
					: pane.result.current.navigate("https://example.com");
		});
		await waitFor(() => expect(f.requests("create")).toHaveLength(1));
		const writes = f.api.updateParameters.mock.calls.length;
		pane.unmount();
		created.resolve({ control });
		await creating;
		expect(f.api.updateParameters).toHaveBeenCalledTimes(writes);
		expect(f.requests("control")).toHaveLength(0);
		expect(f.requests("action")).toHaveLength(0);
	},
);

it("keeps a lost create pending until an explicit reconnect reuses the same operation", async () => {
	const pending = {
		authority: route,
		workspaceId: resource.workspace_id,
		operationId: "create:lost",
	};
	let attempts = 0;
	const f = fixture(
		{ url: "about:blank", browserCreation: pending },
		async (body) => {
			if (body.kind === "workspaces")
				return { workspaces: [workspace(resource.workspace_id)], next: null };
			if (body.kind === "list") return { resources: [] };
			if (body.kind === "create") {
				if (++attempts === 1) throw Error("response lost");
				return { control };
			}
			throw Error(`Unexpected request ${body.kind}`);
		},
	);
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(pane.result.current.error).toBeDefined();
		expect(f.requests("create")).toHaveLength(1);
		expect(f.api.updateParameters).not.toHaveBeenCalled();
		f.selectBackend();
		act(() => pane.result.current.reconnect());
		await waitFor(() =>
			expect(pane.result.current.session?.resource).toEqual(resource),
		);
		expect(
			f
				.requests("create")
				.map((args) => [args.route.authority, args.body.operation_id]),
		).toEqual([
			[route, pending.operationId],
			[route, pending.operationId],
		]);
	} finally {
		pane.unmount();
	}
});

it.each(["fresh", "restored", "unbound"])(
	"allows an explicit new create after a known installation failure (%s)",
	async (mode) => {
		const restored = mode !== "fresh";
		const pending = {
			authority: route,
			workspaceId: resource.workspace_id,
			operationId: "create:missing-installation",
		};
		let installed = false;
		let failedOperation = restored ? pending.operationId : undefined;
		const f = fixture(
			{
				url: "about:blank",
				...(mode === "unbound"
					? {}
					: {
							browserBinding: {
								authority: route,
								workspaceId: resource.workspace_id,
							},
						}),
				...(restored ? { browserCreation: pending } : {}),
			},
			async (body) => {
				if (body.kind === "workspaces")
					return { workspaces: [workspace(resource.workspace_id)], next: null };
				if (body.kind === "list") return { resources: [] };
				if (body.kind === "create") {
					if (!installed) failedOperation = body.operation_id as string;
					if (body.operation_id === failedOperation)
						throw {
							code: "browser_engine_not_installed",
							message: "browser_engine_not_installed",
							details: { disposition: "terminal" },
						};
					return { control };
				}
				throw Error(`Unexpected request ${body.kind}`);
			},
		);
		const invoke = mocks.invoke.getMockImplementation()!;
		if (restored)
			mocks.invoke.mockImplementation(async (command, args) => {
				if (
					args.body?.kind === "create" &&
					args.body.operation_id === pending.operationId
				)
					return {
						schemaVersion: 1,
						backendId: route.backend.id,
						backendGeneration: route.backend.generation,
						routeAuthority: route,
						result: {
							schemaVersion: 1,
							operation_id: pending.operationId,
							replayed: true,
							result_available: true,
							result: null,
							error: { code: "browser_engine_not_installed" },
							receipt: {
								operationId: pending.operationId,
								operationKind: "browser.resource",
								state: "failed",
								terminalCode: "browser_engine_not_installed",
							},
						},
					};
				return invoke(command, args);
			});
		let pane = f.mount();
		try {
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			if (!restored) await act(() => pane.result.current.create());
			expect(pane.result.current.error).toMatchObject({
				code: "browser_engine_not_installed",
			});
			expect(f.api.updateParameters).toHaveBeenLastCalledWith({
				browserBinding: {
					authority: route,
					workspaceId: resource.workspace_id,
				},
				browserCreation: undefined,
			});
			expect(f.requests("create")).toHaveLength(1);
			installed = true;
			pane.unmount();
			f.selectBackend();
			pane = f.mount();
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			expect(pane.result.current.error).toBeUndefined();
			expect(f.requests("create")).toHaveLength(1);
			await act(() => pane.result.current.create());
			expect(pane.result.current.session?.resource).toEqual(resource);
			const creates = f.requests("create");
			expect(creates).toHaveLength(2);
			expect(creates[1].body.operation_id).not.toBe(failedOperation);
			expect(creates[1].route).toEqual({ kind: "exact", authority: route });
		} finally {
			pane.unmount();
		}
	},
);

it.each([
	{ code: "browser_engine_not_installed", disposition: "retry_same" },
	{ code: "browser_operation_outcome_unknown", disposition: "terminal" },
])(
	"retains creation authority when a failure does not prove it was unstarted (%j)",
	async (failure) => {
		const pending = {
			authority: route,
			workspaceId: resource.workspace_id,
			operationId: "create:uncertain",
		};
		const f = fixture(
			{ url: "about:blank", browserCreation: pending },
			async (body) => {
				if (body.kind === "workspaces")
					return { workspaces: [workspace(resource.workspace_id)], next: null };
				if (body.kind === "list") return { resources: [] };
				if (body.kind === "create")
					throw {
						code: failure.code,
						message: failure.code,
						details: { disposition: failure.disposition },
					};
				throw Error(`Unexpected request ${body.kind}`);
			},
		);
		const pane = f.mount();
		try {
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			expect(f.requests("create")).toHaveLength(1);
			f.selectBackend();
			act(() => pane.result.current.reconnect());
			await waitFor(() => expect(f.requests("create")).toHaveLength(2));
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			expect(
				f
					.requests("create")
					.map((args) => [args.route.authority, args.body.operation_id]),
			).toEqual([
				[route, pending.operationId],
				[route, pending.operationId],
			]);
			expect(f.api.updateParameters).not.toHaveBeenCalled();
			expect(pane.result.current.session).toBeUndefined();
		} finally {
			pane.unmount();
		}
	},
);

it("does not let an old workspace failure clear the newer selection's pending state", async () => {
	const old = deferred<unknown>();
	const current = deferred<unknown>();
	const f = fixture(undefined, async (body) => {
		if (body.kind === "workspaces")
			return {
				workspaces: [workspace("workspace:one"), workspace("workspace:two")],
				next: null,
			};
		if (body.kind === "list")
			return body.workspace_id === "workspace:one"
				? old.promise
				: current.promise;
		throw Error(`Unexpected request ${body.kind}`);
	});
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		let first!: Promise<void>;
		let second!: Promise<void>;
		act(() => {
			first = pane.result.current.selectWorkspace("workspace:one");
		});
		act(() => {
			second = pane.result.current.selectWorkspace("workspace:two");
		});
		await act(async () => {
			old.reject(Error("old workspace unavailable"));
			await first;
		});
		expect(pane.result.current.busy).toBe(true);
		expect(pane.result.current.error).toBeUndefined();
		await act(async () => {
			current.resolve({ resources: [] });
			await second;
		});
		expect(pane.result.current.workspaceId).toBe("workspace:two");
		expect(pane.result.current.busy).toBe(false);
	} finally {
		pane.unmount();
	}
});

it.each([
	"broken",
	{ authority: route, workspaceId: resource.workspace_id, operationId: "" },
])(
	"does not reinterpret malformed saved creation as a new request (%j)",
	async (browserCreation) => {
		const f = fixture({ url: "about:blank", browserCreation });
		const pane = f.mount();
		try {
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			expect(pane.result.current.error).toBeDefined();
			expect(f.requests("create")).toHaveLength(0);
			expect(mocks.invoke).not.toHaveBeenCalled();
		} finally {
			pane.unmount();
		}
	},
);

const restartedRoute = {
	...route,
	revision: `sha256:${"c".repeat(64)}`,
	backend: { ...route.backend, generation: "generation:restarted" },
};
const obsoleteRouteError = {
	code: "backend_transport_authority_changed",
	message: "the exact backend route changed",
};
function rejectSavedRoute(currentRoute = restartedRoute) {
	const invoke = mocks.invoke.getMockImplementation()!;
	mocks.invoke.mockImplementation(async (command, args) => {
		if (command === "dure_backend_route_assert") {
			if (args.route.kind === "exact") throw obsoleteRouteError;
			expect(args.route.profileId).toBe(route.profileId);
			return currentRoute;
		}
		return invoke(command, args);
	});
}

it("loads the current catalog after the saved backend generation restarts without replaying input", async () => {
	const params = {
		url: "https://www.dureai.dev/",
		browserBinding: { authority: route, resource, pageId: "page:old" },
	};
	const f = fixture(params, async (body) => {
		if (body.kind === "workspaces")
			return { workspaces: [workspace(resource.workspace_id)], next: null };
		if (body.kind === "list") return { resources: [] };
		throw Error(`Unexpected request ${body.kind}`);
	});
	rejectSavedRoute();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(pane.result.current.workspaces).toEqual([
			workspace(resource.workspace_id),
		]);
		expect(pane.result.current.error).toBeUndefined();
		expect(pane.result.current.workspaceId).toBe(resource.workspace_id);
		expect(pane.result.current.session).toBeUndefined();
		expect(params.browserBinding).toEqual({
			authority: restartedRoute,
			workspaceId: resource.workspace_id,
		});
		expect(f.requests("list")[0]?.route.authority).toEqual(restartedRoute);
		for (const kind of ["create", "control", "action", "close"])
			expect(f.requests(kind)).toHaveLength(0);
	} finally {
		pane.unmount();
	}
});

it("retains the browser and page when only the same backend route revision changes", async () => {
	const updatedRoute = { ...restartedRoute, backend: route.backend };
	const params = {
		url: "about:blank",
		browserBinding: { authority: route, resource, pageId: "page:selected" },
	};
	const f = fixture(params);
	rejectSavedRoute(updatedRoute);
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(pane.result.current.error).toBeUndefined();
		expect(pane.result.current.session?.resource).toEqual(resource);
		expect(params.browserBinding).toMatchObject({
			authority: updatedRoute,
			resource,
			pageId: "page:selected",
		});
		expect(f.requests("list")[0]?.route.authority).toEqual(updatedRoute);
	} finally {
		pane.unmount();
	}
});

it.each([
	{ ...restartedRoute, backend: otherRoute.backend },
	{ ...restartedRoute, profileId: "another-profile" },
	{
		...restartedRoute,
		target: {
			source: "ssh",
			hostId: "ssh:other",
			remote: { host: "example.com", port: 22, user: "user" },
		},
	},
])(
	"does not recover a saved browser through another profile, backend or host (%j)",
	async (currentRoute) => {
		const params = {
			url: "about:blank",
			browserBinding: { authority: route, resource },
		};
		const saved = params.browserBinding;
		const f = fixture(params);
		rejectSavedRoute(currentRoute as typeof restartedRoute);
		const pane = f.mount();
		try {
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			expect(pane.result.current.error).toBeDefined();
			expect(pane.result.current.session).toBeUndefined();
			expect(params.browserBinding).toBe(saved);
			expect(f.requests("workspaces")).toHaveLength(0);
		} finally {
			pane.unmount();
		}
	},
);

it("keeps an uncertain create on its obsolete exact route even after explicit reconnect", async () => {
	const pending = {
		authority: route,
		workspaceId: resource.workspace_id,
		operationId: "create:uncertain-before-restart",
	};
	const params = { url: "about:blank", browserCreation: pending };
	const f = fixture(params);
	rejectSavedRoute();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		act(() => pane.result.current.reconnect());
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(pane.result.current.error).toBeDefined();
		expect(params.browserCreation).toBe(pending);
		expect(f.requests("create")).toHaveLength(0);
		expect(f.requests("workspaces")).toHaveLength(0);
		expect(
			mocks.invoke.mock.calls.every(([, args]) => args.route.kind === "exact"),
		).toBe(true);
	} finally {
		pane.unmount();
	}
});

it("persists a replacement route only after its catalog and resource list succeed", async () => {
	const saved = { authority: route, resource };
	const params = { url: "about:blank", browserBinding: saved };
	let fail = true;
	const f = fixture(params, async (body) => {
		if (body.kind === "workspaces") {
			if (fail) throw new Error("catalog interrupted");
			return { workspaces: [workspace(resource.workspace_id)], next: null };
		}
		if (body.kind === "list") return { resources: [] };
		throw Error(`Unexpected request ${body.kind}`);
	});
	rejectSavedRoute();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.error).toBeDefined());
		expect(params.browserBinding).toBe(saved);
		fail = false;
		act(() => pane.result.current.reconnect());
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(pane.result.current.error).toBeUndefined();
		expect(params.browserBinding).toEqual({
			authority: restartedRoute,
			workspaceId: resource.workspace_id,
		});
	} finally {
		pane.unmount();
	}
});

it("does not query or persist a late replacement route after the pane unmounts", async () => {
	const saved = { authority: route, resource };
	const f = fixture({ url: "about:blank", browserBinding: saved });
	const replacement = deferred<typeof restartedRoute>();
	mocks.invoke.mockImplementation(async (_command, args) => {
		if (args.route.kind === "exact") throw obsoleteRouteError;
		return replacement.promise;
	});
	const pane = f.mount();
	await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
	pane.unmount();
	await act(async () => replacement.resolve(restartedRoute));
	expect(f.requests("workspaces")).toHaveLength(0);
	expect(f.api.updateParameters).not.toHaveBeenCalled();
});
