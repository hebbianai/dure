// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserPanel } from "@/components/panels/BrowserPanel";
import { chooseSelectValue } from "@/test/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/workspace/usePaneFirstReveal", () => ({
	usePaneFirstReveal: () => true,
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeActive: () => true,
}));
vi.mock("@/lib/workspace/pane/paneTitleOverrideStore", () => ({
	applyAutomaticPaneTitle: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	mocks.invoke.mockReset();
});

it.each([
	["list", "browser_pro_development_only", "ipc.browser.developmentRequired"],
	["list", "unknown_backend_error", "ipc.browser.requestFailed"],
	["create", "browser_engine_not_installed", "ipc.browser.runtimeRequired"],
])(
	"presents %s failure %s and retains explicit recovery",
	async (kind, code, message) => {
		vi.stubEnv("PROD", true);
		const route = {
			schemaVersion: 1,
			profileId: "local",
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: "backend:one", generation: "generation:one" },
			target: { source: "local", hostId: "local" },
		};
		const workspaceId = "workspace:actual";
		const requests: string[] = [];
		let unavailable = true;
		mocks.invoke.mockImplementation(async (command, args) => {
			if (command === "dure_backend_route_assert") return route;
			expect(command).toBe("dure_backend_request");
			expect(args.route).toEqual({ kind: "exact", authority: route });
			requests.push(args.body.kind);
			if (unavailable && args.body.kind === kind) {
				throw {
					code,
					message: "Untrusted backend diagnostic",
					details: { disposition: "terminal" },
				};
			}
			expect(["workspaces", "list"]).toContain(args.body.kind);
			return {
				schemaVersion: 1,
				backendId: route.backend.id,
				backendGeneration: route.backend.generation,
				routeAuthority: route,
				result: {
					schemaVersion: 1,
					operation_id: null,
					replayed: false,
					result:
						args.body.kind === "workspaces"
							? {
									workspaces: [
										{
											workspace_id: workspaceId,
											project_name: "Project",
											root_path: "/tmp/project",
										},
									],
									next: null,
								}
							: { resources: [] },
				},
			};
		});
		const api = {
			id: "browser:main",
			isVisible: true,
			updateParameters: vi.fn(),
			onDidVisibilityChange: () => ({ dispose() {} }),
		};
		const mounted = render(
			<BrowserPanel
				{...({
					api,
					params: {
						url: "about:blank",
						browserBinding: { authority: route, workspaceId },
					},
				} as unknown as IDockviewPanelProps<{ url: string }>)}
			/>,
		);
		try {
			fireEvent.click(
				screen.getByRole("button", { name: "panels.browser.options" }),
			);
			if (kind === "create") {
				await waitFor(() =>
					expect(
						screen.getByRole("button", { name: "panels.browser.newBrowser" }),
					).toHaveProperty("disabled", false),
				);
				fireEvent.click(
					screen.getByRole("button", { name: "panels.browser.newBrowser" }),
				);
			}
			expect((await screen.findByRole("alert")).textContent).toBe(message);
			if (code === "browser_engine_not_installed")
				expect(
					screen.getByRole("button", { name: "panels.browser.installRuntime" }),
				).toHaveProperty("disabled", false);
			expect(screen.queryByText("Untrusted backend diagnostic")).toBeNull();
			expect(requests).toEqual(
				kind === "create" ? ["list", "create"] : ["list"],
			);
			if (kind === "list") {
				unavailable = false;
				fireEvent.click(
					screen.getByRole("button", { name: "panels.browser.reconnect" }),
				);
				await waitFor(() =>
					expect(
						screen.getByRole("button", { name: "panels.browser.newBrowser" }),
					).toHaveProperty("disabled", false),
				);
				expect(screen.queryByRole("alert")).toBeNull();
				expect(requests).toEqual(["list", "list"]);
				expect(api.updateParameters).not.toHaveBeenCalled();
			}
		} finally {
			mounted.unmount();
		}
	},
);

