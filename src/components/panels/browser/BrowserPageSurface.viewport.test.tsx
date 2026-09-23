// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserPaneSession } from "@/lib/browser/browserPaneSession";
import type { BrowserControlProjection } from "@/lib/browser/browserResourceContract";
import { createDureBrowserClient } from "@/lib/ipc/dureBrowser";
import { BrowserPageSurface } from "./BrowserPageSurface";

afterEach(() => vi.unstubAllGlobals());

it("fits only the controlling pane and waits for held keys to be released", async () => {
	let resize: (() => void) | undefined;
	let width = 480;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {
				resize = undefined;
			}
		},
	);
	const bounds = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			bottom: 610,
			right: width,
			width,
			height: 610,
			toJSON() {},
		}));
	const resource = {
		resource_id: "browser:viewport",
		generation: "generation:one",
		workspace_id: "workspace:one",
	};
	const page = { resource, page_id: "page:one", document_revision: "1" };
	const route = {
		schemaVersion: 1 as const,
		profileId: "local",
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "backend:one", generation: "generation:one" },
		target: { source: "local" as const, hostId: "local" as const },
	};
	let control: BrowserControlProjection = {
		resource,
		revision: "1",
		phase: "ready",
		controller: { resource, controller_id: "agent:one", epoch: "1" },
		requested_controller: null,
		in_flight: null,
		next_command_sequence: "1",
		current_page: page,
	};
	const actions: unknown[] = [];
	let releaseKeyDown!: () => void;
	const keyDownGate = new Promise<void>((resolve) => {
		releaseKeyDown = resolve;
	});
	const invoke = vi.fn(async (_command, args) => {
		const body = args.body;
		let result: unknown;
		if (body.kind === "observe")
			result = {
				control,
				pages: [
					{
						page,
						url: "https://example.com",
						title: "Shared page",
						profile_id: "default",
					},
				],
			};
		else if (body.kind === "frame")
			result = {
				page,
				mimeType: "image/jpeg",
				base64: "aW1hZ2U=",
				viewport: { width: 1280, height: 720, pixel_ratio: 1 },
			};
		else if (body.kind === "action") {
			if (body.action.kind === "environment") actions.push(body);
			if (body.action.kind === "key_down") {
				await keyDownGate;
				control = { ...control, keyboard: { page, keys: [body.action.key] } };
			}
			if (body.action.kind === "key_up")
				control = { ...control, keyboard: undefined };
			control = {
				...control,
				revision: String(BigInt(control.revision) + 1n),
				next_command_sequence: String(
					BigInt(control.next_command_sequence) + 1n,
				),
			};
			result = { control, response: { success: true }, observation: null };
		} else throw Error("unexpected " + body.kind);
		return {
			schemaVersion: 1,
			backendId: route.backend.id,
			backendGeneration: route.backend.generation,
			routeAuthority: route,
			result: {
				schemaVersion: 1,
				operation_id: body.authority?.operation_id ?? null,
				result,
			},
		};
	});
	const session = new BrowserPaneSession(
		createDureBrowserClient(route, invoke),
		resource,
		"view:one",
		undefined,
		async () => "data:image/jpeg;base64,aW1hZ2U=",
	);
	await session.refresh();
	const mounted = render(
		<BrowserPageSurface
			session={session}
			view={session.read()}
			enabled={false}
		/>,
	);
	try {
		await act(async () => resize?.());
		expect(actions).toHaveLength(0);
		control = {
			...control,
			revision: "2",
			controller: { resource, controller_id: "view:one", epoch: "2" },
			keyboard: { page, keys: ["ShiftLeft"] },
		};
		await act(() => session.refresh());
		mounted.rerender(
			<BrowserPageSurface session={session} view={session.read()} enabled />,
		);
		await act(async () => resize?.());
		expect(actions).toHaveLength(0);
		control = { ...control, revision: "3", keyboard: undefined };
		await act(() => session.refresh());
		mounted.rerender(
			<BrowserPageSurface session={session} view={session.read()} enabled />,
		);
		await waitFor(() => expect(actions).toHaveLength(1));
		const receiver = () => mounted.container.querySelector("textarea")!;
		expect(receiver().readOnly).toBe(true);
		mounted.rerender(
			<BrowserPageSurface
				session={session}
				view={{ ...session.read(), frame: undefined }}
				enabled
			/>,
		);
		expect(receiver().readOnly).toBe(true);
		expect(receiver().tabIndex).toBe(-1);
		const frame = session.read().frame!;
		mounted.rerender(
			<BrowserPageSurface
				session={session}
				view={{
					...session.read(),
					frame: {
						...frame,
						capture: {
							...frame.capture,
							viewport: { ...frame.capture.viewport, width: 480, height: 610 },
						},
					},
				}}
				enabled
			/>,
		);
		expect(receiver().readOnly).toBe(false);
		expect(actions[0]).toMatchObject({
			kind: "action",
			caller: "view:one",
			authority: { lease: control.controller, page, command_sequence: "1" },
			action: {
				kind: "environment",
				action: { kind: "viewport", width: 480, height: 610, mobile: false },
			},
		});
		let down!: Promise<unknown>;
		await act(async () => {
			down = session.input({ kind: "key_down", key: "ShiftLeft" });
			mounted.rerender(
				<BrowserPageSurface session={session} view={session.read()} enabled />,
			);
			width = 640;
			resize?.();
		});
		await act(async () => {
			releaseKeyDown();
			await down;
		});
		mounted.rerender(
			<BrowserPageSurface session={session} view={session.read()} enabled />,
		);
		expect(actions).toHaveLength(1);
		await act(() => session.input({ kind: "key_up", key: "ShiftLeft" }));
		mounted.rerender(
			<BrowserPageSurface session={session} view={session.read()} enabled />,
		);
		await waitFor(() => expect(actions).toHaveLength(2));
		expect(actions[1]).toMatchObject({
			authority: { command_sequence: "4" },
			action: { action: { width: 640, height: 610 } },
		});
		mounted.rerender(
			<BrowserPageSurface
				session={session}
				view={session.read()}
				enabled={false}
			/>,
		);
		width = 320;
		await act(async () => resize?.());
		expect(actions).toHaveLength(2);
	} finally {
		mounted.unmount();
		bounds.mockRestore();
		await session.dispose(false);
	}
});
