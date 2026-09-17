// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseWindowAnimationDiagnostics,
	readWindowAnimationDiagnostics,
} from "./windowAnimationDiagnostics";

interface AnimationFixture {
	name?: string;
	playState: AnimationPlayState;
	target?: Element;
	duration?: number | string;
	iterations?: number;
}

function animation({
	name,
	playState,
	target,
	duration = 1_000,
	iterations = Infinity,
}: AnimationFixture): Animation {
	return {
		animationName: name,
		effect: {
			getTiming: () => ({ duration, iterations }),
			target,
		},
		playState,
	} as unknown as Animation;
}

function installAnimations(animations: Animation[]) {
	const getAnimations = vi.fn(() => animations);
	Object.defineProperty(document, "getAnimations", {
		configurable: true,
		value: getAnimations,
	});
	return getAnimations;
}

describe("window animation diagnostics", () => {
	afterEach(() => {
		Reflect.deleteProperty(document, "getAnimations");
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("groups only perpetual animation categories without exposing raw identity", () => {
		const geometryRead = vi.spyOn(Element.prototype, "getBoundingClientRect");
		const computedStyleRead = vi.spyOn(window, "getComputedStyle");
		const active = document.createElement("span");
		active.className = "chat-shimmer user-secret-class";
		active.textContent = "user secret draft";
		const activePanel = document.createElement("section");
		activePanel.setAttribute("role", "tabpanel");
		activePanel.append(active);
		const hiddenPanel = document.createElement("section");
		hiddenPanel.setAttribute("role", "tabpanel");
		hiddenPanel.setAttribute("aria-hidden", "true");
		const nestedActivePanel = document.createElement("section");
		nestedActivePanel.setAttribute("role", "tabpanel");
		const hidden = document.createElement("span");
		nestedActivePanel.append(hidden);
		hiddenPanel.append(nestedActivePanel);
		document.body.append(activePanel, hiddenPanel);
		const editor = document.createElement("textarea");
		editor.value = "another secret draft";
		document.body.append(editor);
		editor.focus();
		const getAnimations = installAnimations([
			animation({
				name: "terminal-viewport-blink",
				playState: "running",
				target: active,
				duration: 500,
			}),
			animation({
				name: "chat-shimmer-sweep",
				playState: "paused",
				target: hidden,
				duration: 2_400,
			}),
			animation({
				name: "chat-shimmer-sweep",
				playState: "running",
				target: active,
				duration: 2_400,
			}),
			animation({
				name: "chat-shimmer-sweep",
				playState: "running",
				target: active,
				duration: 3_000,
			}),
			animation({
				name: "user secret animation name",
				playState: "running",
				target: active,
			}),
			animation({
				name: "finite-entrance",
				playState: "running",
				target: active,
				iterations: 1,
			}),
			animation({
				name: "finished-loop",
				playState: "finished",
				target: active,
			}),
		]);

		const diagnostics = readWindowAnimationDiagnostics();

		expect(diagnostics).toEqual({
			documentVisibility: "visible",
			focusedEditable: true,
			groups: [
				{
					category: "chat-shimmer",
					count: 2,
					maxDurationMs: 3_000,
					minDurationMs: 2_400,
					playState: "running",
					scope: "active-tabpanel",
				},
				{
					category: "chat-shimmer",
					count: 1,
					maxDurationMs: 2_400,
					minDurationMs: 2_400,
					playState: "paused",
					scope: "hidden-tabpanel",
				},
				{
					category: "other",
					count: 1,
					maxDurationMs: 1_000,
					minDurationMs: 1_000,
					playState: "running",
					scope: "active-tabpanel",
				},
				{
					category: "terminal-cursor",
					count: 1,
					maxDurationMs: 500,
					minDurationMs: 500,
					playState: "running",
					scope: "active-tabpanel",
				},
			],
			supported: true,
		});
		expect(getAnimations).toHaveBeenCalledOnce();
		const serialized = JSON.stringify(diagnostics);
		expect(serialized).not.toContain("user secret");
		expect(serialized).not.toContain("user-secret-class");
		expect(serialized).not.toContain("another secret draft");
		expect(geometryRead).not.toHaveBeenCalled();
		expect(computedStyleRead).not.toHaveBeenCalled();
	});

	it("marks a missing animation capability as unsupported", () => {
		Reflect.deleteProperty(document, "getAnimations");

		expect(readWindowAnimationDiagnostics()).toMatchObject({
			groups: [],
			supported: false,
		});
	});

	it("reports animation inspection failures as unavailable", () => {
		Object.defineProperty(document, "getAnimations", {
			configurable: true,
			value: () => {
				throw new Error("injected animation failure");
			},
		});

		expect(readWindowAnimationDiagnostics()).toEqual({
			documentVisibility: "visible",
			focusedEditable: false,
			groups: [],
			supported: false,
		});
	});

	it.each(["button", "checkbox", "radio", "range"])(
		"does not classify a focused %s input as editable",
		(type) => {
			const control = document.createElement("input");
			control.type = type;
			document.body.append(control);

			expect(
				readWindowAnimationDiagnostics({
					activeElement: control,
					getAnimations: () => [],
					hasFocus: () => true,
					visibilityState: "visible",
				}),
			).toMatchObject({ focusedEditable: false });
		},
	);

	it("does not report a retained editable target as focused after window blur", () => {
		const editor = document.createElement("textarea");

		expect(
			readWindowAnimationDiagnostics({
				activeElement: editor,
				getAnimations: () => [],
				hasFocus: () => false,
				visibilityState: "visible",
			}),
		).toMatchObject({ focusedEditable: false });
	});

	it("projects a remote aggregate and drops all unknown fields", () => {
		const parsed = parseWindowAnimationDiagnostics({
			documentVisibility: "hidden",
			focusedEditable: false,
			groups: [
				{
					category: "chat-shimmer",
					className: "remote-secret-class",
					count: 3,
					maxDurationMs: 2_400,
					minDurationMs: 2_400,
					paneId: "remote-secret-pane",
					playState: "paused",
					scope: "hidden-tabpanel",
				},
			],
			sessionId: "remote-secret-session",
			supported: true,
			textContent: "remote secret text",
		});

		expect(parsed).toEqual({
			documentVisibility: "hidden",
			focusedEditable: false,
			groups: [
				{
					category: "chat-shimmer",
					count: 3,
					maxDurationMs: 2_400,
					minDurationMs: 2_400,
					playState: "paused",
					scope: "hidden-tabpanel",
				},
			],
			supported: true,
		});
		expect(JSON.stringify(parsed)).not.toContain("remote-secret");
	});

	it.each([
		["missing support flag", { groups: [] }],
		[
			"unsupported report with groups",
			{
				documentVisibility: "visible",
				focusedEditable: false,
				groups: [
					{
						category: "pulse",
						count: 1,
						maxDurationMs: 1,
						minDurationMs: 1,
						playState: "running",
						scope: "active-tabpanel",
					},
				],
				supported: false,
			},
		],
		[
			"non-finite timing",
			{
				documentVisibility: "visible",
				focusedEditable: false,
				groups: [
					{
						category: "pulse",
						count: 1,
						maxDurationMs: Infinity,
						minDurationMs: 1,
						playState: "running",
						scope: "active-tabpanel",
					},
				],
				supported: true,
			},
		],
		[
			"half-known duration range",
			{
				documentVisibility: "visible",
				focusedEditable: false,
				groups: [
					{
						category: "pulse",
						count: 1,
						maxDurationMs: 2_000,
						minDurationMs: null,
						playState: "running",
						scope: "active-tabpanel",
					},
				],
				supported: true,
			},
		],
	] as const)("rejects %s", (_label, value) => {
		expect(parseWindowAnimationDiagnostics(value)).toBeUndefined();
	});
});