it.each([false, true])(
	"keeps observer inspection separate, selects with human control, and follows the agent after return and reconnect (delayed: %s)",
	async (delayed) => {
		const route = {
			schemaVersion: 1,
			profileId: "local",
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: "backend:one", generation: "generation:one" },
			target: { source: "local", hostId: "local" },
		};
		const resource = {
			resource_id: "browser:existing",
			generation: "generation:one",
			workspace_id: "workspace:actual",
		};
		const first = { resource, page_id: "page:first", document_revision: "1" };
		const second = { ...first, page_id: "page:second" };
		const pages = [first, second].map((page) => ({
			page,
			url: `https://example.com/${page.page_id}`,
			title: page.page_id,
			profile_id: "default",
		}));
		let control = {
			resource,
			revision: "1",
			phase: "ready",
			current_page: first,
			controller: { resource, controller_id: "controller:agent", epoch: "1" },
			requested_controller: null as string | null,
			in_flight: null as string | null,
			next_command_sequence: "8",
		};
		const grant = (controllerId: string) => {
			control = {
				...control,
				revision: String(BigInt(control.revision) + 1n),
				controller: {
					...control.controller,
					controller_id: controllerId,
					epoch: String(BigInt(control.controller.epoch) + 1n),
				},
				requested_controller: null,
				in_flight: null,
			};
		};
		let observationUnavailable = false;
		const observation = () => ({ control, pages });
		const inputs: {
			authority: { page: typeof first };
			action: { kind: string };
		}[] = [];
		mocks.invoke.mockImplementation(async (command, args) => {
			if (command === "dure_backend_route_assert") return route;
			expect(command).toBe("dure_backend_request");
			expect(args.route).toEqual({ kind: "exact", authority: route });
			const body = args.body;
			let result: unknown;
			switch (body.kind) {
				case "workspaces":
					result = {
						workspaces: [
							{
								workspace_id: resource.workspace_id,
								project_name: "Project",
								root_path: "/tmp/project",
							},
						],
						next: null,
					};
					break;
				case "list":
					result = {
						workspace_id: resource.workspace_id,
						resources: [control],
					};
					break;
				case "observe":
					if (observationUnavailable)
						throw new Error("Fixture observation disconnected");
					result = observation();
					break;
				case "control_state":
					result = control;
					break;
				case "frame":
					result = {
						page: body.page,
						mimeType: "image/jpeg",
						base64: "/9j/2Q==",
						viewport: { width: 400, height: 600, pixel_ratio: 1 },
					};
					break;
				case "control":
					expect(body.expected).toEqual(control.controller);
					if (delayed)
						control = {
							...control,
							revision: String(BigInt(control.revision) + 1n),
							requested_controller: body.controller_id,
						};
					else grant(body.controller_id);
					result = control;
					break;
				case "action":
					expect(body.authority.lease).toEqual(control.controller);
					expect(body.authority.command_sequence).toBe(
						control.next_command_sequence,
					);
					inputs.push(body);
					control = {
						...control,
						revision: String(BigInt(control.revision) + 1n),
						next_command_sequence: String(
							BigInt(control.next_command_sequence) + 1n,
						),
						current_page: body.authority.page,
					};
					result = {
						response: { success: true },
						control,
						observation: observation(),
					};
					break;
				default:
					throw new Error(`Unexpected Browser request: ${body.kind}`);
			}
			return {
				schemaVersion: 1,
				backendId: route.backend.id,
				backendGeneration: route.backend.generation,
				routeAuthority: route,
				result: {
					schemaVersion: 1,
					operation_id:
						body.operation_id ?? body.authority?.operation_id ?? null,
					replayed: false,
					result,
				},
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
		const api = {
			id: "browser:main",
			isVisible: true,
			updateParameters: vi.fn(),
			onDidVisibilityChange: () => ({ dispose() {} }),
		};
		let mounted = render(
			<BrowserPanel
				{...({
					api,
					params: {
						url: pages[0].url,
						browserBinding: {
							authority: route,
							workspaceId: resource.workspace_id,
							resource,
							pageId: first.page_id,
						},
					},
				} as unknown as IDockviewPanelProps<{ url: string }>)}
			/>,
		);
		const pageSelect = () =>
			screen.getByRole("combobox", { name: "panels.browser.page" });
		const address = () =>
			screen.getByRole("textbox", { name: "panels.browser.address" });
		try {
			await screen.findByRole("combobox", { name: "panels.browser.page" });
			await waitFor(() => expect(pageSelect().textContent).toBe(first.page_id));
			chooseSelectValue(pageSelect(), second.page_id);
			await waitFor(() =>
				expect(address()).toHaveProperty("value", pages[1].url),
			);
			expect(inputs).toEqual([]);
			expect(control.current_page).toEqual(first);
			if (delayed) control = { ...control, in_flight: "operation:agent" };
			fireEvent.click(
				screen.getByRole("button", { name: "panels.browser.takeControl" }),
			);
			if (delayed) {
				await screen.findByText("panels.browser.controlPending");
				expect(inputs).toEqual([]);
				expect(
					screen.getByRole("button", { name: "panels.browser.takeControl" }),
				).toHaveProperty("disabled", true);
				grant(control.requested_controller!);
			}
			await screen.findByText("panels.browser.youControl");
			await waitFor(() =>
				expect(
					inputs.filter((body) => body.action.kind === "select_page"),
				).toHaveLength(1),
			);
			expect(inputs[0].authority.page).toEqual(second);
			expect(control.current_page).toEqual(second);
			chooseSelectValue(pageSelect(), first.page_id);
			await waitFor(() => expect(control.current_page).toEqual(first));
			expect(
				inputs
					.filter((body) => body.action.kind === "select_page")
					.map((body) => body.authority.page),
			).toEqual([second, first]);
			if (delayed) control = { ...control, in_flight: "operation:human" };
			fireEvent.click(
				screen.getByRole("button", { name: "panels.browser.returnControl" }),
			);
			if (delayed) {
				await screen.findByText("panels.browser.controlPending");
				const input = screen.getByRole("textbox", {
					name: "panels.browser.pageInput",
				});
				expect(input).toHaveProperty("readOnly", true);
				expect(
					screen.getByRole("button", { name: "panels.browser.returnControl" }),
				).toHaveProperty("disabled", true);
				fireEvent.compositionEnd(input, { data: "must not be submitted" });
				expect(inputs).toHaveLength(2);
				grant(control.requested_controller!);
			}
			await screen.findByText("panels.browser.otherControl");
			await waitFor(() => {
				const calls = api.updateParameters.mock.calls;
				expect(calls[calls.length - 1]?.[0].browserBinding.followCurrent).toBe(
					true,
				);
			});
			control = {
				...control,
				revision: String(BigInt(control.revision) + 1n),
				current_page: second,
			};
			await waitFor(() =>
				expect(address()).toHaveProperty("value", pages[1].url),
			);
			expect(pageSelect().textContent).toBe("panels.browser.followCurrent");
			observationUnavailable = true;
			await screen.findByRole("alert");
			observationUnavailable = false;
			fireEvent.click(
				screen.getByRole("button", { name: "panels.browser.reconnect" }),
			);
			await waitFor(() =>
				expect(pageSelect().textContent).toBe("panels.browser.followCurrent"),
			);
			control = {
				...control,
				revision: String(BigInt(control.revision) + 1n),
				current_page: first,
			};
			await waitFor(() =>
				expect(address()).toHaveProperty("value", pages[0].url),
			);
			expect(inputs).toHaveLength(2);
			chooseSelectValue(pageSelect(), second.page_id);
			await waitFor(() =>
				expect(address()).toHaveProperty("value", pages[1].url),
			);
			chooseSelectValue(pageSelect(), "");
			await waitFor(() =>
				expect(address()).toHaveProperty("value", pages[0].url),
			);
			expect(control.current_page).toEqual(first);
			expect(inputs).toHaveLength(2);
			await waitFor(() => {
				const calls = api.updateParameters.mock.calls;
				expect(calls[calls.length - 1]?.[0].browserBinding).toMatchObject({
					pageId: first.page_id,
					followCurrent: true,
				});
			});
			const calls = api.updateParameters.mock.calls;
			const saved = calls[calls.length - 1][0];
			mounted.unmount();
			control = {
				...control,
				revision: String(BigInt(control.revision) + 1n),
				current_page: second,
			};
			mounted = render(
				<BrowserPanel
					{...({
						api,
						params: { url: pages[0].url, ...saved },
					} as unknown as IDockviewPanelProps<{ url: string }>)}
				/>,
			);
			await screen.findByRole("combobox", { name: "panels.browser.page" });
			await waitFor(() =>
				expect(address()).toHaveProperty("value", pages[1].url),
			);
			expect(pageSelect().textContent).toBe("panels.browser.followCurrent");
			expect(inputs).toHaveLength(2);
		} finally {
			mounted.unmount();
		}
	},
);

it("attaches a shared Browser, navigates, and persists the newly selected page", async () => {
	const route = {
		schemaVersion: 1,
		profileId: "local",
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "backend:one", generation: "generation:one" },
		target: { source: "local", hostId: "local" },
	};
	const resource = {
		resource_id: "browser:existing",
		generation: "generation:one",
		workspace_id: "workspace:actual",
	};
	const page = { resource, page_id: "page:one", document_revision: "1" };
	const createdPage = { ...page, page_id: "page:created" };
	let releaseObservation!: () => void;
	const observationGate = new Promise<void>((resolve) => {
		releaseObservation = resolve;
	});
	let created = false;
	let pages = [
		{
			page,
			url: "https://example.com",
			title: "Existing page",
			profile_id: "default",
		},
	];
	let control = {
		resource,
		revision: "1",
		phase: "ready",
		controller: { resource, controller_id: "controller:agent", epoch: "1" },
		requested_controller: null,
		in_flight: null,
		next_command_sequence: "8",
		current_page: page,
	};
	const observe = () => ({
		control,
		pages,
	});
	mocks.invoke.mockImplementation(async (command, args) => {
		if (command === "dure_backend_route_assert") return route;
		expect(command).toBe("dure_backend_request");
		expect(args.route).toEqual({ kind: "exact", authority: route });
		const body = args.body;
		let result: unknown;
		switch (body.kind) {
			case "workspaces":
				result = {
					workspaces: [
						{
							workspace_id: "workspace:actual",
							project_name: "Project",
							root_path: "/tmp/project",
						},
					],
					next: null,
				};
				break;
			case "list":
				result = { workspace_id: resource.workspace_id, resources: [control] };
				break;
			case "observe":
				if (created) await observationGate;
				result = observe();
				break;
			case "control_state":
				result = control;
				break;
			case "control":
				expect(body.expected).toEqual(control.controller);
				control = {
					...control,
					revision: "2",
					controller: {
						resource,
						controller_id: body.controller_id,
						epoch: "2",
					},
				};
				result = control;
				break;
			case "frame":
				result = {
					page: body.page,
					mimeType: "image/jpeg",
					base64: "/9j/2Q==",
					viewport: { width: 400, height: 600, pixel_ratio: 1 },
				};
				break;
			case "action":
				if (body.action.kind === "new_page") {
					created = true;
					control = { ...control, revision: "3", next_command_sequence: "10" };
					pages = [
						...pages,
						{
							page: createdPage,
							url: "about:blank",
							title: "Created page",
							profile_id: "default",
						},
					];
				}
				result = {
					response: {
						success: true,
						data: body.action.kind === "new_page" ? { page: createdPage } : {},
					},
					control,
					observation: body.action.kind === "new_page" ? null : observe(),
				};
				break;
			default:
				throw new Error(`Unexpected Browser request: ${body.kind}`);
		}
		return {
			schemaVersion: 1,
			backendId: route.backend.id,
			backendGeneration: route.backend.generation,
			routeAuthority: route,
			result: {
				schemaVersion: 1,
				operation_id: body.operation_id ?? body.authority?.operation_id ?? null,
				replayed: false,
				result,
			},
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
	const api = {
		id: "browser:main",
		isVisible: true,
		updateParameters: vi.fn(),
		onDidVisibilityChange: () => ({ dispose() {} }),
	};
	const mounted = render(
		<BrowserPanel
			{...({
				api,
				params: { url: "https://example.com" },
			} as unknown as IDockviewPanelProps<{ url: string }>)}
		/>,
	);
	try {
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.options" }),
		);
		expect(
			screen.queryByRole("combobox", { name: "panels.browser.workspace" }),
		).toBeNull();
		const browser = await screen.findByRole("combobox", {
			name: "panels.browser.resource",
		});
		await waitFor(() => expect(browser.hasAttribute("disabled")).toBe(false));
		chooseSelectValue(browser, "browser:existing");
		fireEvent.click(
			await screen.findByRole("button", { name: "panels.browser.takeControl" }),
		);
		await screen.findByText("panels.browser.youControl");
		const address = screen.getByRole("textbox", {
			name: "panels.browser.address",
		});
		fireEvent.change(address, { target: { value: "https://example.net" } });
		fireEvent.keyDown(address, { key: "Enter" });
		await waitFor(() => {
			const action = mocks.invoke.mock.calls.find(
				([, args]) => args.body?.kind === "action",
			)?.[1].body;
			expect(action).toEqual({
				kind: "action",
				caller: control.controller.controller_id,
				authority: {
					lease: control.controller,
					page,
					operation_id: expect.any(String),
					command_sequence: "8",
				},
				action: { kind: "navigate", url: "https://example.net" },
			});
		});
		expect(api.updateParameters).toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.newPage" }),
		);
		await waitFor(() =>
			expect(
				api.updateParameters.mock.calls.some(
					([value]) => value.browserBinding?.pageId === createdPage.page_id,
				),
			).toBe(true),
		);
		expect
			.soft(
				screen.getByRole("combobox", {
					name: "panels.browser.page",
				}).textContent,
			)
			.toBe("common.loading");
		expect
			.soft(screen.getByRole("button", { name: "panels.browser.newPage" }))
			.toHaveProperty("disabled", true);
		releaseObservation();
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", {
					name: "panels.browser.page",
				}).textContent,
			).toBe("Created page"),
		);
	} finally {
		releaseObservation();
		mounted.unmount();
	}
});
