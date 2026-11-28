// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
	keepOnTopPreferred,
	keepOnTopWindowOptions,
	rememberKeepOnTop,
} from "@/lib/workspace/window/windowKeepOnTop";

const KEY = "dure-window-keep-on-top";

function memoryStorage(initial: Record<string, string> = {}): Storage {
	const items = new Map(Object.entries(initial));
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => {
			items.delete(key);
		},
		setItem: (key, value) => {
			items.set(key, value);
		},
	};
}

function throwingStorage(): Storage {
	const fail = () => {
		throw new Error("storage unavailable");
	};
	return {
		length: 0,
		clear: fail,
		getItem: fail,
		key: fail,
		removeItem: fail,
		setItem: fail,
	};
}

describe("keep-on-top preference", () => {
	it("remembers a window by its label", () => {
		const storage = memoryStorage();
		rememberKeepOnTop(storage, "win-session-agent-1", true);

		expect(keepOnTopPreferred(storage, "win-session-agent-1")).toBe(true);
		expect(keepOnTopPreferred(storage, "win-session-agent-2")).toBe(false);
		expect(keepOnTopPreferred(storage, "win-presentation")).toBe(false);
	});

	it("drops the label when turned off and keeps the others", () => {
		const storage = memoryStorage();
		rememberKeepOnTop(storage, "win-session-agent-1", true);
		rememberKeepOnTop(storage, "win-presentation", true);
		rememberKeepOnTop(storage, "win-session-agent-1", false);

		expect(keepOnTopPreferred(storage, "win-session-agent-1")).toBe(false);
		expect(keepOnTopPreferred(storage, "win-presentation")).toBe(true);
		expect(JSON.parse(storage.getItem(KEY) ?? "null")).toEqual([
			"win-presentation",
		]);
	});

	it("saves each label once", () => {
		const storage = memoryStorage({
			[KEY]: JSON.stringify(["win-presentation", "win-presentation"]),
		});
		rememberKeepOnTop(storage, "win-presentation", true);
		rememberKeepOnTop(storage, "win-presentation", true);

		expect(JSON.parse(storage.getItem(KEY) ?? "null")).toEqual([
			"win-presentation",
		]);
	});

	it.each([
		["not JSON", "{"],
		["not a list", JSON.stringify({ "win-presentation": true })],
		["not labels", JSON.stringify([1, null, "", { label: "x" }])],
	])("reads malformed data (%s) as no saved windows", (_case, raw) => {
		const storage = memoryStorage({ [KEY]: raw });

		expect(keepOnTopPreferred(storage, "win-presentation")).toBe(false);
		rememberKeepOnTop(storage, "win-presentation", true);
		expect(JSON.parse(storage.getItem(KEY) ?? "null")).toEqual([
			"win-presentation",
		]);
	});

	it("keeps only the valid labels from a partly malformed list", () => {
		const storage = memoryStorage({
			[KEY]: JSON.stringify(["win-presentation", 7, ""]),
		});

		expect(keepOnTopPreferred(storage, "win-presentation")).toBe(true);
	});

	it("tolerates a storage that is missing or throws", () => {
		expect(keepOnTopPreferred(undefined, "win-presentation")).toBe(false);
		expect(() =>
			rememberKeepOnTop(undefined, "win-presentation", true),
		).not.toThrow();

		const storage = throwingStorage();
		expect(keepOnTopPreferred(storage, "win-presentation")).toBe(false);
		expect(() =>
			rememberKeepOnTop(storage, "win-presentation", true),
		).not.toThrow();
	});
});

describe("keep-on-top window creation options", () => {
	beforeEach(() => localStorage.clear());

	it("opens a saved window on top and every other window at the normal level", () => {
		rememberKeepOnTop(localStorage, "win-session-agent-1", true);

		expect(keepOnTopWindowOptions("win-session-agent-1")).toEqual({
			alwaysOnTop: true,
		});
		expect(keepOnTopWindowOptions("win-presentation")).toEqual({
			alwaysOnTop: false,
		});
	});
});
