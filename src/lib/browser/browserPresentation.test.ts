// @vitest-environment jsdom
import {
	createDockview,
	type DockviewApi,
	type IDockviewPanel,
} from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { useStore } from "@/store";
import {
	parseBrowserPresentationRequest,
	presentBrowserPage,
} from "./browserPresentation";

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/store", () => ({ useStore: { getState: vi.fn() } }));
const resource = {
	resource_id: "browser:one",
	generation: "generation:one",
	workspace_id: "workspace:one",
};
const authority = {
	schemaVersion: 1 as const,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend:one", generation: "generation:one" },
	target: { source: "local" as const, hostId: "local" },
};
const request = {
	kind: "present" as const,
	schemaVersion: 1 as const,
	backendProfileId: "local",
	backend: authority.backend,
	resource,
	pageId: "page:two",
	spaceId: "space:one",
	windowLabel: "main",
};
function panel(
	id = "browser:main",
	binding = {
		authority,
		resource,
		workspaceId: resource.workspace_id,
		pageId: "page:one",
	},
) {
	return {
		id,
		params: { browserBinding: binding },
		view: { contentComponent: "browser" },
		api: {
			component: "browser",
			getParameters: vi.fn(() => ({})),
			updateParameters: vi.fn(),
		},
	} as unknown as IDockviewPanel;
}
function fixture(panels: IDockviewPanel[] = []) {
	const api = { panels } as DockviewApi;
	const observe = vi.fn(async () => ({
		control: { resource },
		pages: [
			{
				page: { resource, page_id: request.pageId, document_revision: "7" },
				url: "https://example.com/new",
				title: "New",
				profile_id: "default",
			},
		],
	}));
	const runtime = {
		assertSpace: vi.fn(),
		resolveRoute: vi.fn(async () => authority),
		client: vi.fn(() => ({ observe })),
		dockview: vi.fn(() => api),
		prepareSpace: vi.fn(),
		waitForSpace: vi.fn(async () => api),
		open: vi.fn(
			(
				options: Parameters<
					NonNullable<Parameters<typeof presentBrowserPage>[1]>["open"]
				>[0],
			) => {
				const existing = api.panels.find((row) => row.id === options.panelId);
				if (existing) options.onExisting?.(existing);
				return !!existing;
			},
		),
	};
	return {
		api,
		observe,
		runtime: runtime as unknown as NonNullable<
			Parameters<typeof presentBrowserPage>[1]
		>,
		spies: runtime,
	};
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function mounted() {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	api.addPanel({
		id: "sibling",
		component: "terminal",
		params: { sessionId: "retained" },
	});
	cleanups.push(() => {
		api.dispose();
		element.remove();
	});
	const f = fixture();
	f.spies.dockview.mockReturnValue(api);
	f.spies.waitForSpace.mockResolvedValue(api);
	f.spies.open.mockImplementation(openOrFocusPanel);
	return { ...f, api };
}

it("allocates one neutral resource view and reuses its saved pane identity", async () => {
	const f = mounted();
	const result = await presentBrowserPage(request, f.runtime);
	const id = "panelId" in result && result.panelId;
	expect(id).toMatch(/^pane-/);
	expect(f.api.activePanel?.params?.browserPurpose).toBe("resource");
	f.api.fromJSON(f.api.toJSON());
	expect(await presentBrowserPage(request, f.runtime)).toEqual(result);
	expect(f.api.activePanel?.id).toBe(id);
	expect(f.api.panels).toHaveLength(2);
	expect(f.api.getPanel("sibling")?.params).toEqual({ sessionId: "retained" });
});

it("concurrent presentation and replay keep one exact view", async () => {
	const f = mounted();
	const results = await Promise.all([
		presentBrowserPage(request, f.runtime),
		presentBrowserPage(request, f.runtime),
	]);
	expect(results[0]).toEqual(results[1]);
	expect(await presentBrowserPage(request, f.runtime)).toEqual(results[0]);
	expect(f.api.panels).toHaveLength(2);
	expect(f.api.activePanel?.params?.browserPurpose).toBe("resource");
	expect(f.observe).toHaveBeenCalledTimes(3);
});

it("reuses the exact pane after its creation result is interrupted", async () => {
	const f = mounted();
	f.spies.open.mockImplementationOnce((options) => {
		openOrFocusPanel(options);
		throw new Error("fixture_open_result_interrupted");
	});
	await expect(presentBrowserPage(request, f.runtime)).rejects.toThrow(
		"fixture_open_result_interrupted",
	);
	const id = f.api.activePanel!.id;
	expect(await presentBrowserPage(request, f.runtime)).toMatchObject({
		panelId: id,
	});
	expect(f.api.panels).toHaveLength(2);
	expect(f.api.activePanel?.id).toBe(id);
});

it.each(["pane-existing", "browser:main", "launcher:former"])(
	"reuses an exact resource at %s without changing its existing purpose",
	async (id) => {
		const f = mounted();
		const pane = f.api.addPanel({
			id,
			component: "browser",
			params: {
				browserPurpose: "workspace",
				preserved: true,
				browserBinding: {
					authority,
					resource,
					workspaceId: resource.workspace_id,
					pageId: "page:one",
				},
			},
		});
		await presentBrowserPage(request, f.runtime);
		expect(f.api.activePanel).toBe(pane);
		expect(pane.params).toMatchObject({
			browserPurpose: "workspace",
			preserved: true,
			browserBinding: { pageId: request.pageId, followCurrent: false },
		});
		expect(f.api.panels).toHaveLength(2);
	},
);

it("does not retarget changed content when the Browser observation arrives late", async () => {
	const f = mounted();
	const pane = f.api.addPanel({
		id: "browser:main",
		component: "browser",
		params: {
			browserBinding: {
				authority,
				resource,
				workspaceId: resource.workspace_id,
			},
		},
	});
	const observation = await f.observe();
	f.observe.mockClear();
	let finish!: (value: typeof observation) => void;
	f.observe.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const pending = presentBrowserPage(request, f.runtime);
	await vi.waitFor(() => expect(f.observe).toHaveBeenCalledOnce());
	const terminal = f.api.replacePanel(pane.api, {
		component: "terminal",
		params: { ...pane.params, sessionId: "retained" },
	})!;
	const before = { ...terminal.params };
	finish(observation);
	await pending;
	expect(f.api.activePanel).not.toBe(terminal);
	expect(f.api.activePanel?.id).toMatch(/^pane-/);
	expect(terminal.params).toEqual(before);
	expect(f.observe).toHaveBeenCalledOnce();
});

it("uses the mounted resource's pane and requests its page without changing Host control", async () => {
	const existing = panel();
	const f = fixture([existing]);
	const result = await presentBrowserPage(
		parseBrowserPresentationRequest(request),
		f.runtime,
	);
	expect(result).toEqual({
		state: "requested",
		spaceId: request.spaceId,
		windowLabel: request.windowLabel,
		panelId: existing.id,
		resource,
		pageId: request.pageId,
	});
	expect(f.observe).toHaveBeenCalledWith(resource);
	expect(existing.api.updateParameters).toHaveBeenCalledWith({
		url: "https://example.com/new",
		browserBinding: {
			authority,
			resource,
			workspaceId: resource.workspace_id,
			pageId: request.pageId,
			followCurrent: false,
		},
	});
	expect(JSON.stringify(result)).not.toContain(authority.revision);
});

it("creates a distinct pane when this Space has no view of the requested resource", async () => {
	const existing = panel("browser:main", {
		authority,
		resource: { ...resource, resource_id: "browser:peer" },
		workspaceId: resource.workspace_id,
		pageId: "page:one",
	});
	const f = fixture([existing]);
	const result = await presentBrowserPage(request, f.runtime);
	expect("panelId" in result && result.panelId).not.toBe(existing.id);
	expect(existing.api.updateParameters).not.toHaveBeenCalled();
	expect(f.spies.open).toHaveBeenCalledOnce();
});

it("does not pick an arbitrary view when a resource appears twice", async () => {
	const f = fixture([panel(), panel("browser:duplicate")]);
	await expect(presentBrowserPage(request, f.runtime)).rejects.toMatchObject({
		code: "browser_presentation_ambiguous",
	});
	expect(f.spies.open).not.toHaveBeenCalled();
});

it("rejects a replaced backend, resource, missing page or failed observation before changing layout", async () => {
	for (const fault of ["backend", "resource", "page", "observation"]) {
		const f = fixture();
		if (fault === "backend")
			f.spies.resolveRoute.mockResolvedValue({
				...authority,
				backend: { ...authority.backend, generation: "changed" },
			});
		else
			f.observe.mockResolvedValue({
				control: {
					resource:
						fault === "resource"
							? { ...resource, generation: "changed" }
							: resource,
				},
				pages: [],
				...(fault === "observation"
					? { observation_error: "browser_cdp_response_timeout" }
					: {}),
			});
		await expect(presentBrowserPage(request, f.runtime)).rejects.toBeTruthy();
		expect(f.spies.open).not.toHaveBeenCalled();
	}
});

it("revalidates the exact Space and mounted Dockview after asynchronous preparation", async () => {
	const f = fixture();
	f.spies.dockview.mockReturnValueOnce(undefined as unknown as DockviewApi);
	f.spies.waitForSpace.mockImplementation(async () => {
		f.spies.dockview.mockReturnValue({ panels: [] } as unknown as DockviewApi);
		return f.api;
	});
	await expect(presentBrowserPage(request, f.runtime)).rejects.toMatchObject({
		code: "browser_presentation_workspace_changed",
	});
	expect(f.spies.prepareSpace).toHaveBeenCalledWith(request.spaceId);
	expect(f.spies.open).not.toHaveBeenCalled();
});

it("requires complete public identities and rejects route capabilities or unknown inputs", () => {
	for (const invalid of [
		{ ...request, spaceId: "" },
		{ ...request, backendProfileId: "invalid profile" },
		{ ...request, backend: { ...request.backend, token: "secret" } },
		{ ...request, authority },
		{ ...request, resource: { ...resource, generation: "" } },
		{ ...request, windowLabel: "bad/window" },
	]) {
		expect(() => parseBrowserPresentationRequest(invalid)).toThrow();
	}
});

it("prepares the exact Pro Space without opening a pane or requiring a page", async () => {
	const f = fixture([panel()]);
	const { pageId: _page, ...target } = request;
	const prepare = parseBrowserPresentationRequest({
		...target,
		kind: "prepare",
	});
	expect(await presentBrowserPage(prepare, f.runtime)).toEqual({
		state: "ready",
		spaceId: request.spaceId,
		windowLabel: "main",
		resource,
	});
	expect(f.spies.open).not.toHaveBeenCalled();
	expect(f.observe).toHaveBeenCalledOnce();
	expect(() =>
		parseBrowserPresentationRequest({ ...request, kind: "prepare" }),
	).toThrow();
});

it("refuses Pro or window authority failures before reading the Browser", async () => {
	for (const code of [
		"browser_pro_required",
		"browser_presentation_window_changed",
	]) {
		const f = fixture();
		f.spies.assertSpace.mockImplementation(() => {
			throw Object.assign(new Error(code), { code });
		});
		await expect(presentBrowserPage(request, f.runtime)).rejects.toMatchObject({
			code,
		});
		expect(f.spies.resolveRoute).not.toHaveBeenCalled();
		expect(f.observe).not.toHaveBeenCalled();
		expect(f.spies.open).not.toHaveBeenCalled();
	}
});

it("the real presentation entry respects Basic defaults and cannot enable Pro in production", async () => {
	try {
		for (const [storedMode, production] of [
			[undefined, false],
			["basic", false],
			["unknown", false],
			["pro", true],
		] as const) {
			vi.stubEnv("PROD", production);
			vi.mocked(useStore.getState).mockReturnValue({
				uiPrefs: { interfaceMode: storedMode },
				spaces: [],
			} as unknown as ReturnType<typeof useStore.getState>);
			await expect(presentBrowserPage(request)).rejects.toMatchObject({
				code: "browser_pro_required",
			});
		}
	} finally {
		vi.unstubAllEnvs();
	}
});
