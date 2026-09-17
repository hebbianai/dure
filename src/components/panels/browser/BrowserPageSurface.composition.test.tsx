// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserPaneSession } from "@/lib/browser/browserPaneSession";
import type {
	BrowserControlProjection,
	BrowserPageIdentity,
} from "@/lib/browser/browserResourceContract";
import { createDureBrowserClient } from "@/lib/ipc/dureBrowser";
import { BrowserPageSurface } from "./BrowserPageSurface";

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
	const resource = {
		resource_id: "browser:composition",
		generation: "generation:one",
		workspace_id: "workspace:one",
	};
	let page: BrowserPageIdentity = {
		resource,
		page_id: "page:one",
		document_revision: "1",
	};
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
		controller: { resource, controller_id: "view:one", epoch: "1" },
		requested_controller: null,
		in_flight: null,
		next_command_sequence: "1",
		current_page: page,
	};
	const actions: unknown[] = [];
	const invoke = vi.fn(async (_command, args) => {
		const body = args.body;
		let result: unknown;
		if (body.kind === "observe")
			result = {
				control,
				pages: [
					{ page, url: "about:blank", title: "Input", profile_id: "default" },
				],
			};
		else if (body.kind === "control_state") result = control;
		else if (body.kind === "frame")
			result = {
				page,
				mimeType: "image/jpeg",
				base64: "aW1hZ2U=",
				viewport: { width: 400, height: 600, pixel_ratio: 1 },
			};
		else if (body.kind === "action") {
			actions.push(body);
			control = {
				...control,
				revision: String(BigInt(control.revision) + 1n),
				next_command_sequence: String(
					BigInt(control.next_command_sequence) + 1n,
				),
			};
			result = { control, response: { success: true }, observation: null };
		} else throw Error(`unexpected ${body.kind}`);
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
	function Pane() {
		const view = useSyncExternalStore(session.subscribe, session.read);
		return (
			<BrowserPageSurface
				session={session}
				view={view}
				enabled={
					view.control?.controller?.controller_id === session.controllerId
				}
			/>
		);
	}
	const mounted = render(<Pane />);
	return {
		actions,
		input: () => mounted.getByRole("textbox") as HTMLTextAreaElement,
		async observe(
			update: "refresh" | "tab" | "navigation" | "handoff" | "return",
		) {
			if (update === "tab") page = { ...page, page_id: "page:two" };
			if (update === "navigation") page = { ...page, document_revision: "2" };
			control = {
				...control,
				revision: String(BigInt(control.revision) + 1n),
				current_page: page,
				controller:
					update === "handoff" || update === "return"
						? {
								resource,
								controller_id: update === "handoff" ? "agent:one" : "view:one",
								epoch: update === "handoff" ? "2" : "3",
							}
						: control.controller,
			};
			await act(() => session.refresh());
		},
		async close() {
			mounted.unmount();
			await session.dispose(false);
		},
	};
}

function start(input: HTMLTextAreaElement) {
	fireEvent.compositionStart(input, { data: "" });
	fireEvent.input(input, {
		target: { value: "ㅎ" },
		data: "ㅎ",
		inputType: "insertCompositionText",
		isComposing: true,
	});
}
async function finish(input: HTMLTextAreaElement, text: string) {
	await act(async () => {
		fireEvent.input(input, {
			target: { value: text },
			data: text,
			inputType: "insertCompositionText",
			isComposing: true,
		});
		fireEvent.compositionEnd(input, { data: text });
		fireEvent.input(input, { data: text, inputType: "insertText" });
	});
}

it("submits each wheel with its displayed position in one admitted action", async () => {
	const f = await fixture();
	const surface = f.input().parentElement!.querySelector("img")!.parentElement!;
	const bounds = vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
		x: 20,
		y: 30,
		left: 20,
		top: 30,
		right: 220,
		bottom: 330,
		width: 200,
		height: 300,
		toJSON() {},
	});
	try {
		await act(async () => {
			fireEvent.wheel(surface, {
				clientX: 70,
				clientY: 130,
				deltaY: 3,
				deltaX: 1,
				deltaMode: 1,
			});
		});
		expect(f.actions).toHaveLength(1);
		expect(f.actions[0]).toMatchObject({
			authority: { page: { page_id: "page:one", document_revision: "1" } },
			action: {
				kind: "mouse",
				action: { kind: "wheel", x: 100, y: 200, delta_x: 16, delta_y: 48 },
			},
		});
	} finally {
		bounds.mockRestore();
		await f.close();
	}
});

it("commits Korean once to the displayed document while frames refresh", async () => {
	const f = await fixture();
	try {
		start(f.input());
		expect(f.actions).toEqual([]);
		await f.observe("refresh");
		await finish(f.input(), "한글 입력");
		expect(f.actions).toHaveLength(1);
		expect(f.actions[0]).toMatchObject({
			authority: {
				page: { page_id: "page:one", document_revision: "1" },
				lease: { controller_id: "view:one", epoch: "1" },
			},
			action: { kind: "insert_text", text: "한글 입력" },
		});
	} finally {
		await f.close();
	}
});

it.each(["tab", "navigation", "handoff"] as const)(
	"does not transfer a pending composition across %s, and accepts new input",
	async (transition) => {
		const f = await fixture();
		try {
			const original = f.input();
			start(original);
			await f.observe(transition);
			if (transition === "handoff") await f.observe("return");
			await finish(original, "이전 페이지의 입력");
			expect(f.actions).toEqual([]);
			start(f.input());
			await finish(f.input(), "새 입력");
			expect(f.actions).toHaveLength(1);
			expect(f.actions[0]).toMatchObject({
				action: { kind: "insert_text", text: "새 입력" },
				authority: {
					page: {
						page_id: transition === "tab" ? "page:two" : "page:one",
						document_revision: transition === "navigation" ? "2" : "1",
					},
					lease: { epoch: transition === "handoff" ? "3" : "1" },
				},
			});
		} finally {
			await f.close();
		}
	},
);

it("discards a late composition end after blur and accepts a fresh composition", async () => {
	const f = await fixture();
	try {
		start(f.input());
		await act(async () => fireEvent.blur(f.input()));
		await act(async () =>
			fireEvent.compositionEnd(f.input(), { data: "취소된 입력" }),
		);
		expect(f.actions).toEqual([]);
		start(f.input());
		await finish(f.input(), "다음 입력");
		expect(f.actions).toHaveLength(1);
	} finally {
		await f.close();
	}
});
