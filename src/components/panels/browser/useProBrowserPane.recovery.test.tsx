// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserControlProjection } from "@/lib/browser/browserResourceContract";
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
	vi.unstubAllGlobals();
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

it("installs on the bound backend and creates only after installation is ready", async () => {
	const ready = deferred<unknown>();
	const f = fixture({ url: "about:blank" }, async (body) => {
		if (body.kind === "list")
			return { workspace_id: resource.workspace_id, resources: [] };
		if (body.kind === "runtime_install") return ready.promise;
		if (body.kind === "create") return { control };
		throw Error(`Unexpected request ${body.kind}`);
	});
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.connected).toBe(true));
		act(() => {
			void pane.result.current.installRuntime();
		});
		await waitFor(() => expect(pane.result.current.installing).toBe(true));
		expect(f.requests("create")).toHaveLength(0);
		await act(async () => {
			ready.resolve({ state: "ready" });
		});
		await waitFor(() =>
			expect(pane.result.current.session?.resource).toEqual(resource),
		);
		expect(f.requests("runtime_install")).toHaveLength(1);
		expect(f.requests("create")).toHaveLength(1);
		expect(f.requests("create")[0].route.authority).toEqual(route);
		expect(pane.result.current.installing).toBe(false);
	} finally {
		pane.unmount();
	}
});

it("does not create a browser after installation finishes for a detached pane", async () => {
	const ready = deferred<unknown>();
	const f = fixture({ url: "about:blank" }, async (body) => {
		if (body.kind === "list")
			return { workspace_id: resource.workspace_id, resources: [] };
		if (body.kind === "runtime_install") return ready.promise;
		throw Error(`Unexpected request ${body.kind}`);
	});
	const pane = f.mount();
	await waitFor(() => expect(pane.result.current.connected).toBe(true));
	act(() => {
		void pane.result.current.installRuntime();
	});
	await waitFor(() => expect(pane.result.current.installing).toBe(true));
	pane.unmount();
	await act(async () => {
		ready.resolve({ state: "ready" });
	});
	expect(f.requests("create")).toHaveLength(0);
});
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
				workspace_id: resource.workspace_id,
				resources: [control],
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
				operation_id:
					args.body.operation_id ?? args.body.authority?.operation_id ?? null,
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

it("viewer attachment is passive and explicit default selection binds the inspected resource", async () => {
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
		await waitFor(() => expect(pane.result.current.connected).toBe(true));
		act(() => pane.result.current.attach(second.resource_id));
		await act(() => pane.result.current.session!.refresh());
		expect(f.requests("select_resource")).toHaveLength(0);
		expect(selected.current_resource).toBeNull();
		await act(() => pane.result.current.selectDefaultBrowser());
		expect(selected.current_resource).toEqual(second);
		const stale = pane.result.current.selectDefaultBrowser;
		act(() => pane.result.current.attach(resource.resource_id));
		await act(stale);
		expect(f.requests("select_resource")).toHaveLength(1);
		expect(selected.current_resource).toEqual(second);
		await act(() => pane.result.current.selectDefaultBrowser());
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
		await waitFor(() => expect(pane.result.current.connected).toBe(true));
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

it.each([null])(
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

it.each([true, false])(
	"recovers a legacy worktree create by receipt without changing or replaying it (available: %s)",
	async (available) => {
		const pending = {
			authority: route,
			workspaceId: resource.workspace_id,
			operationId: "create:legacy",
		};
		const f = fixture({ url: "about:blank", browserCreation: pending });
		const respondFromFixture = mocks.invoke.getMockImplementation()!;
		mocks.invoke.mockImplementation(async (command, args) => {
			if (args.body?.kind !== "receipt")
				return respondFromFixture(command, args);
			return {
				schemaVersion: 1,
				backendId: route.backend.id,
				backendGeneration: route.backend.generation,
				routeAuthority: route,
				result: {
					schemaVersion: 1,
					operation_id: pending.operationId,
					result_available: available,
					receipt: {
						operationId: pending.operationId,
						operationKind: "browser.resource",
						state: available ? "succeeded" : "running",
					},
					result: available ? { control } : null,
				},
			};
		});
		const pane = f.mount();
		try {
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			if (available) {
				expect(pane.result.current.session?.resource).toEqual(resource);
				expect(pane.result.current.error).toBeUndefined();
			} else {
				expect(pane.result.current.error).toBeDefined();
				await act(() => pane.result.current.create());
				expect(pane.result.current.session).toBeUndefined();
				expect(f.api.updateParameters).toHaveBeenLastCalledWith({
					browserBinding: undefined,
					browserCreation: pending,
				});
			}
			expect(f.requests("create")).toHaveLength(0);
			expect(f.requests("receipt").map((row) => row.body)).toEqual(
				Array.from({ length: available ? 1 : 2 }, () => ({
					kind: "receipt",
					operation_id: pending.operationId,
				})),
			);
		} finally {
			pane.unmount();
		}
	},
);

it("restores an existing binding directly from the shared catalog without worktree discovery", async () => {
	const f = fixture({
		url: "about:blank",
		browserBinding: { authority: route, resource },
	});
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.busy).toBe(false));
		expect(pane.result.current.session?.resource).toEqual(resource);
		expect(f.requests("workspaces")).toHaveLength(0);
		expect(f.requests("list").map((row) => row.body)).toEqual([
			{ kind: "list" },
		]);
	} finally {
		pane.unmount();
	}
});

