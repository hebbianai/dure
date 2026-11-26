// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	completeFileReveal,
	readFileReveal,
	requestFileReveal,
	subscribeFileReveal,
} from "@/lib/files/fileReveal";
import { openFileViewerOn } from "@/lib/files/fileViewerPane";
import { useRecentFileOpens } from "@/lib/files/recentFileOpensStore";
import { useHiddenFilePanes } from "@/lib/workspace/pane/hiddenFilePanesStore";

const local = { source: "local" as const, path: "/repo/src/a.ts" };
const remote = { source: "ssh" as const, hostId: "h1", path: "/repo/src/a.ts" };

const disposals: (() => void)[] = [];
function dockview(): DockviewApi {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	disposals.push(() => {
		api.dispose();
		element.remove();
	});
	return api;
}

beforeEach(() => {
	useHiddenFilePanes.setState({ hidden: {} });
	useRecentFileOpens.setState({ entries: [] });
});
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	for (const target of [local, remote]) {
		const request = readFileReveal(target);
		if (request) completeFileReveal(target, request.id);
	}
});

describe("file reveal requests", () => {
	it("keeps one request per document until the newest one is shown", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeFileReveal(local, listener);
		requestFileReveal(local, { line: 3 });
		const first = readFileReveal(local);
		requestFileReveal({ ...local, sessionId: "s1" }, { line: 9, column: 2 });
		const second = readFileReveal(local);
		expect(second).toMatchObject({ line: 9, column: 2 });
		expect(readFileReveal(remote)).toBeUndefined();

		completeFileReveal(local, first!.id);
		expect(readFileReveal(local)).toBe(second);
		completeFileReveal(local, second!.id);
		expect(readFileReveal(local)).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(3);
		unsubscribe();
	});

	it("opens a file at a line without saving the line in the pane or its history", () => {
		const api = dockview();
		const pane = openFileViewerOn(api, { ...remote, reveal: { line: 12 } });
		expect(pane.params).toEqual(remote);
		expect(useRecentFileOpens.getState().entries[0]).not.toHaveProperty(
			"reveal",
		);
		expect(readFileReveal(remote)).toMatchObject({ line: 12 });

		const reopened = openFileViewerOn(api, {
			...remote,
			reveal: { line: 40, column: 5 },
		});
		expect(reopened.id).toBe(pane.id);
		expect(readFileReveal(remote)).toMatchObject({ line: 40, column: 5 });
	});
});
