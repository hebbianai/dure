// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { terminalRecoveryFocusTracker } from "@/lib/terminal/terminalRecoveryFocus";
import {
	beginPaneContentFocus,
	cancelPaneContentFocus,
	consumePaneContentFocus,
	currentPaneContentFocus,
	settlePaneContentFocus,
} from "./paneContentFocusHandoff";

function focusHandle(group: HTMLElement) {
	return { group: { element: group }, getWindow: () => window };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("pane content focus handoff", () => {
	it("scopes consumption to the exact panel handle", () => {
		const group = document.createElement("div");
		const exact = focusHandle(group);
		const sameShape = focusHandle(group);
		const request = beginPaneContentFocus(exact);

		expect(currentPaneContentFocus(exact)).toBe(request);
		expect(consumePaneContentFocus(sameShape, request)).toBe(false);
		expect(consumePaneContentFocus(exact, request)).toBe(true);
		expect(currentPaneContentFocus(exact)).toBeUndefined();
	});

	it("settles across Dockview's exact group focus but not a newer outside owner", () => {
		const group = document.createElement("div");
		group.tabIndex = -1;
		const outside = document.createElement("button");
		group.append(document.createElement("span"));
		document.body.append(group, outside);
		const handle = focusHandle(group);
		const request = beginPaneContentFocus(handle);

		group.focus();
		settlePaneContentFocus(handle, request);
		const settled = currentPaneContentFocus(handle);
		expect(settled?.generation).toBe(request.generation);
		expect(settled?.requestedAt).toBe(request.requestedAt);
		expect(
			terminalRecoveryFocusTracker.unchanged(settled?.focusRevision ?? -1),
		).toBe(true);

		outside.focus();
		expect(
			terminalRecoveryFocusTracker.unchanged(settled?.focusRevision ?? -1),
		).toBe(false);
		cancelPaneContentFocus(handle, settled);
	});

	it("does not bless a pane toolbar focus that occurs during dispatch", () => {
		const group = document.createElement("div");
		const toolbar = document.createElement("button");
		group.append(toolbar);
		document.body.append(group);
		const handle = focusHandle(group);
		const request = beginPaneContentFocus(handle);

		toolbar.focus();
		settlePaneContentFocus(handle, request);

		expect(currentPaneContentFocus(handle)).toBe(request);
		expect(
			terminalRecoveryFocusTracker.unchanged(request.focusRevision),
		).toBe(false);
		cancelPaneContentFocus(handle, request);
	});
});