it.each(["explicit create", "personal navigation"])(
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
		let creating!: Promise<void>;
		act(() => {
			creating =
				mode === "explicit create"
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
		workspaceId: null,
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

it.each(
	["fresh", "restored", "unbound"].flatMap((mode) =>
		[
			"browser_engine_not_installed",
			"browser_installation_invalid",
			"browser_chromium_not_installed",
			"browser_engine_pin_mismatch",
		].map((code) => ({ mode, code })),
	),
)(
	"allows an explicit new create after a known installation failure (%j)",
	async ({ mode, code }) => {
		const restored = mode !== "fresh";
		const pending = {
			authority: route,
			workspaceId: null,
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
							code: code,
							message: code,
							details: { disposition: "terminal" },
						};
					return { control };
				}
				throw Error(`Unexpected request ${body.kind}`);
			},
		);
		const respondFromFixture = mocks.invoke.getMockImplementation()!;
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
							error: { code: code },
							receipt: {
								operationId: pending.operationId,
								operationKind: "browser.resource",
								state: "failed",
								terminalCode: code,
							},
						},
					};
				return respondFromFixture(command, args);
			});
		let pane = f.mount();
		try {
			await waitFor(() => expect(pane.result.current.busy).toBe(false));
			if (!restored) await act(() => pane.result.current.create());
			expect(pane.result.current.error).toMatchObject({
				code: code,
			});
			expect(f.api.updateParameters).toHaveBeenLastCalledWith({
				browserBinding:
					mode === "unbound"
						? undefined
						: {
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
			expect(creates[1].route).toEqual({
				kind: "exact",
				authority: mode === "unbound" ? otherRoute : route,
			});
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
			workspaceId: null,
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

it("does not let an old catalog failure clear a newer reconnect", async () => {
	const old = deferred<unknown>();
	const latest = deferred<unknown>();
	let count = 0;
	const f = fixture(undefined, async (body) => {
		if (body.kind === "list")
			return ++count === 1 ? old.promise : latest.promise;
		throw Error(`Unexpected request ${body.kind}`);
	});
	const pane = f.mount();
	try {
		await waitFor(() => expect(count).toBe(1));
		act(() => pane.result.current.reconnect());
		await waitFor(() => expect(count).toBe(2));
		await act(async () => {
			old.reject(Error("old catalog unavailable"));
		});
		expect(pane.result.current.busy).toBe(true);
		expect(pane.result.current.error).toBeUndefined();
		await act(async () => {
			latest.resolve({ resources: [] });
		});
		expect(pane.result.current.busy).toBe(false);
		expect(pane.result.current.connected).toBe(true);
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
	const respondFromFixture = mocks.invoke.getMockImplementation()!;
	mocks.invoke.mockImplementation(async (command, args) => {
		if (command === "dure_backend_route_assert") {
			if (args.route.kind === "exact") throw obsoleteRouteError;
			expect(args.route.profileId).toBe(route.profileId);
			return currentRoute;
		}
		return respondFromFixture(command, args);
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
		expect(pane.result.current.resources).toEqual([]);
		expect(pane.result.current.error).toBeUndefined();
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
		workspaceId: null,
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
		if (body.kind === "list") {
			if (fail) throw new Error("catalog interrupted");
			return { resources: [] };
		}
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

function liveRouteFixture(rejectObservation = false) {
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			naturalWidth = 400;
			naturalHeight = 600;
			async decode() {}
		},
	);
	const params = {
		url: "https://www.dureai.dev/",
		browserBinding: { authority: route, resource, pageId: "page:selected" },
	};
	let currentRoute = route;
	let currentControl: BrowserControlProjection = { ...control, phase: "ready" };
	const page = { resource, page_id: "page:selected", document_revision: "1" };
	const f = fixture(params, async (body) => {
		if (body.kind === "list")
			return {
				workspace_id: resource.workspace_id,
				resources:
					currentRoute.backend.generation === route.backend.generation
						? [control]
						: [],
			};
		if (body.kind === "observe") {
			if (rejectObservation) throw obsoleteRouteError;
			return {
				control: currentControl,
				pages: [
					{ page, url: params.url, title: "Browser", profile_id: "default" },
				],
			};
		}
		if (body.kind === "frame")
			return {
				page,
				mimeType: "image/jpeg",
				base64: "aW1hZ2U=",
				viewport: { width: 400, height: 600, pixel_ratio: 1 },
			};
		if (body.kind === "control_state") return currentControl;
		if (body.kind === "action")
			return {
				control: { ...currentControl, revision: "3", keyboard: undefined },
				response: { success: true },
				observation: null,
			};
		throw Error(`Unexpected request ${body.kind}`);
	});
	const respond = mocks.invoke.getMockImplementation()!;
	mocks.invoke.mockImplementation(async (command, args) => {
		if (
			args.route.kind === "exact" &&
			args.route.authority.revision !== currentRoute.revision
		)
			throw obsoleteRouteError;
		if (command === "dure_backend_route_assert") return currentRoute;
		return respond(command, args);
	});
	return {
		...f,
		params,
		setControl: (next: BrowserControlProjection) => {
			currentControl = next;
		},
		changeRoute: (next: typeof route) => {
			currentRoute = next;
		},
	};
}

it("automatically reconnects a mounted browser after its backend restarts", async () => {
	const f = liveRouteFixture();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.session).toBeDefined());
		const old = pane.result.current.session!;
		f.changeRoute(restartedRoute);
		await act(() => old.refresh());
		await waitFor(() =>
			expect(f.params.browserBinding).toEqual({
				authority: restartedRoute,
				workspaceId: resource.workspace_id,
			}),
		);
		expect(pane.result.current.connected).toBe(true);
		expect(pane.result.current.session).toBeUndefined();
		expect(pane.result.current.error).toBeUndefined();
		expect(pane.result.current.view.error).toBeUndefined();
		expect(f.requests("list").slice(-1)[0]?.route.authority).toEqual(
			restartedRoute,
		);
		for (const kind of ["create", "control_state", "action", "close"])
			expect(f.requests(kind)).toHaveLength(0);
	} finally {
		pane.unmount();
	}
});

it("releases this view's surviving held keys on the new route without replaying input", async () => {
	const f = liveRouteFixture();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.session).toBeDefined());
		const old = pane.result.current.session!;
		const page = { resource, page_id: "page:selected", document_revision: "1" };
		f.setControl({
			...control,
			phase: "ready",
			revision: "2",
			current_page: page,
			controller: {
				resource,
				controller_id: pane.result.current.controllerId,
				epoch: "1",
			},
			keyboard: { page, keys: ["ShiftLeft"] },
		});
		const updated = { ...route, revision: restartedRoute.revision };
		f.changeRoute(updated);
		await act(() => old.refresh());
		expect(pane.result.current.error).toBeUndefined();
		await waitFor(() =>
			expect(f.params.browserBinding.authority).toEqual(updated),
		);
		expect(f.requests("action")).toHaveLength(1);
		expect(f.requests("action")[0].route.authority).toEqual(updated);
		expect(f.requests("action")[0].body.action).toEqual({
			kind: "key_up",
			key: "ShiftLeft",
		});
		expect(pane.result.current.error).toBeUndefined();
		expect(pane.result.current.view.error).toBeUndefined();
	} finally {
		pane.unmount();
	}
});

it("automatically refreshes the route while retaining a surviving browser and selected page", async () => {
	const f = liveRouteFixture();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.session).toBeDefined());
		const old = pane.result.current.session!;
		const updated = { ...route, revision: restartedRoute.revision };
		f.changeRoute(updated);
		await act(() => old.refresh());
		await waitFor(() =>
			expect(f.params.browserBinding.authority).toEqual(updated),
		);
		expect(pane.result.current.session).not.toBe(old);
		expect(pane.result.current.session?.resource).toEqual(resource);
		expect(f.params.browserBinding.pageId).toBe("page:selected");
		expect(pane.result.current.error).toBeUndefined();
		expect(pane.result.current.view.error).toBeUndefined();
		for (const kind of ["create", "control_state", "action", "close"])
			expect(f.requests(kind)).toHaveLength(0);
	} finally {
		pane.unmount();
	}
});

