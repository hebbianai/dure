// @vitest-environment jsdom
import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { showToast } from "@/lib/toast";
import {
	invokePaneAction,
	paneActionSnapshot,
} from "@/lib/workspace/pane/paneActionRegistry";
import { ProBrowserPanel } from "./ProBrowserPanel";
import { useProBrowserPane } from "./useProBrowserPane";

const mocks = vi.hoisted(() => ({
	client: vi.fn(),
	route: vi.fn(),
	active: true,
	revealed: true,
}));
vi.mock("@/lib/ipc/dureBrowser", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureBrowser")>()),
	createDureBrowserClient: mocks.client,
}));
vi.mock("@/lib/ipc/dureBackend", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureBackend")>()),
	assertDureBackendRouteAuthority: mocks.route,
	resolveSelectedDureBackendRouteAuthority: mocks.route,
}));
vi.mock("@/components/workspace/usePaneFirstReveal", () => ({
	usePaneFirstReveal: () => mocks.revealed,
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeActive: () => mocks.active,
}));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

const authority = {
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
const other = {
	...resource,
	resource_id: "browser:two",
	workspace_id: "workspace:two",
};
const page = (selected = resource, id = "page:one") => ({
	resource: selected,
	page_id: id,
	document_revision: "1",
});
type Props = Parameters<typeof useProBrowserPane>[0];

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
	Element.prototype,
	"scrollIntoView",
);
afterEach(() => {
	mocks.active = true;
	mocks.revealed = true;
	vi.useRealTimers();
	if (scrollIntoViewDescriptor)
		Object.defineProperty(
			Element.prototype,
			"scrollIntoView",
			scrollIntoViewDescriptor,
		);
	else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
function fixture() {
	// jsdom has no layout scrolling; selection and keyboard events remain real.
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	const control = vi.fn(async (selected: typeof resource) =>
		projection(selected),
	);
	const requestControl = vi.fn();
	const action = vi.fn();
	const client = {
		create: vi.fn(),
		list: vi.fn(async () => [projection(resource), projection(other)]),
		observe: vi.fn(async (selected: typeof resource) => ({
			control: projection(selected),
			pages: ["page:one", "page:two"].map((id) => ({
				page: page(selected, id),
				url: "about:blank",
				title: id,
				profile_id: "default",
			})),
		})),
		frame: vi.fn(async (selected: ReturnType<typeof page>) => ({
			page: selected,
			mimeType: "image/jpeg",
			base64: "aW1hZ2U=",
			viewport: { width: 400, height: 600, pixel_ratio: 1 },
		})),
		control,
		action,
		requestControl,
		close: vi.fn(async () => {}),
	};
	mocks.client.mockReturnValue(client);
	mocks.route.mockImplementation(async (value) => value ?? authority);
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			naturalWidth = 400;
			naturalHeight = 600;
			async decode() {}
		},
	);
	const api = {
		id: "browser:main",
		isVisible: true,
		setTitle: vi.fn(),
		updateParameters: vi.fn(),
		onDidVisibilityChange: () => ({ dispose() {} }),
	};
	const props = (
		selected = resource,
		pageId = "page:one",
		followCurrent = false,
	): Props =>
		({
			api,
			params: {
				url: "about:blank",
				browserBinding: {
					authority,
					workspaceId: selected.workspace_id,
					resource: selected,
					pageId,
					followCurrent,
				},
			},
		}) as unknown as IDockviewPanelProps<{ url: string }>;
	return { api, client, props };
}
function projection(selected: typeof resource) {
	return {
		resource: selected,
		current_page: page(selected),
		controller: {
			resource: selected,
			controller_id: "agent:owner",
			epoch: "3",
		},
		revision: "4",
		phase: "ready",
		requested_controller: null,
		in_flight: null,
		next_command_sequence: "5",
	};
}

