import { describe, expect, it, vi } from "vitest";
import {
	type FilePresentation,
	fileBaseName,
	parseFilePresentation,
	presenterAgentIdForSession,
	readFilePresentation,
	storeFilePresentation,
	subscribeFilePresentation,
} from "@/lib/files/filePresentation";

const first: FilePresentation = {
	id: "p-1",
	file: { source: "local", path: "/work/shot.png" },
	presenterAgentId: "agent-1",
};
const second: FilePresentation = {
	id: "p-2",
	file: { source: "local", path: "/work/demo.mp4" },
};

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	};
}

function deferredTransport(stored: () => FilePresentation | undefined) {
	let deliver: ((payload: unknown) => void) | undefined;
	let settle: ((unlisten: () => void) => void) | undefined;
	let fail: ((error: unknown) => void) | undefined;
	const unlisten = vi.fn();
	const read = vi.fn(stored);
	const transport = {
		listen: (listener: (payload: unknown) => void) => {
			deliver = listener;
			return new Promise<() => void>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			});
		},
		read,
	};
	return {
		transport,
		read,
		unlisten,
		deliver: (payload: unknown) => deliver?.(payload),
		subscribed: async () => {
			settle?.(unlisten);
			await Promise.resolve();
			await Promise.resolve();
		},
		failed: async () => {
			fail?.(new Error("no bridge"));
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

describe("parseFilePresentation", () => {
	it("keeps a local absolute file and an optional presenter", () => {
		expect(parseFilePresentation(first)).toEqual(first);
		expect(parseFilePresentation({ ...second, presenterAgentId: "" })).toEqual(
			second,
		);
		expect(
			parseFilePresentation({
				id: "w",
				file: { source: "local", path: "C:\\work\\report.pdf" },
			}),
		).toEqual({ id: "w", file: { source: "local", path: "C:\\work\\report.pdf" } });
	});

	it.each([
		null,
		[],
		{ file: first.file },
		{ id: "", file: first.file },
		{ id: "bad\nid", file: first.file },
		{ id: "x", file: { source: "ssh", path: "/srv/a.png" } },
		{ id: "x", file: { source: "local", path: "relative.png" } },
		{ id: "x", file: { source: "local", path: "file:///work/a.png" } },
		{ id: "x", file: { source: "local", path: "https://example.com/a.png" } },
		{ id: "x" },
	])("refuses anything else as no presentation: %j", (value) => {
		expect(parseFilePresentation(value)).toBeUndefined();
	});
});

describe("presenterAgentIdForSession", () => {
	const agents = [
		{ id: "agent-1", sessionId: "session-1" },
		{ id: "agent-2", sessionId: "session-2" },
		{ id: "agent-3", sessionId: "session-2" },
	];

	it("names the presenter only for exactly one Agent in the invoking Session", () => {
		expect(presenterAgentIdForSession(agents, "session-1")).toBe("agent-1");
		expect(presenterAgentIdForSession(agents, "session-2")).toBeUndefined();
		expect(presenterAgentIdForSession(agents, "missing")).toBeUndefined();
		expect(presenterAgentIdForSession(agents, undefined)).toBeUndefined();
	});
});

describe("fileBaseName", () => {
	it("names the file on either path separator", () => {
		expect(fileBaseName("/work/report notes.md")).toBe("report notes.md");
		expect(fileBaseName("C:\\work\\report.pdf")).toBe("report.pdf");
	});
});

describe("stored presentation", () => {
	it("round-trips the latest presentation and survives unusable storage", () => {
		const storage = memoryStorage();
		expect(readFilePresentation(storage)).toBeUndefined();
		storeFilePresentation(first, storage);
		storeFilePresentation(second, storage);
		expect(readFilePresentation(storage)).toEqual(second);
		storage.setItem("dure:file-presentation", "{not json");
		expect(readFilePresentation(storage)).toBeUndefined();
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(() => storeFilePresentation(first, broken)).not.toThrow();
		expect(readFilePresentation(broken)).toBeUndefined();
	});
});

describe("subscribeFilePresentation", () => {
	it("reads the stored record only after the subscription is live", async () => {
		const shown: FilePresentation[] = [];
		const channel = deferredTransport(() => second);
		subscribeFilePresentation((value) => shown.push(value), channel.transport);
		expect(channel.read).not.toHaveBeenCalled();
		await channel.subscribed();
		expect(channel.read).toHaveBeenCalledOnce();
		expect(shown).toEqual([second]);
	});

	it("delivers announced presentations and ignores malformed ones", async () => {
		const shown: FilePresentation[] = [];
		const channel = deferredTransport(() => undefined);
		subscribeFilePresentation((value) => shown.push(value), channel.transport);
		await channel.subscribed();
		channel.deliver(first);
		channel.deliver({ id: "x", file: { source: "ssh", path: "/srv/a" } });
		channel.deliver(second);
		expect(shown).toEqual([first, second]);
	});

	it("stops listening when disposed before or after the subscription settles", async () => {
		const early = deferredTransport(() => first);
		const shownEarly: FilePresentation[] = [];
		subscribeFilePresentation((value) => shownEarly.push(value), early.transport)();
		await early.subscribed();
		expect(early.unlisten).toHaveBeenCalledOnce();
		early.deliver(second);
		expect(shownEarly).toEqual([]);

		const late = deferredTransport(() => undefined);
		const stop = subscribeFilePresentation(() => {}, late.transport);
		await late.subscribed();
		stop();
		expect(late.unlisten).toHaveBeenCalledOnce();
	});

	it("still shows the stored record when the event bridge is unavailable", async () => {
		const shown: FilePresentation[] = [];
		const channel = deferredTransport(() => first);
		subscribeFilePresentation((value) => shown.push(value), channel.transport);
		await channel.failed();
		expect(shown).toEqual([first]);
	});
});