it("does not automatically attach a mounted browser to a different backend", async () => {
	const f = liveRouteFixture();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.session).toBeDefined());
		const old = pane.result.current.session!;
		const saved = f.params.browserBinding;
		f.changeRoute(otherRoute);
		await act(() => old.refresh());
		await waitFor(() => expect(pane.result.current.error).toBeDefined());
		expect(pane.result.current.connected).toBe(false);
		expect(pane.result.current.session).toBeUndefined();
		expect(f.params.browserBinding).toBe(saved);
		expect(f.requests("list")).toHaveLength(1);
	} finally {
		pane.unmount();
	}
});

it("bounds automatic recovery when the resolved authority is still rejected and retains manual reconnect", async () => {
	const f = liveRouteFixture(true);
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.session).toBeDefined());
		const first = pane.result.current.session!;
		await act(() => first.refresh());
		await waitFor(() => {
			expect(pane.result.current.session).toBeDefined();
			expect(pane.result.current.session).not.toBe(first);
		});
		const second = pane.result.current.session!;
		await act(() => second.refresh());
		expect(pane.result.current.session).toBe(second);
		expect(pane.result.current.view.error).toBeDefined();
		expect(f.requests("list")).toHaveLength(2);
		act(() => pane.result.current.reconnect());
		await waitFor(() => {
			expect(pane.result.current.session).toBeDefined();
			expect(pane.result.current.session).not.toBe(second);
		});
		expect(f.requests("list")).toHaveLength(3);
	} finally {
		pane.unmount();
	}
});

it("keeps an uncertain Create on its exact route when a mounted browser connection changes", async () => {
	const f = liveRouteFixture();
	const pane = f.mount();
	try {
		await waitFor(() => expect(pane.result.current.session).toBeDefined());
		const attached = pane.result.current.session;
		f.changeRoute(restartedRoute);
		await act(() => pane.result.current.create());
		expect(pane.result.current.error).toBeDefined();
		expect(pane.result.current.session).toBe(attached);
		expect(f.params).toHaveProperty("browserCreation.authority", route);
		expect(f.requests("create")).toHaveLength(1);
		expect(f.requests("list")).toHaveLength(1);
	} finally {
		pane.unmount();
	}
});