it("preserves the handback failure and saved resource while reconnecting", async () => {
	const f = fixture();
	mocks.active = false;
	const failure = new DureBackendRequestError(
		"browser_resource_unavailable",
		"Browser resource is unavailable",
		{ kind: "operation", disposition: "terminal" },
	);
	f.client.requestControl.mockRejectedValueOnce(failure);
	const mounted = render(<ProBrowserPanel {...f.props()} />);
	try {
		await waitFor(() =>
			expect(paneActionSnapshot(f.api.id)?.status).toBe("attached"),
		);
		let result: Awaited<ReturnType<typeof invokePaneAction>> | undefined;
		await act(async () => {
			result = await invokePaneAction(
				f.api.id,
				"take-control",
				paneActionSnapshot(f.api.id)?.actionDefinitions?.["take-control"]
					.current,
			);
		});
		expect(result).toMatchObject({
			ok: true,
			result: {
				outcome: "failed",
				error: {
					code: "browser_resource_unavailable",
					retryable: false,
					nextAction: expect.stringContaining("reconnect"),
				},
			},
		});
		expect(JSON.parse(paneActionSnapshot(f.api.id)!.context!)).toMatchObject({
			resource,
			failure: {
				code: "browser_resource_unavailable",
				kind: "operation",
				disposition: "terminal",
			},
		});
		let finish!: (rows: ReturnType<typeof projection>[]) => void;
		f.client.list.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await act(async () => {
			await invokePaneAction(f.api.id, "reconnect");
		});
		await waitFor(() =>
			expect(paneActionSnapshot(f.api.id)?.status).toBe("connecting"),
		);
		expect(JSON.parse(paneActionSnapshot(f.api.id)!.context!)).toMatchObject({
			resource,
		});
		await act(async () => finish([]));
		await waitFor(() =>
			expect(paneActionSnapshot(f.api.id)?.status).toBe("error"),
		);
		expect(JSON.parse(paneActionSnapshot(f.api.id)!.context!)).toMatchObject({
			resource,
			failure: { code: "browser_saved_resource_missing" },
		});
		expect(f.client.requestControl).toHaveBeenCalledTimes(1);
		expect(f.client.create).not.toHaveBeenCalled();
		expect(f.client.close).not.toHaveBeenCalled();
	} finally {
		mounted.unmount();
	}
});

it("reports a changed controller and clears that failure after a fresh exact handback", async () => {
	const f = fixture();
	mocks.active = false;
	const mounted = render(<ProBrowserPanel {...f.props()} />);
	try {
		await waitFor(() =>
			expect(paneActionSnapshot(f.api.id)?.status).toBe("attached"),
		);
		const stale = paneActionSnapshot(f.api.id)!.actionDefinitions![
			"take-control"
		].current;
		let current = {
			...projection(resource),
			revision: "5",
			controller: {
				...projection(resource).controller,
				epoch: "4",
				controller_id: "agent:new",
			},
		};
		f.client.control.mockImplementation(async () => current);
		f.client.observe.mockImplementation(async () => ({
			control: current,
			pages: [
				{
					page: page(),
					url: "about:blank",
					title: "",
					profile_id: "default",
				},
			],
		}));
		let result: Awaited<ReturnType<typeof invokePaneAction>> | undefined;
		await act(async () => {
			result = await invokePaneAction(f.api.id, "take-control", stale);
		});
		expect(result).toMatchObject({
			ok: true,
			result: {
				outcome: "failed",
				error: { code: "browser_controller_changed", retryable: false },
			},
		});
		expect(f.client.requestControl).not.toHaveBeenCalled();
		f.client.requestControl.mockImplementation(
			async (_resource, controllerId, expected) => {
				expect(expected).toEqual(current.controller);
				current = {
					...current,
					revision: "6",
					controller: {
						...current.controller,
						controller_id: controllerId,
						epoch: "5",
					},
				};
				return current;
			},
		);
		await act(async () => {
			result = await invokePaneAction(
				f.api.id,
				"take-control",
				paneActionSnapshot(f.api.id)!.actionDefinitions!["take-control"]
					.current,
			);
		});
		expect(result).toMatchObject({ ok: true, result: { outcome: "applied" } });
		expect(paneActionSnapshot(f.api.id)?.status).toBe("attached");
		expect(paneActionSnapshot(f.api.id)?.error).toBeUndefined();
		expect(f.client.requestControl).toHaveBeenCalledTimes(1);
		expect(f.client.create).not.toHaveBeenCalled();
		const owned = paneActionSnapshot(f.api.id)!.actionDefinitions![
			"take-control"
		].current;
		current = {
			...current,
			revision: "7",
			controller: {
				...current.controller,
				controller_id: "agent:new",
				epoch: "6",
			},
		};
		await act(async () => {
			result = await invokePaneAction(f.api.id, "take-control", owned);
		});
		expect(result).toMatchObject({
			ok: true,
			result: {
				outcome: "failed",
				error: { code: "browser_controller_changed" },
			},
		});
		expect(f.client.requestControl).toHaveBeenCalledTimes(1);
	} finally {
		mounted.unmount();
	}
});

