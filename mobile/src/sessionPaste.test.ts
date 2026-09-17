import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	renderSessionScreen,
	type SessionActions,
	type SessionModel,
} from "./sessionScreen";
import { HOLD_MS, ROW_PX } from "./holdDrag";
import { createHomeFixture } from "../qa/homeFixture";
import type { AttachedSession } from "./ipc";
import { mountStructuredTerminal } from "./structuredTerminal";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "showPopover", {
		configurable: true,
		value: vi.fn(),
	});
	Object.defineProperty(HTMLElement.prototype, "hidePopover", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	document.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
	vi.useRealTimers();
});

function screen(
	role = "controller",
	transcript: HTMLElement = document.createElement("pre"),
) {
	const actions = {
		back: vi.fn(),
		transcript: () => transcript,
		enableInput: vi.fn(),
		press: vi.fn(),
		type: vi.fn(),
		paste: vi.fn(),
		nativeKey: vi.fn(),
		draft: () => "",
		submit: vi.fn(),
		togglePanel: vi.fn(),
		runCommand: vi.fn(),
		openSession: vi.fn(),
		openSourceControl: vi.fn(),
	};
	const model = {
		machineLabel: "Test Mac",
		session: createHomeFixture().hubs[0].sessions[0],
		attached: { role } as AttachedSession,
		panel: "none",
		tray: [],
		history: [],
		siblings: [],
		nowMs: 0,
		haptics: false,
	} satisfies SessionModel;
	const node = renderSessionScreen(model, actions as SessionActions);
	document.body.append(node);
	return {
		node,
		stage: node.querySelector<HTMLElement>(".session__stage")!,
		actions,
	};
}

function pointer(node: HTMLElement, type: string, y = 200) {
	node.dispatchEvent(
		new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: 100,
			clientY: y,
		}),
	);
}

describe("mobile terminal paste", () => {
	it("offers Paste after a stationary hold and only reads on selection", () => {
		vi.useFakeTimers();
		const { node, stage, actions } = screen();
		pointer(stage, "pointerdown");
		vi.advanceTimersByTime(HOLD_MS);
		expect(node.querySelector('[role="menuitem"]')?.textContent).toBe("Paste");
		pointer(stage, "pointerup");
		expect(actions.paste).not.toHaveBeenCalled();
		const paste = node.querySelector<HTMLButtonElement>('[role="menuitem"]');
		expect(paste?.textContent).toBe("Paste");
		paste?.click();
		expect(actions.paste).toHaveBeenCalledOnce();
	});

	it("leaves a hold on displayed text to native selection rather than opening another screen", () => {
		vi.useFakeTimers();
		const { node, stage, actions } = screen();
		const text = document.createElement("span");
		text.dataset.terminalRun = "";
		text.textContent = "한글 선택";
		stage.querySelector("pre")!.append(text);
		pointer(text, "pointerdown");
		vi.advanceTimersByTime(HOLD_MS);
		pointer(text, "pointermove", 200 - ROW_PX);
		pointer(text, "pointerup");
		const callout = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
		});
		text.dispatchEvent(callout);
		expect(callout.defaultPrevented).toBe(false);
		expect(node.querySelector('[role="menu"]')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(actions.press).not.toHaveBeenCalled();
	});

	it.each(
		[false, true].flatMap((coalesced) => [
			{ coalesced, text: " ".repeat(42), column: 20, area: "blank row" },
			{
				coalesced,
				text: "    padded text".padEnd(42),
				column: 2,
				area: "leading padding",
			},
			{
				coalesced,
				text: "    padded text".padEnd(42),
				column: 30,
				area: "trailing padding",
			},
		]),
	)(
		"offers Paste on $area (coalesced=$coalesced)",
		async ({ coalesced, text, column }) => {
			vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
				coalesced
					? ({
							measureText: (text: string) => ({ width: text.length * 8 }),
						} as CanvasRenderingContext2D)
					: null,
			);
			const transcript = document.createElement("div");
			const { node, actions } = screen("controller", transcript);
			let first = true;
			const surface = mountStructuredTerminal(
				transcript,
				{
					attachment_id: "paste-test",
					terminal_epoch: "terminal-a",
					through_output_seq: "1",
					state_revision: "1",
					initial_delivery_record_count: 1,
				},
				{
					next: async () => {
						if (!first) return new Promise(() => {});
						first = false;
						return viewportFrameRecord({ columns: 42, texts: [text] })
							.buffer as ArrayBuffer;
					},
					send: async () => {},
				},
			);
			try {
				await vi.waitFor(() =>
					expect(
						transcript.querySelector("[data-terminal-run]"),
					).not.toBeNull(),
				);
				vi.useFakeTimers();
				const blank = [
					...transcript.querySelectorAll<HTMLElement>("[data-terminal-run]"),
				].find(
					(run) =>
						Number(run.dataset.column) <= column &&
						Number(run.dataset.column) + Number(run.dataset.columns) > column,
				)!;
				pointer(blank, "pointerdown");
				vi.advanceTimersByTime(HOLD_MS);
				expect(node.querySelector('[role="menuitem"]')?.textContent).toBe(
					"Paste",
				);
				pointer(blank, "pointerup");
				node.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
				expect(actions.paste).toHaveBeenCalledOnce();
				expect(actions.press).not.toHaveBeenCalled();
			} finally {
				surface.dispose();
				vi.restoreAllMocks();
			}
		},
	);

	it.each(["scroll", "drag", "cancel", "watch"])(
		"does not offer paste after %s",
		(kind) => {
			vi.useFakeTimers();
			const { node, stage, actions } = screen(
				kind === "watch" ? "watcher" : "controller",
			);
			pointer(stage, "pointerdown");
			if (kind === "scroll") pointer(stage, "pointermove", 150);
			vi.advanceTimersByTime(HOLD_MS);
			if (kind === "drag") pointer(stage, "pointermove", 200 - ROW_PX);
			pointer(stage, kind === "cancel" ? "pointercancel" : "pointerup");
			expect(
				[...node.querySelectorAll('[role="menuitem"]')].some(
					(item) => item.textContent === "Paste",
				),
			).toBe(false);
			expect(actions.paste).not.toHaveBeenCalled();
			if (kind === "drag") expect(actions.press).toHaveBeenCalledWith("up");
		},
	);

	it("forwards native multiline clipboard text through Paste rather than typing", () => {
		const { node, actions } = screen();
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: {
				items: [],
				getData: () => "한글\nsecond line",
			},
		});
		node.querySelector("textarea")!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(actions.paste).toHaveBeenCalledWith({
			kind: "text",
			text: "한글\nsecond line",
		});
		expect(actions.type).not.toHaveBeenCalled();
	});
	it("captures the native image synchronously instead of pasting its accompanying text", () => {
		const { node, actions } = screen();
		const image = new File([new Uint8Array([137, 80, 78, 71])], "image.png", {
			type: "image/png",
		});
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: {
				items: [{ kind: "file", type: image.type, getAsFile: () => image }],
				getData: () => "accompanying image URL",
			},
		});
		node.querySelector("textarea")!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(actions.paste).toHaveBeenCalledExactlyOnceWith({
			kind: "image",
			image,
		});
		expect(actions.type).not.toHaveBeenCalled();
	});
});