it("binds a browser before its Space is first revealed without capturing or taking control", async () => {
	const f = fixture();
	mocks.active = false;
	mocks.revealed = false;
	const mounted = render(
		<ProBrowserPanel {...f.props(resource, "page:two")} />,
	);
	try {
		await waitFor(() => {
			const state = paneActionSnapshot(f.api.id)!;
			expect(state.status).toBe("attached");
			expect(JSON.parse(state.context!)).toMatchObject({
				resource,
				page: page(resource, "page:two"),
				controller: projection(resource).controller,
			});
			expect(
				state.actionDefinitions!["take-control"].unavailable,
			).toBeUndefined();
		});
		expect(f.client.observe).toHaveBeenCalledTimes(1);
		expect(f.client.frame).not.toHaveBeenCalled();
		expect(f.client.create).not.toHaveBeenCalled();
		expect(f.client.requestControl).not.toHaveBeenCalled();
		expect(f.client.action).not.toHaveBeenCalled();
		mocks.active = true;
		mocks.revealed = true;
		mounted.rerender(<ProBrowserPanel {...f.props(resource, "page:two")} />);
		await waitFor(() => expect(f.client.frame).toHaveBeenCalled());
		expect(f.client.list).toHaveBeenCalledTimes(1);
	} finally {
		mounted.unmount();
	}
});

it.each([false, true])(
	"defers a hidden pane, then connects when an external binding arrives (pending create: %s)",
	async (pending) => {
		const f = fixture();
		mocks.active = false;
		mocks.revealed = false;
		const hook = renderHook(useProBrowserPane, {
			initialProps: {
				...f.props(),
				params: {
					url: "about:blank",
					...(pending
						? {
								browserCreation: {
									authority,
									workspaceId: null,
									operationId: "create:hidden",
								},
							}
						: {}),
				},
			} as Props,
		});
		try {
			await act(async () => {});
			expect(f.client.list).not.toHaveBeenCalled();
			hook.rerender(f.props());
			await waitFor(() =>
				expect(hook.result.current.view.page).toEqual(page()),
			);
			const session = hook.result.current.session;
			hook.rerender(f.props(resource, "page:two"));
			await waitFor(() =>
				expect(hook.result.current.view.page).toEqual(
					page(resource, "page:two"),
				),
			);
			expect(f.client.frame).not.toHaveBeenCalled();
			mocks.active = true;
			mocks.revealed = true;
			hook.rerender(f.props(resource, "page:two"));
			await waitFor(() => expect(hook.result.current.view.frame).toBeDefined());
			expect(hook.result.current.session).toBe(session);
			expect(f.client.list).toHaveBeenCalledTimes(1);
			expect(f.client.create).not.toHaveBeenCalled();
		} finally {
			hook.unmount();
		}
	},
);

it("discards a manual connection when a never-revealed pane unmounts", async () => {
	const f = fixture();
	mocks.active = false;
	mocks.revealed = false;
	let finish!: (rows: ReturnType<typeof projection>[]) => void;
	f.client.list.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const hook = renderHook(useProBrowserPane, {
		initialProps: { ...f.props(), params: { url: "about:blank" } } as Props,
	});
	act(() => hook.result.current.reconnect());
	await waitFor(() => expect(f.client.list).toHaveBeenCalledTimes(1));
	hook.unmount();
	await act(async () => finish([projection(resource)]));
	expect(f.client.observe).not.toHaveBeenCalled();
	expect(f.api.updateParameters).not.toHaveBeenCalled();
});

it("changes Spaces without a release warning when an idle browser loses its backend", async () => {
	const f = fixture();
	const props = f.props();
	const hook = renderHook(useProBrowserPane, { initialProps: props });
	try {
		await waitFor(() => expect(hook.result.current.view.frame).toBeDefined());
		f.client.observe.mockImplementation(async (selected) => ({
			control: {
				...projection(selected),
				revision: "5",
				controller: {
					resource: selected,
					controller_id: hook.result.current.controllerId,
					epoch: "4",
				},
			},
			pages: [
				{
					page: page(selected),
					url: "about:blank",
					title: "",
					profile_id: "default",
				},
			],
		}));
		await act(() => hook.result.current.session!.refresh());
		await waitFor(() =>
			expect(hook.result.current.view.control?.controller?.controller_id).toBe(
				hook.result.current.controllerId,
			),
		);
		f.client.control.mockRejectedValue(new Error("backend restarted"));
		for (let attempt = 0; attempt < 3; attempt++) {
			mocks.active = false;
			await act(async () => hook.rerender(props));
			mocks.active = true;
			await act(async () => hook.rerender(props));
		}
		hook.unmount();
		await act(async () => {});
		expect(showToast).not.toHaveBeenCalled();
		expect(f.client.control).not.toHaveBeenCalled();
	} finally {
		hook.unmount();
	}
});

it("shows current URLs in a focused address field until its value is edited", async () => {
	const f = fixture();
	let url = "https://www.dureai.dev/";
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.client.observe.mockImplementation(async (selected) => {
		await ready;
		return {
			control: projection(selected),
			pages: [{ page: page(selected), url, title: url, profile_id: "default" }],
		};
	});
	const view = render(<ProBrowserPanel {...f.props()} />);
	try {
		const address = screen.getByRole("textbox", {
			name: "panels.browser.address",
		}) as HTMLInputElement;
		await waitFor(() => expect(f.client.observe).toHaveBeenCalled());
		fireEvent.focus(address);
		await act(async () => release());
		await waitFor(() => expect(f.api.setTitle).toHaveBeenCalledWith(url));
		expect(address.value).toBe(url);
		url = "https://www.dureai.dev/docs";
		await waitFor(() => expect(address.value).toBe(url));
		fireEvent.change(address, { target: { value: "unfinished.example" } });
		url = "https://www.dureai.dev/lab";
		await waitFor(() => expect(f.api.setTitle).toHaveBeenCalledWith(url));
		expect(address.value).toBe("unfinished.example");
		fireEvent.blur(address);
		expect(address.value).toBe(url);
		expect(f.client.action).not.toHaveBeenCalled();
	} finally {
		release();
		view.unmount();
	}
});

it.each(["", "unfinished.example"])(
	"restores the observed URL after leaving the address draft %j",
	async (draft) => {
		const f = fixture();
		const url = "https://www.dureai.dev/";
		f.client.observe.mockImplementation(async (selected) => ({
			control: projection(selected),
			pages: [
				{ page: page(selected), url, title: "Dure", profile_id: "default" },
			],
		}));
		const view = render(<ProBrowserPanel {...f.props()} />);
		try {
			const address = screen.getByRole("textbox", {
				name: "panels.browser.address",
			}) as HTMLInputElement;
			await waitFor(() => expect(address.value).toBe(url));
			fireEvent.focus(address);
			fireEvent.change(address, { target: { value: draft } });
			await waitFor(() => expect(f.api.setTitle).toHaveBeenCalledWith("Dure"));
			expect(address.value).toBe(draft);
			fireEvent.blur(address);
			expect(address.value).toBe(url);
			expect(f.client.action).not.toHaveBeenCalled();
		} finally {
			view.unmount();
		}
	},
);

it("captures continuously within the display cadence without overlapping or polling hidden panes", async () => {
	vi.useFakeTimers();
	const f = fixture();
	const starts: number[] = [];
	f.client.frame.mockImplementation(async (selected) => {
		starts.push(Date.now());
		await new Promise((resolve) => setTimeout(resolve, 65));
		return {
			page: selected,
			mimeType: "image/jpeg",
			base64: "aW1hZ2U=",
			viewport: { width: 400, height: 600, pixel_ratio: 1 },
		};
	});
	const visibility = vi.spyOn(document, "visibilityState", "get");
	visibility.mockReturnValue("visible");
	const hook = renderHook(useProBrowserPane, { initialProps: f.props() });
	try {
		await act(async () => vi.advanceTimersByTimeAsync(0));
		expect(starts).toHaveLength(1);
		await act(async () => vi.advanceTimersByTimeAsync(82));
		expect(starts).toHaveLength(2);
		expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(65);
		expect(starts[1] - starts[0]).toBeLessThanOrEqual(66);
		await act(async () => vi.advanceTimersByTimeAsync(15));
		expect(starts).toHaveLength(2);
		visibility.mockReturnValue("hidden");
		fireEvent(document, new Event("visibilitychange"));
		await act(async () => vi.advanceTimersByTimeAsync(200));
		expect(starts).toHaveLength(2);
		visibility.mockReturnValue("visible");
		fireEvent(document, new Event("visibilitychange"));
		await act(async () => vi.advanceTimersByTimeAsync(0));
		expect(starts).toHaveLength(3);
		hook.unmount();
		await act(async () => vi.advanceTimersByTimeAsync(200));
		expect(starts).toHaveLength(3);
	} finally {
		hook.unmount();
		visibility.mockRestore();
	}
});

it("adopts an externally requested page in the existing session and ignores its own persistence echo", async () => {
	const f = fixture();
	const hook = renderHook(useProBrowserPane, { initialProps: f.props() });
	await waitFor(() =>
		expect(hook.result.current.view.frame?.capture.page).toEqual(page()),
	);
	const session = hook.result.current.session;
	hook.rerender(f.props(resource, "page:two"));
	await waitFor(() =>
		expect(hook.result.current.view.frame?.capture.page).toEqual(
			page(resource, "page:two"),
		),
	);
	expect(hook.result.current.session).toBe(session);
	expect(hook.result.current.view.control).toEqual(projection(resource));
	await act(async () => hook.result.current.selectPage(""));
	await waitFor(() =>
		expect(hook.result.current.view.followingCurrent).toBe(true),
	);
	const persisted =
		f.api.updateParameters.mock.calls[
			f.api.updateParameters.mock.calls.length - 1
		]![0];
	hook.rerender({ ...f.props(), params: { url: "about:blank", ...persisted } });
	await waitFor(() =>
		expect(hook.result.current.view.frame?.capture.page).toEqual(page()),
	);
	expect(hook.result.current.session).toBe(session);
	expect(f.client.requestControl).not.toHaveBeenCalled();
	expect(f.client.action).not.toHaveBeenCalled();
	hook.unmount();
});

it("revalidates an external resource binding and never renders a frame from the previous resource", async () => {
	const f = fixture();
	const hook = renderHook(useProBrowserPane, { initialProps: f.props() });
	await waitFor(() =>
		expect(hook.result.current.view.frame?.capture.page).toEqual(page()),
	);
	const first = hook.result.current.session;
	hook.rerender(f.props(other, "page:two"));
	await waitFor(() =>
		expect(hook.result.current.view.frame?.capture.page).toEqual(
			page(other, "page:two"),
		),
	);
	expect(hook.result.current.session).not.toBe(first);
	expect(hook.result.current.session?.resource.workspace_id).toBe(
		other.workspace_id,
	);
	expect(mocks.route).toHaveBeenCalledTimes(2);
	expect(f.client.requestControl).not.toHaveBeenCalled();
	expect(f.client.action).not.toHaveBeenCalled();
	hook.unmount();
});

it("revokes an invalid binding and can recover after valid parameters replace it", async () => {
	const f = fixture();
	const hook = renderHook(useProBrowserPane, { initialProps: f.props() });
	await waitFor(() =>
		expect(hook.result.current.view.frame?.capture.page).toEqual(page()),
	);
	hook.rerender({
		...f.props(),
		params: { url: "about:blank", browserBinding: { resource } },
	});
	await waitFor(() => expect(hook.result.current.error).toBeTruthy());
	expect(hook.result.current.session).toBeUndefined();
	expect(hook.result.current.view.frame).toBeUndefined();
	hook.rerender(f.props(other));
	await waitFor(() =>
		expect(hook.result.current.view.frame?.capture.page).toEqual(page(other)),
	);
	expect(hook.result.current.error).toBeUndefined();
	hook.unmount();
});

async function expectSelectedBrowser(resourceId: string) {
	if (!screen.queryByRole("combobox", { name: "panels.browser.resource" }))
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.options" }),
		);
	const selector = screen.getByRole("combobox", {
		name: "panels.browser.resource",
	});
	fireEvent.keyDown(selector, { key: "ArrowDown" });
	const selected = await screen.findByRole("option", { selected: true });
	expect(selected.getAttribute("data-value")).toBe(resourceId);
	fireEvent.keyDown(selected, { key: "Escape" });
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

it("does not apply an earlier Close confirmation to a newly presented browser", async () => {
	const f = fixture();
	const mounted = render(<ProBrowserPanel {...f.props()} />);
	const closeButtons = () =>
		screen.getAllByRole("button", {
			name: "panels.browser.closeBrowser",
		});
	try {
		await waitFor(() =>
			expect(f.client.observe).toHaveBeenCalledWith(resource),
		);
		await expectSelectedBrowser(resource.resource_id);
		fireEvent.click(closeButtons()[0]);
		const oldConfirmation = closeButtons()[1];
		mounted.rerender(<ProBrowserPanel {...f.props(other)} />);
		await waitFor(() => expect(f.client.observe).toHaveBeenCalledWith(other));
		await expectSelectedBrowser(other.resource_id);
		fireEvent.click(oldConfirmation);
		await act(async () => {});
		expect(f.client.close).not.toHaveBeenCalled();
		expect(screen.queryByText("panels.browser.closeConfirmation")).toBeNull();
		fireEvent.click(closeButtons()[0]);
		fireEvent.click(closeButtons()[1]);
		await waitFor(() =>
			expect(f.client.close).toHaveBeenCalledExactlyOnceWith(
				other,
				expect.any(String),
			),
		);
	} finally {
		mounted.unmount();
	}
});

it("distinguishes a failed catalog load from an empty catalog and reconnects the pane", async () => {
	const f = fixture();
	f.client.list.mockRejectedValueOnce(new Error("connection interrupted"));
	const mounted = render(<ProBrowserPanel {...f.props()} />);
	try {
		await waitFor(() =>
			expect(screen.getByText("ipc.browser.requestFailed")).toBeTruthy(),
		);
		expect(screen.queryByText("panels.browser.noWorkspaces")).toBeNull();
		expect(paneActionSnapshot(f.api.id)).toMatchObject({
			status: "error",
			error: "connection interrupted",
		});
		expect(
			screen.getByRole("button", { name: "panels.browser.reconnect" }),
		).toBeTruthy();
		await act(async () => {
			expect(await invokePaneAction(f.api.id, "reconnect")).toMatchObject({
				ok: true,
				result: { outcome: "pending" },
			});
		});
		await waitFor(() =>
			expect(f.client.observe).toHaveBeenCalledWith(resource),
		);
		await expectSelectedBrowser(resource.resource_id);
		expect(screen.queryByText("ipc.browser.requestFailed")).toBeNull();
		expect(f.client.list).toHaveBeenCalledTimes(2);
	} finally {
		mounted.unmount();
	}
});

it.each(["typed", "initial"])(
	"opens a typed URL from a new pane without selecting a workspace or browser (%s)",
	async (mode) => {
		const f = fixture();
		let controllerId = "";
		let observedUrl = "about:blank";
		let finishNavigation!: () => void;
		const navigation = new Promise<void>((resolve) => {
			finishNavigation = resolve;
		});
		const controlled = () => ({
			...projection(resource),
			controller: controllerId
				? { ...projection(resource).controller, controller_id: controllerId }
				: null,
		});
		f.client.list.mockResolvedValue([]);
		f.client.create.mockImplementation(async () => {
			return controlled();
		});
		f.client.control.mockImplementation(
			async () => controlled() as ReturnType<typeof projection>,
		);
		f.client.requestControl.mockImplementation(async (_resource, id) => {
			controllerId = id;
			return controlled();
		});
		f.client.observe.mockImplementation(async () => ({
			control: controlled() as ReturnType<typeof projection>,
			pages: [
				{ page: page(), url: observedUrl, title: "", profile_id: "default" },
			],
		}));
		f.client.action.mockImplementation(async (_caller, _authority, action) => {
			await navigation;
			observedUrl = `${action.url}/redirected`;
			return {
				control: controlled(),
				response: { success: true, data: {} },
				observation: await f.client.observe(resource),
			};
		});
		const mounted = render(
			<ProBrowserPanel
				{...f.props()}
				params={{ url: mode === "initial" ? "https://example.com" : "" }}
			/>,
		);
		try {
			const address = screen.getByRole("textbox", {
				name: "panels.browser.address",
			});
			await waitFor(() => expect(f.client.list).toHaveBeenCalled());
			if (mode !== "initial") {
				fireEvent.change(address, { target: { value: "example.com" } });
				fireEvent.keyDown(address, { key: "Enter" });
			}
			await waitFor(() =>
				expect(f.client.action).toHaveBeenCalledWith(
					controllerId,
					expect.anything(),
					{ kind: "navigate", url: "https://example.com" },
				),
			);
			expect((address as HTMLInputElement).value).toBe("https://example.com");
			await act(async () => finishNavigation());
			await waitFor(() =>
				expect((address as HTMLInputElement).value).toBe(
					"https://example.com/redirected",
				),
			);
			expect(f.client.create).toHaveBeenCalledExactlyOnceWith(
				expect.any(String),
			);
			fireEvent.change(address, { target: { value: "second.example" } });
			fireEvent.keyDown(address, { key: "Enter" });
			await waitFor(() =>
				expect(f.client.action).toHaveBeenCalledWith(
					controllerId,
					expect.anything(),
					{ kind: "navigate", url: "https://second.example" },
				),
			);
			expect(f.client.create).toHaveBeenCalledTimes(1);
			expect(f.client.list).toHaveBeenCalledExactlyOnceWith();
			expect(f.client.requestControl).toHaveBeenCalledTimes(1);
			expect(f.api.updateParameters).toHaveBeenCalledWith(
				expect.objectContaining({
					browserBinding: expect.objectContaining({
						resource,
						workspaceId: resource.workspace_id,
					}),
				}),
			);
		} finally {
			finishNavigation();
			mounted.unmount();
		}
	},
);

it.each([true, false])("hands back when active=%s", async (active) => {
	const f = fixture();
	let current = projection(resource);
	let viewport = { width: 1280, height: 633, pixel_ratio: 1 };
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			get naturalWidth() {
				return viewport.width;
			}
			get naturalHeight() {
				return viewport.height;
			}
			async decode() {}
		},
	);
	const bounds = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 480,
			bottom: 810,
			width: 480,
			height: 810,
			toJSON() {},
		});
	f.client.control.mockImplementation(async () => current);
	f.client.observe.mockImplementation(async () => ({
		control: current,
		pages: [
			{
				page: page(),
				url: "https://www.dureai.dev/",
				title: "Dure",
				profile_id: "default",
			},
		],
	}));
	f.client.frame.mockImplementation(async () => ({
		page: page(),
		mimeType: "image/jpeg",
		base64: "aW1hZ2U=",
		viewport,
	}));
	f.client.requestControl.mockImplementation(
		async (_resource, controllerId, expected) => {
			expect(expected).toEqual(current.controller);
			current = {
				...current,
				revision: "5",
				controller: {
					...current.controller,
					controller_id: controllerId,
					epoch: "4",
				},
			};
			return current;
		},
	);
	f.client.action.mockImplementation(async (_caller, authority, action) => {
		expect(authority.lease).toEqual(current.controller);
		expect(action.kind).toBe("environment");
		viewport = {
			width: action.action.width,
			height: action.action.height,
			pixel_ratio: action.action.scale,
		};
		current = { ...current, revision: "6", next_command_sequence: "6" };
		return {
			control: current,
			response: { success: true },
			observation: null,
		};
	});
	const mounted = render(<ProBrowserPanel {...f.props()} />);
	try {
		await waitFor(() => expect(f.client.frame).toHaveBeenCalled());
		expect(f.client.action).not.toHaveBeenCalled();
		mocks.active = active;
		mounted.rerender(<ProBrowserPanel {...f.props()} />);
		const snapshot = paneActionSnapshot(f.api.id);
		expect(snapshot?.actions).toContain("take-control");
		let result: Awaited<ReturnType<typeof invokePaneAction>> | undefined;
		await act(async () => {
			result = await invokePaneAction(
				f.api.id,
				"take-control",
				snapshot?.actionDefinitions?.["take-control"].current,
			);
		});
		expect(result).toMatchObject({
			ok: true,
			result: { outcome: "applied" },
		});
		if (!active) {
			expect(f.client.action).not.toHaveBeenCalled();
			mocks.active = true;
			mounted.rerender(<ProBrowserPanel {...f.props()} />);
		}
		await waitFor(() =>
			expect(viewport).toMatchObject({ width: 480, height: 810 }),
		);
		expect(
			await invokePaneAction(
				f.api.id,
				"take-control",
				snapshot?.actionDefinitions?.["take-control"].current,
			),
		).toMatchObject({
			ok: true,
			result: {
				outcome: "refused",
				error: { code: "browser_controller_changed" },
			},
		});
		expect(f.client.requestControl).toHaveBeenCalledTimes(1);
		expect(current.controller.controller_id).toMatch(/^view:/);
	} finally {
		mounted.unmount();
		bounds.mockRestore();
	}
	expect(paneActionSnapshot(f.api.id)).toBeUndefined();
});
